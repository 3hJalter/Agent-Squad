#!/usr/bin/env bash
# Mở web dashboard: scripts/dashboard.sh   rồi vào http://localhost:7070 (trình duyệt Windows cũng được).
# Điều khiển repo khác:  REPO=~/proj scripts/dashboard.sh   (repo đó phải đã chạy setup-agents.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi
command -v node >/dev/null 2>&1 || { echo "Không tìm thấy node. Chạy lại 2-setup-tools.bat."; exit 1; }
exec node "$ROOT/dashboard/server.js"
