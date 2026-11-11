#!/usr/bin/env node
// Agent-Squad dashboard: web UI chạy local để xem task, giao việc và điều khiển các window tmux,
// cho nhiều project (mỗi project là một repo git, một phiên tmux riêng).
// Không cần cài gói npm nào. Chạy:  node dashboard/server.js   rồi mở http://localhost:7070
// Biến môi trường: PORT (7070), HOST (127.0.0.1), SESSION (phiên của project mặc định, "agents"),
// REPO (project mặc định, mặc định là repo chứa dashboard).
// Danh sách project lưu ở ~/.agent-squad/projects.json.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const SQUAD = path.resolve(__dirname, '..');
const SCRIPTS = path.join(SQUAD, 'scripts');
const DEFAULT_ROOT = path.resolve(process.env.REPO || SQUAD);
const DEFAULT_SESSION = process.env.SESSION || 'agents';
const PORT = Number(process.env.PORT || 7070);
const HOST = process.env.HOST || '127.0.0.1';
const CONF_DIR = path.join(os.homedir(), '.agent-squad');
const PROJECTS_FILE = path.join(CONF_DIR, 'projects.json');

const ID_RE = /^T-\d{1,6}$/;
const WIN_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{0,64}$/;
const EFFORT_RE = /^[a-z]{0,12}$/;
const AGENTS = new Set(['claude', 'codex', 'gemini']);
const KEYS = new Set(['Enter', 'Escape', 'C-c', 'Up', 'Down', 'Tab', 'BTab', 'y', 'n', '1', '2', '3', '4', '5']);

const FALLBACK_TEMPLATE = `# T-XXX: <short title>
Status: todo
Owner: codex

## Goal
<one or two sentences>

## Files you may edit
- <path or folder>

## Context (link files, do not paste)
- <path>

## Done when (checks to run)
- <command, e.g. npm test>

## Notes / questions

## Changes by human

## Result (worker fills, max 5 lines)
`;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: SQUAD, timeout: 20000, maxBuffer: 4 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(stdout), err: String(stderr || (err && err.message) || '') });
    });
  });
}
const tmux = (...args) => run('tmux', args);

// ---------------------------------------------------------------- projects
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'project';

function loadProjects() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch { /* chưa có file */ }
  if (!Array.isArray(list)) list = [];
  list = list.filter((p) => p && p.id && p.path);
  if (!list.some((p) => p.path === DEFAULT_ROOT)) list.unshift({ id: slug(path.basename(DEFAULT_ROOT)), name: path.basename(DEFAULT_ROOT), path: DEFAULT_ROOT });
  return list;
}
function saveProjects(list) {
  fs.mkdirSync(CONF_DIR, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2));
}
function withCtx(p) {
  const root = p.path;
  return { ...p, root, tasks: path.join(root, '.agents', 'tasks'), session: root === DEFAULT_ROOT ? DEFAULT_SESSION : `agents-${p.id}` };
}
function getCtx(url) {
  const list = loadProjects();
  const id = url.searchParams.get('p');
  const p = list.find((x) => x.id === id) || list[0];
  return withCtx(p);
}
// Đường dẫn Windows (D:\Web\proj) -> /mnt/d/Web/proj; ~ -> home
function normPath(input) {
  let s = String(input || '').trim().replace(/^["']|["']$/g, '');
  const m = s.match(/^([A-Za-z]):[\\/](.*)$/);
  if (m) s = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(s);
}
const scriptEnv = (ctx, extra = {}) => ({ ...process.env, AGENTS_ROOT: ctx.root, SESSION: ctx.session, ...extra });

async function scaffoldState(root, office) {
  const missing = ['AGENTS.md', 'CLAUDE.md', 'scripts/assign.sh', '.agents/tasks/_template.md'].filter((f) => !fs.existsSync(path.join(root, f)));
  if (office) return { missing, needsCommit: false }; // project điều hành không dùng git
  const st = await run('git', ['-C', root, 'status', '--porcelain', '--', 'AGENTS.md', 'CLAUDE.md', 'scripts', '.gitignore']);
  const head = await run('git', ['-C', root, 'rev-parse', 'HEAD']);
  return { missing, needsCommit: !head.ok || st.out.trim().length > 0 };
}
// Dựng file khung trong thư mục KHÔNG phải repo git (project điều hành): setup-agents.sh đòi có .git nên tạo tạm rồi bỏ
async function scaffoldOffice(root) {
  const g = path.join(root, '.git'), ig = path.join(root, '.gitignore');
  const hadGit = fs.existsSync(g), hadIgnore = fs.existsSync(ig);
  if (!hadGit) fs.mkdirSync(g);
  try {
    const r = await run('bash', [path.join(SCRIPTS, 'setup-agents.sh')], { cwd: root });
    return (r.out + r.err).trim();
  } finally {
    if (!hadGit) fs.rmSync(g, { recursive: true, force: true });
    if (!hadIgnore) fs.rmSync(ig, { force: true });
  }
}

// ---------------------------------------------------------------- tasks
function field(text, name) {
  const m = text.match(new RegExp('^' + name + ':[ \\t]*(.*)$', 'm'));
  return m ? m[1].trim() : '';
}
function section(text, heading) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.toLowerCase().startsWith('## ' + heading.toLowerCase()));
  if (i < 0) return '';
  const out = [];
  for (let j = i + 1; j < lines.length && !lines[j].startsWith('## '); j++) out.push(lines[j]);
  return out.join('\n').trim();
}
const taskPath = (ctx, id) => path.join(ctx.tasks, id + '.md');

