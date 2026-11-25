<#
.SYNOPSIS
  从上游同步无限画布模块到 app/resources/canvas。

.DESCRIPTION
  上游仓库 1314521gjy/ComfyUI-Local-Infinite-Canvas 的 web/dist 里会累积历次构建的
  旧 bundle（v0.25.3 的 dist 有 318 MB 全是过期产物），不能整体复制。本脚本：

  1. 准备 sparse checkout（只取打包需要的路径）；
  2. 从 index.html 出发做「可达资源闭包」，只保留真正会被加载的 assets；
  3. 复制网关源码、工作流、提示词、随包 Python 脚本与 comfyui-bridge；
  4. 应用本地改动（去掉画布修复助手插件、补 config.js 占位）；
  5. 写 VERSION 与 SOURCE.json，记录上游 commit。

  跑完本脚本后仍需：
    npm ci --omit=dev --ignore-scripts   # 在 app/resources/canvas/gateway 下装生产依赖
    .\scripts\build-canvas-pack.ps1      # 打包并回填 sha256 到 canvas-pack.release.json

.PARAMETER Ref
  上游 tag 或 commit，默认 v0.25.3。

.PARAMETER SourceDir
  已存在的上游检出目录。省略时使用仓库根 tmp/canvas-upstream，没有则自动克隆。

.PARAMETER PackDir
  目标模块目录，默认 app/resources/canvas。

.EXAMPLE
  cd app; .\scripts\sync-canvas-pack.ps1 -Ref v0.25.3

.NOTES
  本文件必须保存为「带 BOM 的 UTF-8」。Windows PowerShell 5.1 对无 BOM 的 .ps1
  按系统 ANSI 代码页解析，中文字符串会被撕成语法错误，脚本直接解析失败。
#>
param(
  [string]$Ref = "v0.25.3",
  [string]$SourceDir = "",
  [string]$PackDir = (Join-Path $PSScriptRoot "..\resources\canvas")
)

$ErrorActionPreference = "Stop"

$AppDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $AppDir "..")).Path
$Upstream = "1314521gjy/ComfyUI-Local-Infinite-Canvas"
$UpstreamUrl = "https://github.com/$Upstream.git"

# 上游仓库里 .git/config 可能残留失效代理，这里统一显式清空，避免走 127.0.0.1 失败。
$GitBase = @("git", "-c", "http.proxy=", "-c", "https.proxy=")

# 打包范围（与 docs/guides/CANVAS_MODULE.md 第 4.1 节保持一致）。
$SparsePaths = @(
  "/infinite-canvas/web/dist/",
  "/comfyui-gateway/src/",
  "/comfyui-gateway/workflows/",
  "/comfyui-gateway/prompts/",
  "/comfyui-gateway/resources/index.json",
  "/comfyui-gateway/comfyui-bridge/",
  "/comfyui-gateway/tools/",
  "/comfyui-gateway/scripts/build-h3-trt-vae.py",
  "/comfyui-gateway/package.json",
  "/comfyui-gateway/package-lock.json",
  "/VERSION",
  "/LICENSE",
  "/NOTICE.md",
  "/THIRD_PARTY_NOTICES.md"
)

if (-not $SourceDir) { $SourceDir = Join-Path $RepoRoot "tmp\canvas-upstream" }

# Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，VERSION / JSON / JS
# 都写过之后会让上游比对与 JSON 解析出现差异，这里统一无 BOM 写入。
function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Invoke-Git {
  param([string[]]$Arguments, [string]$WorkDir = "")
  $command = $GitBase + $Arguments
  $previous = (Get-Location).Path
  # git 会把进度写到 stderr；在 $ErrorActionPreference = "Stop" 下用 2>&1 会被当成
  # 终止性错误。这里临时放宽为 Continue，只按退出码判定失败。
  $previousEap = $ErrorActionPreference
  $code = 0
  $output = @()
  try {
    if ($WorkDir) { Set-Location -LiteralPath $WorkDir }
    $ErrorActionPreference = "Continue"
    $output = & $command[0] $command[1..($command.Length - 1)] 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousEap
    Set-Location -LiteralPath $previous
  }
  if ($code -ne 0) {
    throw ("git {0} 失败（退出码 {1}）：`n{2}" -f ($Arguments -join " "), $code, (($output -join "`n").Trim()))
  }
  return ($output -join "`n")
}

# ---------- 1. 准备上游检出 ----------

if (-not (Test-Path -LiteralPath (Join-Path $SourceDir ".git"))) {
  Write-Host "克隆上游 $Upstream ($Ref) → $SourceDir"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SourceDir) | Out-Null
  Invoke-Git @("clone", "--filter=blob:none", "--sparse", "--branch", $Ref, $UpstreamUrl, $SourceDir) | Out-Null
} else {
  Write-Host "复用已有上游检出：$SourceDir"
  Invoke-Git @("fetch", "--depth", "1", "origin", "refs/tags/${Ref}:refs/tags/${Ref}", "refs/heads/main:refs/remotes/origin/main") -WorkDir $SourceDir | Out-Null
  Invoke-Git @("checkout", "--force", $Ref) -WorkDir $SourceDir | Out-Null
}

