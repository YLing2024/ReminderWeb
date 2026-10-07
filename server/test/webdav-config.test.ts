/**
 * M13 服务器模式 WebDAV 设置：优先级、首次落库、部分更新、口令留空不改、
 * 口令不明文回传、非法值 400（中文）、上传用新配置、审计无口令明文。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.ts';
import { openDatabaseAt } from '../src/db.ts';
import type { Logger } from '../src/log.ts';
import {
  applyWebdavConfigPatch,
  readServerSettings,
  serverSettingsView,
} from '../src/server-settings.ts';
import { SyncEngine } from '../src/sync.ts';
import { startTestServer } from './helpers.ts';

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const ENV_DAV = {
  AUTH_MODE: 'none',
  SERVE_STATIC: '0',
  WEBDAV_ENABLED: '1',
  WEBDAV_URL: 'https://dav.example.com/old',
  WEBDAV_USERNAME: 'olduser',
  WEBDAV_PASSWORD: 'oldpass',
  WEBDAV_ENCRYPT: '0',
  WEBDAV_DEBOUNCE_SECONDS: '0',
  WEBDAV_INTERVAL_MINUTES: '10',
  WEBDAV_KEEP: '10',
} as const;

interface Captured {
  method: string;
  url: string;
  authorization: string | undefined;
}

/** 本地假 WebDAV：记录每次请求的方法、完整 URL 与 Authorization。 */
function createCaptureWebDav() {
  const requests: Captured[] = [];
  const files = new Map<string, Uint8Array>();
  const fetchImpl = (async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ method, url: url.href, authorization: headers.Authorization });
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
    const name = decodeURIComponent(url.pathname.replace(/^\/[^/]*\//, ''));
    if (method === 'MKCOL') return ok(405);
    if (method === 'PROPFIND') {
      const body = [...files.entries()]
        .map(
          ([fileName, bytes]) =>
            `<d:response><d:href>/${encodeURIComponent(fileName)}</d:href><d:propstat><d:prop>` +
            `<d:getcontentlength>${bytes.length}</d:getcontentlength>` +
            `<d:getlastmodified>${new Date(1_700_000_000_000).toUTCString()}</d:getlastmodified>` +
            `<d:getetag>"e"</d:getetag></d:prop></d:propstat></d:response>`,
        )
        .join('');
      return ok(207, `<d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`);
    }
    if (method === 'PUT') {
      files.set(name, new Uint8Array(init?.body as Uint8Array));
      return ok(201);
    }
    if (method === 'GET') {
      const bytes = files.get(name);
      return bytes === undefined ? ok(404) : ok(200, bytes);
    }
    if (method === 'DELETE') {
      files.delete(name);
      return ok(204);
    }
    return ok(400);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests, files };
}

async function startWebdavConfigServer(fake: ReturnType<typeof createCaptureWebDav>) {
  let engine: SyncEngine | null = null;
  const ts = await startTestServer({
    env: ENV_DAV,
    syncFactory: (db: DatabaseSync, config) => {
      engine = new SyncEngine(config, db, silentLogger, { fetchImpl: fake.fetchImpl, now: () => 1_700_000_000_000 });
      engine.start();
      return engine;
    },
  });
  return { ts, getEngine: () => engine as SyncEngine | null };
}

const getConfig = (url: string) =>
  fetch(`${url}/api/webdav/config`).then((res) => res.json() as Promise<Record<string, unknown>>);

