import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAuthHeader,
  deleteFile,
  downloadFile,
  fileNameFromHref,
  isBackupName,
  listBackups,
  mapFetchError,
  mapHttpError,
  normalizeBaseUrl,
  parsePropfind,
  uploadFile,
} from '../src/webdav.ts';
import type { WebDavConfig } from '../src/webdav.ts';

const CONFIG: WebDavConfig = {
  url: 'https://dav.example.com/reminder/',
  username: 'davuser',
  password: '密码',
  timeoutMs: 5000,
};

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeResponse(status: number, body: string | Uint8Array = '', headers: Record<string, string> = {}): Response {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
  } as unknown as Response;
}

function stubFetch(handler: (req: Captured) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const request: Captured = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    };
    calls.push(request);
    return handler(request);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function propfindXml(entries: Array<{ href: string; size?: number; modified?: string; etag?: string }>, prefix = 'd:'): string {
  const responses = entries
    .map((entry) => {
      const size = entry.size === undefined ? '' : `<${prefix}getcontentlength>${entry.size}</${prefix}getcontentlength>`;
      const modified = entry.modified === undefined ? '' : `<${prefix}getlastmodified>${entry.modified}</${prefix}getlastmodified>`;
      const etag = entry.etag === undefined ? '' : `<${prefix}getetag>${entry.etag}</${prefix}getetag>`;
      return `<${prefix}response><${prefix}href>${entry.href}</${prefix}href><${prefix}propstat><${prefix}prop>${size}${modified}${etag}</${prefix}prop></${prefix}propstat></${prefix}response>`;
    })
    .join('');
  const namespace = prefix === '' ? 'xmlns="DAV:"' : `xmlns:${prefix.slice(0, -1)}="DAV:"`;
  return `<?xml version="1.0" encoding="utf-8"?><${prefix}multistatus ${namespace}>${responses}</${prefix}multistatus>`;
}

test('normalizeBaseUrl：补协议/尾斜杠、剥离内嵌凭据、拒绝非 http(s)', () => {
  assert.equal(normalizeBaseUrl('dav.example.com/reminder'), 'https://dav.example.com/reminder/');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/dav'), 'http://127.0.0.1:8080/dav/');
  assert.equal(normalizeBaseUrl('https://user:pass@dav.example.com/dav/'), 'https://dav.example.com/dav/');
  assert.equal(normalizeBaseUrl('https://dav.example.com/dav/'), 'https://dav.example.com/dav/');
  assert.throws(() => normalizeBaseUrl('   '), /不能为空/);
  assert.throws(() => normalizeBaseUrl('ftp://dav.example.com/'), /http/);
});

test('buildAuthHeader：中文口令按 UTF-8 Base64 编码', () => {
  const expected = `Basic ${Buffer.from('用户:密码', 'utf8').toString('base64')}`;
  assert.equal(buildAuthHeader('用户', '密码'), expected);
  assert.match(buildAuthHeader('davuser', 'secret'), /^Basic /);
});

test('parsePropfind：空目录、过滤无关与非 zip、时间倒序、无命名空间前缀', () => {
  assert.deepEqual(parsePropfind(propfindXml([{ href: '/reminder/' }])), []);

  const xml = propfindXml([
    { href: '/reminder/' },
    { href: '/reminder/notes.txt' },
    { href: '/reminder/other-20260101.zip' },
    { href: '/reminder/reminder-backup-20260101-120000.tar' },
    { href: '/reminder/reminder-backup-20260101-120000.zip', size: 10, modified: 'Thu, 01 Jan 2026 12:00:00 GMT', etag: '"a"' },
    { href: '/reminder/reminder-backup-20260301-120000.zip', size: 30, modified: 'Sun, 01 Mar 2026 12:00:00 GMT' },
  ]);
  const files = parsePropfind(xml);
  assert.deepEqual(files.map((file) => file.name), [
    'reminder-backup-20260301-120000.zip',
    'reminder-backup-20260101-120000.zip',
  ]);
  assert.equal(files[1]?.size, 10);
  assert.equal(files[1]?.etag, '"a"');

  const noPrefix = parsePropfind(
    propfindXml(
      [{ href: 'https://dav.example.com/reminder/reminder-backup-20260101-120000.zip', size: 5, modified: 'Thu, 01 Jan 2026 12:00:00 GMT' }],
      '',
    ),
  );
  assert.equal(noPrefix.length, 1);
  assert.equal(noPrefix[0]?.name, 'reminder-backup-20260101-120000.zip');
});

