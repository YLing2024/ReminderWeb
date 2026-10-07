/**
 * M10 §2 前后端分离部署测试：CORS 白名单命中/未命中、预检、COOKIE_SAMESITE=none 的 Set-Cookie。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedUser, startTestServer } from './helpers.ts';

const APP_ORIGIN = 'https://app.example.com';
const API_ENV = {
  AUTH_MODE: 'none',
  SERVE_STATIC: '0',
  ALLOWED_ORIGINS: `${APP_ORIGIN}, http://127.0.0.1:5173`,
};

test('CORS：白名单来源回精确 Origin + Allow-Credentials + Vary: Origin', async () => {
  const ts = await startTestServer({ env: API_ENV });
  try {
    const res = await fetch(`${ts.url}/api/health`, { headers: { origin: APP_ORIGIN } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), APP_ORIGIN);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.match(res.headers.get('vary') ?? '', /Origin/);
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  } finally {
    await ts.close();
  }
});

test('CORS：非白名单来源不回任何 CORS 头', async () => {
  const ts = await startTestServer({ env: API_ENV });
  try {
    const res = await fetch(`${ts.url}/api/health`, { headers: { origin: 'https://evil.example.com' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  } finally {
    await ts.close();
  }
});

test('CORS：未配置 ALLOWED_ORIGINS 时完全关闭', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'none', SERVE_STATIC: '0' } });
  try {
    const res = await fetch(`${ts.url}/api/health`, { headers: { origin: APP_ORIGIN } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  } finally {
    await ts.close();
  }
});

test('CORS 预检：命中白名单回 204 + 允许的方法与头；未命中不回 CORS 头', async () => {
  const ts = await startTestServer({ env: API_ENV });
  try {
    const ok = await fetch(`${ts.url}/api/data`, {
      method: 'OPTIONS',
      headers: {
        origin: APP_ORIGIN,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), APP_ORIGIN);
    assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
    assert.match(ok.headers.get('access-control-allow-methods') ?? '', /PUT/);
    assert.match(ok.headers.get('access-control-allow-methods') ?? '', /DELETE/);
    assert.match(ok.headers.get('access-control-allow-headers') ?? '', /Content-Type/i);

    const blocked = await fetch(`${ts.url}/api/data`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'PUT' },
    });
    assert.equal(blocked.status, 204);
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
    assert.equal(blocked.headers.get('access-control-allow-methods'), null);
  } finally {
    await ts.close();
  }
});

test('COOKIE_SAMESITE=lax（默认）：登录 Set-Cookie 为 SameSite=Lax 且带 Secure', async () => {
  const ts = await startTestServer({
    env: { AUTH_MODE: 'builtin', SERVE_STATIC: '0' },
    setup: (db) => seedUser(db, 'admin', 'secret'),
  });
  try {
    const login = await fetch(`${ts.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    });
    const setCookie = login.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /__Host-rw_session=/);
  } finally {
    await ts.close();
  }
});

test('COOKIE_SAMESITE=none：登录与登出的 Set-Cookie 为 SameSite=None; Secure', async () => {
  const ts = await startTestServer({
    env: { AUTH_MODE: 'builtin', SERVE_STATIC: '0', COOKIE_SAMESITE: 'none' },
    setup: (db) => seedUser(db, 'admin', 'secret'),
  });
  try {
    const login = await fetch(`${ts.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    });
    const setCookie = login.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /SameSite=None/);
    assert.match(setCookie, /Secure/);
    const cookie = setCookie.split(';')[0] ?? '';

    const logout = await fetch(`${ts.url}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    const clearCookie = logout.headers.get('set-cookie') ?? '';
    assert.match(clearCookie, /SameSite=None/);
    assert.match(clearCookie, /Max-Age=0/);
  } finally {
    await ts.close();
  }
});
