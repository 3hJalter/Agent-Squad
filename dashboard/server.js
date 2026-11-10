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
const { execFile } = require('child_process');

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
const KEYS = new Set(['Enter', 'Escape', 'C-c', 'Up', 'Down', 'Tab', 'BTab', 'y', 'n']);

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

async function scaffoldState(root) {
  const missing = ['AGENTS.md', 'CLAUDE.md', 'scripts/assign.sh', '.agents/tasks/_template.md'].filter((f) => !fs.existsSync(path.join(root, f)));
  const st = await run('git', ['-C', root, 'status', '--porcelain', '--', 'AGENTS.md', 'CLAUDE.md', 'scripts', '.gitignore']);
  const head = await run('git', ['-C', root, 'rev-parse', 'HEAD']);
  return { missing, needsCommit: !head.ok || st.out.trim().length > 0 };
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
      result: section(text, 'Result'),
      mtime: fs.statSync(p).mtimeMs,
    };
  }).sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)));
}

function nextId(ctx) {
  const nums = listTasks(ctx).map((t) => Number(t.id.slice(2)));
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

const specOf = (a) => (a && AGENTS.has(a.agent) && MODEL_RE.test(a.model || '') && EFFORT_RE.test(a.effort || ''))
  ? a.agent + (a.model ? '@' + a.model : '') + (a.effort ? '#' + a.effort : '') : null;

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
    return { id: p.id, name: p.name, path: p.path, session: c.session, running: has.ok, exists: fs.existsSync(p.path) };
  }));
  send(res, 200, { projects: list });
});

on('POST', /^\/api\/projects$/, async (req, res) => {
  const b = await readBody(req);
  const dir = normPath(b.path);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 400, { error: `Không có thư mục ${dir}` });
  const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  if (!top.ok) return send(res, 400, { error: `${dir} chưa phải repo git. Chạy "git init" trong thư mục đó trước (hoặc git clone repo về).` });
  const root = top.out.trim();
  const list = loadProjects();
  let p = list.find((x) => x.path === root);
  if (!p) {
    const name = String(b.name || '').trim() || path.basename(root);
    let id = slug(name), n = 2;
    while (list.some((x) => x.id === id)) id = `${slug(name)}-${n++}`;
    p = { id, name, path: root };
    list.push(p); saveProjects(list);
  }
  let setup = null;
  const sc = await scaffoldState(root);
  if (sc.missing.length) {
    const r = await run('bash', [path.join(SCRIPTS, 'setup-agents.sh')], { cwd: root });
    setup = (r.out + r.err).trim();
  }
  send(res, 200, { project: p, setup, ...(await scaffoldState(root)) });
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
  const c = await run('git', ['-C', ctx.root, 'commit', '-m', 'Add agent scaffolding (Agent-Squad)', '--', ...files]);
  send(res, c.ok ? 200 : 500, { ok: c.ok, out: (c.out + c.err).trim() });
});

// --- state / tasks
on('GET', /^\/api\/state$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  let workersTxt = '';
  try { workersTxt = fs.readFileSync(path.join(ctx.root, '.agents', 'workers.txt'), 'utf8'); } catch { /* chưa start */ }
  send(res, 200, {
    project: { id: ctx.id, name: ctx.name, path: ctx.root }, session: ctx.session,
    ...(await sessionInfo(ctx)), tasks: listTasks(ctx), workersTxt, ...(await scaffoldState(ctx.root)),
  });
});

on('GET', /^\/api\/task\/([^/]+)$/, (req, res, m, url) => {
  const [id] = m; const ctx = getCtx(url);
  if (!ID_RE.test(id)) return send(res, 400, { error: 'ID không hợp lệ' });
  try { send(res, 200, { id, text: fs.readFileSync(taskPath(ctx, id), 'utf8') }); } catch { send(res, 404, { error: 'Không có task' }); }
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

const assign = (ctx, id, w) => run(path.join(SCRIPTS, 'assign.sh'), [id, w], { env: scriptEnv(ctx) });

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
  const b = await readBody(req);
  const lead = specOf(b.lead) || 'claude';
  const workers = (Array.isArray(b.workers) ? b.workers : []).map(specOf).filter(Boolean).join(' ') || 'codex';
  const r = await run(path.join(SCRIPTS, 'start-agents.sh'), [], { env: scriptEnv(ctx, { LEAD: lead, WORKERS: workers }), timeout: 60000 });
  send(res, r.ok ? 200 : 500, { ok: r.ok, out: (r.out + r.err).trim() });
});

on('POST', /^\/api\/stop$/, async (req, res, _m, url) => {
  const ctx = getCtx(url);
  const r = await tmux('kill-session', '-t', ctx.session);
  send(res, 200, { ok: r.ok, out: r.err.trim() });
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
    if (size > 25 * 1024 * 1024 && !done) { req.unpipe(out); out.destroy(); fs.rm(file, () => {}); finish(413, { error: 'File quá lớn (tối đa 25 MB)' }); }
  });
  req.pipe(out);
  out.on('finish', () => finish(200, { path: file }));
  out.on('error', (e) => finish(500, { error: e.message }));
}));

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
