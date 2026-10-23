@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

if not exist dist (
  echo [ERROR] dist\ not found. Run build.bat first.
  pause
  exit /b 1
)

echo [INFO] Preview production build at http://localhost:4173 ...
pnpm preview

endlocal
