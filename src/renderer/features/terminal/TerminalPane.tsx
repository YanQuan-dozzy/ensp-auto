import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { EVENT } from '@shared/channels'
import type { TerminalDataPayload } from '@shared/api'
import { useApp } from '@/stores/app'
import { Empty } from '@/components/ui'
import { readTerminalFont, readXtermTheme } from './xtermTheme'

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
    return <Empty>左侧选择设备后点击「连接」，终端将在此打开</Empty>
  }

  return (
    <div className="stage">
      {queuedNotice ? <div className="banner pending">{queuedNotice}</div> : null}
      <div ref={hostRef} className="terminal-host" />
      <div className="statusbar" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <span>{device?.name ?? activeDeviceId}</span>
        <span className="sep">·</span>
        <span>{device?.model ?? '型号未知'}</span>
        <span className="sep">·</span>
        <span>{device?.encoding === 'gbk' ? 'GBK' : 'UTF-8'}</span>
      </div>
    </div>
  )
}
