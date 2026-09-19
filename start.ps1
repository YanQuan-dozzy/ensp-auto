# ensp-auto 一键启动（PowerShell）
# 职责：检测 node → 装依赖（npmmirror + Electron 镜像）→ 起 dev。
# 双击 start.cmd 即可；也可在项目目录执行 .\start.ps1。
# 注意：全程不使用 &&/heredoc；npm 11 不认 .npmrc 的 electron_mirror，必须用环境变量。

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
  exit 1
}

Write-Host '=== ensp-auto 一键启动 ===' -ForegroundColor Cyan

# 1. 检测 node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail '未检测到 Node.js。请先安装 Node 24+（https://nodejs.org），再运行本脚本。'
}
Write-Host ("Node {0}" -f (node -v)) -ForegroundColor Green

# 2. Electron 二进制走镜像（npm11 不认 .npmrc 的环境变量方案）
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

# 3. 缺依赖 / 缺二进制才安装（避免每次全量 install）
$ElectronExe = Join-Path $Root 'node_modules\electron\dist\electron.exe'
$NeedInstall = $false
if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  $NeedInstall = $true
} elseif (-not (Test-Path $ElectronExe)) {
  $NeedInstall = $true
}

if ($NeedInstall) {
  Write-Host '首次运行：安装依赖（npmmirror + ELECTRON_MIRROR，含 Electron 二进制下载）…' -ForegroundColor Yellow
  Push-Location $Root
  npm install
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) {
    Fail 'npm install 失败。可手动执行：  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install'
  }
}

# 4. 二次硬检：沙箱/代理等环境下二进制可能下载失败
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

# 5. 起开发模式
Write-Host '依赖就绪，启动开发模式（npm run dev）…' -ForegroundColor Cyan
Push-Location $Root
npm run dev
$code = $LASTEXITCODE
Pop-Location
exit $code