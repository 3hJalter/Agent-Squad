#!/usr/bin/env bash
# setup-agents.sh
# Dựng khung "lead + workers" trong một repo git (chạy trong WSL2 / Linux).
# Dùng:  cd ~/proj && bash /đường/dẫn/setup-agents.sh
# An toàn: file nào đã tồn tại sẽ KHÔNG bị ghi đè.
set -euo pipefail

[ -d .git ] || { echo "Lỗi: chạy trong thư mục gốc của repo git (chạy 'git init' trước)."; exit 1; }

put() { # put <path> : ghi stdin vào file nếu chưa có
  if [ -e "$1" ]; then echo "bỏ qua  $1 (đã có)"; cat >/dev/null
  else mkdir -p "$(dirname "$1")"; cat > "$1"; echo "đã tạo  $1"; fi
}

mkdir -p .agents/tasks .agents/handoff scripts

# .agents/ chứa trạng thái làm việc, không commit (các worktree sẽ symlink tới đây)
touch .gitignore
# Không có dấu "/" cuối: trong worktree .agents là symlink, ".agents/" sẽ không khớp.
sed -i '/^\.agents\/$/d' .gitignore
grep -qx '\.agents' .gitignore || echo '.agents' >> .gitignore

# ---------------------------------------------------------------- AGENTS.md
put AGENTS.md <<'EOF'
# Agent rules (shared by ALL agents: lead and workers)

## Roles
- LEAD (tmux window "lead"; Claude Code by default, can be Codex or Gemini): the only agent that
  talks to the human by default. Plans, writes task files, assigns workers, reads task summaries.
  Does NOT read or edit source code itself; it delegates. Its extra rules are in CLAUDE.md.
- WORKERS (the other tmux windows, listed in .agents/workers.txt): each works in its own git
  worktree and branch (agent/<name>) and executes ONE task at a time from .agents/tasks/<ID>.md.

## Task protocol
1. Tasks live in .agents/tasks/<ID>.md (copy of _template.md). One owner per task.
2. Workers read ONLY the task file and the files in its scope. Do not explore the whole repo.
3. Edit only the files listed under "Files you may edit". If you need others: stop, write the
   question under "Notes / questions", then set Status: blocked.
4. When finished: run the checks listed in the task, commit on your branch, fill "Result"
   (max 5 lines: what changed, files, check outcome), then set Status: done as the LAST step.
   scripts/watch-tasks.sh notifies the lead automatically when Status becomes done or blocked;
   you do not need to run any notify command.
5. DIRECT INSTRUCTIONS FROM THE HUMAN: if the human talks to you directly and changes anything,
   first append one line to "Changes by human" in the task file (date, change, reason), then
   proceed. The lead must never be unaware of a change.
6. Be terse in chat. Details go into the task file, not the conversation.

## Cost rules
- Keep context small. Never paste large files into chat.
- Search with ripgrep (rg); fall back to grep only if rg fails.
- The lead reads only Status and Result of a task, not diffs, unless the human asks.
- Do not poll or re-check tasks that are not marked done. Do not loop on failures: after 2 failed
  attempts, set Status: blocked and explain in Notes.

## Project conventions
(Fill in: language/framework, how to run tests/lint, code style, folders to avoid.)
EOF

# ---------------------------------------------------------------- CLAUDE.md
put CLAUDE.md <<'EOF'
@AGENTS.md

# Extra rules for the LEAD (whichever agent runs in tmux window "lead")
- You are the lead. Turn the human's request into small, self-contained tasks.
- Create a task: copy .agents/tasks/_template.md to .agents/tasks/T-<next number>.md and fill
  Goal, Files you may edit, Context (link files, do not paste), Done when.
- Assign: run `scripts/assign.sh T-<n> <worker>` (worker names: .agents/workers.txt). If that fails
  (e.g. your sandbox blocks tmux), set `Owner: <worker>` and `Status: ready` in the task file;
  scripts/watch-tasks.sh assigns it. Then STOP and tell the human in one line which task went to
  whom. Do not wait, poll or watch the worker.
- When a worker notifies you, read only that task's Status and Result, then report in <= 3 lines.
- Give each task a disjoint set of files; never assign overlapping files to two workers.
- If the human says they changed something directly with a worker, re-read that task file
  before planning anything related to it.
- The human may be non-technical and uses a web dashboard. Reply in the human's language, in plain
  words, short. Never ask them to type commands: do it yourself (or have a worker do it).
- "Merge"/"gộp" finished work: in your own directory, `git merge --no-edit agent/<worker>` for each
  done task's owner, run the project's checks, then report. On conflicts: stop and explain simply.
- "Push": `git push` the current branch (set upstream if needed). Report the result in one line.
EOF

# ---------------------------------------------------------------- task template
put .agents/tasks/_template.md <<'EOF'
# T-XXX: <short title>
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
EOF

