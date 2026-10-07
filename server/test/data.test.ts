import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeData, readServerData, readRevision, writeMergedData, type ServerData } from '../src/data.ts';
import { openDatabaseAt } from '../src/db.ts';
import type { SettingsEnvelope, WireItem, WireTombstone } from '../src/serialize.ts';

const EMPTY_SETTINGS: SettingsEnvelope = { value: {}, updatedAt: 0 };

function serverState(parts: {
  reminders?: WireItem[];
  tags?: WireItem[];
  settings?: SettingsEnvelope;
  tombstones?: WireTombstone[];
}): ServerData {
  return {
    reminders: parts.reminders ?? [],
    tags: parts.tags ?? [],
    settings: parts.settings ?? { ...EMPTY_SETTINGS },
    tombstones: parts.tombstones ?? [],
  };
}

function reminder(id: number, updatedAt: number, title = 't'): WireItem {
  return { id, updatedAt, title };
}

test('合并：客户端新增条目', () => {
  const outcome = mergeData(serverState({}), {
    reminders: [reminder(1, 100)],
    tags: [],
    settings: null,
    tombstones: [],
  });
  assert.equal(outcome.reminders.length, 1);
  assert.equal(outcome.changed, true);
});

test('合并：客户端更新较新时覆盖服务端', () => {
  const outcome = mergeData(serverState({ reminders: [reminder(1, 100, 'old')] }), {
    reminders: [reminder(1, 200, 'new')],
    tags: [],
    settings: null,
    tombstones: [],
  });
  assert.equal(outcome.reminders[0]?.title, 'new');
  assert.equal(outcome.changed, true);
});

test('合并：客户端较旧时保留服务端', () => {
  const outcome = mergeData(serverState({ reminders: [reminder(1, 200, 'server')] }), {
    reminders: [reminder(1, 100, 'client')],
    tags: [],
    settings: null,
    tombstones: [],
  });
  assert.equal(outcome.reminders[0]?.title, 'server');
  assert.equal(outcome.changed, false);
});

test('合并：相同 updatedAt 幂等（保留服务端）', () => {
  const outcome = mergeData(serverState({ reminders: [reminder(1, 100, 'server')] }), {
    reminders: [reminder(1, 100, 'client')],
    tags: [],
    settings: null,
    tombstones: [],
  });
  assert.equal(outcome.reminders[0]?.title, 'server');
  assert.equal(outcome.changed, false);
});

test('合并：墓碑删除条目，且相同 updatedAt 时墓碑胜出', () => {
  const outcome = mergeData(serverState({ reminders: [reminder(1, 100)] }), {
    reminders: [],
    tags: [],
    settings: null,
    tombstones: [{ id: 1, updatedAt: 100, kind: 'reminder' }],
  });
  assert.equal(outcome.reminders.length, 0);
  assert.deepEqual(outcome.tombstones, [{ id: 1, updatedAt: 100, kind: 'reminder' }]);
  assert.equal(outcome.changed, true);
});

test('合并：墓碑时间更新时删除较新的服务端条目', () => {
  const outcome = mergeData(serverState({ reminders: [reminder(1, 100)] }), {
    reminders: [],
    tags: [],
    settings: null,
    tombstones: [{ id: 1, updatedAt: 300, kind: 'reminder' }],
  });
  assert.equal(outcome.reminders.length, 0);
});

test('合并：墓碑比条目旧时不生效', () => {
  const outcome = mergeData(serverState({ reminders: [reminder(1, 300)] }), {
    reminders: [],
    tags: [],
    settings: null,
    tombstones: [{ id: 1, updatedAt: 100, kind: 'reminder' }],
  });
  assert.equal(outcome.reminders.length, 1);
  assert.equal(outcome.changed, false);
});

test('合并：较新条目可复活墓碑', () => {
  const outcome = mergeData(serverState({ tombstones: [{ id: 1, updatedAt: 100, kind: 'reminder' }] }), {
    reminders: [reminder(1, 200, 'back')],
    tags: [],
    settings: null,
    tombstones: [],
  });
  assert.equal(outcome.reminders.length, 1);
  assert.equal(outcome.tombstones.length, 0);
});

