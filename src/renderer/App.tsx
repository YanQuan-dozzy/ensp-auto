import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import { activeProfileOf } from '@shared/profiles'
import { DevicePanel } from '@/features/devices/DevicePanel'
import { TerminalPane } from '@/features/terminal/TerminalPane'
import { AgentPanel } from '@/features/agent/AgentPanel'
import { GateDialog } from '@/features/agent/GateDialog'
import { SettingsDialog } from '@/features/settings/SettingsDialog'
import { TopologyCanvas } from '@/features/topology/TopologyCanvas'
import { SkillsPanel } from '@/features/skills/SkillsPanel'
import { getEffectiveShortcuts, matchesShortcut } from '@/features/shortcuts/shortcutsData'
import {
  IconLogo,
  IconSidebar,
  IconBot,
  IconTerminal,
  IconTopology,
  IconSparkles,
  IconSettings,
  IconSun,
  IconMoon,
  IconPin,
  IconWindowMin,
  IconWindowMax,
  IconWindowRestore,
  IconWindowClose
} from '@/components/ui'

/**
 * 布局保护算法（T5.5 抽到 features/layout/panelSizing）：
 * 常量与纯函数集中在那边，测试直接 import 生产实现，不再抄一份自证。
 */
import {
  computeClampedLeft,
  computeClampedRight,
  computeWindowResizeShrink
} from './features/layout/panelSizing'

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
  const [isMaximized, setIsMaximized] = useState(false)
  const [alwaysOnTop, setAlwaysOnTopState] = useState(false)
  const [leftW, setLeftW] = useState(settings.panels.left)
  const [rightW, setRightW] = useState(settings.panels.right)
  const dragging = useRef<'left' | 'right' | null>(null)

  // 监听窗口最大化状态
  useEffect(() => {
    void window.api.window.isMaximized().then(setIsMaximized)
    const off = window.api.on<{ isMaximized: boolean }>('window:state-changed', (p) => {
      setIsMaximized(p.isMaximized)
    })
    return off
  }, [])

  // 初始化置顶状态（非持久化，随窗口生命周期）
  useEffect(() => {
    void window.api.window.isAlwaysOnTop().then(setAlwaysOnTopState)
  }, [])

  const toggleAlwaysOnTop = (): void => {
    const next = !alwaysOnTop
    // 先切 UI 状态再做 IPC：窗口置顶的 OS 级生效（Windows 上可能耗时数百毫秒），
    // 若等它返回按钮反馈会明显滞后。背后异步应用，生效后用实际值回写对齐状态。
    setAlwaysOnTopState(next)
    void window.api.window.setAlwaysOnTop(next).then(setAlwaysOnTopState)
  }

  useEffect(() => {
    setLeftW(settings.panels.left)
    setRightW(settings.panels.right)
  }, [settings.panels.left, settings.panels.right])

  // v1.8：宽度写 ref（onMove 更新渲染用 state），监听只挂一次 —— 原先每个
  // onMove 都 setLeftW → effect 依赖变化 → 反复 remove/add mousemove，且 mouseup
  // 闭包读到的是滞后一帧的宽度（丢失最后几次拖动）
  const leftWRef = useRef(leftW)
  const rightWRef = useRef(rightW)
  useEffect(() => {
    leftWRef.current = leftW
    rightWRef.current = rightW
  }, [leftW, rightW])

  // 窗口缩放时自适应重配左右面板宽度，防止小窗时挤死中栏
  useEffect(() => {
    const handleResize = (): void => {
      const winW = window.innerWidth
      const cur = useApp.getState().settings.panels
      const leftActive = !cur.leftCollapsed
      const rightActive = !cur.rightCollapsed
      const curLeft = leftActive ? leftWRef.current : 0
      const curRight = rightActive ? rightWRef.current : 0
      // 纯函数：需要收缩时给新宽度，不需要返回 null（T5.5）
      const next = computeWindowResizeShrink({
        winW,
        curLeft,
        curRight,
        leftActive,
        rightActive
      })
      if (!next) return
      if (next.left !== curLeft) {
        leftWRef.current = next.left
        setLeftW(next.left)
      }
      if (next.right !== curRight) {
        rightWRef.current = next.right
        setRightW(next.right)
      }
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      const curSettings = useApp.getState().settings
      const winW = window.innerWidth

      if (dragging.current === 'left') {
        const curRight = curSettings.panels.rightCollapsed ? 0 : rightWRef.current
        const next = computeClampedLeft(e.clientX, winW, curRight)
        leftWRef.current = next
        setLeftW(next)
      } else {
        const curLeft = curSettings.panels.leftCollapsed ? 0 : leftWRef.current
        const next = computeClampedRight(e.clientX, winW, curLeft)
        rightWRef.current = next
        setRightW(next)
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
          ...(which === 'left' ? { left: leftWRef.current } : { right: rightWRef.current })
        }
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [updateSettings])

  const startDrag = useCallback((which: 'left' | 'right') => {
    dragging.current = which
    document.body.style.cursor = 'col-resize'
  }, [])

  const toggleLeftCollapse = useCallback(() => {
    const cur = useApp.getState().settings.panels
    void updateSettings({
      panels: {
        ...cur,
        leftCollapsed: !cur.leftCollapsed
      }
    })
  }, [updateSettings])

  const toggleRightCollapse = useCallback(() => {
    const cur = useApp.getState().settings.panels
    void updateSettings({
      panels: {
        ...cur,
        rightCollapsed: !cur.rightCollapsed
      }
    })
  }, [updateSettings])

  // 快捷键：全局捕获阶段监听（动态响应默认或用户自定义按键映射）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const st = useApp.getState()
      // R24：正在录制快捷键时，全局快捷键一律不响应 ——
      // 本监听在 window 捕获阶段先于面板的录制监听执行，面板里的
      // stopPropagation 拦不住它，只能靠共享标志早退。
      if (st.shortcutRecording) return
      const eff = getEffectiveShortcuts(st.settings.shortcuts)

      // 进入/退出最大化 (F11 或自定义)
      if (matchesShortcut(e, eff['window:maximize'])) {
        e.preventDefault()
        e.stopPropagation()
        void window.api.window.maximize().then(setIsMaximized)
        return
      }

      // 停止生成 / 取消 (Esc 或自定义)
      if (matchesShortcut(e, eff['agent:stop'])) {
        // R23：闸门开着时 Esc 归闸门（= 拒绝本次调用），不能顺手中止整个任务。
        // 本监听在捕获阶段先执行，过去会在这里把事件吞掉，闸门永远收不到 Esc。
        if (st.gate) return
        if (settingsOpen) {
          e.preventDefault()
          e.stopPropagation()
          setSettingsOpen(false)
          return
        }
        if (st.agentRunning) {
          e.preventDefault()
          e.stopPropagation()
          st.abort()
          return
        }
      }

      // 打开/关闭设置
      if (matchesShortcut(e, eff['app:settings'])) {
        e.preventDefault()
        e.stopPropagation()
        setSettingsOpen((prev) => !prev)
        return
      }

      // 切换右侧 AI 面板
      if (matchesShortcut(e, eff['workbench:toggle-right'])) {
        e.preventDefault()
        e.stopPropagation()
        toggleRightCollapse()
        return
      }

      // 切换左侧设备列表
      if (matchesShortcut(e, eff['workbench:toggle-left'])) {
        e.preventDefault()
        e.stopPropagation()
        toggleLeftCollapse()
        return
      }

      // 切换终端
      if (matchesShortcut(e, eff['nav:terminal'])) {
        e.preventDefault()
        e.stopPropagation()
        setTab('terminal')
        return
      }

      // 切换拓扑画布
      if (matchesShortcut(e, eff['nav:topology'])) {
        e.preventDefault()
        e.stopPropagation()
        setTab('topology')
        return
      }

      // 切换技能面板
      if (matchesShortcut(e, eff['nav:skills'])) {
        e.preventDefault()
        e.stopPropagation()
        setTab('skills')
        return
      }

      // 新建对话
      if (matchesShortcut(e, eff['agent:new-session'])) {
        e.preventDefault()
        e.stopPropagation()
        st.newSession()
        return
      }

      // 清空当前终端
      if (matchesShortcut(e, eff['terminal:clear'])) {
        if (st.activeTab === 'terminal' && st.activeDeviceId) {
          e.preventDefault()
          e.stopPropagation()
          void window.api.terminal.clear(st.activeDeviceId)
          return
        }
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setTab, toggleLeftCollapse, toggleRightCollapse, settingsOpen])

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

  const handleMinimize = (): void => void window.api.window.minimize()
  const handleMaximize = (): void => void window.api.window.maximize().then(setIsMaximized)
  const handleClose = (): void => void window.api.window.close()

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbar-brand">
          <button
            className={`btn ghost icon${settings.panels.leftCollapsed ? '' : ' active'}`}
            title={`切换设备列表 (${settings.panels.leftCollapsed ? '展开' : '折叠'}, Ctrl+B)`}
            onClick={toggleLeftCollapse}
          >
            <IconSidebar size={16} />
          </button>
          <div className="topbar-logo">
            <IconLogo size={18} />
          </div>
          <span className="topbar-title">eNSPAuto</span>
          <span className="topbar-sub">eNSP 代理工作台</span>
        </div>

        {/* 顶部中央可拖拽窗口区域，双击最大化/还原 */}
        <div
          className="topbar-drag-spacer"
          onDoubleClick={handleMaximize}
          title="双击最大化/还原窗口，按住拖动窗口"
        />

        <div className="topbar-actions">
          <span className="chip" title="已连接的 eNSP 设备数量">
            <span className={`dot ${connected > 0 ? 'up' : 'down'}`} />
            {connected} 已连接
          </span>
          <button
            className={`btn ghost icon${settings.panels.rightCollapsed ? '' : ' active'}`}
            title={`切换 AI 面板 (${settings.panels.rightCollapsed ? '展开' : '折叠'}, Ctrl+Shift+B)`}
            onClick={toggleRightCollapse}
          >
            <IconBot size={15} />
          </button>
          <button
            className="btn icon"
            title={`切换为${settings.theme === 'dark' ? '浅色' : '深色'}主题`}
            onClick={() => void setTheme(settings.theme === 'dark' ? 'light' : 'dark')}
          >
            {settings.theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
          </button>
          <button
            className={`btn icon${alwaysOnTop ? ' active' : ''}`}
            title={alwaysOnTop ? '取消窗口置顶' : '窗口置顶（始终显示在最前面）'}
            onClick={toggleAlwaysOnTop}
            aria-pressed={alwaysOnTop}
          >
            <IconPin size={15} />
          </button>
          <button className="btn adaptive-btn" onClick={() => setSettingsOpen((prev) => !prev)} title="设置 (Ctrl+,)">
            <IconSettings size={15} />
            <span className="topbar-btn-text">设置</span>
            <span className="kbd-badge">,</span>
          </button>

          <div className="topbar-divider" />

          {/* 自定义窗口控制按钮 */}
          <div className="window-controls">
            <button
              className="window-btn"
              onClick={handleMinimize}
              title="最小化"
              aria-label="最小化窗口"
            >
              <IconWindowMin />
            </button>
            <button
              className="window-btn"
              onClick={handleMaximize}
              title={isMaximized ? '向下还原' : '最大化'}
              aria-label={isMaximized ? '向下还原窗口' : '最大化窗口'}
            >
              {isMaximized ? <IconWindowRestore /> : <IconWindowMax />}
            </button>
            <button
              className="window-btn close"
              onClick={handleClose}
              title="关闭"
              aria-label="关闭窗口"
            >
              <IconWindowClose />
            </button>
          </div>
        </div>
      </div>

      <div className="body">
        {!settings.panels.leftCollapsed && (
          <>
            <div className="panel-side-container" style={{ width: leftW }}>
              <DevicePanel />
            </div>
            <div
              className="splitter"
              title="拖动调整设备栏宽度"
              onMouseDown={() => startDrag('left')}
            />
          </>
        )}

        <div className="col" style={{ flex: 1, minWidth: 0 }}>
          <div className="tabstrip">
            <div className="tab-pill-group">
              <div
                className={`tab${activeTab === 'terminal' ? ' active' : ''}`}
                onClick={() => setTab('terminal')}
                title="设备交互终端 (Ctrl+1)"
              >
                <IconTerminal size={14} />
                终端
              </div>
              <div
                className={`tab${activeTab === 'topology' ? ' active' : ''}`}
                onClick={() => setTab('topology')}
                title="拓扑画布 (Ctrl+2)"
              >
                <IconTopology size={14} />
                拓扑画布
              </div>
              <div
                className={`tab${activeTab === 'skills' ? ' active' : ''}`}
                onClick={() => setTab('skills')}
                title="技能库与提示词管理 (Ctrl+3)"
              >
                <IconSparkles size={14} />
                技能
              </div>
            </div>
            {activeDevice ? (
              <span className="tabstrip-device-badge">
                <span className="chip success" title={`${activeDevice.name} · ${activeDevice.view ?? '未知视图'}`}>
                  <span className="tabstrip-device-name">{activeDevice.name}</span>
                  <span className="tabstrip-device-sep">·</span>
                  <span className="tabstrip-device-view">{activeDevice.view ?? '未知视图'}</span>
                </span>
              </span>
            ) : null}
          </div>

          {activeTab === 'topology' ? <TopologyCanvas /> : null}
          {activeTab === 'skills' ? <SkillsPanel /> : null}
          {/* v1.8：终端保活 —— 切走用 CSS 隐藏而不是卸载，避免 xterm 滚动缓冲（10000 行）
              随切 tab 丢失；xterm 在 display:none 期间仍积累写入，ResizeObserver 在
              显示时重新 fit 尺寸 */}
          <div
            className="col"
            style={{ flex: 1, minWidth: 0, minHeight: 0, display: activeTab === 'terminal' ? 'flex' : 'none' }}
          >
            <TerminalPane />
          </div>
        </div>

        {!settings.panels.rightCollapsed && (
          <>
            <div
              className="splitter"
              title="拖动调整 AI 面板宽度"
              onMouseDown={() => startDrag('right')}
            />
            <div className="panel-side-container" style={{ width: rightW }}>
              <AgentPanel onOpenSettings={() => setSettingsOpen(true)} />
            </div>
          </>
        )}
      </div>

      <div className="statusbar">
        <span className="statusbar-badge">已连接 {connected}</span>
        <span className="sep">·</span>
        <span>设备 {devices.length}</span>
        <span className="sep">·</span>
        <span className="statusbar-badge">
          {activeProfileOf(settings).provider} · {activeProfileOf(settings).model}
        </span>
        <span className="sep">·</span>
        <span>{runtime === 'mock' ? 'mock 运行时' : '真实运行时'}</span>
        {running ? (
          <>
            <span className="sep">·</span>
            <span style={{ color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="dot pending" />
              代理执行中
            </span>
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
