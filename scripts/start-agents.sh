#!/usr/bin/env bash
# Dựng phiên tmux: window "lead" (claude) + mỗi worker một window, mỗi worker một git worktree.
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

tmux new-session -d -s "$SESSION" -n lead -c "$ROOT" "claude; exec bash"
for w in $WORKERS; do
  WT="$ROOT/../$NAME-$w"
  if [ ! -d "$WT" ]; then
    git worktree add "$WT" -b "agent/$w" 2>/dev/null || git worktree add "$WT" "agent/$w"
  fi
  ln -sfn "$ROOT/.agents" "$WT/.agents"   # dùng chung thư mục task với lead
  tmux new-window -t "$SESSION" -n "$w" -c "$WT" "$w; exec bash"
done
tmux select-window -t "$SESSION:lead"
echo "Xong. Vào bằng: tmux attach -t $SESSION   (Ctrl-b n/p: đổi window, Ctrl-b d: thoát ra)"
