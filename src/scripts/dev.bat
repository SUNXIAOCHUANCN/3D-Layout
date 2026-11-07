@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found. Install Node.js 22.18 or newer.
  pause
  exit /b 1
)

rem Node 版本检查：后端使用 node:sqlite 与 stripTypeScriptTypes，需要 22.18+
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]*1000+v[1]>=22018?0:1)"
if errorlevel 1 (
  echo [ERROR] Node.js 22.18 or newer is required. Current version:
  node -v
  pause
  exit /b 1
)

if not exist node_modules (
  echo [INFO] First run - installing dependencies...
  call npm.cmd install
  if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
)

node scripts\gen-manifest.mjs
if errorlevel 1 ( echo [ERROR] gen-manifest failed. & pause & exit /b 1 )

rem 导入导出插件服务（plugins/threejs-interchange，独立进程，端口 5175；重复启动自动复用现有实例）
echo [INFO] Starting interchange plugin service at http://127.0.0.1:5175 ...
start "3d-layout-interchange" /min cmd /c "cd /d %~dp0..\..\plugins\threejs-interchange && (if not exist node_modules call npm.cmd install) && (if not exist ui-dist call npm.cmd run build) && npm.cmd start"

echo [INFO] Starting dev server at http://localhost:5173 ...
call npm.cmd run dev -- --open
if errorlevel 1 ( echo [ERROR] Dev server exited with an error. & pause ) else ( echo [INFO] Dev server exited. & pause )

endlocal