function listTasks(ctx) {
  let files = [];
  try { files = fs.readdirSync(ctx.tasks).filter((f) => /^T-\d+\.md$/.test(f)); } catch { /* chưa có thư mục */ }
  return files.map((f) => {
    const p = path.join(ctx.tasks, f);
    const text = fs.readFileSync(p, 'utf8');
    const first = text.split(/\r?\n/)[0] || '';
    return {
      id: f.slice(0, -3),
      title: first.replace(/^#\s*T-\d+\s*:?\s*/, '').trim(),
      status: field(text, 'Status').toLowerCase() || 'todo',
      owner: field(text, 'Owner'),
      category: field(text, 'Category'),
      createdBy: field(text, 'Created by'),
      parent: field(text, 'Parent'),
      result: section(text, 'Result'),
      mtime: fs.statSync(p).mtimeMs,
    };
  }).sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)));
}

// .agents/hierarchy.txt: "<name> <- <parent>" mỗi dòng; không có file = phẳng (mọi người dưới lead)
function readHierarchy(ctx) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(path.join(ctx.root, '.agents', 'hierarchy.txt'), 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').match(/^\s*(\S+)\s*<-\s*(\S+)\s*$/);
    if (m && m[1] !== 'lead') out[m[1]] = m[2];
  }
  return out;
}

function nextId(ctx) {
  let archived = [];
  try { archived = fs.readdirSync(path.join(ctx.tasks, 'archive')).map((f) => (f.match(/^T-(\d+)/) || [])[1]).filter(Boolean); } catch { /* chưa có */ }
  const nums = [...listTasks(ctx).map((t) => Number(t.id.slice(2))), ...archived.map(Number)];
  return 'T-' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
}

function bullets(s) {
  const lines = String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines.map((l) => (l.startsWith('-') ? l : '- ' + l)).join('\n') : '- ';
}

function createTask(ctx, b) {
  const title = String(b.title || '').replace(/\r?\n/g, ' ').trim();
  if (!title) throw new Error('Thiếu tiêu đề');
  const owner = WIN_RE.test(b.owner || '') ? b.owner : 'codex';
  fs.mkdirSync(ctx.tasks, { recursive: true });
  const id = nextId(ctx);
  const text = `# ${id}: ${title}
Status: todo
Owner: ${owner}

## Goal
${String(b.goal || '').trim()}

## Files you may edit
${bullets(b.files)}

## Context (link files, do not paste)
${bullets(b.context)}

## Done when (checks to run)
${bullets(b.done)}

## Notes / questions

## Changes by human

## Result (worker fills, max 5 lines)
`;
  fs.writeFileSync(taskPath(ctx, id), text, { flag: 'wx' });
  return id;
}

// ---------------------------------------------------------------- tmux
async function sessionInfo(ctx) {
  const has = await tmux('has-session', '-t', ctx.session);
  if (!has.ok) return { running: false, windows: [] };
  const r = await tmux('list-windows', '-t', ctx.session, '-F', '#{window_name}|#{window_active}|#{pane_current_command}');
  const windows = r.out.trim().split('\n').filter(Boolean).map((l) => {
    const [name, active, cmd] = l.split('|');
    return { name, active: active === '1', cmd };
  });
  return { running: true, windows };
}

