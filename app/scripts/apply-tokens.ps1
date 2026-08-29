# Replace hex literals in tsx/ts files with var(--token) for Fluent design system.
# Idempotent: re-running finds no matches.
# Skips rgba() / inline-style hex via regex (only matches #RRGGBB at word boundary).
param(
  [string]$Root = 'D:/Projects/Agent_LLM/app/src',
  [switch]$DryRun
)

$map = @(
  # text
  @{ H='#E2E8F2'; T='text-primary' }
  @{ H='#8E99AD'; T='text-secondary' }
  @{ H='#7D766B'; T='text-secondary' }
  @{ H='#2F2C26'; T='text-primary' }
  @{ H='#403C32'; T='text-primary' }
  @{ H='#8C8576'; T='text-secondary' }
  @{ H='#B8C2D4'; T='text-secondary' }
  @{ H='#A8B2C4'; T='text-secondary' }
  @{ H='#6B7688'; T='text-tertiary' }
  @{ H='#8D867A'; T='text-tertiary' }
  @{ H='#777780'; T='text-tertiary' }
  @{ H='#4E4941'; T='text-primary' }
  @{ H='#625B50'; T='text-secondary' }
  @{ H='#6F685A'; T='text-secondary' }
  @{ H='#A49B8C'; T='text-tertiary' }
  @{ H='#716A5E'; T='text-secondary' }
  @{ H='#8B8B94'; T='text-secondary' }
  @{ H='#A39C8C'; T='text-tertiary' }
  @{ H='#A09A90'; T='text-tertiary' }
  @{ H='#202123'; T='text-primary' }
  @{ H='#817A6D'; T='text-tertiary' }
  @{ H='#7B7468'; T='text-tertiary' }
  @{ H='#5D5D65'; T='text-secondary' }
  @{ H='#5F5F67'; T='text-primary' }
  @{ H='#5E6B7E'; T='text-secondary' }
  @{ H='#AEBBD0'; T='text-secondary' }
  @{ H='#39362E'; T='text-primary' }
  @{ H='#8B8275'; T='text-tertiary' }
  @{ H='#6F675C'; T='text-secondary' }
  @{ H='#9A9082'; T='text-tertiary' }
  @{ H='#969083'; T='text-tertiary' }
  @{ H='#5C6474'; T='text-secondary' }
  @{ H='#5C554B'; T='text-secondary' }
  @{ H='#8A8374'; T='text-tertiary' }
  @{ H='#8A8174'; T='text-tertiary' }
  @{ H='#8D8D8D'; T='text-tertiary' }
  @{ H='#A69E8D'; T='text-tertiary' }
  @{ H='#756E61'; T='text-secondary' }
  @{ H='#2F2C25'; T='text-primary' }
  @{ H='#4D463D'; T='text-primary' }
  @{ H='#6F6F6F'; T='text-tertiary' }
  @{ H='#99999F'; T='text-tertiary' }
  @{ H='#737373'; T='text-tertiary' }
  @{ H='#A5A5A5'; T='text-tertiary' }
  @{ H='#9B9B9B'; T='text-tertiary' }
  @{ H='#888890'; T='text-secondary' }
  @{ H='#92929A'; T='text-tertiary' }
  @{ H='#3A4557'; T='text-tertiary' }
  @{ H='#4A5568'; T='text-secondary' }
  @{ H='#62626A'; T='text-tertiary' }
  @{ H='#B8B1A3'; T='text-tertiary' }
  @{ H='#9C9486'; T='text-tertiary' }
  @{ H='#81796D'; T='text-tertiary' }
  @{ H='#A19A8B'; T='text-tertiary' }
  @{ H='#BBB3A2'; T='text-tertiary' }
  @{ H='#847D6B'; T='text-tertiary' }
  @{ H='#B4B4B4'; T='text-tertiary' }
  @{ H='#7A7264'; T='text-tertiary' }
  @{ H='#B8B0A0'; T='text-tertiary' }
  @{ H='#34343A'; T='text-secondary' }
  @{ H='#3C3C43'; T='text-secondary' }
  @{ H='#66666E'; T='text-tertiary' }
  @{ H='#6F6F78'; T='text-tertiary' }
  @{ H='#71717A'; T='text-tertiary' }

  # surface / background
  @{ H='#FBFAF6'; T='app-bg' }
  @{ H='#FAF9F5'; T='surface' }
  @{ H='#F1EEE7'; T='surface-muted' }
  @{ H='#F8F6F1'; T='surface-muted' }
  @{ H='#1C2836'; T='surface-raised' }
  @{ H='#141720'; T='app-bg' }
  @{ H='#1A1E28'; T='surface-raised' }
  @{ H='#222733'; T='surface-raised' }
  @{ H='#0D0F14'; T='app-bg' }
  @{ H='#F1E7DE'; T='surface-muted' }
  @{ H='#EEEAE2'; T='surface-muted' }
  @{ H='#1A2E28'; T='state-success-bg' }
  @{ H='#1E2A3A'; T='state-danger-bg' }
  @{ H='#F6E4DE'; T='state-danger-bg' }
  @{ H='#12151C'; T='app-bg' }
  @{ H='#F8EDE7'; T='state-danger-bg' }
  @{ H='#EDE8DE'; T='surface-muted' }
  @{ H='#EEF8F2'; T='state-success-bg' }
  @{ H='#F0DDD6'; T='state-danger-border' }
  @{ H='#E9E5DA'; T='surface-muted' }
  @{ H='#E6E1D8'; T='surface-muted' }
  @{ H='#F4F4F4'; T='surface-muted' }
  @{ H='#202020'; T='app-bg' }
  @{ H='#242424'; T='surface-raised' }
  @{ H='#FAFAF9'; T='surface' }
  @{ H='#ECECEC'; T='border' }
  @{ H='#10131A'; T='app-bg' }
  @{ H='#11141B'; T='app-bg' }
  @{ H='#F1D4CA'; T='state-danger-border' }
  @{ H='#F2DED4'; T='state-danger-border' }
  @{ H='#F2F8EF'; T='state-success-bg' }
  @{ H='#171B24'; T='app-bg' }
  @{ H='#1B1B1B'; T='app-bg' }
  @{ H='#101010'; T='app-bg' }
  @{ H='#0B0E14'; T='app-bg' }
  @{ H='#0E1219'; T='app-bg' }
  @{ H='#0D0D0D'; T='app-bg' }
  @{ H='#1A2130'; T='surface-raised' }
  @{ H='#232C3E'; T='surface-hover' }
  @{ H='#1C2130'; T='surface-raised' }
  @{ H='#2A2A2A'; T='surface-raised' }
  @{ H='#3A3A3A'; T='surface-raised' }
  @{ H='#303030'; T='app-bg' }
  @{ H='#2A3040'; T='surface' }
  @{ H='#303848'; T='surface-hover' }
  @{ H='#292929'; T='app-bg' }
  @{ H='#29292F'; T='app-bg' }
  @{ H='#211E19'; T='app-bg' }
  @{ H='#2E2A24'; T='app-bg' }
  @{ H='#171717'; T='app-bg' }
  @{ H='#2A241E'; T='surface-muted' }
  @{ H='#2A2113'; T='state-warning-bg' }
  @{ H='#262044'; T='accent-subtle' }
  @{ H='#2E1F4A'; T='accent-subtle' }
  @{ H='#173024'; T='state-success-bg' }
  @{ H='#1C3050'; T='accent' }
  @{ H='#2A4A72'; T='accent' }
  @{ H='#3A6494'; T='accent' }
  @{ H='#4CC2FF'; T='accent' }
  @{ H='#5088BC'; T='accent' }
  @{ H='#2D5632'; T='state-success-border' }
  @{ H='#2D5638'; T='state-success-border' }
  @{ H='#3A5570'; T='state-danger-border' }
  @{ H='#CFE1C8'; T='state-success-border' }
  @{ H='#CFEADA'; T='state-success-border' }
  @{ H='#BFE0C8'; T='state-success-border' }
  @{ H='#F1EFE8'; T='surface-muted' }
  @{ H='#F3EBDD'; T='surface-muted' }
  @{ H='#F4F1EA'; T='surface-muted' }
  @{ H='#F4F0E8'; T='surface-muted' }
  @{ H='#F3EFE7'; T='surface-muted' }
  @{ H='#F6F3ED'; T='surface-hover' }
  @{ H='#F7F4EC'; T='surface-muted' }
  @{ H='#ECEAE4'; T='surface-muted' }
  @{ H='#FAF8F2'; T='surface' }
  @{ H='#FAF3EC'; T='surface' }
  @{ H='#F7F7F8'; T='surface-muted' }
  @{ H='#ECECF1'; T='border' }
  @{ H='#F1E8E1'; T='surface-muted' }
  @{ H='#F4F4F2'; T='surface-muted' }
  @{ H='#F0F0F2'; T='border' }
  @{ H='#F0F0EE'; T='border' }
  @{ H='#EEEEEC'; T='border' }
  @{ H='#DEDEE2'; T='border' }
  @{ H='#DDE4F0'; T='border' }
  @{ H='#E4E4E7'; T='border' }
  @{ H='#E7E7E9'; T='border' }
  @{ H='#E3E3E3'; T='border' }
  @{ H='#D8D8D8'; T='border' }
  @{ H='#747474'; T='text-tertiary' }
  @{ H='#EEE9DE'; T='surface-muted' }
  @{ H='#EBE6DB'; T='border' }

  # border colors
  @{ H='#DCD8CF'; T='border' }
  @{ H='#E3DFD6'; T='border' }
  @{ H='#E2DED5'; T='border' }
  @{ H='#E4E0D8'; T='border' }
  @{ H='#E1DCD0'; T='border' }
  @{ H='#D8D2C5'; T='border' }
  @{ H='#E5E1D8'; T='border' }
  @{ H='#DED9CC'; T='border' }
  @{ H='#DDD8CC'; T='border' }
  @{ H='#E4E0D6'; T='border' }
  @{ H='#E7E2D8'; T='border' }
  @{ H='#E3DED2'; T='border' }
  @{ H='#E5DFD3'; T='border' }
  @{ H='#E2DCD1'; T='border' }
  @{ H='#DCD7CC'; T='border' }
  @{ H='#E2DFD6'; T='border' }
  @{ H='#EAE6DD'; T='border' }
  @{ H='#E6E2D8'; T='border' }
  @{ H='#E8E2D7'; T='border' }
  @{ H='#E4DFD5'; T='border' }
  @{ H='#E7E2D6'; T='border' }
  @{ H='#E0D8CA'; T='border' }
  @{ H='#E8E3D8'; T='border' }
  @{ H='#DED8CC'; T='border' }
  @{ H='#C8C1B4'; T='border' }
  @{ H='#C7DDF4'; T='border' }
  @{ H='#BFD7E8'; T='border' }
  @{ H='#DCC9F0'; T='border' }

  # accent / brand
  @{ H='#D7663E'; T='accent' }
  @{ H='#D06646'; T='accent' }
  @{ H='#6EA8DC'; T='accent' }
  @{ H='#0078D4'; T='accent' }
  @{ H='#3B82F6'; T='accent' }
  @{ H='#0096FF'; T='accent' }
  @{ H='#2F6FB0'; T='accent' }
  @{ H='#A78BFA'; T='accent' }
  @{ H='#673DB8'; T='accent' }
  @{ H='#6C5DD3'; T='accent' }
  @{ H='#6A4CA3'; T='accent' }
  @{ H='#7A48B5'; T='accent' }
  @{ H='#A8B8F0'; T='accent' }
  @{ H='#B88CFF'; T='accent' }
  @{ H='#2E6E9E'; T='accent' }
  @{ H='#373C46'; T='accent' }
  @{ H='#5A6CFF'; T='accent' }
  @{ H='#6478A0'; T='accent' }
  @{ H='#BE593A'; T='accent-hover' }
  @{ H='#C45732'; T='accent-hover' }
  @{ H='#C65135'; T='accent-hover' }
  @{ H='#DA744D'; T='accent-hover' }
  @{ H='#C4502E'; T='accent-hover' }
  @{ H='#E27750'; T='accent-hover' }
  @{ H='#BE5C3E'; T='accent-hover' }
  @{ H='#8BBDE8'; T='accent-hover' }

  # state warning
  @{ H='#B76540'; T='state-warning' }
  @{ H='#A86A1B'; T='state-warning' }
  @{ H='#6F5A35'; T='state-warning' }
  @{ H='#FF9A00'; T='state-warning' }
  @{ H='#9A6700'; T='state-warning' }
  @{ H='#B26B00'; T='state-warning' }
  @{ H='#7AB8E8'; T='state-warning' }
  @{ H='#D2923B'; T='state-warning' }
  @{ H='#F5C56B'; T='state-warning' }
  @{ H='#D9A324'; T='state-warning' }
  @{ H='#B77800'; T='state-warning' }
  @{ H='#6D4E1D'; T='state-warning' }
  @{ H='#7A4D16'; T='state-warning' }
  @{ H='#FFF7D7'; T='state-warning-bg' }
  @{ H='#FFECA8'; T='state-warning-bg' }
  @{ H='#FFF8DF'; T='state-warning-bg' }
  @{ H='#FFF7E8'; T='state-warning-bg' }
  @{ H='#FFF6E6'; T='state-warning-bg' }
  @{ H='#EACB71'; T='state-warning-border' }
  @{ H='#E8D7A2'; T='state-warning-border' }
  @{ H='#E8CFA6'; T='state-warning-border' }
  @{ H='#E8D3A6'; T='state-warning-border' }

  # state danger
  @{ H='#C44E36'; T='state-danger' }
  @{ H='#B4563B'; T='state-danger' }
  @{ H='#F87171'; T='state-danger' }
  @{ H='#C42B1C'; T='state-danger' }
  @{ H='#FF6347'; T='state-danger' }
  @{ H='#FF5F57'; T='state-danger' }
  @{ H='#5A96D0'; T='state-danger' }
  @{ H='#B42318'; T='state-danger' }
  @{ H='#F0A0A0'; T='state-danger' }
  @{ H='#FF8A70'; T='state-danger' }
  @{ H='#9B664C'; T='state-danger' }
  @{ H='#FFF1EC'; T='state-danger-bg' }
  @{ H='#FFF2EA'; T='state-danger-bg' }
  @{ H='#FDF0EB'; T='state-danger-bg' }
  @{ H='#F4C9B5'; T='state-danger-border' }
  @{ H='#F2B8A4'; T='state-danger-border' }
  @{ H='#E9C7BC'; T='state-danger-border' }
  @{ H='#E8C9BD'; T='state-danger-border' }
  @{ H='#DCC6B9'; T='state-danger-border' }
  @{ H='#E9D0C7'; T='state-danger-border' }
  @{ H='#E7C9BE'; T='state-danger-border' }
  @{ H='#DDBFAE'; T='state-danger-border' }
  @{ H='#C98F70'; T='state-danger-border' }
  @{ H='#C98A70'; T='state-danger-border' }
  @{ H='#E89B79'; T='state-danger-border' }

  # state success
  @{ H='#2C8B58'; T='state-success' }
  @{ H='#4E7751'; T='state-success' }
  @{ H='#7EC8A0'; T='state-success' }
  @{ H='#34D399'; T='status-loaded' }
  @{ H='#6EA56D'; T='state-success' }
  @{ H='#2A8061'; T='state-success' }
  @{ H='#7EE0A3'; T='state-success' }
  @{ H='#28C840'; T='state-success' }
  @{ H='#E9F3E4'; T='state-success-bg' }
  @{ H='#E7F1E4'; T='state-success-bg' }

  # status / misc
  @{ H='#FBBF24'; T='status-loading' }
  @{ H='#FEBC2E'; T='state-warning' }
  @{ H='#BDB8AD'; T='status-standby' }

  # accent-subtle (capability badges)
  @{ H='#EEF6FF'; T='accent-subtle' }
  @{ H='#E7F1F8'; T='accent-subtle' }
  @{ H='#F4ECFA'; T='accent-subtle' }
  @{ H='#F2EEFB'; T='accent-subtle' }
  @{ H='#FCEFE6'; T='state-warning-bg' }
  @{ H='#EEE2FF'; T='accent-subtle' }
  @{ H='#F4ECFF'; T='accent-subtle' }
  @{ H='#D7C7F5'; T='accent-subtle' }
  @{ H='#D9D3FF'; T='accent-subtle' }
  @{ H='#F2F0FF'; T='accent-subtle' }
  @{ H='#FFFFFF'; T='text-on-accent' }
)

