/**
 * 拓扑画布渲染域（T5.8 从 TopologyCanvas.tsx 外提）：
 * 节点、边、接口标签、角色图标与相关常量。全部是纯 props 组件，
 * 不依赖 FlowInner 闭包 —— 拆分前后行为逐字等价。
 */

import { memo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps
} from '@xyflow/react'
import type { TopologyLink, TopologyNode, TopologyRole } from '@shared/types'
import { shortIf, splitPortLabel } from './portLabel'

export interface TopoNodeData {
  label: string
  role: TopologyRole
  model?: string
  /** 各方向是否有连线在使用（undefined = 全部隐藏，悬停显示） */
  used?: { left: boolean; right: boolean; top: boolean; bottom: boolean }
  editing?: boolean
  commitRename?: (name: string) => void
  cancelRename?: () => void
  [key: string]: unknown
}

export type Side = 'left' | 'right' | 'top' | 'bottom'

export const ROLE_LABEL: Record<TopologyRole, string> = {
  router: '路由器',
  switch: '交换机',
  firewall: '防火墙',
  wlan: '无线局域网',
  server: '服务器',
  cloud: '云 / 其他设备',
  pc: '终端',
  unknown: '未知'
}

export const NODE_COLOR: Record<TopologyRole, string> = {
  router: 'var(--agent)',
  switch: 'var(--info)',
  firewall: 'var(--danger)',
  wlan: 'var(--warning)',
  server: 'var(--server, #2dd4bf)',
  cloud: 'var(--cloud, #818cf8)',
  pc: 'var(--success)',
  unknown: 'var(--text-muted)'
}

/** MiniMap 与 SVG 内部使用具体颜色（CSS 变量在 attribute 上不生效） */
export const NODE_COLOR_HEX: Record<TopologyRole, string> = {
  router: '#cba6f7',
  switch: '#89dceb',
  firewall: '#f38ba8',
  wlan: '#fab387',
  server: '#94e2d5',
  cloud: '#b4befe',
  pc: '#a6e3a1',
  unknown: '#6c7086'
}


/** 无向端点 key（与主进程 linkKey 一致，删除链路用） */
export function linkKeyStr(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** 锁 / 解锁图标（与 React Flow 内置 Controls 图标同型，锁定时描边色走警告色） */
export function LockGlyph(): ReactNode {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 32" aria-hidden="true">
      <path d="M21.333 10.667H19.81V7.619C19.81 3.429 16.38 0 12.19 0 8 0 4.571 3.429 4.571 7.619v3.048H3.048A3.056 3.056 0 000 13.714v15.238A3.056 3.056 0 003.048 32h18.285a3.056 3.056 0 003.048-3.048V13.714a3.056 3.056 0 00-3.048-3.047zM12.19 24.533a3.056 3.056 0 01-3.047-3.047 3.056 3.056 0 013.047-3.048 3.056 3.056 0 013.048 3.048 3.056 3.056 0 01-3.048 3.047zm4.724-13.866H7.467V7.619c0-2.59 2.133-4.724 4.723-4.724 2.591 0 4.724 2.133 4.724 4.724v3.048z" />
    </svg>
  )
}

export function UnlockGlyph(): ReactNode {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 32" aria-hidden="true">
      <path d="M21.333 10.667H19.81V7.619C19.81 3.429 16.38 0 12.19 0c-4.114 1.828-1.37 2.133.305 2.438 1.676.305 4.42 2.59 4.42 5.181v3.048H3.047A3.056 3.056 0 000 13.714v15.238A3.056 3.056 0 003.048 32h18.285a3.056 3.056 0 003.048-3.048V13.714a3.056 3.056 0 00-3.048-3.047zM12.19 24.533a3.056 3.056 0 01-3.047-3.047 3.056 3.056 0 013.047-3.048 3.056 3.056 0 013.048 3.048 3.056 3.056 0 01-3.048 3.047z" />
    </svg>
  )
}

/** 候选人列表的日期显示（本地日期 + 时间） */
export function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-CN')}`
}

