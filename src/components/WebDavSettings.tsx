import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  deleteSyncFile,
  fetchSyncConfig,
  fetchSyncFiles,
  fetchSyncStatus,
  restoreSyncFile,
  triggerSyncNow,
  updateSyncConfig,
  uploadSyncNow,
  type RemoteBackupEntry,
  type SyncConfig,
  type SyncStatus,
} from '../lib/api';
import {
  deleteCloudBackup,
  listCloudBackups,
  restoreCloudBackup,
  uploadCurrentBackup,
  webDavConfigFrom,
} from '../lib/cloud-backup';
import { testConnection, type WebDavFile } from '../lib/webdav';
import {
  actionLabel,
  appliedTotal,
  deleteConfirmMessage,
  formatBytes,
  formatSyncTime,
  lastResultText,
  restoreConfirmMessage,
  restoreOverwriteConfirmMessage,
} from '../lib/sync-view';
import { useReminderStore, type StorageMode } from '../store/useReminderStore';
import { ConfirmDialog, Toggle } from './ui';
import styles from './WebDavSettings.module.css';

/** 云端备份条目的最小展示字段（服务器条目与客户端转发条目通用）。 */
type BackupEntry = { name: string; size: number; modifiedAt: number };

/**
 * 云端备份列表（M10 §4）：任何本应用备份都可恢复 / 删除，删除前二次确认并说明会删除 WebDAV 文件。
 */
