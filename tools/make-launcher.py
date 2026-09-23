# -*- coding: utf-8 -*-
"""生成 start.exe —— ensp-auto 的无窗口 GUI 启动器（C# 编译版）。

为什么不用「PE 追加 .launchz 节 + 改入口点指向脚本文本」的旧方案：
  入口点直接指向 PowerShell 脚本文本（非机器码），exe 一启动就在入口崩溃，
  表现为「双击 start.exe 无反应/瞬间退出且日志不增长」。该机制不可运行。

这里改为用 Windows 自带的 .NET Framework csc.exe 编译 tools/launcher.cs：
  - 产物是真正的 GUI 子系统 exe（/target:winexe），零控制台；
  - 行为：定位项目根 → 静默调用 powershell -File start.ps1 → 等待并透传退出码；
  - 编译时用 -win32icon 注入 app.ico，保证资源管理器里也显示项目图标。

用法：
  python tools/make-launcher.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

# csc 候选位置：Windows 自带 .NET Framework 编译器（x64 优先）
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "start.exe"
SRC = ROOT / "tools" / "launcher.cs"
ICO = ROOT / "resources" / "app.ico"


def find_csc() -> Path | None:
    env = os.environ.get("CSC_EXE")
    candidates = [Path(env)] if env else []
    candidates += [
        Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"),
    ]
    for c in candidates:
        if c.is_file():
            return c
    return None


def main() -> int:
    if not SRC.exists():
        print(f"缺少 {SRC}", file=sys.stderr)
        return 1

    csc = find_csc()
    if csc is None:
        print("找不到 csc.exe（.NET Framework 编译器），可用环境变量 CSC_EXE 指定", file=sys.stderr)
        return 1

    args = [str(csc), "/nologo", "/target:winexe", "/optimize"]
    if ICO.exists():
        args += ["/win32icon:" + str(ICO)]
    args += ["/out:" + str(OUT), str(SRC)]

    print(f"编译启动器：{csc.name} -> {OUT}")
    r = subprocess.run(args, text=True, capture_output=True)
    if r.returncode != 0:
        print(r.stdout, file=sys.stderr)
        print(r.stderr, file=sys.stderr)
        return r.returncode

    print(f"OK  {OUT}  ({OUT.stat().st_size} bytes, GUI 子系统、无控制台)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())