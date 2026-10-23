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
if errorlevel 1 ( echo [ERROR] gen-manifest failed. & pause & exit /b 1 )

rem 导入导出插件服务（plugins/threejs-interchange，独立进程，端口 5175；重复启动自动复用现有实例）
echo [INFO] Starting interchange plugin service at http://127.0.0.1:5175 ...
start "3d-layout-interchange" /min cmd /c "cd /d %~dp0..\..\plugins\threejs-interchange && (if not exist node_modules pnpm install) && (if not exist ui-dist pnpm build) && pnpm start"

echo [INFO] Starting dev server at http://localhost:5173 ...
pnpm dev --open
if errorlevel 1 ( echo [ERROR] Dev server exited with an error. & pause ) else ( echo [INFO] Dev server exited. & pause )

endlocal
