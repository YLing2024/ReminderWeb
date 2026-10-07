import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_DIST, seedUser, sessionCookieFrom, startTestServer } from './helpers.ts';

test('health 免认证且不含敏感信息', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'builtin' }, setup: (db) => seedUser(db) });
  try {
    const res = await fetch(`${ts.url}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, { ok: true, revision: 0, authMode: 'builtin' });
  } finally {
    await ts.close();
  }
});

test('未认证访问受保护路由返回 401', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'builtin' }, setup: (db) => seedUser(db) });
  try {
    for (const url of ['/api/data', '/api/auth/me', '/api/version']) {
      const res = await fetch(`${ts.url}${url}`);
      assert.equal(res.status, 401, url);
    }
  } finally {
    await ts.close();
  }
});

test('builtin：登录 → me → PUT → GET → 登出 全流程', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'builtin' }, setup: (db) => seedUser(db, 'admin', 'secret') });
  try {
    const bad = await fetch(`${ts.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'nope' }),
    });
    assert.equal(bad.status, 401);
    assert.deepEqual(await bad.json(), { error: 'invalid_credentials' });

    const login = await fetch(`${ts.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    });
    assert.equal(login.status, 200);
    const cookie = sessionCookieFrom(login);
    assert.ok(cookie.startsWith('__Host-rw_session='));
    const setCookie = login.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);

    const me = await fetch(`${ts.url}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { username: 'admin', authMode: 'builtin' });

    const put = await fetch(`${ts.url}/api/data`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        baseRevision: 0,
        reminders: [{ id: 1, updatedAt: 1000, title: '会议', date: '2026-01-01', type: 'ANNUAL' }],
        tags: [{ id: 1, updatedAt: 1000, name: '工作', color: '#2196F3', sortOrder: 1 }],
        settings: { value: { themeOption: 'DARK' }, updatedAt: 1000 },
        tombstones: [],
      }),
    });
    assert.equal(put.status, 200);
    const putBody = (await put.json()) as Record<string, unknown>;
    assert.equal(putBody.revision, 1);
    assert.equal(putBody.serverRevisionBefore, 0);
    assert.equal(putBody.rejected, 0);

    const get = await fetch(`${ts.url}/api/data`, { headers: { cookie } });
    assert.equal(get.status, 200);
    const getBody = (await get.json()) as Record<string, unknown>;
    assert.equal(getBody.revision, 1);
    const reminders = getBody.reminders as Array<Record<string, unknown>>;
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0]?.updatedAt, 1000);
    assert.equal(reminders[0]?.title, '会议');
    assert.deepEqual(getBody.settings, { value: { themeOption: 'DARK' }, updatedAt: 1000 });

    const logout = await fetch(`${ts.url}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/);

    const after = await fetch(`${ts.url}/api/auth/me`, { headers: { cookie } });
    assert.equal(after.status, 401);
  } finally {
    await ts.close();
  }
});

test('PUT：坏 JSON 返回 400，超大体积返回 413', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'none' } });
  try {
    const badJson = await fetch(`${ts.url}/api/data`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: 'invalid_json' });

    const huge = `{"data":"${'x'.repeat(2 * 1024 * 1024 + 100)}"}`;
    const tooLarge = await fetch(`${ts.url}/api/data`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { error: 'payload_too_large' });
  } finally {
    await ts.close();
  }
});

test('PUT：无效条目被丢弃并计入 rejected，revision 只在有改动时自增', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'none' } });
  try {
    const put = await fetch(`${ts.url}/api/data`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reminders: [{ id: 1, updatedAt: 10, title: 'ok' }, { id: 'bad', updatedAt: 10 }],
      }),
    });
    const body = (await put.json()) as Record<string, unknown>;
    assert.equal(body.rejected, 1);
    assert.equal(body.revision, 1);

    // 相同内容再次 PUT：幂等，revision 不变。
    const again = await fetch(`${ts.url}/api/data`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reminders: [{ id: 1, updatedAt: 10, title: 'ok' }] }),
    });
    const againBody = (await again.json()) as Record<string, unknown>;
    assert.equal(againBody.revision, 1);
  } finally {
    await ts.close();
  }
});

test('sso：缺 X-Auth-User 返回 401，带头返回 200', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'sso', HOST: '127.0.0.1' } });
  try {
    const missing = await fetch(`${ts.url}/api/data`);
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: 'unauthorized' });

    const ok = await fetch(`${ts.url}/api/data`, { headers: { 'x-auth-user': 'alice' } });
    assert.equal(ok.status, 200);

    const me = await fetch(`${ts.url}/api/auth/me`, { headers: { 'x-auth-user': 'alice' } });
    assert.deepEqual(await me.json(), { username: 'alice', authMode: 'sso' });
  } finally {
    await ts.close();
  }
});

test('登录失败达到阈值后返回 429', async () => {
  const ts = await startTestServer({
    env: { AUTH_MODE: 'builtin', LOGIN_RATE_LIMIT: '2' },
    setup: (db) => seedUser(db, 'admin', 'secret'),
  });
  try {
    const attempt = () =>
      fetch(`${ts.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
      });
    assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 401);
    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { error: 'too_many_requests' });
  } finally {
    await ts.close();
  }
});

test('登录体缺字段返回 400', async () => {
  const ts = await startTestServer({
    env: { AUTH_MODE: 'builtin' },
    setup: (db) => seedUser(db, 'admin', 'secret'),
  });
  try {
    for (const body of [{}, { username: 'admin' }, { username: 'admin', password: '' }]) {
      const res = await fetch(`${ts.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
    }
  } finally {
    await ts.close();
  }
});

test('静态服务：index、深链回退、资源类型、禁止点文件与源文件泄露', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'none', SERVE_STATIC: '1' }, staticDir: FIXTURE_DIST });
  try {
    const root = await fetch(`${ts.url}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await root.text(), /FIXTURE_INDEX_HTML/);

    const deep = await fetch(`${ts.url}/reminder/42/edit`);
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /FIXTURE_INDEX_HTML/);

    const asset = await fetch(`${ts.url}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type') ?? '', /javascript/);
    assert.match(await asset.text(), /FIXTURE_APP_JS/);

    // 带扩展名的静态资源缺失时必须 404，不能回退 index.html（否则部署缺文件被静默掩盖）。
    const missingAsset = await fetch(`${ts.url}/assets/does-not-exist.js`);
    assert.equal(missingAsset.status, 404);
    assert.deepEqual(await missingAsset.json(), { error: 'not_found' });

    const missingPng = await fetch(`${ts.url}/assets/missing.png`);
    assert.equal(missingPng.status, 404);

    const dotfile = await fetch(`${ts.url}/.secret`);
    assert.equal(dotfile.status, 404);
    assert.ok(!(await dotfile.text()).includes('top-secret-fixture'));

    const traversal = await fetch(`${ts.url}/..%2f..%2f.env`);
    assert.equal(traversal.status, 404);

    const source = await fetch(`${ts.url}/server/src/index.ts`);
    assert.ok(!(await source.text()).includes('createAppServer'));
  } finally {
    await ts.close();
  }
});

test('SERVE_STATIC=0 时非 API 路径返回 404', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'none', SERVE_STATIC: '0' } });
  try {
    const res = await fetch(`${ts.url}/`);
    assert.equal(res.status, 404);
  } finally {
    await ts.close();
  }
});
