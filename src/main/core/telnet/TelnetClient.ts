import net from 'node:net'
import { randomUUID } from 'node:crypto'
import type { CommandResult, Encoding, PromptInfo } from '@shared/types'
import {
  AUTH_RE,
  CONFIRM_RE,
  DEFAULT_HOST,
  DEFAULT_TELNET_OPTIONS,
  PAGING_ADVANCE,
  PAGING_TAIL_RE,
  type TelnetOptions
} from './patterns'
import { cleanResponse, stripAnsi, stripIac } from './cleaner'
import { decode, detectEncodingDetailed, tailSlice } from './encoding'
import { detectError, hasWarning } from './errors'
import { matchPromptTail, splitTrailingPrompt } from './prompt'

/**
 * TelnetClient —— 只做一件事：发一串字节，收回一段可信的文本。
 *
 * 相对源项目的四处理性改动（见 TELNET-SPEC.md §2）：
 * 1. 提示符状态机替代固定 sleep(1.5)
 * 2. 累积缓冲循环读 + 512KB 上限替代单次 recv(8192)
 * 3. 分页双保险（主动关分页 + 自动续读）
 * 4. 错误结构化，绝不再把设备报错当成功返回
 *
 * 终止判定采用双条件（§4.1）：
 *   强判定 = 缓冲区尾部命中提示符
 *   弱判定 = 静默 quietMs 且缓冲区非空
 * 判定强度通过 CommandResult.settled 透传给代理。
 */

export interface TelnetClientOptions extends Partial<TelnetOptions> {
  encoding?: 'auto' | Encoding
}

export interface ConnectResult {
  banner: string
  prompt: PromptInfo
  encoding: Encoding
  pagingDisabled: boolean
  pagingSupport: boolean
}

interface QueueItem {
  id: string
  kind: 'program' | 'interactive' | 'handshake'
  command: string
  enqueuedAt: number
  timeoutMs: number
  resolve: (r: CommandResult) => void
  reject: (e: Error) => void
  signal?: AbortSignal
}

interface ActiveState {
  item: QueueItem
  startedAt: number
  /** 最近一次收到数据的时刻，用于停顿兜底判定 */
  lastDataAt: number
  quietTimer: NodeJS.Timeout | null
  hardTimer: NodeJS.Timeout | null
  hops: number
  /** 上一次发送分页推进键时的缓冲区长度，用于避免重复推进 */
  advancedAtLen: number
  abortHandler: (() => void) | null
}

interface ResolveOverrides {
  settled?: 'prompt' | 'quiet'
  prompt?: PromptInfo | null
  awaitingConfirm?: boolean
  confirmText?: string
  errorCode?: CommandResult['errorCode']
  error?: string
}

const MAX_QUEUE = 100
const DETECT_WINDOW = 4096

/**
 * 取末尾可见行的内容。
 * 必须先剥掉尾部空白：设备通常在提示行后还带一个换行，
 * 直接 lastIndexOf('\n') 会取到空行，导致确认提示原文丢失。
 */
function lastVisibleLine(text: string): string {
  const trimmed = text.replace(/\s+$/, '')
  const idx = trimmed.lastIndexOf('\n')
  return (idx >= 0 ? trimmed.slice(idx + 1) : trimmed).trim()
}

export class TelnetClient {
  private sock: net.Socket | null = null
  private opts: TelnetOptions
  private encodingPref: 'auto' | Encoding

  private encoding: Encoding = 'utf8'
  private encodingLocked = false
  private hostname: string | null = null

  private queue: QueueItem[] = []
  private active: ActiveState | null = null
  private closed = false
  private closeReason = ''

  // 当前命令的累积缓冲：head 保留前段，tail 滚动保留后段，便于截断时头尾都留
  private head: Buffer[] = []
  private headLen = 0
  private tail: Buffer[] = []
  private tailLen = 0
  private totalLen = 0
  private truncated = false

  // 交互通道按行累积
  private interactiveLine = ''

