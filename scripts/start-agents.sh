#!/usr/bin/env bash
# Dựng phiên tmux: window "lead" + mỗi worker một window (mỗi worker một git worktree),
# và window "watch" chạy watch-tasks.sh (báo lead khi task xong/bị chặn, tự giao task "ready").
# Dùng:  scripts/start-agents.sh                                  (lead claude, 1 worker codex)
#        WORKERS="codex gemini" scripts/start-agents.sh
#        LEAD="codex@gpt-6.1-sol#high" WORKERS="claude@sonnet#medium codex#low" scripts/start-agents.sh
# Mỗi agent viết <agent>[@<model>][#<effort>], agent: claude | codex | gemini.
# Worker có thể đặt tên riêng: <tên>=<agent>..., ví dụ WORKERS="frontend=codex#high backend=codex#low".
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
GITDIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$ROOT/.git")"

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
      # Codex chặn mọi lệnh nếu .agents trong worktree là symlink, nên worker Codex không có symlink:
      # dùng thẳng $ROOT/.agents và .git chung (--add-dir cần sandbox workspace-write)
      c="codex --sandbox workspace-write --add-dir '$ROOT/.agents' --add-dir '$GITDIR'${model:+ -m '$model'}${effort:+ -c 'model_reasoning_effort=\"$effort\"'}"
      if [ "$role" = worker ]; then
        c="$c 'You are a WORKER (tmux window $w), not the lead: ignore the LEAD rules in CLAUDE.md and follow the worker rules in AGENTS.md. Your worktree has no .agents folder: wherever the rules or messages say \".agents/\", use $ROOT/.agents/ instead. Reply \"ready\" and wait.'"
      else c="$c '$LEAD_PROMPT'"; fi ;;
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
  w=""; case "$spec" in *=*) w="${spec%%=*}"; spec="${spec#*=}" ;; esac
  if ! parse "$spec"; then echo "Bỏ qua worker không hợp lệ: $spec"; continue; fi
  if [ -z "$w" ]; then
    w="$agent"; m="$(printf '%s' "$model" | tr -c 'A-Za-z0-9_-' '-')"
    case "$m" in "") ;; "$agent"*) w="$m" ;; *) w="$agent-$m" ;; esac
  fi
  if [[ ! "$w" =~ ^[A-Za-z0-9_-]{1,30}$ || "$w" = lead || "$w" = watch ]] || tmux list-windows -t "$SESSION" -F '#W' | grep -qx -- "$w"; then
    echo "Bỏ qua worker: tên \"$w\" không hợp lệ hoặc bị trùng"; continue
  fi
  WT="$ROOT/../$NAME-$w"
  if [ ! -d "$WT" ]; then
    git worktree add "$WT" -b "agent/$w" 2>/dev/null || git worktree add "$WT" "agent/$w"
  fi
  # dùng chung thư mục task với lead (không ghi đè nếu .agents trong worktree là thư mục thật);
  # riêng Codex: không có symlink (xem cmd_for)
  if [ ! -d "$WT/.agents" ] || [ -L "$WT/.agents" ]; then
    rm -f "$WT/.agents"
    [ "$agent" = codex ] || ln -s "$ROOT/.agents" "$WT/.agents"
  fi
  tmux new-window -t "$SESSION" -n "$w" -c "$WT" "${ENVS[@]}" "$(cmd_for worker "$w"); exec bash"
  echo "$w  ($agent${model:+, model $model}${effort:+, effort $effort})" >> "$ROOT/.agents/workers.txt"
done
tmux new-window -d -t "$SESSION" -n watch -c "$ROOT" "${ENVS[@]}" "'$HERE/watch-tasks.sh'; exec bash"
tmux select-window -t "$SESSION:lead"
echo "Xong. Vào bằng: tmux attach -t $SESSION   (Ctrl-b n/p: đổi window, Ctrl-b d: thoát ra)"