# ---------------------------------------------------------------- scripts
put scripts/start-agents.sh <<'EOF'
#!/usr/bin/env bash
# Dựng phiên tmux: window "lead" + mỗi worker một window (mỗi worker một git worktree),
# và window "watch" chạy watch-tasks.sh (báo lead khi task xong/bị chặn, tự giao task "ready").
# Dùng:  scripts/start-agents.sh                                  (lead claude, 1 worker codex)
#        WORKERS="codex gemini" scripts/start-agents.sh
#        LEAD="codex@gpt-6.1-sol#high" WORKERS="claude@sonnet#medium codex#low" scripts/start-agents.sh
# Mỗi agent viết <agent>[@<model>][#<effort>], agent: claude | codex | gemini.
# Tên window worker = agent, hoặc agent-<model> khi có model (ký tự lạ đổi thành "-";
# model đã bắt đầu bằng tên agent thì chỉ dùng model, ví dụ gemini-3-5-flash).
# AGENTS_ROOT=<repo khác> chạy cho repo đó bằng chính các script này.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${AGENTS_ROOT:-$HERE/..}" && pwd)"
NAME="$(basename "$ROOT")"
SESSION="${SESSION:-agents}"
WORKERS="${WORKERS:-codex}"
LEAD="${LEAD:-claude${LEAD_MODEL:+@$LEAD_MODEL}}"
SAFE='^[A-Za-z0-9._:/-]*$'

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Phiên đã tồn tại. Vào bằng: tmux attach -t $SESSION"; exit 0
fi
cd "$ROOT"
git rev-parse HEAD >/dev/null 2>&1 || { echo "Repo chưa có commit nào. Hãy commit trước."; exit 1; }
mkdir -p "$ROOT/.agents/tasks"

parse() { # parse <spec> -> đặt biến agent, model, effort; trả về 1 nếu không hợp lệ
  local s="$1"; effort=""; model=""
  case "$s" in *'#'*) effort="${s##*#}"; s="${s%#*}" ;; esac
  agent="${s%%@*}"; [ "$agent" = "$s" ] || model="${s#*@}"
  [[ "$agent" =~ ^(claude|codex|gemini)$ && "$model" =~ $SAFE && "$effort" =~ ^[a-z]*$ ]]
}

LEAD_PROMPT="You are the LEAD in tmux window \"lead\". Follow the LEAD rules in CLAUDE.md and the shared rules in AGENTS.md. Available workers are listed in .agents/workers.txt. If running scripts/assign.sh fails (for example because your sandbox blocks tmux), set \"Owner: <worker>\" and \"Status: ready\" in the task file instead; the watcher assigns it. Reply \"ready\" and wait for the human."
cmd_for() { # cmd_for <lead|worker> <window> -> lệnh chạy agent (dùng agent/model/effort)
  local role="$1" w="$2" c
  case "$agent" in
    claude)
      c="claude${model:+ --model '$model'}${effort:+ --effort '$effort'}"
      [ "$role" = lead ] || c="$c --add-dir '$ROOT/.agents' --append-system-prompt 'You are a WORKER (tmux window $w), not the lead: ignore the LEAD rules in CLAUDE.md and follow the worker rules in AGENTS.md.'" ;;
    codex)
      # .agents là symlink ra ngoài worktree: cho Codex quyền ghi vào đó (--add-dir cần sandbox workspace-write)
      c="codex --sandbox workspace-write --add-dir '$ROOT/.agents'${model:+ -m '$model'}${effort:+ -c 'model_reasoning_effort=\"$effort\"'}"
      [ "$role" = worker ] || c="$c '$LEAD_PROMPT'" ;;
    gemini)
      c="gemini --include-directories '$ROOT/.agents'${model:+ -m '$model'}"
      [ "$role" = worker ] || c="$c -i '$LEAD_PROMPT'" ;;
  esac
  printf '%s' "$c"
}

parse "$LEAD" || { echo "LEAD không hợp lệ: $LEAD"; exit 1; }
LEADCMD="$(cmd_for lead lead)"
: > "$ROOT/.agents/workers.txt"
ENVS=(-e "SESSION=$SESSION" -e "AGENTS_ROOT=$ROOT")
tmux new-session -d -s "$SESSION" -n lead -c "$ROOT" "${ENVS[@]}" "$LEADCMD; exec bash"
for spec in $WORKERS; do
  if ! parse "$spec"; then echo "Bỏ qua worker không hợp lệ: $spec"; continue; fi
  w="$agent"; m="$(printf '%s' "$model" | tr -c 'A-Za-z0-9_-' '-')"
  case "$m" in "") ;; "$agent"*) w="$m" ;; *) w="$agent-$m" ;; esac
  WT="$ROOT/../$NAME-$w"
  if [ ! -d "$WT" ]; then
    git worktree add "$WT" -b "agent/$w" 2>/dev/null || git worktree add "$WT" "agent/$w"
  fi
  # dùng chung thư mục task với lead (không ghi đè nếu .agents trong worktree là thư mục thật)
  [ -d "$WT/.agents" ] && [ ! -L "$WT/.agents" ] || ln -sfn "$ROOT/.agents" "$WT/.agents"
  tmux new-window -t "$SESSION" -n "$w" -c "$WT" "${ENVS[@]}" "$(cmd_for worker "$w"); exec bash"
  echo "$w  ($agent${model:+, model $model}${effort:+, effort $effort})" >> "$ROOT/.agents/workers.txt"
