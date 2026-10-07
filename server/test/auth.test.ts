import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SESSION_COOKIE,
  buildClearCookie,
  buildSessionCookie,
  createRateLimiter,
  createSession,
  deleteSession,
  ensureInitialUser,
  getSessionUsername,
  hashPassword,
  parseCookies,
  readSsoUser,
  resolveIdentity,
  sha256Hex,
  verifyPassword,
} from '../src/auth.ts';
import { openDatabaseAt } from '../src/db.ts';

test('scrypt 往返：正确口令通过、错误口令失败', () => {
  const stored = hashPassword('口令-password-123');
  assert.equal(verifyPassword('口令-password-123', stored), true);
  assert.equal(verifyPassword('口令-password-124', stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('加盐：同一口令两次哈希得到不同的盐与摘要', () => {
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(verifyPassword('same', a), true);
  assert.equal(verifyPassword('same', b), true);
});

test('摘要被篡改时校验失败（timingSafeEqual 口径）', () => {
  const stored = hashPassword('x');
  const tampered = { salt: stored.salt, hash: '00'.repeat(32) };
  assert.equal(verifyPassword('x', tampered), false);
});

test('sha256Hex 与已知向量一致', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('会话：签发 / 校验 / 登出后失效', () => {
  const db = openDatabaseAt(':memory:');
  const { token } = createSession(db, 'admin', 60_000, 1_000);
  assert.equal(getSessionUsername(db, token, 2_000), 'admin');
  deleteSession(db, token);
  assert.equal(getSessionUsername(db, token, 2_000), null);
  db.close();
});

test('会话：过期即删并返回 null', () => {
  const db = openDatabaseAt(':memory:');
  const { token } = createSession(db, 'admin', 1_000, 1_000);
  assert.equal(getSessionUsername(db, token, 2_001), null);
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  assert.equal(remaining.n, 0);
  db.close();
});

test('会话令牌只存 SHA-256 摘要，不存明文', () => {
  const db = openDatabaseAt(':memory:');
  const { token } = createSession(db, 'admin', 60_000, 1_000);
  const row = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
  assert.equal(row.token_hash, sha256Hex(token));
  assert.notEqual(row.token_hash, token);
  db.close();
});

test('Cookie 属性符合 __Host- 约定', () => {
  const cookie = buildSessionCookie('tok', 2592000);
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=tok;`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=2592000/);
  assert.ok(!/Domain=/i.test(cookie));

  const cleared = buildClearCookie();
  assert.match(cleared, /Max-Age=0/);
});

test('parseCookies 解析常规与多值头', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('限流：达到阈值后阻断，窗口过期后恢复', () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 3, windowMs: 1_000, now: () => clock });
  assert.equal(limiter.isBlocked('ip'), false);
  limiter.recordFailure('ip');
  limiter.recordFailure('ip');
  limiter.recordFailure('ip');
  assert.equal(limiter.isBlocked('ip'), true);
  assert.equal(limiter.isBlocked('other'), false);
  clock = 2_000;
  assert.equal(limiter.isBlocked('ip'), false);
});

test('限流：成功后 reset 解除计数', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => 0 });
  limiter.recordFailure('ip');
  assert.equal(limiter.isBlocked('ip'), true);
  limiter.reset('ip');
  assert.equal(limiter.isBlocked('ip'), false);
});

test('readSsoUser 只接受合法头值', () => {
  assert.equal(readSsoUser({}), null);
  assert.equal(readSsoUser({ 'x-auth-user': '' }), null);
  assert.equal(readSsoUser({ 'x-auth-user': '   ' }), null);
  assert.equal(readSsoUser({ 'x-auth-user': 'bad\nname' }), null);
  assert.equal(readSsoUser({ 'x-auth-user': 'alice' }), 'alice');
  assert.equal(readSsoUser({ 'x-auth-user': ['bob', 'carol'] }), 'bob');
});

test('resolveIdentity 三种模式的判定', () => {
  const db = openDatabaseAt(':memory:');
  seedUserIfNeeded(db);
  assert.equal(resolveIdentity({}, { mode: 'none', db })?.username, 'dev');
  assert.equal(resolveIdentity({}, { mode: 'sso', db }), null);
  assert.equal(resolveIdentity({ 'x-auth-user': 'alice' }, { mode: 'sso', db })?.username, 'alice');
  assert.equal(resolveIdentity({}, { mode: 'builtin', db }), null);

  const { token } = createSession(db, 'admin', 60_000, 1_000);
  const identity = resolveIdentity({ cookie: `${SESSION_COOKIE}=${token}` }, { mode: 'builtin', db, now: () => 2_000 });
  assert.equal(identity?.username, 'admin');
  db.close();
});

test('ensureInitialUser：口令留空时生成一次性随机口令且只建一次', () => {
  const db = openDatabaseAt(':memory:');
  const first = ensureInitialUser(db, 'admin', '', 1_000);
  assert.equal(first.created, true);
  assert.ok(typeof first.generatedPassword === 'string' && first.generatedPassword.length > 0);
  const second = ensureInitialUser(db, 'admin', 'other', 2_000);
  assert.equal(second.created, false);
  assert.equal(second.generatedPassword, undefined);
  db.close();
});

function seedUserIfNeeded(db: ReturnType<typeof openDatabaseAt>): void {
  ensureInitialUser(db, 'admin', 'secret', 1_000);
}
