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

/**
 * 一次「行窗口」的结果（不含编码）。`readLineWindow`（文本流）与 `windowLineArray`
 * （已抽取的文档行）共用同一套口径，避免两条读取路径分叉。
 */
export interface WindowSlice {
  text: string
  totalLines: number
  from: number
  /** 实际返回的下一行起点（区间 [from, to)），等于 nextOffset */
  to: number
  truncated: boolean
  /** 下一页起点（0-based）；未读完时用它续读 */
  nextOffset: number
  /** 是否已到文件末尾 */
  atEnd: boolean
  /** 是否因**输出字节上限**提前停止收行（后续行仍在，用 nextOffset 续读） */
  truncatedByBytes: boolean
}

export interface LineWindow extends WindowSlice {
  encoding: Encoding
}

/** 分片大小：1 MB。太小会显著增加 syscall 次数，太大会放大峰值内存 */
const CHUNK_BYTES = 1 << 20

/** 头部探测窗口：编码判定只看开头这一段（与预览口径一致） */
const DETECT_BYTES = 64 * 1024

/**
 * 单行最多返回的字符数（v2.13，参照 deepseek-harness 的 readMaxLineLength）。
 *
 * 为什么要它：压缩过的 JSON、单行日志、base64 片段动辄几十万字符，一行就能把
 * 上下文与 IPC 一并撑爆。超长行截断后仍保留行号位置信息（行计数不受影响）。
 */
export const READ_MAX_LINE_CHARS = 2000

/**
 * 一次返回所选行的 UTF-8 总字节上限（v2.13）。
 *
 * 为什么取 10 KB 而不是参考实现的 50 KB：工具结果 `JSON.stringify` 后会经
 * `truncateToolResult` 按 `compaction.toolResultMaxChars`（默认 12000 字符，
 * 见 shared/runtime-policy.ts）做「保头 60% + 保尾 40%」拼接。若源头上限更大，
 * 正文必被传输层腰斩成两头拼接；10 KB 能让**整页正文 + 元数据完整落到模型手里**。
 * 用户在设置里调大 toolResultMaxChars 后可同步调大此常量。
 */
export const READ_MAX_OUTPUT_BYTES = 10 * 1024

/** limit 默认值与上限（工具 schema 描述与本文件共用同一份口径） */
export const READ_LIMIT_DEFAULT = 400
export const READ_LIMIT_MAX = 4000

/** 窗口裁剪可注入的阈值（单测用小阈值造边界，缺省走上面的常量） */
export interface LineWindowOptions {
  maxLineChars?: number
  maxBytes?: number
}

/**
 * 请求的 offset 是否已越界（0-based 语义，刻意不改）。
 * 文件 N 行时有效起点 0..N-1；空文件（0 行）只有 offset=0 合法。
 */
export function isOffsetOutOfRange(from: number, totalLines: number): boolean {
  return totalLines === 0 ? from > 0 : from >= totalLines
}

/** 单行超长时的截断后缀（让模型知道这行不是原文，别照抄） */
function truncateLine(line: string, maxLineChars: number): string {
  return line.length > maxLineChars
    ? `${line.slice(0, maxLineChars)}…（本行超长，已截断至 ${maxLineChars} 字符）`
    : line
}

interface WindowAcc {
  lines: string[]
  totalLines: number
  outputBytes: number
  truncatedByBytes: boolean
}

/**
 * 收一行（文本流与文档行数组共用）。
 *
 * 三条口径：
 * 1. `totalLines` 精确 —— 即使因字节上限停止收行也继续往下数；
 * 2. 超长行按 `maxLineChars` 截断，避免单行撑爆上下文；
 * 3. 输出字节超 `maxBytes` 后停止收行并置 `truncatedByBytes`。**当页首行必收**：
 *    否则注入极小 maxBytes 时会出现「一行都收不下 → to === from」的翻页死循环。
 */