test('合并：客户端未提及的服务端条目原样保留', () => {
  const outcome = mergeData(serverState({ reminders: [reminder(1, 100), reminder(2, 100)] }), {
    reminders: [reminder(1, 200, 'updated')],
    tags: [],
    settings: null,
    tombstones: [],
  });
  assert.equal(outcome.reminders.length, 2);
  assert.equal(outcome.reminders.find((item) => item.id === 2)?.updatedAt, 100);
});

test('合并：提醒与标签的墓碑按 kind 区分', () => {
  const outcome = mergeData(
    serverState({ reminders: [reminder(1, 100)], tags: [{ id: 1, updatedAt: 100, name: 'tag' }] }),
    {
      reminders: [],
      tags: [],
      settings: null,
      tombstones: [{ id: 1, updatedAt: 100, kind: 'tag' }],
    },
  );
  assert.equal(outcome.reminders.length, 1, '提醒不应被标签墓碑删除');
  assert.equal(outcome.tags.length, 0, '标签应被标签墓碑删除');
});

test('合并：设置较新时覆盖、较旧时保留', () => {
  const newer = mergeData(serverState({ settings: { value: { a: 1 }, updatedAt: 100 } }), {
    reminders: [],
    tags: [],
    settings: { value: { a: 2 }, updatedAt: 200 },
    tombstones: [],
  });
  assert.deepEqual(newer.settings, { value: { a: 2 }, updatedAt: 200 });
  assert.equal(newer.changed, true);

  const older = mergeData(serverState({ settings: { value: { a: 1 }, updatedAt: 100 } }), {
    reminders: [],
    tags: [],
    settings: { value: { a: 2 }, updatedAt: 50 },
    tombstones: [],
  });
  assert.deepEqual(older.settings, { value: { a: 1 }, updatedAt: 100 });
  assert.equal(older.changed, false);
});

test('落库往返：写入后读取一致，revision 有改动才自增', () => {
  const db = openDatabaseAt(':memory:');
  const outcome = mergeData(serverState({}), {
    reminders: [reminder(2, 200, 'b'), reminder(1, 100, 'a')],
    tags: [{ id: 5, updatedAt: 150, name: '工作' }],
    settings: { value: { themeOption: 'DARK' }, updatedAt: 150 },
    tombstones: [],
  });
  const revision = writeMergedData(db, outcome);
  assert.equal(revision, 1);
  assert.equal(readRevision(db), 1);

  const read = readServerData(db);
  assert.equal(read.reminders.length, 2);
  assert.equal(read.reminders[0]?.updatedAt, 100);
  assert.equal(read.tags[0]?.name, '工作');
  assert.deepEqual(read.settings, { value: { themeOption: 'DARK' }, updatedAt: 150 });

  // 幂等写入：无改动，revision 不变。
  const again = mergeData(read, {
    reminders: [reminder(1, 100, 'a')],
    tags: [],
    settings: null,
    tombstones: [],
  });
  const revision2 = writeMergedData(db, again);
  assert.equal(revision2, 1);
  assert.equal(again.changed, false);
  db.close();
});

test('落库往返：墓碑持久化后可再次读取', () => {
  const db = openDatabaseAt(':memory:');
  const first = mergeData(serverState({}), {
    reminders: [reminder(1, 100)],
    tags: [],
    settings: null,
    tombstones: [],
  });
  writeMergedData(db, first);
  const second = mergeData(readServerData(db), {
    reminders: [],
    tags: [],
    settings: null,
    tombstones: [{ id: 1, updatedAt: 200, kind: 'reminder' }],
  });
  writeMergedData(db, second);
  const read = readServerData(db);
  assert.equal(read.reminders.length, 0);
  assert.deepEqual(read.tombstones, [{ id: 1, updatedAt: 200, kind: 'reminder' }]);
  db.close();
});