export function RoleIcon({ role, color }: { role: TopologyRole; color: string }): ReactNode {
  const s = {
    stroke: color,
    strokeWidth: 1.6,
    fill: 'none',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  switch (role) {
    case 'router':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" {...s} />
          <path d="M7.5 9.5h9m-2.5-2.5 2.5 2.5-2.5 2.5" {...s} />
          <path d="M16.5 14.5h-9m2.5-2.5-2.5 2.5 2.5 2.5" {...s} />
          <path d="M9.5 16.5v-9m-2.5 2.5 2.5-2.5 2.5 2.5" {...s} />
          <path d="M14.5 7.5v9m-2.5-2.5 2.5 2.5 2.5-2.5" {...s} />
        </svg>
      )
    case 'switch':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="6" width="17" height="12" rx="2" {...s} />
          <path d="M6.5 9.5h4.5m-2-2 2 2-2 2" {...s} />
          <path d="M17.5 9.5h-4.5m2-2-2 2 2 2" {...s} />
          <path d="M11 14.5H6.5m2-2-2 2 2 2" {...s} />
          <path d="M13 14.5h4.5m-2-2 2 2-2 2" {...s} />
        </svg>
      )
    case 'firewall':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="4.5" width="17" height="15" rx="1.8" {...s} />
          <path d="M3.5 9.5h17M3.5 14.5h17M8.5 4.5v5M15.5 4.5v5M12 9.5v5M7 14.5v5M17 14.5v5" {...s} />
        </svg>
      )
    case 'wlan':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6.5a13 13 0 0 1 16 0" {...s} />
          <path d="M7 10.5a8.5 8.5 0 0 1 10 0" {...s} />
          <path d="M10 14.5a4 4 0 0 1 4 0" {...s} />
          <circle cx="12" cy="18" r="1.4" fill={color} stroke="none" />
        </svg>
      )
    case 'server':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="4" width="17" height="6.5" rx="1.8" {...s} />
          <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.8" {...s} />
          <circle cx="7" cy="7.25" r="0.9" fill={color} stroke="none" />
          <circle cx="10" cy="7.25" r="0.9" fill={color} stroke="none" />
          <path d="M14.5 7.25h3M14.5 16.75h3" {...s} />
          <circle cx="7" cy="16.75" r="0.9" fill={color} stroke="none" />
          <circle cx="10" cy="16.75" r="0.9" fill={color} stroke="none" />
        </svg>
      )
    case 'cloud':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M6.5 18a4.5 4.5 0 0 1-.5-8.95 6 6 0 0 1 11.5-1.5A4.5 4.5 0 0 1 18 18H6.5z"
            {...s}
          />
          <circle cx="8.5" cy="14" r="0.9" fill={color} stroke="none" />
          <circle cx="12" cy="11.5" r="0.9" fill={color} stroke="none" />
          <circle cx="15.5" cy="14" r="0.9" fill={color} stroke="none" />
          <path d="m8.5 14 3.5-2.5 3.5 2.5" {...s} strokeWidth={1.2} />
        </svg>
      )
    case 'pc':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="4" width="17" height="12" rx="1.8" {...s} />
          <path d="M8.5 19.5h7M12 16v3.5" {...s} />
          <circle cx="12" cy="13.5" r="0.8" fill={color} stroke="none" />
        </svg>
      )
    case 'unknown':
    default:
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" strokeDasharray="3 2" {...s} />
          <path d="M9.8 9.5a2.2 2.2 0 1 1 3.2 2c-.8.5-1.2 1-1.2 1.8" {...s} />
          <circle cx="12" cy="16.5" r="0.9" fill={color} stroke="none" />
        </svg>
      )
  }
}