async function sendText(ctx, win, text, enter) {
  const target = `${ctx.session}:${win}`;
  if (text) {
    // Dán qua buffer với bracketed paste (-p): tin nhiều dòng không bị gửi từng dòng một.
    const tmp = path.join(os.tmpdir(), `squad-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(tmp, text);
    const buf = `squad-${process.pid}`;
    const l = await tmux('load-buffer', '-b', buf, tmp);
    fs.rmSync(tmp, { force: true });
    if (!l.ok) return l;
    const r = await tmux('paste-buffer', '-p', '-d', '-b', buf, '-t', target);
    if (!r.ok) return r;
  }
  if (enter) {
    await new Promise((res) => setTimeout(res, 400)); // như assign.sh: đợi TUI nhận xong chữ
    return tmux('send-keys', '-t', target, 'Enter');
  }
  return { ok: true };
}

const WNAME_RE = /^[A-Za-z0-9_-]{1,30}$/;
const okName = (n) => !n || (WNAME_RE.test(n) && n !== 'lead' && n !== 'watch');
const specOf = (a) => (a && AGENTS.has(a.agent) && MODEL_RE.test(a.model || '') && EFFORT_RE.test(a.effort || '') && okName(a.name))
  ? (a.name ? a.name + '=' : '') + a.agent + (a.model ? '@' + a.model : '') + (a.effort ? '#' + a.effort : '') : null;

// ---------------------------------------------------------------- http
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) { reject(new Error('Body quá lớn')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('JSON không hợp lệ')); } });
  });
}
// Chặn trang web lạ gọi vào localhost (DNS rebinding / CSRF): chỉ nhận Host localhost và
// yêu cầu header X-Squad cho mọi lệnh ghi (trình duyệt không cho site khác gửi header này).
function allowed(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host) && host !== HOST) return false;
  if (req.method !== 'GET' && req.headers['x-squad'] !== '1') return false;
  return true;
}

const routes = [];
const on = (method, re, fn) => routes.push({ method, re, fn });

on('GET', /^\/$/, (req, res) => send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8'));
on('GET', /^\/api\/catalog$/, (req, res) => send(res, 200, fs.readFileSync(path.join(__dirname, 'catalog.json'))));

// --- projects
on('GET', /^\/api\/projects$/, async (req, res) => {
  const list = await Promise.all(loadProjects().map(async (p) => {
    const c = withCtx(p);
    const has = await tmux('has-session', '-t', c.session);
    return { id: p.id, name: p.name, path: p.path, kind: p.kind || '', session: c.session, running: has.ok, exists: fs.existsSync(p.path) };
  }));
  send(res, 200, { projects: list });
});

// git commit với danh tính dự phòng nếu máy chưa cấu hình user.name/user.email
async function gitCommit(root, msg, files) {
  const id = await run('git', ['-C', root, 'config', 'user.email']);
  const extra = id.out.trim() ? [] : ['-c', 'user.name=Agent-Squad', '-c', 'user.email=agent-squad@localhost'];
  return run('git', ['-C', root, ...extra, 'commit', '-m', msg, ...(files ? ['--', ...files] : [])]);
}

async function addProject(dir, name, init) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { code: 400, body: { error: `Không có thư mục ${dir}` } };
  let top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  let created = false;
  if (!top.ok) {
    if (!init) return { code: 400, body: { code: 'not_repo', error: `${dir} chưa phải repo git.` } };
    const i = await run('git', ['-C', dir, 'init']);
    if (!i.ok) return { code: 500, body: { error: i.err.trim() } };
    created = true;
    top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  }
  const root = top.out.trim();
  const list = loadProjects();
  let p = list.find((x) => x.path === root);
  if (!p) {
    const nm = String(name || '').trim() || path.basename(root);
    let id = slug(nm), n = 2;
    while (list.some((x) => x.id === id)) id = `${slug(nm)}-${n++}`;
    p = { id, name: nm, path: root };
    list.push(p); saveProjects(list);
  }
  let setup = null;
  const sc = await scaffoldState(root);
  if (sc.missing.length) {
    const r = await run('bash', [path.join(SCRIPTS, 'setup-agents.sh')], { cwd: root });
    setup = (r.out + r.err).trim();
  }
  let commit = null;
  if (created) {
    // repo mới tạo: commit toàn bộ (theo .gitignore) để worker thấy được file của project
    await run('git', ['-C', root, 'add', '-A']);
    const c = await gitCommit(root, 'Initial commit (Agent-Squad)');
    commit = { ok: c.ok, out: (c.out + c.err).trim() };
  }
  return { code: 200, body: { project: p, created, setup, commit, ...(await scaffoldState(root)) } };
}

on('POST', /^\/api\/projects$/, async (req, res) => {
  const b = await readBody(req);
  const r = await addProject(normPath(b.path), b.name, !!b.init);
  send(res, r.code, r.body);
});

// Tạo project mới: thư mục <parent>/<name> + git init + file khung + commit đầu
on('POST', /^\/api\/projects\/new$/, async (req, res) => {
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  if (!name) return send(res, 400, { error: 'Nhập tên project' });
  const folder = slug(name);
  const parent = normPath(b.parent || '~');
  const dir = path.join(parent, folder);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) return send(res, 400, { error: `Thư mục ${dir} đã có và không trống. Dùng "Thêm project có sẵn" hoặc đặt tên khác.` });
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return send(res, 400, { error: e.message }); }
  if (b.description) fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\n${String(b.description).trim()}\n`);
  if (b.office) {
    // project điều hành: chỉ chứa task / chat / quy ước, không git; dữ liệu thật nằm ở các thư mục "Tài nguyên"
    const list = loadProjects();
    let id = slug(name), n = 2;
    while (list.some((x) => x.id === id)) id = `${slug(name)}-${n++}`;
    const p = { id, name, path: dir, kind: 'office', resources: [] };
    list.push(p); saveProjects(list);
    const setup = await scaffoldOffice(dir);
    return send(res, 200, { project: p, created: true, setup, office: true, ...(await scaffoldState(dir, true)) });
  }
  const r = await addProject(dir, name, true);
  send(res, r.code, r.body);
});

