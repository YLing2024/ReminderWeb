/**
 * M11 §3.1 WebDAV 同源转发测试：动词 / 头 / 状态码透传、凭据不落库不落响应、
 * SSRF 拒绝、未登录 401。
 */
import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Server } from 'node:http';
import { test } from 'node:test';
import { seedUser, sessionCookieFrom, startTestServer } from './helpers.ts';

interface CapturedRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function startLocalDav(): Promise<{ url: string; close(): Promise<void>; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Uint8Array[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.setHeader('DAV', '1, 2');
      res.setHeader('ETag', '"abc"');
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.statusCode = 207;
      res.end('<d:multistatus/>');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/dav/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        requests,
      });
    });
  });
}

async function withAllowPrivate<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.WEBDAV_RELAY_ALLOW_PRIVATE;
  process.env.WEBDAV_RELAY_ALLOW_PRIVATE = '1';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.WEBDAV_RELAY_ALLOW_PRIVATE;
    else process.env.WEBDAV_RELAY_ALLOW_PRIVATE = previous;
  }
}

test('转发：PROPFIND 动词 / Depth / 请求体透传，响应状态码与 DAV/ETag/Content-Type 原样返回', async () => {
  await withAllowPrivate(async () => {
    const dav = await startLocalDav();
    const ts = await startTestServer({ env: { AUTH_MODE: 'none' } });
    try {
      const res = await fetch(`${ts.url}/api/webdav/dir`, {
        method: 'PROPFIND',
        headers: {
          'X-Dav-Url': dav.url,
          'X-Dav-User': 'davuser',
          'X-Dav-Password': 'topsecret',
          Depth: '1',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        body: '<d:propfind/>',
      });
      assert.equal(res.status, 207);
      assert.equal(res.headers.get('dav'), '1, 2');
      assert.equal(res.headers.get('etag'), '"abc"');
      assert.match(res.headers.get('content-type') ?? '', /application\/xml/);
      const text = await res.text();
      assert.match(text, /multistatus/);
      assert.equal(text.includes('topsecret'), false);

      const captured = dav.requests[0]!;
      assert.equal(captured.method, 'PROPFIND');
      assert.equal(captured.headers.depth, '1');
      assert.equal(captured.headers['content-type'], 'application/xml; charset=utf-8');
      assert.equal(captured.headers.authorization, `Basic ${Buffer.from('davuser:topsecret').toString('base64')}`);
      assert.equal(captured.body, '<d:propfind/>');
    } finally {
      await ts.close();
      await dav.close();
    }
  });
});

test('转发：PUT / HEAD / MKCOL / DELETE 动词透传；If-Match 透传', async () => {
  await withAllowPrivate(async () => {
    const dav = await startLocalDav();
    const ts = await startTestServer({ env: { AUTH_MODE: 'none' } });
    try {
      for (const method of ['PUT', 'HEAD', 'MKCOL', 'DELETE'] as const) {
        const res = await fetch(`${ts.url}/api/webdav/file.zip`, {
          method,
          headers: { 'X-Dav-Url': `${dav.url}file.zip`, 'X-Dav-User': 'u', 'X-Dav-Password': 'p', 'If-Match': '"v1"' },
          body: method === 'PUT' ? 'data' : undefined,
        });
        assert.equal(res.status, 207, method);
      }
      assert.deepEqual(dav.requests.map((r) => r.method), ['PUT', 'HEAD', 'MKCOL', 'DELETE']);
      assert.equal(dav.requests[0]!.body, 'data');
      assert.equal(dav.requests[0]!.headers['if-match'], '"v1"');
    } finally {
      await ts.close();
      await dav.close();
    }
  });
});

test('转发：不支持的动词 405；缺目标 400', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'none' } });
  try {
    const bad = await fetch(`${ts.url}/api/webdav/x`, {
      method: 'PATCH',
      headers: { 'X-Dav-Url': 'https://dav.example.com/dav/' },
      body: 'x',
    });
    assert.equal(bad.status, 405);

    const missing = await fetch(`${ts.url}/api/webdav/x`, { method: 'PROPFIND' });
    assert.equal(missing.status, 400);
  } finally {
    await ts.close();
  }
});

test('SSRF：默认拒绝回环 / 内网 / 元数据地址', async () => {
  const previous = process.env.WEBDAV_RELAY_ALLOW_PRIVATE;
  delete process.env.WEBDAV_RELAY_ALLOW_PRIVATE;
  const ts = await startTestServer({ env: { AUTH_MODE: 'none' } });
  try {
    for (const target of ['http://127.0.0.1:9/dav/', 'http://169.254.169.254/latest/', 'http://192.168.1.1/dav/']) {
      const res = await fetch(`${ts.url}/api/webdav/x`, {
        method: 'GET',
        headers: { 'X-Dav-Url': target },
      });
      assert.equal(res.status, 403, target);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.error, 'target_not_allowed');
    }
  } finally {
    await ts.close();
    if (previous !== undefined) process.env.WEBDAV_RELAY_ALLOW_PRIVATE = previous;
  }
});

test('凭据仅本次请求使用：不落库、不进响应、不写日志', async () => {
  await withAllowPrivate(async () => {
    const dav = await startLocalDav();
    const logs: string[] = [];
    const logger = {
      debug: (m: string) => logs.push(m),
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    };
    const ts = await startTestServer({ env: { AUTH_MODE: 'none' }, logger });
    try {
      const res = await fetch(`${ts.url}/api/webdav/x`, {
        method: 'PROPFIND',
        headers: { 'X-Dav-Url': dav.url, 'X-Dav-User': 'leakuser', 'X-Dav-Password': 'leak-secret-value' },
      });
      const text = await res.text();
      assert.equal(text.includes('leak-secret-value'), false);
      assert.equal(text.includes('leakuser'), false);
      assert.equal(logs.join('\n').includes('leak-secret-value'), false, '日志不得包含口令');
      // 审计表没有转发记录，meta / 各业务表也不含凭据。
      const audit = ts.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number };
      assert.equal(Number(audit.n), 0);
      for (const table of ['meta', 'reminders', 'tags', 'settings', 'images']) {
        const rows = ts.db.prepare(`SELECT * FROM ${table}`).all();
        assert.equal(JSON.stringify(rows).includes('leak-secret-value'), false, table);
      }
    } finally {
      await ts.close();
      await dav.close();
    }
  });
});

test('转发：未登录返回 401（builtin），登录后可用', async () => {
  await withAllowPrivate(async () => {
    const dav = await startLocalDav();
    const ts = await startTestServer({
      env: { AUTH_MODE: 'builtin' },
      setup: (db) => seedUser(db, 'admin', 'secret'),
    });
    try {
      const unauthorized = await fetch(`${ts.url}/api/webdav/x`, {
        method: 'PROPFIND',
        headers: { 'X-Dav-Url': dav.url },
      });
      assert.equal(unauthorized.status, 401);
      assert.equal(dav.requests.length, 0);

      const login = await fetch(`${ts.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'secret' }),
      });
      const cookie = sessionCookieFrom(login);
      const ok = await fetch(`${ts.url}/api/webdav/x`, {
        method: 'PROPFIND',
        headers: { 'X-Dav-Url': dav.url, cookie },
      });
      assert.equal(ok.status, 207);
      assert.equal(dav.requests.length, 1);
    } finally {
      await ts.close();
      await dav.close();
    }
  });
});
