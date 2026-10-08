@echo off
setlocal

REM ============================================================
REM Swift-1.5-Qwen3.8-27B local inference launcher (64K context)
REM Tuning rationale & benchmarks: docs/guides/SWIFT27B_TUNING.md
REM (Chinese user-facing docs live there; this bat is ASCII-only
REM  so cmd.exe parses it reliably on any codepage.)
REM ============================================================

set "SERVER=D:\LLM\beellama\bin\llama-server.exe"
set "MODEL=D:\LLM\beellama\models\Swift-1.5-Qwen3.8-27B-GSQ-RCO-IQ2_XS.gguf"
set "MMPROJ=D:\LLM\beellama\models\mmproj-Swift-1.5-Qwen3.8-27B-F16.gguf"
set "PORT=8080"

REM Explicit args (64K ctx, vision projector on CPU, kvarn4 KV quant + 1024
REM precision tail, small batch buffers). Do NOT add --spec-type draft-mtp:
REM the MTP path is currently ~5x SLOWER on this model (reproduced on
REM BeeLlama v0.4.7 and llama.cpp b11226). kvarn4 + small buffers keep 64K
REM off the VRAM ceiling: with q8_0/q6_0 the NVIDIA driver silently spills
REM to system RAM (~10x slower). See the tuning doc for details.

if not exist "%SERVER%" (
  echo [Swift 27B] ERROR: llama-server not found: "%SERVER%"
  pause
  exit /b 1
)
if not exist "%MODEL%" (
  echo [Swift 27B] ERROR: model not found: "%MODEL%"
  pause
  exit /b 1
)
if not exist "%MMPROJ%" (
  echo [Swift 27B] ERROR: mmproj not found: "%MMPROJ%"
  pause
  exit /b 1
)

%WINDIR%\System32\curl.exe -s -o nul http://127.0.0.1:%PORT%/health
if %errorlevel%==0 (
  echo [Swift 27B] Server is already running at http://127.0.0.1:%PORT% - nothing to do.
  %WINDIR%\System32\ping.exe -n 4 127.0.0.1 >nul
  exit /b 0
)

echo [Swift 27B] Starting: 64K context + vision + kvarn4 KV (loading takes 10-20s)...
echo [Swift 27B] Open http://127.0.0.1:%PORT% in your browser. Close the server console window to stop.

start "swift27b-llama-server" "%SERVER%" -m "%MODEL%" --mmproj "%MMPROJ%" --no-mmproj-offload -ngl 99 -c 65536 -b 512 -ub 256 -fa on -ctk kvarn4 -ctv kvarn4 --kv-tail-tokens 1024 --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 --jinja --port %PORT%

exit /b 0
