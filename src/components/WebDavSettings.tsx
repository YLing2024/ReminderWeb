import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchSyncStatus, triggerSyncNow, type SyncStatus } from '../lib/api';
import { useReminderStore } from '../store/useReminderStore';
import styles from './WebDavSettings.module.css';

function formatTime(timestamp: number | null): string {
  if (timestamp === null) return '暂无';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function resultText(status: SyncStatus): string {
  if (status.lastResult === null) return '尚未同步';
  if (status.lastResult === 'ok') return '成功';
  return status.lastError === null ? '失败' : `失败：${status.lastError}`;
}

/**
 * 「WebDAV 云备份」分组（M7 §5）：只读状态 + 立即同步。
 *
 * 凭据由服务端环境变量持有，本页不再显示地址 / 用户名 / 口令输入框；
 * 数据同步（拉回合并 + 上传）全部由后端完成，浏览器只读状态并触发一次同步。
 */
export function WebDavSettings({ onNotice }: { onNotice: (message: string) => void }) {
  const mode = useReminderStore((state) => state.mode);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (mode !== 'server') return;
    try {
      setStatus(await fetchSyncStatus());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法获取同步状态');
    } finally {
      setLoaded(true);
    }
  }, [mode]);

  useEffect(() => {
    setLoaded(false);
    setStatus(null);
    setError(null);
    if (mode !== 'server') return undefined;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [mode, refresh]);

  const runSync = async () => {
    setBusy(true);
    try {
      const next = await triggerSyncNow();
      setStatus(next);
      setError(null);
      onNotice('已立即同步');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        onNotice('同步正在进行中，请稍候');
      } else {
        onNotice(`同步失败：${caught instanceof Error ? caught.message : '请稍后重试'}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled === true;
  const remoteFiles = status === null ? [] : [...status.remoteFiles].sort((a, b) => b.modifiedAt - a.modifiedAt);

  return (
    <div className={styles.card}>
      <div className={styles.switchRow}>
        <div className={styles.rowText}>
          <p className={styles.rowTitle}>与 WebDAV 双向同步</p>
          <p className={styles.rowDesc}>由服务器把数据打成与安卓版一致的备份包上传到 WebDAV，并拉回合并远端更新。</p>
        </div>
      </div>

      {mode !== 'server' && (
        <p className={styles.fieldHint}>当前为本地模式，云备份由服务器提供；部署后端并连接后可用。</p>
      )}

      {mode === 'server' && (
        <>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>状态</span>
            <span className={styles.fieldHint}>
              {!loaded ? '读取中…' : error !== null ? error : enabled ? '已启用' : '未启用'}
            </span>
          </div>

          {enabled && status !== null && (
            <>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>服务器目录</span>
                <span className={styles.fieldHint}>{status.url === '' ? '—' : status.url}</span>
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>上次同步</span>
                <span className={styles.fieldHint}>{formatTime(status.lastSyncAt)}</span>
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>上次上传</span>
                <span className={styles.fieldHint}>{formatTime(status.lastUploadAt)}</span>
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>上次结果</span>
                <span className={styles.fieldHint}>
                  {resultText(status)}
                  {status.pendingChanges ? '（有待同步的改动）' : ''}
                </span>
              </div>

              <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void runSync()}>
                {busy ? '正在同步…' : '立即同步'}
              </button>

              <div className={styles.field}>
                <span className={styles.fieldLabel}>远端备份</span>
                {remoteFiles.length === 0 ? (
                  <span className={styles.fieldHint}>暂无</span>
                ) : (
                  <div className={styles.fileList}>
                    {remoteFiles.map((file) => (
                      <div key={file.name} className={styles.fileItem}>
                        <span className={styles.fileName}>{file.name}</span>
                        <span className={styles.fileMeta}>
                          {file.modifiedAt > 0 ? new Date(file.modifiedAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {loaded && !enabled && error === null && (
            <p className={styles.fieldHint}>
              后端未启用云备份，请在服务器端设置 WEBDAV_ENABLED 与 WEBDAV_URL 等环境变量后重启。
            </p>
          )}
        </>
      )}

      <p className={styles.fieldHint}>地址与口令已迁移到服务器端配置，本页不再保存凭据。</p>
    </div>
  );
}
