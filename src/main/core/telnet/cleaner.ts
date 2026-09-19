import {
  ANSI_CSI_RE,
  ANSI_OSC_RE,
  ANSI_SINGLE_RE,
  IAC,
  PAGING_RE
} from './patterns'

/**
 * 回显清洗。执行顺序不可调换（见 TELNET-SPEC.md §9）。
 *
 * 注意：IAC 剥离在字节层完成（stripIac），其余在文本层。
 */

/** 剥离 Telnet IAC 协商序列。这是字节层操作，必须在解码之前做 */
export function stripIac(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length)
  let n = 0
  let i = 0

  while (i < buf.length) {
    const b = buf[i]!
    if (b !== IAC) {
      out[n++] = b
      i++
      continue
    }
    // 到尾部只剩一个 IAC，说明序列被截断，丢弃
    if (i + 1 >= buf.length) break
    const cmd = buf[i + 1]!

    if (cmd === IAC) {
      // 转义的 0xFF 本身
      out[n++] = IAC
      i += 2
      continue
    }
    if (cmd === 0xfa) {
      // IAC SB ... IAC SE，整段丢弃
      let j = i + 2
      while (j + 1 < buf.length && !(buf[j] === IAC && buf[j + 1] === 0xf0)) j++
      i = j + 1 < buf.length ? j + 2 : buf.length
      continue
    }
    if (cmd >= 0xfb && cmd <= 0xfe) {
      // WILL / WONT / DO / DONT：IAC + 命令 + 选项，共 3 字节
      i += 3
      continue
    }
    // 两字节命令
    i += 2
  }

  return out.subarray(0, n)
}

/** 剥离 ANSI 转义序列 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_RE, '').replace(ANSI_OSC_RE, '').replace(ANSI_SINGLE_RE, '')
}

/**
 * 处理退格。`\b` 删除前一个字符，
 * 因此 `abcd\x08\x08xy` → `abxy`，`\b \b` 三元组也自然被正确处理。
 */
export function applyBackspaces(text: string): string {
  const out: string[] = []
  for (const ch of text) {
    if (ch === '\b') {
      out.pop()
      continue
    }
    out.push(ch)
  }
  return out.join('')
}

/** 归一化换行：\r\n → \n，孤立 \r → \n */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** 移除分页标记残留 */
export function stripPagingMarkers(text: string): string {
  return text.replace(new RegExp(PAGING_RE.source, 'gi'), '')
}

/**
 * 去除首部命令回显行。
 *
 * 设备会把长命令折行回显，而折行点可能在**词中间**（如 display current-config / uration），
 * 因此累积比对时不能插空格 —— 插了反而对不上。这里统一把两侧的空白全部去掉再比，
 * 于是「词中折行」与「词间折行」两种情况都能覆盖。
 */
export function removeEchoLine(text: string, command: string): string {
  const cmdKey = stripWhitespace(command)
  if (!cmdKey) return text

  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && lines[i]!.trim() === '') i++
  if (i >= lines.length) return text

  let acc = ''
  let j = i
  while (j < lines.length) {
    const piece = stripWhitespace(lines[j]!)
    if (piece === '') break
    acc += piece
    if (acc === cmdKey) {
      lines.splice(i, j - i + 1)
      return lines.join('\n')
    }
    if (!cmdKey.startsWith(acc)) break
    j++
  }
  return text
}

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, '')
}

/** 压缩空行：首尾去除，连续空行最多保留一行 */
export function compressBlankLines(text: string): string {
  return text
    .split('\n')
    .reduce<string[]>((acc, line) => {
      const blank = line.trim() === ''
      if (blank && acc.length > 0 && acc[acc.length - 1]!.trim() === '') return acc
      acc.push(line)
      return acc
    }, [])
    .join('\n')
    .trim()
}

/** 完整清洗流程（不含 IAC 剥离与尾部提示符去除，后两者在 TelnetClient 中处理） */
export function cleanResponse(raw: string, command: string): string {
  let t = stripAnsi(raw)
  t = applyBackspaces(t)
  t = normalizeNewlines(t)
  t = stripPagingMarkers(t)
  t = removeEchoLine(t, command)
  t = compressBlankLines(t)
  return t
}
