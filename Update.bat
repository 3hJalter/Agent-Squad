@echo off
title Cap nhat Agent-Squad
rem Double-click de tai ban Agent-Squad moi nhat (ca ban trong WSL va ban o thu muc nay).
rem Dashboard dang chay se tu khoi dong lai; cac agent dang chay khong bi anh huong.
set URL=http://localhost:7070

echo [1/2] Cap nhat ban trong WSL (~/Agent-Squad)...
curl -sf -o nul %URL%/api/projects
if errorlevel 1 (
  wsl -d Ubuntu -e bash -lc "cd ~/Agent-Squad && git pull --ff-only"
) else (
  curl -s -X POST -H "X-Squad: 1" %URL%/api/update
  echo.
)

echo [2/2] Cap nhat ban o thu muc nay (%~dp0)...
where git >nul 2>&1
if errorlevel 1 (
  echo Bo qua: Windows chua cai git. Ban trong WSL moi la ban dang chay, nen van dung binh thuong.
) else (
  git -C "%~dp0." pull --ff-only
)
echo.
echo Xong.
pause
