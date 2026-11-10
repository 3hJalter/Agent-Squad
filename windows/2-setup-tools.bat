@echo off
echo Cai cong cu trong Ubuntu (se hoi password Linux ban da dat)...
wsl -d Ubuntu -e bash -lc "curl -fsSL https://raw.githubusercontent.com/3hJalter/Agent-Squad/main/scripts/bootstrap-wsl.sh | bash"
pause
