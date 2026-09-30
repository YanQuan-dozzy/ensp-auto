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

/**
 * D3（PERF-MEM-REVIEW-2026-09-29 §4.2）：行偏移索引的缓存容量。
 *
 * 为什么需要索引：原实现每翻一页都要**从头扫完整份文件**，只为算准 `totalLines`
 * （消费方的 `atEnd` / `truncated` 依赖它）。20MB / 50 万行的配置翻 1250 页就是
 * **25GB 同步读盘**。有了索引之后，翻页成本是 O(本页)，与文件大小无关。
 *
 * 缓存按「路径 → {size:mtime, 行起点数组}」认版本：文件被改过就重扫。
 * 上限 4 份（与 `AttachmentStore.docCache` 同口径）：附件是当次导入的东西，
 * 没有长期驻留价值。
 */
const LINE_INDEX_CACHE_MAX = 4

/**
 * 行偏移索引：`offsets[i]` = 第 i 行的**起始字节偏移**（0-based）。
 *
 * 第 `offsets.length` 行是「末尾没有换行符的最后一行」（若文件不以 \n 结尾）——
 * 所以 `totalLines === offsets.length`。空文件 offsets 为空、totalLines 为 0。
 */
interface LineIndex {
  key: string
  offsets: number[]
}

const lineIndexCache = new Map<string, LineIndex>()

/** D3：测试/诊断用 —— 清空行索引缓存 */
export function clearLineIndexCache(): void {
  lineIndexCache.clear()
}

/** D3：测试/诊断用 —— 命中情况（验证缓存真的生效，不必反复扫盘） */
export function lineIndexCacheSize(): number {
  return lineIndexCache.size
}

/**
 * D3：建行偏移索引 —— **只扫 `\n` 的字节位置，不做任何解码**。
 *
 * 为什么不做解码：这一步的唯一目的是「数行 + 记住每行的起点」，而行边界由
 * `0x0a` 唯一确定（UTF-8 与 GBK 的续接字节都不会是 0x0a）。跳过解码让这一遍
 * 扫描比原来的逐行解码快一个量级，也让索引可以独立于编码被复用。
 *
 * 每行的**文本**仍由 `readLineWindow` 按需解码（那条路径要保证跨片半截汉字正确），
 * 这里只负责「告诉它第 N 行从哪个字节开始、到哪个字节结束」。
 */
function buildLineIndex(file: string, key: string): LineIndex {
  const offsets: number[] = [0]
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0) {
      // 空文件：0 行（与旧实现的 `size === 0` 分支一致）
      offsets.length = 0
      return { key, offsets }
    }
    const buf = Buffer.allocUnsafe(CHUNK_BYTES)
    let position = 0
    let lastByteIsNewline = false
    for (;;) {
      const read = fs.readSync(fd, buf, 0, CHUNK_BYTES, position)
      if (read <= 0) break
      // 逐个定位本片内的所有换行：`indexOf` 的第二个参数是「从 buf 的哪个下标继续找」，
      // 返回的也是 buf 的绝对下标 —— 不要再对 subarray 的结果做相对偏移换算（那会重复累加）。
      let at = buf.indexOf(0x0a, 0)
      while (at >= 0 && at < read) {
        offsets.push(position + at + 1)
        at = buf.indexOf(0x0a, at + 1)
      }
      lastByteIsNewline = buf[read - 1] === 0x0a
      position += read
    }
    // 末尾没有换行的最后一行也算一行：offsets 里已经压了一个「最后一行的起点」，
    // 但那是上一个 \n 之后的起点 —— 只有真的还有内容时才成立。
    if (lastByteIsNewline) {
      // 文件以 \n 结尾：最后压进去的起点是「\n 之后」= 越界位置，没有实际行
      offsets.pop()
    }
    return { key, offsets }
  } finally {
    fs.closeSync(fd)
  }
}

/** D3：取（必要时建）行偏移索引 */
function lineIndexOf(file: string, size: number, mtimeMs: number): LineIndex {
  const key = `${size}:${mtimeMs}`
  const hit = lineIndexCache.get(file)
  if (hit && hit.key === key) {
    // LRU 触达
    lineIndexCache.delete(file)
    lineIndexCache.set(file, hit)
    return hit
  }
  const built = buildLineIndex(file, key)
  lineIndexCache.delete(file)
  lineIndexCache.set(file, built)
  while (lineIndexCache.size > LINE_INDEX_CACHE_MAX) {
    const oldest = lineIndexCache.keys().next().value
    if (oldest === undefined) break
    lineIndexCache.delete(oldest)
  }
  return built
}

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

/**
 * 把累加器收口成窗口结果（to = 实际返回的下一行起点 = nextOffset）。
 *
 * `totalLinesOverride`：D3 的文本流路径已经由行偏移索引拿到**权威**总行数，
 * 而 `acc.totalLines` 此时只累计了「本窗口读到的行」。两者必须分清 ——
 * 传 override 时以它为准（值相同，但语义不同：一个数全部、一个数本页）。
 */
