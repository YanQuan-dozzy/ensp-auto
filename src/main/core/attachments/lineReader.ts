import fs from 'node:fs'
import { decode, detectEncoding } from '../telnet/encoding'
import type { Encoding } from '@shared/types'

/**
 * 按「行窗口」读文件（附件分页用，T4.8）。
 *
 * 为什么不能直接 `readFileSync` + `split`：附件可以是 20 MB 的配置文件，
 * 翻到第 10 页时前面 9 页的内容仍然被整份读进内存再切一遍 —— 既慢又占内存，
 * 而调用方（read_attachment）只需要其中 400 行。
 *
 * 这里改成流式扫描：按 1 MB 分片读，维护「跨分片的半行」，
 * 只把落在 [from, to) 区间内的行放进结果；文件大小只影响扫描耗时，不影响内存占用。
 * 返回总行数仍然是精确值（要扫完整份文件才能数出来），但不再构造巨型字符串数组。
 */

export interface LineWindow {
  text: string
  encoding: Encoding
  totalLines: number
  from: number
  to: number
  truncated: boolean
}

/** 分片大小：1 MB。太小会显著增加 syscall 次数，太大会放大峰值内存 */
const CHUNK_BYTES = 1 << 20

/** 头部探测窗口：编码判定只看开头这一段（与预览口径一致） */
const DETECT_BYTES = 64 * 1024

export function readLineWindow(
  file: string,
  from: number,
  take: number
): LineWindow | { error: string } {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size

    // 1) 先看头部：判编码 + 二进制判定（含 NUL 视为二进制）
    const headLen = Math.min(size, DETECT_BYTES)
    const head = Buffer.alloc(headLen)
    if (headLen > 0) fs.readSync(fd, head, 0, headLen, 0)
    if (head.includes(0)) return { error: '二进制文件，无法按文本读取' }
    const encoding = detectEncoding(head)

    // 2) 从 0 开始扫描，逐行归位
    const decoder = new TextDecoder(encoding === 'gbk' ? 'gbk' : 'utf-8')
    const buf = Buffer.alloc(CHUNK_BYTES)
    let carry = ''
    let lineIndex = 0
    const picked: string[] = []
    const end = from + take
    let position = 0

    for (;;) {
      const read = fs.readSync(fd, buf, 0, CHUNK_BYTES, position)
      if (read <= 0) break
      position += read
      // stream: true 保证被切断的多字节序列会留到下一片（GBK 中文不会被解成乱码）
      const text = carry + decoder.decode(buf.subarray(0, read), { stream: true })
      let start = 0
      for (;;) {
        const nl = text.indexOf('\n', start)
        if (nl < 0) break
        const line = stripCr(text.slice(start, nl))
        if (lineIndex >= from && lineIndex < end) picked.push(line)
        lineIndex += 1
        start = nl + 1
      }
      carry = text.slice(start)
    }
    // 结尾没有换行的最后一行也算一行
    if (carry.length > 0 || size === 0) {
      const last = stripCr(carry)
      if (lineIndex >= from && lineIndex < end) picked.push(last)
      lineIndex += 1
    }
    const totalLines = lineIndex
    const to = Math.min(end, totalLines)

    return {
      text: picked.join('\n'),
      encoding,
      totalLines,
      from,
      to,
      truncated: to < totalLines
    }
  } finally {
    fs.closeSync(fd)
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** 供预览复用：只解码头部若干字节 */
export function decodeHead(head: Buffer): { text: string; encoding: Encoding } {
  const encoding = detectEncoding(head)
  return { text: decode(head, encoding).text, encoding }
}
