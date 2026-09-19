import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import { DevicePanel } from '@/features/devices/DevicePanel'
import { TerminalPane } from '@/features/terminal/TerminalPane'
import { AgentPanel } from '@/features/agent/AgentPanel'
import { GateDialog } from '@/features/agent/GateDialog'
import { SettingsDialog } from '@/features/settings/SettingsDialog'
import { TopologyCanvas } from '@/features/topology/TopologyCanvas'

/**
 * 三栏主布局。
 *
 * 关键取舍：AI 面板常驻而不是抽屉。产品主张是「说目标，不看过程」，
 * 但「要看过程」的能力必须随时在手边 —— 所以它占固定宽度且不可被隐藏，
 * 只能调宽窄。
 */
export function App(): ReactNode {
  const ready = useApp((s) => s.ready)
  const startupError = useApp((s) => s.startupError)
  const retryStartup = useApp((s) => s.retryStartup)
  const settings = useApp((s) => s.settings)
  const devices = useApp((s) => s.devices)
  const activeDeviceId = useApp((s) => s.activeDeviceId)
  const activeTab = useApp((s) => s.activeTab)
  const setTab = useApp((s) => s.setTab)
  const running = useApp((s) => s.agentRunning)
  const runtime = useApp((s) => s.agentRuntime)
  const scanProgress = useApp((s) => s.scanProgress)
  const updateSettings = useApp((s) => s.updateSettings)
  const setTheme = useApp((s) => s.setTheme)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [leftW, setLeftW] = useState(settings.panels.left)
  const [rightW, setRightW] = useState(settings.panels.right)
  const dragging = useRef<'left' | 'right' | null>(null)

  useEffect(() => {
    setLeftW(settings.panels.left)
    setRightW(settings.panels.right)
  }, [settings.panels.left, settings.panels.right])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      if (dragging.current === 'left') {
        setLeftW(Math.max(180, Math.min(420, e.clientX - 8)))
      } else {
        setRightW(Math.max(320, Math.min(640, window.innerWidth - e.clientX - 8)))
      }
    }
    const onUp = (): void => {
      if (!dragging.current) return
      const which = dragging.current
      dragging.current = null
      document.body.style.cursor = ''
      void updateSettings({
        panels: {
          ...useApp.getState().settings.panels,
          ...(which === 'left' ? { left: leftW } : { right: rightW })
        }
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [leftW, rightW, updateSettings])

  const startDrag = useCallback((which: 'left' | 'right') => {
    dragging.current = which
    document.body.style.cursor = 'col-resize'
  }, [])

  // 快捷键：只做最高频的几个，不做全量键位表
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key === '1') {
        e.preventDefault()
        setTab('terminal')
      } else if (e.key === '2') {
        e.preventDefault()
        setTab('topology')
      } else if (e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setTab])

  if (!ready) {
  if (startupError) {
    return (
      <div className="startup-error">
        <div className="startup-error-title">启动失败</div>
        <div className="startup-error-msg">{startupError}</div>
        <div className="startup-error-hint">
          通常是 preload 或持久化文件出问题。可尝试重试；若持续失败，删除应用数据目录
          （userData）后重开。
        </div>
        <button className="btn primary" onClick={retryStartup}>
          重试
        </button>
      </div>
    )
  }
  return <div className="empty">正在启动…</div>
}

  const connected = devices.filter((d) => d.connected).length
  const activeDevice = devices.find((d) => d.id === activeDeviceId)

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar-brand">
          <span className="topbar-title">ensp-auto</span>
          <span className="topbar-sub">eNSP 代理工作台</span>
        </div>
        <div className="topbar-actions">
          <span className="chip">
            <span className="dot up" />
            {connected} 已连接
          </span>
          <button
            className="btn icon"
            title={`切换为${settings.theme === 'dark' ? '浅色' : '深色'}主题`}
            onClick={() => void setTheme(settings.theme === 'dark' ? 'light' : 'dark')}
          >
            {settings.theme === 'dark' ? '浅' : '深'}
          </button>
          <button className="btn" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
        </div>
      </div>

      <div
        className="body"
        style={{
          gridTemplateColumns: `${settings.panels.leftCollapsed ? 0 : leftW}px 4px minmax(0, 1fr) 4px ${settings.panels.rightCollapsed ? 0 : rightW}px`
        }}
      >
        {settings.panels.leftCollapsed ? null : <DevicePanel />}
        <div className="splitter" onMouseDown={() => startDrag('left')} />

        <div className="col">
          <div className="tabstrip">
            <span
              className={`tab${activeTab === 'terminal' ? ' active' : ''}`}
              onClick={() => setTab('terminal')}
            >
              终端
            </span>
            <span
              className={`tab${activeTab === 'topology' ? ' active' : ''}`}
              onClick={() => setTab('topology')}
            >
              拓扑画布
            </span>
            {activeDevice ? (
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="chip">
                  {activeDevice.name} · {activeDevice.view ?? '未知视图'}
                </span>
              </span>
            ) : null}
          </div>

          {activeTab === 'topology' ? <TopologyCanvas /> : <TerminalPane />}
        </div>

        <div className="splitter" onMouseDown={() => startDrag('right')} />
        <AgentPanel />
      </div>

      <div className="statusbar">
        <span>已连接 {connected}</span>
        <span className="sep">·</span>
        <span>设备 {devices.length}</span>
        <span className="sep">·</span>
        <span>{settings.agent.provider} · {settings.agent.model}</span>
        <span className="sep">·</span>
        <span>{runtime === 'mock' ? 'mock 运行时' : '真实运行时'}</span>
        {running ? (
          <>
            <span className="sep">·</span>
            <span style={{ color: 'var(--warning)' }}>代理执行中</span>
          </>
        ) : null}
        {scanProgress && !scanProgress.done ? (
          <>
            <span className="sep">·</span>
            <span>扫描 {scanProgress.scanned}/{scanProgress.total}</span>
          </>
        ) : null}
        <span style={{ marginLeft: 'auto' }}>v0.1.0</span>
      </div>

      <GateDialog />
      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  )
}
