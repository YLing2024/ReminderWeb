import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../src/config.ts';
import type { Logger } from '../src/log.ts';
import { SyncEngine } from '../src/sync.ts';
import { seedUser, sessionCookieFrom, startTestServer } from './helpers.ts';

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

interface Stored {
  bytes: Uint8Array;
  lastModified: number;
  etag: string;
}

function createFakeWebDav(onRequest: (method: string) => void = () => {}) {
  const files = new Map<string, Stored>();
  const fetchImpl = (async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    onRequest(method);
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
    if (method === 'PROPFIND') {
      const body = [...files.entries()]
        .map(
          ([fileName, file]) =>
            `<d:response><d:href>/reminder/${encodeURIComponent(fileName)}</d:href><d:propstat><d:prop>` +
            `<d:getcontentlength>${file.bytes.length}</d:getcontentlength>` +
            `<d:getlastmodified>${new Date(file.lastModified).toUTCString()}</d:getlastmodified>` +
            `<d:getetag>${file.etag}</d:getetag>` +
            `</d:prop></d:propstat></d:response>`,
        )
        .join('');
      return ok(207, `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/reminder/</d:href></d:response>${body}</d:multistatus>`);
    }
    if (method === 'MKCOL') return ok(405);
    if (method === 'PUT') {
      files.set(name, { bytes: new Uint8Array(init?.body as Uint8Array), lastModified: 1_700_000_000_000, etag: '"e"' });
      return ok(201);
    }
    if (method === 'GET') {
      const file = files.get(name);
      return file === undefined ? ok(404) : ok(200, file.bytes);
    }
    if (method === 'DELETE') {
      files.delete(name);
      return ok(204);
    }
    return ok(400);
  }) as unknown as typeof fetch;
  return { fetchImpl, files };
}

const WEBDAV_ENV = {
  AUTH_MODE: 'none',
  SERVE_STATIC: '0',
  WEBDAV_ENABLED: '1',
  WEBDAV_URL: 'https://dav.example.com/reminder',
  WEBDAV_USERNAME: 'davuser',
  WEBDAV_PASSWORD: 'topsecret',
  WEBDAV_ENCRYPT: '0',
  WEBDAV_DEBOUNCE_SECONDS: '0',
};

test('sync 接口需认证；status 不回传凭据', async () => {
  const fake = createFakeWebDav();
  let engine: SyncEngine | null = null;
  const ts = await startTestServer({
    env: { ...WEBDAV_ENV, AUTH_MODE: 'builtin' },
    setup: (db) => seedUser(db, 'admin', 'secret'),
    syncFactory: (db: DatabaseSync, config: Config) => {
      engine = new SyncEngine(config, db, silentLogger, { fetchImpl: fake.fetchImpl });
      return engine;
    },
  });
  try {
    const unauthorized = await fetch(`${ts.url}/api/sync/status`);
    assert.equal(unauthorized.status, 401);

    const login = await fetch(`${ts.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    });
    const cookie = sessionCookieFrom(login);

    const status = await fetch(`${ts.url}/api/sync/status`, { headers: { cookie } });
    assert.equal(status.status, 200);
    const body = (await status.json()) as Record<string, unknown>;
    assert.equal(body.enabled, true);
    assert.equal(body.url, 'https://dav.example.com/reminder');
    assert.equal('username' in body, false);
    assert.equal('password' in body, false);
    assert.equal(JSON.stringify(body).includes('topsecret'), false);
    assert.deepEqual(body.remoteFiles, []);

    const now = await fetch(`${ts.url}/api/sync/now`, { method: 'POST', headers: { cookie } });
    assert.equal(now.status, 200);
    const after = (await now.json()) as Record<string, unknown>;
    assert.equal(after.lastResult, 'ok');
    assert.equal((after.remoteFiles as unknown[]).length, 1);
    assert.equal(JSON.stringify(after).includes('topsecret'), false);
  } finally {
    (engine as SyncEngine | null)?.stop();
    await ts.close();
  }
});

test('POST /api/sync/now 进行中重复调用返回 409', async () => {
  let releaseGate: (() => void) | null = null;
  let requestCount = 0;
  let firstRequestSeen: (() => void) | null = null;
  const firstRequest = new Promise<void>((resolve) => {
    firstRequestSeen = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const base = createFakeWebDav();
  const gatedFetch = (async (input: string, init?: RequestInit): Promise<Response> => {
    requestCount += 1;
    if (requestCount === 1) {
      firstRequestSeen?.();
      await gate;
    }
    return base.fetchImpl(input, init);
  }) as unknown as typeof fetch;

  let engine: SyncEngine | null = null;
  const ts = await startTestServer({
    env: WEBDAV_ENV,
    syncFactory: (db: DatabaseSync, config: Config) => {
      engine = new SyncEngine(config, db, silentLogger, { fetchImpl: gatedFetch, now: () => 1_700_000_000_000 });
      return engine;
    },
  });
  try {
    const first = fetch(`${ts.url}/api/sync/now`, { method: 'POST' });
    await firstRequest;
    const second = await fetch(`${ts.url}/api/sync/now`, { method: 'POST' });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: 'sync_in_progress' });

    (releaseGate as (() => void) | null)?.();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
  } finally {
    (engine as SyncEngine | null)?.stop();
    await ts.close();
  }
});

test('未启用 WebDAV：status enabled=false，now 返回 409', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'none', SERVE_STATIC: '0', WEBDAV_ENABLED: '0' } });
  try {
    const status = await fetch(`${ts.url}/api/sync/status`);
    assert.equal(status.status, 200);
    assert.equal(((await status.json()) as Record<string, unknown>).enabled, false);

    const now = await fetch(`${ts.url}/api/sync/now`, { method: 'POST' });
    assert.equal(now.status, 409);
    assert.deepEqual(await now.json(), { error: 'sync_disabled' });
  } finally {
    await ts.close();
  }
});