test('文件名解析与备份名判定', () => {
  assert.equal(fileNameFromHref('/reminder/reminder-backup-20260101-120000.zip?x=1'), 'reminder-backup-20260101-120000.zip');
  assert.equal(isBackupName('reminder-backup-20260101-120000.zip'), true);
  assert.equal(isBackupName('reminder-backup-20260101-120000.ZIP'), true);
  assert.equal(isBackupName('other.zip'), false);
  assert.equal(isBackupName('reminder-backup-20260101-120000.tar'), false);
});

test('错误码 → 中文文案', () => {
  assert.equal(mapHttpError(401).code, 'AUTH');
  assert.equal(mapHttpError(403).code, 'AUTH');
  assert.equal(mapHttpError(401).message, '用户名或密码不正确，或该账号无权访问此目录');
  assert.equal(mapHttpError(404).code, 'NOT_FOUND');
  assert.equal(mapHttpError(405).code, 'NOT_WEBDAV');
  assert.equal(mapHttpError(500).code, 'HTTP');
  assert.equal(mapHttpError(500).message, '服务器返回 500');

  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(mapFetchError(abort).code, 'NETWORK');
  assert.match(mapFetchError(abort).message, /超时/);
  assert.equal(mapFetchError(new TypeError('Failed to fetch')).code, 'NETWORK');
});

test('listBackups：PROPFIND Depth:1 带 Basic 头并解析', async () => {
  const { fetchImpl, calls } = stubFetch(() =>
    fakeResponse(207, propfindXml([{ href: '/reminder/reminder-backup-20260101-120000.zip', size: 3, modified: 'Thu, 01 Jan 2026 12:00:00 GMT' }]), {
      'content-type': 'application/xml',
    }),
  );
  const files = await listBackups(CONFIG, { fetchImpl });
  assert.equal(files.length, 1);
  assert.equal(calls[0]?.method, 'PROPFIND');
  assert.equal(calls[0]?.headers.Depth, '1');
  assert.match(calls[0]?.headers.Authorization ?? '', /^Basic /);
  assert.equal(calls[0]?.headers.Authorization, buildAuthHeader('davuser', '密码'));
});

test('uploadFile：先 MKCOL（已存在 405 忽略）再 PUT，方法/头/体正确', async () => {
  const { fetchImpl, calls } = stubFetch((req) => {
    if (req.method === 'MKCOL') return fakeResponse(405);
    return fakeResponse(201);
  });
  await uploadFile(CONFIG, new Uint8Array([1, 2, 3]), 'reminder-backup-20260101-120000.zip', { fetchImpl });
  assert.deepEqual(calls.map((call) => call.method), ['MKCOL', 'PUT']);
  assert.equal(calls[1]?.headers['Content-Type'], 'application/zip');
  assert.deepEqual(Array.from(calls[1]?.body as Uint8Array), [1, 2, 3]);
  assert.equal(calls[1]?.url, 'https://dav.example.com/reminder/reminder-backup-20260101-120000.zip');
});

test('downloadFile / deleteFile：GET 返回字节，DELETE 方法正确', async () => {
  const { fetchImpl, calls } = stubFetch((req) => {
    if (req.method === 'GET') return fakeResponse(200, new Uint8Array([9, 8, 7]));
    return fakeResponse(204);
  });
  const bytes = await downloadFile(CONFIG, 'reminder-backup-20260101-120000.zip', { fetchImpl });
  assert.deepEqual(Array.from(bytes), [9, 8, 7]);
  await deleteFile(CONFIG, 'reminder-backup-20260101-120000.zip', { fetchImpl });
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'DELETE']);
});

test('listBackups：401/404/405 抛出对应中文错误', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [404, 'NOT_FOUND'], [405, 'NOT_WEBDAV']] as const) {
    const { fetchImpl } = stubFetch(() => fakeResponse(status));
    await assert.rejects(async () => {
      await listBackups(CONFIG, { fetchImpl });
    }, (error: unknown) => {
      return typeof error === 'object' && error !== null && (error as { code?: string }).code === code;
    });
  }
});

test('超时中止并映射为网络错误', async () => {
  const fetchImpl = ((_input: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as { addEventListener?: (event: string, listener: () => void) => void } | undefined;
      signal?.addEventListener?.('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as unknown as typeof fetch;
  await assert.rejects(async () => {
    await listBackups({ ...CONFIG, timeoutMs: 10 }, { fetchImpl });
  }, (error: unknown) => {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'NETWORK';
  });
});
