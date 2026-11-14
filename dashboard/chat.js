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
const { spawn, spawnSync } = require('child_process');
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
const SH_WORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'time', '!', '{', '}', '(', ')']);
// Bỏ phần không phải lệnh: nội dung heredoc (<<'EOF' … EOF) và chuỗi trong nháy, để không hiểu nhầm nội dung file thành lệnh.
function bareShell(cmd) {
  return String(cmd || '')
    .replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1([^\n]*)\n(?:(?:[\s\S]*?\n)??[ \t]*\2[ \t]*(?=\n|$)|[\s\S]*$)/g, ' $3')
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '\u0001');
}
function prefixesOf(cmd) {
  const out = [];
  for (const part of bareShell(cmd).split(/&&|\|\||;|\||\n/)) {
    const w = part.trim().split(/\s+/).filter(Boolean);
    if (/^(for|case|select|function)$/.test(w[0] || '')) continue; // "for f in a b": không phải lệnh
    while (w.length && (SH_WORDS.has(w[0]) || /^[A-Za-z_]\w*=/.test(w[0]))) w.shift(); // từ khoá shell, "BIEN=giatri lệnh"
    if (!w.length || !/^[A-Za-z0-9._/-]+$/.test(w[0])) continue;
    // "git -c k=v commit" / "git -C <dir> commit" không khớp quyền "git commit" của Claude: xin đúng dạng lệnh đó
    if (w[0] === 'git' && (w[1] === '-C' || w[1] === '-c')) {
      let i = 1;
      while (w[i] === '-C' || w[i] === '-c') i += 2;
      const lit = w.slice(0, i + 1);
      if (w[i] && /^[a-z][a-z0-9-]*$/.test(w[i]) && lit.every((x) => /^[\w.@=:/+-]+$/.test(x)) && !out.includes(lit.join(' '))) out.push(lit.join(' '));
      continue;
    }
    const pre = TWO_WORD.has(w[0]) && /^[a-z][a-z0-9-]*$/.test(w[1] || '') ? `${w[0]} ${w[1]}` : w[0];
    if (!SAFE_CMDS.includes(pre) && !SAFE_CMDS.includes(w[0]) && !out.includes(pre)) out.push(pre);
  }
  return out;
}
// Tên dễ hiểu cho quyền hiện trên thẻ xin quyền (câu lệnh đầy đủ nằm trong phần chi tiết).
const CMD_NAMES = { python: 'chạy Python', python3: 'chạy Python', pip: 'cài thư viện Python', pip3: 'cài thư viện Python', dotnet: 'công cụ .NET', which: 'kiểm tra chương trình đã cài',
  curl: 'tải dữ liệu từ mạng', wget: 'tải dữ liệu từ mạng', rm: 'xoá file', chmod: 'đổi quyền file', 'git push': 'đẩy code lên máy chủ (git push)', 'git clone': 'tải kho code về (git clone)',
  'npm install': 'cài thư viện (npm install)', 'npm i': 'cài thư viện (npm install)', npx: 'chạy công cụ npm (npx)', make: 'chạy make', bash: 'chạy script bash', sh: 'chạy script shell' };
function cmdLabel(pre) {
  const m = /^git (?:-[cC] \S+ )+(\S+)$/.exec(pre);
  if (m) return CMD_NAMES['git ' + m[1]] || `git ${m[1]} kèm tuỳ chọn riêng`;
  return CMD_NAMES[pre] || `lệnh "${pre}"`;
}
// Mô tả một câu lệnh bằng lời cho người không rành kỹ thuật (câu lệnh thật vẫn nằm trong phần chi tiết của bước).
const CMD_SAY = [
  [/^(ls|find|cat|head|tail|wc|stat|pwd|test)$/, 'Xem file và thư mục'], [/^(grep|rg)$/, 'Tìm trong nội dung file'],
  [/^git (status|diff|log|show|branch|rev-parse|ls-files|remote)$/, 'Xem tình trạng git'], [/^git (add|commit)$/, 'Lưu thay đổi vào git (commit)'],
  [/^git push$/, 'Đẩy code lên máy chủ'], [/^git (pull|fetch|merge|rebase|cherry-pick)$/, 'Lấy và gộp code'], [/^git /, 'Thao tác git'],
  [/^(npm test|npm run|pytest|bash -n|shellcheck|dotnet)$/, 'Chạy kiểm tra'], [/^(python3?|node|bash|sh)$/, 'Chạy script'],
  [/^(npm install|npm i|pip3?|npx)$/, 'Cài thư viện'], [/^(mkdir|cp|mv|touch|rm)$/, 'Sắp xếp file'], [/^(sed|awk|jq|tr|cut|sort|uniq)$/, 'Xử lý nội dung file'],
  [/^(curl|wget)$/, 'Tải dữ liệu từ mạng'], [/^which$/, 'Kiểm tra chương trình đã cài'],
];
function sayCmd(cmd) {
  let best = '';
  for (const part of bareShell(cmd).split(/&&|\|\||;|\||\n/)) {
    const w = part.trim().split(/\s+/).filter(Boolean);
    while (w.length && (SH_WORDS.has(w[0]) || /^[A-Za-z_]\w*=/.test(w[0]))) w.shift();
    if (w[0] === 'git') while (w[1] === '-C' || w[1] === '-c') w.splice(1, 2);
    if (!w.length || w[0] === 'cd' || w[0] === 'echo' || w[0] === 'printf' || !/^[A-Za-z0-9._/-]+$/.test(w[0])) continue;
    const two = `${w[0]} ${w[1] || ''}`.trim();
    const hit = CMD_SAY.find(([re]) => re.test(two)) || CMD_SAY.find(([re]) => re.test(w[0]));
    const say = hit ? hit[1] : `Chạy lệnh ${w[0].split('/').pop()}`;
    if (!best || /^Xem /.test(best)) best = say; // ưu tiên việc "làm" hơn việc "xem"
    if (!/^Xem /.test(best)) break;
  }
  return best || 'Chạy lệnh';
}
const SHELL_NOTE = ' SHELL COMMANDS: commands are checked one by one against an allow-list, so keep them simple: plain commands joined with && only. ' +
  'No shell variables, no $(...), no heredocs, no `git -c` or `git -C` (use `cd <dir> && git ...`; the git author name and email are already set for you). ' +
  'To run a script, write it to a file with your file tool, then run the file. If a command is blocked, do not retry it in another shape: say what you need in one plain sentence.';

// Trả lời gọn: không kể lể từng bước, chỉ báo khi xong / bị chặn / cần hỏi.
const TERSE = ' REPORTING STYLE: do not narrate what you are about to do or are doing. Work silently, then send ONE final message of at most 4 short lines, ' +
  'only when you are finished (what changed + check result), blocked (what blocks you + what you need), or must ask a question (the question only). No preambles, no recaps of the task.';
const LEAD_ROLE = 'You are the LEAD of Agent-Squad, chatting with the human through a web dashboard (chat mode, no tmux). ' +
  'Follow the LEAD rules in CLAUDE.md and the shared rules in AGENTS.md. Workers are listed in .agents/workers.txt. ' +
  'To assign a task, set "Owner: <worker>" and "Status: ready" in the task file; the dashboard starts the worker and tells you when it is done. ' +
  'Do not run scripts/assign.sh or tmux. If a command or tool is blocked, say in one plain sentence what you need and why: ' +
  'the human sees an "Allow" button and you will be told when it is granted. ' +
  'Reply in the human\'s language, short and in plain words.' + TERSE;
const HUMAN_NOTE = ' Your chat replies are read by a human who may be non-technical: write them in the human\'s language (the language of their messages, or of the task file if they have not written to you), in plain words, without command lines unless asked.';
// Xin tạo agent cấp dưới: agent viết file yêu cầu, người dùng bấm xác nhận trên dashboard.
const helperHint = (name, agentsDir) => ` HELPERS: if the work clearly needs a helper below you, create the file ${agentsDir}/requests/<helper-name>.md with these lines: ` +
  `"Name: <helper-name>" (letters, digits, - only), "Agent: claude|codex|gemini", "Model: <model>" (pick a cheaper/weaker model than your own; a helper is for simpler sub-tasks), ` +
  `"Effort: low|medium|high" (optional), "Parent: ${name}", "Reason: <one line>", "Status: pending". Then say so in one line and stop: the human must confirm. ` +
  `After approval you assign tasks to the helper by writing task files with "Created by: ${name}", "Owner: <helper-name>", "Status: ready".`;
const WORKER_RE = /^[A-Za-z0-9_-]{1,30}$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{0,64}$/;
const EFFORT_RE = /^[a-z]{0,12}$/;
// Project điều hành: thư mục văn phòng không có git; mọi agent làm việc ngay trong đó và sửa tài nguyên bằng đường dẫn thật.
const OFFICE_NOTE = ' OFFICE PROJECT: your working folder is a plain office folder, not a git repo, and every agent works in it directly. ' +
  'There are no branches, worktrees or merges: skip the task-protocol steps about committing, merging or branches. Real work happens in the RESOURCES folders.';
const GIT_ROLE = ' YOU ARE THE GIT AGENT. Your only job is git on the resource folders listed above (status, diff, add, commit, pull, merge, push). Never edit file contents. ' +
  'Run commands as `cd <repo> && git <command>`. For a task: look at `git status` and `git diff --stat` first; stage only what the task names, or all changes if it names none ' +
  '(but ask before committing anything surprising such as large binaries or build output); commit with a clear message; pull only if asked (`git pull --no-rebase`) and never resolve conflicts yourself: ' +
  'on a conflict run `git merge --abort`, set the task Status: blocked and name the conflicting files. Push only when asked. Never force-push, never `git reset --hard`, never delete branches. ' +
  'Push needs the human to click Allow: if it is blocked, say so in one line.';
const UNITY_NOTE = ' UNITY: resources marked [Unity project] are Unity projects. Never touch Library/, Temp/, Obj/, Logs/, Build/, Builds/ or UserSettings/. ' +
  'Every asset has a .meta file: move or rename an asset together with its .meta, never delete a .meta alone, never invent GUIDs. ' +
  'Edit .unity and .prefab files only if the task says so, with minimal changes. You cannot run the Unity Editor: say what the human should test in Unity.';
