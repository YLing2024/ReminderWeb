/**
 * WebDAV 双向同步引擎（M7 §4）。
 *
 * 一次同步周期（进程内串行）：
 *   1. PROPFIND(Depth:1) 取最新备份；
 *   2. 与上次处理过的（meta 记录 `etag`/`getlastmodified` + 文件名）比对，未变则跳过下载；
 *   3. 下载 → 解密 → 解 zip → 解析 metadata.json（条目形状走共享 android-shape）；
 *   4. 与库内数据走 M6 的 `mergeData` 条目级合并；有变化才落库并 revision++；
 *   5. 有变化或本机有待上传改动时，上传一份新包；
 *   6. 按 `WEBDAV_KEEP` 只清理**本服务上传过**的旧包（绝不碰安卓端的历史备份）。
 *
 * 本机数据变更 → `markLocalChange()` 按 `WEBDAV_DEBOUNCE_SECONDS` 合并节流。
 * 任何异常都不致命：脱敏记日志 + 写状态 + 下轮继续 + 指数退避（上限 4× 间隔）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { getMeta, setMeta } from './db.ts';
import { mergeData, readServerData, writeMergedData } from './data.ts';
import { BackupFormatError, backupFileName, buildBackupMetadata, decodeArchive, encodeArchive, parseBackupMetadata } from './backup-format.ts';
import type { Logger } from './log.ts';
import {
  deleteFile,
  downloadFile,
  listBackups,
  uploadFile,
  WebDavError,
  webDavConfigFrom,
  type RemoteFile,
} from './webdav.ts';

export interface SyncStatus {
  enabled: boolean;
  url: string;
  lastSyncAt: number | null;
  lastUploadAt: number | null;
  lastResult: 'ok' | 'error' | null;
  lastError: string | null;
  pendingChanges: boolean;
  remoteFiles: Array<{ name: string; modifiedAt: number }>;
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
} as const;

function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export class SyncEngine {
  private readonly config: Config;
  private readonly db: DatabaseSync;
  private readonly logger: Logger;
  private readonly deps: SyncEngineDeps;
  private readonly intervalMs: number;
  private readonly debounceMs: number;

  /** 当前串行执行中的周期；null 表示空闲。 */
  private running: Promise<SyncStatus> | null = null;
  private pending = false;
  private debounceTimer: unknown = null;
  private pollTimer: unknown = null;
  private backoffMs: number;
  private remoteFiles: RemoteFile[] = [];

  constructor(config: Config, db: DatabaseSync, logger: Logger, deps: SyncEngineDeps = {}) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.deps = deps;
    this.intervalMs = config.webdavIntervalMinutes * 60_000;
    this.debounceMs = config.webdavDebounceSeconds * 1000;
    this.backoffMs = this.intervalMs;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get enabled(): boolean {
    return this.config.webdavEnabled;
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
    };
  }

  /** 启动：定时轮询；若有待上传改动，按 debounce 排期。 */
  start(): void {
    if (!this.enabled) return;
    this.schedulePoll(this.intervalMs);
    if (this.pending) this.scheduleDebounce();
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** 本机数据变更：置 pending 并按 debounce 合并节流。 */
  markLocalChange(): void {
    if (!this.enabled) return;
    this.pending = true;
    this.scheduleDebounce();
  }

  /** 立即执行一次同步（`POST /api/sync/now`）；已有周期在跑时返回 null（调用方 409）。 */
  async runNow(): Promise<SyncStatus | null> {
    if (!this.enabled) return null;
    if (this.running !== null) return null;
    return this.runCycle();
  }

  /** 串行执行一次同步周期；并发调用复用同一个执行中的 Promise。 */
  runCycle(): Promise<SyncStatus> {
    if (!this.enabled) return Promise.resolve(this.status());
    if (this.running !== null) return this.running;
    this.running = this.execute().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.runCycle();
    }, Math.max(0, delayMs));
  }

  private scheduleDebounce(): void {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
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

      if (files.length === 0) {
        // 空远端：上传当前数据作为基线。
        await this.upload(client, dep);
        this.recordSuccess();
        return this.status();
      }

      const newest = files[0]!;
      const marker = this.readMarker();
      const unchanged =
        marker !== null &&
        marker.name === newest.name &&
        (newest.lastModified === 0 || marker.lastModified === newest.lastModified) &&
        (marker.etag === null || newest.etag === null || marker.etag === newest.etag);

      let mergedChanged = false;
      if (!unchanged) {
        const bytes = await downloadFile(client, newest.name, dep);
        const content = decodeArchive(bytes);
        const parsed = parseBackupMetadata(content.metadataJson, newest.lastModified > 0 ? newest.lastModified : startedAt);
        const outcome = mergeData(readServerData(this.db), {
          reminders: parsed.reminders,
          tags: parsed.tags,
          settings: parsed.settings,
          tombstones: [],
        });
        if (outcome.changed) {
          writeMergedData(this.db, outcome);
          mergedChanged = true;
        }
        this.writeMarker({ name: newest.name, lastModified: newest.lastModified, etag: newest.etag });
      }

      if (mergedChanged || this.pending) {
        await this.upload(client, dep);
      }
      this.recordSuccess();
    } catch (error) {
      this.recordError(error);
    }
    return this.status();
  }

  private async upload(
    client: ReturnType<typeof webDavConfigFrom>,
    dep: { fetchImpl?: typeof fetch },
  ): Promise<void> {
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
    setMeta(this.db, META.lastUploadAt, String(this.now()));

    const names = [fileName, ...this.uploadedNames().filter((name) => name !== fileName)];
    this.saveUploadedNames(names);
    await this.prune(client, dep);
    this.pending = false;
  }

  /** 仅清理本服务上传过的旧包，保留最新 `WEBDAV_KEEP` 份。 */
  private async prune(client: ReturnType<typeof webDavConfigFrom>, dep: { fetchImpl?: typeof fetch }): Promise<void> {
    const keep = Math.max(1, this.config.webdavKeep);
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

  private recordSuccess(): void {
    setMeta(this.db, META.lastSyncAt, String(this.now()));
    setMeta(this.db, META.lastResult, 'ok');
    setMeta(this.db, META.lastError, '');
    this.backoffMs = this.intervalMs;
    this.schedulePoll(this.intervalMs);
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
    this.backoffMs = Math.min(Math.max(this.backoffMs * 2, this.intervalMs), this.intervalMs * 4);
    this.schedulePoll(this.backoffMs);
  }
}
