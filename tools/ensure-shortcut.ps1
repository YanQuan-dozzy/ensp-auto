# ensure-shortcut.ps1 —— 开始菜单快捷方式 + AppUserModelID 绑定（dev 任务栏身份的前提）
#
# 为什么需要（两处调用，本文件是唯一实现）：
#   1. package.json 的 dev script 前置：npm run dev 由 electron-vite 直拉 electron.exe，
#      没有「启动快捷方式」可关联；而任务栏对设置了 AUMID 的窗口，按「开始菜单/桌面里
#      带同 AUMID 的 .lnk」解析名称与图标 —— 找不到就回退 exe 元数据（名称 Electron +
#      Electron 图标）。start.ps1 在 %LOCALAPPDATA% 的 .lnk 不在解析搜索范围内。
#   2. start.ps1 默认分支（start.cmd / start.exe）§7.2：开始菜单多一个可用入口。
# AUMID 必须与 src/main/index.ts 的 APP_ID、electron-builder.yml 的 appId、
# start.ps1 §7.1 的 $AppAumid 一致：cn.enspauto.workbench。
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

  # 已安装 NSIS 版则跳过：安装版的开始菜单快捷方式带同一 AUMID，
  # dev 的任务栏直接借它解析；覆盖它反而会把开始菜单入口改成指向 electron.exe
  $installedExe = Join-Path $env:LOCALAPPDATA 'Programs\ensp-auto\ensp-auto.exe'
  if (Test-Path $installedExe) {
    Write-Host 'ensure-shortcut: installed build detected, reuse its shortcut'
    exit 0
  }

  $iconPath = Join-Path $Root 'resources\enspauto.ico'
  if (-not (Test-Path $iconPath)) { $iconPath = Join-Path $Root 'resources\app.ico' }

  $appAumid = 'cn.enspauto.workbench'
  $lnkPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\eNSPAuto.lnk'

  # WScript.Shell 不支持写 AUMID，走 IPropertyStore（PKEY_AppUserModel_ID）。
  # C# 与 start.ps1 §7.1 相同 —— 改这里记得那边同步。
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
                pv.vt = 31;
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

  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnkPath)
  $sc.TargetPath = $electronExe
  $sc.Arguments = '"' + $Root + '"'
  $sc.WorkingDirectory = $Root
  $sc.IconLocation = "$iconPath,0"
  $sc.Description = 'eNSPAuto - eNSP AI workbench (dev)'
  $sc.Save()

  if ([LnkAumid]::SetLnkAumid($lnkPath, $appAumid)) {
    # 写后读回断言，结果进启动日志/控制台 —— 真机排查有据可查
    $readback = [LnkAumid]::GetLnkAumid($lnkPath)
    if ($readback -eq $appAumid) {
      Write-Host ('ensure-shortcut: OK ' + $lnkPath)
    } else {
      Write-Host ('ensure-shortcut: AUMID readback mismatch: ' + $readback)
    }
  } else {
    Write-Host 'ensure-shortcut: bind AUMID failed (taskbar name falls back to exe image name eNSPAuto, still correct)'
  }
} catch {
  Write-Host ('ensure-shortcut: warn ' + $_.Exception.Message)
}
exit 0
