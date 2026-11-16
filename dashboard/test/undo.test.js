// Chạy: node --test dashboard/test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const undo = require('../undo');

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 20000, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout), err: String(stderr || (err && err.message) || '') }));
});
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-undo-'));
  const git = (...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]);
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
  const r = (f) => fs.readFileSync(path.join(d, f), 'utf8');
  git('init', '-q', '-b', 'main');
  w('a.txt', 'one\n'); w('dir/b.txt', 'two\n'); w('c.txt', 'three\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  return { d, git, w, r, has: (f) => fs.existsSync(path.join(d, f)) };
}

test('snapshot does not touch the real index or HEAD', async () => {
  const { d, git, w } = repo();
  w('new.txt', 'x\n');
  const before = String(git('status', '--porcelain'));
  const tree = await undo.snapshot(run, d);
  assert.match(tree, /^[0-9a-f]{40,64}$/);
  assert.strictEqual(String(git('status', '--porcelain')), before);
});

test('undo restores edits, removes new files, brings back deleted files', async () => {
  const { d, w, r, has } = repo();
  w('untracked-before.txt', 'keep me\n');
  const pre = await undo.snapshot(run, d);
  w('a.txt', 'ONE changed\n'); w('made.txt', 'new\n'); fs.unlinkSync(path.join(d, 'c.txt')); w('untracked-before.txt', 'edited\n');
  const post = await undo.snapshot(run, d);
  assert.strictEqual((await undo.changed(run, d, pre, post)).length, 4);
  const res = await undo.undoTurn(run, d, pre, post);
  assert.strictEqual(res.restored.length, 4);
  assert.strictEqual(r('a.txt'), 'one\n');
  assert.strictEqual(r('c.txt'), 'three\n');
  assert.strictEqual(r('untracked-before.txt'), 'keep me\n');
  assert.ok(!has('made.txt'));
});

test('files edited again after the turn are left alone', async () => {
  const { d, w, r } = repo();
  const pre = await undo.snapshot(run, d);
  w('a.txt', 'agent\n'); w('dir/b.txt', 'agent\n');
  const post = await undo.snapshot(run, d);
  w('a.txt', 'someone else\n');
  const res = await undo.undoTurn(run, d, pre, post);
  assert.deepStrictEqual(res.skipped, ['a.txt']);
  assert.strictEqual(r('a.txt'), 'someone else\n');
  assert.strictEqual(r('dir/b.txt'), 'two\n');
});

test('undo still works after the turn was committed, without rewriting history', async () => {
  const { d, git, w, r } = repo();
  const pre = await undo.snapshot(run, d);
  w('a.txt', 'agent\n');
  const post = await undo.snapshot(run, d);
  git('add', '-A'); git('commit', '-qm', 'agent turn');
  const head = String(git('rev-parse', 'HEAD'));
  await undo.undoTurn(run, d, pre, post);
  assert.strictEqual(r('a.txt'), 'one\n');
  assert.strictEqual(String(git('rev-parse', 'HEAD')), head);
});

test('.agents is ignored and a non-git folder gives no snapshot', async () => {
  const { d, w } = repo();
  w('.gitignore', '.agents\n');
  const pre = await undo.snapshot(run, d);
  w('.agents/chat/x.json', '{}');
  assert.strictEqual(await undo.snapshot(run, d), pre);
  assert.strictEqual(await undo.snapshot(run, fs.mkdtempSync(path.join(os.tmpdir(), 'squad-nogit-'))), '');
});