done
tmux new-window -d -t "$SESSION" -n watch -c "$ROOT" "${ENVS[@]}" "'$HERE/watch-tasks.sh'; exec bash"
tmux select-window -t "$SESSION:lead"
echo "Xong. Vào bằng: tmux attach -t $SESSION   (Ctrl-b n/p: đổi window, Ctrl-b d: thoát ra)"
EOF

put scripts/assign.sh <<'EOF'
#!/usr/bin/env bash
# Lead gọi: scripts/assign.sh T-001 codex   (tên worker: xem .agents/workers.txt)
set -euo pipefail
ID="${1:?task id}"; W="${2:?worker (xem .agents/workers.txt)}"; SESSION="${SESSION:-agents}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${AGENTS_ROOT:-$HERE/..}" && pwd)"
F="$ROOT/.agents/tasks/$ID.md"
[ -f "$F" ] || { echo "Không có $F"; exit 1; }
tmux list-windows -t "$SESSION" -F '#W' 2>/dev/null | grep -qx -- "$W" || { echo "Không có window $W trong phiên $SESSION"; exit 1; }
sed -i "s/^Owner:.*/Owner: $W/; s/^Status:.*/Status: in-progress/" "$F"
BASE="$(git -C "$ROOT" branch --show-current 2>/dev/null || true)"
MSG="Do task $ID: ${BASE:+first run 'git merge --no-edit $BASE' to get the latest code (on conflicts set Status: blocked and explain), then }read .agents/tasks/$ID.md and AGENTS.md, follow the task protocol exactly. Be terse."
tmux send-keys -t "$SESSION:$W" -l "$MSG"
sleep 0.4
tmux send-keys -t "$SESSION:$W" Enter
echo "Đã giao $ID cho $W"
EOF

put scripts/notify.sh <<'EOF'
#!/usr/bin/env bash
# Báo lead về một task: scripts/notify.sh T-001 (watch-tasks.sh tự gọi; cũng gọi tay được)
set -euo pipefail
ID="${1:?task id}"; SESSION="${SESSION:-agents}"
tmux send-keys -t "$SESSION:lead" -l "Worker updated $ID. Read only its Status and Result in .agents/tasks/$ID.md, then report to me in 3 lines max."
sleep 0.4
tmux send-keys -t "$SESSION:lead" Enter
EOF

put scripts/watch-tasks.sh <<'EOF'
#!/usr/bin/env bash
# Chạy nền trong window "watch" (start-agents.sh tự bật). Không tốn token:
# mỗi vài giây đọc dòng "Status:" của .agents/tasks/T-*.md;
# - done/blocked: gõ thông báo vào window lead (thay cho việc worker tự gọi tmux,
#   vì sandbox của worker có thể chặn tmux);
# - ready: giao task cho worker ở dòng "Owner:" (cho lead không gọi được tmux, ví dụ Codex).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${AGENTS_ROOT:-$HERE/..}" && pwd)"
DIR="$ROOT/.agents/tasks"; SESSION="${SESSION:-agents}"; INTERVAL="${INTERVAL:-5}"
export AGENTS_ROOT="$ROOT" SESSION
declare -A last

field() { sed -n "s/^$1:[[:space:]]*//p" "$2" | head -n1 | tr -d '\r[:space:]'; }

scan() { # scan <notify 0|1>
  local f id st
  for f in "$DIR"/T-*.md; do
    [ -f "$f" ] || continue
    id="$(basename "$f" .md)"; st="$(field Status "$f")"
    if [ "$st" = ready ]; then
      "$HERE/assign.sh" "$id" "$(field Owner "$f")" && echo "$(date +%T) $id -> đã giao (ready)"
      st="$(field Status "$f")"
    elif [ "$1" = 1 ] && [ "${last[$id]:-}" != "$st" ] && { [ "$st" = done ] || [ "$st" = blocked ]; }; then
      "$HERE/notify.sh" "$id" && echo "$(date +%T) $id -> $st (đã báo lead)"
    fi
    last[$id]="$st"
  done
}

mkdir -p "$DIR"
scan 0
echo "Đang theo dõi $DIR (mỗi ${INTERVAL}s). Ctrl-c để dừng."
while sleep "$INTERVAL"; do scan 1; done
EOF

chmod +x scripts/*.sh

cat <<'EOF'

Hoàn tất. Bước tiếp theo:
  1. Mở AGENTS.md, điền phần "Project conventions".
  2. git add AGENTS.md CLAUDE.md scripts .gitignore && git commit -m "agent scaffolding"
     (bắt buộc commit trước, vì worktree của worker lấy file từ commit)
  3. scripts/start-agents.sh      rồi      tmux attach -t agents
EOF
