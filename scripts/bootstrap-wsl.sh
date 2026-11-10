#!/usr/bin/env bash
# Chạy trong Ubuntu (WSL2): cài công cụ, clone repo, tạo mẫu task.
set -euo pipefail
sudo apt-get update
sudo apt-get install -y git tmux ripgrep curl
if [ ! -d "$HOME/.nvm" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
fi
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install --lts
# .bashrc bỏ qua shell không tương tác (wsl -e bash -lc ...), nên nạp nvm cả trong ~/.profile
# để các file .bat tìm thấy lệnh codex.
grep -q 'NVM_DIR/nvm.sh' "$HOME/.profile" 2>/dev/null || \
  printf '\nexport NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n' >> "$HOME/.profile"
command -v codex >/dev/null || npm i -g @openai/codex
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash
[ -d "$HOME/Agent-Squad" ] || git clone https://github.com/3hJalter/Agent-Squad "$HOME/Agent-Squad"
cd "$HOME/Agent-Squad" && bash scripts/setup-agents.sh >/dev/null
echo
echo "Cài xong. Bước tiếp: chạy 3-login.bat để đăng nhập claude và codex."
echo "Nếu 'claude' báo không tìm thấy lệnh, đóng cửa sổ và mở lại."
