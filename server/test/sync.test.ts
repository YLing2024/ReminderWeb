import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeArchive } from '../src/backup-format.ts';
import { loadConfig } from '../src/config.ts';
import { getMeta, openDatabaseAt, setMeta } from '../src/db.ts';
import { readRevision, readServerData } from '../src/data.ts';
import type { Logger } from '../src/log.ts';
import { SyncEngine } from '../src/sync.ts';

/* ------------------------------------------------------------------ */
/* 内存假 WebDAV 服务                                                  */
/* ------------------------------------------------------------------ */

interface Stored {
  bytes: Uint8Array;
  lastModified: number;
  etag: string;
}

function createFakeWebDav(now: () => number) {
  const files = new Map<string, Stored>();
  const deletes: string[] = [];
  const methods: string[] = [];
  let seq = 0;

  const propfindBody = (): string => {
    const entries = [...files.entries()]
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
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:multistatus xmlns:d="DAV:">' +
      '<d:response><d:href>/reminder/</d:href></d:response>' +
      `${entries}</d:multistatus>`
    );
  };

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
    if (method === 'PROPFIND') return ok(207, propfindBody());
    if (method === 'PUT') {
      const bytes = new Uint8Array(init?.body as Uint8Array);
      seq += 1;
      files.set(name, { bytes, lastModified: now(), etag: `"e${seq}"` });
      return ok(201);
    }
    if (method === 'GET') {
      const file = files.get(name);
      if (file === undefined) return ok(404);
      return ok(200, file.bytes);
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
    putCount: () => methods.filter((m) => m === 'PUT').length,
    deleteCount: () => methods.filter((m) => m === 'DELETE').length,
  };
}

/* ------------------------------------------------------------------ */

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const BASE_CLOCK = Date.UTC(2026, 0, 1, 12, 0, 0);

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    AUTH_MODE: 'none',
    SERVE_STATIC: '0',
    WEBDAV_ENABLED: '1',
    WEBDAV_URL: 'https://dav.example.com/reminder',
    WEBDAV_USERNAME: 'davuser',
    WEBDAV_PASSWORD: 'secret',
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), ms));

test('空远端：同步一次上传一份基线包并置 ok', async () => {
  const clock = BASE_CLOCK;
  const db = openDatabaseAt(':memory:');
  const server = createFakeWebDav(() => clock);
  const engine = new SyncEngine(makeConfig(), db, silentLogger, { fetchImpl: server.fetchImpl, now: () => clock });
  try {
    const status = await engine.runCycle();
    assert.equal(status.enabled, true);
    assert.equal(status.lastResult, 'ok');
    assert.notEqual(status.lastUploadAt, null);
    assert.equal(status.pendingChanges, false);
    assert.equal(server.files.size, 1);
    const name = [...server.files.keys()][0]!;
    assert.match(name, /^reminder-backup-\d{8}-\d{6}\.zip$/);
    assert.equal(server.putCount(), 1);
    assert.equal(status.remoteFiles.length, 1);
  } finally {
    engine.stop();
    db.close();
  }
});

test('远端出现安卓新包：拉回合并并落库 revision++', async () => {
  const clock = BASE_CLOCK;
  const db = openDatabaseAt(':memory:');
  const server = createFakeWebDav(() => clock);
  server.files.set('reminder-backup-20260101-120000.zip', {
    bytes: androidPackage([androidItem(7, '安卓写的春节')]),
    lastModified: BASE_CLOCK,
    etag: '"android1"',
  });
  const engine = new SyncEngine(makeConfig(), db, silentLogger, { fetchImpl: server.fetchImpl, now: () => clock });
  try {
    await engine.runCycle();
    const data = readServerData(db);
    assert.equal(data.reminders.length, 1);
    assert.equal(data.reminders[0]?.id, 7);
    assert.equal(data.reminders[0]?.title, '安卓写的春节');
    assert.equal(data.reminders[0]?.updatedAt, BASE_CLOCK);
    assert.equal(readRevision(db), 1);
  } finally {
    engine.stop();
    db.close();
  }
});

test('无变化：重复同步不重复上传', async () => {
  const clock = BASE_CLOCK;
  const db = openDatabaseAt(':memory:');
  const server = createFakeWebDav(() => clock);
  const engine = new SyncEngine(makeConfig(), db, silentLogger, { fetchImpl: server.fetchImpl, now: () => clock });
  try {
    const first = await engine.runCycle();
    assert.equal(server.putCount(), 1);
    const second = await engine.runCycle();
    assert.equal(server.putCount(), 1, '远端与上次一致时不得再传');
    assert.equal(second.lastUploadAt, first.lastUploadAt);
    assert.equal(readRevision(db), 0);
  } finally {
    engine.stop();
    db.close();
  }
});

