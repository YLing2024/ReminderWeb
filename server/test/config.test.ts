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
