#!/usr/bin/env node
// Agent-Squad dashboard: web UI chạy local để xem task, giao việc và điều khiển các window tmux.
// Không cần cài gói npm nào. Chạy:  node dashboard/server.js   rồi mở http://localhost:7070
// Biến môi trường: PORT (7070), HOST (127.0.0.1), SESSION (agents), WORKERS (codex),
// REPO (repo cần điều khiển, mặc định là repo chứa dashboard; repo đó phải đã chạy setup-agents.sh).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = path.resolve(process.env.REPO || path.join(__dirname, '..'));
const TASKS = path.join(ROOT, '.agents', 'tasks');
const PORT = Number(process.env.PORT || 7070);
const HOST = process.env.HOST || '127.0.0.1';
const SESSION = process.env.SESSION || 'agents';
const DEFAULT_WORKERS = process.env.WORKERS || 'codex';

const ID_RE = /^T-\d{1,6}$/;
const WIN_RE = /^[A-Za-z0-9_-]{1,32}$/;
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
    execFile(cmd, args, { cwd: ROOT, timeout: 20000, maxBuffer: 4 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(stdout), err: String(stderr || (err && err.message) || '') });
    });
  });
}
const tmux = (...args) => run('tmux', args);

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
function taskPath(id) { return path.join(TASKS, id + '.md'); }

function listTasks() {
  let files = [];
  try { files = fs.readdirSync(TASKS).filter((f) => /^T-\d+\.md$/.test(f)); } catch { /* chưa có thư mục */ }
  return files.map((f) => {
    const p = path.join(TASKS, f);
    const text = fs.readFileSync(p, 'utf8');
    const first = text.split(/\r?\n/)[0] || '';
    return {
      id: f.slice(0, -3),
      title: first.replace(/^#\s*T-\d+\s*:?\s*/, '').trim(),
      status: field(text, 'Status').toLowerCase() || 'todo',
      owner: field(text, 'Owner'),
      result: section(text, 'Result'),
      notes: section(text, 'Notes'),
      mtime: fs.statSync(p).mtimeMs,
    };
  }).sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)));
}

function nextId() {
  const nums = listTasks().map((t) => Number(t.id.slice(2)));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return 'T-' + String(n).padStart(3, '0');
}

function bullets(s) {
  const lines = String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines.map((l) => (l.startsWith('-') ? l : '- ' + l)).join('\n') : '- ';
}

function createTask(b) {
  const title = String(b.title || '').replace(/\r?\n/g, ' ').trim();
  if (!title) throw new Error('Thiếu tiêu đề');
  const owner = WIN_RE.test(b.owner || '') ? b.owner : 'codex';
  fs.mkdirSync(TASKS, { recursive: true });
  const id = nextId();
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
  fs.writeFileSync(taskPath(id), text, { flag: 'wx' });
  return id;
}

// ---------------------------------------------------------------- tmux
async function sessionInfo() {
  const has = await tmux('has-session', '-t', SESSION);
  if (!has.ok) return { running: false, windows: [] };
  const r = await tmux('list-windows', '-t', SESSION, '-F', '#{window_name}|#{window_active}|#{pane_current_command}');
  const windows = r.out.trim().split('\n').filter(Boolean).map((l) => {
    const [name, active, cmd] = l.split('|');
    return { name, active: active === '1', cmd };
  });
  return { running: true, windows };
}

