/**
 * M9 §1 §2 / M10 §4 服务端测试：同步配置读写 / 定时重排 / 云端备份列表、恢复、删除任意备份、立即备份、状态新字段。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { encodeArchive, decodeArchive } from '../src/backup-format.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabaseAt } from '../src/db.ts';
import { readRevision, readServerData } from '../src/data.ts';
import type { Logger } from '../src/log.ts';
import { SyncConfigError } from '../src/sync-config.ts';
import { SyncEngine } from '../src/sync.ts';
import { seedUser, sessionCookieFrom, startTestServer } from './helpers.ts';

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const BASE_CLOCK = Date.UTC(2026, 0, 1, 12, 0, 0);

interface Stored {
  bytes: Uint8Array;
  lastModified: number;
  etag: string;
}

/** 内存假 WebDAV：记录方法、删除名，供断言「绝不删除 / 只上传不拉取」。 */
function createFakeWebDav(now: () => number) {
  const files = new Map<string, Stored>();
  const deletes: string[] = [];
  const methods: string[] = [];
  let seq = 0;

  const propfindBody = (): string =>
    [...files.entries()]
      .map(
        ([name, file]) =>
          '<d:response>' +
          `<d:href>/reminder/${encodeURIComponent(name)}</d:href>` +
          '<d:propstat><d:prop>' +
          `<d:getcontentlength>${file.bytes.length}</d:getcontentlength>` +
          `<d:getlastmodified>${new Date(file.lastModified).toUTCString()}</d:getlastmodified>` +
          `<d:getetag>${file.etag}</d:getetag>` +
          '</d:prop></d:propstat></d:response>',
      )
      .join('');

  const fetchImpl = (async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    methods.push(method);
    const name = decodeURIComponent(url.pathname.replace(/^\/reminder\//, ''));
    const ok = (status: number, body: string | Uint8Array = '') => {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => null },
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      } as unknown as Response;
    };
    if (method === 'MKCOL') return ok(405);
    if (method === 'PROPFIND') {
      return ok(
        207,
        '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/reminder/</d:href></d:response>' +
          propfindBody() +
          '</d:multistatus>',
      );
    }
    if (method === 'PUT') {
      const bytes = new Uint8Array(init?.body as Uint8Array);
      seq += 1;
      files.set(name, { bytes, lastModified: now(), etag: `"e${seq}"` });
      return ok(201);
    }
    if (method === 'GET') {
      const file = files.get(name);
      return file === undefined ? ok(404) : ok(200, file.bytes);
    }
    if (method === 'DELETE') {
      deletes.push(name);
      files.delete(name);
      return ok(204);
    }
    return ok(400);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    files,
    deletes,
    methods,
    getCount: () => methods.filter((m) => m === 'GET').length,
    deleteCount: () => methods.filter((m) => m === 'DELETE').length,
    putCount: () => methods.filter((m) => m === 'PUT').length,
  };
}

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    AUTH_MODE: 'none',
    SERVE_STATIC: '0',
    WEBDAV_ENABLED: '1',
    WEBDAV_URL: 'https://dav.example.com/reminder',
    WEBDAV_USERNAME: 'davuser',
    WEBDAV_PASSWORD: 'topsecret',
    WEBDAV_ENCRYPT: '0',
    WEBDAV_INTERVAL_MINUTES: '10',
    WEBDAV_DEBOUNCE_SECONDS: '0',
    WEBDAV_KEEP: '10',
    ...overrides,
  });
}

function androidPackage(reminders: Array<Record<string, unknown>>): Uint8Array {
  return encodeArchive({ metadataJson: JSON.stringify({ reminders, tags: [] }) }, false);
}

function androidItem(id: number, title: string): Record<string, unknown> {
  return { id, title, date: '2026-02-17', type: 'ANNUAL', tag: '', isLunar: true, isPinned: false };
}

/* ------------------------------------------------------------------ */
/* §1 配置读写与非法值                                                 */
/* ------------------------------------------------------------------ */

