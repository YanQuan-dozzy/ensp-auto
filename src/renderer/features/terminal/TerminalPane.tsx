import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { EVENT } from '@shared/channels'
import type { TerminalClearPayload, TerminalDataPayload } from '@shared/api'
import { useApp } from '@/stores/app'
import { Empty, IconTerminal } from '@/components/ui'
import { readTerminalFont, readXtermTheme } from './xtermTheme'
import { matchesShortcut, terminalPassthroughShortcuts } from '@/features/shortcuts/shortcutsData'

/**
 * xterm 终端。
 *
 * 实现要点：
 * 1. 原始字节直接交给 xterm（Uint8Array），由 xterm 自己解码 ——
 *    我们在主进程做的是「业务用」的解码，终端显示要保持与设备端一致。
 * 2. 代理下发的命令用 --agent 色加 ⟨agent⟩ 前缀标注，与用户手输可区分。
 * 3. **挂载时先拉一次回放快照**（2026-09-25）：设备字节流从连接成功那一刻就开始到达，
 *    而 xterm 是后建的（切设备还会整个重建），不拉快照就只能看到一片空白，
 *    连接握手的 banner / 提示符 / 探针输出全都看不到。
 *    快照与实时事件用 seq 对齐去重（先订阅、后回放，只写 seq 大于快照水位的实时段）。
 * 4. 设备被代理占用时主进程只缓冲不回显，这里负责**本地回显** ——
 *    否则用户敲键盘屏幕上毫无反应，观感就是「终端打不了字」。
 * 5. 按键放行只认终端适用作用域的快捷键：`agent:send` 绑的是裸 Enter，
 *    若一并放行，xterm 就收不到回车，命令永远发不出去。
 */
export function TerminalPane(): React.ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastFromAgent = useRef(false)
  /** 已本地回显、但设备端还没收到的字符数（占用期回显，提交/让位时清掉） */
  const localEchoRef = useRef(0)

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

    const safeFit = (): void => {
      try {
        fit.fit()
        void window.api.terminal.resize(activeDeviceId, term.cols, term.rows)
      } catch {
        /* 容器尚未布局完成时忽略 */
      }
    }
    safeFit()

    term.writeln(`\x1b[38;5;245m已连接到 ${activeDeviceId}\x1b[0m`)

    /** 把一段设备原始字节写进终端（含代理标注与「显示代理命令」开关） */
    const writeChunk = (chunk: Uint8Array, fromAgent: boolean): void => {
      // 「终端显示代理命令」关闭时，代理下发的命令与其回显都不落地到终端，
      // 用户仍能在右侧 AI 面板的执行轨迹里逐条看到（原始字节不丢，只是不往这里写）。
      if (fromAgent && !echoRef.current) return
      if (fromAgent && !lastFromAgent.current) {
        // 代理下发的命令：以代理色标注来源，设备自身的回显紧随其后
        term.write('\r\n\x1b[38;5;183m⟨agent⟩\x1b[0m ')
      }
      lastFromAgent.current = fromAgent
      term.write(chunk)
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
    const pending: TerminalDataPayload[] = []

    const offData = window.api.on<TerminalDataPayload>(EVENT.terminalData, (payload) => {
      if (payload.deviceId !== activeDeviceId) return
      if (!live) {
        pending.push(payload)
        return
      }
      writeChunk(payload.chunk, payload.fromAgent)
    })

    void window.api.terminal
      .buffer(activeDeviceId)
      .then((snap) => {
        if (disposed) return
        for (const seg of snap.segments) writeChunk(latin1ToBytes(seg.data), seg.fromAgent)
        live = true
        // 快照期间到达的实时段：只写水位之后的，避免同一段内容被写两遍
        for (const p of pending) {
          if (p.seq > snap.seq) writeChunk(p.chunk, p.fromAgent)
        }
        pending.length = 0
      })
      .catch(() => {
        if (disposed) return
        // 拉快照失败不该把终端卡死：直接切到实时模式
        live = true
        for (const p of pending) writeChunk(p.chunk, p.fromAgent)
        pending.length = 0
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

    return () => {
      disposed = true
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