$hashed = @{}
foreach ($m in $map) {
  $hashed[$m.H.ToUpperInvariant()] = $m.T
}

$files = Get-ChildItem -Path $Root -Recurse -Include '*.tsx', '*.ts' -File
$totalReplaced = 0
$fileReplaced = 0

foreach ($file in $files) {
  $content = Get-Content $file -Raw
  if (-not $content) { continue }
  $fileHit = 0
  foreach ($hex in $hashed.Keys) {
    $pattern = [regex]::Escape($hex)
    $replacement = '[var(--' + $hashed[$hex] + ')]'
    $newContent = [regex]::Replace($content, $pattern, $replacement, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($newContent -ne $content) {
      $content = $newContent
      $fileHit += 1
    }
  }
  if ($fileHit -gt 0) {
    $fileReplaced += 1
    $totalReplaced += $fileHit
    if ($DryRun) {
      Write-Host "would patch: $($file.FullName.Substring($Root.Length))  ($fileHit hex families)"
    } else {
      Set-Content -Path $file.FullName -Value $content -NoNewline -Encoding UTF8
      Write-Host "patched:     $($file.FullName.Substring($Root.Length))  ($fileHit hex families)"
    }
  }
}

Write-Host ""
Write-Host "files touched: $fileReplaced"
Write-Host "hex families replaced: $totalReplaced"
