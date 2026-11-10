@echo off
rem Mo web dashboard: chay server trong WSL roi mo trinh duyet o http://localhost:7070
start "" /min cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:7070"
wsl -d Ubuntu -e bash -lc "cd ~/Agent-Squad && scripts/dashboard.sh"
pause
