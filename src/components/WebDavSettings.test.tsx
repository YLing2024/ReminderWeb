import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { CloudBackupList, SyncStatusPanel, WebDavSettings } from './WebDavSettings';
import type { SyncStatus } from '../lib/api';

const OWN = {
  name: 'reminder-backup-20260102-120000.zip',
  size: 2048,
  modifiedAt: 1_700_000_000_000,
  isOwn: true,
};
const FOREIGN = {
  name: 'reminder-backup-20260101-120000.zip',
  size: 512,
  modifiedAt: 1_690_000_000_000,
  isOwn: false,
};

const STATUS: SyncStatus = {
  enabled: true,
  url: 'https://dav.example.com/reminder/',
  lastSyncAt: 1_700_000_000_000,
  lastUploadAt: 1_700_000_000_000,
  lastResult: 'ok',
  lastError: null,
  pendingChanges: true,
  remoteFiles: [],
  nextSyncAt: 1_700_000_600_000,
  lastMerged: 3,
  lastAction: 'restore',
};

describe('CloudBackupList 云端备份列表', () => {
  it('空态显示「云端还没有备份」', () => {
    const html = renderToString(
      createElement(CloudBackupList, { files: [], onRestore: () => {}, onDelete: () => {}, busy: false }),
    );
    expect(html).toContain('云端还没有备份');
  });

  it('渲染名称/大小/恢复删除；别人的包删除按钮置灰并给出原因', () => {
    const html = renderToString(
      createElement(CloudBackupList, {
        files: [OWN, FOREIGN],
        onRestore: () => {},
        onDelete: () => {},
        busy: false,
      }),
    );
    expect(html).toContain(OWN.name);
    expect(html).toContain(FOREIGN.name);
    expect(html).toContain('2.0 KB');
    expect(html).toContain('512 B');
    expect(html.match(/>恢复<\/button>/g)?.length).toBe(2);
    expect(html.match(/>删除<\/button>/g)?.length).toBe(2);
    // 只有别人的包那个删除按钮被禁用。
    expect(html.match(/disabled=""/g)?.length).toBe(1);
    expect(html).toContain('别的设备上传的备份，不能在本机删除');
    expect(html).toContain('本设备上传');
  });

  it('busy 时恢复与删除按钮都禁用', () => {
    const html = renderToString(
      createElement(CloudBackupList, {
        files: [OWN],
        onRestore: () => {},
        onDelete: () => {},
        busy: true,
      }),
    );
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});

describe('SyncStatusPanel 状态渲染', () => {
  it('启用 + 待上传 + 下次自动同步 + 动作/结果', () => {
    const html = renderToString(
      createElement(SyncStatusPanel, { loaded: true, error: null, enabled: true, status: STATUS }),
    );
    expect(html).toContain('已启用');
    expect(html).toContain('https://dav.example.com/reminder/');
    expect(html).toContain('有改动待上传');
    expect(html).toContain('从备份恢复');
    expect(html).toContain('成功');
    expect(html).toContain('下次自动同步');
  });

  it('未加载 / 未启用 / 尚未同步', () => {
    const html = renderToString(
      createElement(SyncStatusPanel, {
        loaded: false,
        error: null,
        enabled: false,
        status: null,
      }),
    );
    expect(html).toContain('读取中…');
    expect(html).toContain('尚未同步');
    expect(html).toContain('暂无');
  });

  it('读取失败时显示错误文案', () => {
    const html = renderToString(
      createElement(SyncStatusPanel, { loaded: true, error: '连不上服务器', enabled: false, status: null }),
    );
    expect(html).toContain('连不上服务器');
  });
});

describe('WebDavSettings 分组外壳', () => {
  it('顶部说明这些设置存服务器、且不再保存凭据', () => {
    const html = renderToString(createElement(WebDavSettings, { onNotice: () => {} }));
    expect(html).toContain('这些设置在服务器上，所有设备一致');
    expect(html).toContain('地址与口令已迁移到服务器端配置，本页不再保存凭据');
  });
});
