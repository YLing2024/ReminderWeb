/**
 * 云备份集成测试（需求 M4 §9）：内存 WebDAV 服务端 + mock fetch，
 * 跑「上传 → 列出 → 下载 → 恢复」全流程，并断言上传字节与本地导出逐字节相同。
 *
 * 通过 mock `./storage` 把 IndexedDB 依赖摘掉，其余全部走真实代码路径。
 */
import { describe, expect, it, vi } from 'vitest';
import { decodeArchive } from './backup';
import { exportBackup } from './backup-service';
import { listCloudBackups, restoreCloudBackup, uploadCurrentBackup } from './cloud-backup';
import { DEFAULT_SETTINGS } from './storage';
import { makeItem } from '../test/factories';

vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>();
  return {
    ...actual,
    listImageNames: async () => [],
    loadImageBlob: async () => undefined,
    deleteImageBlob: async () => {},
    listFontNames: async () => [],
    loadFontBlob: async () => undefined,
    replaceImageBlobs: async () => {},
    replaceFontBlobs: async () => {},
  };
});

interface StoredFile {
  bytes: Uint8Array;
  lastModified: number;
}

function createMemoryWebDavServer() {
  const files = new Map<string, StoredFile>();
  const deletes: string[] = [];
  let lastAuth = '';

  const propfindBody = (): string => {
    const entries = [...files.entries()]
      .map(
        ([name, file]) =>
          '<d:response>' +
          `<d:href>/dav/${encodeURIComponent(name)}</d:href>` +
          '<d:propstat><d:prop>' +
          `<d:getcontentlength>${file.bytes.length}</d:getcontentlength>` +
          `<d:getlastmodified>${new Date(file.lastModified).toUTCString()}</d:getlastmodified>` +
          '</d:prop></d:propstat></d:response>',
      )
      .join('');
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:multistatus xmlns:d="DAV:">' +
      '<d:response><d:href>/dav/</d:href></d:response>' +
      `${entries}</d:multistatus>`
    );
  };

  async function readBody(body: BodyInit | null | undefined): Promise<Uint8Array> {
    if (body === null || body === undefined) return new Uint8Array(0);
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return new Uint8Array(0);
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = init?.headers;
    const authorization =
      headers instanceof Headers ? headers.get('Authorization') : (headers as Record<string, string> | undefined)?.Authorization;
    if (typeof authorization === 'string') lastAuth = authorization;

    const name = decodeURIComponent(url.pathname.replace(/^\/dav\//, ''));

    if (method === 'MKCOL') {
      // 目录已存在，按 RFC 返回 405（客户端应忽略）。
      return new Response(null, { status: 405 });
    }
    if (method === 'PROPFIND') {
      return new Response(propfindBody(), {
        status: 207,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      });
    }
    if (method === 'PUT') {
      files.set(name, { bytes: await readBody(init?.body), lastModified: Date.now() });
      return new Response(null, { status: 201 });
    }
    if (method === 'GET') {
      const file = files.get(name);
      if (file === undefined) return new Response(null, { status: 404 });
      return new Response(file.bytes as unknown as BodyInit, { status: 200 });
    }
    if (method === 'DELETE') {
      deletes.push(name);
      files.delete(name);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 400 });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    files,
    deletes,
    get lastAuth() {
      return lastAuth;
    },
  };
}

const BASE_SETTINGS = {
  ...DEFAULT_SETTINGS,
  webdavEnabled: true,
  webdavServer: 'https://dav.example.com/dav',
  webdavUsername: 'davuser',
  webdavPassword: 'secret',
  webdavKeepCount: 10,
  backupEncryptionEnabled: false,
};

describe('WebDAV 云备份集成（内存服务端）', () => {
  it('上传 → 列出 → 下载 → 恢复，上传字节与本地导出逐字节相同', async () => {
    const server = createMemoryWebDavServer();
    const reminders = [makeItem({ id: 1, title: '甲', date: '2026-01-01' })];
    const tags = [{ id: 1, name: '节日', color: '#2196F3', sortOrder: 1 }];
    const fixedNow = new Date(2026, 9, 7, 16, 15, 3);

    // 参照：与「导出为文件」完全相同的本地产物。
    const local = await exportBackup(reminders, tags, BASE_SETTINGS, false, fixedNow);
    const localBytes = new Uint8Array(await local.blob.arrayBuffer());

    const outcome = await uploadCurrentBackup(
      { reminders, tags, settings: BASE_SETTINGS },
      { fetchImpl: server.fetchImpl, now: () => fixedNow },
    );
    expect(outcome.fileName).toBe('reminder-backup-20261007-161503.zip');
    expect(outcome.bytes).toEqual(localBytes);
    // 服务端实际收到的字节与本地导出逐字节相同。
    expect(server.files.get(outcome.fileName)!.bytes).toEqual(localBytes);
    expect(server.lastAuth.startsWith('Basic ')).toBe(true);

    const listed = await listCloudBackups(BASE_SETTINGS, { fetchImpl: server.fetchImpl });
    expect(listed.map((file) => file.name)).toContain(outcome.fileName);

    const restored = await restoreCloudBackup(BASE_SETTINGS, outcome.fileName, {
      fetchImpl: server.fetchImpl,
    });
    expect(restored.reminders).toEqual(reminders);
    expect(restored.tags).toEqual(tags);
  });

  it('保留份数：上传两份且保留 1 时，自动删除最旧一份', async () => {
    const server = createMemoryWebDavServer();
    const reminders = [makeItem({ id: 1, title: '乙', date: '2026-02-02' })];
    const settings = { ...BASE_SETTINGS, webdavKeepCount: 1 };

    await uploadCurrentBackup(
      { reminders, tags: [], settings },
      { fetchImpl: server.fetchImpl, now: () => new Date(2026, 9, 7, 16, 15, 3) },
    );
    const second = await uploadCurrentBackup(
      { reminders, tags: [], settings },
      { fetchImpl: server.fetchImpl, now: () => new Date(2026, 9, 7, 16, 20, 3) },
    );

    expect(second.pruned).toBe(1);
    expect([...server.files.keys()]).toEqual([second.fileName]);
    expect(server.deletes).toContain('reminder-backup-20261007-161503.zip');
  });

  it('导出的备份包不含 WebDAV 凭据', async () => {
    const settings = { ...BASE_SETTINGS, webdavServer: 'https://dav.example.com/dav/', webdavPassword: 'topsecret' };
    const result = await exportBackup([], [], settings, false, new Date(2026, 0, 1));
    const content = await decodeArchive(new Uint8Array(await result.blob.arrayBuffer()));
    const metadata = JSON.parse(content.metadataJson) as Record<string, unknown>;
    expect(metadata['webDavPassword']).toBeNull();
    expect(metadata['webDavServer']).toBeNull();
    expect(JSON.stringify(metadata)).not.toContain('topsecret');
  });
});
