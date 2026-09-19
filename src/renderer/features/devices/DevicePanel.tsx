import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import { Chip, Dot, Empty, PanelHeader } from '@/components/ui'

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
  const disconnect = useApp((s) => s.disconnect)
  const rename = useApp((s) => s.rename)
  const setActive = useApp((s) => s.setActiveDevice)
  const updateSettings = useApp((s) => s.updateSettings)

  const [start, setStart] = useState(String(settings.scanStart))
  const [end, setEnd] = useState(String(settings.scanEnd))
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    setStart(String(settings.scanStart))
    setEnd(String(settings.scanEnd))
  }, [settings.scanStart, settings.scanEnd])

  const doScan = (): void => {
    const s = Number.parseInt(start, 10) || 2000
    const e = Number.parseInt(end, 10) || 2050
    void updateSettings({ scanStart: s, scanEnd: e }).then(() => useApp.getState().scan())
  }

  const commitRename = (deviceId: string): void => {
    const name = draft.trim()
    setEditing(null)
    if (name) void rename(deviceId, name)
  }

  const pct =
    progress && progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0

  return (
    <div className="col">
      <PanelHeader
        title="设备"
        actions={
          <button className="btn" onClick={doScan} disabled={scanning}>
            {scanning && progress ? `已扫 ${progress.scanned}/${progress.total}` : '扫描'}
          </button>
        }
      />

      <div className="scan-bar">
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
        <span className="sep" style={{ marginLeft: 'auto' }}>
          {devices.length > 0 ? `${devices.filter((d) => d.connected).length}/${devices.length} 已连` : ''}
        </span>
      </div>

      {scanning ? (
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}

      {scanError ? <div className="banner danger">{scanError}</div> : null}

      <div className="device-list">
        {devices.length === 0 ? (
          <Empty>
            <span>还没有发现设备</span>
            <span style={{ fontSize: 'var(--text-xs)' }}>
              确认 eNSP 已启动并运行了网络设备，然后点击「扫描」
            </span>
          </Empty>
        ) : (
          devices.map((d) => (
            <div
              key={d.id}
              className={`device-item${activeDeviceId === d.id ? ' active' : ''}`}
              onClick={() => d.connected && setActive(d.id)}
            >
              <Dot tone={d.connected ? 'up' : 'down'} />
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
                        if (e.key === 'Escape') setEditing(null)
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
                </div>
                <div className="device-meta">
                  :{d.port}
                  {d.model ? ` · ${d.model}` : ''}
                </div>
              </div>

              <div className="device-actions">
                {d.connected ? (
                  <>
                    <Chip tone="success">已连接</Chip>
                    <button
                      className="btn ghost"
                      title="断开连接"
                      onClick={(e) => {
                        e.stopPropagation()
                        void disconnect(d.id)
                      }}
                    >
                      断开
                    </button>
                  </>
                ) : (
                  <button
                    className="btn primary"
                    onClick={(e) => {
                      e.stopPropagation()
                      void connect(d.port)
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
    </div>
  )
}