// context-mode (https://github.com/mksglu/context-mode): MCP server giữ dữ liệu lớn ở ngoài ngữ cảnh. Thử nghiệm, chỉ cho agent Claude, bật theo project.
const CM_SERVER = 'context-mode';
const CM_MCP = JSON.stringify({ mcpServers: { [CM_SERVER]: { command: 'npx', args: ['-y', 'context-mode'] } } });
const CM_NOTE = ' CONTEXT-MODE: to keep your context small, when a command or file read would print a lot (many files, long logs, big JSON), do not dump it: ' +
  'use the MCP tools ctx_execute / ctx_execute_file / ctx_batch_execute (run a small script and print only the result) and ctx_search / ctx_index to look things up later. ' +
  'For small reads and for editing files use your normal tools.';
// Đổi tài khoản / model: agent ghi bộ nhớ ra file trước, rồi cuộc trò chuyện mới đọc lại file đó.
const MEMORY_SAVE = (file) => `Save your working memory so a fresh conversation can continue your work. Write the file ${file} (overwrite it) with at most 40 short lines in the human's language, with these sections: ` +
  '"## Đang làm" (current task and its status), "## Đã chốt" (decisions and conventions agreed with the human), "## File đã đụng tới" (paths), "## Bước tiếp theo", "## Lưu ý" (pitfalls and preferences the human stated). ' +
  'Facts only: if unsure write "chưa rõ". Do no other work. Then reply with exactly one line: "Đã lưu bộ nhớ."';
const READ_MEMORY = (file) => `NOTE: this is a fresh conversation (your account or model changed, or the previous conversation was closed to save tokens). Before anything else, read your memory notes in ${file} (written before the change) ` +
  'and treat them as what you already know about this project. If a note looks outdated, check the code or the task file. Do not reply about this note separately. Now continue with the request below.\n\n';
// Bộ nhớ chung của project: quyết định, quy ước, sở thích của người dùng. Mọi agent cùng đọc, cùng ghi thêm.
const MEM_MAX = 12000;
const MEMORY_NOTE = (file) => ` PROJECT MEMORY: ${file} holds the lasting decisions, conventions and preferences of the human, shared by all agents. ` +
  'When the human states a lasting decision, preference or convention, append ONE short line to it ("- YYYY-MM-DD <fact>", in the human\'s language). ' +
  'Never log progress, task details or things already in the code there. Keep it under 60 lines: merge or drop outdated lines instead of growing it.';
const PROJECT_MEMORY = (text) => 'PROJECT MEMORY (shared notes of this project; treat them as facts you already know, do not reply about them):\n' + text.trim() + '\n\n';
// Cuộc trò chuyện quá dài thì mỗi bước đều phải đọc lại toàn bộ: cho agent lưu bộ nhớ rồi mở cuộc trò chuyện mới.
const REFRESH_DEFAULT = 120000;
const RES_REMOVED = ' RESOURCES: the list of resource folders is now empty. Do not touch folders you were given before.';
const GRANT_RE = /^(network|[A-Za-z_][A-Za-z0-9_]{0,40}(\([^\n]{1,300}\))?)$/;
const workerRole = (name, agentsDir, noGit) => `You are a WORKER named "${name}" (chat mode, no tmux), not the lead: ignore the LEAD rules in CLAUDE.md ` +
  'and follow the worker rules in AGENTS.md.' + HUMAN_NOTE + TERSE +
  (agentsDir ? ` Your worktree has no .agents folder: wherever the rules or messages say ".agents/", use ${agentsDir}/ instead.` : '') +
  (noGit ? ' Your sandbox cannot write .git: never run git merge/commit/add/stash/checkout; the dashboard commits your changes after each turn.' : '');
// Project "chung một thư mục": mọi agent làm thẳng trong thư mục project, cùng một nhánh, không có worktree và không có bước gộp.
const SHARED_NOTE = ' SHARED FOLDER: every agent (lead and workers) works directly in the same project folder on the same git branch. There are no worktrees, ' +
  'no agent/<name> branches and no merge step: ignore the rules about merging agent branches. Other agents may be editing other files at the same time, ' +
  'so touch only the files your task names, never revert or reformat files you did not change, and commit only your own files (`git add <your paths>`, never `git add -A` or `git add .`).';
const usesWt = (ctx, a) => ctx.kind !== 'office' && !!a?.cwd && path.resolve(a.cwd) !== path.resolve(ctx.root);
// Codex chặn mọi lệnh khi .agents trong worktree là symlink ("crosses a writable symlink"), nên worker
// Codex không có symlink .agents mà dùng đường dẫn tuyệt đối <repo>/.agents (đã cho quyền bằng --add-dir).
const noLink = (a) => a?.agent === 'codex';
// Sandbox của Codex không cho ghi vào .git (ORIG_HEAD.lock, index.lock...), nên với worker Codex dashboard tự làm phần git:
// merge nhánh chính vào worktree trước khi giao việc, và commit thay đổi sau mỗi lượt.
const gitByDashboard = (ctx, name, a) => ctx.kind !== 'office' && name !== 'lead' && a?.agent === 'codex';

