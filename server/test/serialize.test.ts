import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseClientData,
  parseSettingsEnvelope,
  parseTombstone,
  parseWireItem,
} from '../src/serialize.ts';

test('parseWireItem：拒绝缺 id / updatedAt / 类型不符的条目', () => {
  assert.equal(parseWireItem({ updatedAt: 1 }, 'reminder'), null);
  assert.equal(parseWireItem({ id: 1 }, 'reminder'), null);
  assert.equal(parseWireItem({ id: 0, updatedAt: 1 }, 'reminder'), null);
  assert.equal(parseWireItem({ id: 1.5, updatedAt: 1 }, 'reminder'), null);
  assert.equal(parseWireItem({ id: 1, updatedAt: -1 }, 'reminder'), null);
  assert.equal(parseWireItem({ id: 1, updatedAt: 1, title: 42 }, 'reminder'), null);
  assert.equal(parseWireItem({ id: 1, updatedAt: 1, type: 'NOPE' }, 'reminder'), null);
  assert.equal(parseWireItem({ id: 1, updatedAt: 1, name: 42 }, 'tag'), null);
  assert.equal(parseWireItem('nope', 'tag'), null);
});

test('parseWireItem：合法条目保留未知字段', () => {
  const item = parseWireItem(
    { id: 7, updatedAt: 100, title: 't', type: 'ANNUAL', extraGlass: 0.5 },
    'reminder',
  );
  assert.deepEqual(item, { id: 7, updatedAt: 100, title: 't', type: 'ANNUAL', extraGlass: 0.5 });
});

test('parseTombstone：缺省 kind 视为提醒，非法 kind 丢弃', () => {
  assert.deepEqual(parseTombstone({ id: 1, updatedAt: 5 }), { id: 1, updatedAt: 5, kind: 'reminder' });
  assert.deepEqual(parseTombstone({ id: 1, updatedAt: 5, kind: 'tag' }), { id: 1, updatedAt: 5, kind: 'tag' });
  assert.equal(parseTombstone({ id: 1, updatedAt: 5, kind: 'nope' }), null);
  assert.equal(parseTombstone({ id: 1 }), null);
});

test('parseSettingsEnvelope：需要 value 对象与 updatedAt', () => {
  assert.deepEqual(parseSettingsEnvelope({ value: { a: 1 }, updatedAt: 9 }), { value: { a: 1 }, updatedAt: 9 });
  assert.equal(parseSettingsEnvelope({ value: [], updatedAt: 9 }), null);
  assert.equal(parseSettingsEnvelope({ value: {}, updatedAt: 'x' }), null);
});

test('parseClientData：无效条目丢弃并计入 rejected', () => {
  const data = parseClientData({
    baseRevision: 3,
    reminders: [{ id: 1, updatedAt: 10 }, { updatedAt: 10 }, 'bad', { id: 2, updatedAt: 20 }],
    tags: [{ id: 1, updatedAt: 1, name: 'x' }],
    tombstones: [{ id: 2, updatedAt: 30 }, { id: 'x', updatedAt: 1 }],
    settings: { value: { themeOption: 'DARK' }, updatedAt: 5 },
  });
  assert.equal(data.baseRevision, 3);
  assert.equal(data.reminders.length, 2);
  assert.equal(data.tags.length, 1);
  assert.equal(data.tombstones.length, 1);
  assert.equal(data.rejected, 3);
});

test('parseClientData：缺省数组视为空，非数组计入 rejected', () => {
  const data = parseClientData({ reminders: 'nope' });
  assert.deepEqual(data.reminders, []);
  assert.equal(data.rejected, 1);
});

test('parseClientData：整体非对象时 rejected=1', () => {
  assert.equal(parseClientData(null).rejected, 1);
  assert.equal(parseClientData([]).rejected, 1);
});
