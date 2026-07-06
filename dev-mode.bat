@echo off
echo ========================================
echo  Agent LLM - 开发模式 (热重载)
echo ========================================
echo.
echo 此模式支持前端热重载，修改代码后自动刷新。
echo 按 Ctrl+C 可以停止。
echo.
echo 正在启动...
echo.

cd /d "%~dp0app"

if not exist "node_modules\" (
  echo 正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo ❌ 依赖安装失败
    pause
    exit /b 1
  )
)

echo 启动 Tauri 开发服务器...
call npm run desktop

pause