$sparseArgs = @("sparse-checkout", "set", "--no-cone") + $SparsePaths
Invoke-Git $sparseArgs -WorkDir $SourceDir | Out-Null

$commit = (Invoke-Git @("rev-parse", "HEAD") -WorkDir $SourceDir | Out-String).Trim()
$version = (Get-Content -LiteralPath (Join-Path $SourceDir "VERSION") -Raw -Encoding UTF8).Trim()
Write-Host "上游版本：$version  commit：$commit"

if ($version.TrimStart("v") -ne $Ref.TrimStart("v")) {
  throw "VERSION（$version）与请求的 Ref（$Ref）不一致，请确认 tag 是否移动过。"
}

$DistSrc = Join-Path $SourceDir "infinite-canvas\web\dist"
$GatewaySrc = Join-Path $SourceDir "comfyui-gateway"
foreach ($required in @("index.html", "assets")) {
  if (-not (Test-Path -LiteralPath (Join-Path $DistSrc $required))) {
    throw "上游 dist 缺少 $required：$DistSrc"
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $GatewaySrc "src\server.js") -PathType Leaf)) {
  throw "上游网关缺少 src\server.js：$GatewaySrc"
}

# ---------- 2. 计算 dist 的可达资源闭包 ----------

# 上游 dist 不清理历史构建，assets 里堆积了数百个旧 bundle。只保留 index.html
# 及动态 import 真正引用的文件，否则单包会膨胀到 300 MB 以上。
$reachable = [System.Collections.Generic.HashSet[string]]::new()
$queue = [System.Collections.Generic.Queue[object]]::new()

function Add-Reachable {
  param([string]$Dir, [string]$Name, [System.Collections.Generic.HashSet[string]]$Seen, [System.Collections.Generic.Queue[object]]$Queue)
  $rel = if ($Dir) { "$Dir/$Name" } else { $Name }
  if ($Seen.Add($rel)) { $Queue.Enqueue([pscustomobject]@{ Rel = $rel; Dir = $Dir }) }
}

$indexHtml = Get-Content -LiteralPath (Join-Path $DistSrc "index.html") -Raw -Encoding UTF8
foreach ($match in [regex]::Matches($indexHtml, 'assets/([A-Za-z0-9._-]+\.(?:js|css))')) {
  Add-Reachable -Dir "assets" -Name $match.Groups[1].Value -Seen $reachable -Queue $queue
}

$skipped = [System.Collections.Generic.List[string]]::new()
while ($queue.Count -gt 0) {
  $item = $queue.Dequeue()
  $path = Join-Path $DistSrc ($item.Rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    # 占位文案里也会出现类似 "./plugin.js" 的示例路径，不是真实资源。
    $skipped.Add($item.Rel)
    continue
  }
  if ($item.Rel -notmatch '\.(js|css)$') { continue }
  $text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  # 动态 import 以文件自身目录为基准，形如 "./chunk.js"。
  foreach ($match in [regex]::Matches($text, '(?:\./|assets/)([A-Za-z0-9._-]+\.(?:js|css|png|jpe?g|webp|svg|woff2?|wasm))')) {
    Add-Reachable -Dir $item.Dir -Name $match.Groups[1].Value -Seen $reachable -Queue $queue
  }
}

