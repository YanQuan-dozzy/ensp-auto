/**
 * 终端回放缓冲（2026-09-25）。
 *
 * 为什么需要：xterm 实例活在渲染层，而设备字节流从连接成功那一刻就开始到达 ——
 * 切换设备时旧实例被 dispose、新实例挂载前的那段输出（banner、提示符、
 * `screen-length 0 temporary` 的回显、型号探针的输出）**全部丢掉**。
 * 用户看到的就是「连上了，但终端一片空白」，切走再切回来更是干干净净。
 *
 * 这里在主进程按设备留一份最近 N 字节的原始输出，渲染层挂载 xterm 时拉取回放，
 * 之后再接实时事件。段上带 `seq`（单调递增）用于去重：
 * 渲染层先订阅再拉快照，只回放 `seq > snapshot.seq` 的实时事件，
 * 避免「快照期间到达的数据」被写两遍。
 *
 * 字节编码：`data` 用 latin1 字符串承载，**每个 code unit 恰好对应一个原始字节**，
 * 渲染层 `Uint8Array.from(data, (c) => c.charCodeAt(0))` 即可无损还原。
 * 不要在这里做文本解码 —— 解码口径归通信层（cleaner/encoding）管，
 * 且终端要能**按新编码整屏重画**（编码变了就把这些原始字节重解一遍），
 * 所以这里必须留字节而不是留文本。
 *
 * 注意（2026-09-28）：还原出来的字节**不能直接交给 xterm** ——
 * xterm 的输入解码器只认 UTF-8，GBK 中文会被解成拉丁字母乱码。
 * 渲染层要用 `TerminalBufferPayload.encoding` 走 `shared/terminal-decode`
 * （见 TELNET-SPEC §7.1）。
 */

import type { TerminalBufferSegment } from '@shared/types'

export type { TerminalBufferSegment }

/** 每设备保留的字节上限。够回看常见的 `display current-configuration` 量级 */
export const DEFAULT_TERMINAL_BUFFER_BYTES = 256 * 1024

/**
 * M4（PERF-MEM-REVIEW-2026-09-29 §4.1）：**段数**上限。
 *
 * 为什么光有字节上限不够：`append` 每个 TCP chunk 压一条 segment，而 `trim()`
 * 原来只按**字节**裁（256KB）。设备以小包慢速吐数据时（分页续读、逐字符回显、
 * 一个字节一个字节地回 `---- More ----`），**每 chunk 1 字节就能塞满
 * 262144 条 segment 对象** —— 每个对象带 `data`/`fromAgent`/`seq` 三个字段外加
 * 对象头，单设备实际占用 25~50MB，而字节计数才 256KB。
 *
 * 上界取 512：正常交互（一次命令回显）只有几条到几十条，512 足够覆盖整屏回放。
 *
 * ⚠️ **只能靠「丢最旧的整段」来兜底，不能在 append 里合并相邻片** ——
 * 合并会让两条 chunk 复用同一个 `seq`，而渲染层是按 `seq` 水位去重的
 * （见 `append` 的注释），后果是终端随机丢字节。
 */
export const DEFAULT_TERMINAL_MAX_SEGMENTS = 512

/**
 * 把下标向前对齐到 UTF-8 字符边界。
 *
 * 裁剪时若从多字节字符中间切开，xterm 开头几个字符就是乱码（连续字节解不出来）。
 * continuation 字节的高两位是 10，往后跳过它们即可落在下一个字符的起始字节上。
 */
function alignToCharBoundary(data: string, index: number): number {
  let i = Math.max(0, index)
  while (i < data.length && (data.charCodeAt(i) & 0xc0) === 0x80) i++
  return i
}

export class TerminalBuffer {
  private segments: TerminalBufferSegment[] = []
  private bytes = 0
  private seq = 0

  constructor(
    private readonly maxBytes: number = DEFAULT_TERMINAL_BUFFER_BYTES,
    private readonly maxSegments: number = DEFAULT_TERMINAL_MAX_SEGMENTS
  ) {}

  get byteLength(): number {
    return this.bytes
  }

  /** 最近一次分配的序号；缓冲为空时为 0（渲染层把它当作「快照水位」） */
  get lastSeq(): number {
    return this.seq
  }

  get segmentCount(): number {
    return this.segments.length
  }

  /**
   * 追加一段设备原始输出，返回本次分配的序号。
   *
   * ⚠️ **一个 chunk 一条 segment，`seq` 严格是「本次 append 的编号」——
   * 这里绝不能把相邻片合并**：`DeviceSession` 把本方法的返回值直接当作实时事件的
   * `seq` 广播给渲染层（`deps.onRaw(..., seq, ...)`），而渲染层用
   * `p.seq > snap.seq` 决定「快照之后到达的实时片要不要画」。
   * 一旦两条 chunk 复用同一个 `seq`，后到的那条会因为不大于水位而被**静默丢弃**
   * （表现为终端随机丢字节）。段数问题在 `trim()` 里按条数裁，不在这里合并。
   */
  append(chunk: Uint8Array, fromAgent: boolean): number {
    this.seq += 1
    if (!chunk.byteLength) return this.seq
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    this.segments.push({ data: buf.toString('latin1'), fromAgent, seq: this.seq })
    this.bytes += chunk.byteLength
    this.trim()
    return this.seq
  }

  /** 当前保留的全部片段（副本，调用方可自由使用） */
  snapshot(): TerminalBufferSegment[] {
    return this.segments.map((s) => ({ ...s }))
  }

  /** 清空内容。序号**不回退** —— 回退会让渲染层的水位判断误判成「旧数据」 */
  clear(): void {
    this.segments = []
    this.bytes = 0
  }

  private trim(): void {
    // 优先按整段丢弃：段边界天然是合法的字节边界，不会切断字符
    while (this.bytes > this.maxBytes && this.segments.length > 1) {
      const dropped = this.segments.shift()!
      this.bytes -= dropped.data.length
    }
    // M4：段数兜底。字节上限挡不住「每 chunk 1 字节」的形态（256KB / 1B
    // = 26 万个对象），这里再按条数裁一次 —— 同样整段丢，不切字符。
    while (this.segments.length > this.maxSegments) {
      const dropped = this.segments.shift()!
      this.bytes -= dropped.data.length
    }
    const head = this.segments[0]
    if (!head || this.bytes <= this.maxBytes) return
    // 单段自身就超过上限：保留尾部，并对齐到字符边界
    const start = alignToCharBoundary(head.data, head.data.length - this.maxBytes)
    head.data = head.data.slice(start)
    this.bytes = head.data.length
  }
}
