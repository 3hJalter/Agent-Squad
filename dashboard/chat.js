// Chế độ "chat": chạy lead và worker ở chế độ không giao diện (headless) để dashboard hiện
// tin nhắn dạng chat thay vì màn hình terminal.
//
// QUYỀN: mặc định an toàn, người dùng cấp thêm từng quyền một ngay trong chat.
// - Agent chỉ được sửa file trong thư mục project (hoặc worktree của worker) và .agents/.
// - Lệnh shell: Claude/Gemini chỉ được chạy danh sách lệnh git/kiểm tra bên dưới;
//   Codex chạy trong sandbox workspace-write (không mạng).
// - Khi agent bị chặn, tin nhắn có nút "Cho phép": người dùng bấm thì quyền đó (loại lệnh bị chặn, ví dụ "npm install", công cụ,
//   hoặc quyền mạng cho Codex) được lưu cho agent đó và agent làm tiếp. Thu hồi được ở mục Nâng cao.
// - Không bao giờ tự bật chế độ bỏ qua mọi xác nhận.
//
// Lịch sử chat lưu ở <repo>/.agents/chat/<agent>.jsonl, trạng thái ở <repo>/.agents/chat/state.json.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_TURN_MS = 60 * 60 * 1000;
const KEEP = 300;

// Lệnh chạy ngay không cần hỏi: xem/tìm file, git cục bộ, lệnh kiểm tra. Lệnh khác cần bạn bấm "Cho phép".
const SAFE_CMDS = ['cd', 'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg', 'sort', 'diff', 'mkdir',
  'git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git merge', 'git branch', 'git checkout',
  'git switch', 'git restore', 'git rev-parse', 'git ls-files',
  'git worktree', 'git stash', 'git fetch', 'git pull', 'git cherry-pick', 'git rebase', 'git tag',
  'git reset', 'git rm', 'git mv', 'git remote', 'git config --get',
  'sed', 'awk', 'echo', 'printf', 'touch', 'cp', 'mv', 'jq', 'date', 'tr', 'cut', 'uniq', 'xargs', 'stat', 'test', 'true',
  'node', 'npm ls', 'npm run',
  'bash -n', 'shellcheck', 'npm test', 'npm run test', 'npm run lint', 'npm run build', 'pytest'];
