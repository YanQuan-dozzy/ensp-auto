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
# 优先用补丁产物 eNSPAuto.exe（tools/patch-electron-exe.cjs 产出）：任务栏名称
# 回退取进程映像名，electron.exe 会显示 "Electron"，eNSPAuto.exe 显示 "eNSPAuto"。
$ElectronExe = Join-Path $Root 'node_modules\electron\dist\eNSPAuto.exe'
if (-not (Test-Path $ElectronExe)) {
  $ElectronExe = Join-Path $Root 'node_modules\electron\dist\electron.exe'
}
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
# 原理：主进程 setAppUserModelId 后，任务栏按钮按「AUMID → 关联快捷方式(.lnk)」解析
# 名称与图标；找不到就回退 exe 元数据（名称 Electron + Electron 图标）。
# v2.12 通知修复让主进程声明了 AUMID（cn.enspauto.workbench），但 WScript.Shell 建的
# .lnk 不带 AUMID → 关联断裂，任务栏身份退回 Electron —— 下方 7.1 补写绑定。
# NSIS 安装版由 electron-builder 自动给快捷方式写 AUMID，无需本段。
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

  # ---- 7.1 给 .lnk 写入 AppUserModelID（必须与 src/main/index.ts 的 APP_ID 一致）----
  # WScript.Shell 不支持该属性，走 IPropertyStore（PKEY_AppUserModel_ID）写 .lnk 属性流。
  # 失败不阻断启动（仅告警）——退化为修复前的任务栏显示。
  $AppAumid = 'cn.enspauto.workbench'
  try {
    if (-not ('LnkAumid' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class LnkAumid {
    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PropertyKey pkey);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant pv);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant pv);
        [PreserveSig] int Commit();
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHGetPropertyStoreFromParsingName(string pszPath, IntPtr pbc, uint gpsFlags, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ppv);
    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant pv);

    // PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, pid 5
    private static PropertyKey PkeyAumid = new PropertyKey {
        fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5
    };

    public static bool SetLnkAumid(string lnkPath, string aumid) {
        try {
            Guid iid = typeof(IPropertyStore).GUID;
            IPropertyStore store;
            // GPS_READWRITE(0x1)：SHCreateItemFromParsingName 拿到的是只读存储，
            // SetValue/Commit 会静默失败 —— 这是此前 AUMID 绑定一直不生效的根因
            SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 0x1, ref iid, out store);
            PropVariant pv = new PropVariant();
            try {
                pv.vt = 31; // VT_LPWSTR
                pv.pointerValue = Marshal.StringToCoTaskMemUni(aumid);
                PropertyKey k = PkeyAumid;
                if (store.SetValue(ref k, ref pv) != 0) return false;
                return store.Commit() == 0;
            } finally { PropVariantClear(ref pv); }
        } catch { return false; }
    }

    public static string GetLnkAumid(string lnkPath) {
        try {
            Guid iid = typeof(IPropertyStore).GUID;
            IPropertyStore store;
            // GPS_READWRITE(0x1)：SHCreateItemFromParsingName 拿到的是只读存储，
            // SetValue/Commit 会静默失败 —— 这是此前 AUMID 绑定一直不生效的根因
            SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 0x1, ref iid, out store);
            PropertyKey k = PkeyAumid;
            PropVariant pv;
            if (store.GetValue(ref k, out pv) != 0) return null;
            try {
                if (pv.vt != 31 || pv.pointerValue == IntPtr.Zero) return null;
                return Marshal.PtrToStringUni(pv.pointerValue);
            } finally { PropVariantClear(ref pv); }
        } catch { return null; }
    }
}
'@
    }
    if ([LnkAumid]::SetLnkAumid($ScPath, $AppAumid)) {
      # 写后读回断言，结果进 start.log —— 真机排查有据可查
      $readback = [LnkAumid]::GetLnkAumid($ScPath)
      if ($readback -eq $AppAumid) {
        Say ('快捷方式已绑定 AppUserModelID（' + $AppAumid + '）') 'DarkGray'
      } else {
        Say ('警告：AUMID 写入读回不一致：' + $readback) 'Yellow'
      }
    } else {
      Say '警告：.lnk 绑定 AppUserModelID 失败（系统限制）。任务栏名称回退取进程映像名 eNSPAuto，仍正确；通知不受影响' 'Yellow'
    }
  } catch {
    Say ('警告：AppUserModelID 绑定异常：' + $_.Exception.Message) 'Yellow'
  }
} catch {
  Fail '创建 eNSPAuto.lnk 快捷方式失败：' + $_.Exception.Message
}

# ---- 7.2 开始菜单快捷方式（唯一实现见 tools/ensure-shortcut.ps1）----
# 任务栏按 AUMID 解析名称/图标只搜「开始菜单 + 桌面」；§7 的 .lnk 在 %LOCALAPPDATA%
# 不在搜索范围，仅「经它启动」时生效。开始菜单放一份同 AUMID 的 .lnk，
# dev（electron-vite 直拉 electron.exe）与任何绕过启动器的场景都能正确解析身份。
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\ensure-shortcut.ps1')
} catch { }

Say '快捷方式就绪，启动 eNSPAuto…' 'Green'
Start-Process -FilePath $ScPath | Out-Null

if ($Visible) {
  Write-Host ''
  Write-Host 'eNSPAuto 已启动（后台运行）。日志见 %LOCALAPPDATA%\ensp-auto\start.log' 'DarkGray'
  Read-Host '按任意键退出'
}
exit 0