test('配置默认值来自环境变量并落库', () => {
  const db = openDatabaseAt(':memory:');
  const config = makeConfig({ WEBDAV_INTERVAL_MINUTES: '30', WEBDAV_KEEP: '20' });
  const engine = new SyncEngine(config, db, silentLogger, { now: () => BASE_CLOCK });
  try {
    const view = engine.configView();
    assert.equal(view.enabled, true);
    assert.equal(view.intervalMinutes, 30);
    assert.equal(view.keep, 20);
    assert.deepEqual(view.options, { intervals: [5, 10, 30, 60], keepRange: [1, 50] });
    assert.equal(view.url, 'https://dav.example.com/reminder');
    assert.equal(JSON.stringify(view).includes('topsecret'), false);
  } finally {
    engine.stop();
    db.close();
  }
});

test('配置：关闭时 url 为空串且不含凭据', () => {
  const db = openDatabaseAt(':memory:');
  const engine = new SyncEngine(makeConfig({ WEBDAV_ENABLED: '0' }), db, silentLogger, { now: () => BASE_CLOCK });
  try {
    const view = engine.configView();
    assert.equal(view.enabled, false);
    assert.equal(view.url, '');
  } finally {
    engine.stop();
    db.close();
  }
});

test('配置改动落库，重启后仍以库里的值为准', () => {
  const db = openDatabaseAt(':memory:');
  const config = makeConfig();
  const first = new SyncEngine(config, db, silentLogger, { now: () => BASE_CLOCK });
  first.updateConfig({ enabled: false, intervalMinutes: 60, keep: 5 });
  first.stop();

  // 模拟重启：同一数据库 + 同样的环境变量（env 里 interval=10/keep=10 不应覆盖库值）。
  const second = new SyncEngine(config, db, silentLogger, { now: () => BASE_CLOCK });
  try {
    const view = second.configView();
    assert.equal(view.enabled, false);
    assert.equal(view.intervalMinutes, 60);
    assert.equal(view.keep, 5);
  } finally {
    second.stop();
    db.close();
  }
});

test('配置：非法值抛出中文错误', () => {
  const db = openDatabaseAt(':memory:');
  const engine = new SyncEngine(makeConfig(), db, silentLogger, { now: () => BASE_CLOCK });
  try {
    assert.throws(() => engine.updateConfig({ intervalMinutes: 7 }), SyncConfigError);
    assert.throws(() => engine.updateConfig({ intervalMinutes: 7 }), /5 \/ 10 \/ 30 \/ 60/);
    assert.throws(() => engine.updateConfig({ keep: 0 }), /1–50/);
    assert.throws(() => engine.updateConfig({ keep: 51 }), SyncConfigError);
    assert.throws(() => engine.updateConfig({ keep: 3.5 }), SyncConfigError);
    assert.throws(() => engine.updateConfig({ enabled: 'yes' }), SyncConfigError);
    assert.throws(() => engine.updateConfig({}), SyncConfigError);
    assert.throws(() => engine.updateConfig(null), SyncConfigError);
  } finally {
    engine.stop();
    db.close();
  }
});

test('配置改动立即重排定时器：改间隔 / 关闭 / 关→开立即排一次', () => {
  const db = openDatabaseAt(':memory:');
  const engine = new SyncEngine(makeConfig({ WEBDAV_INTERVAL_MINUTES: '10' }), db, silentLogger, {
    now: () => BASE_CLOCK,
  });
  try {
    engine.start();
    assert.equal(engine.status().nextSyncAt, BASE_CLOCK + 10 * 60_000);

    engine.updateConfig({ intervalMinutes: 30 });
    assert.equal(engine.status().nextSyncAt, BASE_CLOCK + 30 * 60_000);

    engine.updateConfig({ enabled: false });
    assert.equal(engine.status().nextSyncAt, null);

    engine.updateConfig({ enabled: true });
    // 关 → 开：立即排一次（delay=0）。
    assert.equal(engine.status().nextSyncAt, BASE_CLOCK);
  } finally {
    engine.stop();
    db.close();
  }
});

