/**
 * CP1252 解码（Windows-1252）。
 *
 * 为什么单独一层：PDF 的 WinAnsiEncoding 与老式 Word（.doc 的压缩分片）都用它，
 * 两处各抄一张表迟早会漂移。0x00–0x7F 与 0x A0–0xFF 与 Latin-1 相同，
 * 只有 0x80–0x9F 这 32 个位置是「可打印字符」（其余是控制字符）。
 */
const HIGH =
  '\u20ac\ufffd\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\ufffd\u017d\ufffd' +
  '\ufffd\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\ufffd\u017e\u0178'

/** 单字节 → 字符（0x80–0x9F 走 CP1252 表） */
export function cp1252Char(byte: number): string {
  const b = byte & 0xff
  if (b >= 0x80 && b <= 0x9f) return HIGH[b - 0x80]
  return String.fromCharCode(b)
}

/** 整段字节 → 字符串 */
export function decodeCp1252(bytes: Buffer | readonly number[]): string {
  let out = ''
  for (const b of bytes) out += cp1252Char(b)
  return out
}
