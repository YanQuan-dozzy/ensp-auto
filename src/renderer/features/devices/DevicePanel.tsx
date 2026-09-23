import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import { parseDeviceId } from '@shared/transport'
import {
  Chip,
  Dot,
  Empty,
  PanelHeader,
  IconServer,
  IconTerminal,
  IconSearch,
  IconRefresh,
  IconTrash,
  initials,
  AdaptiveContainer,
  AdaptiveButton
} from '@/components/ui'

/** 右键菜单状态：目标设备 + 菜单锚点（屏幕坐标） */
interface ContextMenuState {
  deviceId: string
  x: number
  y: number
}

/**
 * 左栏设备树。
 *
 * 交互取舍：
 * - 别名用「原地编辑」而不是弹窗，少一层模态打断
 * - 断开不做二次确认（断开比连接安全），但连接失败会以红框 + 原因提示
 * - 端口范围输入直接绑本地 state，扫描时才写回设置，避免每次按键都持久化
 */
export function DevicePanel(): ReactNode {
  const devices = useApp((s) => s.devices)
  const scanning = useApp((s) => s.scanning)
  const progress = useApp((s) => s.scanProgress)
  const scanError = useApp((s) => s.scanError)
  const settings = useApp((s) => s.settings)
  const activeDeviceId = useApp((s) => s.activeDeviceId)
  const connect = useApp((s) => s.connect)
  const connectAll = useApp((s) => s.connectAll)
  const connectAllProgress = useApp((s) => s.connectAllProgress)
  const disconnect = useApp((s) => s.disconnect)
  const forgetDevice = useApp((s) => s.forgetDevice)
  const rename = useApp((s) => s.rename)
  const setActive = useApp((s) => s.setActiveDevice)
  const updateSettings = useApp((s) => s.updateSettings)
  const connectSsh = useApp((s) => s.connectSsh)

  const [start, setStart] = useState(String(settings.scanStart))
  const [end, setEnd] = useState(String(settings.scanEnd))
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<ContextMenuState | null>(null)

  // 右键菜单：点击任意处 / 失焦 / 滚动即关闭
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  useEffect(() => {
    setStart(String(settings.scanStart))
    setEnd(String(settings.scanEnd))
  }, [settings.scanStart, settings.scanEnd])

  const doScan = (): void => {
    const s = Number.parseInt(start, 10) || 2000
    const e = Number.parseInt(end, 10) || 2050
    void updateSettings({ scanStart: s, scanEnd: e }).then(() => useApp.getState().scan())
  }

  // v1.8：Escape 取消重命名时，input 卸载会先派发 blur → onBlur 又把 draft 提交，
  // 造成「取消却保存了」。用标志挡住卸载引发的 blur；只有真正失焦才提交。
  const renameCancelRef = useRef(false)

  const commitRename = (deviceId: string): void => {
    setEditing(null)
    if (renameCancelRef.current) {
      renameCancelRef.current = false
      return
    }
    const name = draft.trim()
    if (name) void rename(deviceId, name)
  }

  const cancelRename = (): void => {
    renameCancelRef.current = true
    setEditing(null)
  }

  const isSsh = (d: { transport?: string }): boolean => d.transport === 'ssh'

  const pct =
    progress && progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0

  const unconnected = devices.filter((d) => !d.connected && !isSsh(d)).length
  const connectingAll = connectAllProgress !== null

  const connectDevice = (d: (typeof devices)[number]): void => {
    if (isSsh(d)) {
      // SSH 设备凭据在「设置 → SSH 连接」里管理，这里只需按 credentialId 重连
      if (d.sshCredentialId) {
        void connectSsh({ credentialId: d.sshCredentialId }).catch((e) =>
          console.error('SSH 重连失败', e)
        )
      }
      return
    }
    void connect(d.port)
  }

  return (
    <div className="col">
      <PanelHeader
        title="设备管理"
        icon={<IconServer size={16} />}
        actionsWrap={false}
        actions={
          <AdaptiveButton
            size="sm"
            variant="primary"
            collapseBelow={250}
            onClick={doScan}
            disabled={scanning}
            icon={scanning ? <IconRefresh size={12} className="dot pending" /> : <IconSearch size={12} />}
            label={scanning && progress ? `已扫 ${progress.scanned}/${progress.total}` : '扫描设备'}
            tooltip="扫描局域网/本机 eNSP 虚拟设备"
          />
        }
      />

      <AdaptiveContainer className="scan-bar">
        {({ width }) => {
          const showPortLabel = width >= 250
          const hasDevices = devices.length > 0
          return (
            <>
              {showPortLabel && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>
                  端口:
                </span>
              )}
              <div className="scan-range-box" title="eNSP Telnet 端口监听范围">
                <input
                  aria-label="起始端口"
                  value={start}
                  onChange={(e) => setStart(e.target.value.replace(/\D/g, '').slice(0, 5))}
                  onKeyDown={(e) => e.key === 'Enter' && doScan()}
                />
                <span className="sep">–</span>
                <input
                  aria-label="结束端口"
                  value={end}
                  onChange={(e) => setEnd(e.target.value.replace(/\D/g, '').slice(0, 5))}
                  onKeyDown={(e) => e.key === 'Enter' && doScan()}
                />
              </div>
              {hasDevices ? (
                <span
                  className="sep scan-status-text"
                  style={{
                    marginLeft: 'auto',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--text-muted)',
                    whiteSpace: 'nowrap',
                    flexShrink: 0
                  }}
                >
                  {connectingAll
                    ? `${connectAllProgress.ok}/${connectAllProgress.total}`
                    : width >= 250
                      ? `${devices.filter((d) => d.connected).length}/${devices.length} 已连`
                      : `${devices.filter((d) => d.connected).length}/${devices.length}`}
                </span>
              ) : (
                <div style={{ flex: 1, minWidth: 4 }} />
              )}
              <AdaptiveButton
                size="sm"
                collapseBelow={210}
                icon={connectingAll ? <IconRefresh size={12} className="dot pending" /> : <IconTerminal size={12} />}
                label={connectingAll ? `${connectAllProgress.ok}/${connectAllProgress.total}` : '一键连接'}
                onClick={() => void connectAll()}
                disabled={connectingAll || unconnected === 0}
                tooltip={unconnected === 0 ? '没有需要连接的设备，先扫描发现设备' : '一键连接所有已发现但未连接的设备'}
              />
            </>
          )
        }}
      </AdaptiveContainer>

      {scanning ? (
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}

      {scanError ? <div className="banner danger">{scanError}</div> : null}

      <div className="device-list">
        {devices.length === 0 ? (
          <Empty
            icon={<IconServer size={24} />}
            action={
              <button className="btn primary sm" onClick={doScan} disabled={scanning}>
                <IconSearch size={13} />
                扫描设备 ({start} - {end})
              </button>
            }
          >
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>还没有发现设备</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              确认 eNSP 已启动并运行了网络设备拓扑，然后点击扫描
            </span>
          </Empty>
        ) : (
          devices.map((d) => (
            <div
              key={d.id}
              className={`device-item${activeDeviceId === d.id ? ' active' : ''}`}
              onClick={() => d.connected && setActive(d.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ deviceId: d.id, x: e.clientX, y: e.clientY })
              }}
            >
              <div className="device-avatar" title={d.model ?? d.name}>
                {initials(d.name)}
              </div>
              <div className="device-main">
                <div className="device-name">
                  {editing === d.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(d.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(d.id)
                        if (e.key === 'Escape') cancelRename()
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      title="双击重命名"
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        setEditing(d.id)
                        setDraft(d.name)
                      }}
                    >
                      {d.name}
                    </span>
                  )}
                  <Dot tone={d.connected ? 'up' : 'down'} />
                </div>
                <div className="device-meta">
                  {isSsh(d) ? (
                    <>
                      <span
                        style={{
                          fontSize: 10,
                          padding: '1px 6px',
                          borderRadius: 99,
                          background: 'var(--agent-subtle)',
                          color: 'var(--agent)'
                        }}
                      >
                        ssh
                      </span>{' '}
                      {parseDeviceId(d.id)?.host ?? ''}:{d.port}
                    </>
                  ) : (
                    <>:{d.port}</>
                  )}
                  {d.model ? ` · ${d.model}` : ''}
                </div>
              </div>

              <div className="device-actions">
                {d.connected ? (
                  <>
                    <Chip tone="success">已连接</Chip>
                    <button
                      className="btn ghost sm"
                      title="断开连接"
                      onClick={(e) => {
                        e.stopPropagation()
                        void disconnect(d.id)
                      }}
                    >
                      断开
                    </button>
                  </>
                ) : isSsh(d) && !d.sshCredentialId ? (
                  <button className="btn sm" disabled title="未保存连接凭据，请到 设置 → SSH 连接 中添加后再连">
                    连接
                  </button>
                ) : (
                  <button
                    className="btn primary sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      connectDevice(d)
                    }}
                  >
                    连接
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {menu ? (
        <div className="device-context-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            onClick={() => {
              const id = menu.deviceId
              setMenu(null)
              void forgetDevice(id)
            }}
            title="断开连接并从列表中移除"
          >
            <IconTrash size={13} />
            删除设备
          </button>
        </div>
      ) : null}
    </div>
  )
}
