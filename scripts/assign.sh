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
