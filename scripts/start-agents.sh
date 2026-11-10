#!/usr/bin/env bash
# Dựng phiên tmux: window "lead" (claude) + mỗi worker một window, mỗi worker một git worktree,
# và window "watch" chạy scripts/watch-tasks.sh để báo lead khi task xong/bị chặn.
# Dùng:  scripts/start-agents.sh            (chỉ codex)
#        WORKERS="codex gemini" scripts/start-agents.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="$(basename "$ROOT")"
SESSION="${SESSION:-agents}"
WORKERS="${WORKERS:-codex}"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Phiên đã tồn tại. Vào bằng: tmux attach -t $SESSION"; exit 0
fi
cd "$ROOT"
git rev-parse HEAD >/dev/null 2>&1 || { echo "Repo chưa có commit nào. Hãy commit trước."; exit 1; }
mkdir -p "$ROOT/.agents/tasks"

tmux new-session -d -s "$SESSION" -n lead -c "$ROOT" "claude; exec bash"
for w in $WORKERS; do
  WT="$ROOT/../$NAME-$w"
  if [ ! -d "$WT" ]; then
    git worktree add "$WT" -b "agent/$w" 2>/dev/null || git worktree add "$WT" "agent/$w"
  fi
  # dùng chung thư mục task với lead (không ghi đè nếu .agents trong worktree là thư mục thật)
  [ -d "$WT/.agents" ] && [ ! -L "$WT/.agents" ] || ln -sfn "$ROOT/.agents" "$WT/.agents"
  case "$w" in
    # .agents là symlink ra ngoài worktree: cho Codex quyền ghi vào đó trong sandbox
    codex) CMD="codex --add-dir '$ROOT/.agents'" ;;
    *)     CMD="$w" ;;
  esac
  tmux new-window -t "$SESSION" -n "$w" -c "$WT" "$CMD; exec bash"
done
tmux new-window -d -t "$SESSION" -n watch -c "$ROOT" "SESSION='$SESSION' scripts/watch-tasks.sh; exec bash"
tmux select-window -t "$SESSION:lead"
echo "Xong. Vào bằng: tmux attach -t $SESSION   (Ctrl-b n/p: đổi window, Ctrl-b d: thoát ra)"