test('自动同步关闭时 markLocalChange 不排期，但 POST /now 仍可手动同步', async () => {
  const fake = createFakeWebDav(() => BASE_CLOCK);
  const db = openDatabaseAt(':memory:');
  const engine = new SyncEngine(makeConfig({ WEBDAV_ENABLED: '0' }), db, silentLogger, {
    fetchImpl: fake.fetchImpl,
    now: () => BASE_CLOCK,
  });
  try {
    engine.markLocalChange();
    assert.equal(engine.status().pendingChanges, false);

    const result = await engine.runNow();
    assert.notEqual(result, null);
    assert.equal(result?.lastResult, 'ok');
    assert.equal(fake.files.size, 1);
  } finally {
    engine.stop();
    db.close();
  }
});

test('POST /api/sync/config：默认值、合法更新、非法值 400（中文）', async () => {
  const fake = createFakeWebDav(() => BASE_CLOCK);
  let engine: SyncEngine | null = null;
  const ts = await startTestServer({
    env: {
      AUTH_MODE: 'none',
      SERVE_STATIC: '0',
      WEBDAV_ENABLED: '1',
      WEBDAV_URL: 'https://dav.example.com/reminder',
      WEBDAV_USERNAME: 'davuser',
      WEBDAV_PASSWORD: 'topsecret',
      WEBDAV_INTERVAL_MINUTES: '10',
      WEBDAV_KEEP: '10',
    },
    syncFactory: (db: DatabaseSync, config) => {
      engine = new SyncEngine(config, db, silentLogger, { fetchImpl: fake.fetchImpl, now: () => BASE_CLOCK });
      return engine;
    },
  });
  try {
    const initial = await fetch(`${ts.url}/api/sync/config`);
    assert.equal(initial.status, 200);
    const initialBody = (await initial.json()) as Record<string, unknown>;
    assert.equal(initialBody.enabled, true);
    assert.equal(initialBody.intervalMinutes, 10);
    assert.equal(initialBody.keep, 10);
    assert.equal(JSON.stringify(initialBody).includes('topsecret'), false);

    const updated = await fetch(`${ts.url}/api/sync/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, intervalMinutes: 60, keep: 3 }),
    });
    assert.equal(updated.status, 200);
    const updatedBody = (await updated.json()) as Record<string, unknown>;
    assert.equal(updatedBody.enabled, false);
    assert.equal(updatedBody.intervalMinutes, 60);
    assert.equal(updatedBody.keep, 3);
    assert.equal(updatedBody.url, '');

    const bad = await fetch(`${ts.url}/api/sync/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervalMinutes: 7 }),
    });
    assert.equal(bad.status, 400);
    const badBody = (await bad.json()) as Record<string, unknown>;
    assert.equal(badBody.error, 'invalid_config');
    assert.match(String(badBody.message), /5 \/ 10 \/ 30 \/ 60/);

    const badKeep = await fetch(`${ts.url}/api/sync/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keep: 99 }),
    });
    assert.equal(badKeep.status, 400);
    assert.match(String(((await badKeep.json()) as Record<string, unknown>).message), /1–50/);
  } finally {
    (engine as SyncEngine | null)?.stop();
    await ts.close();
  }
});

/* ------------------------------------------------------------------ */
/* §2 云端备份：列表 / 恢复 / 删除 / 立即备份 / 状态                    */
/* ------------------------------------------------------------------ */

const FOREIGN = 'reminder-backup-20260101-100000.zip';

function seedForeign(fake: ReturnType<typeof createFakeWebDav>): void {
  fake.files.set(FOREIGN, {
    bytes: androidPackage([androidItem(7, '安卓写的春节')]),
    lastModified: BASE_CLOCK - 10_000,
    etag: '"android1"',
  });
}

async function startSyncServer(fake: ReturnType<typeof createFakeWebDav>, env: Record<string, string> = {}) {
  let engine: SyncEngine | null = null;
  const ts = await startTestServer({
    env: {
      AUTH_MODE: 'none',
      SERVE_STATIC: '0',
      WEBDAV_ENABLED: '1',
      WEBDAV_URL: 'https://dav.example.com/reminder',
      WEBDAV_USERNAME: 'davuser',
      WEBDAV_PASSWORD: 'topsecret',
      WEBDAV_ENCRYPT: '0',
      WEBDAV_DEBOUNCE_SECONDS: '0',
      ...env,
    },
    syncFactory: (db: DatabaseSync, config) => {
      engine = new SyncEngine(config, db, silentLogger, { fetchImpl: fake.fetchImpl, now: () => BASE_CLOCK });
      engine.start();
      return engine;
    },
  });
  return { ts, getEngine: () => engine as SyncEngine | null };
}

async function loginCookie(url: string): Promise<string> {
  const login = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret' }),
  });
  return sessionCookieFrom(login);
}

test('status 新字段：nextSyncAt / lastMerged / lastAction', async () => {
  const fake = createFakeWebDav(() => BASE_CLOCK);
  seedForeign(fake);
  const { ts, getEngine } = await startSyncServer(fake);
  try {
    const before = (await (await fetch(`${ts.url}/api/sync/status`)).json()) as Record<string, unknown>;
    assert.equal(before.nextSyncAt, BASE_CLOCK + 10 * 60_000);
    assert.equal(before.lastMerged, 0);
    assert.equal(before.lastAction, 'none');

    const now = (await (await fetch(`${ts.url}/api/sync/now`, { method: 'POST' })).json()) as Record<string, unknown>;
    assert.equal(now.lastAction, 'pull');
    assert.ok(Number(now.lastMerged) >= 1);
    assert.equal(now.nextSyncAt, BASE_CLOCK + 10 * 60_000);

    const upload = (await (await fetch(`${ts.url}/api/sync/upload`, { method: 'POST' })).json()) as Record<string, unknown>;
    assert.equal(upload.lastUploadAt, BASE_CLOCK);
    const afterUpload = (await (await fetch(`${ts.url}/api/sync/status`)).json()) as Record<string, unknown>;
    assert.equal(afterUpload.lastAction, 'upload');
  } finally {
    getEngine()?.stop();
    await ts.close();
  }
});

test('GET /api/sync/files：列出 name/size/modifiedAt，时间倒序，不含 isOwn', async () => {
  const fake = createFakeWebDav(() => BASE_CLOCK);
  seedForeign(fake);
  fake.files.set('reminder-backup-20260102-120000.zip', {
    bytes: androidPackage([androidItem(8, '另一台')]),
    lastModified: BASE_CLOCK - 5000,
    etag: '"x"',
  });
  const { ts, getEngine } = await startSyncServer(fake);
  try {
    await fetch(`${ts.url}/api/sync/upload`, { method: 'POST' });
    const response = await fetch(`${ts.url}/api/sync/files`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { files: Array<Record<string, unknown>> };
    assert.ok(Array.isArray(body.files));
    assert.equal(body.files.length, 3);
    // 倒序：本服务刚上传（lastModified=BASE_CLOCK）在最前，其次 20260102，最后 20260101。
    assert.equal(typeof body.files[0]?.size, 'number');
    assert.equal(body.files[0]?.isOwn, undefined, '不再返回 isOwn');
    assert.equal(body.files[1]?.name, 'reminder-backup-20260102-120000.zip');
    assert.equal(body.files[2]?.name, FOREIGN);
    assert.equal(JSON.stringify(body).includes('topsecret'), false);
  } finally {
    getEngine()?.stop();
    await ts.close();
  }
});

test('POST /api/sync/restore：正常合并、幂等、绝不 DELETE', async () => {
  const fake = createFakeWebDav(() => BASE_CLOCK);
  seedForeign(fake);
  const { ts, getEngine } = await startSyncServer(fake);
  try {
    const first = await fetch(`${ts.url}/api/sync/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: FOREIGN }),
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { applied: Record<string, number>; revision: number };
    assert.equal(firstBody.applied.added, 1);
    assert.equal(firstBody.applied.updated, 0);
    assert.equal(firstBody.applied.removed, 0);
    assert.equal(firstBody.revision, 1);

    const second = await fetch(`${ts.url}/api/sync/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: FOREIGN }),
    });
    const secondBody = (await second.json()) as { applied: Record<string, number>; revision: number };
    assert.deepEqual(secondBody.applied, { updated: 0, added: 0, removed: 0, rejected: 0 });
    assert.equal(secondBody.revision, 1);

    assert.equal(fake.deleteCount(), 0, '恢复绝不能发出 DELETE');
    assert.equal(fake.files.has(FOREIGN), true, '恢复绝不删除远端文件');

    const status = (await (await fetch(`${ts.url}/api/sync/status`)).json()) as Record<string, unknown>;
    assert.equal(status.lastAction, 'restore');
    assert.equal(status.lastMerged, 0, '幂等第二次合并 0 条');
    const data = readServerData(ts.db);
    assert.equal(data.reminders.length, 1);
    assert.equal(data.reminders[0]?.id, 7);
    assert.equal(readRevision(ts.db), 1);
  } finally {
    getEngine()?.stop();
    await ts.close();
  }
});

test('图片往返：恢复含 images/ 的安卓包后，背景图路径保留并随下次上传的 metadata 输出', async () => {
  const fake = createFakeWebDav(() => BASE_CLOCK);
  const withImage = 'reminder-backup-20260104-120000.zip';
  const item = {
    ...androidItem(9, '带背景图'),
    cardBackgroundType: 'IMAGE',
    cardBackgroundImagePath: 'images/bg.jpg',
  };
  fake.files.set(withImage, {
    bytes: encodeArchive(
      {
        metadataJson: JSON.stringify({ reminders: [item], tags: [] }),
        images: { 'bg.jpg': new Uint8Array([1, 2, 3, 4]) },
      },
      false,
    ),
    lastModified: BASE_CLOCK - 1,
    etag: '"img"',
  });
  const { ts, getEngine } = await startSyncServer(fake);
  try {
    const restored = await fetch(`${ts.url}/api/sync/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: withImage }),
    });
    assert.equal(restored.status, 200);
    const data = readServerData(ts.db);
    assert.equal(data.reminders[0]?.cardBackgroundImagePath, 'images/bg.jpg');

    const upload = (await (await fetch(`${ts.url}/api/sync/upload`, { method: 'POST' })).json()) as { name: string };
    const uploaded = fake.files.get(upload.name);
    assert.ok(uploaded !== undefined);
    const content = decodeArchive(uploaded.bytes);
    const metadata = JSON.parse(content.metadataJson) as { reminders: Array<Record<string, unknown>> };
    assert.equal(metadata.reminders[0]?.cardBackgroundImagePath, 'images/bg.jpg');
  } finally {
    getEngine()?.stop();
    await ts.close();
  }
});

