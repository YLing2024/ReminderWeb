/**
 * 「WebDAV 云备份」分组的纯展示逻辑（M9 §3）：
 * 时间 / 大小 / 动作文案与「能否删除」判定，便于单测且与组件解耦。
 */
import type { RemoteBackupEntry, SyncAction, SyncStatus } from './api';

/** 时间戳 → 本地时间文案。 */
export function formatSyncTime(timestamp: number | null): string {
  if (timestamp === null || timestamp <= 0) return '暂无';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

/** 字节数 → 可读大小。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 同步动作 → 中文短句。 */
export function actionLabel(action: SyncAction): string {
  if (action === 'upload') return '上传备份';
  if (action === 'pull') return '拉取合并';
  if (action === 'restore') return '从备份恢复';
  return '暂无';
}

/** 恢复结果里实际合并的条目数（更新 + 新增 + 删除）。 */
export function appliedTotal(applied: { updated: number; added: number; removed: number }): number {
  return applied.updated + applied.added + applied.removed;
}

/** 安装删除按钮的置灰原因；`null` 表示可删除。 */
export function deleteDisabledReason(entry: Pick<RemoteBackupEntry, 'isOwn'>): string | null {
  return entry.isOwn ? null : '别的设备上传的备份，不能在本机删除';
}

/** 状态摘要里「上次结果」文案。 */
export function lastResultText(status: SyncStatus): string {
  if (status.lastResult === null) return '尚未同步';
  if (status.lastResult === 'ok') return '成功';
  return status.lastError === null ? '失败' : `失败：${status.lastError}`;
}

/** 恢复前二次确认文案（M9 §3.7）。 */
export function restoreConfirmMessage(name: string): string {
  return `将把「${name}」合并进当前数据，不会删除本地已有的条目，也不会删除云端文件。`;
}

/** 删除前二次确认文案。 */
export function deleteConfirmMessage(name: string): string {
  return `将从云端删除「${name}」，删除后无法恢复。`;
}
