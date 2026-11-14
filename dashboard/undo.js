// Hoàn tác thay đổi file của một lượt agent, dựa vào git nhưng không đụng tới lịch sử commit.
// - snapshot(): chụp toàn bộ thư mục làm việc (kể cả file chưa add, trừ .agents và file bị ignore) thành một "tree" của git,
//   dùng index tạm nên không ảnh hưởng tới index thật.
// - undoTurn(): với từng file khác nhau giữa bản chụp trước và sau lượt, nếu file hiện vẫn đúng như sau lượt đó thì trả về
//   nội dung trước lượt (file mới tạo thì xoá). File đã bị sửa tiếp sau đó được giữ nguyên và báo lại.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 400;

async function snapshot(run, cwd) {
  const tmp = path.join(os.tmpdir(), 'squad-idx-' + crypto.randomBytes(6).toString('hex'));
  try {
    const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    if (!top.ok) return '';
    const idx = await run('git', ['-C', cwd, 'rev-parse', '--git-path', 'index']);
    // chép index thật để git không phải đọc lại mọi file
    try { fs.copyFileSync(path.resolve(cwd, idx.out.trim()), tmp); } catch { /* repo chưa có index */ }
    const env = { ...process.env, GIT_INDEX_FILE: tmp };
    // không dùng ':(exclude).agents' ở đây: khi .agents nằm trong .gitignore thì git add báo lỗi vì pathspec đó
    const add = await run('git', ['-C', cwd, 'add', '-A', '--', '.'], { env, timeout: 30000, cwd });
    if (!add.ok) return '';
    await run('git', ['-C', cwd, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.agents'], { env, cwd });
    const tree = await run('git', ['-C', cwd, 'write-tree'], { env, cwd });
    return tree.ok ? tree.out.trim() : '';
  } catch { return ''; } finally { fs.rm(tmp, { force: true }, () => {}); fs.rm(tmp + '.lock', { force: true }, () => {}); }
}

// danh sách file khác nhau giữa hai bản chụp: [{ status: 'A'|'M'|'D', file }]
async function changed(run, cwd, pre, post) {
  if (!pre || !post || pre === post) return [];
  const r = await run('git', ['-C', cwd, '-c', 'core.quotepath=off', 'diff', '--name-status', '--no-renames', '-z', pre, post], { cwd });
  if (!r.ok) return [];
  const parts = r.out.split('\0').filter(Boolean), out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], file: parts[i + 1] });
  return out;
}

async function undoTurn(run, cwd, pre, post) {
  const top = (await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])).out.trim();
  const list = await changed(run, cwd, pre, post);
  if (!top || !list.length) return { restored: [], skipped: [], total: 0 };
  if (list.length > MAX_FILES) throw new Error(`Lượt này đổi ${list.length} file, nhiều hơn mức hoàn tác tự động (${MAX_FILES}).`);
  const blob = async (tree, f) => { const r = await run('git', ['-C', top, 'rev-parse', '--verify', '-q', `${tree}:${f}`], { cwd: top }); return r.ok ? r.out.trim() : ''; };
  const restored = [], skipped = [];
  for (const { status, file } of list) {
    const abs = path.join(top, file);
    let cur = '';
    if (fs.existsSync(abs)) { const h = await run('git', ['-C', top, 'hash-object', '--', file], { cwd: top }); cur = h.ok ? h.out.trim() : '?'; }
    if (cur !== await blob(post, file)) { skipped.push(file); continue; } // đã bị sửa tiếp sau lượt này
    if (status === 'A') { try { fs.unlinkSync(abs); restored.push(file); } catch { skipped.push(file); } continue; }
    const r = await run('git', ['-C', top, 'restore', '--source=' + pre, '--worktree', '--', file], { cwd: top });
    (r.ok ? restored : skipped).push(file);
  }
  return { restored, skipped, total: list.length };
}

module.exports = { snapshot, changed, undoTurn };