const undo = require('./undo');
module.exports = function setupChat({ on, send, readBody, getCtx, loadProjects, loadAccounts, withCtx, run }) {
  let noPartial = false; // bản Claude Code cũ không có --include-partial-messages: tắt chữ hiện dần
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

  // ------------------------------------------------------------ tài khoản (hồ sơ đăng nhập riêng cho từng agent) và bộ nhớ khi đổi
  // Claude đọc cấu hình/đăng nhập từ CLAUDE_CONFIG_DIR, Codex từ CODEX_HOME: mỗi hồ sơ là một thư mục riêng.
  function accountOf(a) {
    if (!a?.account || !['claude', 'codex'].includes(a.agent)) return null;
    return (loadAccounts() || []).find((x) => x.id === a.account && x.agent === a.agent) || null;
  }
  // Máy chưa đặt tên/email git thì đặt sẵn theo tên agent, để agent không phải gõ "git -c user.name=…" (dạng lệnh đó luôn bị chặn).
  function gitEnv(name, a) {
    try {
      const r = spawnSync('git', ['config', 'user.email'], { cwd: a.cwd, encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout.trim()) return {};
    } catch { /* không có git: bỏ qua */ }
    const email = `${name}@agent.local`;
    return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  }
  function accountEnv(a) {
    const acc = accountOf(a);
    if (!acc) return {};
    return a.agent === 'claude' ? { CLAUDE_CONFIG_DIR: acc.dir } : { CODEX_HOME: acc.dir };
  }
  const memoryFile = (ctx) => path.join(ctx.root, '.agents', 'memory.md');
  const readMemory = (ctx) => { try { return fs.readFileSync(memoryFile(ctx), 'utf8').slice(0, MEM_MAX); } catch { return ''; } };
  const refreshAt = (ctx) => (Number.isFinite(ctx.refreshAt) ? ctx.refreshAt : REFRESH_DEFAULT);
  const handoffFile = (ctx, name) => path.join(ctx.root, '.agents', 'handoff', name + '.md');
  // dự phòng khi agent không ghi được bộ nhớ (ví dụ tài khoản cũ hết hạn mức): lấy phần cuối lịch sử chat đã lưu
  function writeFallbackHandoff(ctx, name) {
    const lines = messages(ctx, name).filter((m) => (m.role === 'you' || m.role === 'agent') && m.text).slice(-14)
      .map((m) => `- ${m.role === 'you' ? 'Bạn' : 'Agent'}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 500)}`);
    fs.mkdirSync(path.dirname(handoffFile(ctx, name)), { recursive: true });
    fs.writeFileSync(handoffFile(ctx, name), `# Bộ nhớ của ${name} (tự lấy từ lịch sử chat, có thể thiếu hoặc không còn đúng)\n\n` + (lines.join('\n') || '(chưa có lịch sử)') + '\n');
  }
  // áp dụng đổi model / effort / tài khoản; model hoặc tài khoản đổi thì bắt đầu cuộc trò chuyện mới và nhớ để agent đọc lại bộ nhớ
  function planChange(st, name, ch) {
    const a = st.agents[name];
    const model = typeof ch.model === 'string' ? ch.model.trim() : (a.model || '');
    const effort = typeof ch.effort === 'string' ? ch.effort : (a.effort || '');
    const account = typeof ch.account === 'string' ? ch.account : (a.account || '');
    if (!MODEL_RE.test(model) || !EFFORT_RE.test(effort)) throw new Error('Model hoặc effort không hợp lệ');
    if (account) {
      if (!['claude', 'codex'].includes(a.agent)) throw new Error('Gemini chưa hỗ trợ đổi tài khoản trong dashboard.');
      const acc = (loadAccounts() || []).find((x) => x.id === account);
      if (!acc || acc.agent !== a.agent) throw new Error('Hồ sơ tài khoản này không dùng cho ' + a.agent + '.');
    }
    const fresh = model !== (a.model || '') || account !== (a.account || '');
    return { model, effort, account, fresh, changed: fresh || effort !== (a.effort || '') };
  }
  function applyChange(ctx, st, name, ch) {
    const a = st.agents[name];
    const { model, effort, account, fresh, changed } = planChange(st, name, ch);
    if (!changed) return false;
    a.model = model; a.effort = effort;
    if (account) a.account = account; else delete a.account;
    if (fresh) {
      if (st.sessions) delete st.sessions[name];
      st.handoffRead = st.handoffRead || {};
      if (fs.existsSync(handoffFile(ctx, name))) st.handoffRead[name] = true;
    }
    const accName = accountOf(a)?.name;
    addMessage(ctx, name, newMsg('system', `Đã đổi cấu hình: ${a.agent}${model ? ', model ' + model : ', model mặc định'}${effort ? ', effort ' + effort : ''}${a.account ? ', tài khoản ' + (accName || a.account) : ', tài khoản mặc định'}.` +
      (fresh ? ' Agent bắt đầu cuộc trò chuyện mới' + (st.handoffRead?.[name] ? ' và sẽ đọc lại bộ nhớ đã lưu trước.' : '.') : ' Áp dụng từ lượt tiếp theo.')));
    saveState(ctx, st); writeWorkers(ctx, st);
    return true;
  }

  // ------------------------------------------------------------ tài nguyên của project (folder/file dùng chung, sửa tại chỗ)
  function resourceInfo(ctx) {
    return (ctx.resources || []).map((r) => {
      const p = r.path;
      let st = null;
      try { st = fs.statSync(p); } catch { /* không còn */ }
      const isDir = !!st?.isDirectory();
      const isRepo = isDir && fs.existsSync(path.join(p, '.git'));
      const unity = isDir && fs.existsSync(path.join(p, 'Assets')) && fs.existsSync(path.join(p, 'ProjectSettings'));
      return { path: p, name: r.name || path.basename(p), exists: !!st, isDir, isRepo, unity, needsIgnore: unity && isRepo && !fs.existsSync(path.join(p, '.gitignore')) };
    });
  }
  // thư mục cho --add-dir (file thì lấy thư mục chứa nó)
  const resDirs = (ctx) => [...new Set(resourceInfo(ctx).filter((r) => r.exists).map((r) => (r.isDir ? r.path : path.dirname(r.path))))];
  function resourcesNote(ctx, name) {
    const rs = resourceInfo(ctx).filter((r) => r.exists);
    if (!rs.length) return '';
    const gitOwner = ctx.kind === 'office' ? 'git' : 'lead';
    const lines = rs.map((r) => `- ${r.path}${r.isDir ? '' : ' (single file)'}${r.unity ? ' [Unity project]' : ''}${r.isRepo ? ' [git repo]' : ''}`);
    return ' RESOURCES: these folders/files are shared work material outside your own folder. Read and edit them in place by absolute path. ' +
      'They have no branch and no merge step and other agents edit them too, so touch only the files your task names:\n' + lines.join('\n') + '\n' +
      (name === gitOwner
        ? 'GIT RULE: you are the only agent who runs git (commit, pull, merge, push) in these resources.'
        : `GIT RULE: never run git commit, checkout, switch, pull, merge, rebase, stash, reset or push inside these resources. When your edits are done, say which files you changed; ` +
          (gitOwner === 'git' ? 'the lead gives the agent named "git" a task to commit and push them.' : 'the lead commits and pushes them.')) +
      (name === 'lead' && gitOwner === 'git' ? ' To save work to git or push it, create a task with "Owner: git", "Created by: lead", "Status: ready" whose Goal names the repo path, the commit message, and whether to pull and push.' : '') +
      (rs.some((r) => r.unity) ? UNITY_NOTE : '');
  }
  const useCm = (ctx, a) => !!ctx.contextMode && a?.agent === 'claude';
  function sysPrompt(ctx, name, a, extraDir) {
    const office = ctx.kind === 'office';
    const base = name === 'lead' ? LEAD_ROLE : workerRole(name, usesWt(ctx, a) && noLink(a) && extraDir, gitByDashboard(ctx, name, a));
    return base + SHELL_NOTE + MEMORY_NOTE(memoryFile(ctx)) + (office ? OFFICE_NOTE : '') + (!office && !usesWt(ctx, a) && (name !== 'lead' || ctx.shared) ? SHARED_NOTE : '') + resourcesNote(ctx, name) + (office && name === 'git' ? GIT_ROLE : '') + (useCm(ctx, a) ? CM_NOTE : '') + helperHint(name, extraDir);
  }

  // ------------------------------------------------------------ lệnh chạy từng agent
  function buildCmd(ctx, name, a, session, prompt, grants = []) {
    const lead = name === 'lead';
    const tools = grants.filter((g) => g !== 'network');
    const extraDir = path.join(ctx.root, '.agents');
    if (a.agent === 'claude') {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', ...(noPartial ? [] : ['--include-partial-messages']), '--permission-mode', 'acceptEdits',
        '--allowedTools', ...CLAUDE_TOOLS, ...tools, ...(useCm(ctx, a) ? ['mcp__' + CM_SERVER] : []),
        ...(useCm(ctx, a) ? ['--mcp-config', CM_MCP] : []), '--add-dir', extraDir, ...resDirs(ctx),
        '--append-system-prompt', sysPrompt(ctx, name, a, extraDir)];
      if (a.model) args.push('--model', a.model);
      if (a.effort) args.push('--effort', a.effort);
      if (session) args.push('--resume', session);
      const deny = CLAUDE_DENY.filter((d) => !tools.includes(d));
      if (deny.length) args.push('--disallowedTools', ...deny);
      return { cmd: 'claude', args, stdin: prompt };
    }
    const first = session ? prompt : sysPrompt(ctx, name, a, extraDir) + '\n\n' + prompt;
    if (a.agent === 'codex') {
      const args = ['exec', '--json', '-s', 'workspace-write', '--add-dir', extraDir];
      if (a.gitDir) args.push('--add-dir', a.gitDir);
      for (const d of resDirs(ctx)) args.push('--add-dir', d);
      if (a.model) args.push('-m', a.model);
      if (a.effort) args.push('-c', `model_reasoning_effort="${a.effort}"`);
      if (grants.includes('network')) args.push('-c', 'sandbox_workspace_write.network_access=true');
      if (session) args.push('resume', session);
      args.push('--', first);
      return { cmd: 'codex', args };
    }
    const args = ['--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--include-directories', [extraDir, ...resDirs(ctx)].join(','),
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
    if (/^(Bash|run_shell_command|shell)$/i.test(n)) return { icon: '▶', title: sayCmd(input.command), detail: short(input.command, 400) };
    if (/^(Edit|MultiEdit|replace)$/i.test(n)) return { icon: '✏️', title: 'Sửa ' + file, file };
    if (/^(Write|write_file)$/i.test(n)) return { icon: '📝', title: 'Ghi ' + file, file };
    if (/^(Read|read_file|read_many_files)$/i.test(n)) return { icon: '📖', title: 'Đọc ' + (file || (input.paths || []).join(', ')) };
    if (/^(Grep|Glob|search_file_content|glob|LS|list_directory)$/i.test(n)) return { icon: '🔎', title: 'Tìm ' + (input.pattern || file || '') };
    if (/^TodoWrite$/i.test(n)) return { icon: '🗒', title: 'Lập danh sách việc', detail: short((input.todos || []).map((t) => `${t.status === 'completed' ? '✓' : '○'} ${t.content}`).join('\n')) };
    return { icon: '🔧', title: n, detail: short(JSON.stringify(input), 400) };
  }
  const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
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
    // số token của lượt này (cộng dồn nếu agent báo nhiều lần trong một lượt)
    const addUse = (u) => {
      if (!u.in && !u.out) return;
      const t = msg.usage || (msg.usage = { in: 0, out: 0, cached: 0 });
      t.in += u.in; t.out += u.out; t.cached += u.cached || 0;
      if (u.cost) t.cost = (t.cost || 0) + u.cost;
    };
    // Claude: mỗi lần gọi model đều kèm số token; giữ lại để lượt bị dừng giữa chừng (không có báo cáo cuối) vẫn tính được
    const partial = new Map();
    let final = false, raw = null, initModel = '';
    const want = (g, label, cmd) => {
      if (!GRANT_RE.test(g)) return;
      msg.grants = msg.grants || [];
      if (!msg.grants.some((x) => x.id === g)) msg.grants.push({ id: g, label, ...(cmd ? { cmd: short(cmd, 300) } : {}) });
    };
    const parse = (ev) => {
      if (agent === 'claude') {
        if (ev.type === 'assistant' && ev.message?.usage && ev.message.id) partial.set(ev.message.id, ev.message.usage);
        if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string') initModel = ev.model.slice(0, 64);
        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) onSession(ev.session_id);
        if (ev.type === 'system' && ev.subtype === 'init' && msg.cm) {
          const m = (ev.mcp_servers || []).find((x) => x.name === CM_SERVER);
          if (!m || m.status !== 'connected') steps.push({ icon: '⚠️', error: true, title: 'context-mode không chạy được (cần Node.js 22.5 trở lên, và có mạng ở lần chạy đầu để tải về). Agent vẫn làm việc bình thường, chỉ là không có context-mode.' });
        }
        // chữ hiện dần: phần đang viết nằm ở msg.draft, tới khi nhận được đoạn hoàn chỉnh thì bỏ
        if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
          const e = ev.event || {};
          if (e.type === 'message_start') msg.draft = '';
          if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') msg.draft = ((msg.draft || '') + e.delta.text).slice(-20000);
          return;
        }
        if (ev.type === 'assistant' && !ev.parent_tool_use_id) delete msg.draft;
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
          const u = ev.usage;
          // modelUsage chia theo model thực chạy và gồm cả agent phụ; không có thì dùng usage của lượt
          const models = {};
          for (const [m, v] of Object.entries(ev.modelUsage && typeof ev.modelUsage === 'object' ? ev.modelUsage : {})) {
            const r = { in: num(v.inputTokens) + num(v.cacheCreationInputTokens) + num(v.cacheReadInputTokens), out: num(v.outputTokens), cached: num(v.cacheReadInputTokens), cost: num(v.costUSD) };
            if (r.in || r.out) models[String(m).slice(0, 64)] = r;
          }
          const ms = Object.values(models);
          if (ms.length) {
            msg.usage = { in: ms.reduce((t, r) => t + r.in, 0), out: ms.reduce((t, r) => t + r.out, 0), cached: ms.reduce((t, r) => t + r.cached, 0), models };
            const cost = num(ev.total_cost_usd) || ms.reduce((t, r) => t + r.cost, 0);
            if (cost) msg.usage.cost = cost;
            final = true;
          } else if (u) {
            delete msg.usage;
            addUse({ in: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens), out: num(u.output_tokens), cached: num(u.cache_read_input_tokens), cost: num(ev.total_cost_usd) });
            final = !!msg.usage;
          }
          raw = { usage: u, modelUsage: ev.modelUsage, total_cost_usd: ev.total_cost_usd };
          if (ev.is_error && ev.result) msg.error = short(ev.result, 600);
          if (!msg.text && ev.result && !ev.is_error) msg.text = ev.result;
          let complex = false;
          for (const d of ev.permission_denials || []) {
            const s0 = byId.get(d.tool_use_id);
            if (s0) Object.assign(s0, { icon: '⛔', error: true, denied: true, detail: toolStep(d.tool_name, d.tool_input).detail });
            else steps.push({ ...toolStep(d.tool_name, d.tool_input), icon: '⛔', error: true, denied: true });
            const cmd = d.tool_input?.command;
            if (d.tool_name === 'Bash' && cmd) {
              const pre = prefixesOf(cmd);
              if (pre.length) for (const x of pre) want(`Bash(${x}:*)`, cmdLabel(x), cmd);
              else if (cmd.length <= 280 && !/[()\n]/.test(cmd)) want(`Bash(${cmd.trim()})`, 'chạy đúng một câu lệnh (xem chi tiết)', cmd);
              else complex = true;
            }
            else if (d.tool_name) want(d.tool_name, `dùng công cụ ${d.tool_name}` + (d.tool_input?.file_path ? ` (${d.tool_input.file_path})` : d.tool_input?.url ? ` (${d.tool_input.url})` : ''));
          }
          if (complex && !msg.grants?.length) msg.note = 'Agent dùng một lệnh ghép quá phức tạp nên bị chặn. Nhắn "làm lại bằng các lệnh đơn giản" để agent thử cách khác.';
        }
      } else if (agent === 'codex') {
        if (ev.type === 'thread.started' && ev.thread_id) onSession(ev.thread_id);
        const it = ev.item;
        if (it && (ev.type === 'item.started' || ev.type === 'item.completed' || ev.type === 'item.updated')) {
          let s = byId.get(it.id);
          if (it.type === 'agent_message' && ev.type === 'item.completed' && it.text) msg.text += (msg.text ? '\n\n' : '') + it.text.trim();
          if (it.type === 'command_execution') {
            if (!s) { stash(); s = { icon: '▶', title: sayCmd(it.command), detail: short(it.command, 400) }; byId.set(it.id, s); steps.push(s); }
            if (ev.type === 'item.completed' && it.exit_code) {
              s.error = true; s.detail = short(`${it.command}\n${it.aggregated_output || ''}`);
              if (/network|resolve host|could not resolve|connection (refused|reset)|timed out|ENOTFOUND|EAI_AGAIN|sandbox|operation not permitted/i.test(it.aggregated_output || '')) {
                s.denied = true; s.icon = '⛔'; want('network', 'cho lệnh shell truy cập mạng (cài thư viện, tải dữ liệu, git push…)');
              }
            }
          }
          if (it.type === 'file_change' && !s) {
            stash();
            s = { icon: '✏️', title: 'Sửa ' + (it.changes || []).map((c) => c.path).join(', '), files: (it.changes || []).map((c) => c.path).slice(0, 10) }; byId.set(it.id, s); steps.push(s);
          }
          if (it.type === 'error' && it.message) msg.error = short(it.message, 600);
        }
        if (ev.type === 'turn.completed' && ev.usage) { raw = { 'turn.completed': ev.usage }; addUse({ in: num(ev.usage.input_tokens), out: num(ev.usage.output_tokens), cached: num(ev.usage.cached_input_tokens) }); }
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
              if (pre.length) for (const x of pre) want(`run_shell_command(${x})`, cmdLabel(x), s.cmd);
              else if (s.tool) want(s.tool, `dùng công cụ ${s.tool}`);
            }
          }
        }
        if (ev.type === 'result' && (ev.stats || ev.usage)) {
          const u = ev.stats || ev.usage;
          raw = { result: u };
          addUse({ in: num(u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount), out: num(u.output_tokens ?? u.candidates_tokens ?? u.candidatesTokenCount), cached: num(u.cached ?? u.cached_tokens ?? u.cachedContentTokenCount) });
        }
        if (ev.type === 'error') msg.error = short(ev.message || JSON.stringify(ev), 600);
      }
    };
    // gọi khi tiến trình agent kết thúc: trả về số liệu gốc để đối chiếu; lượt Claude bị dừng thì cộng từ các lần gọi model đã xong
    // độ dài cuộc trò chuyện hiện tại ≈ số token đầu vào của lần gọi model gần nhất (chỉ Claude báo theo từng lần gọi)
    parse.ctxSize = () => {
      const u = [...partial.values()].pop();
      return u ? num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens) : 0;
    };
    parse.done = () => {
      if (agent === 'claude' && !final && partial.size) {
        const us = [...partial.values()];
        const t = { in: 0, out: 0, cached: 0, partial: true };
        for (const u of us) { t.in += num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens); t.out += num(u.output_tokens); t.cached += num(u.cache_read_input_tokens); }
        if (initModel) t.models = { [initModel]: { in: t.in, out: t.out, cached: t.cached, cost: 0 } };
        if (t.in || t.out) { msg.usage = t; raw = { partial_from_assistant_events: us.slice(-5), calls: us.length }; }
      }
      return raw;
    };
    return parse;
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
    // danh sách tài nguyên có thể vừa đổi từ lúc tin được xếp hàng: đọc lại project
    const fresh = loadProjects().find((p) => p.path === ctx.root);
    if (fresh) ctx = withCtx(fresh);
    const st = loadState(ctx);
    const a = st.agents[name];
    if (!a) { addMessage(ctx, name, newMsg('system', 'Agent này không còn trong cấu hình.')); return; }
    if (!st.sessions[name] && st.ctxSize?.[name]) { delete st.ctxSize[name]; saveState(ctx, st); }
    // Việc mới (bạn nhắn hoặc nhận task) mà cuộc trò chuyện đã quá dài: lưu bộ nhớ trước, rồi làm việc đó trong cuộc trò chuyện mới
    const size = (st.ctxSize || {})[name] || 0, limit = refreshAt(ctx);
    if (limit > 0 && size > limit && st.sessions[name] && !job.memorySave && !job.noRefresh && (job.taskId || job.display === undefined || job.display?.role === 'you')) {
      L.queue.unshift({ ...job, noRefresh: true });
      L.queue.unshift({ text: MEMORY_SAVE(handoffFile(ctx, name)), memorySave: true, refresh: true, startedAt: Date.now(),
        display: { role: 'system', text: `♻️ Cuộc trò chuyện đã dài (khoảng ${Math.round(size / 1000)}k token). Agent lưu bộ nhớ rồi bắt đầu cuộc trò chuyện mới để tiết kiệm token…` } });
      return next(ctx, name);
    }
    if (job.display !== null) addMessage(ctx, name, newMsg(job.display?.role || 'you', job.display?.text ?? job.text, job.display?.files?.length ? { files: job.display.files } : {}));
    // Claude nhận danh sách tài nguyên mới ở mỗi lượt (system prompt); Codex/Gemini chỉ nhận ở lượt đầu nên báo thêm khi danh sách đổi
    let text = job.text;
    const rn = resourcesNote(ctx, name);
    const sig = crypto.createHash('md5').update(rn).digest('hex').slice(0, 8);
    const prev = (st.resSig || {})[name];
    if (a.agent !== 'claude' && st.sessions[name] && prev !== undefined && prev !== sig) {
      const note = rn || RES_REMOVED;
      text = 'UPDATE:' + note + '\n\n' + text;
    }
    if (prev !== sig) { st.resSig = st.resSig || {}; st.resSig[name] = sig; saveState(ctx, st); }
    // cuộc trò chuyện mới sau khi đổi tài khoản/model: đọc lại bộ nhớ đã lưu trước khi làm
    if ((st.handoffRead || {})[name] && !st.sessions[name] && !job.memorySave) {
      text = READ_MEMORY(handoffFile(ctx, name)) + text;
      delete st.handoffRead[name]; saveState(ctx, st);
    }
    if ((st.undoNote || {})[name]) {
      if (st.sessions[name]) text = `NOTE: the human undid the file changes of one of your earlier turns (${st.undoNote[name]}). Those files are back to how they were before that turn; re-read a file before editing it.\n\n` + text;
      delete st.undoNote[name]; saveState(ctx, st);
    }
    // mọi cuộc trò chuyện mới đều nhận bộ nhớ chung của project
    if (!st.sessions[name] && !job.memorySave) { const mem = readMemory(ctx); if (mem.trim()) text = PROJECT_MEMORY(mem) + text; }
    const { cmd, args, stdin } = buildCmd(ctx, name, a, st.sessions[name], text, (st.grants || {})[name] || []);
    const msg = newMsg('agent', '', { steps: [], running: true, agent: a.agent, ...(useCm(ctx, a) ? { cm: true } : {}) });
    L.msg = msg;
    // chụp thư mục làm việc trước lượt, để sau này hoàn tác được (project không dùng git thì bỏ qua)
    const preSnap = ctx.kind === 'office' || job.memorySave ? Promise.resolve('') : undo.snapshot(run, a.cwd).catch(() => '');
    const parse = makeParser(a.agent, msg, (sid) => { const s2 = loadState(ctx); s2.sessions[name] = sid; saveState(ctx, s2); });
    // đợi chụp xong rồi mới chạy agent (trong lúc đó coi như đang bận), để bản chụp chắc chắn là trước khi agent sửa gì
    L.committing = true;
    preSnap.then(() => { L.committing = false; launch(); });
    function launch() {
    let child;
    try {
      // detached: agent và mọi lệnh con của nó cùng một nhóm tiến trình, để nút Dừng tắt được hết
      child = spawn(cmd, args, { cwd: a.cwd, env: { ...process.env, ...gitEnv(name, a), ...accountEnv(a) }, detached: true, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
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
      if (!L.stopped && code && /unknown option.*include-partial-messages/i.test(errTail)) {
        noPartial = true; msg.error = 'Bản Claude Code trong WSL chưa hỗ trợ hiện chữ dần nên dashboard đã tắt tính năng này. Bạn nhắn lại là được.';
      }
      if (L.stopped) msg.note = 'Bạn đã dừng lượt này.';
      else if (code && !msg.error) msg.error = short(errTail.trim() || `Agent thoát với mã ${code}${signal ? ' (' + signal + ')' : ''}`, 800);
      finish();
    });
    }
    async function finish() {
      delete msg.running; delete msg.draft; L.child = null; L.msg = null; L.stopped = false;
      if (!msg.text && !msg.error && !msg.steps.length) msg.text = '(không có trả lời)';
      try { const fl = filesOf(ctx, a, msg); if (fl.length) msg.files = fl; } catch { /* không bắt buộc */ }
      let after = null; // việc làm sau khi tin nhắn của lượt này đã được ghi vào chat
      if (job.memorySave) {
        // lượt "lưu bộ nhớ": nếu agent không ghi được file thì lấy từ lịch sử chat; xong thì áp dụng thay đổi đang chờ
        const f = handoffFile(ctx, name);
        let saved = false;
        try { saved = !msg.error && fs.statSync(f).mtimeMs >= job.startedAt; } catch { /* chưa có */ }
        if (!saved) { try { writeFallbackHandoff(ctx, name); msg.note = 'Agent không ghi được bộ nhớ, dashboard đã lấy từ lịch sử chat thay thế.'; } catch { /* bỏ qua */ } }
        if (job.refresh) after = () => {
          const st2 = loadState(ctx);
          if (st2.sessions) delete st2.sessions[name];
          if (st2.ctxSize) delete st2.ctxSize[name];
          st2.handoffRead = st2.handoffRead || {}; st2.handoffRead[name] = true;
          saveState(ctx, st2);
        };
        if (job.switchTo) after = () => {
          try { const st2 = loadState(ctx); if (st2.agents[name]) applyChange(ctx, st2, name, job.switchTo); }
          catch (e) { addMessage(ctx, name, newMsg('system', 'Không đổi được: ' + e.message)); }
        };
      }
      let raw = null;
      try { raw = parse.done(); } catch { /* không bắt buộc */ }
      try { const cs = parse.ctxSize(); if (cs) { const s3 = loadState(ctx); s3.ctxSize = s3.ctxSize || {}; s3.ctxSize[name] = cs; saveState(ctx, s3); } } catch { /* không bắt buộc */ }
      if (msg.usage) { try { addUsage(ctx, name, a, msg.usage, !!msg.cm, raw, job.taskId ? [job.taskId] : job.costTasks || []); } catch (e) { console.error('usage:', e.message); } }
      addMessage(ctx, name, msg);
      if (after) after();
      try {
        const pre = await preSnap;
        if (pre) {
          const post = await undo.snapshot(run, a.cwd);
          const n = (await undo.changed(run, a.cwd, pre, post)).length;
          if (n) { msg.snap = { pre, post, cwd: a.cwd, files: n }; rewrite(ctx, name); }
        }
      } catch { /* không hoàn tác được lượt này, không sao */ }
      if (gitByDashboard(ctx, name, a)) {
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


  // ------------------------------------------------------------ ảnh / file trong chat
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
  const MAX_FILE = 20 * 1024 * 1024;
  // chỉ mở được file nằm trong project (hoặc worktree của agent), không mở thư mục .git
  function resolveFile(ctx, p, base) {
    p = String(p || '');
    if (!p || p.length > 1000 || p.includes('\0')) return null;
    if (p === '~' || p.startsWith('~/')) return null;
    try {
      const real = fs.realpathSync(path.isAbsolute(p) ? p : path.resolve(base || ctx.root, p));
      const s = fs.statSync(real);
      if (!s.isFile() || real.split(path.sep).includes('.git')) return null;
      const st = loadState(ctx);
      const roots = [ctx.root, ...Object.values(st.agents || {}).map((a) => a.cwd).filter(Boolean), ...(ctx.resources || []).map((r) => r.path)]
        .map((r) => { try { return fs.realpathSync(r); } catch { return null; } }).filter(Boolean);
      if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) return null;
      return { path: real, name: path.basename(real), kind: IMG_RE.test(real) ? 'image' : 'file', size: s.size };
    } catch { return null; }
  }
  // file agent nhắc tới trong câu trả lời + file agent vừa sửa trong lượt này
  function filesOf(ctx, a, msg) {
    const out = [];
    const add = (p, edited) => {
      if (out.length >= 12) return;
      const f = resolveFile(ctx, p, a.cwd) || resolveFile(ctx, p, ctx.root);
      if (!f) return;
      const had = out.find((x) => x.path === f.path);
      if (had) { if (edited) had.edited = true; return; }
      out.push(edited ? { ...f, edited: true } : f);
    };
    const cands = [];
    const re = /`([^`\n]{1,300})`|\]\(([^)\s]{1,300})\)|((?:[\w.@~-]+\/|\/)*[\w.@-]+\.[A-Za-z0-9]{1,8})/g;
    let m;
    while ((m = re.exec(msg.text || '')) && cands.length < 60) cands.push((m[1] || m[2] || m[3]).trim().replace(/^file:\/\//, '').replace(/[:#]L?\d+([-:]\d+)?$/, ''));
    const stepFiles = (msg.steps || []).flatMap((s) => [s.file, ...(s.files || [])]).filter(Boolean);
    const dirs = [...new Set(stepFiles.map((f) => path.dirname(path.resolve(a.cwd || ctx.root, f))))].slice(0, 8);
    for (const c of cands) if (/\.[A-Za-z0-9]{1,8}$/.test(c) && !/^https?:/i.test(c)) {
      const n = out.length; add(c, false);
      if (out.length === n && !c.includes('/')) for (const d of dirs) { add(path.join(d, c), false); if (out.length > n) break; }
    }
    for (const f of stepFiles) add(f, true);
    return out;
  }

  // ------------------------------------------------------------ thống kê token
  // .agents/chat/usage.json: { days: { "2026-11-11": { "<tên>|<hãng>|<model>": { in, out, cached, cost, turns } } } }
  const usageFile = (ctx) => path.join(dir(ctx), 'usage.json');
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function loadUsage(ctx) {
    try { const u = JSON.parse(fs.readFileSync(usageFile(ctx), 'utf8')); if (u && typeof u.days === 'object') return u; } catch { /* chưa có */ }
    return { days: {} };
  }
  function addUsage(ctx, name, a, u, cm, raw, taskIds = []) {
    const accId = accountOf(a) ? a.account : '';
    const all = loadUsage(ctx);
    const day = all.days[dayKey()] || (all.days[dayKey()] = {});
    // Claude báo theo từng model thực chạy (gồm agent phụ): mỗi model một dòng; lượt được tính cho model dùng nhiều nhất
    const parts = u.models && Object.keys(u.models).length ? Object.entries(u.models) : [[a.model || '', u]];
    const main = parts.reduce((x, y) => ((y[1].in + y[1].out) > (x[1].in + x[1].out) ? y : x))[0];
    for (const [model, v] of parts) {
      const k = `${name}|${a.agent}|${String(model).replace(/\|/g, '/')}` + (cm ? '|cm' : '') + (accId ? '|acc:' + accId : '');
      const r = day[k] || (day[k] = { in: 0, out: 0, cached: 0, cost: 0, turns: 0 });
      r.in += v.in; r.out += v.out; r.cached += v.cached || 0; r.cost += v.cost || 0;
      if (model === main) { r.turns += 1; if (u.partial) r.partial = (r.partial || 0) + 1; }
    }
    // token theo task: lượt worker làm task và lượt cấp trên đọc kết quả; một lượt báo nhiều task thì chia đều
    const ids = taskIds.filter((x) => /^T-\d+$/.test(x));
    if (ids.length) {
      all.tasks = all.tasks || {};
      for (const id of ids) {
        const t = all.tasks[id] || (all.tasks[id] = { in: 0, out: 0, cached: 0, cost: 0, turns: 0 });
        t.in += u.in / ids.length; t.out += u.out / ids.length; t.cached += (u.cached || 0) / ids.length; t.cost += (u.cost || 0) / ids.length; t.turns += 1;
      }
    }
    if (raw) { all.last = all.last || {}; all.last[name] = { ts: Date.now(), agent: a.agent, raw: short(JSON.stringify(raw, null, 1), 3000) }; }
    fs.mkdirSync(dir(ctx), { recursive: true });
    fs.writeFileSync(usageFile(ctx), JSON.stringify(all));
  }
  function usage(ctx, range) {
    const all = loadUsage(ctx);
    const days = Object.keys(all.days).sort();
    const from = range === 'today' ? dayKey() : range === '7' ? dayKey(new Date(Date.now() - 6 * 864e5)) : '';
    const rows = new Map();
    const accs = loadAccounts() || [];
    for (const d of days) {
      if (d < from) continue;
      for (const [k, v] of Object.entries(all.days[d])) {
        const [name, agent, model, ...flags] = k.split('|');
        const accId = (flags.find((x) => x.startsWith('acc:')) || '').slice(4);
        const r = rows.get(k) || { name, agent, model, cm: flags.includes('cm'), account: accId, accountName: (accs.find((x) => x.id === accId) || {}).name || accId, in: 0, out: 0, cached: 0, cost: 0, turns: 0, partial: 0 };
        r.in += v.in || 0; r.out += v.out || 0; r.cached += v.cached || 0; r.cost += v.cost || 0; r.turns += v.turns || 0; r.partial += v.partial || 0;
        rows.set(k, r);
      }
    }
    return { range: range || 'all', since: days[0] || '', last: all.last || {}, rows: [...rows.values()].sort((x, y) => (y.in + y.out) - (x.in + x.out)) };
  }
  on('GET', /^\/api\/usage$/, (req, res, _m, url) => send(res, 200, usage(getCtx(url), url.searchParams.get('range') || 'all')));

  // ------------------------------------------------------------ khởi động / dừng
  const winName = (a) => { const m = (a.model || '').replace(/[^A-Za-z0-9_-]/g, '-'); return !m ? a.agent : m.startsWith(a.agent) ? m : `${a.agent}-${m}`; };

  // tạo worktree + nhánh agent/<name> cho một worker và ghi vào st.agents; trả về dòng cho workers.txt
  // Bản sao riêng của từng agent nằm chung trong <project>-agents/<tên>; bản đã tạo kiểu cũ (<project>-<tên>) thì dùng tiếp.
  function wtPath(ctx, name) {
    const old = path.resolve(ctx.root, '..', `${path.basename(ctx.root)}-${name}`);
    return fs.existsSync(old) ? old : path.resolve(ctx.root, '..', `${path.basename(ctx.root)}-agents`, name);
  }
  async function addWorker(ctx, st, name, w, gitDir) {
    if (ctx.kind === 'office') { // project điều hành: không worktree, mọi agent làm trong thư mục văn phòng
      st.agents[name] = { agent: w.agent, model: w.model || '', effort: w.effort || '', ...(w.helper ? { helper: true } : {}), cwd: ctx.root };
      return workerLine(name, w);
    }
    if (ctx.shared) { // chung một thư mục: không worktree, không nhánh riêng
      st.agents[name] = { agent: w.agent, model: w.model || '', effort: w.effort || '', ...(w.helper ? { helper: true } : {}), cwd: ctx.root, gitDir };
      return workerLine(name, w);
    }
    const wt = wtPath(ctx, name);
    if (!fs.existsSync(wt)) {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
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
    const common = ctx.kind === 'office' ? { ok: false } : await run('git', ['-C', ctx.root, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    let line;
    try { line = await addWorker(ctx, st, r.name, { agent: r.agent, model: r.model, effort: r.effort, helper: true }, common.ok ? common.out.trim() : path.join(ctx.root, '.git')); }
    catch (e) { return send(res, 500, { error: e.message }); }
    saveState(ctx, st);
    fs.appendFileSync(path.join(ctx.root, '.agents', 'workers.txt'), line + '\n');
    editHierarchy(ctx, (h) => h.set(r.name, r.parent));
    setRequestStatus(ctx, id, 'approved');
    tell(`The human APPROVED helper "${r.name}" (${r.agent}${r.model ? ' ' + r.model : ''}). It is now your direct report: assign it tasks by writing task files with "Created by: ${r.parent}", "Owner: ${r.name}", "Status: ready". Keep its tasks small and simple. Continue your work.`,
      `✅ Bạn đã cho phép tạo agent "${r.name}" (${r.agent}${r.model ? ', ' + r.model : ''}) dưới quyền ${r.parent}.`);
    send(res, 200, { ok: true });
  });


  // ------------------------------------------------------------ quản lý cây phân cấp (bạn sửa trên dashboard)
  const hierFile = (ctx) => path.join(ctx.root, '.agents', 'hierarchy.txt');
  function readHierarchy(ctx) {
    const h = new Map();
    let text = '';
    try { text = fs.readFileSync(hierFile(ctx), 'utf8'); } catch { return h; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.replace(/#.*/, '').match(/^\s*(\S+)\s*<-\s*(\S+)\s*$/);
      if (m && m[1] !== 'lead') h.set(m[1], m[2]);
    }
    return h;
  }
  // giữ các dòng chú thích (#) ở đầu file, viết lại các dòng "<tên> <- <cấp trên>"
  function editHierarchy(ctx, fn) {
    const h = readHierarchy(ctx);
    fn(h);
    let old = '';
    try { old = fs.readFileSync(hierFile(ctx), 'utf8'); } catch { /* chưa có */ }
    const comments = old.split(/\r?\n/).filter((l) => /^\s*#/.test(l));
    fs.mkdirSync(path.dirname(hierFile(ctx)), { recursive: true });
    fs.writeFileSync(hierFile(ctx), [...comments, ...[...h].map(([n, p]) => `${n} <- ${p}`)].join('\n') + '\n');
  }
  function knownNames(ctx, st) {
    const names = new Set(['lead', ...Object.keys(st.agents || {})]);
    try {
      for (const l of fs.readFileSync(path.join(ctx.root, '.agents', 'workers.txt'), 'utf8').split('\n')) {
        const n = l.trim().split(/\s+/)[0];
        if (n && WORKER_RE.test(n)) names.add(n);
      }
    } catch { /* chưa start */ }
    return names;
  }
  const workerLine = (n, a) => `${n}  (${a.agent}${a.model ? ', model ' + a.model : ''}${a.effort ? ', effort ' + a.effort : ''})`;
  function writeWorkers(ctx, st) {
    const lines = Object.entries(st.agents).filter(([n]) => n !== 'lead').map(([n, a]) => workerLine(n, a));
    fs.writeFileSync(path.join(ctx.root, '.agents', 'workers.txt'), lines.join('\n') + (lines.length ? '\n' : ''));
  }
  const isBusy = (ctx, n) => { const L = live.get(key(ctx, n)); return !!(L && (L.child || L.committing || L.queue.length)); };
  const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
  function eachTask(ctx, fn) {
    const tdir = path.join(ctx.root, '.agents', 'tasks');
    let files = [];
    try { files = fs.readdirSync(tdir).filter((f) => /^T-\d+\.md$/.test(f)); } catch { return; }
    for (const f of files) {
      const fp = path.join(tdir, f);
      let text;
      try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      const t2 = fn(text, f.slice(0, -3));
      if (typeof t2 === 'string' && t2 !== text) fs.writeFileSync(fp, t2);
    }
  }
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function setParent(ctx, st, name, parent) {
    const names = knownNames(ctx, st);
    if (name === 'lead') throw new Error('Lead luôn ở trên cùng.');
    if (!names.has(name)) throw new Error(`Không có agent ${name}`);
    if (!names.has(parent)) throw new Error(`Không có agent ${parent}`);
    const h = readHierarchy(ctx);
    for (let p = parent, i = 0; p && p !== 'lead' && i < 100; p = h.get(p) || 'lead', i++) {
      if (p === name) throw new Error(`Không được: ${parent} đang nằm dưới ${name}, đổi như vậy sẽ thành vòng lặp.`);
    }
    editHierarchy(ctx, (m) => m.set(name, parent));
  }

  async function renameAgent(ctx, st, old, nw) {
    const a = st.agents[old];
    if (!WORKER_RE.test(nw) || nw === 'lead' || nw === 'watch') throw new Error('Tên chỉ gồm chữ, số, dấu - và _ (tối đa 30 ký tự).');
    if (st.agents[nw]) throw new Error(`Đã có agent tên ${nw}`);
    let wt = a.cwd;
    if (usesWt(ctx, a)) {
      wt = path.join(path.dirname(a.cwd), path.basename(a.cwd) === old ? nw : `${path.basename(ctx.root)}-${nw}`);
      if (fs.existsSync(wt)) throw new Error(`Thư mục ${wt} đã tồn tại, hãy chọn tên khác.`);
      const b = await run('git', ['-C', ctx.root, 'branch', '-m', `agent/${old}`, `agent/${nw}`]);
      if (!b.ok) throw new Error('Không đổi được tên nhánh: ' + b.err.trim());
      const mv = await run('git', ['-C', ctx.root, 'worktree', 'move', a.cwd, wt]);
      if (!mv.ok) {
        await run('git', ['-C', ctx.root, 'branch', '-m', `agent/${nw}`, `agent/${old}`]);
        throw new Error('Không chuyển được thư mục làm việc: ' + mv.err.trim());
      }
    }
    st.agents = Object.fromEntries(Object.entries(st.agents).map(([n, v]) => (n === old ? [nw, { ...v, cwd: wt }] : [n, v])));
    if (st.sessions) delete st.sessions[old]; // phiên cũ gắn với thư mục cũ
    if (st.grants?.[old]) { st.grants[nw] = st.grants[old]; delete st.grants[old]; }
    try { fs.renameSync(path.join(dir(ctx), old + '.jsonl'), path.join(dir(ctx), nw + '.jsonl')); } catch { /* chưa có lịch sử */ }
    cache.delete(key(ctx, old)); live.delete(key(ctx, old));
    editHierarchy(ctx, (h) => {
      const p = h.get(old); h.delete(old);
      for (const [n, v] of [...h]) if (v === old) h.set(n, nw);
      if (p) h.set(nw, p);
    });
    const re = new RegExp(`^(Owner|Created by):[ \\t]*${esc(old)}[ \\t]*$`, 'gm');
    eachTask(ctx, (text) => text.replace(re, `$1: ${nw}`));
    addMessage(ctx, nw, newMsg('system', `Đã đổi tên agent từ "${old}" thành "${nw}". Agent bắt đầu cuộc trò chuyện mới.`));
  }

  on('POST', /^\/api\/agents$/, async (req, res, _m, url) => {
    const ctx = getCtx(url);
    const b = await readBody(req);
    const st = loadState(ctx);
    if (!st.active) return send(res, 400, { error: 'Chỉ thêm được agent khi đang chạy kiểu Chat. Ở kiểu Terminal hãy thêm worker trong Cài đặt, tab "Đội agent", rồi Start lại.' });
    const name = String(b.name || '');
    const parent = String(b.parent || 'lead');
    if (!WORKER_RE.test(name) || name === 'lead' || name === 'watch') return send(res, 400, { error: 'Tên chỉ gồm chữ, số, dấu - và _ (tối đa 30 ký tự).' });
    if (st.agents[name]) return send(res, 400, { error: `Đã có agent tên ${name}` });
    if (!['claude', 'codex', 'gemini'].includes(b.agent)) return send(res, 400, { error: 'Agent phải là claude, codex hoặc gemini' });
    if (!MODEL_RE.test(b.model || '') || !EFFORT_RE.test(b.effort || '')) return send(res, 400, { error: 'Model hoặc effort không hợp lệ' });
    if (!st.agents[parent]) return send(res, 400, { error: `Không có agent cấp trên ${parent}` });
    const common = ctx.kind === 'office' ? { ok: false } : await run('git', ['-C', ctx.root, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    try { await addWorker(ctx, st, name, { agent: b.agent, model: b.model || '', effort: b.effort || '', helper: true }, common.ok ? common.out.trim() : path.join(ctx.root, '.git')); }
    catch (e) { return send(res, 500, { error: e.message }); }
    saveState(ctx, st); writeWorkers(ctx, st);
    editHierarchy(ctx, (h) => h.set(name, parent));
    enqueue(ctx, parent, `The human added a new agent "${name}" (${b.agent}${b.model ? ' ' + b.model : ''}) as your direct report. Assign it tasks by writing task files with "Created by: ${parent}", "Owner: ${name}", "Status: ready". Reply with one short line only.`,
      { role: 'system', text: `➕ Bạn đã thêm agent "${name}" dưới quyền ${parent}.` });
    send(res, 200, { ok: true });
  });

  on('POST', /^\/api\/agents\/([^/]+)$/, async (req, res, m, url) => {
    let [name] = m; const ctx = getCtx(url);
    const b = await readBody(req);
    const st = loadState(ctx);
    try {
      if (typeof b.parent === 'string') setParent(ctx, st, name, b.parent);
      const a = st.agents?.[name];
      const wantsEdit = typeof b.model === 'string' || typeof b.effort === 'string' || (typeof b.rename === 'string' && b.rename && b.rename !== name);
      if (wantsEdit && !a) throw new Error('Chỉ sửa được agent khi đang chạy kiểu Chat.');
      const wantsChange = a && (typeof b.model === 'string' || typeof b.effort === 'string' || typeof b.account === 'string');
      if (wantsChange) {
        const ch = { model: b.model, effort: b.effort, account: b.account };
        const fresh = (typeof b.model === 'string' && b.model.trim() !== (a.model || '')) || (typeof b.account === 'string' && b.account !== (a.account || ''));
        if (fresh && b.keepMemory !== false && st.sessions?.[name]) {
          // trước khi đổi: agent ghi bộ nhớ ra file (bằng tài khoản/model cũ), xong dashboard mới áp dụng thay đổi
          if (isBusy(ctx, name)) throw new Error('Agent đang làm việc. Dừng lượt hiện tại hoặc đợi xong rồi đổi.');
          planChange(st, name, ch); // kiểm tra hợp lệ trước khi mất công lưu bộ nhớ
          enqueue(ctx, name, MEMORY_SAVE(handoffFile(ctx, name)), { role: 'system', text: '💾 Đang lưu bộ nhớ trước khi đổi…' }, { memorySave: true, switchTo: ch, startedAt: Date.now() });
          return send(res, 200, { ok: true, name, pending: true });
        }
        applyChange(ctx, st, name, ch);
      }
      if (a && typeof b.rename === 'string' && b.rename && b.rename !== name) {
        if (name === 'lead') throw new Error('Không đổi tên được Lead.');
        if (isBusy(ctx, name)) throw new Error('Agent đang làm việc. Dừng lượt hiện tại rồi đổi tên.');
        await renameAgent(ctx, st, name, b.rename);
        saveState(ctx, st); writeWorkers(ctx, st);
        name = b.rename;
      }
    } catch (e) { return send(res, 400, { error: e.message }); }
    send(res, 200, { ok: true, name });
  });

  // Nút "Cập nhật bộ nhớ": bảo agent ghi lại bộ nhớ ra .agents/handoff/<tên>.md (không đổi gì)
  on('POST', /^\/api\/agents\/([^/]+)\/memory$/, (req, res, m, url) => {
    const [name] = m; const ctx = getCtx(url);
    const st = loadState(ctx);
    if (!st.agents?.[name]) return send(res, 404, { error: 'Không có agent này (chỉ dùng được khi đang chạy kiểu Chat).' });
    if (isBusy(ctx, name)) return send(res, 409, { error: 'Agent đang làm việc. Đợi xong rồi bấm lại.' });
    enqueue(ctx, name, MEMORY_SAVE(handoffFile(ctx, name)), { role: 'system', text: '💾 Đang cập nhật bộ nhớ…' }, { memorySave: true, startedAt: Date.now() });
    send(res, 200, { ok: true, file: handoffFile(ctx, name) });
  });

  // Tab "Bộ nhớ": bộ nhớ chung của project và ghi chú riêng của từng agent
  on('GET', /^\/api\/memory$/, (req, res, _m, url) => {
    const ctx = getCtx(url); const st = loadState(ctx);
    const agents = Object.keys(st.agents || {}).map((name) => {
      let text = '', mtime = 0;
      try { text = fs.readFileSync(handoffFile(ctx, name), 'utf8').slice(0, MEM_MAX); mtime = fs.statSync(handoffFile(ctx, name)).mtimeMs; } catch { /* chưa có */ }
      return { name, text, mtime, ctx: (st.ctxSize || {})[name] || 0, session: !!(st.sessions || {})[name] };
    });
    send(res, 200, { shared: readMemory(ctx), file: memoryFile(ctx), refreshAt: refreshAt(ctx), agents });
  });
  on('POST', /^\/api\/memory$/, async (req, res, _m, url) => {
    const ctx = getCtx(url); const b = await readBody(req);
    if (typeof b.text !== 'string' || b.text.length > MEM_MAX) return send(res, 400, { error: 'Nội dung quá dài (tối đa khoảng 12.000 ký tự).' });
    fs.mkdirSync(path.dirname(memoryFile(ctx)), { recursive: true });
    fs.writeFileSync(memoryFile(ctx), b.text.trim() ? b.text.trimEnd() + '\n' : '');
    send(res, 200, { ok: true });
  });
  on('POST', /^\/api\/memory\/agent\/([^/]+)$/, async (req, res, m, url) => {
    const [name] = m; const ctx = getCtx(url); const b = await readBody(req);
    if (!loadState(ctx).agents?.[name]) return send(res, 404, { error: 'Không có agent này.' });
    if (typeof b.text !== 'string' || b.text.length > MEM_MAX) return send(res, 400, { error: 'Nội dung quá dài (tối đa khoảng 12.000 ký tự).' });
    if (!b.text.trim()) fs.rmSync(handoffFile(ctx, name), { force: true });
    else { fs.mkdirSync(path.dirname(handoffFile(ctx, name)), { recursive: true }); fs.writeFileSync(handoffFile(ctx, name), b.text.trimEnd() + '\n'); }
    send(res, 200, { ok: true });
  });

  // Xoá agent: cấp dưới chuyển lên cấp trên của nó, task đang giữ trở về "todo". Worktree và nhánh agent/<tên> được giữ lại.
  on('DELETE', /^\/api\/agents\/([^/]+)$/, (req, res, m, url) => {
    const [name] = m; const ctx = getCtx(url);
    const st = loadState(ctx);
    if (name === 'lead') return send(res, 400, { error: 'Không xoá được Lead.' });
    if (!st.agents?.[name]) return send(res, 404, { error: 'Không có agent này (chỉ xoá được khi đang chạy kiểu Chat).' });
    if (isBusy(ctx, name)) return send(res, 409, { error: 'Agent đang làm việc. Dừng lượt hiện tại rồi xoá.' });
    const up = parentOf(ctx, name);
    const moved = [];
    editHierarchy(ctx, (h) => {
      h.delete(name);
      for (const [n, v] of [...h]) if (v === name) { h.set(n, up); moved.push(n); }
    });
    const freed = [];
    eachTask(ctx, (text, id) => {
      if (field(text, 'Owner') !== name || !['ready', 'in-progress'].includes(field(text, 'Status').toLowerCase())) return null;
      freed.push(id);
      const note = `- ${stamp()} Dashboard: agent ${name} đã bị xoá, task trở về todo để giao lại.`;
      const t2 = text.replace(/^Status:.*$/m, 'Status: todo');
      return /^## Notes/m.test(t2) ? t2.replace(/^(## Notes.*)$/m, `$1\n${note}`) : `${t2}\n## Notes / questions\n${note}\n`;
    });
    const cwd = st.agents[name].cwd;
    delete st.agents[name];
    if (st.sessions) delete st.sessions[name];
    if (st.grants) delete st.grants[name];
    saveState(ctx, st); writeWorkers(ctx, st);
    live.delete(key(ctx, name));
    send(res, 200, { ok: true, moved, freed, up, cwd });
  });

  async function start(ctx, lead, workers) {
    const office = ctx.kind === 'office';
    let gitDir = '';
    if (!office) {
      const head = await run('git', ['-C', ctx.root, 'rev-parse', 'HEAD']);
      if (!head.ok) throw new Error('Repo chưa có commit nào. Hãy commit trước (nút ở thanh cảnh báo).');
      const common = await run('git', ['-C', ctx.root, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
      gitDir = common.ok ? common.out.trim() : path.join(ctx.root, '.git');
    } else if (!workers.some((w) => (w.name || winName(w)) === 'git')) {
      // project điều hành luôn có một agent riêng lo git cho các thư mục tài nguyên (model rẻ là đủ)
      workers = [...workers, { name: 'git', agent: 'claude', model: 'haiku', effort: '' }];
    }
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
    for (let again = true; again;) {
      again = false;
      for (const [n, o] of Object.entries(old)) {
        if (!o.helper || st.agents[n] || !st.agents[parentOf(ctx, n)]) continue;
        lines.push(await addWorker(ctx, st, n, o, gitDir)); again = true;
      }
    }
    // hồ sơ tài khoản đã gán cho agent thì giữ lại (nếu vẫn cùng loại agent)
    for (const [n, a] of Object.entries(st.agents)) if (old[n]?.account && old[n].agent === a.agent && !a.account) a.account = old[n].account;
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
      active: !!st.active, taskUsage: loadUsage(ctx).tasks || {},
      agents: Object.entries(st.agents || {}).map(([name, a]) => {
        const L = live.get(key(ctx, name));
        const grants = (st.grants || {})[name] || [];
        const lastMsg = messages(ctx, name).slice(-1)[0];
        // agent đang chờ bạn bấm "Cho phép"
        const wants = !L?.child && !!lastMsg?.grants?.length && !lastMsg.granted && !lastMsg.grants.every((g) => grants.includes(g.id));
        return { name, agent: a.agent, model: a.model || '', effort: a.effort || '', helper: !!a.helper, account: a.account || '', busy: !!L?.child, queued: L?.queue.length || 0, grants, wants, ctx: (st.ctxSize || {})[name] || 0 };
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
      const reports = {};
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
          const byDash = gitByDashboard(ctx, owner, st.agents[owner]);
          if (byDash && base && usesWt(ctx, st.agents[owner])) {
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
            ? `Do task ${id}: the dashboard ${usesWt(ctx, st.agents[owner]) ? `already merged ${base || 'the main branch'} into your branch and ` : ''}will commit your changes after your turn, ` +
              'so do NOT run git merge or git commit (your sandbox cannot write .git). Skip those steps of the task protocol, ' +
              `do everything else: read ${path.join(ctx.root, '.agents', 'tasks', id + '.md')} and AGENTS.md, follow the task protocol. Be terse.`
            : `Do task ${id}: ${base && usesWt(ctx, st.agents[owner]) ? `first run 'git merge --no-edit ${base}' to get the latest code (on conflicts set Status: blocked and explain), then ` : ''}` +
            `read ${noLink(st.agents[owner]) ? path.join(ctx.root, '.agents', 'tasks', id + '.md') : `.agents/tasks/${id}.md`} and AGENTS.md, follow the task protocol exactly. Be terse.`;
          enqueue(ctx, owner, msg, { role: 'system', text: `📋 Nhận việc ${id}: ${(text.split('\n')[0] || '').replace(/^#\s*(T-\d+\s*:?\s*)?/, '')}` }, { taskId: id });
        } else if (!first && last[id] !== status && (status === 'done' || status === 'blocked')) {
          // worker còn đang chạy hoặc dashboard đang commit hộ: đợi vòng sau để lead merge được bản đầy đủ
          const Lo = live.get(key(ctx, owner));
          if (Lo && (Lo.child || Lo.committing)) continue;
          // báo người tạo task (dòng "Created by:", như scripts/notify.sh); không có agent đó thì báo lead
          const to = st.agents[creator] ? creator : 'lead';
          if (st.agents[to]) {
            // phần Result (và Notes nếu bị chặn) được chép sẵn vào tin, để cấp trên không tốn thêm lượt gọi công cụ đọc file
            const sec = (re) => ((text.split(/^## /m).find((x) => re.test(x)) || '').split('\n').slice(1).join('\n').trim());
            const body = [sec(/^Result/i) && 'Result:\n' + sec(/^Result/i), status === 'blocked' && sec(/^Notes/i) && 'Notes / questions:\n' + sec(/^Notes/i)].filter(Boolean).join('\n');
            (reports[to] = reports[to] || []).push({ id, status, owner, body: short(body, 1500) });
          }
        }
        last[id] = status;
      }
      for (const [to, list] of Object.entries(reports)) {
        const tdirShown = noLink(st.agents[to]) ? tdir : '.agents/tasks';
        const txt = list.map((r) => `- ${r.id}: Status ${r.status} (worker ${r.owner}).${r.body ? '\n' + r.body : ' The worker left Result empty.'}`).join('\n');
        enqueue(ctx, to, `Worker update:\n${txt}\n\nThe text above is copied from the task file${list.length > 1 ? 's' : ''} in ${tdirShown}, so do not open ${list.length > 1 ? 'them' : 'it'} unless something is unclear. ` +
          `Report ${to === 'lead' ? 'to me' : 'and continue your own task'} in 3 lines max${list.length > 1 ? ' per task' : ''}.`,
        { role: 'system', text: `🔔 ${list.map((r) => `${r.id} ${r.status === 'done' ? 'đã xong' : 'bị chặn'} (${r.owner})`).join(', ')}. ${to === 'lead' ? 'Lead' : to} đang đọc kết quả…` },
        { costTasks: list.map((r) => r.id) });
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
    // file đính kèm: chỉ nhận file đã tải lên .agents/uploads của project này
    let up = '';
    try { up = fs.realpathSync(path.join(ctx.root, '.agents', 'uploads')) + path.sep; } catch { /* chưa có file tải lên */ }
    const files = (Array.isArray(b.files) ? b.files : []).slice(0, 20).map((f) => {
      const r = up && resolveFile(ctx, f?.path);
      return r && r.path.startsWith(up) ? { ...r, name: String(f.name || r.name).slice(0, 120) } : null;
    }).filter(Boolean);
    if (!text && !files.length) return send(res, 400, { error: 'Tin nhắn trống' });
    const st = loadState(ctx);
    if (!st.active) return send(res, 400, { error: 'Chưa Start agents ở chế độ chat.' });
    if (!st.agents[name]) return send(res, 404, { error: 'Không có agent này' });
    if (files.length) {
      const prompt = (text || 'See the attached file(s).') + '\n\nAttached files from the human (open and read each one; image files can be viewed with your file/image reading tool):\n' + files.map((f) => '- ' + f.path).join('\n');
      enqueue(ctx, name, prompt, { role: 'you', text, files });
    } else enqueue(ctx, name, text);
    send(res, 200, { ok: true });
  });
  on('POST', /^\/api\/chat\/([^/]+)\/undo$/, async (req, res, m, url) => {
    const [name] = m; const ctx = getCtx(url);
    if (!NAME_RE.test(name)) return send(res, 400, { error: 'Tên không hợp lệ' });
    const b = await readBody(req);
    const L = live.get(key(ctx, name));
    if (L && (L.child || L.committing)) return send(res, 409, { error: 'Agent đang làm việc. Chờ xong hoặc bấm Dừng rồi hoàn tác.' });
    const msg = messages(ctx, name).find((x) => x.id === b.msgId);
    if (!msg || !msg.snap || msg.undone) return send(res, 400, { error: 'Lượt này không hoàn tác được (không có bản chụp, hoặc đã hoàn tác rồi).' });
    try {
      const r = await undo.undoTurn(run, msg.snap.cwd, msg.snap.pre, msg.snap.post);
      msg.undone = { restored: r.restored.length, skipped: r.skipped.slice(0, 20) };
      rewrite(ctx, name);
      let note = `↩ Đã hoàn tác ${r.restored.length} file của lượt này.` + (r.skipped.length ? ` Giữ nguyên ${r.skipped.length} file vì đã bị sửa tiếp sau đó: ${r.skipped.slice(0, 5).join(', ')}${r.skipped.length > 5 ? '…' : ''}.` : '');
      const st = loadState(ctx), a = st.agents[name];
      if (r.restored.length) {
        st.undoNote = st.undoNote || {}; st.undoNote[name] = short(r.restored.join(', '), 600); saveState(ctx, st);
        if (a && gitByDashboard(ctx, name, a)) { try { const c = await autoCommit(msg.snap.cwd, `undo: revert a turn of ${name}`); if (c) note += ' ' + c; } catch { /* để nguyên chưa commit */ } }
      }
      addMessage(ctx, name, newMsg('system', note));
      send(res, 200, { ok: true, ...r });
    } catch (e) { send(res, 500, { error: e.message }); }
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
    const st = loadState(ctx);
    if ((st.sessions || {})[name]) {
      // chưa có ghi chú do agent tự viết gần đây thì lấy tạm từ lịch sử chat, để cuộc trò chuyện mới không bắt đầu từ con số không
      let recent = false;
      try { recent = Date.now() - fs.statSync(handoffFile(ctx, name)).mtimeMs < 30 * 60 * 1000; } catch { /* chưa có */ }
      if (!recent) { try { writeFallbackHandoff(ctx, name); } catch { /* bỏ qua */ } }
      st.handoffRead = st.handoffRead || {};
      if (fs.existsSync(handoffFile(ctx, name))) st.handoffRead[name] = true;
    }
    delete (st.sessions || {})[name]; if (st.ctxSize) delete st.ctxSize[name]; saveState(ctx, st);
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
      enqueue(ctx, name, `The human granted the permission(s) you were missing: ${pick.map((g) => g.id).join(', ')}. Retry the blocked step(s) with simple commands (see SHELL COMMANDS) and continue the task.`,
        { role: 'system', text: `✅ Đã cho phép ${pick.length} quyền. Agent làm tiếp…` });
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

  // Tab "Quyền" trong Cài đặt: người dùng tự bấm để cho phép trước một nhóm lệnh hoặc thu hồi từng quyền.
  on('POST', /^\/api\/chat\/([^/]+)\/perm$/, async (req, res, m, url) => {
    const [name] = m; const ctx = getCtx(url);
    const b = await readBody(req);
    const st = loadState(ctx);
    if (!st.agents?.[name]) return send(res, 404, { error: 'Không tìm thấy agent' });
    const add = Array.isArray(b.add) ? b.add.map(String) : [], remove = Array.isArray(b.remove) ? b.remove.map(String) : [];
    if (add.length > 20 || add.some((g) => !GRANT_RE.test(g))) return send(res, 400, { error: 'Quyền không hợp lệ' });
    if (add.includes('network') && st.agents[name].agent !== 'codex') return send(res, 400, { error: 'Quyền mạng chỉ dành cho agent Codex' });
    st.grants = st.grants || {};
    const cur = b.removeAll ? [] : (st.grants[name] || []).filter((g) => !remove.includes(g));
    st.grants[name] = [...new Set([...cur, ...add])].slice(0, 60);
    if (!st.grants[name].length) delete st.grants[name];
    saveState(ctx, st);
    send(res, 200, { ok: true, grants: st.grants[name] || [] });
  });

  // trước khi dashboard khởi động lại: dừng các lượt đang chạy (lịch sử và trạng thái chat giữ nguyên)
  function killAll() {
    let n = 0;
    for (const L of live.values()) { L.queue = []; if (L.child) { L.stopped = true; kill(L); n++; } }
    return n;
  }
  // "Chuyển về thư mục chung": lưu việc đang dở của từng agent, gộp vào thư mục chính, rồi bỏ các bản sao.
  // Dừng ngay khi gộp bị xung đột; không ép xoá thư mục nào còn file chưa lưu.
  async function toShared(ctx) {
    if (ctx.kind === 'office') throw new Error('Project điều hành vốn đã dùng chung một thư mục.');
    const st = loadState(ctx);
    const names = Object.keys(st.agents || {}).filter((n) => usesWt(ctx, st.agents[n]));
    if (names.some((n) => isBusy(ctx, n)) || isBusy(ctx, 'lead')) throw new Error('Có agent đang làm việc. Chờ xong hoặc bấm Dừng rồi thử lại.');
    const log = [];
    for (const n of names) {
      const cwd = st.agents[n].cwd;
      if (!fs.existsSync(cwd)) continue;
      const c = await autoCommit(cwd, `wip: changes by ${n} before moving to the shared folder`);
      if (c) log.push(`${n}: đã lưu việc đang dở`);
    }
    const id = await run('git', ['-C', ctx.root, 'config', 'user.email']);
    const who = id.out.trim() ? [] : ['-c', 'user.name=Agent-Squad', '-c', 'user.email=agent-squad@localhost'];
    for (const n of names) {
      const has = await run('git', ['-C', ctx.root, 'rev-parse', '--verify', '--quiet', `refs/heads/agent/${n}`]);
      if (!has.ok) continue;
      const m = await run('git', ['-C', ctx.root, ...who, 'merge', '--no-edit', `agent/${n}`]);
      if (!m.ok) {
        await run('git', ['-C', ctx.root, 'merge', '--abort']);
        const e = new Error(`Không gộp được phần việc của ${n} vào thư mục chính: ${(m.out + m.err).trim().split('\n').slice(-3).join(' ')}`);
        e.log = log; throw e;
      }
      log.push(`${n}: đã gộp vào thư mục chính`);
    }
    const kept = [];
    for (const n of names) {
      const a = st.agents[n], cwd = a.cwd;
      try { const link = path.join(cwd, '.agents'); if (fs.lstatSync(link).isSymbolicLink()) fs.rmSync(link); } catch { /* không có */ }
      const r = fs.existsSync(cwd) ? await run('git', ['-C', ctx.root, 'worktree', 'remove', cwd]) : { ok: true };
      if (!r.ok) kept.push(cwd);
      a.cwd = ctx.root;
      // Claude gắn cuộc trò chuyện với thư mục làm việc: đổi thư mục thì mở cuộc trò chuyện mới và đọc lại bộ nhớ
      try { writeFallbackHandoff(ctx, n); } catch { /* không bắt buộc */ }
      if (st.sessions) delete st.sessions[n];
      st.handoffRead = st.handoffRead || {};
      if (fs.existsSync(handoffFile(ctx, n))) st.handoffRead[n] = true;
      addMessage(ctx, n, newMsg('system', '📂 Project chuyển sang dùng chung một thư mục. Từ giờ agent này làm thẳng trong thư mục project, bắt đầu cuộc trò chuyện mới' + (st.handoffRead[n] ? ' và đọc lại bộ nhớ đã lưu.' : '.')));
    }
    saveState(ctx, st); writeWorkers(ctx, st);
    return { moved: names, log, kept };
  }

  const busyCount = () => [...live.values()].filter((L) => L.child).length;

  return { start, stopAll, info, listRequests, killAll, busyCount, toShared, resolveFile, MAX_FILE, resourceInfo, isActive: (ctx) => !!loadState(ctx).active };
};
module.exports._test = { prefixesOf, cmdLabel, sayCmd, bareShell };
