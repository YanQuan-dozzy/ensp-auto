# ============================================================================
#  fix-vboxdrv.ps1  --  修复 eNSP「启动设备失败，错误代码 40」
#
#  根因：
#    内核驱动服务 VBoxDrv 的 ImagePath 指向 E:\Netexe\VBoxDrv.sys，
#    而该文件并不存在 -> 驱动加载失败（Win32 退出码 2，系统找不到指定的文件）
#    -> VirtualBox 无法启动 AR/WLAN 虚拟机 -> eNSP 报错误代码 40。
#
#  做法：
#    1. 备份 VBoxDrv 服务注册表项
#    2. 把 ImagePath 指回标准位置 C:\Windows\System32\drivers\VBoxDrv.sys
#       并把 Start 改为 1（开机自动加载，不依赖运行时提权）
#    3. 立即加载驱动并查询状态验证
#    4. 若标准位置加载失败，自动回退：复制驱动到 E:\Netexe 并还原原 ImagePath
#
#  用法：右键「以管理员身份运行 PowerShell」，执行本脚本。
# ============================================================================

$ErrorActionPreference = 'Continue'

$root = 'F:\projects\ensp-auto\.workbuddy\tmp'
$log  = Join-Path $root 'fix-vboxdrv.result.txt'
$bakD = Join-Path $root 'bak'
New-Item -ItemType Directory -Force -Path $root | Out-Null
New-Item -ItemType Directory -Force -Path $bakD | Out-Null

$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($log, '', $enc)
function W([string]$m) { [System.IO.File]::AppendAllText($log, $m + "`r`n", $enc) }

$svcKey = 'HKLM\SYSTEM\CurrentControlSet\Services\VBoxDrv'
$std    = "$env:SystemRoot\system32\DRIVERS\VBoxDrv.sys"
$alt    = 'E:\Netexe\VBoxDrv.sys'
$src    = 'E:\Netexe\drivers\vboxdrv\VBoxDrv.sys'
$vbm    = 'E:\Netexe\VBoxManage.exe'

W '=== 修复 VBoxDrv（eNSP 错误代码 40） ==='
W ('时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
W ('管理员权限：' + $isAdmin)
if (-not $isAdmin) { W '不是管理员，终止。请以管理员身份重新运行。'; exit 1 }

# 1. 备份
$bakFile = Join-Path $bakD ('VBoxDrv-service-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.reg')
reg export $svcKey $bakFile /y 2>&1 | Out-Null
W ('注册表备份：' + $bakFile + '  存在=' + (Test-Path $bakFile))

W '--- 修复前 ---'
W ((& sc.exe qc VBoxDrv 2>&1 | Out-String).Trim())
W ((& sc.exe query VBoxDrv 2>&1 | Out-String).Trim())

W ('驱动文件： 系统标准位置存在=' + (Test-Path $std) + '  E:\Netexe 存在=' + (Test-Path $alt) + '  安装包源存在=' + (Test-Path $src))
if (-not (Test-Path $std)) {
  if (Test-Path $src) { Copy-Item $src $std -Force; W ('已复制 ' + $src + ' -> ' + $std) }
  else { W '找不到可用的 VBoxDrv.sys 源文件，终止。'; exit 2 }
}

# 2. 指向标准位置 + 开机自动加载
reg add $svcKey /v ImagePath /t REG_EXPAND_SZ /d '\SystemRoot\system32\DRIVERS\VBoxDrv.sys' /f 2>&1 | Out-Null
reg add $svcKey /v Start     /t REG_DWORD     /d 1 /f 2>&1 | Out-Null
W '已设置 ImagePath=\SystemRoot\system32\DRIVERS\VBoxDrv.sys  Start=1'

# 3. 立即加载并验证
W '--- sc start VBoxDrv ---'
W ((& sc.exe start VBoxDrv 2>&1 | Out-String).Trim())
Start-Sleep -Seconds 2
$q = (& sc.exe query VBoxDrv 2>&1 | Out-String)
W $q.Trim()
$ok = ($q -match 'RUNNING')

# 4. 回退方案
if (-not $ok) {
  W '标准位置加载失败，走回退方案：复制驱动到 E:\Netexe 并还原原 ImagePath'
  if (Test-Path $src) { Copy-Item $src $alt -Force; W ('已复制 ' + $src + ' -> ' + $alt) }
  reg add $svcKey /v ImagePath /t REG_EXPAND_SZ /d '\??\E:\Netexe\VBoxDrv.sys' /f 2>&1 | Out-Null
  W ((& sc.exe start VBoxDrv 2>&1 | Out-String).Trim())
  Start-Sleep -Seconds 2
  $q2 = (& sc.exe query VBoxDrv 2>&1 | Out-String)
  W $q2.Trim()
  if ($q2 -match 'RUNNING') { $ok = $true }
}

if ($ok) {
  W '驱动加载结果：成功（RUNNING）'
  W '--- VBoxManage 自检 ---'
  W ((& $vbm list systemproperties 2>&1 | Out-String))
  W ((& $vbm list vms 2>&1 | Out-String).Trim())
} else {
  W '驱动加载结果：失败。请把本日志发回，需要进一步排查驱动签名/安全软件拦截。'
}
W '=== 结束 ==='
