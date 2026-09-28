# clear-shell-cache.ps1 —— 清理 Windows Shell 对「应用身份」的隐藏缓存
#
# 为什么需要（v2.23，任务栏名称一直显示 Electron 的真凶）：
#   设了 AUMID 的 Electron 应用**首次弹 Toast/SMTC 时，Windows 会自动在开始菜单创建
#   一个名为 `Electron.lnk` 的快捷方式**（目标指向 node_modules 里的 electron.exe，
#   当时的 FileDescription 是 "Electron"），并把它与我们的 AUMID 永久绑定。
#   此后 Get-StartApps / Toast / SMTC / 任务栏按**字典序优先**取 "Electron"（E 在 e 之前），
#   于是无论怎么改 exe 元数据都显示 "Electron" —— 这就是「隐藏缓存」的实体（★ 头号元凶）。
#   参考：github.com/timeshiftsauce/CeruMusic commit 4298df5（同类问题的权威解法）。
#
#   次生缓存（即使删了 .lnk 也可能残留旧值）：
#     1. MuiCache（HKCU\...\Windows\Shell\MuiCache）
#        —— 键名 <exe 全路径>.FriendlyAppName，原地改元数据不刷新。
#     2. FeatureUsage\AppSwitched / ShowJumpView —— 身份调用计数。
#     3. AppResolver 内存缓存（explorer 进程内），随 explorer 重启刷新。
#     4. iconcache_*.db —— 图标缓存。
#
# 本脚本做 1/2/3/4，并可选重启 explorer 让内存缓存失效。幂等、可反复跑。
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\clear-shell-cache.ps1
#   powershell ... -File tools\clear-shell-cache.ps1 -AlsoRestartExplorer
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [switch]$AlsoRestartExplorer
)

$ErrorActionPreference = 'Continue'

# 本项目需要清理身份的二进制（原地补丁过的 electron.exe + 复制出的 eNSPAuto.exe）
$targets = New-Object System.Collections.Generic.List[string]
foreach ($exe in @(
    (Join-Path $Root 'node_modules\electron\dist\electron.exe'),
    (Join-Path $Root 'node_modules\electron\dist\eNSPAuto.exe')
  )) { $targets.Add($exe) }

Write-Host '=== clear-shell-cache ==='

# ---- 0. ★ 删除被 Windows 自动创建并绑定到本应用 AUMID 的 Electron.lnk ----
# 这是头号元凶：设 AUMID 后首次弹通知时系统自动生成，指向 electron.exe、
# 名称 "Electron"，且按字典序压过 eNSPAuto.lnk → 任务栏/Get-StartApps 都显示 Electron。
$smDirs = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu'),
  ([Environment]::GetFolderPath('Desktop')),
  (Join-Path $env:PUBLIC 'Desktop')
)
$killed = 0
foreach ($d in $smDirs) {
  if (-not (Test-Path $d)) { continue }
  Get-ChildItem $d -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^Electron( |\.|$)' -or $_.Name -eq 'Electron.lnk' } | ForEach-Object {
    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    Write-Host ('  removed auto-created shortcut: ' + $_.FullName)
    $killed++
  }
}
if ($killed -eq 0) { Write-Host '  no auto-created Electron.lnk found' }

# ---- 1. MuiCache：删掉这些 exe 路径的 FriendlyAppName / ApplicationCompany ----
$mui = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache'
if (Test-Path $mui) {
  $names = (Get-Item $mui).GetValueNames()
  $removed = 0
  foreach ($exe in $targets) {
    foreach ($suffix in @('.FriendlyAppName', '.ApplicationCompany')) {
      $key = $exe + $suffix
      if ($names -contains $key) {
        Remove-ItemProperty -Path $mui -Name $key -Force -ErrorAction SilentlyContinue
        Write-Host ('  MuiCache removed: ' + $key)
        $removed++
      }
    }
  }
  Write-Host ('  MuiCache: removed ' + $removed + ' stale entry(ies)')
} else {
  Write-Host '  MuiCache: not present, skip'
}

# ---- 2. FeatureUsage\AppSwitched / ShowJumpView：删掉本项目的陈旧身份计数 ----
foreach ($sub in @('AppSwitched', 'ShowJumpView')) {
  $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FeatureUsage\' + $sub
  if (-not (Test-Path $k)) { Write-Host ('  FeatureUsage\' + $sub + ': not present, skip'); continue }
  $names = (Get-Item $k).GetValueNames()
  $hit = 0
  foreach ($n in $names) {
    # 匹配本项目路径，以及此前误建的通用 Electron 身份
    if ($n -like ($Root + '*') -or $n -eq 'electron.app.Electron' -or $n -like '*ensp-auto*' -or $n -like '*enspauto*') {
      Remove-ItemProperty -Path $k -Name $n -Force -ErrorAction SilentlyContinue
      Write-Host ('  ' + $sub + ' removed: ' + $n)
      $hit++
    }
  }
  Write-Host ('  FeatureUsage\' + $sub + ': removed ' + $hit + ' entry(ies)')
}

# ---- 3. 图标缓存数据库（改图标后不刷新时才有必要，删了 Explorer 会重建）----
$explorerDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
$ic = 0
if (Test-Path $explorerDir) {
  Get-ChildItem $explorerDir -Filter 'iconcache*.db' -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    Write-Host ('  iconcache removed: ' + $_.Name)
    $ic++
  }
}
Write-Host ('  iconcache: removed ' + $ic + ' file(s)')

# ---- 4. 重启 explorer：清掉进程内的 AppResolver 内存缓存 ----
if ($AlsoRestartExplorer) {
  Write-Host '  restarting explorer ...'
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1500
  if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) {
    Start-Process explorer
  }
  Write-Host '  explorer restarted'
} else {
  Write-Host '  (explorer not restarted; pass -AlsoRestartExplorer to clear in-memory AppResolver cache)'
}

Write-Host '=== done ==='
exit 0
