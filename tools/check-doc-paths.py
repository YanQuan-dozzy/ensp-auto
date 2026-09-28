# -*- coding: utf-8 -*-
"""校验文档里引用的文件路径是否真的存在于仓库中（T5.6 的验收手段）。

存在的意义：文档一旦开始指向「已经改名/删掉的文件」，读的人会照着不存在的路径
去翻源码，最后得出「这个项目文档不可信」的结论 —— 而这类漂移没有任何编译期信号。
本脚本把「文档里的路径」抽出来逐个核对，发现失效引用以非零码退出，可挂进 CI。

用法：
  python tools/check-doc-paths.py            # 检查 docs/*.md 与 README.md
  python tools/check-doc-paths.py --verbose

约定：
- 允许只写文件名（如 `TelnetClient.ts`）—— 全仓能找到同名文件即算通过；
- 允许白名单里的**运行期产物**路径（如 exports/xxx.json，不是源码）；
- 不检查代码块里的命令行示例（只认形如 a/b/c.ext 的相对路径）。
  注意：**必须含 `/`**才会被抽取 —— 「只写文件名」是靠 PATH_RE 匹配到 `a/b/name.ts`
  之后再退回 basename 比对实现的，而不是逐个裸文件名去扫（那样会把正文里的泛指词
  也当路径，噪声大到没法用）。
"""
from __future__ import print_function

import io
import os
import re
import sys
import glob

# 运行期产物 / 外部依赖目录：文档里描述的是「文件会生成在哪」，不是仓库里的文件。
# 只按**路径段**匹配（而不是 `a in raw` 的子串包含）—— 后者会把 `myexports/x.json`、
# `output/` 这类含相同子串的路径也放过去。
ALLOW_SEGMENTS = (
    'exports',
    'attachments',
    'snapshots-data',
    'userData',
    'node_modules',
    'out',
)

TARGETS = ['README.md'] + [
    p for p in sorted(glob.glob('docs/*.md')) if os.path.basename(p) != 'OPTIMIZATION-REVIEW.md'
]

# 注意：扩展名分支里 tsx 必须排在 ts 前面，否则正则会把 .tsx 截成 .ts
# 扩展名清单要覆盖仓库里真实存在的类型（漏一种 = 该类路径漂移不会被发现）
PATH_RE = re.compile(
    r'[A-Za-z0-9_@./-]+/[A-Za-z0-9_.-]+\.'
    r'(?:tsx|mts|cts|cjs|mjs|ts|py|json|yml|yaml|css|md|topo|ps1|cmd|vbs|cs|ico)'
)


def is_allowed(raw):
    """白名单匹配：按路径段比对，而不是子串包含"""
    parts = [p for p in raw.split('/') if p]
    return parts[0] in ALLOW_SEGMENTS if parts else False


def build_name_index():
    """文件名 → 是否存在（用于允许「只写文件名」的简写引用）"""
    names = set()
    for root in ('src', 'tests', 'tools'):
        for _dp, _dirs, fns in os.walk(root):
            for fn in fns:
                names.add(fn)
    return names


def main():
    verbose = '--verbose' in sys.argv
    names = build_name_index()

    total = 0
    bad = []
    for doc in TARGETS:
        if not os.path.isfile(doc):
            continue
        text = io.open(doc, encoding='utf-8').read()
        for m in PATH_RE.finditer(text):
            raw = m.group(0).strip('`(),.:;')
            if is_allowed(raw):
                continue
            total += 1
            rel = raw.lstrip('./')
            if os.path.exists(rel):
                continue
            if os.path.basename(rel) in names:
                continue
            bad.append((doc, raw))

    print('检查文档 %d 份，抽取路径引用 %d 条' % (len(TARGETS), total))
    if bad:
        print('失效引用 %d 条：' % len(bad))
        for doc, raw in bad:
            print('  %s -> %s' % (doc, raw))
        return 1
    if verbose:
        print('全部路径均可定位 ✔')
    return 0


if __name__ == '__main__':
    sys.exit(main())
