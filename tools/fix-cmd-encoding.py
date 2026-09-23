# -*- coding: utf-8 -*-
"""把 .cmd 转成中文 Windows 上 cmd.exe 能正确解析的形式：GBK + CRLF。

cmd.exe 按系统 OEM 代码页（中文 Windows = 936/GBK）解码脚本字节。
用 UTF-8 写中文注释会被解成乱码，注释里的字节甚至可能拼出
引号或重定向符，把整行语法带偏（实测会报一连串
"'xxx' 不是内部或外部命令"）。

注意：PowerShell 的 [IO.File]::WriteAllText 在中文 Windows 下会静默
把 UTF-8 转成 GBK，必须用 Python 显式指定 codec，别用 PowerShell。

用法：
  python tools/fix-cmd-encoding.py start.cmd [more.cmd ...]
"""

from __future__ import annotations

import sys
from pathlib import Path


def fix(path: Path) -> tuple[bool, str]:
    raw = path.read_bytes()
    text = raw.decode("utf-8-sig")
    body = text.replace("\r\n", "\n").replace("\n", "\r\n")
    data = body.encode("gbk")  # 中文 Windows 的 OEM 代码页
    if data == raw:
        return False, "已是 GBK+CRLF"
    path.write_bytes(data)
    return True, f"{len(raw)} -> {len(data)} bytes"


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    for a in argv:
        p = Path(a)
        if not p.exists():
            print(f"SKIP  {p} (不存在)")
            continue
        changed, note = fix(p)
        print(f"{'FIXED' if changed else 'OK   '} {p}  {note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
