@echo off
setlocal

set "EXE=%~dp0app\src-tauri\target\release\agent-llm.exe"
set "APP_DIR=%~dp0app"

if exist "%EXE%" (
  echo [Agent LLM] Starting release app...
  start "" "%EXE%"
  exit /b 0
)

echo [Agent LLM] Release exe was not found.
echo [Agent LLM] Building it now. This may take a few minutes...

cd /d "%APP_DIR%"
if errorlevel 1 (
  echo [Agent LLM] Cannot enter app directory.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [Agent LLM] Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [Agent LLM] Rust/Cargo was not found. Please install Rust first.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [Agent LLM] node_modules not found. Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [Agent LLM] npm install failed.
    pause
    exit /b 1
  )
)

call npm run desktop:build

if errorlevel 1 (
  echo [Agent LLM] Build failed.
  pause
  exit /b 1
)

if exist "%EXE%" (
  echo [Agent LLM] Starting release app...
  start "" "%EXE%"
  exit /b 0
)

echo [Agent LLM] Build finished, but exe was not found:
echo %EXE%
pause
exit /b 1

endlocal
