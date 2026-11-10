#!/usr/bin/env bash
# Lead gọi: scripts/assign.sh T-001 codex
set -euo pipefail
ID="${1:?task id}"; W="${2:?worker (codex|gemini)}"; SESSION="${SESSION:-agents}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$ROOT/.agents/tasks/$ID.md"
[ -f "$F" ] || { echo "Không có $F"; exit 1; }
sed -i "s/^Owner:.*/Owner: $W/; s/^Status:.*/Status: in-progress/" "$F"
MSG="Do task $ID: read .agents/tasks/$ID.md and AGENTS.md, follow the task protocol exactly. Be terse."
tmux send-keys -t "$SESSION:$W" -l "$MSG"
sleep 0.4
tmux send-keys -t "$SESSION:$W" Enter
echo "Đã giao $ID cho $W"
