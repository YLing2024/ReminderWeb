/**
 * WebDAV 双向同步引擎（M7 §4 / M9 §1 §2）。
 *
 * 一次同步周期（进程内串行）：
 *   1. PROPFIND(Depth:1) 取最新备份；
 *   2. 与上次处理过的（meta 记录 `etag`/`getlastmodified` + 文件名）比对，未变则跳过下载；
 *   3. 下载 → 解密 → 解 zip → 解析 metadata.json（条目形状走共享 android-shape）；
 *   4. 与库内数据走 `mergeData` 条目级合并；有变化才落库并 revision++；
 *   5. 有变化或本机有待上传改动时，上传一份新包；
 *   6. 按保留份数只清理**本服务上传过**的旧包（绝不碰安卓端的历史备份）。
 *
 * 自动同步开关 / 间隔 / 保留份数来自 SQLite（`sync-config.ts`），改动立即重排定时器；
 * 环境变量只作初始默认值。手动操作（立即同步 / 立即备份 / 恢复 / 删除）不受开关限制。
 *
 * 本机数据变更 → `markLocalChange()` 按 debounce 合并节流。
 * 任何异常都不致命：脱敏记日志 + 写状态 + 下轮继续 + 指数退避（上限 4× 间隔）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { getMeta, setMeta } from './db.ts';
import { countChanges, mergeData, readServerData, writeMergedData, type ServerData } from './data.ts';
import {
  BackupFormatError,
  backupFileName,
  buildBackupMetadata,
  decodeArchive,
  encodeArchive,
  parseBackupMetadata,
} from './backup-format.ts';
import type { Logger } from './log.ts';
import {
  applySyncConfigPatch,
  parseSyncConfigPatch,
  readSyncConfig,
  syncConfigView,
  type StoredSyncConfig,
  type SyncConfigView,
} from './sync-config.ts';
import {
  deleteFile,
  downloadFile,
  isValidBackupName,
  listBackups,
  uploadFile,
  WebDavError,
  webDavConfigFrom,
  type RemoteFile,
} from './webdav.ts';

export type SyncAction = 'upload' | 'pull' | 'restore' | 'none';

export interface SyncStatus {
  enabled: boolean;
  url: string;
  lastSyncAt: number | null;
  lastUploadAt: number | null;
  lastResult: 'ok' | 'error' | null;
  lastError: string | null;
  pendingChanges: boolean;
  remoteFiles: Array<{ name: string; modifiedAt: number }>;
  /** 下次自动同步的预计时间戳；未启用 / 未排期为 null。 */
  nextSyncAt: number | null;
  /** 最近一次同步合并的条目数（可为 0）。 */
  lastMerged: number;
  /** 最近一次同步 / 备份的动作。 */
  lastAction: SyncAction;
}

/** 云端备份条目（供 GET /api/sync/files）。 */
export interface RemoteBackupEntry {
  name: string;
  size: number;
  modifiedAt: number;
}

export interface RestoreResult {
  applied: { updated: number; added: number; removed: number; rejected: number };
  revision: number;
}

export interface UploadResult {
  name: string;
  size: number;
  lastUploadAt: number | null;
}

/** 手动云端操作（恢复 / 删除）失败：`status` + 稳定错误码 + 中文文案。 */
export class SyncActionError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SyncActionError';
    this.status = status;
    this.code = code;
  }
}

interface ProcessedMarker {
  name: string;
  lastModified: number;
  etag: string | null;
}

export interface SyncEngineDeps {
  /** 注入 fetch（测试用假 WebDAV 服务；生产走全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 固定「现在」，便于测试确定性文件名与退避。 */
  now?: () => number;
}

const META = {
  lastProcessed: 'sync.lastProcessed',
  uploaded: 'sync.uploaded',
  lastSyncAt: 'sync.lastSyncAt',
  lastUploadAt: 'sync.lastUploadAt',
  lastResult: 'sync.lastResult',
  lastError: 'sync.lastError',
  lastMerged: 'sync.lastMerged',
  lastAction: 'sync.lastAction',
} as const;

function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseAction(raw: string | undefined): SyncAction {
  if (raw === 'upload' || raw === 'pull' || raw === 'restore') return raw;
  return 'none';
}

export class SyncEngine {
  private readonly config: Config;
  private readonly db: DatabaseSync;
  private readonly logger: Logger;
  private readonly deps: SyncEngineDeps;
  private readonly debounceMs: number;

  /** 当前串行执行中的周期；null 表示空闲。 */
  private running: Promise<unknown> | null = null;
  private pending = false;
  private debounceTimer: unknown = null;
  private pollTimer: unknown = null;
  private backoffMs = 0;
  private remoteFiles: RemoteFile[] = [];
  private syncConfig: StoredSyncConfig;
  private intervalMs: number;
  /** 下次自动同步的预计时间戳；null 表示未排期。 */
  private nextPollAt: number | null = null;

