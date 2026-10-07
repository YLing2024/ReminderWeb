import { useState } from 'react';
import { ConfirmDialog, Toggle } from './ui';
import { listCloudBackups, restoreCloudBackup, uploadCurrentBackup, webDavConfigFrom } from '../lib/cloud-backup';
import { testConnection, type WebDavFile } from '../lib/webdav';
import { useReminderStore } from '../store/useReminderStore';
import styles from './WebDavSettings.module.css';

type Busy = 'test' | 'upload' | 'list' | 'restore' | null;

function formatTime(timestamp: number | null): string {
  if (timestamp === null) return '暂无';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}

export function WebDavSettings({ onNotice }: { onNotice: (message: string) => void }) {
  const settings = useReminderStore((state) => state.settings);
  const updateSettings = useReminderStore((state) => state.updateSettings);
  const reminders = useReminderStore((state) => state.reminders);
  const tags = useReminderStore((state) => state.tags);
  const importData = useReminderStore((state) => state.importData);

  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [remoteFiles, setRemoteFiles] = useState<WebDavFile[] | null>(null);
  const [restoreFile, setRestoreFile] = useState<WebDavFile | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const disabled = !settings.webdavEnabled;
  const working = busy !== null;

  const ensureConfigured = (): boolean => {
    if (settings.webdavServer.trim() === '') {
      onNotice('请先填写服务器地址');
      return false;
    }
    return true;
  };

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
      const files = await listCloudBackups(settings);
      if (files.length === 0) {
        onNotice('云端还没有备份');
        return;
      }
      setRemoteFiles(files);
    } catch (error) {
      onNotice(`无法获取云端备份：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const runRestore = async (file: WebDavFile) => {
    setBusy('restore');
    try {
      const result = await restoreCloudBackup(settings, file.name);
      await importData({ reminders: result.reminders, tags: result.tags, settings: result.settings });
      onNotice(
        `已恢复 ${result.reminders.length} 条提醒、${result.tags.length} 个标签、${result.imageCount} 张图片。`,
      );
    } catch (error) {
      onNotice(`恢复失败：${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.card}>
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
        <span className={styles.fieldLabel}>密码</span>
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
          {busy === 'upload' ? '正在上传…' : '立即上传备份'}
        </button>
      </div>
      <button type="button" className={styles.secondaryButton} disabled={disabled || working} onClick={() => void runList()}>
        {busy === 'list' ? '正在获取…' : '从云端恢复'}
      </button>

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

      <div className={styles.status} role="status">
        <p className={styles.statusLine}>
          当前状态：
          {busy === 'upload'
            ? '正在上传'
            : busy === 'restore'
              ? '正在恢复'
              : busy === 'test'
                ? '正在测试连接'
                : busy === 'list'
                  ? '正在获取云端备份'
                  : '空闲'}
        </p>
        <p className={styles.statusLine}>上次成功：{formatTime(settings.webdavLastSuccessAt)}</p>
        {settings.webdavLastResult !== null && <p className={styles.statusLine}>上次结果：{settings.webdavLastResult}</p>}
      </div>

      <button
        type="button"
        className={styles.textButton}
        disabled={disabled || working}
        onClick={() => {
          void updateSettings({ webdavUsername: '', webdavPassword: '' });
          setShowPassword(false);
          onNotice('已清除云备份凭据');
        }}
      >
        清除云备份凭据
      </button>

      {remoteFiles !== null && (
        <div className={styles.dialogBackdrop} role="presentation" onClick={() => setRemoteFiles(null)}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="从云端恢复" onClick={(event) => event.stopPropagation()}>
            <h2 className={styles.dialogTitle}>云端备份</h2>
            <div className={styles.fileList}>
              {remoteFiles.map((file) => (
                <button
                  key={file.name}
                  type="button"
                  className={styles.fileItem}
                  onClick={() => {
                    setRemoteFiles(null);
                    setRestoreFile(file);
                  }}
                >
                  <span className={styles.fileName}>{file.name}</span>
                  <span className={styles.fileMeta}>
                    {file.lastModified > 0 ? new Date(file.lastModified).toLocaleString('zh-CN', { hour12: false }) : '时间未知'}
                    {' · '}
                    {formatSize(file.size)}
                  </span>
                </button>
              ))}
            </div>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.textButton} onClick={() => setRemoteFiles(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={restoreFile !== null && !confirmOverwrite}
        title="从云端恢复"
        message={`将从云端下载「${restoreFile?.name ?? ''}」覆盖当前全部数据，此操作不可撤销。`}
        confirmText="继续"
        onCancel={() => setRestoreFile(null)}
        onConfirm={() => setConfirmOverwrite(true)}
      />
      <ConfirmDialog
        open={confirmOverwrite}
        title="确认覆盖"
        message="覆盖后当前全部提醒、标签与设置将被云端备份替换，无法恢复。"
        confirmText="确认覆盖"
        danger
        onCancel={() => {
          setConfirmOverwrite(false);
          setRestoreFile(null);
        }}
        onConfirm={() => {
          const file = restoreFile;
          setConfirmOverwrite(false);
          setRestoreFile(null);
          if (file !== null) void runRestore(file);
        }}
      />
    </div>
  );
}
