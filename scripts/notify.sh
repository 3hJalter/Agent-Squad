#!/usr/bin/env bash
# Báo lead về một task: scripts/notify.sh T-001 (watch-tasks.sh tự gọi; cũng gọi tay được)
set -euo pipefail
ID="${1:?task id}"; SESSION="${SESSION:-agents}"
tmux send-keys -t "$SESSION:lead" -l "Worker updated $ID. Read only its Status and Result in .agents/tasks/$ID.md, then report to me in 3 lines max."
sleep 0.4
tmux send-keys -t "$SESSION:lead" Enter
