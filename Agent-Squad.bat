@echo off
title Agent-Squad
rem Double-click de chay: cap nhat code trong WSL, bat cac agent (tmux) va mo dashboard.
rem Cua so "Agent-Squad server" (thu nho) phai de mo; dong no la tat dashboard va co the tat ca agent.
set URL=http://localhost:7070

curl -sf -o nul %URL%/api/state && goto open

echo Dang khoi dong Agent-Squad (cap nhat code, bat agent, mo dashboard)...
start "Agent-Squad server" /min wsl -d Ubuntu -e bash -lc "cd ~/Agent-Squad && (git pull -q --ff-only || echo 'Bo qua git pull'); scripts/start-agents.sh; scripts/dashboard.sh; echo; echo 'Dashboard da dung.'; read -r -p 'Enter de dong...'"

set /a n=0
:wait
timeout /t 1 /nobreak >nul
curl -sf -o nul %URL%/api/state && goto open
set /a n+=1
if %n% lss 40 goto wait
echo.
echo Loi: dashboard khong chay sau 40 giay. Mo cua so "Agent-Squad server" o thanh taskbar de xem loi.
pause
exit /b 1

:open
start "" msedge --app=%URL%
exit /b 0