async function sendText(win, text, enter) {
  const target = `${SESSION}:${win}`;
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

on('GET', /^\/api\/state$/, async (req, res) => {
  send(res, 200, { session: SESSION, defaultWorkers: DEFAULT_WORKERS, root: ROOT, ...(await sessionInfo()), tasks: listTasks() });
});

on('GET', /^\/api\/template$/, (req, res) => {
  let t = FALLBACK_TEMPLATE;
  try { t = fs.readFileSync(path.join(TASKS, '_template.md'), 'utf8'); } catch { /* dùng mẫu dự phòng */ }
  send(res, 200, { text: t });
});

on('GET', /^\/api\/task\/([^/]+)$/, (req, res, id) => {
  if (!ID_RE.test(id)) return send(res, 400, { error: 'ID không hợp lệ' });
  try { send(res, 200, { id, text: fs.readFileSync(taskPath(id), 'utf8') }); } catch { send(res, 404, { error: 'Không có task' }); }
});

on('PUT', /^\/api\/task\/([^/]+)$/, async (req, res, id) => {
  if (!ID_RE.test(id)) return send(res, 400, { error: 'ID không hợp lệ' });
  const b = await readBody(req);
  if (typeof b.text !== 'string') return send(res, 400, { error: 'Thiếu nội dung' });
  if (!fs.existsSync(taskPath(id))) return send(res, 404, { error: 'Không có task' });
  fs.writeFileSync(taskPath(id), b.text);
  send(res, 200, { ok: true });
});

on('POST', /^\/api\/task$/, async (req, res) => {
  const b = await readBody(req);
  const id = createTask(b);
  let assigned = null;
  if (b.assign) {
    const r = await run(path.join(ROOT, 'scripts', 'assign.sh'), [id, b.owner], { env: { ...process.env, SESSION } });
    assigned = { ok: r.ok, out: (r.out + r.err).trim() };
  }
  send(res, 200, { id, assigned });
});

on('POST', /^\/api\/assign$/, async (req, res) => {
  const b = await readBody(req);
  if (!ID_RE.test(b.id || '') || !WIN_RE.test(b.worker || '')) return send(res, 400, { error: 'Tham số không hợp lệ' });
  const r = await run(path.join(ROOT, 'scripts', 'assign.sh'), [b.id, b.worker], { env: { ...process.env, SESSION } });
  send(res, r.ok ? 200 : 500, { ok: r.ok, out: (r.out + r.err).trim() });
});

on('GET', /^\/api\/pane\/([^/]+)$/, async (req, res, win) => {
  if (!WIN_RE.test(win)) return send(res, 400, { error: 'Window không hợp lệ' });
  const r = await tmux('capture-pane', '-p', '-J', '-t', `${SESSION}:${win}`, '-S', '-300');
  if (!r.ok) return send(res, 404, { error: r.err.trim() || 'Không đọc được window' });
  send(res, 200, { text: r.out.replace(/\s+$/, '') });
});

on('POST', /^\/api\/send$/, async (req, res) => {
  const b = await readBody(req);
  if (!WIN_RE.test(b.win || '')) return send(res, 400, { error: 'Window không hợp lệ' });
  if (b.key) {
    if (!KEYS.has(b.key)) return send(res, 400, { error: 'Phím không được phép' });
    const r = await tmux('send-keys', '-t', `${SESSION}:${b.win}`, b.key);
    return send(res, r.ok ? 200 : 500, { ok: r.ok, out: r.err.trim() });
  }
  const r = await sendText(b.win, String(b.text || ''), b.enter !== false);
  send(res, r.ok ? 200 : 500, { ok: r.ok, out: (r.err || '').trim() });
});

on('POST', /^\/api\/start$/, async (req, res) => {
  const b = await readBody(req);
  const MODEL_RE = /^[A-Za-z0-9._:/-]{0,64}$/;
  let workers;
  if (Array.isArray(b.workers)) {
    workers = b.workers
      .filter((w) => w && WIN_RE.test(w.agent || '') && MODEL_RE.test(w.model || ''))
      .map((w) => (w.model ? `${w.agent}@${w.model}` : w.agent)).join(' ');
  } else {
    workers = String(b.workers || DEFAULT_WORKERS).split(/[\s,]+/).filter((w) => /^[A-Za-z0-9_-]+(@[A-Za-z0-9._:/-]+)?$/.test(w)).join(' ');
  }
  const leadModel = MODEL_RE.test(b.leadModel || '') ? (b.leadModel || '') : '';
  const env = { ...process.env, SESSION, WORKERS: workers || 'codex', LEAD_MODEL: leadModel };
  const r = await run(path.join(ROOT, 'scripts', 'start-agents.sh'), [], { env, timeout: 60000 });
  send(res, r.ok ? 200 : 500, { ok: r.ok, out: (r.out + r.err).trim() });
});

// Đính kèm file: lưu vào .agents/uploads/ (worker thấy qua symlink .agents) rồi trả về đường dẫn.
on('POST', /^\/api\/upload$/, (req, res) => new Promise((resolve) => {
  const url = new URL(req.url, 'http://x');
  const base = path.basename(String(url.searchParams.get('name') || 'file')).replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
  const dir = path.join(ROOT, '.agents', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(dir, `${stamp}-${base}`);
  const out = fs.createWriteStream(file, { flags: 'wx' });
  let size = 0, failed = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > 25 * 1024 * 1024 && !failed) { failed = true; req.unpipe(out); out.destroy(); fs.rm(file, () => {}); send(res, 413, { error: 'File quá lớn (tối đa 25 MB)' }); resolve(); }
  });
  req.pipe(out);
  out.on('finish', () => { if (!failed) { send(res, 200, { path: file }); resolve(); } });
  out.on('error', (e) => { if (!failed) { failed = true; send(res, 500, { error: e.message }); resolve(); } });
}));

on('POST', /^\/api\/stop$/, async (req, res) => {
  const r = await tmux('kill-session', '-t', SESSION);
  send(res, 200, { ok: r.ok, out: r.err.trim() });
});

const server = http.createServer(async (req, res) => {
  try {
    if (!allowed(req)) return send(res, 403, { error: 'Bị chặn' });
    const url = new URL(req.url, 'http://x');
    for (const r of routes) {
      const m = req.method === r.method && url.pathname.match(r.re);
      if (m) return await r.fn(req, res, ...m.slice(1).map(decodeURIComponent));
    }
    send(res, 404, { error: 'Không tìm thấy' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Agent-Squad dashboard: http://localhost:${PORT}  (session tmux: ${SESSION}, repo: ${ROOT})`);
  console.log('Ctrl-c để dừng.');
});