// Thử chạy bản code hiện có trên đĩa ở một cổng tạm: nếu nó lỗi ngay khi khởi động thì không khởi động lại,
// để dashboard đang chạy không bị tắt bởi một bản nâng cấp hỏng.
function selfTest() {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: '0', SQUAD_SELFTEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', done = false;
    const end = (ok) => { if (!done) { done = true; c.kill('SIGTERM'); resolve({ ok, out: out.trim().slice(-1500) }); } };
    c.stdout.on('data', (d) => { out += d; if (/Agent-Squad dashboard:/.test(out)) end(true); });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', () => end(false));
    setTimeout(() => end(false), 8000);
  });
}
// Thoát với mã 75: scripts/dashboard.sh chạy lại server (đọc code mới).
function restartSoon() {
  setTimeout(() => { chat.killAll(); setTimeout(() => process.exit(75), 300); }, 300);
}

// Cập nhật Agent-Squad (git pull) rồi tự khởi động lại dashboard
on('POST', /^\/api\/update$/, async (req, res) => {
  const before = await run('git', ['-C', SQUAD, 'rev-parse', 'HEAD']);
  const r = await run('git', ['-C', SQUAD, 'pull', '--ff-only'], { timeout: 120000 });
  const after = await run('git', ['-C', SQUAD, 'rev-parse', 'HEAD']);
  const changed = r.ok && before.out !== after.out;
  if (!changed) return send(res, r.ok ? 200 : 500, { ok: r.ok, changed, out: (r.out + r.err).trim() });
  const t = await selfTest();
  if (!t.ok) return send(res, 500, { ok: false, changed, out: 'Đã tải bản mới nhưng bản này không khởi động được, nên dashboard vẫn chạy bản cũ.\n' + t.out });
  send(res, 200, { ok: true, changed, out: (r.out + r.err).trim() });
  restartSoon();
});

// Khởi động lại dashboard để chạy code mới trên máy (ví dụ sau khi lead gộp bản nâng cấp)
on('POST', /^\/api\/restart$/, async (req, res, _m, url) => {
  const b = await readBody(req);
  const busy = chat.busyCount();
  if (busy && !b.force) return send(res, 409, { code: 'busy', busy, error: `${busy} agent đang làm việc. Khởi động lại sẽ dừng lượt đang chạy của chúng.` });
  const t = await selfTest();
  if (!t.ok) return send(res, 500, { error: 'Code mới không khởi động được, nên dashboard vẫn chạy bản hiện tại. Nhắn Lead sửa lỗi này:\n' + t.out });
  send(res, 200, { ok: true });
  restartSoon();
});

on('POST', /^\/api\/projects\/prune$/, (req, res) => {
  const list = loadProjects();
  const keep = list.filter((x) => x.path === DEFAULT_ROOT || fs.existsSync(x.path));
  saveProjects(keep);
  send(res, 200, { removed: list.length - keep.length });
});