export function TopoNode(props: NodeProps): ReactNode {
  const data = props.data as TopoNodeData
  const selected = props.selected ?? false
  const color = NODE_COLOR[data.role] ?? 'var(--text-muted)'
  const used = data.used
  const visible = (side: Side): boolean => !used || used[side]
  const handleCls = (side: Side): string => `topo-handle${visible(side) ? '' : ' hidden'}`
  /**
   * v1.8：Escape / Enter 后 input 卸载会先派发 blur → onBlur 又把 draft 提交一遍。
   * 这就是「取消改名，实际上保存了」的根因。用标志挡住卸载引发的这次 blur，
   * 只有「真正失焦」（点了别处）才提交。
   */
  const skipBlur = useRef(false)
  const finishEdit = (name: string): void => {
    skipBlur.current = true
    data.commitRename?.(name)
  }
  const cancelEdit = (): void => {
    skipBlur.current = true
    data.cancelRename?.()
  }
  return (
    <div
      className="topo-node"
      style={{
        borderColor: selected ? 'var(--accent)' : color,
        background: 'linear-gradient(160deg, var(--bg-elevated), var(--bg-surface))'
      }}
    >
      <Handle type="target" position={Position.Left} id="target-left" className={handleCls('left')} />
      <Handle type="source" position={Position.Left} id="source-left" className={handleCls('left')} />
      <Handle type="target" position={Position.Top} id="target-top" className={handleCls('top')} />
      <Handle type="source" position={Position.Top} id="source-top" className={handleCls('top')} />
      <div className="topo-node-icon" style={{ color }}>
        <RoleIcon role={data.role} color={color} />
      </div>
      <div className="topo-node-text">
        {data.editing ? (
          <input
            className="topo-node-edit"
            defaultValue={data.label}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') finishEdit(e.currentTarget.value)
              else if (e.key === 'Escape') cancelEdit()
            }}
            onBlur={(e) => {
              if (skipBlur.current) {
                skipBlur.current = false
                return
              }
              data.commitRename?.(e.currentTarget.value)
            }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <div className="topo-node-name" style={{ color: 'var(--text-primary)' }}>
              {data.label}
            </div>
            <div className="topo-node-sub" style={{ color }}>
              {ROLE_LABEL[data.role] ?? data.role}
              {data.model ? ` · ${data.model}` : ''}
            </div>
          </>
        )}
      </div>
      <Handle type="source" position={Position.Right} id="source-right" className={handleCls('right')} />
      <Handle type="target" position={Position.Right} id="target-right" className={handleCls('right')} />
      <Handle type="source" position={Position.Bottom} id="source-bottom" className={handleCls('bottom')} />
      <Handle type="target" position={Position.Bottom} id="target-bottom" className={handleCls('bottom')} />
    </div>
  )
}

export const TopoNodeMemo = memo(TopoNode)

export const toFlowNodes = (nodes: TopologyNode[]): Node[] =>
  nodes.map((n, i) => ({
    id: n.id,
    position: {
      x: Number.isFinite(n.x) ? (n.x as number) : ((i % 4) * 240 + 40),
      y: Number.isFinite(n.y) ? (n.y as number) : (Math.floor(i / 4) * 130 + 40)
    },
    data: { label: n.name, role: n.role, ...(n.model ? { model: n.model } : {}) },
    type: 'topo'
  }))

