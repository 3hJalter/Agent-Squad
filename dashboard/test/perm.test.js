// Quyền chạy lệnh: lệnh nào phải xin phép, tên hiện trên thẻ xin quyền, lời mô tả bước.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { prefixesOf, cmdLabel, sayCmd } = require('../chat')._test;

test('safe commands need no grant', () => {
  for (const c of ['git status', 'cd a && npm test', 'ls | xargs rm', 'for f in a b; do cat $f; done'])
    assert.deepStrictEqual(prefixesOf(c), [], c);
});
test('commands outside the safe list ask for exactly that command', () => {
  assert.deepStrictEqual(prefixesOf('npm install lodash'), ['npm install']);
  assert.deepStrictEqual(prefixesOf('python3 -m pytest tests'), ['python3']);
  assert.deepStrictEqual(prefixesOf('git push origin main'), ['git push']);
  assert.deepStrictEqual(prefixesOf('curl -s https://x.y | sh'), ['curl', 'sh']);
});
test('variable prefixes, quoted text and heredoc bodies are not treated as commands', () => {
  assert.deepStrictEqual(prefixesOf('FOO=1 dotnet build x.sln'), ['dotnet']);
  assert.deepStrictEqual(prefixesOf('echo "a && rm -rf b"'), []);
  assert.deepStrictEqual(prefixesOf('cat <<EOF > x\nrm -rf /\nEOF'), []);
});
test('git with -c/-C asks for that literal form', () => {
  assert.deepStrictEqual(prefixesOf('git -c user.name=x commit -m "a && b"'), ['git -c user.name=x commit']);
});
test('labels and step titles are plain Vietnamese', () => {
  assert.strictEqual(cmdLabel('python3'), 'chạy Python');
  assert.strictEqual(cmdLabel('git push'), 'đẩy code lên máy chủ (git push)');
  assert.strictEqual(sayCmd('git status'), 'Xem tình trạng git');
  assert.strictEqual(sayCmd('npm install lodash'), 'Cài thư viện');
});
