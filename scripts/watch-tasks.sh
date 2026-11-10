#!/usr/bin/env bash
# Chạy nền trong window "watch" (start-agents.sh tự bật). Không tốn token:
# mỗi vài giây đọc dòng "Status:" của .agents/tasks/T-*.md; khi một task chuyển sang
# done hoặc blocked thì gõ thông báo vào window lead (thay cho việc worker tự gọi tmux,
# vì sandbox của worker có thể chặn tmux).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/.agents/tasks"; SESSION="${SESSION:-agents}"; INTERVAL="${INTERVAL:-5}"
declare -A last

status_of() { sed -n 's/^Status:[[:space:]]*//p' "$1" | head -n1 | tr -d '\r[:space:]'; }

scan() { # scan <notify 0|1>
  local f id st
  for f in "$DIR"/T-*.md; do
    [ -f "$f" ] || continue
    id="$(basename "$f" .md)"; st="$(status_of "$f")"
    if [ "$1" = 1 ] && [ "${last[$id]:-}" != "$st" ] && { [ "$st" = done ] || [ "$st" = blocked ]; }; then
      SESSION="$SESSION" "$ROOT/scripts/notify.sh" "$id" && echo "$(date +%T) $id -> $st (đã báo lead)"
    fi
    last[$id]="$st"
  done
}

mkdir -p "$DIR"
scan 0
echo "Đang theo dõi $DIR (mỗi ${INTERVAL}s). Ctrl-c để dừng."
while sleep "$INTERVAL"; do scan 1; done
