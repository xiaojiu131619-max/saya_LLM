<#
.SYNOPSIS
  把画布模块放到 release 产物旁边，让裸 exe 也能直接打开画布。

.DESCRIPTION
  `app/resources/canvas` 在 .gitignore 中（它是构建产物），而 Tauri 打包资源时会
  遵循忽略规则，所以 `tauri build` 不会把 `../resources/canvas` 放进产物目录 —— 只
  改 tauri.conf.json 的 `bundle.resources` 是不够的。`npm run desktop:build` 因此
  在构建后调用本脚本，把模块复制到 `<target>/canvas`。

  应用侧 `canvas_manager::pack_candidates` 会按以下顺序找画布模块：显式环境变量 →
  资源目录 → 已安装包（%APPDATA%/AgentLLM/canvas/pack）→ 当前目录 → exe 同级
  `_up_/resources/canvas`、`resources/canvas`、`canvas`，并按版本取最高的有效包。
  本脚本写的是其中的 exe 同级 `canvas`。

.PARAMETER PackDir
  画布模块源目录，默认 app/resources/canvas。

.PARAMETER TargetDir
  产物目录，默认 app/src-tauri/target/release。
#>
param(
  [string]$PackDir = (Join-Path $PSScriptRoot "..\resources\canvas"),
  [string]$TargetDir = (Join-Path $PSScriptRoot "..\src-tauri\target\release")
)

$ErrorActionPreference = "Stop"

$TargetDir = (Resolve-Path -LiteralPath $TargetDir).Path
$ExePath = Join-Path $TargetDir "agent-llm.exe"
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
  throw "未找到 release 产物：$ExePath（先跑 tauri build）"
}

if (-not (Test-Path -LiteralPath $PackDir -PathType Container)) {
  Write-Warning "画布模块不存在（$PackDir），本次产物不含画布。先在 app 下跑 scripts\sync-canvas-pack.ps1 并安装依赖。"
  exit 0
}
$PackDir = (Resolve-Path -LiteralPath $PackDir).Path

foreach ($required in @("VERSION", "web\index.html", "gateway\src\server.js")) {
  if (-not (Test-Path -LiteralPath (Join-Path $PackDir $required))) {
    throw "画布模块不完整，缺少 ${required}：$PackDir"
  }
}

$Dest = Join-Path $TargetDir "canvas"
if (Test-Path -LiteralPath $Dest) {
  Remove-Item -LiteralPath $Dest -Recurse -Force
}
Copy-Item -LiteralPath $PackDir -Destination $Dest -Recurse -Force

$Version = (Get-Content -LiteralPath (Join-Path $Dest "VERSION") -Raw -Encoding UTF8).Trim()
$Size = (Get-ChildItem -LiteralPath $Dest -Recurse -File | Measure-Object Length -Sum).Sum
$Bridge = Test-Path -LiteralPath (Join-Path $Dest "gateway\comfyui-bridge\open-workflow.js")
$Deps = Test-Path -LiteralPath (Join-Path $Dest "gateway\node_modules\express")

Write-Host ("画布模块已放置：{0}（{1}，{2:N2} MB）" -f $Dest, $Version, ($Size / 1MB))
if (-not $Bridge) { Write-Warning "缺少 gateway\comfyui-bridge，H3 音频与工作流桥会不可用。" }
if (-not $Deps) { Write-Warning "缺少 gateway\node_modules，画布启动会报「缺少网关依赖（express）」。" }
