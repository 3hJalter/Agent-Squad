#!/usr/bin/env bash
# Dựng phiên tmux: window "lead" (claude) + mỗi worker một window, mỗi worker một git worktree,
# và window "watch" chạy scripts/watch-tasks.sh để báo lead khi task xong/bị chặn.
# Dùng:  scripts/start-agents.sh                          (lead claude, 1 worker codex)
#        WORKERS="codex gemini" scripts/start-agents.sh
#        WORKERS="codex@gpt-5-codex claude@sonnet" LEAD_MODEL=opus scripts/start-agents.sh
# Mỗi worker là <agent>[@<model>], agent: codex | claude | gemini. Tên window = agent, hoặc
# agent-<model> khi có model (dấu chấm đổi thành "-").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="$(basename "$ROOT")"
SESSION="${SESSION:-agents}"
WORKERS="${WORKERS:-codex}"
LEAD_MODEL="${LEAD_MODEL:-}"
SAFE='^[A-Za-z0-9._:/-]*$'

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Phiên đã tồn tại. Vào bằng: tmux attach -t $SESSION"; exit 0
fi
cd "$ROOT"
git rev-parse HEAD >/dev/null 2>&1 || { echo "Repo chưa có commit nào. Hãy commit trước."; exit 1; }
mkdir -p "$ROOT/.agents/tasks"
[[ "$LEAD_MODEL" =~ $SAFE ]] || { echo "LEAD_MODEL không hợp lệ: $LEAD_MODEL"; exit 1; }

tmux new-session -d -s "$SESSION" -n lead -c "$ROOT" "claude${LEAD_MODEL:+ --model '$LEAD_MODEL'}; exec bash"
for spec in $WORKERS; do
  agent="${spec%%@*}"; model=""; [ "$agent" = "$spec" ] || model="${spec#*@}"
  if ! [[ "$agent" =~ ^[A-Za-z0-9_-]+$ && "$model" =~ $SAFE ]]; then echo "Bỏ qua worker không hợp lệ: $spec"; continue; fi
  w="$agent"; [ -z "$model" ] || w="$agent-$(printf '%s' "$model" | tr -c 'A-Za-z0-9_-' '-')"
  WT="$ROOT/../$NAME-$w"
  if [ ! -d "$WT" ]; then
    git worktree add "$WT" -b "agent/$w" 2>/dev/null || git worktree add "$WT" "agent/$w"
  fi
  # dùng chung thư mục task với lead (không ghi đè nếu .agents trong worktree là thư mục thật)
  [ -d "$WT/.agents" ] && [ ! -L "$WT/.agents" ] || ln -sfn "$ROOT/.agents" "$WT/.agents"
  case "$agent" in
    # .agents là symlink ra ngoài worktree: cho Codex quyền ghi vào đó (--add-dir cần sandbox workspace-write)
    codex)  CMD="codex --sandbox workspace-write --add-dir '$ROOT/.agents'${model:+ -m '$model'}" ;;
    # CLAUDE.md có luật cho lead: nói rõ đây là worker
    claude) CMD="claude --add-dir '$ROOT/.agents'${model:+ --model '$model'} --append-system-prompt 'You are a WORKER (tmux window $w), not the lead: ignore the LEAD rules in CLAUDE.md and follow the worker rules in AGENTS.md.'" ;;
    gemini) CMD="gemini${model:+ -m '$model'}" ;;
    *)      CMD="$agent" ;;
  esac
  tmux new-window -t "$SESSION" -n "$w" -c "$WT" "$CMD; exec bash"
done
tmux new-window -d -t "$SESSION" -n watch -c "$ROOT" "SESSION='$SESSION' scripts/watch-tasks.sh; exec bash"
tmux select-window -t "$SESSION:lead"
echo "Xong. Vào bằng: tmux attach -t $SESSION   (Ctrl-b n/p: đổi window, Ctrl-b d: thoát ra)"
