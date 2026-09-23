import type { Encoding } from '@shared/types'
import { REPLACEMENT_CHAR } from './patterns'

/**
 * 编码处理。
 *
 * 两条硬规则（来自 TELNET-SPEC.md §7）：
 * 1. 绝不使用 errors='ignore'。无法解码的字节保留为替换符并置 decodeIssues，
 *    让上层知道这段文本可能有损，而不是静默丢字。
 * 2. 解码必须在字节层完成。多字节字符可能跨越两次 recv 的边界，
 *    逐段解码会产出「半个汉字」。
 *
 * 实现选择：用 Node/Electron 内置的 TextDecoder，不引 iconv-lite。
 * Node 22+ 与 Electron 均自带完整 ICU，`gbk` 可用；启动时做一次探测，
 * 不可用时降级并标记，不静默出错。
 */

const utf8Fatal = new TextDecoder('utf-8', { fatal: true })
const utf8Loose = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

let gbkDecoder: TextDecoder | null = null
let gbkProbed = false

function getGbkDecoder(): TextDecoder | null {
  if (!gbkProbed) {
    gbkProbed = true
    try {
      const d = new TextDecoder('gbk', { fatal: false })
      // 探针：GBK 的「中」是 0xD6 0xD0
      if (d.decode(new Uint8Array([0xd6, 0xd0])) === '中') gbkDecoder = d
    } catch {
      gbkDecoder = null
    }
  }
  return gbkDecoder
}

export interface DecodeResult {
  text: string
  encoding: Encoding
  /** 文本中是否含替换符（说明有损） */
  issues: boolean
}

function countReplacement(text: string): number {
  let n = 0
  for (const ch of text) if (ch === REPLACEMENT_CHAR) n++
  return n
}

/** 是否为纯 ASCII（纯 ASCII 时两种编码等价，直接判 utf8） */
function isAscii(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i]! > 0x7f) return false
  return true
}

/** UTF-8 严格校验：能通过就说明是合法 UTF-8。这是编码判定的主判据 */
function isValidUtf8(buf: Buffer): boolean {
  try {
    utf8Fatal.decode(buf)
    return true
  } catch {
    return false
  }
}

/**
 * 「这段文本像不像乱码」检查。
 *
 * 用途有限但必要：GBK 字节偶尔整体也是合法 UTF-8，此时要靠内容合理性兜底。
 * eNSP 的回显里可能出现英文与中文，但不会出现成片的希伯来/阿拉伯文 ——
 * 那正是 GBK 被误当 UTF-8 时的典型落点。因此只在这几种语言上判乱码，
 * 不动其他任何情况。
 */
function looksLikeMojibake(text: string): boolean {
  let suspicious = 0
  let nonAscii = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) continue
    nonAscii++
    if ((c >= 0x0590 && c <= 0x05ff) || (c >= 0x0600 && c <= 0x06ff)) suspicious++
  }
  return nonAscii >= 4 && suspicious / nonAscii > 0.3
}

export interface EncodingVerdict {
  encoding: Encoding
  /** 是否是基于非 ASCII 证据得出的结论（只有此时才适合锁定编码） */
  confident: boolean
}

/**
 * 主判据是「能否通过严格 UTF-8 校验」，副判据是内容合理性。
 *
 * 为什么不直接用「哪种解码的汉字更多」：GBK 几乎把任意字节对都映射成汉字，
 * 拿 UTF-8 的中文去按 GBK 解码通常也能解出一堆汉字，绝对数量反而更多，
 * 会系统性地把 UTF-8 误判成 GBK。
 *
 * 反过来，一段较长的 GBK 中文几乎不可能整体通过严格 UTF-8 校验
 * （GBK 的后续字节落在 0x40–0xFE，其中约一半不是合法的 UTF-8 后续字节），
 * 所以严格校验是可靠的主判据。
 */
