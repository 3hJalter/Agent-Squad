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
