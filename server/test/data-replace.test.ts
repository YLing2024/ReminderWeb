/**
 * M11 §2 整库替换接口与图片字节读写测试。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabaseAt } from '../src/db.ts';
import { replaceServerData, readRevision, readServerData } from '../src/data.ts';
import { isValidImageName, readImages, upsertImage } from '../src/images.ts';
import { parseReplaceData } from '../src/serialize.ts';
import { seedUser, sessionCookieFrom, startTestServer } from './helpers.ts';

function reminder(id: number, title: string) {
  return { id, updatedAt: 1000, title, date: '2026-01-01', type: 'ANNUAL' };
}

test('parseReplaceData：解析条目 / 设置 / base64 图片，非法项计入 rejected', () => {
  const parsed = parseReplaceData({
    reminders: [reminder(1, '甲')],
    tags: [{ id: 2, updatedAt: 1000, name: '工作', color: '#2196F3', sortOrder: 1 }],
    settings: { value: { themeOption: 'DARK' }, updatedAt: 1000 },
    images: [
      { name: 'a.jpg', data: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64') },
      { name: '../evil.jpg', data: 'AQID' },
      { name: 'b.jpg', data: 123 },
    ],
  });
  assert.equal(parsed.reminders.length, 1);
  assert.equal(parsed.tags.length, 1);
  assert.deepEqual(parsed.settings, { value: { themeOption: 'DARK' }, updatedAt: 1000 });
  assert.deepEqual(parsed.images.map((image) => image.name), ['a.jpg']);
  assert.deepEqual(Array.from(parsed.images[0]!.bytes), [1, 2, 3]);
  assert.equal(parsed.rejected, 2);
});

test('isValidImageName：拒绝路径分隔符 / 控制字符 / 空名', () => {
  assert.equal(isValidImageName('card-bg-20260101-120000-abcd.jpg'), true);
  assert.equal(isValidImageName(''), false);
  assert.equal(isValidImageName('..'), false);
  assert.equal(isValidImageName('a/b.jpg'), false);
  assert.equal(isValidImageName('a\\b.jpg'), false);
  assert.equal(isValidImageName(`a\nb.jpg`), false);
});

test('replaceServerData：整库覆盖并 revision 自增；重复替换不产生重复', () => {
  const db = openDatabaseAt(':memory:');
  const first = replaceServerData(
    db,
    {
      reminders: [reminder(1, '甲'), reminder(2, '乙')],
      tags: [{ id: 1, updatedAt: 1000, name: '工作', color: '#2196F3', sortOrder: 1 }],
      settings: { value: { themeOption: 'DARK' }, updatedAt: 1000 },
      images: [{ name: 'a.jpg', bytes: new Uint8Array([9, 9]) }],
    },
    1000,
  );
  assert.equal(first, 1);

  // 覆盖式：旧数据被清空，只留新集合。
  replaceServerData(
    db,
    {
      reminders: [reminder(3, '丙')],
      tags: [],
      settings: { value: {}, updatedAt: 2000 },
      images: [],
    },
    2000,
  );
  const server = readServerData(db);
  assert.deepEqual(server.reminders.map((item) => item.id), [3]);
  assert.equal(server.tags.length, 0);
  assert.equal(readImages(db).length, 0);
  assert.equal(readRevision(db), 2);

  // 重复同一替换：条数不翻倍。
  replaceServerData(
    db,
    {
      reminders: [reminder(3, '丙')],
      tags: [],
      settings: { value: {}, updatedAt: 2000 },
      images: [],
    },
    2000,
  );
  assert.equal(readServerData(db).reminders.length, 1);
  db.close();
});

test('replaceServerData：事务失败回滚，原数据保持不变', () => {
  const db = openDatabaseAt(':memory:');
  replaceServerData(
    db,
    {
      reminders: [reminder(1, '原始')],
      tags: [],
      settings: { value: { themeOption: 'LIGHT' }, updatedAt: 1000 },
      images: [],
    },
    1000,
  );
  // 重复 id 触发 PRIMARY KEY 约束，插入中途失败 → 必须整体回滚。
  assert.throws(() =>
    replaceServerData(
      db,
      {
        reminders: [reminder(1, 'a'), reminder(1, 'b')],
        tags: [],
        settings: { value: { themeOption: 'DARK' }, updatedAt: 2000 },
        images: [],
      },
      2000,
    ),
  );
  const server = readServerData(db);
  assert.equal(server.reminders.length, 1);
  assert.equal(server.reminders[0]?.title, '原始');
  assert.deepEqual(server.settings.value, { themeOption: 'LIGHT' });
  assert.equal(readRevision(db), 1);
  db.close();
});

test('PUT /api/data/replace：需认证；整库覆盖并带图片', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'builtin' }, setup: (db) => seedUser(db, 'admin', 'secret') });
  try {
    const unauthorized = await fetch(`${ts.url}/api/data/replace`, { method: 'PUT', body: '{}' });
    assert.equal(unauthorized.status, 401);

    const login = await fetch(`${ts.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret' }),
    });
    const cookie = sessionCookieFrom(login);

    const replace = await fetch(`${ts.url}/api/data/replace`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        reminders: [reminder(1, '迁移')],
        tags: [{ id: 1, updatedAt: 1000, name: '工作', color: '#2196F3', sortOrder: 1 }],
        settings: { value: { themeOption: 'DARK' }, updatedAt: 1000 },
        images: [{ name: 'bg.jpg', data: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64') }],
      }),
    });
    assert.equal(replace.status, 200);
    const body = (await replace.json()) as Record<string, unknown>;
    assert.deepEqual(body.counts, { reminders: 1, tags: 1, images: 1 });

    const full = await fetch(`${ts.url}/api/data/full`, { headers: { cookie } });
    const fullBody = (await full.json()) as Record<string, unknown>;
    assert.deepEqual(fullBody.imageNames, ['bg.jpg']);
    const images = fullBody.images as Array<{ name: string; data: string }>;
    assert.equal(images.length, 1);
    assert.deepEqual(Array.from(Buffer.from(images[0]!.data, 'base64')), [1, 2, 3, 4]);

    const raw = await fetch(`${ts.url}/api/images/bg.jpg`, { headers: { cookie } });
    assert.equal(raw.status, 200);
    assert.deepEqual(Array.from(new Uint8Array(await raw.arrayBuffer())), [1, 2, 3, 4]);
  } finally {
    await ts.close();
  }
});

test('图片上传接口：非法名 400、空内容 400、同名覆盖、删除', async () => {
  const ts = await startTestServer({ env: { AUTH_MODE: 'none' } });
  try {
    const bad = await fetch(`${ts.url}/api/images/..%2Fevil.jpg`, { method: 'PUT', body: new Uint8Array([1]) });
    assert.equal(bad.status, 400);

    const empty = await fetch(`${ts.url}/api/images/ok.jpg`, { method: 'PUT', body: new Uint8Array(0) });
    assert.equal(empty.status, 400);

    const put = await fetch(`${ts.url}/api/images/ok.jpg`, { method: 'PUT', body: new Uint8Array([1, 2]) });
    assert.equal(put.status, 200);
    const overwrite = await fetch(`${ts.url}/api/images/ok.jpg`, { method: 'PUT', body: new Uint8Array([3]) });
    assert.equal(overwrite.status, 200);
    const read = await fetch(`${ts.url}/api/images/ok.jpg`);
    assert.deepEqual(Array.from(new Uint8Array(await read.arrayBuffer())), [3]);

    const del = await fetch(`${ts.url}/api/images/ok.jpg`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const missing = await fetch(`${ts.url}/api/images/ok.jpg`);
    assert.equal(missing.status, 404);
  } finally {
    await ts.close();
  }
});

test('upsertImage / readImages：字节往返一致', () => {
  const db = openDatabaseAt(':memory:');
  upsertImage(db, 'x.jpg', new Uint8Array([7, 8, 9]), 1);
  const images = readImages(db);
  assert.equal(images.length, 1);
  assert.deepEqual(Array.from(images[0]!.bytes), [7, 8, 9]);
  db.close();
});