// Luôn hỏi/chặn với Claude (kể cả khi lệnh khớp danh sách trên), trừ khi bạn đã bấm "Cho phép" đúng quyền đó.
const CLAUDE_DENY = ['Bash(git push:*)', 'Bash(rm -rf:*)', 'Bash(sudo:*)'];
const CLAUDE_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'LS', 'TodoWrite', ...SAFE_CMDS.map((c) => `Bash(${c}:*)`)];
const GEMINI_TOOLS = SAFE_CMDS.map((c) => `run_shell_command(${c})`);
// Khi bạn bấm "Cho phép", quyền được cấp theo loại lệnh ("npm install …") chứ không chỉ đúng một câu lệnh,
// để lần sau agent chạy lệnh cùng loại không bị chặn lại.
const TWO_WORD = new Set(['git', 'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'cargo', 'go', 'docker', 'gh']);
function prefixesOf(cmd) {
  const out = [];
  for (const part of String(cmd || '').split(/&&|\|\||;|\||\n/)) {
    const w = part.trim().split(/\s+/).filter(Boolean);
    // "git -C <dir> …" / "git -c k=v …" -> coi như "git …" để quyền và kiểm tra khớp theo lệnh con
    if (w[0] === 'git') while (w[1] === '-C' || w[1] === '-c') w.splice(1, 2);
    if (!w.length || !/^[A-Za-z0-9._/-]+$/.test(w[0])) continue;
    const pre = TWO_WORD.has(w[0]) && /^[a-z][a-z0-9-]*$/.test(w[1] || '') ? `${w[0]} ${w[1]}` : w[0];
    if (!SAFE_CMDS.includes(pre) && !SAFE_CMDS.includes(w[0]) && !out.includes(pre)) out.push(pre);
  }
  return out;
}

// Trả lời gọn: không kể lể từng bước, chỉ báo khi xong / bị chặn / cần hỏi.
const TERSE = ' REPORTING STYLE: do not narrate what you are about to do or are doing. Work silently, then send ONE final message of at most 4 short lines, ' +
  'only when you are finished (what changed + check result), blocked (what blocks you + what you need), or must ask a question (the question only). No preambles, no recaps of the task.';
const LEAD_ROLE = 'You are the LEAD of Agent-Squad, chatting with the human through a web dashboard (chat mode, no tmux). ' +
  'Follow the LEAD rules in CLAUDE.md and the shared rules in AGENTS.md. Workers are listed in .agents/workers.txt. ' +
  'To assign a task, set "Owner: <worker>" and "Status: ready" in the task file; the dashboard starts the worker and tells you when it is done. ' +
  'Do not run scripts/assign.sh or tmux. If a command or tool is blocked, say in one plain sentence what you need and why: ' +
  'the human sees an "Allow" button and you will be told when it is granted. ' +
  'Reply in the human\'s language, short and in plain words.' + TERSE;
// Xin tạo agent cấp dưới: agent viết file yêu cầu, người dùng bấm xác nhận trên dashboard.
const helperHint = (name, agentsDir) => ` HELPERS: if the work clearly needs a helper below you, create the file ${agentsDir}/requests/<helper-name>.md with these lines: ` +
  `"Name: <helper-name>" (letters, digits, - only), "Agent: claude|codex|gemini", "Model: <model>" (pick a cheaper/weaker model than your own; a helper is for simpler sub-tasks), ` +
  `"Effort: low|medium|high" (optional), "Parent: ${name}", "Reason: <one line>", "Status: pending". Then say so in one line and stop: the human must confirm. ` +
  `After approval you assign tasks to the helper by writing task files with "Created by: ${name}", "Owner: <helper-name>", "Status: ready".`;
const GRANT_RE = /^(network|[A-Za-z_][A-Za-z0-9_]{0,40}(\([^\n]{1,300}\))?)$/;
const workerRole = (name, agentsDir) => `You are a WORKER named "${name}" (chat mode, no tmux), not the lead: ignore the LEAD rules in CLAUDE.md ` +
  'and follow the worker rules in AGENTS.md.' + TERSE +
  (agentsDir ? ` Your worktree has no .agents folder: wherever the rules or messages say ".agents/", use ${agentsDir}/ instead.` +
    ' Your sandbox cannot write .git: never run git merge/commit/add/stash/checkout; the dashboard merges before each task and commits after each turn.' : '');
// Codex chặn mọi lệnh khi .agents trong worktree là symlink ("crosses a writable symlink"), nên worker
// Codex không có symlink .agents mà dùng đường dẫn tuyệt đối <repo>/.agents (đã cho quyền bằng --add-dir).
const noLink = (a) => a?.agent === 'codex';
// Sandbox của Codex không cho ghi vào .git (ORIG_HEAD.lock, index.lock...), nên với worker Codex dashboard tự làm phần git:
// merge nhánh chính vào worktree trước khi giao việc, và commit thay đổi sau mỗi lượt.
const gitByDashboard = (name, a) => name !== 'lead' && a?.agent === 'codex';

module.exports = function setupChat({ on, send, readBody, getCtx, loadProjects, withCtx, run }) {
  const live = new Map(); // key root|name -> { child, msg, queue: [] }
  const cache = new Map(); // key root|name -> messages[]

  const dir = (ctx) => path.join(ctx.root, '.agents', 'chat');
  const key = (ctx, name) => ctx.root + '|' + name;
  function loadState(ctx) {
    try { return JSON.parse(fs.readFileSync(path.join(dir(ctx), 'state.json'), 'utf8')); } catch { return { active: false, agents: {}, sessions: {} }; }
  }
  function saveState(ctx, st) {
    fs.mkdirSync(dir(ctx), { recursive: true });
    fs.writeFileSync(path.join(dir(ctx), 'state.json'), JSON.stringify(st, null, 2));
  }
  function messages(ctx, name) {
    const k = key(ctx, name);
    if (!cache.has(k)) {
      let list = [];
      try {
        list = fs.readFileSync(path.join(dir(ctx), name + '.jsonl'), 'utf8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { /* chưa có */ }
      cache.set(k, list.slice(-KEEP));
    }
    return cache.get(k);
  }
  function addMessage(ctx, name, m) {
    const list = messages(ctx, name);
    list.push(m);
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    fs.mkdirSync(dir(ctx), { recursive: true });
    fs.appendFileSync(path.join(dir(ctx), name + '.jsonl'), JSON.stringify(m) + '\n');
  }
  function rewrite(ctx, name) {
    fs.writeFileSync(path.join(dir(ctx), name + '.jsonl'), messages(ctx, name).map((m) => JSON.stringify(m) + '\n').join(''));
  }
  const newMsg = (role, text, extra = {}) => ({ id: crypto.randomUUID(), role, text, ts: Date.now(), ...extra });

  // ------------------------------------------------------------ lệnh chạy từng agent
  function buildCmd(ctx, name, a, session, prompt, grants = []) {
    const lead = name === 'lead';
    const tools = grants.filter((g) => g !== 'network');
    const extraDir = path.join(ctx.root, '.agents');
    if (a.agent === 'claude') {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
        '--allowedTools', ...CLAUDE_TOOLS, ...tools, '--add-dir', extraDir,
        '--append-system-prompt', (lead ? LEAD_ROLE : workerRole(name)) + helperHint(name, extraDir)];
      if (a.model) args.push('--model', a.model);
      if (a.effort) args.push('--effort', a.effort);
      if (session) args.push('--resume', session);
      const deny = CLAUDE_DENY.filter((d) => !tools.includes(d));
      if (deny.length) args.push('--disallowedTools', ...deny);
      return { cmd: 'claude', args, stdin: prompt };
    }
    const first = session ? prompt : (lead ? LEAD_ROLE : workerRole(name, noLink(a) && extraDir)) + helperHint(name, extraDir) + '\n\n' + prompt;
    if (a.agent === 'codex') {
      const args = ['exec', '--json', '-s', 'workspace-write', '--add-dir', extraDir];
      if (a.gitDir) args.push('--add-dir', a.gitDir);
      if (a.model) args.push('-m', a.model);
      if (a.effort) args.push('-c', `model_reasoning_effort="${a.effort}"`);
      if (grants.includes('network')) args.push('-c', 'sandbox_workspace_write.network_access=true');
      if (session) args.push('resume', session);
      args.push('--', first);
      return { cmd: 'codex', args };
    }
    const args = ['--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--include-directories', extraDir,
      '--allowed-tools', ...GEMINI_TOOLS, ...tools];
    if (a.model) args.push('-m', a.model);
    if (session) args.push('--resume', session);
    args.push('--prompt=' + first);
    return { cmd: 'gemini', args };
  }

  // ------------------------------------------------------------ đọc sự kiện JSON của agent
  const short = (s, n = 1500) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  function toolStep(name, input = {}) {
    const n = String(name || '');
    const file = input.file_path || input.path || input.absolute_path || '';
    if (/^(Bash|run_shell_command|shell)$/i.test(n)) return { icon: '▶', title: 'Chạy lệnh', detail: short(input.command, 400) };
    if (/^(Edit|MultiEdit|replace)$/i.test(n)) return { icon: '✏️', title: 'Sửa ' + file };
    if (/^(Write|write_file)$/i.test(n)) return { icon: '📝', title: 'Ghi ' + file };
    if (/^(Read|read_file|read_many_files)$/i.test(n)) return { icon: '📖', title: 'Đọc ' + (file || (input.paths || []).join(', ')) };
    if (/^(Grep|Glob|search_file_content|glob|LS|list_directory)$/i.test(n)) return { icon: '🔎', title: 'Tìm ' + (input.pattern || file || '') };
    if (/^TodoWrite$/i.test(n)) return { icon: '🗒', title: 'Lập danh sách việc', detail: short((input.todos || []).map((t) => `${t.status === 'completed' ? '✓' : '○'} ${t.content}`).join('\n')) };
    return { icon: '🔧', title: n, detail: short(JSON.stringify(input), 400) };
  }
  const firstWord = (cmd) => String(cmd || '').trim().split(/\s+/).slice(0, 2).join(' ');
  function makeParser(agent, msg, onSession) {
    const steps = msg.steps;
    const byId = new Map();
    // lời agent nói giữa chừng (trước khi chạy công cụ) chuyển vào danh sách bước; tin nhắn chỉ giữ câu trả lời cuối
    const stash = () => {
      const t = msg.text.trim();
      if (!t) return;
      const line = t.split('\n')[0];
      steps.push({ icon: '💬', title: short(line, 160), ...(t.length > line.length ? { detail: short(t, 1200) } : {}) });
      msg.text = '';
    };
    const want = (g, label) => {
      if (!GRANT_RE.test(g)) return;
      msg.grants = msg.grants || [];
      if (!msg.grants.some((x) => x.id === g)) msg.grants.push({ id: g, label });
    };
    return (ev) => {
      if (agent === 'claude') {
        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) onSession(ev.session_id);
        if (ev.type === 'assistant') for (const c of ev.message?.content || []) {
          if (c.type === 'text' && c.text.trim()) msg.text += (msg.text ? '\n\n' : '') + c.text.trim();
          if (c.type === 'tool_use') { stash(); const s = toolStep(c.name, c.input); byId.set(c.id, s); steps.push(s); }
        }
        if (ev.type === 'user') for (const c of ev.message?.content || []) {
          const s = c.type === 'tool_result' && byId.get(c.tool_use_id);
          if (!s) continue;
          const out = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : c.content;
          if (c.is_error) { s.error = true; s.detail = short([s.detail, out].filter(Boolean).join('\n')); }
        }
        if (ev.type === 'result') {
          if (ev.is_error && ev.result) msg.error = short(ev.result, 600);
          if (!msg.text && ev.result && !ev.is_error) msg.text = ev.result;
          for (const d of ev.permission_denials || []) {
            const s0 = byId.get(d.tool_use_id);
            if (s0) Object.assign(s0, { icon: '⛔', error: true, denied: true, detail: toolStep(d.tool_name, d.tool_input).detail });
            else steps.push({ ...toolStep(d.tool_name, d.tool_input), icon: '⛔', error: true, denied: true });
            const cmd = d.tool_input?.command;
            if (d.tool_name === 'Bash' && cmd) {
              const pre = prefixesOf(cmd);
              if (pre.length) for (const x of pre) want(`Bash(${x}:*)`, `chạy các lệnh "${x} …" (lần này: ${short(cmd, 120)})`);
              else want('Bash(' + String(cmd).replace(/[()\n]/g, ' ').trim().slice(0, 280) + ')', `chạy lệnh: ${short(cmd, 200)}`);
            }
            else if (d.tool_name) want(d.tool_name, `dùng công cụ ${d.tool_name}` + (d.tool_input?.file_path ? ` (${d.tool_input.file_path})` : d.tool_input?.url ? ` (${d.tool_input.url})` : ''));
          }
        }
      } else if (agent === 'codex') {
        if (ev.type === 'thread.started' && ev.thread_id) onSession(ev.thread_id);
        const it = ev.item;
        if (it && (ev.type === 'item.started' || ev.type === 'item.completed' || ev.type === 'item.updated')) {
          let s = byId.get(it.id);
          if (it.type === 'agent_message' && ev.type === 'item.completed' && it.text) msg.text += (msg.text ? '\n\n' : '') + it.text.trim();
          if (it.type === 'command_execution') {
            if (!s) { stash(); s = { icon: '▶', title: 'Chạy lệnh', detail: short(it.command, 400) }; byId.set(it.id, s); steps.push(s); }
            if (ev.type === 'item.completed' && it.exit_code) {
              s.error = true; s.detail = short(`${it.command}\n${it.aggregated_output || ''}`);
              if (/network|resolve host|could not resolve|connection (refused|reset)|timed out|ENOTFOUND|EAI_AGAIN|sandbox|operation not permitted/i.test(it.aggregated_output || '')) {
                s.denied = true; s.icon = '⛔'; want('network', 'cho lệnh shell truy cập mạng (cài thư viện, tải dữ liệu, git push…)');
              }
            }
          }
          if (it.type === 'file_change' && !s) {
            stash();
            s = { icon: '✏️', title: 'Sửa ' + (it.changes || []).map((c) => c.path).join(', ') }; byId.set(it.id, s); steps.push(s);
          }
          if (it.type === 'error' && it.message) msg.error = short(it.message, 600);
        }
        if (ev.type === 'turn.failed') msg.error = short(ev.error?.message || 'Lỗi', 600);
        if (ev.type === 'error' && ev.message) msg.error = short(ev.message, 600);
      } else {
        if (ev.type === 'init' && ev.session_id) onSession(ev.session_id);
        if (ev.type === 'message' && ev.role === 'assistant' && ev.content) msg.text += ev.content;
        if (ev.type === 'tool_use') {
          const s = toolStep(ev.tool_name, ev.parameters);
          Object.defineProperty(s, 'tool', { value: ev.tool_name, enumerable: false });
          if (ev.tool_name === 'run_shell_command') Object.defineProperty(s, 'cmd', { value: ev.parameters?.command, enumerable: false });
          stash(); byId.set(ev.tool_id, s); steps.push(s);
        }
        if (ev.type === 'tool_result') {
          const s = byId.get(ev.tool_id);
          if (s && ev.status === 'error') {
            const err = ev.error?.message || ev.output || '';
            s.error = true; s.detail = short([s.detail, err].filter(Boolean).join('\n'));
            if (/not allowed|permission|approv|denied|disallow|confirm/i.test(err)) {
              s.denied = true; s.icon = '⛔';
              const pre = s.cmd ? (prefixesOf(s.cmd).length ? prefixesOf(s.cmd) : [firstWord(s.cmd)]) : [];
              if (pre.length) for (const x of pre) want(`run_shell_command(${x})`, `chạy các lệnh "${x} …"`);
              else if (s.tool) want(s.tool, `dùng công cụ ${s.tool}`);
            }
          }
        }
        if (ev.type === 'error') msg.error = short(ev.message || JSON.stringify(ev), 600);
      }
    };
  }

  // Dừng ngay: SIGTERM cả nhóm tiến trình, sau 2 giây còn sống thì SIGKILL
  function kill(L) {
    const c = L.child;
    if (!c || c.exitCode !== null) return;
    L.stopped = true;
    const sig = (s) => { try { process.kill(-c.pid, s); } catch { try { c.kill(s); } catch { /* đã thoát */ } } };
    sig('SIGTERM');
    setTimeout(() => { if (c.exitCode === null && c.signalCode === null) sig('SIGKILL'); }, 2000);
  }

  // ------------------------------------------------------------ chạy một lượt
  function enqueue(ctx, name, text, display, extra = {}) {
    const k = key(ctx, name);
    if (!live.has(k)) live.set(k, { child: null, msg: null, queue: [] });
    const L = live.get(k);
    L.queue.push({ text, display, ...extra });
    if (!L.child && !L.committing) next(ctx, name);
  }
  function next(ctx, name) {
    const L = live.get(key(ctx, name));
    const job = L.queue.shift();
    if (!job) return;
    const st = loadState(ctx);
    const a = st.agents[name];
    if (!a) { addMessage(ctx, name, newMsg('system', 'Agent này không còn trong cấu hình.')); return; }
    if (job.display !== null) addMessage(ctx, name, newMsg(job.display?.role || 'you', job.display?.text ?? job.text));
    const { cmd, args, stdin } = buildCmd(ctx, name, a, st.sessions[name], job.text, (st.grants || {})[name] || []);
    const msg = newMsg('agent', '', { steps: [], running: true, agent: a.agent });
    L.msg = msg;
    const parse = makeParser(a.agent, msg, (sid) => { const s2 = loadState(ctx); s2.sessions[name] = sid; saveState(ctx, s2); });
    let child;
    try {
      // detached: agent và mọi lệnh con của nó cùng một nhóm tiến trình, để nút Dừng tắt được hết
      child = spawn(cmd, args, { cwd: a.cwd, env: process.env, detached: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (e) { msg.error = e.message; return finish(); }
    L.child = child;
    if (stdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
    let buf = '', errTail = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try { parse(JSON.parse(line)); } catch { /* dòng không phải JSON */ }
      }
    });
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
    const timer = setTimeout(() => kill(L), MAX_TURN_MS);
    child.on('error', (e) => { msg.error = e.code === 'ENOENT' ? `Không tìm thấy lệnh "${cmd}". Agent này đã được cài trong WSL chưa?` : e.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (buf.trim().startsWith('{')) { try { parse(JSON.parse(buf.trim())); } catch { /* bỏ */ } }
      if (L.stopped) msg.note = 'Bạn đã dừng lượt này.';
      else if (code && !msg.error) msg.error = short(errTail.trim() || `Agent thoát với mã ${code}${signal ? ' (' + signal + ')' : ''}`, 800);
      finish();
    });
    async function finish() {
      delete msg.running; L.child = null; L.msg = null; L.stopped = false;
      if (!msg.text && !msg.error && !msg.steps.length) msg.text = '(không có trả lời)';
      addMessage(ctx, name, msg);
      if (gitByDashboard(name, a)) {
        L.committing = true;
        try {
          const c = await autoCommit(a.cwd, `${job.taskId || 'work'}: changes by ${name}`);
          if (c) addMessage(ctx, name, newMsg('system', c));
        } catch (e) { addMessage(ctx, name, newMsg('system', 'Không commit được: ' + e.message)); }
        L.committing = false;
      }
      setImmediate(() => next(ctx, name));
    }
  }

  // commit mọi thay đổi trong worktree (trừ .agents); trả về câu báo hoặc '' nếu không có gì
  async function autoCommit(cwd, message) {
    const st = await run('git', ['-C', cwd, 'status', '--porcelain', '--', '.', ':(exclude).agents']);
    if (!st.ok || !st.out.trim()) return '';
    const id = await run('git', ['-C', cwd, 'config', 'user.email']);
    const who = id.out.trim() ? [] : ['-c', 'user.name=Agent-Squad', '-c', 'user.email=agent-squad@localhost'];
    await run('git', ['-C', cwd, 'add', '-A', '--', '.', ':(exclude).agents']);
    const c = await run('git', ['-C', cwd, ...who, 'commit', '-m', message]);
    if (!c.ok) throw new Error((c.out + c.err).trim().slice(0, 400));
    return `💾 Dashboard đã commit thay đổi của lượt này (${st.out.trim().split('\n').length} file).`;
  }

  // ------------------------------------------------------------ khởi động / dừng
  const winName = (a) => { const m = (a.model || '').replace(/[^A-Za-z0-9_-]/g, '-'); return !m ? a.agent : m.startsWith(a.agent) ? m : `${a.agent}-${m}`; };

  // tạo worktree + nhánh agent/<name> cho một worker và ghi vào st.agents; trả về dòng cho workers.txt
  async function addWorker(ctx, st, name, w, gitDir) {
    const wt = path.resolve(ctx.root, '..', `${path.basename(ctx.root)}-${name}`);
    if (!fs.existsSync(wt)) {
      let r = await run('git', ['-C', ctx.root, 'worktree', 'add', wt, '-b', `agent/${name}`]);
      if (!r.ok) r = await run('git', ['-C', ctx.root, 'worktree', 'add', wt, `agent/${name}`]);
      if (!r.ok) throw new Error(`Không tạo được worktree cho ${name}: ${r.err.trim()}`);
    }
    const link = path.join(wt, '.agents');
    let isRealDir = false;
    try { isRealDir = fs.lstatSync(link).isDirectory(); } catch { /* chưa có */ }
    if (!isRealDir) {
      fs.rmSync(link, { force: true });
      if (!noLink(w)) fs.symlinkSync(path.join(ctx.root, '.agents'), link);
    }
    st.agents[name] = { agent: w.agent, model: w.model || '', effort: w.effort || '', ...(w.helper ? { helper: true } : {}), cwd: wt, gitDir };
    return `${name}  (${w.agent}${w.model ? ', model ' + w.model : ''}${w.effort ? ', effort ' + w.effort : ''})`;
  }

  // ------------------------------------------------------------ agent xin tạo agent cấp dưới
  const reqDir = (ctx) => path.join(ctx.root, '.agents', 'requests');
  function listRequests(ctx) {
    let files = [];
    try { files = fs.readdirSync(reqDir(ctx)).filter((f) => /^[A-Za-z0-9_-]{1,30}\.md$/.test(f)); } catch { return []; }
    const st = loadState(ctx);
    const out = [];
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(path.join(reqDir(ctx), f), 'utf8'); } catch { continue; }
      if (field(text, 'Status').toLowerCase() !== 'pending') continue;
      const r = { id: f.slice(0, -3), name: field(text, 'Name') || f.slice(0, -3), agent: field(text, 'Agent').toLowerCase(), model: field(text, 'Model'),
        effort: field(text, 'Effort').toLowerCase(), parent: field(text, 'Parent') || 'lead', reason: field(text, 'Reason').slice(0, 300) };
      const p = st.agents?.[r.parent];
      r.parentInfo = p ? `${p.agent}${p.model ? ' ' + p.model : ''}` : '';
      r.problem = !/^[A-Za-z0-9_-]{1,30}$/.test(r.name) || r.name === 'lead' || r.name === 'watch' ? 'tên không hợp lệ'
        : st.agents?.[r.name] ? 'đã có agent tên này'
          : !['claude', 'codex', 'gemini'].includes(r.agent) ? 'agent phải là claude, codex hoặc gemini'
            : !/^[A-Za-z0-9._:/-]{0,64}$/.test(r.model) || !/^[a-z]{0,12}$/.test(r.effort) ? 'model hoặc effort không hợp lệ'
              : !p ? `không có agent cấp trên "${r.parent}"` : '';
      out.push(r);
    }
    return out;
  }
  function setRequestStatus(ctx, id, status) {
    const f = path.join(reqDir(ctx), id + '.md');
    const text = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, /^Status:/m.test(text) ? text.replace(/^Status:.*$/m, 'Status: ' + status) : text + '\nStatus: ' + status + '\n');
  }
  on('POST', /^\/api\/requests\/([^/]+)\/(approve|deny)$/, async (req, res, m, url) => {
    const [id, what] = m; const ctx = getCtx(url);
    const r = listRequests(ctx).find((x) => x.id === id);
    if (!r) return send(res, 404, { error: 'Không còn yêu cầu này' });
    const st = loadState(ctx);
    const tell = (text, show) => { if (st.agents[r.parent]) enqueue(ctx, r.parent, text, { role: 'system', text: show }); };
    if (what === 'deny') {
      setRequestStatus(ctx, id, 'denied');
      tell(`The human DENIED your request for helper "${r.name}". Continue without it, or explain in one line why it is really needed.`, `🚫 Bạn đã từ chối tạo agent "${r.name}".`);
      return send(res, 200, { ok: true });
    }
    if (r.problem) return send(res, 400, { error: 'Yêu cầu không hợp lệ: ' + r.problem });
    if (!st.active) return send(res, 400, { error: 'Chưa Start agents ở chế độ chat.' });
    const common = await run('git', ['-C', ctx.root, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    let line;
    try { line = await addWorker(ctx, st, r.name, { agent: r.agent, model: r.model, effort: r.effort, helper: true }, common.ok ? common.out.trim() : path.join(ctx.root, '.git')); }
    catch (e) { return send(res, 500, { error: e.message }); }
    saveState(ctx, st);
    fs.appendFileSync(path.join(ctx.root, '.agents', 'workers.txt'), line + '\n');
    const hf = path.join(ctx.root, '.agents', 'hierarchy.txt');
    let h = '';
    try { h = fs.readFileSync(hf, 'utf8'); } catch { /* chưa có */ }
    h = h.split(/\r?\n/).filter((l) => !new RegExp('^\\s*' + r.name + '\\s*<-').test(l)).join('\n').replace(/\n*$/, '\n');
    fs.writeFileSync(hf, (h.trim() ? h : '') + `${r.name} <- ${r.parent}\n`);
    setRequestStatus(ctx, id, 'approved');
    tell(`The human APPROVED helper "${r.name}" (${r.agent}${r.model ? ' ' + r.model : ''}). It is now your direct report: assign it tasks by writing task files with "Created by: ${r.parent}", "Owner: ${r.name}", "Status: ready". Keep its tasks small and simple. Continue your work.`,
      `✅ Bạn đã cho phép tạo agent "${r.name}" (${r.agent}${r.model ? ', ' + r.model : ''}) dưới quyền ${r.parent}.`);
    send(res, 200, { ok: true });
  });

  async function start(ctx, lead, workers) {
    const head = await run('git', ['-C', ctx.root, 'rev-parse', 'HEAD']);
    if (!head.ok) throw new Error('Repo chưa có commit nào. Hãy commit trước (nút ở thanh cảnh báo).');
    const common = await run('git', ['-C', ctx.root, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const gitDir = common.ok ? common.out.trim() : path.join(ctx.root, '.git');
    const st = loadState(ctx);
    const old = st.agents || {};
    st.agents = { lead: { ...lead, cwd: ctx.root } };
    const lines = [];
    const repoName = path.basename(ctx.root);
    for (const w of workers) {
      const name = w.name || winName(w);
      if (st.agents[name] || name === 'lead') continue;
      lines.push(await addWorker(ctx, st, name, w, gitDir));
    }
    // agent cấp dưới đã được duyệt trước đó (có dòng trong hierarchy.txt) thì giữ lại
    for (const [n, o] of Object.entries(old)) {
      if (!o.helper || st.agents[n] || !st.agents[parentOf(ctx, n)]) continue;
      lines.push(await addWorker(ctx, st, n, o, gitDir));
    }
    // đổi agent/model thì bắt đầu cuộc trò chuyện mới cho agent đó
    for (const n of Object.keys(st.sessions || {})) {
      const o = old[n], a = st.agents[n];
      if (!a || !o || o.agent !== a.agent || o.model !== a.model) delete st.sessions[n];
    }
    st.sessions = st.sessions || {};
    st.active = true;
    fs.mkdirSync(path.join(ctx.root, '.agents', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, '.agents', 'workers.txt'), lines.join('\n') + (lines.length ? '\n' : ''));
    saveState(ctx, st);
    seen.delete(ctx.root);
    return Object.keys(st.agents);
  }
  function stopAll(ctx) {
    const st = loadState(ctx);
    for (const n of Object.keys(st.agents || {})) {
      const L = live.get(key(ctx, n));
      if (L) { L.queue = []; if (L.child) { L.stopped = true; kill(L); } }
    }
    if (st.active) { st.active = false; saveState(ctx, st); }
  }
  function info(ctx) {
    const st = loadState(ctx);
    return {
      active: !!st.active,
      agents: Object.entries(st.agents || {}).map(([name, a]) => {
        const L = live.get(key(ctx, name));
        return { name, agent: a.agent, model: a.model || '', effort: a.effort || '', busy: !!L?.child, queued: L?.queue.length || 0, grants: (st.grants || {})[name] || [] };
      }),
    };
  }

  // ------------------------------------------------------------ tự giao task / báo lead
  const seen = new Map(); // root -> {id: status}
  function field(text, n) { const m = text.match(new RegExp('^' + n + ':[ \\t]*(.*)$', 'm')); return m ? m[1].trim() : ''; }
  function parentOf(ctx, name) {
    let text = '';
    try { text = fs.readFileSync(path.join(ctx.root, '.agents', 'hierarchy.txt'), 'utf8'); } catch { return 'lead'; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.replace(/#.*/, '').match(/^\s*(\S+)\s*<-\s*(\S+)\s*$/);
      if (m && m[1] === name) return m[2];
    }
    return 'lead';
  }
  async function dispatch() {
    for (const p of loadProjects()) {
      const ctx = withCtx(p);
      let st;
      try { st = loadState(ctx); } catch { continue; }
      if (!st.active) continue;
      const tdir = path.join(ctx.root, '.agents', 'tasks');
      let files = [];
      try { files = fs.readdirSync(tdir).filter((f) => /^T-\d+\.md$/.test(f)); } catch { continue; }
      const first = !seen.has(ctx.root);
      const last = seen.get(ctx.root) || {};
      for (const f of files) {
        const id = f.slice(0, -3), fp = path.join(tdir, f);
        let text;
        try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
        let status = field(text, 'Status').toLowerCase();
        const owner = field(text, 'Owner');
        const creator = field(text, 'Created by') || 'lead';
        if (status === 'ready' && st.agents[owner] && owner !== 'lead') {
          // phân cấp (.agents/hierarchy.txt, như scripts/assign.sh): chỉ cấp trên trực tiếp được giao việc;
          // việc bạn giao từ dashboard ("Assigned by: human") thì luôn được.
          const parent = parentOf(ctx, owner);
          if (field(text, 'Assigned by').toLowerCase() !== 'human' && parent !== creator) {
            const note = `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} Dashboard: không giao được, ${creator} không phải cấp trên trực tiếp của ${owner} (cấp trên: ${parent}) trong .agents/hierarchy.txt.`;
            let t2 = text.replace(/^Status:.*$/m, 'Status: blocked');
            t2 = /^## Notes/m.test(t2) ? t2.replace(/^(## Notes.*)$/m, `$1\n${note}`) : `${t2}\n## Notes / questions\n${note}\n`;
            fs.writeFileSync(fp, t2);
            last[id] = 'ready'; // để vòng sau báo người giao việc là task bị chặn
            continue;
          }
          const base = (await run('git', ['-C', ctx.root, 'branch', '--show-current'])).out.trim();
          const byDash = gitByDashboard(owner, st.agents[owner]);
          if (byDash && base) {
            const cwd = st.agents[owner].cwd;
            await autoCommit(cwd, `wip: changes by ${owner} before ${id}`).catch(() => {});
            const m = await run('git', ['-C', cwd, 'merge', '--no-edit', base]);
            if (!m.ok) {
              await run('git', ['-C', cwd, 'merge', '--abort']);
              const note = `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} Dashboard: không merge được ${base} vào agent/${owner} (xung đột). Cần lead xử lý: ${(m.out + m.err).trim().split('\n').slice(-2).join(' ')}`;
              let t2 = text.replace(/^Status:.*$/m, 'Status: blocked');
              t2 = /^## Notes/m.test(t2) ? t2.replace(/^(## Notes.*)$/m, `$1\n${note}`) : `${t2}\n## Notes / questions\n${note}\n`;
              fs.writeFileSync(fp, t2);
              last[id] = 'ready';
              continue;
            }
          }
          fs.writeFileSync(fp, text.replace(/^Status:.*$/m, 'Status: in-progress'));
          status = 'in-progress';
          const msg = byDash
            ? `Do task ${id}: the dashboard already merged ${base || 'the main branch'} into your branch and will commit your changes after your turn, ` +
              'so do NOT run git merge or git commit (your sandbox cannot write .git). Skip those steps of the task protocol, ' +
              `do everything else: read ${path.join(ctx.root, '.agents', 'tasks', id + '.md')} and AGENTS.md, follow the task protocol. Be terse.`
            : `Do task ${id}: ${base ? `first run 'git merge --no-edit ${base}' to get the latest code (on conflicts set Status: blocked and explain), then ` : ''}` +
            `read ${noLink(st.agents[owner]) ? path.join(ctx.root, '.agents', 'tasks', id + '.md') : `.agents/tasks/${id}.md`} and AGENTS.md, follow the task protocol exactly. Be terse.`;
          enqueue(ctx, owner, msg, { role: 'system', text: `📋 Nhận việc ${id}: ${(text.split('\n')[0] || '').replace(/^#\s*(T-\d+\s*:?\s*)?/, '')}` }, { taskId: id });
        } else if (!first && last[id] !== status && (status === 'done' || status === 'blocked')) {
          // worker còn đang chạy hoặc dashboard đang commit hộ: đợi vòng sau để lead merge được bản đầy đủ
          const Lo = live.get(key(ctx, owner));
          if (Lo && (Lo.child || Lo.committing)) continue;
          // báo người tạo task (dòng "Created by:", như scripts/notify.sh); không có agent đó thì báo lead
          const to = st.agents[creator] ? creator : 'lead';
          const file = noLink(st.agents[to]) ? path.join(ctx.root, '.agents', 'tasks', id + '.md') : `.agents/tasks/${id}.md`;
          if (st.agents[to]) {
            enqueue(ctx, to, `Worker updated ${id}. Read only its Status and Result in ${file}, then report ${to === 'lead' ? 'to me' : 'and continue your own task'} in 3 lines max.`,
              { role: 'system', text: `🔔 ${id} ${status === 'done' ? 'đã xong' : 'bị chặn'} (${owner}). ${to === 'lead' ? 'Lead' : to} đang đọc kết quả…` });
          }
        }
        last[id] = status;
      }
      seen.set(ctx.root, last);
    }
  }
  if (!process.env.SQUAD_SELFTEST) setInterval(() => dispatch().catch((e) => console.error('chat dispatch:', e.message)), 3000);

  // ------------------------------------------------------------ API
  on('GET', /^\/api\/chat\/([^/]+)$/, (req, res, m, url) => {
    const [name] = m; const ctx = getCtx(url);
    if (!NAME_RE.test(name)) return send(res, 400, { error: 'Tên không hợp lệ' });
    const L = live.get(key(ctx, name));
    const list = messages(ctx, name).slice(-150);
    send(res, 200, { messages: L?.msg ? [...list, L.msg] : list, busy: !!L?.child, queued: L?.queue.length || 0 });
  });
  on('POST', /^\/api\/chat\/([^/]+)\/send$/, async (req, res, m, url) => {
    const [name] = m; const ctx = getCtx(url);
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    if (!text) return send(res, 400, { error: 'Tin nhắn trống' });
    const st = loadState(ctx);
    if (!st.active) return send(res, 400, { error: 'Chưa Start agents ở chế độ chat.' });
    if (!st.agents[name]) return send(res, 404, { error: 'Không có agent này' });
    enqueue(ctx, name, text);
    send(res, 200, { ok: true });
  });
  on('POST', /^\/api\/chat\/([^/]+)\/stop$/, (req, res, m, url) => {
    const [name] = m; const ctx = getCtx(url);
    const L = live.get(key(ctx, name));
    if (L) { L.queue = []; if (L.child) { L.stopped = true; kill(L); } }
    send(res, 200, { ok: true });
  });
  on('POST', /^\/api\/chat\/([^/]+)\/reset$/, (req, res, m, url) => {
    const [name] = m; const ctx = getCtx(url);
    if (!NAME_RE.test(name)) return send(res, 400, { error: 'Tên không hợp lệ' });
    const L = live.get(key(ctx, name));
    if (L?.child) return send(res, 409, { error: 'Agent đang làm việc. Dừng lượt hiện tại trước.' });
    const st = loadState(ctx); delete (st.sessions || {})[name]; saveState(ctx, st);
    fs.rmSync(path.join(dir(ctx), name + '.jsonl'), { force: true });
    cache.delete(key(ctx, name));
    addMessage(ctx, name, newMsg('system', 'Đã bắt đầu cuộc trò chuyện mới.'));
    send(res, 200, { ok: true });
  });

  // Người dùng bấm "Cho phép" trên một tin nhắn: chỉ nhận các quyền mà chính tin nhắn đó xin.
  on('POST', /^\/api\/chat\/([^/]+)\/grant$/, async (req, res, m, url) => {
    const [name] = m; const ctx = getCtx(url);
    const b = await readBody(req);
    const msg = messages(ctx, name).find((x) => x.id === b.msgId);
    if (!msg || !msg.grants) return send(res, 404, { error: 'Không tìm thấy yêu cầu quyền' });
    const pick = msg.grants.filter((g) => !Array.isArray(b.ids) || b.ids.includes(g.id));
    if (!pick.length) return send(res, 400, { error: 'Không có quyền nào được chọn' });
    const st = loadState(ctx);
    st.grants = st.grants || {};
    st.grants[name] = [...new Set([...(st.grants[name] || []), ...pick.map((g) => g.id)])];
    saveState(ctx, st);
    msg.granted = true; rewrite(ctx, name);
    if (b.retry !== false) {
      enqueue(ctx, name, `The human granted the permission(s) you were missing: ${pick.map((g) => g.id).join(', ')}. Retry the blocked step(s) and continue the task.`,
        { role: 'system', text: '✅ Bạn đã cho phép: ' + pick.map((g) => g.label).join('; ') + '. Agent làm tiếp…' });
    }
    send(res, 200, { ok: true, grants: st.grants[name] });
  });
  on('POST', /^\/api\/chat\/([^/]+)\/revoke$/, (req, res, m, url) => {
    const [name] = m; const ctx = getCtx(url);
    const st = loadState(ctx);
    if (st.grants) delete st.grants[name];
    saveState(ctx, st);
    addMessage(ctx, name, newMsg('system', 'Đã thu hồi mọi quyền đã cấp thêm cho agent này.'));
    send(res, 200, { ok: true });
  });

  // trước khi dashboard khởi động lại: dừng các lượt đang chạy (lịch sử và trạng thái chat giữ nguyên)
  function killAll() {
    let n = 0;
    for (const L of live.values()) { L.queue = []; if (L.child) { L.stopped = true; kill(L); n++; } }
    return n;
  }
  const busyCount = () => [...live.values()].filter((L) => L.child).length;

  return { start, stopAll, info, listRequests, killAll, busyCount, isActive: (ctx) => !!loadState(ctx).active };
};
