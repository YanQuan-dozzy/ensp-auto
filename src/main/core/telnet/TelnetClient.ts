import { randomUUID } from 'node:crypto'
import type { CommandResult, Encoding, PromptInfo } from '@shared/types'
import { type ByteChannel, connectTcp } from '../transport/ByteChannel'
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
  private channel: ByteChannel | null = null
  private opts: TelnetOptions
  private encodingPref: 'auto' | Encoding

  private encoding: Encoding = 'utf8'
  private encodingLocked = false
  private hostname: string | null = null

  private queue: QueueItem[] = []
  private active: ActiveState | null = null
  private closed = false
  private closeReason = ''
  /** 握手唤醒定时器（连接后无数据则补发回车） */
  private nudgeTimer: NodeJS.Timeout | null = null

  // 当前命令的累积缓冲：head 保留前段，tail 滚动保留后段，便于截断时头尾都留
  private head: Buffer[] = []
  private headLen = 0
  private tail: Buffer[] = []
  private tailLen = 0
  private totalLen = 0
  private truncated = false
  /**
   * concat 结果缓存（T4.2）。
   *
   * head/tail 是分片数组，每调一次 combined() 就要 concat 一遍；
   * 而一次 handleData 里 evaluate / armQuietTimer→onQuiet / buildResult 会各调一次，
   * 512KB 回显下就是同一份内容被反复拼 3 遍。缓存由 append/resetBuffer 失效，
   * 保证「一个 chunk 只拼一次」。
   */
  private combinedCache: Buffer | null = null

  // 交互通道按行累积
  private interactiveLine = ''

  /** 中断（Ctrl+C）发出后的排空窗口：此期间 pump 停止推进，避免设备迟到输出污染下一条命令缓冲（D11） */
  private drainingUntil = 0

  private rawSubs = new Set<(chunk: Uint8Array) => void>()
  private closeSubs = new Set<(reason: string) => void>()

  /**
   * 设备停在 [Y/N]（或认证）提示上时挂起队列推进。
   *
   * 为什么需要：resolveActive 结尾会无条件 pump()，于是队列里的下一条命令
   * 会被立刻写进设备 —— 而设备此时把它当成确认应答吃掉（R6）。
   * 挂起后必须由「上层显式应答」来解除：见 exec() / writeInteractive() 的说明。
   */
  private confirmPaused = false
  /** 最近一次命中的确认提示原文（仅在 confirmPaused 期间有效，供应答工具回显） */
  private confirmPromptText = ''

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

  /** 设备是否正停在 [Y/N] / 认证提示上（队列已挂起） */
  get isAwaitingConfirm(): boolean {
    return this.confirmPaused
  }

  /** 挂起中的确认提示原文；无挂起时为空串 */
  get awaitingConfirmText(): string {
    return this.confirmPaused ? this.confirmPromptText : ''
  }

  onRawData(cb: (chunk: Uint8Array) => void): () => void {
    this.rawSubs.add(cb)
    return () => this.rawSubs.delete(cb)
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closeSubs.add(cb)
    return () => this.closeSubs.delete(cb)
  }

  /**
   * telnet 便捷入口：按默认主机（127.0.0.1）建 TCP 管道后走 connectChannel。
   * 保留此签名以兼容既有调用（含 telnet.test.mjs）。
   */
  async connect(port: number): Promise<ConnectResult> {
    const ch = await connectTcp(DEFAULT_HOST, port, this.opts.connectTimeoutMs)
    return this.connectChannel(ch)
  }

  /**
   * 通用入口：接收任何已就绪的字节管道（telnet 或 SSH）完成握手。
   * 握手、关分页、编码锁定等状态机逻辑与此处共用的状态无关，只换字节来源。
   */
  async connectChannel(ch: ByteChannel): Promise<ConnectResult> {
    if (this.channel) {
      ch.destroy()
      throw new Error('已经连接')
    }
    this.channel = ch

    ch.onData((chunk) => this.handleData(Buffer.from(chunk)))
    ch.onError((e) => this.shutdown(`连接错误：${e.message}`))
    ch.onClose(() => this.shutdown('连接已关闭'))

    // 握手唤醒：部分 eNSP 设备连接后不主动推 banner/提示符，必须收到输入才回话。
    // 短窗口（connectNudgeMs，默认 200ms）内握手还没拿到首个提示符就补发一个回车；
    // 正常首发 banner 的设备此时已结束握手，不受影响。
    // 参照参考实现的 connect() 里 send(b'\r\n')。
    this.nudgeTimer = setTimeout(() => {
      const handshakePending = this.active?.item.kind === 'handshake'
      if (!this.closed && handshakePending && this.channel && this.channel.writable) {
        this.channel.write(Buffer.from('\r\n'))
      }
      this.nudgeTimer = null
    }, this.opts.connectNudgeMs)

    // 握手：先静候提示符；唤醒窗口过了仍无声则已由上面的定时器补发回车
    const hs = await this.enqueue({
      kind: 'handshake',
      command: '',
      timeoutMs: this.opts.connectTimeoutMs
    })
    this.clearNudge()

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

  /**
   * 程序通道：给代理 / 工具层用，返回清洗后的结构化结果。
   *
   * 若上一条命令停在 [Y/N] 上（confirmPaused），本次调用即视为「显式应答」：
   * 解除挂起，并把这条命令**插到队首** —— 设备只会把紧接着的输入当成对提示的回答，
   * 若让它排在早先入队的命令后面，被吃掉的就会是那条无辜的命令（R6 的同一个坑）。
   */
  exec(command: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
    if (this.closed) {
      return Promise.resolve(this.synthetic('CLOSED', '连接已关闭'))
    }
    if (this.queue.length >= MAX_QUEUE) {
      return Promise.resolve(this.synthetic('UNKNOWN', `命令队列已满（${MAX_QUEUE}），拒绝入队`))
    }
    const isConfirmAnswer = this.confirmPaused
    this.confirmPaused = false
    return this.enqueue(
      {
        kind: 'program',
        command,
        timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs,
        signal: opts.signal
      },
      isConfirmAnswer
    )
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
      this.channel?.write(Buffer.from(data))
      return { accepted: true, queued: false }
    }

    // 含回车：按行拆开，每行作为一条交互命令入队。
    // 粘贴多行文本时设备本来就是逐行执行，拆开入队可让每一行都走完整判定，
    // 也保证入队项永远不会带内嵌换行（writeCommand 会拒绝这种载荷）。
    const raw = this.interactiveLine + data
    this.interactiveLine = ''
    const lines = raw.split(/[\r\n]+/).filter((l) => l.trim().length > 0)
    if (lines.length === 0) {
      // 空行回车（D12）：
      // ① 程序命令执行中 → 只缓冲不发送（设备此刻的回显边界属于命令，回车会错位）；
      // ② 停在 [Y/N] 上 → 视为显式应答，走队列插队（与 exec() 同路径），不直写 socket ——
      //    否则这个回车会绕过挂起机制，落到设备上又被本地当成「默认应答已解决」，
      //    队列顺序与设备状态从此对不上；
      // ③ 平时 → 直写回车，保持终端手感。
      if (programRunning) {
        return { accepted: true, queued: true }
      }
      if (this.confirmPaused) {
        this.confirmPaused = false
        this.enqueueInteractive([''], true)
        return { accepted: true, queued: true }
      }
      this.channel?.write(Buffer.from('\r\n'))
      return { accepted: true, queued: false }
    }
    // 用户在确认提示上按回车（此时 lines 非空）= 显式应答：解除挂起并插队
    const isConfirmAnswer = this.confirmPaused
    this.confirmPaused = false
    // D13：批量整体入队（首插/追加一次完成），保证粘贴顺序与执行顺序一致
    this.enqueueInteractive(lines, isConfirmAnswer)
    return { accepted: true, queued: programRunning || this.queue.length > 0 }
  }

  close(): void {
    if (this.closed) return
    this.shutdown('主动断开')
  }

  // ———————————————————————————— 队列 ————————————————————————————

  private enqueue(
    partial: {
      kind: QueueItem['kind']
      command: string
      timeoutMs: number
      signal?: AbortSignal
    },
    /** 插队：仅用于「对设备确认提示的显式应答」，见 exec() 的说明 */
    toFront = false
  ): Promise<CommandResult> {
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
      if (toFront && !this.active) this.queue.unshift(item)
      else this.queue.push(item)
      this.pump()
    })
  }

  /**
   * 交互通道多行批量入队（D13）。
   *
   * 旧实现是逐行 enqueue：只有第一行能 unshift 到队首（此时 active 为空），
   * 第二行起 conn 已非空 → push 到队尾 —— 粘贴顺序与执行顺序被反转。
   * 这里一次性构造并整体前插/追加，且**每一行都占 MAX_QUEUE 预算**（与 exec() 同口径，
   * 交互通道不得绕过队列上限——D12 修法 3 要的不变量）。
   * 交互项的结果无人消费（fire-and-forget），但 resolve/reject 必须挂接，
   * 否则 pump→resolveActive 结算时会因 undefined 崩溃。
   * 返回值忽略：交互通道不向调用方回传命令结果。
   */
  private enqueueInteractive(lines: string[], toFront: boolean): void {
    const room = MAX_QUEUE - (this.queue.length + (this.active ? 1 : 0))
    if (lines.length > room) {
      // 超预算：丢弃超出的行（保持信号完整；一行粘贴 201 行的场景现实中不会发生）
      lines = lines.slice(0, room)
      if (lines.length === 0) return
    }
    const items: QueueItem[] = lines.map((command) => {
      let resolve: (r: CommandResult) => void = () => {}
      let reject: (e: Error) => void = () => {}
      new Promise<CommandResult>((res, rej) => {
        resolve = res
        reject = rej
      })
      return {
        id: randomUUID(),
        kind: 'interactive' as const,
        command,
        enqueuedAt: Date.now(),
        timeoutMs: this.opts.timeoutMs,
        resolve,
        reject
      }
    })
    if (toFront && !this.active) this.queue.unshift(...items)
    else this.queue.push(...items)
    this.pump()
  }

  private pump(): void {
    if (this.closed || this.active || !this.channel) return
    if (Date.now() < this.drainingUntil) {
      // D11：刚发过中断，等一个 quiet 窗口让设备的迟到输出先流完，
      // 否则它们会落进下一条命令的缓冲，污染回显边界与提示符判定。
      const wait = Math.min(this.drainingUntil - Date.now(), 250)
      setTimeout(() => this.pump(), wait)
      return
    }
    if (this.confirmPaused) {
      // 设备停在 [Y/N] 上：不推进队列（否则下一条命令会被当成确认应答吃掉），
      // 但要让已中止的排队项及时结算，避免它们永远悬挂。
      this.settleAbortedQueue()
      return
    }
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
      // D11：中止不只是结算本地 Promise —— 设备可能仍在吐字节（长输出被打断）。
      // 尽力向设备发 Ctrl+C（\x03）打断执行，并留一个 quiet 窗口给迟到输出排水，
      // 否则它们会污染下一条命令的缓冲区（旧实现全仓无任何中断序列，R13）。
      const onAbort = (): void => {
        if (this.active === state) {
          this.confirmPaused = false
          try {
            this.channel?.write(Buffer.from('\x03'))
          } catch {
            /* 尽力而为 */
          }
          this.drainingUntil = Date.now() + this.opts.quietMs
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

    // 握手项（command 为空）只等数据，不下发任何字节；
    // 其余项目（含空命令的 [Y/N] 回车应答）一律走 writeCommand ——
    // 空 command 会写出裸 \r\n（≈ 用户在设备提示上按了一次回车，D12）。
    // 只用 kind 分流而不是 `command 非空` 判断：否则「空命令应答」会被跳过永不下发。
    if (item.kind !== 'handshake' && !this.writeCommand(item.command)) {
      this.resolveActive({
        errorCode: 'INVALID_INPUT',
        error:
          '命令包含换行符（\\r / \\n），已拒绝下发：设备会把一行之内的多段内容当成多条命令依次执行'
      })
      return
    }
  }

  /**
   * 下发一条命令行。
   *
   * 返回 false 表示载荷被拒（含 \r / \n）。这是「命令不得跨行」的最后一道防线：
   * 上层（风险判定 / 白名单）已经会拦多行命令，这里兜住任何漏判的调用方。
   */
  private writeCommand(command: string): boolean {
    if (!this.channel) return false
    if (/[\r\n]/.test(command)) return false
    const payload = Buffer.from(`${command}\r\n`)
    if (this.opts.charDelayMs > 0) {
      let i = 0
      const tick = (): void => {
        if (!this.channel || this.closed || i >= payload.length) return
        this.channel.write(payload.subarray(i, i + 1))
        i++
        setTimeout(tick, this.opts.charDelayMs)
      }
      tick()
      return true
    }
    this.channel.write(payload)
    return true
  }

  /** 队列挂起期间，把已被中止（signal.aborted）的排队项结算掉，不留悬挂 Promise */
  private settleAbortedQueue(): void {
    if (!this.queue.length) return
    const kept: QueueItem[] = []
    for (const item of this.queue) {
      if (item.signal?.aborted) {
        item.resolve(this.synthetic('ABORTED', '命令被中断'))
      } else {
        kept.push(item)
      }
    }
    this.queue = kept
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
    this.combinedCache = null

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
    this.combinedCache = null
  }

  private combined(): Buffer {
    if (!this.combinedCache) {
      this.combinedCache = Buffer.concat([...this.head, ...this.tail], this.headLen + this.tailLen)
    }
    return this.combinedCache
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
        this.channel?.write(Buffer.from(PAGING_ADVANCE))
        this.armQuietTimer()
      }
      return
    }

    // 2) 交互确认提示：绝不被自动应答，交由上层裁决；同时挂起队列（R6）
    if (CONFIRM_RE.test(tailText)) {
      this.confirmPaused = true
      this.confirmPromptText = lastVisibleLine(tailText)
      this.resolveActive({
        awaitingConfirm: true,
        confirmText: this.confirmPromptText,
        settled: 'quiet'
      })
      return
    }

    // 3) 认证提示
    if (AUTH_RE.test(tailText)) {
      this.confirmPaused = true
      this.confirmPromptText = lastVisibleLine(tailText)
      this.resolveActive({
        awaitingConfirm: true,
        confirmText: this.confirmPromptText,
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

  private clearNudge(): void {
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer)
      this.nudgeTimer = null
    }
  }

  private shutdown(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    this.confirmPaused = false
    this.confirmPromptText = ''
    this.clearNudge()

    const state = this.active
    this.active = null
    if (state) {
      if (state.quietTimer) clearTimeout(state.quietTimer)
      if (state.hardTimer) clearTimeout(state.hardTimer)
      // T4.2：这里过去漏摘 abort 监听。每次「执行中异常断开」都会在调用方的
      // AbortSignal 上留一个永不释放的监听（长任务里越积越多）。
      if (state.abortHandler && state.item.signal) {
        state.item.signal.removeEventListener('abort', state.abortHandler)
      }
      const result = this.buildResult(state, { errorCode: 'CLOSED', error: reason })
      state.item.resolve({ ...result, ok: false })
    }

    // 队列剩余项全部 reject —— 不留悬挂的 Promise
    const pending = this.queue.splice(0, this.queue.length)
    for (const item of pending) {
      item.resolve(this.synthetic('CLOSED', reason))
    }

    try {
      this.channel?.destroy()
    } catch {
      /* 忽略 */
    }
    this.channel = null

    for (const cb of this.closeSubs) cb(reason)
    this.rawSubs.clear()
  }

  get reason(): string {
    return this.closeReason
  }
}
