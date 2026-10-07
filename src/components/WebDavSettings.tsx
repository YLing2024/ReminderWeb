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
import { actionLabel, appliedTotal, deleteConfirmMessage, deleteDisabledReason, formatBytes, formatSyncTime, lastResultText, restoreConfirmMessage } from '../lib/sync-view';
import { useReminderStore } from '../store/useReminderStore';
import { ConfirmDialog, Toggle } from './ui';
import styles from './WebDavSettings.module.css';

/**
 * 云端备份列表（M9 §3）：文件名、时间、大小；每项「恢复」「删除」。
 * 非本服务上传的包不可删除，按钮置灰并给出原因。
 */
export function CloudBackupList({
  files,
  onRestore,
  onDelete,
  busy,
}: {
  files: RemoteBackupEntry[];
  onRestore: (entry: RemoteBackupEntry) => void;
  onDelete: (entry: RemoteBackupEntry) => void;
  busy: boolean;
}) {
  if (files.length === 0) {
    return <p className={styles.fieldHint}>云端还没有备份</p>;
  }
  return (
    <div className={styles.fileList}>
      {files.map((file) => {
        const disabledReason = deleteDisabledReason(file);
        return (
          <div key={file.name} className={styles.fileItem}>
            <div className={styles.fileInfo}>
              <span className={styles.fileName}>{file.name}</span>
              <span className={styles.fileMeta}>
                {formatSyncTime(file.modifiedAt)} · {formatBytes(file.size)}
                {file.isOwn ? ' · 本设备上传' : ''}
              </span>
            </div>
            <div className={styles.fileActions}>
              <button
                type="button"
                className={styles.linkButton}
                disabled={busy}
                onClick={() => onRestore(file)}
              >
                恢复
              </button>
              <button
                type="button"
                className={styles.linkButtonDanger}
                disabled={busy || disabledReason !== null}
                title={disabledReason ?? undefined}
                onClick={() => onDelete(file)}
              >
                删除
              </button>
            </div>
            {disabledReason !== null && <span className={styles.fileHint}>{disabledReason}</span>}
          </div>
        );
      })}
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
 * 「WebDAV 云备份」分组（M9 §3）：自动同步开关 / 间隔 / 保留份数 / 状态 / 两个按钮 / 云端备份列表。
 *
 * 所有策略字段读写服务端（`/api/sync/config`），对所有设备一致；凭据只由服务端环境变量持有。
 */
export function WebDavSettings({ onNotice }: { onNotice: (message: string) => void }) {
  const mode = useReminderStore((state) => state.mode);
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
    if (mode !== 'server') return;
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
  }, [mode]);

  useEffect(() => {
    setLoaded(false);
    setConfig(null);
    setStatus(null);
    setFiles(null);
    setError(null);
    if (mode !== 'server') return undefined;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [mode, refresh]);

  const saveConfig = async (
    patch: Partial<Pick<SyncConfig, 'enabled' | 'intervalMinutes' | 'keep'>>,
  ) => {
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
  const keepOptions = Array.from(
    { length: keepRange[1] - keepRange[0] + 1 },
    (_, index) => keepRange[0] + index,
  );

  return (
    <div className={styles.card}>
      <p className={styles.groupNote}>这些设置在服务器上，所有设备一致。</p>

      {mode !== 'server' && (
        <p className={styles.fieldHint}>当前为本地模式，云备份由服务器提供；部署后端并连接后可用。</p>
      )}

      {mode === 'server' && (
        <>
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
            <button
              type="button"
              className={styles.primaryButton}
              disabled={working}
              onClick={() => void runSync()}
            >
              {busy ? '处理中…' : '立即同步'}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={working}
              onClick={() => void runUpload()}
            >
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
        </>
      )}

      <p className={styles.fieldHint}>地址与口令已迁移到服务器端配置，本页不再保存凭据。</p>

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
    </div>
  );
}
