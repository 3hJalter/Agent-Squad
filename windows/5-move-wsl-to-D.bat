@echo off
rem Chuyen Ubuntu (WSL) tu o C: sang o khac (mac dinh D:\WSL\Ubuntu), giu nguyen du lieu.
rem Can WSL ban moi (lenh "wsl --manage --move"). Khong xoa gi neu lenh di chuyen that bai.
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
title Chuyen Ubuntu sang o D
set DISTRO=Ubuntu
set TARGET=D:\WSL\Ubuntu

echo Se chuyen %DISTRO% (gom project, worker, cong cu da cai) sang %TARGET%.
echo Du lieu duoc giu nguyen. Co the mat vai phut toi vai chuc phut tuy dung luong.
echo.
echo TRUOC KHI TIEP TUC: dong cua so dashboard va cua so "Agent-Squad server".
echo Moi thu dang chay trong Ubuntu se bi tat.
echo.
powershell -NoProfile -Command "$l = ((wsl -l -q) -replace [char]0,'') | ForEach-Object { $_.Trim() }; if ($l -contains '%DISTRO%') { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo Loi: khong tim thay Ubuntu ten "%DISTRO%" trong WSL.
  goto end
)
if not exist D:\ (
  echo Loi: may khong co o D:.
  goto end
)
if exist "%TARGET%\ext4.vhdx" (
  echo Ubuntu da nam o %TARGET% roi. Khong can chuyen nua.
  goto end
)
choice /c YN /m "Tiep tuc chuyen sang %TARGET%"
if errorlevel 2 goto end

echo.
echo [1/3] Tat WSL...
wsl --shutdown
if not exist "%TARGET%" mkdir "%TARGET%"

echo [2/3] Dang chuyen (dung dong cua so nay)...
wsl --manage %DISTRO% --move "%TARGET%"
if %errorlevel% equ 0 goto ok

echo.
echo Lenh chuyen chua co trong ban WSL nay. Dang cap nhat WSL roi thu lai...
wsl --update
wsl --shutdown
wsl --manage %DISTRO% --move "%TARGET%"
if %errorlevel% equ 0 goto ok

echo.
echo Khong chuyen duoc. Ubuntu van o cho cu, KHONG mat du lieu.
echo Chup man hinh cua so nay gui cho Claude de duoc huong dan tiep.
goto end

:ok
echo [3/3] Kiem tra...
wsl -d %DISTRO% -e bash -lc "echo Ubuntu chay binh thuong, user: $(whoami)"
echo.
echo Xong. Ubuntu gio nam o %TARGET%. Mo lai Agent-Squad.bat de lam viec nhu cu.
echo O C: se trong ra khoang dung luong cua file ext4.vhdx cu.

:end
echo.
pause