  private rawSubs = new Set<(chunk: Uint8Array) => void>()
  private closeSubs = new Set<(reason: string) => void>()

  constructor(options: TelnetClientOptions = {}) {
    this.opts = { ...DEFAULT_TELNET_OPTIONS, ...options }
    this.encodingPref = options.encoding ?? 'auto'
  }

  // ———————————————————————————— 对外接口 ————————————————————————————

  get isClosed(): boolean {
    return this.closed
  }

  get queueLength(): number {
    return this.queue.length + (this.active ? 1 : 0)
  }

  onRawData(cb: (chunk: Uint8Array) => void): () => void {
    this.rawSubs.add(cb)
    return () => this.rawSubs.delete(cb)
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closeSubs.add(cb)
    return () => this.closeSubs.delete(cb)
  }

  async connect(port: number): Promise<ConnectResult> {
    if (this.sock) throw new Error('已经连接')

    const sock = net.createConnection({ host: DEFAULT_HOST, port })
    sock.setNoDelay(true)
    this.sock = sock

    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error): void => {
        cleanup()
        reject(e)
      }
      const onConn = (): void => {
        cleanup()
        resolve()
      }
      const cleanup = (): void => {
        sock.off('error', onErr)
        sock.off('connect', onConn)
      }
      sock.once('error', onErr)
      sock.once('connect', onConn)
    })

    sock.on('data', (chunk: Buffer) => this.handleData(chunk))
    sock.on('error', (e: Error) => this.shutdown(`连接错误：${e.message}`))
    sock.on('close', () => this.shutdown('连接已关闭'))

    // 握手：不写入任何内容，只等首个提示符，banner 一并丢弃
    const hs = await this.enqueue({
      kind: 'handshake',
      command: '',
      timeoutMs: this.opts.connectTimeoutMs
    })

    const m = matchPromptTail(stripAnsi(decode(this.combined(), this.encoding).text))
    if (!m) {
      this.close()
      const reason = hs.awaitingConfirm ? '设备要求认证（Username/Password）' : '未能在超时内读到提示符'
      throw new Error(reason)
    }

    // 锁定宿主名用于提示符防误判；编码不在这里锁定 ——
    // 握手阶段通常只有 ASCII，此时锁定会让后续的 GBK 中文描述被误解。
    this.hostname = m.info.host

    let pagingDisabled = false
    if (this.opts.disablePagingOnConnect) {
      try {
        const r = await this.exec('screen-length 0 temporary', { timeoutMs: 5000 })
        pagingDisabled = r.ok && !r.errorCode
      } catch {
        pagingDisabled = false
      }
    }

    return {
      banner: cleanResponse(hs.clean, ''),
      prompt: m.info,
      encoding: this.encoding,
      pagingDisabled,
      // 关分页失败不代表分页不可用，只是需要走自动续读兜底
      pagingSupport: pagingDisabled
    }
  }

  /** 程序通道：给代理 / 工具层用，返回清洗后的结构化结果 */
  exec(command: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
    if (this.closed) {
      return Promise.resolve(this.synthetic('CLOSED', '连接已关闭'))
    }
    if (this.queue.length >= MAX_QUEUE) {
      return Promise.resolve(this.synthetic('UNKNOWN', `命令队列已满（${MAX_QUEUE}），拒绝入队`))
    }
    return this.enqueue({
      kind: 'program',
      command,
      timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs,
      signal: opts.signal
    })
  }

  /**
   * 交互通道：给 xterm 终端用。
   *
   * 行为规则（TELNET-SPEC.md §11）：
   * - 未按回车前：若当前有程序命令在执行，则缓冲不发送（避免代理命令与用户输入串在一行）；
   *   否则立即写 socket，保持正常终端手感。
   * - 按下回车：整行作为一条交互命令入队，与代理命令共用同一条串行队列，不享有插队特权。
   */
  writeInteractive(data: string): { accepted: boolean; queued: boolean } {
    if (this.closed) return { accepted: false, queued: false }

    const hasNewline = /[\r\n]/.test(data)
    const programRunning = this.active?.item.kind === 'program'

    if (!hasNewline) {
      if (programRunning) {
        this.interactiveLine += data
        return { accepted: true, queued: true }
      }
      this.interactiveLine += data
      this.sock?.write(data)
      return { accepted: true, queued: false }
    }

    // 含回车：把该行作为一条交互命令入队
    const line = this.interactiveLine + data.replace(/[\r\n]+$/, '')
    this.interactiveLine = ''
    if (!line.trim()) {
      // 空行：仅回一个回车
      this.sock?.write('\r\n')
      return { accepted: true, queued: false }
    }
    this.enqueue({ kind: 'interactive', command: line, timeoutMs: this.opts.timeoutMs })
    return { accepted: true, queued: programRunning || this.queue.length > 0 }
  }

  close(): void {
    if (this.closed) return
    this.shutdown('主动断开')
  }

  // ———————————————————————————— 队列 ————————————————————————————

  private enqueue(partial: {
    kind: QueueItem['kind']
    command: string
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const item: QueueItem = {
        id: randomUUID(),
        kind: partial.kind,
        command: partial.command,
        enqueuedAt: Date.now(),
        timeoutMs: partial.timeoutMs,
        resolve,
        reject,
        signal: partial.signal
      }
      this.queue.push(item)
      this.pump()
    })
  }

  private pump(): void {
    if (this.closed || this.active || !this.sock) return
    const item = this.queue.shift()
    if (!item) return

    this.resetBuffer()

    const state: ActiveState = {
      item,
      startedAt: Date.now(),
      lastDataAt: Date.now(),
      quietTimer: null,
      hardTimer: null,
      hops: 0,
      advancedAtLen: -1,
      abortHandler: null
    }
    this.active = state

    if (item.signal) {
      const onAbort = (): void => {
        if (this.active === state) {
          this.resolveActive({ errorCode: 'ABORTED', error: '命令被中断' })
        }
      }
      item.signal.addEventListener('abort', onAbort, { once: true })
      state.abortHandler = onAbort
      if (item.signal.aborted) {
        onAbort()
        return
      }
    }

    state.hardTimer = setTimeout(() => {
      if (this.active === state) {
        this.resolveActive({ errorCode: 'TIMEOUT', error: `命令超时（${item.timeoutMs}ms）` })
      }
    }, item.timeoutMs)

    if (item.command) this.writeCommand(item.command)
    // 命令为空（握手）时只等数据
  }

  private writeCommand(command: string): void {
    if (!this.sock) return
    const payload = `${command}\r\n`
    if (this.opts.charDelayMs > 0) {
      let i = 0
      const tick = (): void => {
        if (!this.sock || this.closed || i >= payload.length) return
        this.sock.write(payload[i]!)
        i++
        setTimeout(tick, this.opts.charDelayMs)
      }
      tick()
      return
    }
    this.sock.write(payload)
  }

  // ———————————————————————————— 数据流入 ————————————————————————————

  private handleData(chunk: Buffer): void {
    if (this.closed) return
    const clean = stripIac(chunk)

    // 交互通道始终拿到原始字节（只剥 IAC），保证终端显示与设备一致
    for (const cb of this.rawSubs) cb(new Uint8Array(clean))

    if (!this.active) return

    this.active.lastDataAt = Date.now()
    this.append(clean)

    if (!this.encodingLocked) {
      if (this.encodingPref !== 'auto') {
        this.encoding = this.encodingPref
        this.encodingLocked = true
      } else {
        // 只在出现非 ASCII 证据时才锁定编码。
        // 若在纯 ASCII 的握手阶段就锁定，后面出现的 GBK 中文描述会被按 UTF-8 误解。
        const sample = this.combined().subarray(0, 65536)
        const verdict = detectEncodingDetailed(sample)
        this.encoding = verdict.encoding
        if (verdict.confident) this.encodingLocked = true
      }
    }

    this.armQuietTimer()
    this.evaluate()
  }

  private append(chunk: Buffer): void {
    const halfLimit = Math.floor(this.opts.maxBytes / 2)
    this.totalLen += chunk.length

    if (!this.truncated && this.totalLen > this.opts.maxBytes) {
      this.truncated = true
    }

    if (this.truncated) {
      // 超出上限后：head 停止增长，只维护滚动 tail，保证头尾都留
      this.tail.push(chunk)
      this.tailLen += chunk.length
      const keep = Math.max(halfLimit, DETECT_WINDOW)
      while (this.tailLen - (this.tail[0]?.length ?? 0) > keep && this.tail.length > 1) {
        const dropped = this.tail.shift()!
        this.tailLen -= dropped.length
      }
      return
    }

    if (this.headLen < halfLimit) {
      this.head.push(chunk)
      this.headLen += chunk.length
      return
    }
    this.tail.push(chunk)
    this.tailLen += chunk.length
  }

  private resetBuffer(): void {
    this.head = []
    this.headLen = 0
    this.tail = []
    this.tailLen = 0
    this.totalLen = 0
    this.truncated = false
  }

  private combined(): Buffer {
    return Buffer.concat([...this.head, ...this.tail], this.headLen + this.tailLen)
  }

  private armQuietTimer(): void {
    const state = this.active
    if (!state) return
    if (state.quietTimer) clearTimeout(state.quietTimer)
    state.quietTimer = setTimeout(() => {
      if (this.active !== state) return
      this.onQuiet()
    }, this.opts.quietMs)
  }

  /** 静默兜底：弱判定 */
  private onQuiet(): void {
    const state = this.active
    if (!state) return
    if (this.totalLen === 0) return // 还没收到任何字节，交给硬超时

    this.evaluate()

    // evaluate 若已处理（推进分页 / 命中强判定）则 active 会变化或已结束
    if (this.active !== state) return

    /*
     * 弱判定的触发条件刻意收紧：
     * 必须「已有内容」且「以换行收尾」。
     *
     * 反例是设备回显命令后停顿一下才吐输出 —— 此时缓冲区只有回显行，
     * 没有内容也没有提示符。若仅凭 quietMs 就收尾，会把慢命令判成提前结束，
     * 代理拿到的是残缺回显却以为是完整结果。
     */
    const text = decode(this.combined(), this.encoding).text
    const hasContent = cleanResponse(text, state.item.command).trim().length > 0
    const endsWithNewline = /[\r\n]$/.test(text)
    const stalled = Date.now() - state.lastDataAt >= this.opts.stallMs

    if ((hasContent && endsWithNewline) || stalled) {
      this.resolveActive({ settled: 'quiet' })
      return
    }

    // 还不到收尾时机：重新武装，继续等，由硬超时兜底上限
    this.armQuietTimer()
  }

  // ———————————————————————————— 判定 ————————————————————————————

  private evaluate(): void {
    const state = this.active
    if (!state) return

    const bytes = this.combined()
    const tailText = stripAnsi(decode(tailSlice(bytes, DETECT_WINDOW), this.encoding).text)

    // 1) 分页：缓冲区尾部是分页标记 → 发空格续读（同一处标记只推进一次）
    if (PAGING_TAIL_RE.test(tailText)) {
      if (state.advancedAtLen !== this.totalLen && state.hops < this.opts.maxPagingHops) {
        state.hops++
        state.advancedAtLen = this.totalLen
        this.sock?.write(PAGING_ADVANCE)
        this.armQuietTimer()
      }
      return
    }

    // 2) 交互确认提示：绝不被自动应答，交由上层裁决
    if (CONFIRM_RE.test(tailText)) {
      this.resolveActive({
        awaitingConfirm: true,
        confirmText: lastVisibleLine(tailText),
        settled: 'quiet'
      })
      return
    }

    // 3) 认证提示
    if (AUTH_RE.test(tailText)) {
      this.resolveActive({
        awaitingConfirm: true,
        confirmText: lastVisibleLine(tailText),
        settled: 'quiet'
      })
      return
    }

    // 4) 强判定：尾部命中提示符
    const m = matchPromptTail(tailText, this.hostname ?? undefined)
    if (m) {
      this.resolveActive({ settled: 'prompt', prompt: m.info })
      return
    }

    // 5) 超限
    if (this.truncated) {
      this.resolveActive({ settled: 'quiet' })
    }
  }

  private resolveActive(over: ResolveOverrides): void {
    const state = this.active
    if (!state) return
    this.active = null

    if (state.quietTimer) clearTimeout(state.quietTimer)
    if (state.hardTimer) clearTimeout(state.hardTimer)
    if (state.abortHandler && state.item.signal) {
      state.item.signal.removeEventListener('abort', state.abortHandler)
    }

    const result = this.buildResult(state, over)
    state.item.resolve(result)
    // 让出一次事件循环，避免同步递归过深
    setImmediate(() => this.pump())
  }

  private buildResult(state: ActiveState, over: ResolveOverrides): CommandResult {
    const ms = Date.now() - state.startedAt
    const bytes = this.combined()
    const decoded = decode(bytes, this.encoding)
    const rawText = decoded.text

    const { body, prompt } = splitTrailingPrompt(rawText, this.hostname ?? undefined)
    const clean = cleanResponse(body, state.item.kind === 'handshake' ? '' : state.item.command)

    const errInfo = detectError(clean)
    const finalPrompt = over.prompt ?? prompt

    let errorCode = over.errorCode
    let error = over.error
    let ok = true

    if (errorCode) {
      ok = false
    } else if (errInfo) {
      ok = false
      errorCode = errInfo.code as CommandResult['errorCode']
      error = errInfo.message
    }

    if (this.truncated && ok) {
      // 截断不算失败，但必须让上层知道内容不完整
      errorCode = errorCode ?? 'TRUNCATED'
    }

    return {
      ok,
      clean,
      raw: rawText,
      prompt: finalPrompt?.raw ?? '',
      view: finalPrompt?.view ?? 'other',
      settled: over.settled ?? 'quiet',
      awaitingConfirm: over.awaitingConfirm ?? false,
      ...(over.confirmText ? { confirmText: over.confirmText } : {}),
      ...(error ? { error } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(hasWarning(clean) ? { hasWarning: true } : {}),
      ...(this.truncated ? { truncated: true } : {}),
      ...(decoded.issues ? { decodeIssues: true } : {}),
      ms
    }
  }

  private synthetic(code: CommandResult['errorCode'], message: string): CommandResult {
    return {
      ok: false,
      clean: '',
      raw: '',
      prompt: '',
      view: 'other',
      settled: 'quiet',
      awaitingConfirm: false,
      error: message,
      errorCode: code,
      ms: 0
    }
  }

  // ———————————————————————————— 生命周期 ————————————————————————————

  private shutdown(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason

    const state = this.active
    this.active = null
    if (state) {
      if (state.quietTimer) clearTimeout(state.quietTimer)
      if (state.hardTimer) clearTimeout(state.hardTimer)
      const result = this.buildResult(state, { errorCode: 'CLOSED', error: reason })
      state.item.resolve({ ...result, ok: false })
    }

    // 队列剩余项全部 reject —— 不留悬挂的 Promise
    const pending = this.queue.splice(0, this.queue.length)
    for (const item of pending) {
      item.resolve(this.synthetic('CLOSED', reason))
    }

    try {
      this.sock?.destroy()
    } catch {
      /* 忽略 */
    }
    this.sock = null

    for (const cb of this.closeSubs) cb(reason)
    this.rawSubs.clear()
  }

  get reason(): string {
    return this.closeReason
  }
}
