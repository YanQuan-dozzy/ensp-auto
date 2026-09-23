# ensp-auto 一键启动（PowerShell，start.cmd / start.ps1 / start.exe 共用的实现）
# 职责：
#   默认   ：检测 node → 装依赖（npmmirror + Electron 镜像）→（源码有更新才）构建 →
#            创建 eNSPAuto.lnk 快捷方式并经快捷方式启动 electron —— 任务栏右键显示
#            「eNSPAuto」+ 项目图标（对标 Boss-claw 的启动器做法）。
#   -Dev   ：直接 npm run dev（HMR 开发模式；任务栏显示 Electron 属开发态，可接受）。
#   -Visible：保留当前控制台输出。
# 注意：全程不使用 &&/heredoc；npm 11 不认 .npmrc 的 electron_mirror，必须用环境变量。

param(
  [switch]$Dev,
  [switch]$Visible,
  [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
  # 老终端不支持时忽略
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Fail([string]$Msg) {
  Write-Host ''
  Write-Host $Msg -ForegroundColor Red
  Write-Host ''
  if ($Visible) {
    Read-Host '按任意键退出'
  } else {
    # 隐藏模式：稍作停留，让错误能写进日志再退出
    Start-Sleep -Seconds 5
  }
  exit 1
}

function Say([string]$Msg, [string]$Color = 'Cyan') {
  Write-Host $Msg -ForegroundColor $Color
}

Say '=== ensp-auto 启动器 ===' 'Cyan'
Say ("项目根：" + $Root) 'DarkGray'

# ---- 1. 检测 node（仅在需要安装 / 构建时才强依赖；纯启动已构建产物不需要）----
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Say ("Node " + (node -v)) 'Green' }

# ---- 2. Electron 二进制走镜像（npm11 不认 .npmrc 的环境变量方案）----
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

# ---- 3. 缺依赖 / 缺二进制才安装 ----
$ElectronExe = Join-Path $Root 'node_modules\electron\dist\electron.exe'
$NeedInstall = $false
if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  $NeedInstall = $true
} elseif (-not (Test-Path $ElectronExe)) {
  $NeedInstall = $true
}

if ($NeedInstall -and -not $NoInstall) {
  if (-not $node) {
    Fail '首次运行需要安装依赖，但未检测到 Node.js。请先安装 Node 24+（https://nodejs.org），再运行本脚本。'
  }
  Say '首次运行：安装依赖（npmmirror + ELECTRON_MIRROR，含 Electron 二进制下载）…' 'Yellow'
  Push-Location $Root
  npm install
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) {
    Fail 'npm install 失败。可手动执行：  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install'
  }
}

# ---- 4. 二次硬检：沙箱/代理等环境下二进制可能下载失败 ----
if (-not (Test-Path $ElectronExe)) {
  Fail @"
Electron 二进制缺失（当前环境未能自动下载）。请手动执行：

  `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
  npm install

仍失败则用浏览器打开 https://npmmirror.com/mirrors/electron/ 下载与
node_modules/electron/package.json 中 version 一致的文件，解压到
node_modules/electron/dist 后重跑本脚本。
"@
}

# ---- 5. 开发模式（HMR）：直接起 electron-vite dev ----
if ($Dev) {
  Say '开发模式（electron-vite dev，HMR）…' 'Cyan'
  Push-Location $Root
  npm run dev
  $code = $LASTEXITCODE
  Pop-Location
  if ($Visible) {
    Write-Host ''
    Write-Host ('开发模式已退出，exit=' + $code) 'DarkGray'
    Read-Host '按任意键退出'
  }
  exit $code
}

# ---- 6. 默认：源码有更新才构建 ----
$OutMain = Join-Path $Root 'out\main\index.js'

function Test-OutStale {
  if (-not (Test-Path $OutMain)) { return $true }
  $newest = (Get-Item $OutMain).LastWriteTimeUtc
  $checkRoots = @(
    (Join-Path $Root 'src'),
    (Join-Path $Root 'package.json'),
    (Join-Path $Root 'electron.vite.config.ts')
  )
  foreach ($r in $checkRoots) {
    if (-not (Test-Path $r)) { continue }
    $item = Get-Item $r
    if ($item.PSIsContainer) {
      Get-ChildItem $r -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.LastWriteTimeUtc -gt $newest) { $newest = $_.LastWriteTimeUtc }
      }
    } elseif ($item.LastWriteTimeUtc -gt $newest) {
      $newest = $item.LastWriteTimeUtc
    }
  }
  return ((Get-Item $OutMain).LastWriteTimeUtc -lt $newest)
}

if (Test-OutStale) {
  if (-not $node) {
    Fail '源码有更新需要重新构建，但未检测到 Node.js。请先安装 Node 24+（https://nodejs.org），再运行本脚本。'
  }
  Say '源码有更新，先构建（electron-vite build）…' 'Yellow'
  Push-Location $Root
  npm run build
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) {
    Fail 'npm run build 失败（见上方输出）。也可改用 -Dev 直接起 HMR。'
  }
}

if (-not (Test-Path $OutMain)) {
  Fail ('未找到构建产物 ' + $OutMain + '，且构建未成功。请确认源码完整后重试。')
}

# ---- 7. 创建快捷方式并经快捷方式启动（任务栏显示 eNSPAuto 而非 Electron）----
# 原理（对标 Boss-claw）：任务栏按钮的名称/图标取自「启动该进程的快捷方式(.lnk)」。
# 直接跑 electron.exe 时 Windows 会显示 exe 自带元数据（Electron/eNSPAuto 默认图标），
# 因此先在 %LOCALAPPDATA%\eNSPAuto 放置同名快捷方式，再经它拉起 electron.exe，
# Explorer 即把该窗口关联到「eNSPAuto + app.ico」。
$ScDir = Join-Path $env:LOCALAPPDATA 'eNSPAuto'
if (-not (Test-Path $ScDir)) { New-Item -ItemType Directory -Force -Path $ScDir | Out-Null }
$ScPath = Join-Path $ScDir 'eNSPAuto.lnk'
$IconPath = Join-Path $Root 'resources\enspauto.ico'
if (-not (Test-Path $IconPath)) { $IconPath = Join-Path $Root 'resources\app.ico' }

# 若快捷方式已存在，重写并刷新时间戳，确保 Explorer 重新获取图标
if (Test-Path $ScPath) {
  Remove-Item -Path $ScPath -Force -ErrorAction SilentlyContinue
}

try {
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($ScPath)
  $sc.TargetPath = $ElectronExe
  $sc.Arguments = "`"$Root`""
  $sc.WorkingDirectory = $Root
  $sc.IconLocation = "$IconPath,0"
  $sc.Description = 'eNSPAuto —— eNSP 网络实验的 AI 代理工作台'
  $sc.Save()
  (Get-Item $ScPath).LastWriteTime = Get-Date
} catch {
  Fail '创建 eNSPAuto.lnk 快捷方式失败：' + $_.Exception.Message
}

Say '快捷方式就绪，启动 eNSPAuto…' 'Green'
Start-Process -FilePath $ScPath | Out-Null

if ($Visible) {
  Write-Host ''
  Write-Host 'eNSPAuto 已启动（后台运行）。日志见 %LOCALAPPDATA%\ensp-auto\start.log' 'DarkGray'
  Read-Host '按任意键退出'
}
exit 0