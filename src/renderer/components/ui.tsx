import type { ReactNode } from 'react'

export function Dot({ tone }: { tone: 'up' | 'down' | 'err' | 'pending' }): ReactNode {
  const cls = tone === 'down' ? 'dot' : `dot ${tone}`
  return <span className={cls} aria-hidden="true" />
}

export function Chip({
  children,
  tone,
  title
}: {
  children: ReactNode
  tone?: 'success' | 'warning' | 'danger' | 'agent' | 'plain'
  title?: string
}): ReactNode {
  const cls = tone && tone !== 'plain' ? `chip ${tone}` : 'chip'
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  )
}

export function PanelHeader({
  title,
  actions
}: {
  title: ReactNode
  actions?: ReactNode
}): ReactNode {
  return (
    <div className="panel-header">
      <span className="panel-title">{title}</span>
      {actions ? <span className="panel-actions">{actions}</span> : null}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="empty">{children}</div>
}

const VIEW_LABEL: Record<string, string> = {
  user: '用户视图',
  system: '系统视图',
  interface: '接口视图',
  vlan: 'VLAN 视图',
  ospf: 'OSPF 视图',
  acl: 'ACL 视图',
  other: '未知视图'
}

export function viewLabel(view: string | undefined): string {
  return view ? (VIEW_LABEL[view] ?? '未知视图') : '未知视图'
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 依据设备名生成稳定的两字缩写，用于设备条目左侧的标识 */
export function initials(name: string): string {
  const cleaned = name.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '')
  if (!cleaned) return '?'
  return cleaned.slice(0, 2).toUpperCase()
}