// --- duyệt thư mục (cho hộp chọn project)
const fsRoots = () => {
  const roots = [{ label: 'Home (WSL)', path: os.homedir() }];
  try { for (const d of fs.readdirSync('/mnt')) if (/^[a-z]$/.test(d)) roots.push({ label: `${d.toUpperCase()}:`, path: `/mnt/${d}` }); } catch { /* không phải WSL */ }
  return roots;
};
on('GET', /^\/api\/fs$/, (req, res, _m, url) => {
  const dir = normPath(url.searchParams.get('dir') || os.homedir());
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => { try { return (e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(dir, e.name)).isDirectory())) && !e.name.startsWith('.') && !e.name.startsWith('$'); } catch { return false; } })
      .map((e) => ({ name: e.name, repo: fs.existsSync(path.join(dir, e.name, '.git')) }))
      .sort((x, y) => x.name.localeCompare(y.name));
  } catch (e) { return send(res, 400, { error: `Không mở được ${dir}: ${e.code || e.message}` }); }
  send(res, 200, { dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), repo: fs.existsSync(path.join(dir, '.git')), entries: entries.slice(0, 500), roots: fsRoots() });
});
on('POST', /^\/api\/fs\/mkdir$/, async (req, res) => {
  const b = await readBody(req);
  const name = String(b.name || '').trim();
  if (!name || /[\\/]|^\.\.?$/.test(name)) return send(res, 400, { error: 'Tên thư mục không hợp lệ' });
  const dir = path.join(normPath(b.dir), name);
  try { fs.mkdirSync(dir); } catch (e) { return send(res, 400, { error: e.code === 'EEXIST' ? 'Thư mục đã có' : e.message }); }
  send(res, 200, { dir });
});
// Hộp thoại chọn thư mục của Windows (chỉ chạy được trong WSL có powershell.exe)
on('POST', /^\/api\/fs\/pick$/, async (req, res) => {
  const ps = "Add-Type -AssemblyName System.Windows.Forms; $o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; " +
    "$f=New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description='Chon thu muc project cho Agent-Squad'; $f.ShowNewFolderButton=$true; " +
    "if($f.ShowDialog($o) -eq 'OK'){[Console]::Out.Write($f.SelectedPath)}";
  const r = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { timeout: 10 * 60000 });
  if (!r.ok) return send(res, 501, { error: 'Không mở được hộp thoại Windows (chỉ dùng được khi chạy trong WSL). Hãy dùng nút "Duyệt".' });
  const win = r.out.trim();
  if (!win) return send(res, 200, { path: null });
  const u = await run('wslpath', ['-u', win]);
  send(res, 200, { path: u.ok ? u.out.trim() : normPath(win), windowsPath: win });
});

on('DELETE', /^\/api\/projects$/, (req, res, _m, url) => {
  const id = url.searchParams.get('p');
  const list = loadProjects();
  const p = list.find((x) => x.id === id);
  if (!p) return send(res, 404, { error: 'Không có project' });
  if (p.path === DEFAULT_ROOT) return send(res, 400, { error: 'Không bỏ được project mặc định' });
  saveProjects(list.filter((x) => x.id !== id));
  send(res, 200, { ok: true });
});

on('POST', /^\/api\/projects\/commit$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  const files = ['AGENTS.md', 'CLAUDE.md', 'scripts', '.gitignore'].filter((f) => fs.existsSync(path.join(ctx.root, f)));
  const a = await run('git', ['-C', ctx.root, 'add', '--', ...files]);
  if (!a.ok) return send(res, 500, { error: a.err.trim() });
  const c = await gitCommit(ctx.root, 'Add agent scaffolding (Agent-Squad)', files);
  send(res, c.ok ? 200 : 500, { ok: c.ok, out: (c.out + c.err).trim() });
});

on('POST', /^\/api\/office\/scaffold$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  if (ctx.kind !== 'office') return send(res, 400, { error: 'Chỉ dùng cho project điều hành.' });
  send(res, 200, { ok: true, out: await scaffoldOffice(ctx.root) });
});

// Cài đặt theo project (hiện chỉ có context-mode: thử nghiệm, tắt mặc định)
on('POST', /^\/api\/project\/settings$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  const b = await readBody(req);
  if (typeof b.contextMode !== 'boolean') return send(res, 400, { error: 'Thiếu contextMode' });
  const ok = editProject(ctx, (pr) => { pr.contextMode = b.contextMode; return true; });
  if (!ok) return send(res, 404, { error: 'Không có project' });
  send(res, 200, { ok: true, contextMode: b.contextMode });
});

