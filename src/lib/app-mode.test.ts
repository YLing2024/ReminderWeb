/**
 * M10 §1 运行模式判定测试：优先级（config.json > VITE_APP_MODE > 探测）
 * 与「客户端模式不发起任何请求」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectAppMode, loadConfigMode, parseConfigMode, parseEnvMode, resolveAppMode } from './app-mode';
import type { HealthInfo } from './api';

const HEALTH: HealthInfo = { ok: true, revision: 3, authMode: 'builtin' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('resolveAppMode：优先级 config.json > VITE_APP_MODE > 探测', () => {
  it('config.json 高于 VITE_APP_MODE 与探测', () => {
    expect(resolveAppMode({ fileMode: 'server', envMode: 'client', health: null })).toBe('server');
    expect(resolveAppMode({ fileMode: 'client', envMode: 'server', health: HEALTH })).toBe('client');
  });

  it('无 config 时 VITE_APP_MODE 高于探测', () => {
    expect(resolveAppMode({ fileMode: null, envMode: 'client', health: HEALTH })).toBe('client');
    expect(resolveAppMode({ fileMode: null, envMode: 'server', health: null })).toBe('server');
  });

  it('auto：探测通则服务器模式，不通则客户端模式', () => {
    expect(resolveAppMode({ fileMode: null, envMode: 'auto', health: HEALTH })).toBe('server');
    expect(resolveAppMode({ fileMode: null, envMode: 'auto', health: null })).toBe('client');
  });
});

describe('解析函数', () => {
  it('parseEnvMode：仅 server/client，其余回落 auto', () => {
    expect(parseEnvMode('server')).toBe('server');
    expect(parseEnvMode('client')).toBe('client');
    expect(parseEnvMode('auto')).toBe('auto');
    expect(parseEnvMode(undefined)).toBe('auto');
    expect(parseEnvMode('nope')).toBe('auto');
  });

  it('parseConfigMode：合法值返回，非法/缺失返回 null', () => {
    expect(parseConfigMode({ mode: 'server' })).toBe('server');
    expect(parseConfigMode({ mode: 'client' })).toBe('client');
    expect(parseConfigMode({ mode: 'auto' })).toBeNull();
    expect(parseConfigMode({})).toBeNull();
    expect(parseConfigMode(null)).toBeNull();
    expect(parseConfigMode('server')).toBeNull();
  });
});

describe('loadConfigMode', () => {
  it('读到合法 config.json 返回模式', async () => {
    const mode = await loadConfigMode({
      configUrl: 'https://static.example.com/config.json',
      fetchImpl: (async () => jsonResponse({ mode: 'client' })) as unknown as typeof fetch,
    });
    expect(mode).toBe('client');
  });

  it('404 / 坏 JSON / 网络错误一律返回 null', async () => {
    const notFound = await loadConfigMode({
      fetchImpl: (async () => jsonResponse({ error: 'x' }, 404)) as unknown as typeof fetch,
    });
    expect(notFound).toBeNull();
    const broken = await loadConfigMode({
      fetchImpl: (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch,
    });
    expect(broken).toBeNull();
    const network = await loadConfigMode({
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    });
    expect(network).toBeNull();
  });
});

describe('detectAppMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('config.json 指定 server 时直接用，不再探测', async () => {
    const probe = vi.fn(async () => HEALTH);
    const detection = await detectAppMode({
      envMode: 'auto',
      configUrl: 'https://static.example.com/config.json',
      fetchImpl: (async () => jsonResponse({ mode: 'server' })) as unknown as typeof fetch,
      probe,
    });
    expect(detection).toEqual({ mode: 'server', source: 'config', health: null });
    expect(probe).not.toHaveBeenCalled();
  });

  it('auto + 无 config：探测通=server，不通=client', async () => {
    const ok = await detectAppMode({
      envMode: 'auto',
      configUrl: '/config.json',
      fetchImpl: (async () => jsonResponse({}, 404)) as unknown as typeof fetch,
      probe: async () => HEALTH,
    });
    expect(ok.mode).toBe('server');
    expect(ok.source).toBe('probe');

    const fail = await detectAppMode({
      envMode: 'auto',
      configUrl: '/config.json',
      fetchImpl: (async () => jsonResponse({}, 404)) as unknown as typeof fetch,
      probe: async () => null,
    });
    expect(fail.mode).toBe('client');
  });

  it('显式 client：不读 config.json、不探测、不调用 fetch', async () => {
    vi.stubEnv('VITE_APP_MODE', 'client');
    const fetchImpl = vi.fn();
    const probe = vi.fn(async () => HEALTH);
    const detection = await detectAppMode({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      probe,
    });
    expect(detection.mode).toBe('client');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
});
