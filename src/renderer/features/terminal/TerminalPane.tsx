import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { EVENT } from '@shared/channels'
import type { TerminalDataPayload } from '@shared/api'
import { useApp } from '@/stores/app'
import { Empty, IconTerminal } from '@/components/ui'
import { readTerminalFont, readXtermTheme } from './xtermTheme'
import { getEffectiveShortcuts, matchesShortcut } from '@/features/shortcuts/shortcutsData'

/**
 * xterm 终端。
 *
 * 三条实现要点：
 * 1. 原始字节直接交给 xterm（Uint8Array），由 xterm 自己解码 ——
 *    我们在主进程做的是「业务用」的解码，终端显示要保持与设备端一致。
 * 2. 代理下发的命令用 --agent 色加 ⟨agent⟩ 前缀标注，与用户手输可区分。
 * 3. 若用户在某条命令执行期间敲命令，该行会入队；此时显示提示条，
 *    而不是让用户以为终端卡死了。
 */
export function TerminalPane(): React.ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastFromAgent = useRef(false)

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

    // 放行全局与应用快捷键（支持用户自定义修改后的按键），防止 xterm 拦截
    term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
      const st = useApp.getState()
      const eff = getEffectiveShortcuts(st.settings.shortcuts)
      for (const [id, keys] of Object.entries(eff)) {
        if (id === 'agent:stop' && !st.agentRunning) continue
        if (matchesShortcut(e, keys)) {
          return false
        }
      }
      return true
    })

    term.open(host)

    termRef.current = term
    fitRef.current = fit
    lastFromAgent.current = false

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

    const disposeData = term.onData((data) => {
      void window.api.terminal
        .write(activeDeviceId, data)
        .then((r) => {
          if (r.queued) {
            setQueuedNotice('命令已入队，等待当前命令执行完成')
          } else {
            setQueuedNotice(null)
          }
        })
        .catch(() => setQueuedNotice(null))
    })

    const offData = window.api.on<TerminalDataPayload>(EVENT.terminalData, (payload) => {
      if (payload.deviceId !== activeDeviceId || !termRef.current) return
      const t = termRef.current
      // 「终端显示代理命令」关闭时，代理下发的命令与其回显都不落地到终端，
      // 用户仍能在右侧 AI 面板的执行轨迹里逐条看到（原始字节不丢，只是不往这里写）。
      if (payload.fromAgent && !echoRef.current) return
      if (payload.fromAgent && !lastFromAgent.current) {
        // 代理下发的命令：以代理色标注来源，设备自身的回显紧随其后
        t.write('\r\n\x1b[38;5;183m⟨agent⟩\x1b[0m ')
      }
      lastFromAgent.current = payload.fromAgent
      t.write(payload.chunk)
    })

    const offClosed = window.api.on<{ deviceId: string; reason: string }>(
      EVENT.terminalClosed,
      (payload) => {
        if (payload.deviceId !== activeDeviceId || !termRef.current) return
        termRef.current.writeln(`\r\n\x1b[38;5;203m连接已断开：${payload.reason}\x1b[0m`)
      }
    )

    const ro = new ResizeObserver(() => safeFit())
    ro.observe(host)

    return () => {
      disposeData.dispose()
      offData()
      offClosed()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [activeDeviceId])

  // 主题联动：xterm 不读 CSS 变量，必须显式同步
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = readXtermTheme()
  }, [theme])

  // 队列提示 4 秒后自动消失
  useEffect(() => {
    if (!queuedNotice) return
    const timer = setTimeout(() => setQueuedNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [queuedNotice])

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