// --- tài nguyên: folder/file ngoài project mà agent được đọc và sửa tại chỗ (xem chat.js: resourceInfo)
const tooWide = (p) => p === '/' || p === os.homedir() || /^\/mnt\/[a-z]$/.test(p);
function editProject(ctx, fn) {
  const list = loadProjects();
  const p = list.find((x) => x.id === ctx.id);
  if (!p) return false;
  p.resources = Array.isArray(p.resources) ? p.resources : [];
  const r = fn(p);
  saveProjects(list);
  return r;
}
on('POST', /^\/api\/resources$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  const b = await readBody(req);
  if (!String(b.path || '').trim()) return send(res, 400, { error: 'Chọn hoặc nhập đường dẫn' });
  let p = normPath(b.path);
  try { p = fs.realpathSync(p); } catch { return send(res, 400, { error: `Không có đường dẫn ${p}` }); }
  if (tooWide(p)) return send(res, 400, { error: 'Thư mục này quá rộng (cả ổ đĩa hoặc cả thư mục Home). Hãy chọn một thư mục cụ thể.' });
  if (p === ctx.root || p.startsWith(ctx.root + path.sep)) return send(res, 400, { error: 'Đường dẫn này đã nằm trong project, không cần thêm.' });
  const err = editProject(ctx, (pr) => {
    if (pr.resources.some((r) => r.path === p)) return 'Đã có trong danh sách.';
    pr.resources.push({ path: p });
    return '';
  });
  if (err === false) return send(res, 404, { error: 'Không có project' });
  if (err) return send(res, 400, { error: err });
  send(res, 200, { ok: true, resources: chat.resourceInfo(withCtx(loadProjects().find((x) => x.id === ctx.id))) });
});
on('DELETE', /^\/api\/resources$/, (req, res, _m, url) => {
  const ctx = getCtx(url);
  const p = url.searchParams.get('path');
  const ok = editProject(ctx, (pr) => { const n = pr.resources.length; pr.resources = pr.resources.filter((r) => r.path !== p); return n !== pr.resources.length; });
  if (!ok) return send(res, 404, { error: 'Không có mục này' });
  send(res, 200, { ok: true });
});
// .gitignore chuẩn cho project Unity (chỉ tạo khi chưa có, và chỉ khi bạn bấm nút)
const UNITY_IGNORE = `# Unity (tạo bởi Agent-Squad)
[Ll]ibrary/
[Tt]emp/
[Oo]bj/
[Bb]uild/
[Bb]uilds/
[Ll]ogs/
[Uu]ser[Ss]ettings/
[Mm]emoryCaptures/
[Rr]ecordings/
.vs/
.idea/
.gradle/
ExportedObj/
*.csproj
*.unityproj
*.sln
*.suo
*.tmp
*.user
*.userprefs
*.pidb
*.booproj
*.svd
*.pdb
*.mdb
*.opendb
*.VC.db
sysinfo.txt
*.apk
*.aab
*.unitypackage
crashlytics-build.properties
/[Aa]ssets/[Aa]ddressable[Aa]ssets[Dd]ata/*/*.bin*
/[Aa]ssets/[Ss]treamingAssets/aa.meta
/[Aa]ssets/[Ss]treamingAssets/aa/*
`;
on('POST', /^\/api\/resources\/unity-ignore$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  const b = await readBody(req);
  const r = chat.resourceInfo(ctx).find((x) => x.path === b.path);
  if (!r || !r.unity || !r.isRepo) return send(res, 400, { error: 'Không phải project Unity có git.' });
  const f = path.join(r.path, '.gitignore');
  if (fs.existsSync(f)) return send(res, 400, { error: 'Đã có .gitignore, không ghi đè.' });
  fs.writeFileSync(f, UNITY_IGNORE);
  send(res, 200, { ok: true });
});

// --- state / tasks
on('GET', /^\/api\/state$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  let workersTxt = '';
  try { workersTxt = fs.readFileSync(path.join(ctx.root, '.agents', 'workers.txt'), 'utf8'); } catch { /* chưa start */ }
  send(res, 200, {
    project: { id: ctx.id, name: ctx.name, path: ctx.root, kind: ctx.kind || '', contextMode: !!ctx.contextMode }, session: ctx.session,
    ...(await sessionInfo(ctx)), chat: chat.info(ctx), requests: chat.listRequests(ctx), tasks: listTasks(ctx), workersTxt, hierarchy: readHierarchy(ctx),
    resources: chat.resourceInfo(ctx), ...(await scaffoldState(ctx.root, ctx.kind === 'office')),
  });
});

on('GET', /^\/api\/task\/([^/]+)$/, (req, res, m, url) => {
  const [id] = m; const ctx = getCtx(url);
  if (!ID_RE.test(id)) return send(res, 400, { error: 'ID không hợp lệ' });
  try { send(res, 200, { id, text: fs.readFileSync(taskPath(ctx, id), 'utf8') }); } catch { send(res, 404, { error: 'Không có task' }); }
});

// Xoá task = chuyển vào .agents/tasks/archive/ (lấy lại được bằng cách chuyển file về)
function archiveTask(ctx, id) {
  const src = taskPath(ctx, id);
  if (!fs.existsSync(src)) return false;
  const dir = path.join(ctx.tasks, 'archive');
  fs.mkdirSync(dir, { recursive: true });
  let dst = path.join(dir, id + '.md'), n = 2;
  while (fs.existsSync(dst)) dst = path.join(dir, `${id}-${n++}.md`);
  fs.renameSync(src, dst);
  return true;
}
on('DELETE', /^\/api\/task\/([^/]+)$/, (req, res, m, url) => {
  const [id] = m; const ctx = getCtx(url);
  if (!ID_RE.test(id)) return send(res, 400, { error: 'ID không hợp lệ' });
  if (!archiveTask(ctx, id)) return send(res, 404, { error: 'Không có task' });
  send(res, 200, { ok: true });
});
on('POST', /^\/api\/tasks\/cleanup$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  const b = await readBody(req);
  const want = new Set(Array.isArray(b.statuses) && b.statuses.length ? b.statuses : ['done']);
  const ids = listTasks(ctx).filter((t) => want.has(t.status)).map((t) => t.id);
  for (const id of ids) archiveTask(ctx, id);
  send(res, 200, { ok: true, archived: ids });
});

