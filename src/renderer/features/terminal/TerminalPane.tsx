import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { EVENT } from '@shared/channels'
import type { TerminalBufferPayload, TerminalClearPayload, TerminalDataPayload } from '@shared/api'
import type { Encoding } from '@shared/types'
import { createStreamDecoder } from '@shared/terminal-decode'
import { useApp } from '@/stores/app'
import { Empty, IconTerminal } from '@/components/ui'
import { readTerminalFont, readXtermTheme } from './xtermTheme'
import { matchesShortcut, terminalPassthroughShortcuts } from '@/features/shortcuts/shortcutsData'

/**
 * xterm 终端。
 *
 * 实现要点：
 * 1. 设备原始字节在**这一层**按设备回显编码解成文本再写进 xterm（2026-09-28 修）。
 *    原因：xterm 的输入解码器只认 UTF-8，而设备切到中文后回显是 GBK ——
 *    把 GBK 字节丢给它只会解出「ǷĵǰԻȷл」这类拉丁/希腊字母乱码，
 *    且与设置里的 utf8/gbk 毫无关系（那条设置过去只管主进程的业务解码）。
 *    载荷自带 `encoding`，解码用 `createStreamDecoder`（有状态，半截汉字跨片不丢）。
 * 2. 代理下发的命令用 --agent 色加 ⟨agent⟩ 前缀标注，与用户手输可区分。
 * 3. **挂载时先拉一次回放快照**（2026-09-25）：设备字节流从连接成功那一刻就开始到达，
 *    而 xterm 是后建的（切设备还会整个重建），不拉快照就只能看到一片空白，
 *    连接握手的 banner / 提示符 / 探针输出全都看不到。
 *    快照与实时事件用 seq 对齐去重（先订阅、后回放，只写 seq 大于快照水位的实时段）。
 * 4. 回显编码变化时**整屏重画**（回放缓冲存的是原始字节，按新编码重解一遍就对）
 *    —— 已经画到屏幕上的乱码没有别的修法，xterm 内部没有「换编码」这种操作。
 * 5. 设备被代理占用时主进程只缓冲不回显，这里负责**本地回显** ——
 *    否则用户敲键盘屏幕上毫无反应，观感就是「终端打不了字」。
 * 6. 按键放行只认终端适用作用域的快捷键：`agent:send` 绑的是裸 Enter，
 *    若一并放行，xterm 就收不到回车，命令永远发不出去。
 */
