import { decodeCp1252 } from '../../charset/cp1252'
import { normalizeText } from '../textNormalize'
import type { DocExtractResult } from './ooxml'

/**
 * RTF 文本抽取（v2.1）。
 *
 * RTF 是「带控制字的纯文本」：`{\rtf1\ansi\ansicpg936 Hello \par World}`。
 * 抽取要点：
 * - `\par` / `\line` / `\page` → 换行，`\tab` → 制表，`\cell` / `\row` → 表格分隔；
 * - `\'hh` 是**按代码页**编码的字节（中文 RTF 常见 `\ansicpg936` → 两两一组才是 GBK），
 *   所以连续的十六进制转义要攒成字节串再整体解码，不能一个字节一个字符；
 * - `\uN?` 是 Unicode 码位，后面带 `\ucN`（默认 1）个「回退字符」要跳掉；
 * - 字体表/颜色表/样式表/图片/域代码这些「目标组」要整组跳过，
 *   其中 `{\*\...}` 按规范就是「不认识就忽略」。
 */

/** 整组跳过的目标（它们的文字不是正文） */
const SKIP_DESTS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'datastore',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'generator',
  'filetbl',
  'revtbl',
  'xmlnstbl'
])

export function extractRtf(buf: Buffer): DocExtractResult {
  const raw = buf.toString('latin1')
  if (!raw.startsWith('{\\rtf')) {
    return { ok: false, reason: 'parse-failed', error: '不是 RTF 文档（缺少 {\\rtf 头）' }
  }
  const text = normalizeText(rtfToText(raw))
  if (!text) return { ok: false, reason: 'no-text', error: 'RTF 里没有可抽取的文字' }
  return { ok: true, text }
}

/** 只用等宽 ASCII 视角扫，字节转义一律走 `\'hh`（RTF 规范如此） */
export function rtfToText(raw: string): string {
  let out = ''
  let i = 0
  let codepage = 1252
  /** `\uc` 指定回退字符个数，默认 1 */
  let ucSkip = 1
  /** 待解码的 `\'hh` 字节串（连续出现才在一起解码） */
  let hexBuf: number[] = []

  const flushHex = (): void => {
    if (hexBuf.length === 0) return
    out += decodeBytes(Buffer.from(hexBuf), codepage)
    hexBuf = []
  }

  while (i < raw.length) {
    const ch = raw[i]

    if (ch === '{') {
      // `{\*\...}` 或目标组：整组跳过，直到配对的花括号（字体表、颜色表、图片等）
      const name = /^\{\s*\\\*?\\?([a-zA-Z]+)/.exec(raw.slice(i, i + 40))?.[1] ?? ''
      const ignorable = raw.startsWith('{\\*', i)
      if (ignorable || SKIP_DESTS.has(name.toLowerCase())) {
        flushHex()
        i = matchGroupEnd(raw, i)
        continue
      }
      i += 1
      continue
    }
    if (ch === '}') {
      flushHex()
      i += 1
      continue
    }
    if (ch === '\\') {
      const next = raw[i + 1]
      if (next === "'") {
        hexBuf.push(Number.parseInt(raw.slice(i + 2, i + 4), 16) || 0)
        i += 4
        continue
      }
      flushHex()
      if (next === '\\' || next === '{' || next === '}') {
        // 转义的定界符：字面输出
        out += next
        i += 2
        continue
      }
      if (next === '*') {
        // 单独的 `\*`：其所在组按「可忽略目标」处理，但组头已被上面拦下
        i += 2
        continue
      }
      const m = /^\\([a-zA-Z]+)(-?\d+)?\s?/.exec(raw.slice(i))
      if (!m) {
        // `\;` `\~` `\-` 之类：只有 `\~`（不换行空格）有文字意义
        if (next === '~') out += ' '
        i += 2
        continue
      }
      const word = m[1].toLowerCase()
      const num = m[2] === undefined ? undefined : Number(m[2])
      i += m[0].length
      switch (word) {
        case 'par':
        case 'line':
        case 'page':
        case 'row':
          out += '\n'
          break
        case 'tab':
        case 'cell':
        case 'nestcell':
          out += '\t'
          break
        case 'ansicpg':
          if (num) codepage = num
          break
        case 'uc':
          if (num !== undefined) ucSkip = Math.max(0, num)
          break
        case 'u': {
          if (num !== undefined) {
            // 负数按 16 位补码还原（RTF 的 \uN 是带符号的）
            const code = num < 0 ? num + 0x10000 : num
            out += String.fromCharCode(code & 0xffff)
            // 跳掉回退字符：可能是普通字符，也可能是 `\'hh` 转义
            let skipped = 0
            while (skipped < ucSkip && i < raw.length) {
              if (raw[i] === '\\' && raw[i + 1] === "'") i += 4
              else if (raw[i] === '\\') {
                const mm = /^\\([a-zA-Z]+)(-?\d+)?\s?/.exec(raw.slice(i))
                i += mm ? mm[0].length : 2
              } else i += 1
              skipped += 1
            }
          }
          break
        }
        default:
          break
      }
      continue
    }
    if (ch === '\r' || ch === '\n') {
      flushHex()
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  flushHex()
  return out
}

/** 从 `{` 开始找到配对的 `}` 之后的位置（跳过 `\'hh` 与转义花括号） */
function matchGroupEnd(raw: string, start: number): number {
  let depth = 0
  let i = start
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\\') {
      if (raw[i + 1] === "'") {
        i += 4
        continue
      }
      const m = /^\\([a-zA-Z]+)/.exec(raw.slice(i, i + 16))
      i += m ? m[0].length : 2
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return raw.length
}

/** 按代码页解码字节串（中文 RTF 多为 936 = GBK；解不了就退回 CP1252） */
function decodeBytes(bytes: Buffer, codepage: number): string {
  const label =
    codepage === 936 ? 'gbk' : codepage === 950 ? 'big5' : codepage === 932 ? 'shift_jis' : ''
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes)
    } catch {
      // 运行时没有该代码页（ICU 精简版）→ 落到 CP1252
    }
  }
  return decodeCp1252(bytes)
}