on('PUT', /^\/api\/task\/([^/]+)$/, async (req, res, m, url) => {
  const [id] = m; const ctx = getCtx(url);
  if (!ID_RE.test(id)) return send(res, 400, { error: 'ID không hợp lệ' });
  const b = await readBody(req);
  if (typeof b.text !== 'string') return send(res, 400, { error: 'Thiếu nội dung' });
  if (!fs.existsSync(taskPath(ctx, id))) return send(res, 404, { error: 'Không có task' });
  fs.writeFileSync(taskPath(ctx, id), b.text);
  send(res, 200, { ok: true });
});

const chat = require('./chat')({ on, send, readBody, getCtx, loadProjects, withCtx, run });
const validAgent = (a) => !!specOf(a) && { name: a.name || '', agent: a.agent, model: a.model || '', effort: a.effort || '' };

const assign = async (ctx, id, w) => {
  // ASSIGN_BY=human: bạn giao từ dashboard, không cần đúng cấp trên trong .agents/hierarchy.txt
  if (!chat.isActive(ctx)) return run(path.join(SCRIPTS, 'assign.sh'), [id, w], { env: scriptEnv(ctx, { ASSIGN_BY: 'human' }) });
  // chế độ chat: đặt Owner + Status: ready, bộ tự giao việc của chat.js sẽ chạy worker
  const f = taskPath(ctx, id);
  if (!fs.existsSync(f)) return { ok: false, out: '', err: 'Không có task' };
  if (!chat.info(ctx).agents.some((a) => a.name === w && a.name !== 'lead')) return { ok: false, out: '', err: `Không có worker ${w}` };
  let text = fs.readFileSync(f, 'utf8').replace(/^Owner:.*$/m, `Owner: ${w}`).replace(/^Status:.*$/m, 'Status: ready');
  text = /^Assigned by:/m.test(text) ? text.replace(/^Assigned by:.*$/m, 'Assigned by: human') : text.replace(/^(Owner:.*)$/m, '$1\nAssigned by: human');
  fs.writeFileSync(f, text);
  return { ok: true, out: `Đã giao ${id} cho ${w}`, err: '' };
};

on('POST', /^\/api\/task$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  const b = await readBody(req);
  const id = createTask(ctx, b);
  let assigned = null;
  if (b.assign) { const r = await assign(ctx, id, b.owner); assigned = { ok: r.ok, out: (r.out + r.err).trim() }; }
  send(res, 200, { id, assigned });
});

on('POST', /^\/api\/assign$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  const b = await readBody(req);
  if (!ID_RE.test(b.id || '') || !WIN_RE.test(b.worker || '')) return send(res, 400, { error: 'Tham số không hợp lệ' });
  const r = await assign(ctx, b.id, b.worker);
  send(res, r.ok ? 200 : 500, { ok: r.ok, out: (r.out + r.err).trim() });
});

// --- tmux
on('GET', /^\/api\/pane\/([^/]+)$/, async (req, res, m, url) => {
  const [win] = m; const ctx = getCtx(url);
  if (!WIN_RE.test(win)) return send(res, 400, { error: 'Window không hợp lệ' });
  const r = await tmux('capture-pane', '-p', '-J', '-t', `${ctx.session}:${win}`, '-S', '-300');
  if (!r.ok) return send(res, 404, { error: r.err.trim() || 'Không đọc được window' });
  send(res, 200, { text: r.out.replace(/\s+$/, '') });
});

on('POST', /^\/api\/pane\/([^/]+)\/clear$/, async (req, res, m, url) => {
  const [win] = m; const ctx = getCtx(url);
  if (!WIN_RE.test(win)) return send(res, 400, { error: 'Window không hợp lệ' });
  const r = await tmux('clear-history', '-t', `${ctx.session}:${win}`);
  send(res, r.ok ? 200 : 500, { ok: r.ok, out: r.err.trim() });
});

on('POST', /^\/api\/send$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  const b = await readBody(req);
  if (!WIN_RE.test(b.win || '')) return send(res, 400, { error: 'Window không hợp lệ' });
  if (b.key) {
    if (!KEYS.has(b.key)) return send(res, 400, { error: 'Phím không được phép' });
    const r = await tmux('send-keys', '-t', `${ctx.session}:${b.win}`, b.key);
    return send(res, r.ok ? 200 : 500, { ok: r.ok, out: r.err.trim() });
  }
  const r = await sendText(ctx, b.win, String(b.text || ''), b.enter !== false);
  send(res, r.ok ? 200 : 500, { ok: r.ok, out: (r.err || '').trim() });
});