function finishWindow(acc: WindowAcc, from: number, totalLinesOverride?: number): WindowSlice {
  const totalLines = totalLinesOverride ?? acc.totalLines
  const to = from + acc.lines.length
  return {
    text: acc.lines.join('\n'),
    totalLines,
    from,
    to,
    truncated: to < totalLines,
    nextOffset: to,
    atEnd: to >= totalLines,
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
    const st = fs.fstatSync(fd)
    const size = st.size

    // 1) 先看头部：判编码 + 二进制判定（含 NUL 视为二进制）
    const headLen = Math.min(size, DETECT_BYTES)
    const head = Buffer.alloc(headLen)
    if (headLen > 0) fs.readSync(fd, head, 0, headLen, 0)
    if (head.includes(0)) return { error: '二进制文件，无法按文本读取' }
    const encoding = detectEncoding(head)

    /*
     * D3（PERF-MEM-REVIEW-2026-09-29 §4.2）：只读「本页覆盖的那段字节」。
     *
     * 原实现无条件从 0 扫到 EOF（每一步都做解码），只为算准 totalLines ——
     * 20MB / 50 万行的配置翻 1250 页就是 25GB 同步读盘。
     *
     * 现在：行偏移索引给出「第 from 行从哪个字节开始、第 to 行从哪个字节开始」，
     * 我们只 read 这一段。`totalLines` 直接由索引长度得出（精确），
     * 不再需要扫全文件。
     *
     * 取到 `to` 行的起点即可（多读一个字节都不必）—— 若 `to` 越界，
     * 就读到文件末尾；判据由 atEnd/truncated 表达。
     */
    const index = lineIndexOf(file, size, st.mtimeMs)
    const totalLines = index.offsets.length
    if (totalLines === 0) {
      // 空文件：与旧实现一致 —— 0 行、atEnd、to === from
      return {
        ...finishWindow({ lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false }, from),
        encoding
      }
    }

    const startByte = index.offsets[from] ?? size
    // 读到「第 from+take 行的起点 - 1」即可覆盖 take 整行；越界则读到 EOF。
    // 注意行尾的 \n 本身属于本行（stripCr 会去掉 \r），所以末尾要含进这一个字节。
    const endExclusive =
      from + take < totalLines ? Math.min(index.offsets[from + take] ?? size, size) : size
    const spanBytes = Math.max(0, endExclusive - startByte)

    // 单页最多能收的行数有限（每行至少 1 字节 + 换行），但仍按整段读；
    // 上限保护：一页正文的字节上限是 maxBytes，读盘量不必超过它太多 ——
    // 但为了不切断多字节字符与超长行，这里按「本页行数 × 单行上限」估一个安全窗。
    const readCap = Math.min(
      spanBytes,
      Math.max(
        maxBytes * 4,
        // 超长行被截断到 maxLineChars，但源行可能远长于此 —— 给足余量，
        // 遇到超长行时退化为「读到本页末行起点」（endExclusive 已经封顶）
        (take + 1) * (maxLineChars * 4 + 16)
      )
    )
    const wantBytes = Math.min(spanBytes, readCap)
    const buf = Buffer.alloc(wantBytes)
    if (wantBytes > 0) fs.readSync(fd, buf, 0, wantBytes, startByte)

    /*
     * 解码：这一段必须在**字符边界**上切 —— `offsets` 是字节偏移，而 \n 是 ASCII，
     * 所以每个偏移都天然落在字符边界上（不可能切在多字节序列中间）。
     *
     * ⚠️ 但 `readCap` 可能把这个窗口截短（wantBytes < spanBytes），此时末尾可能
     * 落在字符中间。处理方式：只喂 `stream: true` 的解码器、丢弃未完成的尾部
     * （`decode` 的 stream 模式会把它留在内部缓冲里），行边界以 `\n` 为准 ——
     * 与我们收到的字节到哪为止无关。
     */
    const decoder = new TextDecoder(encoding === 'gbk' ? 'gbk' : 'utf-8')
    // 行缓冲设界：整份文件没有换行时（巨型单行），carry 不再无界增长。
    const lineCap = maxLineChars + 1
    /*
     * ⚠️ `totalLines` 从 0 起算（只统计本窗口读到的行），不能预置成索引长度 ——
     * `consumeLine` 会对每一行做 `+= 1`，预置会让 totalLines 翻倍（D3 首版就踩了这个）。
     * 真实总数由索引提供，收口时通过 `finishWindow` 的 override 传入。
     */
    const acc: WindowAcc = { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false }
    let carry = ''

    const appendCarry = (segment: string): void => {
      if (carry.length >= lineCap) return
      carry += segment
      if (carry.length > lineCap) carry = carry.slice(0, lineCap)
    }

    // 逐行归位：只消费本窗口内的前 `take` 行。
    // ⚠️ 这里的行号是**相对窗口起点**（buffer 从第 from 行开始），所以 consumeLine
    // 的区间参数必须是 [0, take)，而不是 [from, from+take) —— 传绝对行号会把本页
    // 第一行当成「第 from 行」而整体跳过（D3 首版踩过：from=1 时永远返回空）。
    const text = decoder.decode(buf.subarray(0, wantBytes), { stream: true })
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      if (nl < 0) break
      appendCarry(text.slice(start, nl))
      consumeLine(acc, stripCr(carry), 0, take, maxLineChars, maxBytes)
      carry = ''
      start = nl + 1
    }
    appendCarry(text.slice(start))

    /*
     * 尾部：本页的最后一行可能没有换行符（它正好是文件末行），此时 carry 里
     * 就是那一行的内容，必须收进去。判据是「本页确实覆盖到文件末尾」——
     * 否则 carry 只是被 readCap 截断的半行，收进去会凭空多一行。
     */
    if (endExclusive >= size && (carry.length > 0 || size === 0)) {
      consumeLine(acc, stripCr(carry), 0, take, maxLineChars, maxBytes)
    }

    return { ...finishWindow(acc, from, totalLines), encoding }
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
