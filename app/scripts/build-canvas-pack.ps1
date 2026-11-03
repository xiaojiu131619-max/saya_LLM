param(
  [string]$PackDir = (Join-Path $PSScriptRoot "..\resources\canvas"),
  [string]$OutDir = (Join-Path $PSScriptRoot "..\dist-canvas"),
  [string]$Version = "",
  [string]$DownloadUrl = ""
)

$ErrorActionPreference = "Stop"

$PackDir = (Resolve-Path -LiteralPath $PackDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $PackDir "VERSION") -PathType Leaf)) {
  throw "Canvas pack is missing VERSION: $PackDir"
}
if (-not (Test-Path -LiteralPath (Join-Path $PackDir "web\index.html") -PathType Leaf)) {
  throw "Canvas pack is missing web\index.html: $PackDir"
}
if (-not (Test-Path -LiteralPath (Join-Path $PackDir "gateway\src\server.js") -PathType Leaf)) {
  throw "Canvas pack is missing gateway\src\server.js: $PackDir"
}
if (-not (Test-Path -LiteralPath (Join-Path $PackDir "gateway\node_modules\express") -PathType Container)) {
  throw "Canvas pack is missing gateway dependencies. Run: npm ci --omit=dev --ignore-scripts in $PackDir\gateway"
}

if (-not $Version) {
  $Version = (Get-Content -LiteralPath (Join-Path $PackDir "VERSION") -Raw -Encoding UTF8).Trim()
}
$Version = $Version.TrimStart("v")
$AssetName = "Agent_LLM_Canvas_v$Version.zip"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$ZipPath = Join-Path $OutDir $AssetName
$ManifestPath = Join-Path $OutDir "canvas-pack.json"

if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}

Write-Host "Packing canvas module: $PackDir"
Write-Host "Target: $ZipPath"
Compress-Archive -Path (Join-Path $PackDir "*") -DestinationPath $ZipPath -CompressionLevel Optimal

$Item = Get-Item -LiteralPath $ZipPath
$Hash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$SourcePath = Join-Path $PackDir "SOURCE.json"
$Source = if (Test-Path -LiteralPath $SourcePath) {
  Get-Content -LiteralPath $SourcePath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
  [pscustomobject]@{ upstream = "1314521gjy/ComfyUI-Local-Infinite-Canvas"; commit = "" }
}

$Manifest = [ordered]@{
  name = "Agent_LLM Canvas"
  version = $Version
  asset = $AssetName
  url = if ($DownloadUrl) { $DownloadUrl } else { "" }
  sha256 = $Hash
  size = $Item.Length
  built_at = (Get-Date).ToString("o")
  upstream = $Source.upstream
  upstream_commit = $Source.commit
}
$Manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8

Write-Host ""
Write-Host "Canvas pack created: $ZipPath"
Write-Host ("Size: {0:N2} MB" -f ($Item.Length / 1MB))
Write-Host "SHA256: $Hash"
Write-Host "Manifest: $ManifestPath"