on('POST', /^\/api\/start$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  if (ctx.kind === 'office') return send(res, 400, { error: 'Project điều hành chỉ chạy ở kiểu Chat (không có git và bản sao riêng cho từng worker).' });
  const b = await readBody(req);
  const lead = specOf({ ...b.lead, name: '' }) || 'claude';
  const workers = (Array.isArray(b.workers) ? b.workers : []).map(specOf).filter(Boolean).join(' ') || 'codex';
  chat.stopAll(ctx);
  const r = await run(path.join(SCRIPTS, 'start-agents.sh'), [], { env: scriptEnv(ctx, { LEAD: lead, WORKERS: workers }), timeout: 60000 });
  send(res, r.ok ? 200 : 500, { ok: r.ok, out: (r.out + r.err).trim() });
});

on('POST', /^\/api\/stop$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  chat.stopAll(ctx);
  await tmux('kill-session', '-t', ctx.session);
  send(res, 200, { ok: true });
});

// Chế độ chat (agent chạy ẩn, dashboard hiện dạng tin nhắn). Xem dashboard/chat.js.
on('POST', /^\/api\/chatmode\/start$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  const b = await readBody(req);
  const lead = validAgent({ ...b.lead, name: '' }) || { agent: 'claude', model: '', effort: '' };
  const workers = (Array.isArray(b.workers) ? b.workers : []).map(validAgent).filter(Boolean);
  if (!workers.length) workers.push({ agent: 'codex', model: '', effort: '' });
  await tmux('kill-session', '-t', ctx.session); // không chạy song song hai kiểu
  try { const names = await chat.start(ctx, lead, workers); send(res, 200, { ok: true, agents: names }); }
  catch (e) { send(res, 400, { error: e.message }); }
});

// Đính kèm file: lưu vào .agents/uploads/ (worker thấy qua symlink .agents) rồi trả về đường dẫn.
on('POST', /^\/api\/upload$/, (req, res, _m, url) => new Promise((resolve) => {
  const ctx = getCtx(url);
  const base = path.basename(String(url.searchParams.get('name') || 'file')).replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
  const dir = path.join(ctx.root, '.agents', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(dir, `${stamp}-${Math.random().toString(36).slice(2, 6)}-${base}`);
  const out = fs.createWriteStream(file, { flags: 'wx' });
  let size = 0, done = false;
  const finish = (code, body) => { if (!done) { done = true; send(res, code, body); resolve(); } };
  req.on('data', (c) => {
    size += c.length;
    if (size > 20 * 1024 * 1024 && !done) { req.unpipe(out); out.destroy(); fs.rm(file, () => {}); finish(413, { error: 'File quá lớn (tối đa 20 MB)' }); }
  });
  req.pipe(out);
  out.on('finish', () => finish(200, { path: file }));
  out.on('error', (e) => finish(500, { error: e.message }));
}));

// Xem / tải file trong project để hiện ảnh và file trong chat. Chỉ file nằm trong project hoặc worktree của agent.
const IMG_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
on('GET', /^\/api\/file$/, (req, res, _m, url) => {
  const ctx = getCtx(url);
  const f = chat.resolveFile(ctx, url.searchParams.get('path'));
  if (!f) return send(res, 404, { error: 'Không mở được file này (không tồn tại hoặc nằm ngoài project).' });
  if (url.searchParams.get('text')) {
    const fd = fs.openSync(f.path, 'r');
    const buf = Buffer.alloc(Math.min(f.size, 300 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    if (buf.includes(0)) return send(res, 200, { ...f, binary: true });
    return send(res, 200, { ...f, text: buf.toString('utf8'), truncated: f.size > buf.length });
  }
  if (f.size > chat.MAX_FILE) return send(res, 413, { error: 'File quá lớn (tối đa 20 MB).' });
  const type = IMG_TYPES[path.extname(f.path).toLowerCase()];
  const inline = type && !url.searchParams.get('dl');
  res.writeHead(200, {
    'Content-Type': inline ? type : 'application/octet-stream', 'Content-Length': f.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    // không cho file (ví dụ SVG) chạy script trong trang dashboard
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  });
  fs.createReadStream(f.path).on('error', () => res.destroy()).pipe(res);
});

const server = http.createServer(async (req, res) => {
  try {
    if (!allowed(req)) return send(res, 403, { error: 'Bị chặn' });
    const url = new URL(req.url, 'http://x');
    for (const r of routes) {
      const m = req.method === r.method && url.pathname.match(r.re);
      if (m) return await r.fn(req, res, m.slice(1).map(decodeURIComponent), url);
    }
    send(res, 404, { error: 'Không tìm thấy' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Agent-Squad dashboard: http://localhost:${PORT}  (project mặc định: ${DEFAULT_ROOT})`);
  console.log('Ctrl-c để dừng.');
});
