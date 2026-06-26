param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Decode-Utf8Base64 {
  param([Parameter(Mandatory = $true)][string]$Value)
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))
}

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Parent
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullParent = [System.IO.Path]::GetFullPath($Parent)
  if (-not $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path check failed: $fullPath is outside $fullParent."
  }
}

$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PackageJsonPath = Join-Path $AppRoot "package.json"
$Package = Get-Content -LiteralPath $PackageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = $Package.version

$ReleaseDir = Join-Path $AppRoot "src-tauri\target\release"
$ExePath = Join-Path $ReleaseDir "agent-llm.exe"

if (-not $SkipBuild) {
  Write-Host "Building desktop release..."
  Push-Location $AppRoot
  try {
    & npm.cmd run desktop:build
    if ($LASTEXITCODE -ne 0) {
      throw "Desktop build failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
  throw "Desktop executable not found: $ExePath"
}

$DistRoot = Join-Path $AppRoot "dist-portable"
$StageRoot = Join-Path $DistRoot "Agent_LLM_Portable"
$ZipPath = Join-Path $DistRoot "Agent_LLM_Portable_v$Version.zip"

New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null
Assert-ChildPath -Path $StageRoot -Parent $DistRoot
Assert-ChildPath -Path $ZipPath -Parent $DistRoot

if (Test-Path -LiteralPath $StageRoot) {
  Remove-Item -LiteralPath $StageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}

New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null
Copy-Item -LiteralPath $ExePath -Destination $StageRoot -Force
New-Item -ItemType Directory -Force -Path (Join-Path $StageRoot "_up_\resources") | Out-Null

$StartBatName = Decode-Utf8Base64 "5ZCv5YqoIEFnZW50IExMTS5iYXQ="
$StartBatPath = Join-Path $StageRoot $StartBatName
$StartBat = "@echo off`r`ncd /d ""%~dp0""`r`nstart """" ""%~dp0agent-llm.exe""`r`n"
[System.IO.File]::WriteAllText($StartBatPath, $StartBat, [System.Text.Encoding]::ASCII)

$ReadmePath = Join-Path $StageRoot "README.txt"
$Readme = Decode-Utf8Base64 "QWdlbnQgTExNIOaegeeugOS+v+aQuueJiA0KDQrkvb/nlKjmlrnlvI/vvJoNCjEuIOino+WOi+aVtOS4qiBBZ2VudF9MTE1fUG9ydGFibGUg5paH5Lu25aS544CCDQoyLiDlj4zlh7vigJzlkK/liqggQWdlbnQgTExNLmJhdOKAneaIliBhZ2VudC1sbG0uZXhl44CCDQozLiDpppbmrKHmiZPlvIDml7blpoLmnpzmsqHmnIkgbGxhbWEuY3BwIOaguOW/g++8jOi9r+S7tuS8muiHquWKqOi/m+WFpeKAnOiuvue9riAvIGxsYW1hLmNwcCDlhoXmoLjigJ3jgIINCjQuIOeCueWHu+KAnOabtOaWsOKAne+8jOi9r+S7tuS8muaMieacrOacuueOr+Wig+S4i+i9veWvueW6lOaguOW/g+W5tuino+WOi+WIsCBfdXBfXHJlc291cmNlc+OAgg0KDQror7TmmI7vvJoNCi0g5q2k5Y6L57yp5YyF5LiN5YaF572uIGxsYW1hLXNlcnZlci5leGUg5oiWIERMTO+8jOeUqOS6juWwvemHj+e8qeWwj+WIhuWPkeS9k+enr+OAgg0KLSDmqKHlnovmlofku7bkuI3kvJrooqvmiZPov5vkvr/mkLrljIXvvIzor7flnKjlupTnlKjlhoXpgInmi6nmnKzmnLogR0dVRiDmqKHlnovnm67lvZXjgIINCi0g6YWN572u44CB5Lya6K+d5ZKM5a+G6ZKl5LuN55Sx57O757uf5bqU55So5pWw5o2u55uu5b2V566h55CG77yM5LiN5Lya5piO5paH5pS+6L+b5Y6L57yp5YyF44CCDQo="
[System.IO.File]::WriteAllText($ReadmePath, $Readme, [System.Text.Encoding]::UTF8)

$BundledRuntimeFiles = Get-ChildItem -LiteralPath $StageRoot -Recurse -File | Where-Object {
  $_.Name -ieq "llama-server.exe" -or $_.Extension -ieq ".dll"
}
if ($BundledRuntimeFiles) {
  $FileList = ($BundledRuntimeFiles | ForEach-Object { $_.FullName }) -join "`n"
  throw "Portable package must not include llama.cpp runtime files:`n$FileList"
}

Compress-Archive -LiteralPath $StageRoot -DestinationPath $ZipPath -CompressionLevel Optimal

$ZipItem = Get-Item -LiteralPath $ZipPath
$ZipSizeMb = [Math]::Round($ZipItem.Length / 1MB, 2)
Write-Host "Portable zip created: $ZipPath"
Write-Host "Size: $ZipSizeMb MB"
