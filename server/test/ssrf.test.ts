/**
 * M11 §3.1 SSRF 防护规则测试。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRelayTarget, isBlockedIpv4, isBlockedIpv6, parseIpv4, relayAllowsPrivate } from '../src/ssrf.ts';

test('parseIpv4 / isBlockedIpv4：私网与链路本地判定', () => {
  assert.deepEqual(parseIpv4('192.168.1.10'), [192, 168, 1, 10]);
  assert.equal(parseIpv4('999.1.1.1'), null);
  assert.equal(parseIpv4('dav.example.com'), null);

  for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1']) {
    assert.equal(isBlockedIpv4(parseIpv4(ip)!), true, ip);
  }
  assert.equal(isBlockedIpv4(parseIpv4('8.8.8.8')!), false);
  assert.equal(isBlockedIpv4(parseIpv4('172.32.0.1')!), false);
});

test('isBlockedIpv6：回环 / ULA / 链路本地 / 映射地址', () => {
  assert.equal(isBlockedIpv6('::1'), true);
  assert.equal(isBlockedIpv6('::'), true);
  assert.equal(isBlockedIpv6('fe80::1'), true);
  assert.equal(isBlockedIpv6('fd00:ec2::254'), true);
  assert.equal(isBlockedIpv6('fc00::1'), true);
  assert.equal(isBlockedIpv6('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedIpv6('2001:4860:4860::8888'), false);
});

test('checkRelayTarget：默认拒绝私网 / 元数据，放行公网', () => {
  const blocked = [
    'http://127.0.0.1:8080/dav/',
    'http://localhost/dav/',
    'https://10.0.0.1/dav/',
    'https://172.16.0.1/dav/',
    'https://192.168.1.1/dav/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/dav/',
    'http://[fd00::1]/dav/',
    'http://metadata.google.internal/computeMetadata/v1/',
  ];
  for (const url of blocked) {
    assert.equal(checkRelayTarget(url, false).ok, false, url);
  }
  assert.equal(checkRelayTarget('https://dav.example.com/reminder/', false).ok, true);
  assert.equal(checkRelayTarget('http://[2001:4860:4860::8888]/', false).ok, true);
});

test('checkRelayTarget：仅 http/https；allowPrivate 显式放开', () => {
  assert.equal(checkRelayTarget('ftp://dav.example.com/', false).ok, false);
  assert.equal(checkRelayTarget('not a url', false).ok, false);
  assert.equal(checkRelayTarget('http://127.0.0.1/dav/', true).ok, true);
  assert.equal(checkRelayTarget('http://192.168.1.1/dav/', true).ok, true);
});

test('relayAllowsPrivate：只认显式真值', () => {
  assert.equal(relayAllowsPrivate({}), false);
  assert.equal(relayAllowsPrivate({ WEBDAV_RELAY_ALLOW_PRIVATE: '0' }), false);
  assert.equal(relayAllowsPrivate({ WEBDAV_RELAY_ALLOW_PRIVATE: '1' }), true);
  assert.equal(relayAllowsPrivate({ WEBDAV_RELAY_ALLOW_PRIVATE: 'true' }), true);
});