test('同一安卓包重复导入幂等：不产生新 revision / 新上传', async () => {
  const clock = BASE_CLOCK;
  const db = openDatabaseAt(':memory:');
  const server = createFakeWebDav(() => clock);
  const pkg = androidPackage([androidItem(7, '幂等')]);
  server.files.set('reminder-backup-20260101-120000.zip', { bytes: pkg, lastModified: BASE_CLOCK, etag: '"a"' });
  const engine = new SyncEngine(makeConfig(), db, silentLogger, { fetchImpl: server.fetchImpl, now: () => clock });
  try {
    await engine.runCycle();
    assert.equal(readRevision(db), 1);
    assert.equal(server.putCount(), 1);

    // 模拟「同一份包再次导入」：移除本轮上传的包并清掉处理标记，
    // 让同一份安卓包重新成为最新且 mtime 不变 → 合并应判定无变化。
    for (const name of [...server.files.keys()]) {
      if (name !== 'reminder-backup-20260101-120000.zip') server.files.delete(name);
    }
    setMeta(db, 'sync.lastProcessed', '');
    await engine.runCycle();
    assert.equal(readRevision(db), 1, '重复导入同一份包不得产生新 revision');
    assert.equal(server.putCount(), 1, '重复导入同一份包不得再次上传');
  } finally {
    engine.stop();
    db.close();
  }
});

test('坏包：记错误但服务继续，下轮可恢复', async () => {
  let clock = BASE_CLOCK;
  const db = openDatabaseAt(':memory:');
  const server = createFakeWebDav(() => clock);
  server.files.set('reminder-backup-20260101-120000.zip', {
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
    lastModified: BASE_CLOCK,
    etag: '"bad"',
  });
  const engine = new SyncEngine(makeConfig(), db, silentLogger, { fetchImpl: server.fetchImpl, now: () => clock });
  try {
    const failed = await engine.runCycle();
    assert.equal(failed.lastResult, 'error');
    assert.ok(failed.lastError !== null && failed.lastError.length > 0);
    assert.equal(readRevision(db), 0);

    // 远端换成一份较新的有效包，服务应继续并恢复。
    clock += 60_000;
    server.files.set('reminder-backup-20260101-120100.zip', {
      bytes: androidPackage([androidItem(9, '恢复')]),
      lastModified: clock,
      etag: '"good"',
    });
    const recovered = await engine.runCycle();
    assert.equal(recovered.lastResult, 'ok');
    assert.equal(recovered.lastError, null);
    assert.equal(readServerData(db).reminders[0]?.id, 9);
  } finally {
    engine.stop();
    db.close();
  }
});

test('清理：只删本服务上传过的旧包，绝不动安卓端的备份', async () => {
  let clock = BASE_CLOCK;
  const db = openDatabaseAt(':memory:');
  const server = createFakeWebDav(() => clock);
  const foreign = 'reminder-backup-20200101-000000.zip';
  server.files.set(foreign, {
    bytes: androidPackage([androidItem(100, '安卓历史')]),
    lastModified: BASE_CLOCK - 10_000_000,
    etag: '"foreign"',
  });
  const engine = new SyncEngine(makeConfig({ WEBDAV_KEEP: '1' }), db, silentLogger, {
    fetchImpl: server.fetchImpl,
    now: () => clock,
  });
  try {
    await engine.runCycle();
    const firstUpload = [...server.files.keys()].find((name) => name !== foreign)!;
    assert.ok(firstUpload !== undefined);

    // 本机再改一次 → debounce 0 触发第二次上传，keep=1 应删掉自己第一次传的包。
    clock += 60_000;
    engine.markLocalChange();
    await sleep(20);
    await engine.runCycle();

    assert.equal(server.deleteCount() >= 1, true);
    assert.equal(server.deletes.includes(firstUpload), true, '应删除自己上传过的旧包');
    assert.equal(server.deletes.includes(foreign), false, '不得删除安卓端的备份');
    assert.equal(server.files.has(foreign), true, '安卓端备份必须还在');

    const mine = [...server.files.keys()].filter((name) => name !== foreign);
    assert.equal(mine.length, 1, '本服务上传的包只保留 keep 份');

    const recorded = JSON.parse(getMeta(db, 'sync.uploaded') ?? '[]') as string[];
    assert.deepEqual(recorded, mine);
  } finally {
    engine.stop();
    db.close();
  }
});

test('status：未启用时 enabled=false 且不含凭据', async () => {
  const db = openDatabaseAt(':memory:');
  const config = loadConfig({ AUTH_MODE: 'none', SERVE_STATIC: '0', WEBDAV_ENABLED: '0', WEBDAV_PASSWORD: 'topsecret' });
  const engine = new SyncEngine(config, db, silentLogger);
  try {
    const status = engine.status();
    assert.equal(status.enabled, false);
    assert.equal(JSON.stringify(status).includes('topsecret'), false);
    assert.equal('username' in status, false);
    assert.equal('password' in status, false);
  } finally {
    db.close();
  }
});
