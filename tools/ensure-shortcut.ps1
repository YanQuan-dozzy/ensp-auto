# ensure-shortcut.ps1 —— 在开始菜单放一份指向 eNSPAuto 的快捷方式（dev/便携任务栏身份的前提）
#
# 为什么需要（两处调用，本文件是唯一实现）：
#   1. package.json 的 dev script 前置：npm run dev 由 electron-vite 直拉 electron.exe，
#      没有「启动快捷方式」可关联。放一份开始菜单快捷方式后，Explorer 解析任务栏
#      名称/图标时能命中的应用入口（图标 + 名称都取它）。
#   2. start.ps1 默认分支（start.cmd / start.exe）§7.2：开始菜单多一个可用入口。
#
# ★ v2.23 重要变更：**不再尝试给 .lnk 写 AUMID**。
#   本机 Win11 无法用标准 API 写 .lnk 的 PKEY_AppUserModel_ID（HRESULT 级实测
#   STG_E_ACCESSDENIED；ShellLink 对象 commit 返回 S_OK 也不落盘），此路已封死。
#   同时主进程已改为**只在 app.isPackaged 时设 AUMID**（见 src/main/index.ts），
#   dev/便携不设 AUMID → Explorer 走启动快捷方式/exe 元数据，本脚本只需提供入口。
#   AUMID 仍是安装版的事；这里不再需要与它对齐。
#
# 任何失败只告警、恒 exit 0 —— 绝不能挡住 dev 启动。
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Continue'

try {
  # 进程本体优先 eNSPAuto.exe（tools/patch-electron-exe.cjs 产出）：任务栏名称
  # 回退取进程映像名，electron.exe → "Electron"、eNSPAuto.exe → "eNSPAuto"
  $electronExe = Join-Path $Root 'node_modules\electron\dist\eNSPAuto.exe'
  if (-not (Test-Path $electronExe)) {
    $electronExe = Join-Path $Root 'node_modules\electron\dist\electron.exe'
  }
  if (-not (Test-Path $electronExe)) {
    Write-Host 'ensure-shortcut: electron.exe not found, skip'
    exit 0
  }

  # 已安装 NSIS 版则跳过：安装版自带带 AUMID 的开始菜单快捷方式，
  # 覆盖它反而会把开始菜单入口改成指向 node_modules 里的 electron.exe。
  $installedExe = Join-Path $env:LOCALAPPDATA 'Programs\ensp-auto\ensp-auto.exe'
  if (Test-Path $installedExe) {
    Write-Host 'ensure-shortcut: installed build detected, reuse its shortcut'
    exit 0
  }

  $iconPath = Join-Path $Root 'resources\enspauto.ico'
  if (-not (Test-Path $iconPath)) { $iconPath = Join-Path $Root 'resources\app.ico' }

  $lnkPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\eNSPAuto.lnk'

  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnkPath)
  $sc.TargetPath = $electronExe
  $sc.Arguments = '"' + $Root + '"'
  $sc.WorkingDirectory = $Root
  $sc.IconLocation = "$iconPath,0"
  $sc.Description = 'eNSPAuto - eNSP AI workbench (dev)'
  $sc.Save()

  if (Test-Path $lnkPath) {
    Write-Host ('ensure-shortcut: OK ' + $lnkPath)
  } else {
    Write-Host 'ensure-shortcut: shortcut not created (unexpected)'
  }
} catch {
  Write-Host ('ensure-shortcut: warn ' + $_.Exception.Message)
}
exit 0