export function TerminalPane(): React.ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastFromAgent = useRef(false)
  /** 已本地回显、但设备端还没收到的字符数（占用期回显，提交/让位时清掉） */
  const localEchoRef = useRef(0)
  /** 屏幕上的内容是用哪个编码画的（'' = 还没画过）；编码一变就整屏重画 */
  const appliedEncRef = useRef<Encoding | ''>('')
  /** 供「编码变化」effect 触发重画（重画函数活在终端实例的闭包里） */
  const replayRef = useRef<((reset: boolean) => void) | null>(null)

  const activeDeviceId = useApp((s) => s.activeDeviceId)
  const devices = useApp((s) => s.devices)
  const theme = useApp((s) => s.settings.theme)
  const echoAgentCommands = useApp((s) => s.settings.terminalEchoAgentCommands)

  // 用 ref 承接设置：数据订阅 effect 只依赖 activeDeviceId（重建终端代价高），
  // 直接读闭包里的 settings 会拿到旧值，改设置后不生效。
  const echoRef = useRef(echoAgentCommands)
  useEffect(() => {
    echoRef.current = echoAgentCommands
  }, [echoAgentCommands])

  const [queuedNotice, setQueuedNotice] = useState<string | null>(null)

  const device = devices.find((d) => d.id === activeDeviceId)

  // 建立 / 切换终端实例
  useEffect(() => {
    const host = hostRef.current
    if (!host || !activeDeviceId) return

    const font = readTerminalFont()
    const term = new Terminal({
      ...font,
      cursorBlink: true,
      // 设备输出自带换行，不做转换，否则会把回显的行结构改掉
      convertEol: false,
      scrollback: 10000,
      allowProposedApi: true,
      theme: readXtermTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    // 放行全局与应用快捷键（支持用户自定义修改后的按键），防止 xterm 拦截。
    // 必须用 terminalPassthroughShortcuts：它剔除了「输入框」作用域的绑定 ——
    // agent:send 是裸 Enter，一旦放行，回车会被 xterm 丢弃，命令再也发不出去。
    term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
      const st = useApp.getState()
      const eff = terminalPassthroughShortcuts(st.settings.shortcuts)
      for (const [id, keys] of Object.entries(eff)) {
        if (id === 'agent:stop' && !st.agentRunning) continue
        if (matchesShortcut(e, keys)) return false
      }
      return true
    })

    term.open(host)

    termRef.current = term
    fitRef.current = fit
    lastFromAgent.current = false
    localEchoRef.current = 0
    appliedEncRef.current = ''

    /** 设备字节 → 文本的解码器（有状态：半截汉字会等下一片字节） */
    let decoder = createStreamDecoder('utf8')

    const welcome = `\x1b[38;5;245m已连接到 ${activeDeviceId}\x1b[0m`

    const safeFit = (): void => {
      try {
        fit.fit()
        void window.api.terminal.resize(activeDeviceId, term.cols, term.rows)
      } catch {
        /* 容器尚未布局完成时忽略 */
      }
    }
    safeFit()

    /**
     * 把一段设备原始字节写进终端（含代理标注与「显示代理命令」开关）。
     *
     * `encoding` 省略时沿用解码器当前编码（回放同一编码的连续段就走这条）。
     */
    const writeChunk = (bytes: Uint8Array, fromAgent: boolean, encoding?: Encoding): void => {
      // 先喂解码器、再决定写不写：即便这段因为开关被跳过，也不能把字节丢在解码器外 ——
      // 落掉半截多字节序列，后面每一个字符都会错位。
      if (encoding) decoder.setEncoding(encoding)
      const text = decoder.push(bytes)
      if (!text) return
      if (fromAgent && !echoRef.current) return
      if (fromAgent && !lastFromAgent.current) {
        // 代理下发的命令：以代理色标注来源，设备自身的回显紧随其后
        term.write('\r\n\x1b[38;5;183m⟨agent⟩\x1b[0m ')
      }
      lastFromAgent.current = fromAgent
      term.write(text)
    }

    /** latin1 字符串 → 原始字节（一 code unit = 一字节） */
    const latin1ToBytes = (data: string): Uint8Array => {
      const out = new Uint8Array(data.length)
      for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff
      return out
    }

    // —— 数据通道：先订阅（未就绪时暂存），回放快照后再放行 ——
    let disposed = false
    let live = false
    /** 重画代次：并发重画只有最后一次算数，在途的旧重画作废 */
    let replayId = 0
    const pending: TerminalDataPayload[] = []

    /**
     * 用主进程的回放缓冲重建画面（挂载时 + 回显编码变化时）。
     *
     * 之所以能「重画」：缓冲里存的是**原始字节**，按新编码重解一遍就对了；
     * 而屏幕上已经画出来的乱码只能靠重画修掉。
     */
    const replay = async (reset: boolean): Promise<void> => {
      const myId = ++replayId
      live = false
      pending.length = 0

      let snap: TerminalBufferPayload | null = null
      try {
        snap = await window.api.terminal.buffer(activeDeviceId)
      } catch {
        /* 拉快照失败不该把终端卡死：切到实时模式，后续数据照常显示 */
      }
      if (disposed || myId !== replayId) return

      if (reset) {
        term.reset()
        term.writeln(welcome)
        // 画面被清空，本地回显与「上一段是否来自代理」的记号也一并归零，
        // 否则后续第一段代理输出会被少画一个 ⟨agent⟩ 前缀
        localEchoRef.current = 0
        lastFromAgent.current = false
      }
      if (snap) {
        decoder = createStreamDecoder(snap.encoding)
        appliedEncRef.current = snap.encoding
        for (const seg of snap.segments) writeChunk(latin1ToBytes(seg.data), seg.fromAgent)
        live = true
        // 快照期间到达的实时段：只写水位之后的，避免同一段内容被写两遍
        for (const p of pending) {
          if (p.seq > snap.seq) writeChunk(p.chunk, p.fromAgent, p.encoding)
        }
      } else {
        live = true
        for (const p of pending) writeChunk(p.chunk, p.fromAgent, p.encoding)
      }
      pending.length = 0
    }
    replayRef.current = (reset: boolean): void => void replay(reset)

    const offData = window.api.on<TerminalDataPayload>(EVENT.terminalData, (payload) => {
      if (payload.deviceId !== activeDeviceId) return
      if (!live) {
        pending.push(payload)
        return
      }
      if (payload.encoding !== decoder.encoding) {
        // 回显编码变了（自动探测刚锁定 GBK，或用户改了设置）：
        // 旧画面是拿旧编码解出来的，只有整屏重画才能修掉。
        // 先记下新编码，免得紧随其后的状态广播（device.encoding）再触发一次重画。
        appliedEncRef.current = payload.encoding
        void replay(true)
        // replay 已同步把 live 置回 false，这一段会进 pending，由重画后的水位判断写入
        pending.push(payload)
        return
      }
      writeChunk(payload.chunk, payload.fromAgent)
    })

    const offClosed = window.api.on<{ deviceId: string; reason: string }>(
      EVENT.terminalClosed,
      (payload) => {
        if (payload.deviceId !== activeDeviceId || !termRef.current) return
        term.writeln(`\r\n\x1b[38;5;203m连接已断开：${payload.reason}\x1b[0m`)
      }
    )

    // 清屏：主进程已清回放缓冲，画面只能由这里清（xterm 活在渲染层）
    const offClear = window.api.on<TerminalClearPayload>(EVENT.terminalClear, (payload) => {
      if (payload.deviceId !== activeDeviceId) return
      term.write('\x1b[2J\x1b[3J\x1b[H')
      localEchoRef.current = 0
      lastFromAgent.current = false
    })

    // —— 输入通道 ——
    /** 占用期本地回显：设备不会收到这些字符，也就不会回显，只能自己画 */
    const echoLocally = (data: string): void => {
      if (/[\r\n]/.test(data)) {
        // 提交这一行：先清掉本地回显行，交由设备执行时回显真实命令行，避免两行重影
        if (localEchoRef.current > 0) term.write('\x1b[2K\r')
        localEchoRef.current = 0
        return
      }
      if (data === '\x7f' || data === '\b') {
        if (localEchoRef.current > 0) {
          term.write('\b \b')
          localEchoRef.current -= 1
        }
        return
      }
      // 只回显可打印字符；Ctrl+C 之类的控制键不回显
      if (/^[\x20-\x7e]+$/.test(data)) {
        term.write(data)
        localEchoRef.current += data.length
      }
    }

    const disposeData = term.onData((data) => {
      void window.api.terminal
        .write(activeDeviceId, data)
        .then((r) => {
          if (r.queued) {
            echoLocally(data)
            setQueuedNotice(
              /[\r\n]/.test(data)
                ? '命令已入队，将在代理命令之后按顺序执行'
                : '代理执行中：按键已暂存，回车后按顺序执行'
            )
          } else {
            localEchoRef.current = 0
            setQueuedNotice(null)
          }
        })
        .catch(() => setQueuedNotice(null))
    })

    const ro = new ResizeObserver(() => safeFit())
    ro.observe(host)

    term.writeln(welcome)
    void replay(false)

    return () => {
      disposed = true
      // 让在途的重画作废：终端已 dispose，晚到的写入会抛
      replayId++
      replayRef.current = null
      disposeData.dispose()
      offData()
      offClosed()
      offClear()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      setQueuedNotice(null)
    }
  }, [activeDeviceId])

  // 主题联动：xterm 不读 CSS 变量，必须显式同步
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = readXtermTheme()
  }, [theme])

  /**
   * 回显编码变化 → 整屏重画。
   *
   * 两个来源都会走到这里：① 主进程自动探测刚锁定 GBK（此前几段中文是按 UTF-8 解的，
   * 屏幕上是乱码，重画后一并修好）；② 用户在设置里切换编码（主进程已即时应用到会话，
   * 并广播 device.encoding）。
   *
   * 少了这一步，用户改完设置看不到任何变化 —— 只会以为设置项是坏的。
   * 首次（挂载）不同步：那一屏由回放快照负责画，它自带 encoding。
   */
  useEffect(() => {
    const next = device?.encoding
    if (!next || appliedEncRef.current === next) return
    const first = appliedEncRef.current === ''
    appliedEncRef.current = next
    if (first) return
    replayRef.current?.(true)
  }, [device?.encoding])

  if (!activeDeviceId) {
    return (
      <Empty
        icon={<IconTerminal size={26} />}
      >
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>未连接设备终端</span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', maxWidth: 300 }}>
          在左侧设备列表中点击「连接」，或在右侧让 AI 代理自动扫描并连接设备，即可在此打开实时命令行。
        </span>
      </Empty>
    )
  }

  return (
    <div className="stage">
      {queuedNotice ? <div className="banner pending">{queuedNotice}</div> : null}
      <div ref={hostRef} className="terminal-host" />
      <div className="statusbar" style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}>
        <span className="statusbar-badge">{device?.name ?? activeDeviceId}</span>
        <span className="sep">·</span>
        <span>{device?.model ?? '型号未知'}</span>
        <span className="sep">·</span>
        <span>编码：{device?.encoding === 'gbk' ? 'GBK' : 'UTF-8'}</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          支持标准 VRP 命令行 · 滚动缓冲 10000 行
        </span>
      </div>
    </div>
  )
}
