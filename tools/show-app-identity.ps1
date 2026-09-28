# show-app-identity.ps1 —— 打印 Windows 对 eNSPAuto 的身份解析现状（排查用，只读）
#
# 用途：任务栏名称/图标不对时，一条命令看清每个身份来源的实际值，不必再猜。
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\show-app-identity.ps1
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$appId = 'cn.enspauto.workbench'
$exe   = Join-Path $Root 'node_modules\electron\dist\eNSPAuto.exe'
$exe2  = Join-Path $Root 'node_modules\electron\dist\electron.exe'
$lnk   = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\eNSPAuto.lnk'

Write-Host '=== eNSPAuto 身份解析现状 ==='
Write-Host ''

Write-Host '[1] 运行中的进程（任务栏身份的直接载体）'
$procs = Get-Process | Where-Object { $_.Name -match 'electron|eNSPAuto' }
if ($procs) { $procs | ForEach-Object { Write-Host ('    ' + $_.Name + '  pid=' + $_.Id + '  path=' + $_.Path) } }
else { Write-Host '    （无。dev 未启动）' }
Write-Host ''

Write-Host '[2] exe 元数据（未设 AUMID 时任务栏的回退来源）'
foreach ($f in @($exe, $exe2)) {
  if (Test-Path $f) {
    $v = (Get-Item $f).VersionInfo
    Write-Host ('    ' + (Split-Path $f -Leaf) + '  FileDescription=' + $v.FileDescription + '  ProductName=' + $v.ProductName)
  } else { Write-Host ('    ' + (Split-Path $f -Leaf) + '  <不存在>') }
}
Write-Host ''

Write-Host '[3] AUMID 注册表键（只服务通知，不参与任务栏）'
$k = 'HKCU:\Software\Classes\AppUserModelId\' + $appId
if (Test-Path $k) {
  $p = Get-ItemProperty $k
  Write-Host ('    DisplayName=' + $p.DisplayName + '  IconUri=' + $p.IconUri)
} else { Write-Host '    <缺失 —— 通知会显示 Electron>' }
Write-Host ''

Write-Host '[4] 开始菜单快捷方式（设了 AUMID 时任务栏解析的第一来源）'
if (Test-Path $lnk) {
  $b = [System.IO.File]::ReadAllBytes($lnk)
  $u = [System.Text.Encoding]::Unicode.GetString($b)
  $hasAumid = $u.Contains($appId)
  Write-Host ('    ' + $lnk)
  Write-Host ('    带 AUMID=' + $hasAumid + '（False 属正常：本机 Win11 禁写 .lnk 的 AUMID 属性）')
} else { Write-Host '    <缺失>' }
Write-Host ''

Write-Host '[5] Shell 对 AUMID 的解析结果（Get-StartApps）'
$sa = Get-StartApps | Where-Object { $_.AppID -like '*enspauto*' }
if ($sa) { $sa | ForEach-Object { Write-Host ('    ' + $_.AppID + '  =>  ' + $_.Name) } }
else { Write-Host '    （无条目）' }
Write-Host ''

Write-Host '[6] 残留的隐藏缓存条目'
$mui = 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache'
if (Test-Path $mui) {
  $hit = (Get-Item $mui).GetValueNames() | Where-Object { $_ -match 'ensp-auto|enspauto' -and $_ -match 'electron' }
  if ($hit) { $hit | ForEach-Object { Write-Host ('    MuiCache: ' + $_) } } else { Write-Host '    MuiCache: 干净' }
}
$fs = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FeatureUsage\AppSwitched'
if (Test-Path $fs) {
  $hit2 = (Get-Item $fs).GetValueNames() | Where-Object { $_ -match 'ensp-auto|enspauto|electron.app.Electron' }
  if ($hit2) { $hit2 | ForEach-Object { Write-Host ('    AppSwitched: ' + $_) } } else { Write-Host '    AppSwitched: 干净' }
}
Write-Host ''
Write-Host '提示：身份不对时先跑 tools\clear-shell-cache.ps1 -AlsoRestartExplorer 清缓存，'
Write-Host '      再重启 dev（务必确认进程名是 eNSPAuto.exe）。'
exit 0