  constructor(config: Config, db: DatabaseSync, logger: Logger, deps: SyncEngineDeps = {}) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.deps = deps;
    this.debounceMs = config.webdavDebounceSeconds * 1000;
    this.syncConfig = readSyncConfig(db, config);
    this.intervalMs = this.syncConfig.intervalMinutes * 60_000;
    this.backoffMs = this.intervalMs;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get enabled(): boolean {
    return this.syncConfig.enabled;
  }

  /** 当前同步配置视图（不含凭据）。 */
  configView(): SyncConfigView {
    return syncConfigView(this.syncConfig, this.config);
  }

  /** 更新同步配置并立即重排定时器；非法值抛 `SyncConfigError`。 */
  updateConfig(raw: unknown): SyncConfigView {
    const patch = parseSyncConfigPatch(raw);
    const previousEnabled = this.enabled;
    this.syncConfig = applySyncConfigPatch(this.db, this.config, patch);
    this.applySchedule(previousEnabled);
    return this.configView();
  }

  /** 应用当前配置到定时器：关闭即停；从关到开立即排一次；间隔变化立即改用新间隔。 */
  private applySchedule(previousEnabled: boolean): void {
    this.intervalMs = this.syncConfig.intervalMinutes * 60_000;
    this.backoffMs = this.intervalMs;
    if (!this.enabled) {
      this.clearPoll();
      this.clearDebounce();
      this.nextPollAt = null;
      return;
    }
    if (!previousEnabled) this.schedulePoll(0);
    else this.schedulePoll(this.intervalMs);
    if (this.pending) this.scheduleDebounce();
  }

  private readMarker(): ProcessedMarker | null {
    const raw = getMeta(this.db, META.lastProcessed);
    if (raw === undefined || raw === '') return null;
    try {
      const parsed = JSON.parse(raw) as Partial<ProcessedMarker>;
      if (typeof parsed.name !== 'string') return null;
      return {
        name: parsed.name,
        lastModified: typeof parsed.lastModified === 'number' ? parsed.lastModified : 0,
        etag: typeof parsed.etag === 'string' ? parsed.etag : null,
      };
    } catch {
      return null;
    }
  }

  private writeMarker(marker: ProcessedMarker): void {
    setMeta(this.db, META.lastProcessed, JSON.stringify(marker));
  }

