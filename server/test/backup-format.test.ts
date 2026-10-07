import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BackupFormatError,
  backupFileName,
  buildBackupMetadata,
  decodeArchive,
  encodeArchive,
  parseBackupMetadata,
} from '../src/backup-format.ts';
import { decryptArchive, encryptArchive, isZip, obfuscatedKey } from '../src/backup-crypto.ts';
import { zipCreate, zipExtract } from '../src/zip.ts';
import type { ServerData } from '../src/data.ts';

/* ------------------------------------------------------------------ */
/* 前端既有实现的交叉引用（用变量路径做动态导入，tsc 不静态解析，避免把前端
   DOM 依赖拉进后端类型检查；运行时由 Node 直接执行前端纯函数）。      */
/* ------------------------------------------------------------------ */

interface FrontendBackup {
  OBFUSCATED_KEY: readonly number[];
  encryptArchive(zip: Uint8Array): Promise<Uint8Array>;
  tryDecryptArchive(data: Uint8Array): Promise<Uint8Array | null>;
  encodeArchive(input: { metadataJson: string; images?: Record<string, Uint8Array> }, encrypt: boolean): Promise<Uint8Array>;
  decodeArchive(data: Uint8Array): Promise<{ metadataJson: string; images: Record<string, Uint8Array> }>;
}

const FRONTEND_BACKUP_PATH: string = '../../src/lib/backup.ts';
let frontendPromise: Promise<FrontendBackup> | null = null;
function loadFrontend(): Promise<FrontendBackup> {
  if (frontendPromise === null) frontendPromise = import(FRONTEND_BACKUP_PATH) as Promise<FrontendBackup>;
  return frontendPromise;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('zip：写入后解出条目逐字节一致（含中文文件名与大文件）', () => {
  const files: Record<string, Uint8Array> = {
    'metadata.json': encoder.encode(JSON.stringify({ reminders: [{ id: 1, title: '春节' }] })),
    'images/背景.png': new Uint8Array(Array.from({ length: 5000 }, (_, i) => i % 256)),
  };
  const zip = zipCreate(files);
  assert.equal(isZip(zip), true);
  const out = zipExtract(zip);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(files).sort());
  assert.deepEqual(Array.from(out['images/背景.png']!), Array.from(files['images/背景.png']!));
  assert.equal(decoder.decode(out['metadata.json']!), decoder.decode(files['metadata.json']!));
});

test('加密：服务端密钥常量与前端逐字节一致', async () => {
  const frontend = await loadFrontend();
  assert.deepEqual(Array.from(frontend.OBFUSCATED_KEY), Array.from(obfuscatedKey()));
});

test('加密互通：服务端加密 → 前端解密 → 前端解包', async () => {
  const frontend = await loadFrontend();
  const metadataJson = JSON.stringify({ reminders: [{ id: 1, title: '互通', isLunar: true }], tags: [] });
  const archive = encodeArchive({ metadataJson }, true);
  assert.equal(isZip(archive), false);

  const zipBytes = await frontend.tryDecryptArchive(archive);
  assert.notEqual(zipBytes, null);
  const content = await frontend.decodeArchive(archive);
  assert.equal(content.metadataJson, metadataJson);
});

test('加密互通：前端加密 → 服务端解密 → 服务端解包', async () => {
  const frontend = await loadFrontend();
  const metadataJson = JSON.stringify({ reminders: [{ id: 2, title: '反向' }], tags: [] });
  const zip = zipCreate({ 'metadata.json': encoder.encode(metadataJson) });
  const archive = await frontend.encryptArchive(zip);
  const content = decodeArchive(archive);
  assert.equal(content.metadataJson, metadataJson);
});

test('同数据两次打包，解出 metadata 深相等', () => {
  const metadataJson = JSON.stringify({ reminders: [{ id: 1, title: '稳定' }] });
  const a = decodeArchive(encodeArchive({ metadataJson }, false));
  const b = decodeArchive(encodeArchive({ metadataJson }, true));
  assert.deepEqual(JSON.parse(a.metadataJson), JSON.parse(b.metadataJson));
  assert.deepEqual(a.metadataJson, b.metadataJson);
});

test('decodeArchive：坏包 / 缺 metadata 报可读中文错误', () => {
  assert.throws(() => decodeArchive(new Uint8Array([1, 2, 3])), BackupFormatError);
  const noMetadata = zipCreate({ 'images/x.png': new Uint8Array([1]) });
  assert.throws(() => decodeArchive(noMetadata), /metadata\.json/);
  assert.throws(() => decodeArchive(new Uint8Array(0)), BackupFormatError);
});

test('decryptArchive：篡改密文返回 null 不抛异常', () => {
  const archive = encryptArchive(encoder.encode('hello world'));
  const tampered = archive.slice();
  tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;
  assert.equal(decryptArchive(tampered), null);
});

test('backupFileName：reminder-backup-yyyyMMdd-HHmmss.zip', () => {
  assert.equal(backupFileName(new Date(2026, 9, 7, 16, 15, 3)), 'reminder-backup-20261007-161503.zip');
  assert.equal(backupFileName(new Date(2026, 0, 2, 3, 4, 5)), 'reminder-backup-20260102-030405.zip');
});

test('parseBackupMetadata：安卓 7-key 条目补齐并注入同批 updatedAt', () => {
  const json = JSON.stringify({
    reminders: [
      { id: 1, title: '春节', date: '2026-02-17', type: 'ANNUAL', tag: '节日', isLunar: true, isPinned: true },
      { id: 0, title: '非法 id 丢弃' },
    ],
    tags: [{ id: 3, name: '节日' }],
    themeOption: 'DARK',
    pureBlackEnabled: true,
  });
  const parsed = parseBackupMetadata(json, 1_700_000_000_000);
  assert.equal(parsed.rejected, 1);
  assert.equal(parsed.reminders.length, 1);
  assert.equal(parsed.reminders[0]?.updatedAt, 1_700_000_000_000);
  assert.equal(parsed.reminders[0]?.isLunar, true);
  assert.equal(parsed.reminders[0]?.title, '春节');
  assert.equal(parsed.tags[0]?.updatedAt, 1_700_000_000_000);
  assert.deepEqual(parsed.settings, { value: { themeOption: 'DARK', pureBlackEnabled: true }, updatedAt: 1_700_000_000_000 });
});

test('parseBackupMetadata：缺 reminders 抛错；无设置字段时 settings 为 null', () => {
  assert.throws(() => parseBackupMetadata(JSON.stringify({ tags: [] }), 1), /reminders/);
  const parsed = parseBackupMetadata(JSON.stringify({ reminders: [] }), 1);
  assert.equal(parsed.settings, null);
});

test('buildBackupMetadata：条目不含 updatedAt，设置字段回填', () => {
  const state: ServerData = {
    reminders: [{ id: 1, updatedAt: 99, title: '甲', isLunar: false }],
    tags: [{ id: 1, updatedAt: 99, name: '工作', color: '#2196F3', sortOrder: 1 }],
    settings: { value: { themeOption: 'LIGHT', pureBlackEnabled: true }, updatedAt: 99 },
    tombstones: [],
  };
  const data = JSON.parse(buildBackupMetadata(state)) as Record<string, unknown>;
  assert.equal((data.reminders as Array<Record<string, unknown>>)[0]?.updatedAt, undefined);
  assert.equal(data.themeOption, 'LIGHT');
  assert.equal(data.pureBlackEnabled, true);
  assert.equal(data.webDavPassword, null);
});
