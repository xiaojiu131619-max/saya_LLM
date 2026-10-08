@echo off
setlocal

REM Stops the local llama-server inference service.
REM NOTE: this kills ALL llama-server.exe processes on this machine.

%WINDIR%\System32\taskkill.exe /IM llama-server.exe /F >nul 2>&1
if %errorlevel%==0 (
  echo [Swift 27B] llama-server stopped.
) else (
  echo [Swift 27B] No running llama-server process found.
)
%WINDIR%\System32\ping.exe -n 4 127.0.0.1 >nul
exit /b 0
