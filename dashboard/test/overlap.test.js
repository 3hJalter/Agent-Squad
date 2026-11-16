'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { record } = require('../overlap');

test('two active agents touching the same file is reported once per file', () => {
  const t = {};
  assert.deepStrictEqual(record(t, 'dev', 'T-1', ['a.cs', 'b.cs'], () => true), []);
  assert.deepStrictEqual(record(t, 'tester', 'T-2', ['b.cs', 'c.cs'], () => true), [{ file: 'b.cs', other: 'dev', task: 'T-1' }]);
});
test('an agent that finished its task no longer counts', () => {
  const t = {};
  record(t, 'dev', 'T-1', ['a.cs'], () => true);
  assert.deepStrictEqual(record(t, 'tester', 'T-2', ['a.cs'], () => false), []);
  assert.ok(!t.dev);
});
test('a new task resets the agent own list, same task accumulates', () => {
  const t = {};
  record(t, 'dev', 'T-1', ['a.cs'], () => true);
  record(t, 'dev', 'T-1', ['b.cs'], () => true);
  assert.deepStrictEqual(t.dev.files, ['a.cs', 'b.cs']);
  record(t, 'dev', 'T-3', ['c.cs'], () => true);
  assert.deepStrictEqual({ task: t.dev.task, files: t.dev.files }, { task: 'T-3', files: ['c.cs'] });
});
test('the time of the last record is passed to isActive, so overlapping turns can be detected', () => {
  const t = {};
  record(t, 'dev', '', ['a.cs'], () => true, 500);
  const seen = [];
  const c = record(t, 'tester', '', ['a.cs'], (o, task, at) => { seen.push(at); return at >= 400; }, 600);
  assert.deepStrictEqual(seen, [500]);
  assert.strictEqual(c.length, 1);
});
