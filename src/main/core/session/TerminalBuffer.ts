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

  constructor(private readonly maxBytes: number = DEFAULT_TERMINAL_BUFFER_BYTES) {}

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

  /** 追加一段设备原始输出，返回本次分配的序号 */
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
    const head = this.segments[0]
    if (!head || this.bytes <= this.maxBytes) return
    // 单段自身就超过上限：保留尾部，并对齐到字符边界
    const start = alignToCharBoundary(head.data, head.data.length - this.maxBytes)
    head.data = head.data.slice(start)
    this.bytes = head.data.length
  }
}