$assetFiles = @()
foreach ($rel in ($reachable | Sort-Object)) {
  $path = Join-Path $DistSrc ($rel -replace '/', '\')
  if (Test-Path -LiteralPath $path -PathType Leaf) { $assetFiles += $rel }
}

$allAssets = (Get-ChildItem -LiteralPath (Join-Path $DistSrc "assets") -Recurse -File).Count
Write-Host ("可达资源 {0} 个 / dist 内 {1} 个（丢弃过期产物 {2} 个）" -f $assetFiles.Count, $allAssets, ($allAssets - $assetFiles.Count))
if ($skipped.Count -gt 0) {
  Write-Host ("忽略非资源引用：{0}" -f (($skipped | Sort-Object -Unique) -join ", "))
}

# ---------- 3. 写入模块目录 ----------

$PackDir = if (Test-Path -LiteralPath $PackDir) { (Resolve-Path -LiteralPath $PackDir).Path } else { $PackDir }
New-Item -ItemType Directory -Force -Path $PackDir | Out-Null

# 只清理本脚本接管的目录，保留 gateway/node_modules（重新装依赖由 npm ci 负责）。
foreach ($dir in @("web", "gateway\src", "gateway\workflows", "gateway\prompts", "gateway\resources", "gateway\comfyui-bridge", "gateway\tools", "gateway\scripts")) {
  $target = Join-Path $PackDir $dir
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}

# 3.1 前端
$webDir = Join-Path $PackDir "web"
New-Item -ItemType Directory -Force -Path (Join-Path $webDir "assets") | Out-Null

Copy-Item -LiteralPath (Join-Path $DistSrc "index.html") -Destination $webDir -Force
foreach ($entry in (Get-ChildItem -LiteralPath $DistSrc -Force | Where-Object { $_.PSIsContainer -and $_.Name -ne "assets" })) {
  Copy-Item -LiteralPath $entry.FullName -Destination $webDir -Recurse -Force
}
foreach ($rel in $assetFiles) {
  $name = Split-Path $rel -Leaf
  Copy-Item -LiteralPath (Join-Path $DistSrc ($rel -replace '/', '\')) -Destination (Join-Path $webDir "assets\$name") -Force
}

# 3.2 本地改动：不随包提供画布修复助手插件
$assistantPlugin = Join-Path $webDir "plugins\canvas-assistant.js"
if (Test-Path -LiteralPath $assistantPlugin) { Remove-Item -LiteralPath $assistantPlugin -Force }
$pluginIndex = Join-Path $webDir "plugins\index.json"
if (Test-Path -LiteralPath $pluginIndex) {
  $plugins = Get-Content -LiteralPath $pluginIndex -Raw -Encoding UTF8 | ConvertFrom-Json
  $kept = @($plugins | Where-Object { $_ -ne "/plugins/canvas-assistant.js" })
  Write-Utf8NoBom -Path $pluginIndex -Text (ConvertTo-Json -InputObject $kept -Compress)
}

# 3.3 本地改动：config.js 占位（应用运行时由 canvas_host 动态返回真实配置）
$configStub = @(
  "// 画布运行时配置占位。应用通过 canvas_host.rs 动态返回 /config.js 注入网关地址；",
  "// 这里只保证 dist 脱离应用直接托管时也不报错。",
  "window.__RUNTIME_CONFIG__ = window.__RUNTIME_CONFIG__ || {};"
) -join "`r`n"
Write-Utf8NoBom -Path (Join-Path $webDir "config.js") -Text $configStub

# 3.4 网关
$gatewayDst = Join-Path $PackDir "gateway"
foreach ($dir in @("src", "workflows", "prompts", "comfyui-bridge", "tools", "scripts")) {
  $from = Join-Path $GatewaySrc $dir
  if (Test-Path -LiteralPath $from) {
    Copy-Item -LiteralPath $from -Destination $gatewayDst -Recurse -Force
  }
}
New-Item -ItemType Directory -Force -Path (Join-Path $gatewayDst "resources") | Out-Null
Copy-Item -LiteralPath (Join-Path $GatewaySrc "resources\index.json") -Destination (Join-Path $gatewayDst "resources\index.json") -Force
foreach ($file in @("package.json", "package-lock.json")) {
  Copy-Item -LiteralPath (Join-Path $GatewaySrc $file) -Destination (Join-Path $gatewayDst $file) -Force
}

# 3.5 顶层文件
foreach ($file in @("LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md")) {
  $from = Join-Path $SourceDir $file
  if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $PackDir -Force }
}
Write-Utf8NoBom -Path (Join-Path $PackDir "VERSION") -Text $version
$source = [ordered]@{
  upstream = $Upstream
  upstream_url = "https://github.com/$Upstream"
  commit = $commit
  version = $version
  license = "MIT"
  bundled = @(
    "infinite-canvas/web/dist（仅 index.html 可达的 assets）",
    "comfyui-gateway/src",
    "comfyui-gateway/workflows",
    "comfyui-gateway/prompts",
    "comfyui-gateway/comfyui-bridge",
    "comfyui-gateway/tools/scene3d_pano.py",
    "comfyui-gateway/scripts/build-h3-trt-vae.py",
    "comfyui-gateway/resources/index.json",
    "comfyui-gateway/package.json",
    "comfyui-gateway/package-lock.json",
    "comfyui-gateway/node_modules（仅生产依赖）"
  )
  excluded = @(
    "模型权重、LoRA、自定义节点解压包",
    "assistant 工作区与修复助手",
    "launcher / tools / docs / tests / mock",
    "dist 中历次构建遗留的过期 bundle"
  )
  local_changes = @(
    "移除 web/plugins/canvas-assistant.js 及 index.json 中的对应入口：应用不随包提供修复助手工作区",
    "web/config.js 为占位文件，运行时由 canvas_host.rs 动态注入网关地址"
  )
  synced_at = (Get-Date).ToString("o")
}
Write-Utf8NoBom -Path (Join-Path $PackDir "SOURCE.json") -Text ($source | ConvertTo-Json -Depth 4)

$webSize = (Get-ChildItem -LiteralPath $webDir -Recurse -File | Measure-Object Length -Sum).Sum
$gatewaySize = (Get-ChildItem -LiteralPath $gatewayDst -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ""
Write-Host ("模块已同步：{0}" -f $PackDir)
Write-Host ("web     {0,8:N2} MB" -f ($webSize / 1MB))
Write-Host ("gateway {0,8:N2} MB" -f ($gatewaySize / 1MB))
Write-Host ""
Write-Host "下一步："
Write-Host "  cd `"$gatewayDst`"; npm ci --omit=dev --ignore-scripts"
Write-Host "  cd `"$AppDir`"; .\scripts\build-canvas-pack.ps1"
