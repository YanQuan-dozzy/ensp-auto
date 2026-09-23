# -*- coding: utf-8 -*-
"""合成 ensp-auto 的应用图标（icon.png / icon-512.png / app.ico）。

支持两种输入：
  1) 项目官方图稿（resources/src/enspauto-logo.png，带透明通道的矢量级产物）：
     直接以Lanczos抗锯齿输出各档位，保留精确的圆角与渐变。
  2) AI 生成图稿（RGB方形原稿）：
     走去水印 → 色阶增强 → 中心裁切 → 4x 超采样圆角遮罩流程。

流程：
  读取图稿 → 构建 1024x1024 master → 导出 icon.png / icon-512.png / app.ico / _icon-preview.png。

用法：
  python tools/make-icon.py [图稿路径]      # 默认优先取 resources/src/enspauto-logo.png
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "resources" / "src"
OUT_ICO = ROOT / "resources" / "app.ico"
OUT_PNG = ROOT / "resources" / "icon.png"

# 导出尺寸（Windows 图标标准档位）
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
# 中心裁切比例（针对未裁切方形原图）
CROP_RATIO = 0.88
# 圆角半径占边长比例（针对方形原图）
RADIUS_RATIO = 0.19
# 小尺寸可读性增强（仅针对第三方暗色原图）
ENHANCE = dict(brightness=1.08, contrast=1.10, color=1.25)
# 遮罩超采样倍数（抗锯齿）
SS = 4
# 水印清理区域（相对原图 1024 的右下角）
WM_BOX = (860, 895, 1024, 1024)
WM_MIN_CHANNEL = 110  # 三通道都亮于此值视为水印笔画
WM_DILATE = 3         # 笔画周围一并抹除，消除抗锯齿边缘


def strip_watermark(img: Image.Image) -> Image.Image:
    """把右下角的水印抹成局部背景色（针对 AI 生成的原图）。"""
    px = img.load()
    x0, y0, x1, y1 = WM_BOX
    x1, y1 = min(x1, img.width), min(y1, img.height)

    samples = []
    for y in range(y0, y1, 3):
        for x in range(x0, x1, 3):
            r, g, b = px[x, y][:3]
            if min(r, g, b) < WM_MIN_CHANNEL:
                samples.append((r, g, b))
    if not samples:
        return img
    samples.sort(key=lambda c: c[0] + c[1] + c[2])
    bg = samples[len(samples) // 2]

    hits = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b = px[x, y][:3]
            if min(r, g, b) >= WM_MIN_CHANNEL:
                hits.append((x, y))
    for x, y in hits:
        for dy in range(-WM_DILATE, WM_DILATE + 1):
            for dx in range(-WM_DILATE, WM_DILATE + 1):
                nx, ny = x + dx, y + dy
                if x0 <= nx < x1 and y0 <= ny < y1:
                    px[nx, ny] = bg
    return img


def rounded_mask(size: int, radius_ratio: float = RADIUS_RATIO) -> Image.Image:
    """4x 超采样绘制圆角矩形遮罩，缩小后得到干净的抗锯齿边缘。"""
    big = size * SS
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=int(big * radius_ratio), fill=255
    )
    return mask.resize((size, size), Image.LANCZOS)


def build_master(src: Path, size: int = 1024) -> Image.Image:
    img = Image.open(src)
    # 若图稿本身已有透明通道（如项目官方 logo 图标），直接使用高质量重采样
    if img.mode == "RGBA":
        if img.size != (size, size):
            img = img.resize((size, size), Image.LANCZOS)
        return img

    # 针对未裁切的纯 RGB 方形原图（如第三方/AI 画稿）走去水印、裁切与圆角遮罩流程
    img = img.convert("RGB")
    img = strip_watermark(img)

    img = ImageOps.autocontrast(img, cutoff=(1, 1), preserve_tone=True)
    img = ImageEnhance.Brightness(img).enhance(ENHANCE["brightness"])
    img = ImageEnhance.Contrast(img).enhance(ENHANCE["contrast"])
    img = ImageEnhance.Color(img).enhance(ENHANCE["color"])

    w, h = img.size
    side = int(min(w, h) * CROP_RATIO)
    left, top = (w - side) // 2, (h - side) // 2
    content = img.crop((left, top, left + side, top + side))

    art = content.resize((size, size), Image.LANCZOS).convert("RGBA")
    art.putalpha(rounded_mask(size))
    return art


def save_ico(master: Image.Image, dst: Path) -> None:
    """Pillow 按 sizes 生成多档 ICO；显式给定各档位以控制每档的采样质量。"""
    frames = [master.resize((s, s), Image.LANCZOS) for s in ICO_SIZES]
    frames[-1].save(
        dst,
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=frames[:-1],
    )


def write_preview(master: Image.Image, dst: Path) -> None:
    """拼一张小尺寸对照图，便于目检 16/24/32px 下是否清晰。"""
    tiles = [(s, master.resize((s, s), Image.LANCZOS)) for s in (16, 24, 32, 48, 64)]
    pad = 12
    sheet = Image.new(
        "RGBA",
        (sum(t.width for _, t in tiles) + pad * (len(tiles) + 1), 64 + pad * 2),
        (255, 255, 255, 255),
    )
    x = pad
    for _, t in tiles:
        sheet.alpha_composite(t, (x, pad + (64 - t.height) // 2))
        x += t.width + pad
    sheet.save(dst)


def ico_sizes_of(path: Path) -> list[int]:
    """读回 .ico 目录，确认各档位确实写入。"""
    b = path.read_bytes()
    count = struct.unpack_from("<H", b, 4)[0]
    return [b[6 + i * 16] or 256 for i in range(count)]


def main(argv: list[str]) -> int:
    if argv:
        src = Path(argv[0])
    else:
        canonical = SRC_DIR / "enspauto-logo.png"
        if canonical.exists():
            src = canonical
        else:
            cands = sorted(SRC_DIR.glob("*.png"), key=lambda p: p.stat().st_mtime)
            if not cands:
                print(f"没有可用的图稿：把 PNG 放进 {SRC_DIR}", file=sys.stderr)
                return 1
            src = cands[-1]
    if not src.exists():
        print(f"图稿不存在：{src}", file=sys.stderr)
        return 1

    master = build_master(src)
    master.save(OUT_PNG)
    master.resize((512, 512), Image.LANCZOS).save(OUT_PNG.with_name("icon-512.png"))
    save_ico(master, OUT_ICO)
    save_ico(master, ROOT / "resources" / "enspauto.ico")
    write_preview(master, ROOT / "resources" / "_icon-preview.png")

    print(f"图稿     : {src.name}")
    print(f"icon.png : {OUT_PNG} ({master.width}x{master.height}, 圆角透明)")
    print(f"app.ico  : {OUT_ICO} 档位={ico_sizes_of(OUT_ICO)}")
    print(f"enspauto.ico : {ROOT / 'resources' / 'enspauto.ico'}")
    print(f"预览     : resources/_icon-preview.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
