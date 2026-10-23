@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm not found. Install it first:  npm install -g pnpm
  pause
  exit /b 1
)

if not exist node_modules (
  echo [INFO] First run - installing dependencies...
  pnpm install
  if errorlevel 1 ( echo [ERROR] pnpm install failed. & pause & exit /b 1 )
)

node scripts\gen-manifest.mjs

echo [INFO] Building...
pnpm build
if errorlevel 1 ( echo [ERROR] build failed. & pause & exit /b 1 )

echo [OK] Build complete -^> dist\  ^(deploy together with assets\ and scenes\^)

endlocal