export function detectEncodingDetailed(rawBuf: Buffer): EncodingVerdict {
  if (rawBuf.length === 0) return { encoding: 'utf8', confident: false }
  if (isAscii(rawBuf)) return { encoding: 'utf8', confident: false }

  // T4.3：TCP 分片会把一个汉字劈成两半（前 1~2 字节在这一片、剩下的在下一片），
  // 此时严格 UTF-8 校验必然失败 → 误锁 GBK，之后所有中文都成乱码。
  // 判定用的样本先切掉尾部不完整序列，等下一片到了自然能通过校验。
  const buf = trimIncompleteTail(rawBuf)

  if (isValidUtf8(buf)) {
    const text = utf8Loose.decode(buf)
    if (!looksLikeMojibake(text)) return { encoding: 'utf8', confident: true }
    // 合法但内容荒谬 —— 按 GBK 再试
    return getGbkDecoder() ? { encoding: 'gbk', confident: true } : { encoding: 'utf8', confident: true }
  }

  return getGbkDecoder() ? { encoding: 'gbk', confident: true } : { encoding: 'utf8', confident: true }
}

/**
 * 切掉尾部「不完整的多字节序列」（UTF-8 语义）。
 *
 * 只处理结尾最多 3 个字节：找到领头字节后比较它需要几字节、实际还剩几字节，
 * 不够就截掉。完整的结尾原样返回，因此对正常输入没有任何影响。
 */
export function trimIncompleteTail(buf: Buffer): Buffer {
  for (let back = 1; back <= 4 && back <= buf.length; back++) {
    const b = buf[buf.length - back]!
    if ((b & 0x80) === 0) return buf // 结尾是 ASCII → 必定完整
    if ((b & 0xc0) === 0xc0) {
      // 领头字节：算出它需要的总长度
      const need = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 0
      if (need === 0) return buf // 非法领头字节，交给校验器判
      return back < need ? buf.subarray(0, buf.length - back) : buf
    }
    // 0x80..0xbf：后续字节，继续往前找领头
  }
  return buf
}

/**
 * 按「UTF-8 优先、失败回退 GBK」判定编码。
 * 返回更可信的那种，细节见 detectEncodingDetailed。
 */
export function detectEncoding(buf: Buffer): Encoding {
  return detectEncodingDetailed(buf).encoding
}

export function decode(buf: Buffer, encoding: Encoding): DecodeResult {
  if (encoding === 'gbk') {
    const d = getGbkDecoder()
    if (d) {
      const text = d.decode(buf)
      return { text, encoding: 'gbk', issues: countReplacement(text) > 0 }
    }
    // GBK 不可用：退回宽松 UTF-8 并标记有损，不静默伪装成功
    const text = utf8Loose.decode(buf)
    return { text, encoding: 'utf8', issues: countReplacement(text) > 0 || !isAscii(buf) }
  }
  const text = utf8Loose.decode(buf)
  return { text, encoding: 'utf8', issues: countReplacement(text) > 0 }
}

/**
 * 从字节流的尾部截取一段用于增量检测（分页 / 提示符 / 确认提示）。
 *
 * 关键细节：截断点可能落在多字节字符中间。这里回退跳过 UTF-8 续接字节（0b10xxxxxx），
 * 避免在尾部检测时产生虚假的替换符；GBK 的双字节序列同样跳过 0x40–0xFE 区间的续字节。
 * 由于检测只看尾部，起点处的少量偏差不影响判定。
 */
export function tailSlice(buf: Buffer, tailBytes: number): Buffer {
  if (buf.length <= tailBytes) return buf
  let start = buf.length - tailBytes
  // 跳过 UTF-8 / GBK 续接字节
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++
  return buf.subarray(start)
}

/** 探测当前环境的 GBK 支持情况，用于启动日志与设置页展示 */
export function probeEncodingSupport(): { utf8: boolean; gbk: boolean } {
  return { utf8: true, gbk: getGbkDecoder() !== null }
}