function consumeLine(
  acc: WindowAcc,
  rawLine: string,
  from: number,
  take: number,
  maxLineChars: number,
  maxBytes: number
): void {
  acc.totalLines += 1
  if (acc.truncatedByBytes) return
  const index = acc.totalLines - 1
  if (index < from || index >= from + take) return

  const text = truncateLine(rawLine, maxLineChars)
  // 行间分隔符也计入体积（join('\n') 的换行）
  const bytes = Buffer.byteLength(text, 'utf8') + (acc.lines.length > 0 ? 1 : 0)
  if (acc.lines.length > 0 && acc.outputBytes + bytes > maxBytes) {
    acc.truncatedByBytes = true
    return
  }
  acc.outputBytes += bytes
  acc.lines.push(text)
}

/** 把累加器收口成窗口结果（to = 实际返回的下一行起点 = nextOffset） */
function finishWindow(acc: WindowAcc, from: number): WindowSlice {
  const to = from + acc.lines.length
  return {
    text: acc.lines.join('\n'),
    totalLines: acc.totalLines,
    from,
    to,
    truncated: to < acc.totalLines,
    nextOffset: to,
    atEnd: to >= acc.totalLines,
    truncatedByBytes: acc.truncatedByBytes
  }
}

export function readLineWindow(
  file: string,
  from: number,
  take: number,
  opts?: LineWindowOptions
): LineWindow | { error: string } {
  const maxLineChars = opts?.maxLineChars ?? READ_MAX_LINE_CHARS
  const maxBytes = opts?.maxBytes ?? READ_MAX_OUTPUT_BYTES
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
    // 行缓冲设界：整份文件没有换行时（巨型单行），carry 不再无界增长。
    // 超出部分必然要被截断，丢弃无害；行计数只依赖 `\n` 的定位。
    const lineCap = maxLineChars + 1
    let carry = ''
    let position = 0
    const acc: WindowAcc = { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false }

    const appendCarry = (segment: string): void => {
      if (carry.length >= lineCap) return
      carry += segment
      if (carry.length > lineCap) carry = carry.slice(0, lineCap)
    }

    for (;;) {
      const read = fs.readSync(fd, buf, 0, CHUNK_BYTES, position)
      if (read <= 0) break
      position += read
      // stream: true 保证被切断的多字节序列会留到下一片（GBK 中文不会被解成乱码）
      const text = decoder.decode(buf.subarray(0, read), { stream: true })
      let start = 0
      for (;;) {
        const nl = text.indexOf('\n', start)
        if (nl < 0) break
        appendCarry(text.slice(start, nl))
        consumeLine(acc, stripCr(carry), from, take, maxLineChars, maxBytes)
        carry = ''
        start = nl + 1
      }
      appendCarry(text.slice(start))
    }
    // 结尾没有换行的最后一行也算一行
    if (carry.length > 0 || size === 0) {
      consumeLine(acc, stripCr(carry), from, take, maxLineChars, maxBytes)
    }

    return { ...finishWindow(acc, from), encoding }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 已抽取的**文档行数组**（PDF / Office / RTF）走同一套窗口裁剪。
 *
 * 为什么需要：文档分支原先直接 `slice(from, to)`，完全绕过单行/字节上限 ——
 * 一份表格里有个超长单元格就能把结果撑爆。这里复用 `consumeLine` 保证两条
 * 读取路径（文本流 / 文档抽取）口径一致。
 */
export function windowLineArray(
  lines: readonly string[],
  from: number,
  take: number,
  opts?: LineWindowOptions
): WindowSlice {
  const maxLineChars = opts?.maxLineChars ?? READ_MAX_LINE_CHARS
  const maxBytes = opts?.maxBytes ?? READ_MAX_OUTPUT_BYTES
  const acc: WindowAcc = { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false }
  for (const raw of lines) consumeLine(acc, stripCr(raw), from, take, maxLineChars, maxBytes)
  return finishWindow(acc, from)
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** 供预览复用：只解码头部若干字节 */
export function decodeHead(head: Buffer): { text: string; encoding: Encoding } {
  const encoding = detectEncoding(head)
  return { text: decode(head, encoding).text, encoding }
}
