import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, isLoopbackHost, loadConfig } from '../src/config.ts';

test('默认值：回环、18940、builtin、服务静态', () => {
  const config = loadConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 18940);
  assert.equal(config.authMode, 'builtin');
  assert.equal(config.authUser, 'admin');
  assert.equal(config.sessionTtlDays, 30);
  assert.equal(config.loginRateLimit, 5);
  assert.equal(config.serveStatic, true);
  assert.equal(config.trustProxy, true);
});

test('isLoopbackHost 识别回环地址', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.5.6.7'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('example.com'), false);
});

test('非法 AUTH_MODE 抛错', () => {
  assert.throws(() => loadConfig({ AUTH_MODE: 'cookie' }), ConfigError);
});

test('非法 PORT 抛错', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), ConfigError);
  assert.throws(() => loadConfig({ PORT: '70000' }), ConfigError);
});

test('sso 模式监听非回环地址拒绝启动', () => {
  assert.throws(() => loadConfig({ AUTH_MODE: 'sso', HOST: '0.0.0.0' }), /回环/);
});

test('sso 模式回环地址可启动', () => {
  const config = loadConfig({ AUTH_MODE: 'sso', HOST: '127.0.0.1' });
  assert.equal(config.authMode, 'sso');
});

test('none 模式 + production + 非回环 拒绝启动', () => {
  assert.throws(
    () => loadConfig({ AUTH_MODE: 'none', HOST: '0.0.0.0', NODE_ENV: 'production' }),
    /拒绝启动/,
  );
});

test('none 模式 + production + 回环 可启动', () => {
  const config = loadConfig({ AUTH_MODE: 'none', HOST: '127.0.0.1', NODE_ENV: 'production' });
  assert.equal(config.authMode, 'none');
});

test('none 模式 + 开发 + 非回环 可启动', () => {
  const config = loadConfig({ AUTH_MODE: 'none', HOST: '0.0.0.0', NODE_ENV: 'development' });
  assert.equal(config.authMode, 'none');
});

test('WebDAV 默认关闭，参数取默认值', () => {
  const config = loadConfig({});
  assert.equal(config.webdavEnabled, false);
  assert.equal(config.webdavUrl, '');
  assert.equal(config.webdavIntervalMinutes, 10);
  assert.equal(config.webdavDebounceSeconds, 60);
  assert.equal(config.webdavEncrypt, true);
  assert.equal(config.webdavKeep, 10);
  assert.equal(config.webdavTimeoutSeconds, 20);
});

test('WebDAV：启用但缺 URL 时拒绝启动', () => {
  assert.throws(() => loadConfig({ WEBDAV_ENABLED: '1' }), /WEBDAV_URL/);
  assert.throws(() => loadConfig({ WEBDAV_ENABLED: '1', WEBDAV_URL: '   ' }), /WEBDAV_URL/);
});

test('WebDAV：合法配置解析（含布尔与整数边界）', () => {
  const config = loadConfig({
    WEBDAV_ENABLED: '1',
    WEBDAV_URL: 'https://dav.example.com/reminder/',
    WEBDAV_USERNAME: 'davuser',
    WEBDAV_PASSWORD: 'secret',
    WEBDAV_INTERVAL_MINUTES: '1',
    WEBDAV_DEBOUNCE_SECONDS: '0',
    WEBDAV_ENCRYPT: '0',
    WEBDAV_KEEP: '3',
    WEBDAV_TIMEOUT_SECONDS: '5',
  });
  assert.equal(config.webdavEnabled, true);
  assert.equal(config.webdavUrl, 'https://dav.example.com/reminder/');
  assert.equal(config.webdavIntervalMinutes, 1);
  assert.equal(config.webdavDebounceSeconds, 0);
  assert.equal(config.webdavEncrypt, false);
  assert.equal(config.webdavKeep, 3);
  assert.equal(config.webdavTimeoutSeconds, 5);
});

test('WebDAV：非法参数抛错', () => {
  assert.throws(() => loadConfig({ WEBDAV_INTERVAL_MINUTES: '0' }), ConfigError);
  assert.throws(() => loadConfig({ WEBDAV_KEEP: '0' }), ConfigError);
  assert.throws(() => loadConfig({ WEBDAV_TIMEOUT_SECONDS: '9999' }), ConfigError);
  assert.throws(() => loadConfig({ WEBDAV_ENCRYPT: 'maybe' }), ConfigError);
});

test('WEBDAV_RELAY_ALLOW_PRIVATE：默认关，仅显式真值为首次默认开', () => {
  assert.equal(loadConfig({}).webdavRelayAllowPrivate, false);
  assert.equal(loadConfig({ WEBDAV_RELAY_ALLOW_PRIVATE: '0' }).webdavRelayAllowPrivate, false);
  assert.equal(loadConfig({ WEBDAV_RELAY_ALLOW_PRIVATE: '1' }).webdavRelayAllowPrivate, true);
  assert.equal(loadConfig({ WEBDAV_RELAY_ALLOW_PRIVATE: 'true' }).webdavRelayAllowPrivate, true);
});

test('CORS：默认为空、逗号白名单去重并规范化为 origin', () => {
  assert.deepEqual(loadConfig({}).allowedOrigins, []);
  const config = loadConfig({
    ALLOWED_ORIGINS: 'https://app.example.com/, http://127.0.0.1:5173, https://app.example.com',
  });
  assert.deepEqual(config.allowedOrigins, ['https://app.example.com', 'http://127.0.0.1:5173']);
});

test('CORS：拒绝 * 与非法来源', () => {
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: '*' }), /通配/);
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: 'not a url' }), ConfigError);
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: 'https://app.example.com/path' }), /来源/);
});

test('COOKIE_SAMESITE：默认 lax，仅接受 lax / none', () => {
  assert.equal(loadConfig({}).cookieSameSite, 'lax');
  assert.equal(loadConfig({ COOKIE_SAMESITE: 'none' }).cookieSameSite, 'none');
  assert.equal(loadConfig({ COOKIE_SAMESITE: 'Lax' }).cookieSameSite, 'lax');
  assert.throws(() => loadConfig({ COOKIE_SAMESITE: 'strict' }), ConfigError);
});