const putConfig = (url: string, patch: unknown) =>
  fetch(`${url}/api/webdav/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });

/* ------------------------------------------------------------------ */

test('优先级：库值 > 环境变量；首次读取用 env 落库', () => {
  const db = openDatabaseAt(':memory:');
  const envA = loadConfig(ENV_DAV);
  try {
    const seeded = readServerSettings(db, envA);
    assert.equal(seeded.webdavUrl, 'https://dav.example.com/old');
    assert.equal(seeded.webdavUsername, 'olduser');
    assert.equal(seeded.webdavPassword, 'oldpass');
    assert.equal(seeded.webdavIntervalMinutes, 10);
    assert.equal(seeded.webdavKeep, 10);

    // 环境变量改成另一组：已落库的字段仍以库为准。
    const envB = loadConfig({
      ...ENV_DAV,
      WEBDAV_URL: 'https://dav.example.com/env-b',
      WEBDAV_USERNAME: 'env-b-user',
    });
    const again = readServerSettings(db, envB);
    assert.equal(again.webdavUrl, 'https://dav.example.com/old', '库值应覆盖 env');
    assert.equal(again.webdavUsername, 'olduser', '库值应覆盖 env');

    // 部分更新落库后，env 仍不生效。
    applyWebdavConfigPatch(db, envB, { webdavUrl: 'https://dav.example.com/db-new' });
    assert.equal(readServerSettings(db, envB).webdavUrl, 'https://dav.example.com/db-new');
  } finally {
    db.close();
  }
});

test('GET 回落 env；PUT 部分更新后不重启即新值；口令不明文回传', async () => {
  const fake = createCaptureWebDav();
  const { ts, getEngine } = await startWebdavConfigServer(fake);
  try {
    const initial = await getConfig(ts.url);
    assert.equal(initial.webdavEnabled, true);
    assert.equal(initial.webdavUrl, 'https://dav.example.com/old');
    assert.equal(initial.webdavUsername, 'olduser');
    assert.equal(initial.webdavPasswordSet, true);
    assert.equal(initial.webdavIntervalMinutes, 10);
    assert.equal(initial.webdavKeep, 10);
    assert.equal(JSON.stringify(initial).includes('oldpass'), false, 'GET 绝不回传口令明文');
    assert.equal('webdavPassword' in initial, false);

    // 只改地址与间隔：其它字段保持不变。
    const updated = await putConfig(ts.url, {
      webdavUrl: 'https://dav.example.com/new',
      webdavIntervalMinutes: 7,
      webdavKeep: 99,
    });
    assert.equal(updated.status, 200);
    const body = (await updated.json()) as Record<string, unknown>;
    assert.equal(body.webdavUrl, 'https://dav.example.com/new');
    assert.equal(body.webdavIntervalMinutes, 7);
    assert.equal(body.webdavKeep, 99);
    assert.equal(body.webdavUsername, 'olduser', '未提交的字段应保持原值');
    assert.equal(body.webdavPasswordSet, true, '空口令提交不改动口令');
    assert.equal(JSON.stringify(body).includes('oldpass'), false);

    const after = await getConfig(ts.url);
    assert.equal(after.webdavUrl, 'https://dav.example.com/new', '不重启即读到新值');
    assert.equal(after.webdavIntervalMinutes, 7);
  } finally {
    getEngine()?.stop();
    await ts.close();
  }
});

test('口令留空不改动：改完地址后上传仍用原口令；改口令后上传用新口令', async () => {
  const fake = createCaptureWebDav();
  const { ts, getEngine } = await startWebdavConfigServer(fake);
  try {
    // 提交不带口令：应保持 env 里的 oldpass。
    await putConfig(ts.url, { webdavUrl: 'https://dav.example.com/new', webdavUsername: 'newuser', webdavPassword: '' });
    fake.requests.length = 0;
    const upload1 = await fetch(`${ts.url}/api/sync/upload`, { method: 'POST' });
    assert.equal(upload1.status, 200);
    const put1 = fake.requests.find((request) => request.method === 'PUT');
    assert.ok(put1 !== undefined, '应有 PUT 上传');
    assert.ok(put1.url.startsWith('https://dav.example.com/new/'), `上传应使用新地址，实际 ${put1.url}`);
    assert.equal(put1.authorization, `Basic ${Buffer.from('newuser:oldpass').toString('base64')}`, '留空应沿用旧口令');

    // 显式改口令：上传改用新口令。
    await putConfig(ts.url, { webdavPassword: 'brandnew' });
    fake.requests.length = 0;
    const upload2 = await fetch(`${ts.url}/api/sync/upload`, { method: 'POST' });
    assert.equal(upload2.status, 200);
    const put2 = fake.requests.find((request) => request.method === 'PUT');
    assert.ok(put2 !== undefined);
    assert.equal(put2.authorization, `Basic ${Buffer.from('newuser:brandnew').toString('base64')}`);
  } finally {
    getEngine()?.stop();
    await ts.close();
  }
});

test('非法值一律 400（中文）', async () => {
  const fake = createCaptureWebDav();
  const { ts, getEngine } = await startWebdavConfigServer(fake);
  const expect400 = async (patch: unknown, pattern: RegExp) => {
    const response = await putConfig(ts.url, patch);
    assert.equal(response.status, 400, JSON.stringify(patch));
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, 'invalid_config');
    assert.match(String(body.message), pattern);
  };
  try {
    await expect400({ webdavUrl: 'ftp://dav.example.com/x' }, /http/);
    await expect400({ webdavUrl: 'not a url' }, /格式/);
    await expect400({ webdavEnabled: 'yes' }, /布尔值/);
    await expect400({ webdavIntervalMinutes: 0 }, /1–1440/);
    await expect400({ webdavIntervalMinutes: 1441 }, /1–1440/);
    await expect400({ webdavIntervalMinutes: 10.5 }, /整数/);
    await expect400({ webdavKeep: 0 }, /1–1000/);
    await expect400({ webdavKeep: 1001 }, /1–1000/);
    await expect400({}, /没有需要更新/);
    await expect400([], /请求内容不正确/);
    // 停用后可以清空地址；此时再启用必须补地址。
    assert.equal((await putConfig(ts.url, { webdavEnabled: false })).status, 200);
    assert.equal((await putConfig(ts.url, { webdavUrl: '' })).status, 200);
    await expect400({ webdavEnabled: true }, /服务器地址/);
  } finally {
    getEngine()?.stop();
    await ts.close();
  }
});

test('审计：action=webdav_config_update，detail 只记字段名与是否改口令', async () => {
  const fake = createCaptureWebDav();
  const { ts, getEngine } = await startWebdavConfigServer(fake);
  try {
    const response = await putConfig(ts.url, {
      webdavUrl: 'https://dav.example.com/audited',
      webdavPassword: 'audit-secret-value',
      webdavKeep: 5,
    });
    assert.equal(response.status, 200);

    const rows = ts.db
      .prepare("SELECT action, detail FROM audit WHERE action = 'webdav_config_update' ORDER BY id")
      .all() as Array<{ action: string; detail: string }>;
    assert.equal(rows.length, 1, '应恰好写一条 webdav_config_update');
    const detail = rows[0]!.detail;
    assert.match(detail, /webdavUrl/);
    assert.match(detail, /webdavKeep/);
    assert.match(detail, /"passwordChanged":true/);
    assert.equal(detail.includes('audit-secret-value'), false, 'detail 绝不记口令明文');
    assert.equal(detail.includes('audited'), false, 'detail 不记完整地址');
  } finally {
    getEngine()?.stop();
    await ts.close();
  }
});

test('对外视图始终不含口令，但能反映是否已设置', () => {
  const db = openDatabaseAt(':memory:');
  const config = loadConfig(ENV_DAV);
  try {
    const withPassword = serverSettingsView(readServerSettings(db, config));
    assert.equal(withPassword.webdavPasswordSet, true);
    assert.equal('webdavPassword' in withPassword, false);

    applyWebdavConfigPatch(db, config, { webdavPassword: '__clear__' });
    const cleared = serverSettingsView(readServerSettings(db, config));
    assert.equal(cleared.webdavPasswordSet, false);
  } finally {
    db.close();
  }
});