/** 依据两节点中心的相对方位判断连线该从哪一侧进出（决定使用上下还是左右连接点） */
export function sideOf(a: { x: number; y: number }, b: { x: number; y: number }): Side {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

export const toFlowEdges = (
  links: TopologyLink[],
  roleOf: Map<string, TopologyRole>,
  pos: Map<string, { x: number; y: number }>
): Edge[] =>
  links
    .filter((l) => roleOf.has(l.from) && roleOf.has(l.to))
    .map((l) => {
      const a = pos.get(l.from)
      const b = pos.get(l.to)
      // 显式指定连接点方向：上下层级链路从底部/顶部接入，左右链路由右侧/左侧接入，
      // 避免全部退化为默认的右->左连接点
      const sourceHandle = a && b ? `source-${sideOf(a, b)}` : 'source-right'
      const targetHandle = a && b ? `target-${sideOf(b, a)}` : 'target-left'
      return {
        id: l.id,
        source: l.from,
        target: l.to,
        sourceHandle,
        targetHandle,
        type: 'topo',
        data: { label: l.label, srcName: l.from, dstName: l.to },
        style: { stroke: NODE_COLOR_HEX[roleOf.get(l.from) ?? 'unknown'], strokeWidth: 1.6 }
      }
    })

/** 连接点所在侧向外的偏移（把接口标注放在设备连接点外侧，不压住设备框） */
export function portOffset(pos: Position): { x: number; y: number } {
  switch (pos) {
    case Position.Top:
      return { x: 0, y: -32 }
    case Position.Bottom:
      return { x: 0, y: 32 }
    case Position.Left:
      return { x: -32, y: 0 }
    default:
      return { x: 32, y: 0 }
  }
}

/** 单个接口标签：默认落在连线一侧，可拖拽移动，悬停展示该连接的双端接口信息（类比 eNSP 的接口标注） */
export const PortLabel = memo(function PortLabel(props: {
  text: string
  tip: string
  x: number
  y: number
  selected?: boolean
}): ReactNode {
  const { text, tip, x, y, selected } = props
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState(false)
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    dragRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    setOffset({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) })
  }
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    dragRef.current = null
    setDragging(false)
  }

  return (
    <div
      className={`topo-link-port nodrag${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      style={{ transform: `translate(-50%, -50%) translate(${x + offset.x}px, ${y + offset.y}px)` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <span>{text}</span>
      {hover && !dragging ? <div className="topo-port-tip">{tip}</div> : null}
    </div>
  )
})

/**
 * 自定义拓扑连线：已使用的接口各自成为独立标签。
 * - 默认贴各自设备连接点外侧，并整体偏向连线一侧（并联多对按序错开），同一链路两端标签互不遮挡；
 * - 标签可自由拖拽，位置随设备移动仍保持相对；悬停展示该连接的双端接口信息；
 * - 无端口信息（如“手动连线”）回退为连线中点居中标示。
 */
export const TopoEdge = memo(function TopoEdge(props: EdgeProps): ReactNode {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
    style,
    data
  } = props
  const [path, midX, midY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  })
  const edgeData = data as { label?: string; srcName?: string; dstName?: string } | undefined
  const label = edgeData?.label
  const srcName = edgeData?.srcName
  const dstName = edgeData?.dstName
  const ports = splitPortLabel(label)

  if (!ports) {
    return (
      <>
        <BaseEdge id={id} path={path} style={style} interactionWidth={18} />
        {label ? (
          <EdgeLabelRenderer>
            <div
              className="topo-link-port center nodrag"
              style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)` }}
            >
              {label}
            </div>
          </EdgeLabelRenderer>
        ) : null}
      </>
    )
  }

  // 连线一侧的单位法向量：竖直连线偏左、水平连线偏下，两端标签放在同一侧、并联多对按序错开
  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const len = Math.hypot(dx, dy) || 1
  const sideSign = dx >= 0 ? 1 : -1
  const px = (-dy / len) * sideSign
  const py = (dx / len) * sideSign
  const src = portOffset(sourcePosition)
  const tgt = portOffset(targetPosition)
  const pairTip = (i: number): string => {
    const a = `${srcName ?? ''} ${ports.from[i] ?? ''}`.trim()
    const b = ports.to[i] ? `${dstName ?? ''} ${ports.to[i]}`.trim() : ''
    return b ? `${a} ↔ ${b}` : a
  }
  return (
    <>
      <BaseEdge id={id} path={path} style={style} interactionWidth={18} />
      <EdgeLabelRenderer>
        {ports.from.map((p, i) => (
          <PortLabel
            key={`${id}:src${i}`}
            text={shortIf(p)}
            tip={pairTip(i)}
            x={sourceX + src.x + px * (16 + 18 * i)}
            y={sourceY + src.y + py * (16 + 18 * i)}
            selected={selected}
          />
        ))}
        {ports.to.map((p, i) => (
          <PortLabel
            key={`${id}:dst${i}`}
            text={shortIf(p)}
            tip={pairTip(i)}
            x={targetX + tgt.x + px * (16 + 18 * i)}
            y={targetY + tgt.y + py * (16 + 18 * i)}
            selected={selected}
          />
        ))}
      </EdgeLabelRenderer>
    </>
  )
})

/** 依据几何方向算节点各方向是否「有连线在使用」 */
export function computeUsedHandles(nodes: Node[], edges: Edge[]): Map<string, NonNullable<TopoNodeData['used']>> {
  const pos = new Map(nodes.map((n) => [n.id, n.position]))
  const init = (): NonNullable<TopoNodeData['used']> => ({ left: false, right: false, top: false, bottom: false })
  const m = new Map<string, NonNullable<TopoNodeData['used']>>()
  for (const e of edges) {
    const a = pos.get(e.source)
    const b = pos.get(e.target)
    if (!a || !b) continue
    const sa = sideOf(a, b)
    const sb = sideOf(b, a)
    m.set(e.source, { ...(m.get(e.source) ?? init()), [sa]: true })
    m.set(e.target, { ...(m.get(e.target) ?? init()), [sb]: true })
  }
  return m
}


export interface MenuState {
  x: number
  y: number
  kind: 'node' | 'edge' | 'pane'
  nodeId?: string
  edgeId?: string
  sub?: 'roles'
}

/** 拓扑操作指南浮窗提示组件（悬停展示完整快捷键与操作说明，节约工具栏空间） */