  private uploadedNames(): string[] {
    const raw = getMeta(this.db, META.uploaded);
    if (raw === undefined || raw === '') return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
    } catch {
      return [];
    }
  }

  private saveUploadedNames(names: string[]): void {
    setMeta(this.db, META.uploaded, JSON.stringify(names));
  }

  status(): SyncStatus {
    const rawResult = getMeta(this.db, META.lastResult);
    const lastResult = rawResult === 'ok' || rawResult === 'error' ? rawResult : null;
    const rawError = getMeta(this.db, META.lastError);
    return {
      enabled: this.enabled,
      url: this.enabled ? this.config.webdavUrl : '',
      lastSyncAt: parseNumber(getMeta(this.db, META.lastSyncAt)),
      lastUploadAt: parseNumber(getMeta(this.db, META.lastUploadAt)),
      lastResult,
      lastError: rawError === undefined || rawError === '' ? null : rawError,
      pendingChanges: this.pending,
      remoteFiles: this.remoteFiles.map((file) => ({ name: file.name, modifiedAt: file.lastModified })),
      nextSyncAt: this.enabled ? this.nextPollAt : null,
      lastMerged: parseNumber(getMeta(this.db, META.lastMerged)) ?? 0,
      lastAction: parseAction(getMeta(this.db, META.lastAction)),
    };
  }

  /** 启动：自动同步开启时定时轮询；有待上传改动时按 debounce 排期。 */
  start(): void {
    if (!this.enabled) return;
    this.schedulePoll(this.intervalMs);
    if (this.pending) this.scheduleDebounce();
  }

  stop(): void {
    this.clearPoll();
    this.clearDebounce();
    this.nextPollAt = null;
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer as ReturnType<typeof setTimeout>);
      this.pollTimer = null;
    }
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer as ReturnType<typeof setTimeout>);
      this.debounceTimer = null;
    }
  }

  /** 本机数据变更：自动同步开启时置 pending 并按 debounce 合并节流。 */
  markLocalChange(): void {
    if (!this.enabled) return;
    this.pending = true;
    this.scheduleDebounce();
  }

  /** 立即执行一次双向同步（`POST /api/sync/now`）；已有任务在跑时返回 null（调用方 409）。 */
  async runNow(): Promise<SyncStatus | null> {
    if (this.running !== null) return null;
    return this.runCycle();
  }

  /** 串行执行一次同步周期；并发调用复用同一个执行中的 Promise。 */
  runCycle(): Promise<SyncStatus> {
    if (this.running !== null) return this.running as Promise<SyncStatus>;
    const task = this.execute().finally(() => {
      this.running = null;
    });
    this.running = task;
    return task;
  }

  /** 只上传不拉取（`POST /api/sync/upload`）；已有任务在跑时返回 null（调用方 409）。 */
  async runUpload(): Promise<UploadResult | null> {
    return this.serialize(async () => {
      const client = webDavConfigFrom(this.config);
      const dep = this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl };
      const info = await this.upload(client, dep);
      setMeta(this.db, META.lastAction, 'upload');
      return info;
    });
  }

  /** 列出云端备份（时间倒序）；任何 reminder-backup-*.zip 都可恢复。 */
  async listFiles(): Promise<RemoteBackupEntry[]> {
    const client = webDavConfigFrom(this.config);
    const dep = this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl };
    const files = await listBackups(client, dep);
    this.remoteFiles = files;
    return files.map((file) => ({
      name: file.name,
      size: file.size,
      modifiedAt: file.lastModified,
    }));
  }

  /**
   * 从指定远端备份恢复（`POST /api/sync/restore`）：
   * 下载 → 解密 → 解包 → 复用自动同步同一条 `mergeData`；有变化才 revision++；
   * **绝不删除远端文件**。重复恢复同一份幂等。
   */
  async restore(name: string): Promise<RestoreResult | null> {
    if (!isValidBackupName(name)) throw new SyncActionError(400, 'invalid_name', '备份文件名不合法');
    return this.serialize(async () => {
      const client = webDavConfigFrom(this.config);
      const dep = this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl };
      const files = await listBackups(client, dep);
      this.remoteFiles = files;
      const target = files.find((file) => file.name === name);
      if (target === undefined) throw new SyncActionError(404, 'not_found', '云端没有这份备份');
      const bytes = await downloadFile(client, name, dep);
      let metadataJson: string;
      try {
        metadataJson = decodeArchive(bytes).metadataJson;
      } catch (error) {
        const message = error instanceof BackupFormatError ? error.message : '无法识别该备份包';
        throw new SyncActionError(400, 'invalid_backup', `该备份无法解析：${message}`);
      }
      const updatedAt = target.lastModified > 0 ? target.lastModified : this.now();
      const parsed = parseBackupMetadata(metadataJson, updatedAt);
      const before = readServerData(this.db);
      const outcome = mergeData(before, {
        reminders: parsed.reminders,
        tags: parsed.tags,
        settings: parsed.settings,
        tombstones: [],
      });
      const revision = writeMergedData(this.db, outcome);
      const counts = countChanges(before, outcome);
      setMeta(this.db, META.lastMerged, String(counts.updated + counts.added + counts.removed));
      setMeta(this.db, META.lastAction, 'restore');
      return { applied: { ...counts, rejected: parsed.rejected }, revision };
    });
  }

  /** 删除云端备份（`DELETE /api/sync/files/:name`）：任何本应用备份都可删除，但绝不碰同目录其它文件。 */
  async deleteRemote(name: string): Promise<'deleted' | null> {
    if (!isValidBackupName(name)) throw new SyncActionError(400, 'invalid_name', '备份文件名不合法');
    return this.serialize<'deleted'>(async () => {
      const client = webDavConfigFrom(this.config);
      const dep = this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl };
      const files = await listBackups(client, dep);
      this.remoteFiles = files;
      if (!files.some((file) => file.name === name)) throw new SyncActionError(404, 'not_found', '云端没有这份备份');
      await deleteFile(client, name, dep);
      this.saveUploadedNames(this.uploadedNames().filter((entry) => entry !== name));
      this.remoteFiles = this.remoteFiles.filter((file) => file.name !== name);
      return 'deleted';
    });
  }

  private async serialize<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.running !== null) return null;
    const task = fn().finally(() => {
      this.running = null;
    });
    this.running = task;
    return task;
  }

  private schedulePoll(delayMs: number): void {
    this.clearPoll();
    const delay = Math.max(0, delayMs);
    this.nextPollAt = this.now() + delay;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.nextPollAt = null;
      void this.runCycle();
    }, delay);
  }

  private scheduleDebounce(): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runCycle();
    }, Math.max(0, this.debounceMs));
  }

  private async execute(): Promise<SyncStatus> {
    const startedAt = this.now();
    try {
      const client = webDavConfigFrom(this.config);
      const dep = this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl };
      const files = await listBackups(client, dep);
      this.remoteFiles = files;

      let mergedChanged = false;
      let mergedCount = 0;
      let uploaded = false;

      if (files.length === 0) {
        // 空远端：上传当前数据作为基线。
        await this.upload(client, dep);
        uploaded = true;
      } else {
        const newest = files[0]!;
        const marker = this.readMarker();
        const unchanged =
          marker !== null &&
          marker.name === newest.name &&
          (newest.lastModified === 0 || marker.lastModified === newest.lastModified) &&
          (marker.etag === null || newest.etag === null || marker.etag === newest.etag);

        if (!unchanged) {
          const bytes = await downloadFile(client, newest.name, dep);
          const content = decodeArchive(bytes);
          const parsed = parseBackupMetadata(
            content.metadataJson,
            newest.lastModified > 0 ? newest.lastModified : startedAt,
          );
          const before: ServerData = readServerData(this.db);
          const outcome = mergeData(before, {
            reminders: parsed.reminders,
            tags: parsed.tags,
            settings: parsed.settings,
            tombstones: [],
          });
          if (outcome.changed) {
            writeMergedData(this.db, outcome);
            mergedChanged = true;
          }
          const counts = countChanges(before, outcome);
          mergedCount = counts.updated + counts.added + counts.removed;
          this.writeMarker({ name: newest.name, lastModified: newest.lastModified, etag: newest.etag });
        }

        if (mergedChanged || this.pending) {
          await this.upload(client, dep);
          uploaded = true;
        }
      }
      const action: SyncAction = mergedChanged ? 'pull' : uploaded ? 'upload' : 'none';
      this.recordSuccess(action, mergedCount);
    } catch (error) {
      this.recordError(error);
    }
    return this.status();
  }

  private async upload(
    client: ReturnType<typeof webDavConfigFrom>,
    dep: { fetchImpl?: typeof fetch },
  ): Promise<UploadResult> {
    const metadataJson = buildBackupMetadata(readServerData(this.db));
    const bytes = encodeArchive({ metadataJson }, this.config.webdavEncrypt);
    const fileName = backupFileName(new Date(this.now()));
    await uploadFile(client, bytes, fileName, dep);

    const files = await listBackups(client, dep);
    this.remoteFiles = files;
    const uploaded = files.find((file) => file.name === fileName);
    this.writeMarker({
      name: fileName,
      lastModified: uploaded?.lastModified ?? 0,
      etag: uploaded?.etag ?? null,
    });
    const uploadedAt = this.now();
    setMeta(this.db, META.lastUploadAt, String(uploadedAt));

    const names = [fileName, ...this.uploadedNames().filter((name) => name !== fileName)];
    this.saveUploadedNames(names);
    await this.prune(client, dep);
    this.pending = false;
    return { name: fileName, size: uploaded?.size ?? bytes.length, lastUploadAt: uploadedAt };
  }

  /** 仅清理本服务上传过的旧包，保留最新 `keep` 份。 */
  private async prune(client: ReturnType<typeof webDavConfigFrom>, dep: { fetchImpl?: typeof fetch }): Promise<void> {
    const keep = Math.max(1, this.syncConfig.keep);
    const names = [...new Set(this.uploadedNames())].sort((a, b) => b.localeCompare(a));
    const kept = names.slice(0, keep);
    const remote = new Set(this.remoteFiles.map((file) => file.name));
    for (const name of names.slice(keep)) {
      if (!remote.has(name)) continue;
      try {
        await deleteFile(client, name, dep);
      } catch (error) {
        if (!(error instanceof WebDavError && error.code === 'NOT_FOUND')) throw error;
      }
    }
    this.saveUploadedNames(kept);
  }

  private recordSuccess(action: SyncAction, merged: number): void {
    setMeta(this.db, META.lastSyncAt, String(this.now()));
    setMeta(this.db, META.lastResult, 'ok');
    setMeta(this.db, META.lastError, '');
    setMeta(this.db, META.lastMerged, String(merged));
    if (action !== 'none') setMeta(this.db, META.lastAction, action);
    this.backoffMs = this.intervalMs;
    if (this.enabled) this.schedulePoll(this.intervalMs);
    else this.nextPollAt = null;
  }

  private recordError(error: unknown): void {
    const message =
      error instanceof WebDavError || error instanceof BackupFormatError
        ? error.message
        : '同步失败，请稍后重试';
    this.logger.warn(`WebDAV 同步失败：${message}`);
    setMeta(this.db, META.lastSyncAt, String(this.now()));
    setMeta(this.db, META.lastResult, 'error');
    setMeta(this.db, META.lastError, message);
    if (this.enabled) {
      this.backoffMs = Math.min(Math.max(this.backoffMs * 2, this.intervalMs), this.intervalMs * 4);
      this.schedulePoll(this.backoffMs);
    } else {
      this.nextPollAt = null;
    }
  }
}
