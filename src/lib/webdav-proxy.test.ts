/**
 * M11 §3.2 客户端模式两种传输：直连 / 同源代理。
 */
import { describe, expect, it } from 'vitest';
import { listBackups, mapFetchError, testConnection, uploadBackup } from './webdav';

const CONFIG = { server: 'https://dav.example.com/dav/', username: 'davuser', password: '密码' };

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(status = 207, body = ''): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    return new Response(status === 204 || status === 207 ? body : body, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('直连传输', () => {
  it('直接请求目标地址并带 Basic 认证头', async () => {
    const { fetchImpl, calls } = stubFetch(207, '<d:multistatus xmlns:d="DAV:"/>');
    await testConnection(CONFIG, { fetchImpl, transport: 'direct' });
    expect(calls[0]!.url).toBe('https://dav.example.com/dav/');
    expect(calls[0]!.method).toBe('PROPFIND');
    expect(calls[0]!.headers.Authorization).toMatch(/^Basic /);
    expect(calls[0]!.headers['X-Dav-Url']).toBeUndefined();
  });
});

describe('同源代理传输', () => {
  it('请求 /api/webdav 并携带 X-Dav-* 头，不含 Authorization', async () => {
    const { fetchImpl, calls } = stubFetch(207, `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/reminder-backup-20260101-120000.zip</d:href><d:propstat><d:prop><d:getcontentlength>3</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>`);
    const files = await listBackups(CONFIG, { fetchImpl, transport: 'proxy', apiBase: '' });
    expect(files.map((file) => file.name)).toEqual(['reminder-backup-20260101-120000.zip']);
    const call = calls[0]!;
    expect(call.url).toBe('/api/webdav');
    expect(call.method).toBe('PROPFIND');
    expect(call.headers['X-Dav-Url']).toBe('https://dav.example.com/dav/');
    expect(call.headers['X-Dav-User']).toBe('davuser');
    expect(call.headers['X-Dav-Password']).toBe('密码');
    expect(call.headers.Depth).toBe('1');
    expect(call.headers.Authorization).toBeUndefined();
  });

  it('上传经代理：PUT 请求体与 Content-Type 原样透传', async () => {
    const { fetchImpl, calls } = stubFetch(201);
    await uploadBackup(CONFIG, new Uint8Array([1, 2, 3]), 'reminder-backup-20260101-120000.zip', {
      fetchImpl,
      transport: 'proxy',
    });
    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.url).toBe('/api/webdav');
    expect(put.headers['Content-Type']).toBe('application/zip');
    expect(put.headers['X-Dav-Url']).toBe('https://dav.example.com/dav/reminder-backup-20260101-120000.zip');
    expect(put.body).toBeInstanceOf(Blob);
  });
});

describe('人话报错', () => {
  it('直连跨域失败：提示跨域策略与两种解决办法', () => {
    const error = mapFetchError(new TypeError('Failed to fetch'), {
      url: 'https://dav.example.com/dav/',
      pageOrigin: 'https://app.example.com',
      transport: 'direct',
    });
    expect(error.code).toBe('CORS');
    expect(error.message).toContain('浏览器被跨域策略拦住了');
    expect(error.message).toContain('经服务器转发');
    expect(error.message).toContain('跨域白名单');
  });

  it('代理失败：提示同源代理不可用而非 TypeError', () => {
    const error = mapFetchError(new TypeError('Failed to fetch'), {
      url: 'https://dav.example.com/dav/',
      pageOrigin: 'https://app.example.com',
      transport: 'proxy',
    });
    expect(error.code).toBe('NETWORK');
    expect(error.message).toContain('同源代理');
    expect(error.message).not.toContain('Failed to fetch');
  });
});
