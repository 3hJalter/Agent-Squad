// "Kiểm tra máy": xem công cụ đã cài, đã đăng nhập chưa, và thử gọi thật từng agent một lượt rất ngắn.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TRY_PROMPT = 'Reply with the single word OK and nothing else.';
const TRY_MS = 90000;
const AGENTS = {
  claude: { label: 'Claude Code', cred: ['.claude', '.credentials.json'], login: 'Chạy lại windows\\3-login.bat (bước Claude), hoặc mở Ubuntu, gõ "claude" rồi /login.' },
  codex: { label: 'Codex', cred: ['.codex', 'auth.json'], login: 'Chạy lại windows\\3-login.bat (bước Codex), hoặc mở Ubuntu và gõ "codex login".' },
  gemini: { label: 'Gemini CLI', cred: ['.gemini', 'oauth_creds.json'], login: 'Mở Ubuntu, gõ "gemini" và đăng nhập theo hướng dẫn.' },
};
const short = (s, n = 400) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

module.exports = function setupHealth({ on, send, readBody, getCtx, run, loadAccounts }) {
  const version = async (cmd) => {
    const r = await run(cmd, ['--version'], { timeout: 15000, cwd: os.tmpdir() });
    if (!r.ok) return { found: !/ENOENT/.test(r.err), text: '' };
    return { found: true, text: short((r.out || r.err).split('\n')[0], 80) };
  };

  async function checks(ctx) {
    const out = [];
    const add = (id, label, state, text, fix) => out.push({ id, label, state, text, ...(fix ? { fix } : {}) });
    const major = Number(process.versions.node.split('.')[0]), minor = Number(process.versions.node.split('.')[1]);
    add('node', 'Node.js', major >= 18 ? 'ok' : 'fail', 'bản ' + process.versions.node + (major > 22 || (major === 22 && minor >= 5) ? '' : ' (context-mode cần 22.5 trở lên, các phần khác vẫn chạy)'),
      major >= 18 ? '' : 'Chạy lại windows\\2-setup-tools.bat để cài Node.js mới hơn.');
    const git = await version('git');
    add('git', 'Git', git.found ? 'ok' : 'fail', git.text || 'chưa cài', git.found ? '' : 'Chạy lại windows\\2-setup-tools.bat.');
    if (git.found) {
      const n = await run('git', ['config', '--global', 'user.name'], { cwd: os.tmpdir() });
      add('gitid', 'Tên trong git', n.out.trim() ? 'ok' : 'warn', n.out.trim() || 'chưa đặt. Dashboard sẽ tự dùng tên agent khi lưu code.');
    }
    for (const [id, a] of Object.entries(AGENTS)) {
      const v = await version(id);
      if (!v.found) { add(id, a.label, id === 'gemini' ? 'warn' : 'fail', 'chưa cài' + (id === 'gemini' ? ' (chỉ cần nếu bạn dùng Gemini)' : ''), id === 'gemini' ? '' : 'Chạy lại windows\\2-setup-tools.bat.'); continue; }
      const logged = fs.existsSync(path.join(os.homedir(), ...a.cred));
      out.push({ id, label: a.label, state: logged ? 'ok' : 'warn', text: (v.text || 'đã cài') + (logged ? ' · có file đăng nhập' : ' · chưa thấy file đăng nhập'), ...(logged ? {} : { fix: a.login }), canTry: true });
    }
    for (const acc of loadAccounts()) {
      const logged = fs.existsSync(path.join(acc.dir, acc.agent === 'claude' ? '.credentials.json' : 'auth.json'));
      out.push({ id: 'acc:' + acc.id, label: 'Hồ sơ "' + acc.name + '"', state: logged ? 'ok' : 'warn', text: (AGENTS[acc.agent]?.label || acc.agent) + (logged ? ' · có file đăng nhập' : ' · chưa đăng nhập'),
        ...(logged ? {} : { fix: 'Mở tab Tài khoản và chạy dòng lệnh đăng nhập của hồ sơ này.' }), canTry: true, agent: acc.agent, account: acc.id });
    }
    const tv = await run('tmux', ['-V'], { timeout: 15000, cwd: os.tmpdir() }); const tmux = { found: tv.ok || !/ENOENT/.test(tv.err), text: tv.out.trim() };
    add('tmux', 'tmux', tmux.found ? 'ok' : 'warn', tmux.found ? tmux.text : 'chưa cài (chỉ cần cho kiểu Terminal)');
    if (ctx && ctx.kind !== 'office') {
      const r = await run('git', ['-C', ctx.root, 'rev-parse', '--is-inside-work-tree']);
      add('repo', 'Project đang chọn', r.ok ? 'ok' : 'fail', r.ok ? 'là repo git' : 'chưa phải repo git', r.ok ? '' : 'Xoá project khỏi danh sách rồi thêm lại với ô "Tự tạo repo git" được chọn.');
    }
    try {
      const probe = path.join(ctx.root, '.agents', '.write-test');
      fs.mkdirSync(path.dirname(probe), { recursive: true }); fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe);
      add('write', 'Quyền ghi vào project', 'ok', 'ghi được');
    } catch (e) { add('write', 'Quyền ghi vào project', 'fail', 'không ghi được: ' + short(e.message, 120), 'Kiểm tra thư mục project còn tồn tại và không bị khoá.'); }
    return out;
  }

  // Gọi thật một lượt rất ngắn (tốn vài token) để biết agent có trả lời được không.
  function tryAgent(agent, env, withPartial = true) {
    return new Promise((resolve) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-check-'));
      const spec = agent === 'claude' ? { args: ['-p', '--output-format', 'stream-json', '--verbose', ...(withPartial ? ['--include-partial-messages'] : [])], stdin: TRY_PROMPT }
        : agent === 'codex' ? { args: ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '--', TRY_PROMPT] }
          : { args: ['--output-format', 'stream-json', '--prompt=' + TRY_PROMPT] };
      const t0 = Date.now();
      const res = { ok: false, text: '', deltas: 0, usage: null, error: '' };
      let child;
      try { child = spawn(agent, spec.args, { cwd, env: { ...process.env, ...env }, stdio: [spec.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); }
      catch (e) { res.error = e.message; return resolve(res); }
      if (spec.stdin) { child.stdin.on('error', () => {}); child.stdin.end(spec.stdin); }
      let buf = '', err = '';
      const parse = (ev) => {
        if (ev.type === 'stream_event' && ev.event?.delta?.type === 'text_delta') res.deltas++;
        if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'text') res.text += c.text;
        if (ev.type === 'result') { if (ev.is_error) res.error = short(ev.result || ev.subtype); res.usage = ev.usage || null; }
        if (ev.type === 'item.completed' && /message/.test(ev.item?.type || '')) res.text += ev.item.text || '';
        if (ev.type === 'turn.completed') res.usage = ev.usage || null;
        if (ev.type === 'error' || ev.type === 'turn.failed') res.error = short(ev.message || ev.error?.message || JSON.stringify(ev));
        if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') res.text += ev.content;
      };
      child.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line.startsWith('{')) { try { parse(JSON.parse(line)); } catch { /* bỏ */ } } }
      });
      child.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
      const timer = setTimeout(() => { res.error = 'Quá 90 giây không thấy trả lời.'; try { child.kill('SIGKILL'); } catch { /* đã thoát */ } }, TRY_MS);
      child.on('error', (e) => { res.error = e.code === 'ENOENT' ? 'Chưa cài công cụ này trong WSL.' : e.message; });
      child.on('close', (code) => {
        clearTimeout(timer);
        try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* không sao */ }
        res.seconds = Math.round((Date.now() - t0) / 100) / 10;
        if (code && !res.error) res.error = short(err || 'Thoát với mã ' + code);
        res.unknownFlag = /unknown option.*include-partial-messages/i.test(err);
        res.text = short(res.text, 200);
        res.ok = !res.error && !!res.text;
        if (!res.ok && !res.error) res.error = 'Agent không trả lời gì.';
        resolve(res);
      });
    });
  }

  on('GET', /^\/api\/health$/, async (req, res, _m, url) => {
    let ctx = null;
    try { ctx = getCtx(url); } catch { /* chưa có project */ }
    send(res, 200, { checks: await checks(ctx) });
  });
  on('POST', /^\/api\/health\/try$/, async (req, res) => {
    const b = await readBody(req);
    const agent = String(b.agent || '');
    if (!AGENTS[agent]) return send(res, 400, { error: 'Không biết agent này.' });
    let env = {};
    if (b.account) {
      const acc = loadAccounts().find((x) => x.id === b.account && x.agent === agent);
      if (!acc) return send(res, 400, { error: 'Không tìm thấy hồ sơ.' });
      env = agent === 'claude' ? { CLAUDE_CONFIG_DIR: acc.dir } : { CODEX_HOME: acc.dir };
    }
    let r = await tryAgent(agent, env);
    let streaming = agent === 'claude' && r.deltas > 0 ? true : null; // null = không rõ (câu trả lời quá ngắn)
    if (agent === 'claude' && r.unknownFlag) { r = await tryAgent(agent, env, false); streaming = false; }
    send(res, 200, { ok: r.ok, text: r.text, seconds: r.seconds, error: r.error, streaming, usage: r.usage ? short(JSON.stringify(r.usage), 600) : '' });
  });
  return { checks, tryAgent };
};
