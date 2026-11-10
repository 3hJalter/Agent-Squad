@echo off
echo [1/2] Dang nhap Claude: lam theo huong dan, xong go /exit
wsl -d Ubuntu -e bash -lc "claude"
echo [2/2] Dang nhap Codex: chon "Sign in with ChatGPT", xong thoat
wsl -d Ubuntu -e bash -lc "codex"
pause