test('POST /api/sync/restore：名字非法 400 / 不存在 404 / 坏包 400', async () => {
  const fake = createFakeWebDav(() => BASE_CLOCK);
  fake.files.set('reminder-backup-20260103-120000.zip', {
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
    lastModified: BASE_CLOCK,
    etag: '"bad"',
  });
  const { ts, getEngine } = await startSyncServer(fake);
  const restore = (name: unknown) =>
    fetch(`${ts.url}/api/sync/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  try {
    assert.equal((await restore('evil.sh')).status, 400);
    assert.equal((await restore('reminder-backup-20260101-120000.zip')).status, 404);
    const bad = await restore('reminder-backup-20260103-120000.zip');
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as Record<string, unknown>).error, 'invalid_backup');
    assert.equal(fake.deleteCount(), 0);
  } finally {
    getEngine()?.stop();
    await ts.close();
  }
});

test('DELETE /api/sync/files/:name：任何本应用备份都能删，非本应用名 400，不存在 404', async () => {
  const fake = createFakeWebDav(() => BASE_CLOCK);
  seedForeign(fake);
  // 同目录下的非备份文件：删除操作绝不允许碰它。
  fake.files.set('notes.txt', { bytes: new TextEncoder().encode('keep me'), lastModified: BASE_CLOCK, etag: '"n"' });
  const { ts, getEngine } = await startSyncServer(fake);
  try {
    const upload = (await (await fetch(`${ts.url}/api/sync/upload`, { method: 'POST' })).json()) as { name: string };
    assert.ok(upload.name.startsWith('reminder-backup-'));

    // 其它设备上传的包也能删除（不再 403）。
    const foreign = await fetch(`${ts.url}/api/sync/files/${FOREIGN}`, { method: 'DELETE' });
    assert.equal(foreign.status, 200);
    assert.equal(fake.files.has(FOREIGN), false);
    assert.equal(fake.files.has('notes.txt'), true, '绝不碰同目录其它文件');

    const missing = await fetch(`${ts.url}/api/sync/files/reminder-backup-20200101-000000.zip`, { method: 'DELETE' });
    assert.equal(missing.status, 404);

    // 非 reminder-backup-*.zip 一律拒绝（即使文件真的存在）。
    const invalid = await fetch(`${ts.url}/api/sync/files/notes.txt`, { method: 'DELETE' });
    assert.equal(invalid.status, 400);
    assert.equal(fake.files.has('notes.txt'), true);

    const own = await fetch(`${ts.url}/api/sync/files/${upload.name}`, { method: 'DELETE' });
    assert.equal(own.status, 200);
    assert.equal(fake.files.has(upload.name), false);

    const after = (await (await fetch(`${ts.url}/api/sync/files`)).json()) as { files: unknown[] };
    assert.equal(after.files.length, 0, '两份备份都已删除');
  } finally {
    getEngine()?.stop();
    await ts.close();
  }
});

test('POST /api/sync/upload：只上传不拉取，返回 name/size/lastUploadAt', async () => {
  const fake = createFakeWebDav(() => BASE_CLOCK);
  seedForeign(fake);
  const { ts, getEngine } = await startSyncServer(fake);
  try {
    fake.methods.length = 0;
    const response = await fetch(`${ts.url}/api/sync/upload`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { name: string; size: number; lastUploadAt: number };
    assert.ok(body.name.startsWith('reminder-backup-'));
    assert.ok(body.size > 0);
    assert.equal(body.lastUploadAt, BASE_CLOCK);
    assert.equal(fake.files.has(body.name), true);
    assert.equal(fake.getCount(), 0, '立即备份不得拉取（无 GET）');
    assert.equal(fake.putCount(), 1);
  } finally {
    getEngine()?.stop();
    await ts.close();
  }
});

test('sync 新接口需认证', async () => {
  const fake = createFakeWebDav(() => BASE_CLOCK);
  const ts = await startTestServer({
    env: {
      AUTH_MODE: 'builtin',
      SERVE_STATIC: '0',
      WEBDAV_ENABLED: '1',
      WEBDAV_URL: 'https://dav.example.com/reminder',
    },
    setup: (db) => seedUser(db, 'admin', 'secret'),
    syncFactory: (db: DatabaseSync, config) => new SyncEngine(config, db, silentLogger, { fetchImpl: fake.fetchImpl }),
  });
  try {
    for (const [method, path] of [
      ['GET', '/api/sync/config'],
      ['PUT', '/api/sync/config'],
      ['GET', '/api/sync/files'],
      ['POST', '/api/sync/restore'],
      ['POST', '/api/sync/upload'],
      ['DELETE', `/api/sync/files/${FOREIGN}`],
    ] as const) {
      const response = await fetch(`${ts.url}${path}`, { method });
      assert.equal(response.status, 401, `${method} ${path} 应需认证`);
    }
    assert.ok((await fetch(`${ts.url}/api/sync/config`, { headers: { cookie: await loginCookie(ts.url) } })).status === 200);
  } finally {
    await ts.close();
  }
});
