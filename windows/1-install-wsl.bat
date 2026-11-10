@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
wsl --install -d Ubuntu
echo.
echo Xong. Hay KHOI DONG LAI may. Sau do mo "Ubuntu" tu menu Start, dat username/password,
echo roi chay 2-setup-tools.bat
pause
