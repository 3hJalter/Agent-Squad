#!/usr/bin/env bash
# Báo người tạo task (dòng "Created by:", mặc định lead): scripts/notify.sh T-001
# (watch-tasks.sh tự gọi; cũng gọi tay được)
set -euo pipefail
ID="${1:?task id}"; SESSION="${SESSION:-agents}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${AGENTS_ROOT:-$HERE/..}" && pwd)"
TO="$(sed -n 's/^Created by:[[:space:]]*//p' "$ROOT/.agents/tasks/$ID.md" 2>/dev/null | head -n1 | tr -d '\r[:space:]')"
TO="${TO:-lead}"
tmux send-keys -t "$SESSION:$TO" -l "Worker updated $ID. Read only its Status and Result in .agents/tasks/$ID.md, then report to me in 3 lines max."
sleep 0.4
tmux send-keys -t "$SESSION:$TO" Enter
