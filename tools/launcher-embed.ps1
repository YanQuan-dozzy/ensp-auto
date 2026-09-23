# ensp-auto 启动器（无窗口版）
# 本文件由 tools/make-launcher.py 内嵌进 start.exe 的 .launchz 节；
# 运行时由 GUI 子系统的 start.exe 解出到 %TEMP% 后以 powershell -File 执行。
# 不直接双击本文件 —— 改了它必须重跑 make-launcher.py 才会生效。
# 职责：日志落盘 → 定位项目根 → 委托 start.ps1（构建 + eNSPAuto.lnk 快捷方式启动）。

$ErrorActionPreference = 'Stop'

# ---- 控制台已被剥离，输出重定向到日志文件 ----
$LogDir  = Join-Path $env:LOCALAPPDATA 'ensp-auto'
$LogFile = Join-Path $LogDir 'start.log'
try {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Start-Transcript -Path $LogFile -Append -Force | Out-Null
} catch {
  # 记不上日志也要继续跑
}

function Say([string]$Msg, [string]$Color = 'Gray') {
  Write-Host $Msg -ForegroundColor $Color
}

function Die([string]$Msg) {
  Say '' 'Red'
  Say $Msg 'Red'
  Say '' 'Red'
  Say ('日志：' + $LogFile) 'DarkGray'
  try { Stop-Transcript | Out-Null } catch {}
  exit 1
}

# ---- 定位项目根：ENSP_AUTO_ROOT > 当前工作目录(双击启动时 = exe 所在目录) > 脚本所在目录 ----
# 注意：内嵌脚本被解到 %TEMP%，$MyInvocation.MyCommand.Path 是 %TEMP%，不可作根；
# 用「当前目录有 package.json」兜底，覆盖从资源管理器双击 start.exe 的常见场景。
$Root = $null
if ($env:ENSP_AUTO_ROOT -and (Test-Path $env:ENSP_AUTO_ROOT)) {
  $Root = $env:ENSP_AUTO_ROOT
} elseif (Test-Path (Join-Path (Get-Location).Path 'package.json')) {
  $Root = (Get-Location).Path
} elseif (Test-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'package.json')) {
  $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
}

if (-not $Root -or -not (Test-Path (Join-Path $Root 'package.json'))) {
  Die '无法定位 ensp-auto 项目根目录（未找到 package.json）。请把 start.exe 放回项目根目录运行。'
}

Say '=== ensp-auto 启动器 ===' 'Cyan'
Say ('项目根：' + $Root) 'DarkGray'
Say ('日志：  ' + $LogFile) 'DarkGray'

# ---- 1. 找 node（GUI 进程继承的 PATH 可能缺 node，按常见位置兜底）----
$nodeExe = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $nodeExe = $cmd.Source }

if (-not $nodeExe) {
  $guesses = @(
    'E:\Node.js\node.exe',
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  foreach ($g in $guesses) {
    if (Test-Path $g) { $nodeExe = $g; break }
  }
}

if (-not $nodeExe) {
  Die '未检测到 Node.js。请先安装 Node 24+（https://nodejs.org），再双击 start.exe。'
}
$nodeDir = Split-Path -Parent $nodeExe
$env:PATH = $nodeDir + ';' + $env:PATH

# ---- 2. 清理可能干扰 Electron 的环境变量 ----
foreach ($v in 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PYTHONPATH') {
  if (Test-Path "Env:$v") { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
}

# ---- 3. 委托 start.ps1：构建（源码有更新时）+ 创建 eNSPAuto.lnk 并经快捷方式启动 ----
# start.ps1 内部负责镜像配置、依赖安装、构建、快捷方式与拉起 electron。
$ScriptPath = Join-Path $Root 'start.ps1'
if (-not (Test-Path $ScriptPath)) {
  Die '缺少 start.ps1，start.exe 无法启动。请确认项目文件完整。'
}

$wantTail = ($env:ENSP_AUTO_LOG -eq '1')
if ($wantTail) {
  if (Get-Command wt.exe -ErrorAction SilentlyContinue) {
    Start-Process wt.exe -ArgumentList @(
      '-w', 'new',
      'new-tab', '--title', 'eNSPAuto',
      'powershell', '-NoProfile', '-NoExit', '-Command',
      "Get-Content -LiteralPath '$LogFile' -Wait -Tail 40"
    ) | Out-Null
  } else {
    Start-Process powershell.exe -ArgumentList @(
      '-NoProfile', '-NoExit', '-Command',
      "Get-Content -LiteralPath '$LogFile' -Wait -Tail 40"
    ) | Out-Null
  }
}

$env:ENSP_AUTO_ROOT = $Root
Push-Location $Root
try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath } finally { Pop-Location }
$code = $LASTEXITCODE

Say ('启动器已退出，exit=' + $code) 'DarkGray'
try { Stop-Transcript | Out-Null } catch {}
exit $code