export function CloudBackupList({
  files,
  onRestore,
  onDelete,
  busy,
}: {
  files: BackupEntry[];
  onRestore: (entry: BackupEntry) => void;
  onDelete: (entry: BackupEntry) => void;
  busy: boolean;
}) {
  if (files.length === 0) {
    return <p className={styles.fieldHint}>云端还没有备份</p>;
  }
  return (
    <div className={styles.fileList}>
      {files.map((file) => (
        <div key={file.name} className={styles.fileItem}>
          <div className={styles.fileInfo}>
            <span className={styles.fileName}>{file.name}</span>
            <span className={styles.fileMeta}>
              {formatSyncTime(file.modifiedAt)} · {formatBytes(file.size)}
            </span>
          </div>
          <div className={styles.fileActions}>
            <button type="button" className={styles.linkButton} disabled={busy} onClick={() => onRestore(file)}>
              恢复
            </button>
            <button type="button" className={styles.linkButtonDanger} disabled={busy} onClick={() => onDelete(file)}>
              删除
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 同步状态面板（M9 §3.4）：启用状态、目录、上次同步/上传、下次自动同步、待上传改动。
 * 纯展示，便于直接单测。
 */
export function SyncStatusPanel({
  loaded,
  error,
  enabled,
  status,
}: {
  loaded: boolean;
  error: string | null;
  enabled: boolean;
  status: SyncStatus | null;
}) {
  return (
    <div className={styles.status}>
      <p className={styles.statusLine}>
        状态：{loaded ? (error !== null ? error : enabled ? '已启用' : '未启用') : '读取中…'}
      </p>
      <p className={styles.statusLine}>服务器目录：{status !== null && status.url !== '' ? status.url : '—'}</p>
      <p className={styles.statusLine}>上次同步：{formatSyncTime(status?.lastSyncAt ?? null)}</p>
      <p className={styles.statusLine}>上次上传：{formatSyncTime(status?.lastUploadAt ?? null)}</p>
      <p className={styles.statusLine}>下次自动同步：{formatSyncTime(status?.nextSyncAt ?? null)}</p>
      <p className={styles.statusLine}>上次动作：{status === null ? '暂无' : actionLabel(status.lastAction)}</p>
      <p className={styles.statusLine}>
        上次结果：{status === null ? '尚未同步' : lastResultText(status)}
        {status?.pendingChanges === true ? ' · 有改动待上传' : ''}
      </p>
    </div>
  );
}

/**
 * 服务器模式面板（M9）：自动同步开关 / 间隔 / 保留份数 / 状态 / 立即同步与备份 / 云端备份列表。
 * 凭据只由服务端环境变量持有，界面不出现地址与口令输入框。
 */
function ServerWebDavPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const refreshStore = useReminderStore((state) => state.refresh);
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [files, setFiles] = useState<RemoteBackupEntry[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<RemoteBackupEntry | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RemoteBackupEntry | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextStatus, nextFiles] = await Promise.all([
        fetchSyncConfig(),
        fetchSyncStatus(),
        fetchSyncFiles(),
      ]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setFiles(nextFiles);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法获取云备份状态');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const saveConfig = async (patch: Partial<Pick<SyncConfig, 'enabled' | 'intervalMinutes' | 'keep'>>) => {
    setSavingConfig(true);
    try {
      const next = await updateSyncConfig(patch);
      setConfig(next);
      setStatus(await fetchSyncStatus());
      setError(null);
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : '保存失败，请稍后重试');
    } finally {
      setSavingConfig(false);
    }
  };

  const runSync = async () => {
    setBusy(true);
    try {
      setStatus(await triggerSyncNow());
      setFiles(await fetchSyncFiles());
      onNotice('已立即同步');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) onNotice('同步正在进行中，请稍候');
      else onNotice(`同步失败：${caught instanceof Error ? caught.message : '请稍后重试'}`);
    } finally {
      setBusy(false);
    }
  };

  const runUpload = async () => {
    setBusy(true);
    try {
      const result = await uploadSyncNow();
      setFiles(await fetchSyncFiles());
      setStatus(await fetchSyncStatus());
      onNotice(`已备份 ${result.name}`);
    } catch (caught) {
      onNotice(`备份失败：${caught instanceof Error ? caught.message : '请稍后重试'}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = async (entry: RemoteBackupEntry) => {
    setBusy(true);
    try {
      const result = await restoreSyncFile(entry.name);
      await refresh();
      await refreshStore(true);
      onNotice(`已合并 ${appliedTotal(result.applied)} 条`);
    } catch (caught) {
      onNotice(`恢复失败：${caught instanceof Error ? caught.message : '请稍后重试'}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (entry: RemoteBackupEntry) => {
    setBusy(true);
    try {
      await deleteSyncFile(entry.name);
      setFiles(await fetchSyncFiles());
      onNotice('已删除该云端备份');
    } catch (caught) {
      onNotice(`删除失败：${caught instanceof Error ? caught.message : '请稍后重试'}`);
    } finally {
      setBusy(false);
    }
  };

  const enabled = config?.enabled ?? status?.enabled ?? false;
  const working = busy || savingConfig;
  const keepRange = config?.options.keepRange ?? [1, 50];
  const keepOptions = Array.from({ length: keepRange[1] - keepRange[0] + 1 }, (_, index) => keepRange[0] + index);

  return (
    <>
      <p className={styles.groupNote}>这些设置在服务器上，所有设备一致；凭据保存在服务器，由服务器与 WebDAV 通信。</p>

      <div className={styles.switchRow}>
        <div className={styles.rowText}>
          <p className={styles.rowTitle}>自动同步</p>
          <p className={styles.rowDesc}>在服务器上按间隔自动同步；关闭后仍可用下方按钮手动同步</p>
        </div>
        <Toggle
          checked={enabled}
          label="自动同步"
          disabled={!loaded || config === null || working}
          onChange={(next) => config !== null && void saveConfig({ enabled: next })}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="sync-interval">
          同步间隔
        </label>
        <select
          id="sync-interval"
          className={styles.select}
          value={config?.intervalMinutes ?? 10}
          disabled={!enabled || config === null || working}
          onChange={(event) => void saveConfig({ intervalMinutes: Number(event.target.value) })}
        >
          {(config?.options.intervals ?? [5, 10, 30, 60]).map((minutes) => (
            <option key={minutes} value={minutes}>
              每 {minutes} 分钟
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="sync-keep">
          保留备份份数
        </label>
        <select
          id="sync-keep"
          className={styles.select}
          value={config?.keep ?? 10}
          disabled={config === null || working}
          onChange={(event) => void saveConfig({ keep: Number(event.target.value) })}
        >
          {keepOptions.map((count) => (
            <option key={count} value={count}>
              {count} 份
            </option>
          ))}
        </select>
        <span className={styles.fieldHint}>超出后自动清理本服务上传的旧备份</span>
      </div>

      <SyncStatusPanel loaded={loaded} error={error} enabled={enabled} status={status} />

      <div className={styles.buttonRow}>
        <button type="button" className={styles.primaryButton} disabled={working} onClick={() => void runSync()}>
          {busy ? '处理中…' : '立即同步'}
        </button>
        <button type="button" className={styles.secondaryButton} disabled={working} onClick={() => void runUpload()}>
          立即备份
        </button>
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>云端备份</span>
        {files === null ? (
          <span className={styles.fieldHint}>读取中…</span>
        ) : (
          <CloudBackupList
            files={files}
            busy={working}
            onRestore={(entry) => setPendingRestore(entry)}
            onDelete={(entry) => setPendingDelete(entry)}
          />
        )}
      </div>

      <ConfirmDialog
        open={pendingRestore !== null}
        title="从云端备份恢复"
        message={restoreConfirmMessage(pendingRestore?.name ?? '')}
        confirmText="合并恢复"
        onCancel={() => setPendingRestore(null)}
        onConfirm={() => {
          const entry = pendingRestore;
          setPendingRestore(null);
          if (entry !== null) void confirmRestore(entry);
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除云端备份"
        message={deleteConfirmMessage(pendingDelete?.name ?? '')}
        confirmText="删除"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const entry = pendingDelete;
          setPendingDelete(null);
          if (entry !== null) void confirmDelete(entry);
        }}
      />
    </>
  );
}

/**
 * 客户端（纯前端）模式面板：WebDAV 请求一律经本应用后端 `/api/webdav` 转发（M12 §1）。
 * 复用 `lib/webdav`、`lib/cloud-backup` 与 `lib/cloud-auto`，凭据只存本机。
 */
function ClientWebDavPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const settings = useReminderStore((state) => state.settings);
  const updateSettings = useReminderStore((state) => state.updateSettings);
  const reminders = useReminderStore((state) => state.reminders);
  const tags = useReminderStore((state) => state.tags);
  const importData = useReminderStore((state) => state.importData);

  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<'test' | 'upload' | 'list' | 'restore' | 'delete' | null>(null);
  const [files, setFiles] = useState<WebDavFile[] | null>(null);
  const [pendingRestore, setPendingRestore] = useState<WebDavFile | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WebDavFile | null>(null);

  const disabled = !settings.webdavEnabled;
  const working = busy !== null;

  const ensureConfigured = (): boolean => {
    if (settings.webdavServer.trim() === '') {
      onNotice('请先填写服务器地址');
      return false;
    }
    return true;
  };

  const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : '操作失败，请稍后重试');

  const runTest = async () => {
    if (!ensureConfigured()) return;
    setBusy('test');
    try {
      await testConnection(webDavConfigFrom(settings));
      await updateSettings({ webdavLastResult: '连接正常' });
      onNotice('连接正常');
    } catch (error) {
      const message = errorMessage(error);
      await updateSettings({ webdavLastResult: `连接失败：${message}` });
      onNotice(`连接失败：${message}`);
    } finally {
      setBusy(null);
    }
  };

  const runUpload = async () => {
    if (!ensureConfigured()) return;
    setBusy('upload');
    try {
      const outcome = await uploadCurrentBackup({ reminders, tags, settings });
      const suffix = outcome.pruned > 0 ? `，已清理 ${outcome.pruned} 份旧备份` : '';
      await updateSettings({
        webdavLastSuccessAt: Date.now(),
        webdavLastResult: `已上传 ${outcome.fileName}${suffix}`,
      });
      onNotice(`已上传 ${outcome.fileName}`);
    } catch (error) {
      const message = errorMessage(error);
      await updateSettings({ webdavLastResult: `上传失败：${message}` });
      onNotice(`上传失败：${message}`);
    } finally {
      setBusy(null);
    }
  };

  const runList = async () => {
    if (!ensureConfigured()) return;
    setBusy('list');
    try {
      const next = await listCloudBackups(settings);
      setFiles(next);
      if (next.length === 0) onNotice('云端还没有备份');
    } catch (error) {
      onNotice(`无法获取云端备份：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const confirmRestore = async (file: WebDavFile) => {
    setBusy('restore');
    try {
      const result = await restoreCloudBackup(settings, file.name);
      await importData({ reminders: result.reminders, tags: result.tags, settings: result.settings });
      onNotice(`已恢复 ${result.reminders.length} 条提醒、${result.tags.length} 个标签、${result.imageCount} 张图片。`);
    } catch (error) {
      onNotice(`恢复失败：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async (file: WebDavFile) => {
    setBusy('delete');
    try {
      await deleteCloudBackup(settings, file.name);
      setFiles((current) => (current === null ? current : current.filter((entry) => entry.name !== file.name)));
      onNotice('已删除该云端备份');
    } catch (error) {
      onNotice(`删除失败：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p className={styles.groupNote}>
        地址与口令只保存在本机；转发时随请求发给本应用服务器，不落库、不写日志。
      </p>

      <div className={styles.switchRow}>
        <div className={styles.rowText}>
          <p className={styles.rowTitle}>启用云备份</p>
          <p className={styles.rowDesc}>把与本地导出相同的备份包上传到你自己的 WebDAV 服务器</p>
        </div>
        <Toggle
          checked={settings.webdavEnabled}
          label="启用云备份"
          onChange={(next) => void updateSettings({ webdavEnabled: next })}
        />
      </div>

      <p className={styles.fieldHint}>WebDAV 请求经本应用服务器转发，因此浏览器不受跨域限制。</p>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>服务器地址</span>
        <input
          className={styles.input}
          type="url"
          inputMode="url"
          placeholder="https://dav.example.com/dav/"
          value={settings.webdavServer}
          disabled={disabled}
          onChange={(event) => void updateSettings({ webdavServer: event.target.value })}
        />
        <span className={styles.fieldHint}>完整地址，含协议与目录；结尾斜杠会自动补齐</span>
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>用户名</span>
        <input
          className={styles.input}
          type="text"
          autoComplete="username"
          value={settings.webdavUsername}
          disabled={disabled}
          onChange={(event) => void updateSettings({ webdavUsername: event.target.value })}
        />
      </label>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>口令</span>
        <div className={styles.passwordRow}>
          <input
            className={styles.input}
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            value={settings.webdavPassword}
            disabled={disabled}
            onChange={(event) => void updateSettings({ webdavPassword: event.target.value })}
          />
          <button
            type="button"
            className={styles.showToggle}
            aria-pressed={showPassword}
            disabled={disabled}
            onClick={() => setShowPassword((value) => !value)}
          >
            {showPassword ? '隐藏' : '显示'}
          </button>
        </div>
      </div>

      <div className={styles.buttonRow}>
        <button type="button" className={styles.secondaryButton} disabled={disabled || working} onClick={() => void runTest()}>
          {busy === 'test' ? '正在测试…' : '测试连接'}
        </button>
        <button type="button" className={styles.primaryButton} disabled={disabled || working} onClick={() => void runUpload()}>
          {busy === 'upload' ? '正在上传…' : '立即备份'}
        </button>
      </div>

      <div className={styles.switchRow}>
        <div className={styles.rowText}>
          <p className={styles.rowTitle}>自动备份</p>
          <p className={styles.rowDesc}>数据变动后延迟一分钟合并上传一次，期间不打断操作</p>
        </div>
        <Toggle
          checked={settings.webdavAutoBackup}
          label="自动备份"
          disabled={disabled}
          onChange={(next) => void updateSettings({ webdavAutoBackup: next })}
        />
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>保留份数</span>
        <input
          className={styles.input}
          type="number"
          min={1}
          max={100}
          value={settings.webdavKeepCount}
          disabled={disabled}
          onChange={(event) => {
            const next = Math.max(1, Math.min(100, Math.floor(Number(event.target.value) || 1)));
            void updateSettings({ webdavKeepCount: next });
          }}
        />
        <span className={styles.fieldHint}>上传成功后仅保留最新的这么多份，超出的最旧备份会被删除</span>
      </label>

      <div className={styles.buttonRow}>
        <button type="button" className={styles.secondaryButton} disabled={disabled || working} onClick={() => void runList()}>
          {busy === 'list' ? '正在获取…' : '从云端恢复'}
        </button>
      </div>

      {files !== null && (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>云端备份列表</span>
          <CloudBackupList
            files={files.map((file) => ({ name: file.name, size: file.size, modifiedAt: file.lastModified }))}
            busy={working}
            onRestore={(entry) => setPendingRestore({ name: entry.name, size: entry.size, lastModified: entry.modifiedAt })}
            onDelete={(entry) => setPendingDelete({ name: entry.name, size: entry.size, lastModified: entry.modifiedAt })}
          />
        </div>
      )}

      <div className={styles.status} role="status">
        <p className={styles.statusLine}>
          当前状态：
          {busy === 'upload'
            ? '正在上传'
            : busy === 'restore'
              ? '正在恢复'
              : busy === 'delete'
                ? '正在删除'
                : busy === 'test'
                  ? '正在测试连接'
                  : busy === 'list'
                    ? '正在获取云端备份'
                    : '空闲'}
        </p>
        <p className={styles.statusLine}>上次成功：{formatSyncTime(settings.webdavLastSuccessAt)}</p>
        {settings.webdavLastResult !== null && <p className={styles.statusLine}>上次结果：{settings.webdavLastResult}</p>}
      </div>

      <ConfirmDialog
        open={pendingRestore !== null}
        title="从云端备份恢复"
        message={restoreOverwriteConfirmMessage(pendingRestore?.name ?? '')}
        confirmText="覆盖恢复"
        danger
        onCancel={() => setPendingRestore(null)}
        onConfirm={() => {
          const file = pendingRestore;
          setPendingRestore(null);
          if (file !== null) void confirmRestore(file);
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除云端备份"
        message={deleteConfirmMessage(pendingDelete?.name ?? '')}
        confirmText="删除"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const file = pendingDelete;
          setPendingDelete(null);
          if (file !== null) void confirmDelete(file);
        }}
      />
    </>
  );
}

/**
 * 「WebDAV 云备份」分组（M10 §1）：
 * - 服务器模式：M9 服务端策略面板（不出现地址 / 用户名 / 口令输入框）；
 * - 客户端模式（纯前端）：WebDAV 请求经本应用服务器转发（地址 / 用户名 / 口令 / 自动备份 / 保留份数 / 测试 / 备份 / 恢复 / 列表）。
 */
export function WebDavSettings({ onNotice, mode: modeProp }: { onNotice: (message: string) => void; mode?: StorageMode }) {
  const storeMode = useReminderStore((state) => state.mode);
  const mode = modeProp ?? storeMode;

  return (
    <div className={styles.card}>
      {mode === 'server' && <ServerWebDavPanel onNotice={onNotice} />}
      {mode === 'client' && <ClientWebDavPanel onNotice={onNotice} />}
      {mode === 'unknown' && <p className={styles.fieldHint}>正在检测运行模式…</p>}
    </div>
  );
}
