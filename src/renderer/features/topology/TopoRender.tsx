/**
 * 拓扑画布渲染域（T5.8 从 TopologyCanvas.tsx 外提）：
 * 节点、边、接口标签、角色图标与相关常量。全部是纯 props 组件，
 * 不依赖 FlowInner 闭包 —— 拆分前后行为逐字等价。
 */

import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  Position,
  ViewportPortal,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps
} from '@xyflow/react'
import type {
  TopologyLink,
  TopologyLinkOffsets,
  TopologyNode,
  TopologyPortOffset,
  TopologyRole
} from '@shared/types'
import { shortIf, splitPortLabel } from './portLabel'
import {
  handlePlacementOf,
  sideOf,
  slotAxisOf,
  SLOT_GAP_X,
  SLOT_GAP_Y,
  type LinkPortMaps,
  type NodePortHandle,
  type PortSlotInfo,
  type PortSlotTable,
  type Side,
  type SlotAxis
} from './portSlots'

/**
 * 兼容再出口：槽位几何已搬到 portSlots.ts（纯几何，不依赖 React），
 * 但既有导入点（harness / TopologyCanvas / 单测）继续从本模块取这些名字。
 */
export {
  assignPortSlots,
  chipWidthOf,
  sideOf,
  sideToPosition,
  slotAxisOf,
  SLOT_GAP_X,
  SLOT_GAP_Y
} from './portSlots'
export type { PortSlotInfo, PortSlotTable, Side, SlotAxis } from './portSlots'
export type { NodePortHandle, LinkPortMaps } from './portSlots'
import { routeToPath, snapRouteToHandles, type LinkRoute } from './topoRouting'
import type { TopologyBlock } from './autoLayout'
import { alignNodeSizes, centerToTopLeft } from './layoutGrid'
import type { PortOffsetSide } from '@shared/topology-ports'
import { isDashedLineType, linkIdentity, linkPairKey } from '@shared/topology-link'

export interface TopoNodeData {
  label: string
  role: TopologyRole
  model?: string
  /** 各方向是否有连线在使用（undefined = 全部隐藏，悬停显示） */
  used?: { left: boolean; right: boolean; top: boolean; bottom: boolean }
  /** 每条链路独立的端口点（B4 第五批「像 eNSP 一样」；由 assignLinkPorts 产出） */
  ports?: NodePortHandle[]
  editing?: boolean
  /** F11：正在回放的步骤对应的设备（描边发光强调） */
  highlight?: boolean
  /** B4：悬停聚焦时不在焦点内的设备（淡化，让焦点自己浮出来） */
  dimmed?: boolean
  /**
   * 设备框尺寸（**偶数口径**，与布局/走线同源）。渲染时**硬钉**成这个尺寸，
   * 让 DOM 实测尺寸 == 布局估算尺寸 —— 否则实测与估算的差值会让「布局坐标（中心）
   * − 半框」算出的左上角仍与 DOM 框中心错开，网格十字就压不中设备中心。
   * 见 `layoutGrid.ts` 头注释的三条不变式。
   */
  size?: { w: number; h: number }
  commitRename?: (name: string) => void
  cancelRename?: () => void
  [key: string]: unknown
}


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

/**
 * 拓扑连线（及 MiniMap 节点）的角色色：**必须走主题变量**，不能写死 RGB。
 *
 * 原先是写死的 Catppuccin 亮色（`#89dceb` 之类）—— 那是给深色底调的。切到浅色主题后，
 * 1.6px 的浅色线压在 `#f6f8fa` 画布上对比度不足 1.5:1，放大后整个拓扑的连线几乎看不见
 * （节点边框走 `var(--info)` 反而清清楚楚，于是「只看得见设备、看不见拓扑」）。
 * 深浅两套值都定义在 theme.css 的 `--topo-line-*`，切主题自动跟随，无需 JS 重算。
 *
 * 有效性依据：React Flow 把 `edge.style` 原样透传给 `BaseEdge` 的 `<path>`，
 * MiniMap 也把 nodeColor 作为**内联 CSS**（`style={{ fill }}`）下发 —— 内联样式里
 * `var()` 是生效的，与「SVG 属性不支持 var()」不冲突。
 */
export const NODE_LINE_COLOR: Record<TopologyRole, string> = {
  router: 'var(--topo-line-router)',
  switch: 'var(--topo-line-switch)',
  firewall: 'var(--topo-line-firewall)',
  wlan: 'var(--topo-line-wlan)',
  server: 'var(--topo-line-server)',
  cloud: 'var(--topo-line-cloud)',
  pc: 'var(--topo-line-pc)',
  unknown: 'var(--topo-line-unknown)'
}


/**
 * 无向**设备对** key（与主进程 linkKey、@shared/topology-link 同源）。
 * 注意它标识的是「两台设备之间」，不是「一条线」—— 删除单条线要用 `linkIdentity`。
 */
export function linkKeyStr(a: string, b: string): string {
  return linkPairKey(a, b)
}

/** 链路标识（设备对 + 线标识）：删除单条线、标注偏移落库都用它 */
export { linkIdentity }

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
      className={`topo-node${data.highlight ? ' highlight' : ''}${data.dimmed ? ' dimmed' : ''}`}
      style={{
        borderColor: data.highlight ? 'var(--accent-hover)' : selected ? 'var(--accent)' : color,
        // 硬钉尺寸：DOM 实测必须等于布局估算，中心才会正好落在网格十字上（见 data.size 注释）
        ...(data.size ? { width: data.size.w, height: data.size.h } : {}),
        ...(data.highlight
          ? {}
          : { background: 'linear-gradient(160deg, var(--bg-elevated), var(--bg-surface))' })
      }}
    >
      <Handle type="target" position={Position.Left} id="target-left" className={handleCls('left')} />
      <Handle type="source" position={Position.Left} id="source-left" className={handleCls('left')} />
      <Handle type="target" position={Position.Top} id="target-top" className={handleCls('top')} />
      <Handle type="source" position={Position.Top} id="source-top" className={handleCls('top')} />
      {/* 每条链路自己的端口点（8 方向，eNSP 式）：位置由 pct / 角点钉在边框上 */}
      {(data.ports ?? []).map((port) => {
        const placement = handlePlacementOf(port.side, port.pct)
        return (
          <Handle
            key={`${port.kind}-${port.linkId}`}
            type={port.kind}
            position={placement.position}
            id={`p-${port.linkId}-${port.kind === 'source' ? 'src' : 'dst'}`}
            className={`topo-port${data.dimmed ? ' dimmed' : ''}`}
            style={placement.style}
            isConnectable={!data.dimmed}
          />
        )
      })}
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

/**
 * store 节点 → React Flow 节点。
 *
 * ⚠️ **坐标口径（2026-09-29）**：store 里的 `x/y` 是**设备框中心**（布局内核的输出，
 * 用户拖动写回的也是它），而 React Flow 的 `node.position` 是**左上角** —— 必须在这里
 * 减半个框。这样背景方格的十字交点才会正好压在设备正中心（用户要的「网格十字中心」）。
 *
 * `alignNodeSizes` 与布局/走线同源（偶数尺寸），所以减完仍是格点倍数，
 * 「对齐到网格」按钮不会把网格推歪半个格。
 */
export const toFlowNodes = (
  nodes: TopologyNode[],
  /** F11：回放当前步骤操作的设备 id；不传 = 与旧行为一致（无高亮） */
  highlightDeviceId?: string | null
): Node[] => {
  const sizes = alignNodeSizes(nodes)
  return nodes.map((n, i) => {
    const size = sizes.get(n.id) ?? { w: 130, h: 52 }
    // 无坐标的兜底仍是「左上角」口径（本来就是临时摆位，不走中心换算）
    const raw = {
      x: Number.isFinite(n.x) ? (n.x as number) : (i % 4) * 240 + 40,
      y: Number.isFinite(n.y) ? (n.y as number) : Math.floor(i / 4) * 130 + 40
    }
    const pos = Number.isFinite(n.x) && Number.isFinite(n.y) ? centerToTopLeft(raw, size) : raw
    return {
      id: n.id,
      position: pos,
      data: {
        label: n.name,
        role: n.role,
        // 硬钉尺寸来源：与 pos 的换算用的是**同一个** size，二者必须同源，
        // 否则「按估算尺寸减半框」得到的位置与「按另一尺寸渲染」的框中心错开。
        size,
        ...(n.model ? { model: n.model } : {}),
        ...(highlightDeviceId &&
        (n.deviceId === highlightDeviceId ||
          n.id === highlightDeviceId ||
          n.name.toLowerCase() === highlightDeviceId.toLowerCase())
          ? { highlight: true }
          : {})
      },
      type: 'topo'
    }
  })
}

/** 拓扑连线携带的展示数据（含 B4 的槽位/偏移/分级显示标记） */
export interface TopoEdgeData {
  label?: string
  srcName?: string
  dstName?: string
  /**
   * 链路标识（设备对 + 线标识）—— 删除单条线时要精确到「条」，不能退回设备对
   * （设备对上可能并接多条，退回设备对会把同对的其它线一起删掉）。
   */
  identity?: string
  /** eNSP 链路类型（Copper/Serial/…）：串口族走虚线 */
  lineType?: string
  /** 两端接口标注的槽位（assignPortSlots 产出；缺省 = 各自单槽） */
  slots?: PortSlotTable
  /** 走线内核算出的折线（缺省 = 退回 getSmoothStepPath 的旧口径） */
  route?: LinkRoute
  /** 已持久化的手调偏移 */
  offsets?: TopologyLinkOffsets
  /** 缩放过小 → 标注收成小点（悬停/选中仍展开） */
  dense?: boolean
  /** 悬停聚焦时被淡化的链路 */
  dim?: boolean
  /** 本链路处于聚焦状态（点亮、标注展开） */
  emphasized?: boolean
  /** 标注拖拽结束的落库回调（FlowInner 注入；走 data 以免为 edgeTypes 另开参数通道） */
  onLabelCommit?: (linkId: string, side: PortOffsetSide, index: number, offset: TopologyPortOffset) => void
}

export interface ToFlowEdgesOptions {
  /** 接口标注槽位（assignPortSlots 产出；不传 = 每条链路各自单槽） */
  slots?: Map<string, PortSlotTable>
  /** 每链路端口点（assignLinkPorts 产出；有则连线接各自端口，无则退回共用侧点） */
  linkPorts?: LinkPortMaps
  /** 走线内核的折线（planRoutes 产出；不传 = 退回旧口径） */
  routes?: Map<string, LinkRoute>
  /** 标注拖拽结束回调（透传进 edge data） */
  onLabelCommit?: TopoEdgeData['onLabelCommit']
}

export const toFlowEdges = (
  links: TopologyLink[],
  roleOf: Map<string, TopologyRole>,
  pos: Map<string, { x: number; y: number }>,
  options: ToFlowEdgesOptions = {}
): Edge[] =>
  links
    .filter((l) => roleOf.has(l.from) && roleOf.has(l.to))
    .map((l) => {
      const a = pos.get(l.from)
      const b = pos.get(l.to)
      // 端口点就绪 → 每条链路接自己的端口（eNSP 式，线不再从同一点发散）；
      // 否则退回共用侧点（上下层级从底/顶接入，左右链路从右/左接入）
      const hasPort = !!options.linkPorts?.byLink.has(l.id) && !!a && !!b
      const sourceHandle = hasPort ? `p-${l.id}-src` : a && b ? `source-${sideOf(a, b)}` : 'source-right'
      const targetHandle = hasPort ? `p-${l.id}-dst` : a && b ? `target-${sideOf(b, a)}` : 'target-left'
      const slots = options.slots?.get(l.id)
      const route = options.routes?.get(l.id)
      return {
        id: l.id,
        source: l.from,
        target: l.to,
        sourceHandle,
        targetHandle,
        type: 'topo',
        data: {
          label: l.label,
          srcName: l.from,
          dstName: l.to,
          identity: linkIdentity(l),
          ...(l.lineType ? { lineType: l.lineType } : {}),
          ...(slots ? { slots } : {}),
          ...(route ? { route } : {}),
          ...(l.portOffsets ? { offsets: l.portOffsets } : {}),
          ...(options.onLabelCommit ? { onLabelCommit: options.onLabelCommit } : {})
        },
        style: {
          stroke: NODE_LINE_COLOR[roleOf.get(l.from) ?? 'unknown'],
          strokeWidth: 1.6,
          // 线型：串口族（Serial/POS/E1/ATM/CTL）虚线 —— 见 @shared/topology-link 的类型表
          ...(isDashedLineType(l.lineType) ? { strokeDasharray: '7 5' } : {})
        }
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

/**
 * 单个接口标签：默认落在自动槽位上，可拖拽微调（B4：位置随链路持久化），
 * 悬停展示该连接的双端接口信息（类比 eNSP 的接口标注）。
 *
 * 「受控」的含义：手调偏移的初值来自链路数据（`baseOffset`），拖拽结束时通过
 * `onCommitOffset` 上报落库 —— 于是刷新/切会话后标注还在你放的位置，
 * 而不是像过去那样只存在组件 state 里、一刷新就跳回默认位。
 */
export const PortLabel = memo(function PortLabel(props: {
  text: string
  tip: string
  x: number
  y: number
  selected?: boolean
  /** 缩放过小：只显示一个圆点（悬停仍可看到完整信息） */
  compact?: boolean
  /** 悬停聚焦时被淡化的标注 */
  dim?: boolean
  /** 已持久化的手调偏移（受控初值） */
  baseOffset?: TopologyPortOffset
  /** 拖拽结束上报（写回链路数据） */
  onCommitOffset?: (offset: TopologyPortOffset) => void
}): ReactNode {
  const { text, tip, x, y, selected, compact, dim, baseOffset, onCommitOffset } = props
  const [offset, setOffset] = useState<TopologyPortOffset>(() => baseOffset ?? { x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [hover, setHover] = useState(false)
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)
  /** 指针位移的即时值：pointerup 可能在同一个批次里读到旧的 state，故用 ref 兜底 */
  const offsetRef = useRef<TopologyPortOffset>(baseOffset ?? { x: 0, y: 0 })
  const movedRef = useRef(false)

  /**
   * 主进程回包（或被白名单收敛过）之后以链路数据为准。拖动中不同步 ——
   * 否则指针位移与回包会互相打架，表现为标签抖动。
   */
  useEffect(() => {
    if (dragging || !baseOffset) return
    offsetRef.current = baseOffset
    setOffset((prev) => (prev.x === baseOffset.x && prev.y === baseOffset.y ? prev : baseOffset))
  }, [baseOffset?.x, baseOffset?.y, dragging])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.stopPropagation()
    dragRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y }
    movedRef.current = false
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d) return
    const next = { x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }
    if (next.x !== d.ox || next.y !== d.oy) movedRef.current = true
    offsetRef.current = next
    setOffset(next)
  }
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    dragRef.current = null
    setDragging(false)
    // 只是点了一下没挪动 → 不写盘（避免每次点击都触发一次手动层保存）
    if (movedRef.current) onCommitOffset?.(offsetRef.current)
  }

  return (
    <div
      className={`topo-link-port nodrag${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}${
        compact ? ' compact' : ''
      }${dim ? ' dim' : ''}`}
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
 * - 标注锚定在**自动槽位**上（assignPortSlots 的跨链路统一编号），同侧多链路不再互相压住；
 * - 手调偏移（链路数据 portOffsets）叠加在槽位之上，位置随设备移动仍保持相对；
 * - 缩放过小时标注收成小点，悬停/选中展开；悬停聚焦时未点亮的标注一并淡化；
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
  const edgeData = data as TopoEdgeData | undefined
  const route = edgeData?.route
  /**
   * 旧口径兜底：没有走线内核结果时（比如刚拖出来的手动连线）仍旧用 smoothstep。
   *
   * R6/T7（PERF-MEM-REVIEW-2026-09-29 §4.3）：**必须惰性求值**。
   * `planRoutes` 给每条可绘制链路都产出了 `route`，所以生产路径上 `route`
   * 恒为真值、下面的 `: smoothPath` 分支**永不成立** —— 原来无条件先算一遍
   * `getSmoothStepPath` 是纯浪费（400 条边每次重渲就白算 400 次）。
   */
  const smooth = route
    ? null
    : getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const smoothPath = smooth?.[0] ?? ''
  const midX = smooth?.[1] ?? 0
  const midY = smooth?.[2] ?? 0
  /**
   * 走线内核给的折线是**按估算尺寸**算出来的，这里贴合到 React Flow 实测的连接点坐标：
   * 估算误差会让首/末段斜一小截（看着像没接到设备上）。
   */
  const path = route
    ? routeToPath(
        snapRouteToHandles(
          route.points,
          { x: sourceX, y: sourceY },
          { x: targetX, y: targetY },
          route.startAxis,
          route.endAxis
        )
      )
    : smoothPath
  const label = edgeData?.label
  const srcName = edgeData?.srcName
  const dstName = edgeData?.dstName
  const ports = splitPortLabel(label)
  const dim = !!edgeData?.dim
  /** 缩放过小且未聚焦 → 标注收成小点（分级显示） */
  const compact = !!edgeData?.dense && !selected && !edgeData?.emphasized
  const onLabelCommit = edgeData?.onLabelCommit

  if (!ports) {
    return (
      <>
        <BaseEdge id={id} path={path} style={style} interactionWidth={18} />
        {label ? (
          <EdgeLabelRenderer>
            <div
              className={`topo-link-port center nodrag${dim ? ' dim' : ''}`}
              style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)` }}
            >
              {label}
            </div>
          </EdgeLabelRenderer>
        ) : null}
      </>
    )
  }

  const offsets = edgeData?.offsets
  const srcSlots = edgeData?.slots?.from ?? []
  const dstSlots = edgeData?.slots?.to ?? []
  const srcOut = portOffset(sourcePosition)
  const dstOut = portOffset(targetPosition)
  const srcAxis = slotAxisOf(sourcePosition)
  const dstAxis = slotAxisOf(targetPosition)

  const pairTip = (i: number): string => {
    const a = `${srcName ?? ''} ${ports.from[i] ?? ''}`.trim()
    const b = ports.to[i] ? `${dstName ?? ''} ${ports.to[i]}`.trim() : ''
    return b ? `${a} ↔ ${b}` : a
  }

  /**
   * 标注基准 = 走线内核给出的锚点（已含**跨链路**槽位错开），并按实测连接点修正；
   * 没有路由结果时退回本地算法：连接点 + 外侧偏移 + 槽位错开。
   */
  const routeFrom = route?.fromPoint
  const routeLast = route?.points[route.points.length - 1]
  const fromDelta = route && route.points[0] ? { x: sourceX - route.points[0].x, y: sourceY - route.points[0].y } : { x: 0, y: 0 }
  const toDelta = routeLast ? { x: targetX - routeLast.x, y: targetY - routeLast.y } : { x: 0, y: 0 }

  const localBase = (
    x: number,
    y: number,
    outward: { x: number; y: number },
    axis: SlotAxis,
    slot: PortSlotInfo | undefined
  ): { x: number; y: number } => {
    const count = slot?.count ?? 1
    const gap = slot?.gap ?? (axis === 'y' ? SLOT_GAP_Y : SLOT_GAP_X)
    const spread = count > 1 ? ((slot?.index ?? 0) - (count - 1) / 2) * gap : 0
    return {
      x: x + outward.x + (axis === 'x' ? spread : 0),
      y: y + outward.y + (axis === 'y' ? spread : 0)
    }
  }

  const srcBase = routeFrom
    ? { x: routeFrom.x + fromDelta.x, y: routeFrom.y + fromDelta.y }
    : localBase(sourceX, sourceY, srcOut, srcAxis, srcSlots[0])
  const dstBase = route?.toPoint
    ? { x: route.toPoint.x + toDelta.x, y: route.toPoint.y + toDelta.y }
    : localBase(targetX, targetY, dstOut, dstAxis, dstSlots[0])

  /** 同一条链路的第 i 个端口相对第 0 个的步进（槽位序号是连续的）+ 手调偏移 */
  const placeAt = (
    base: { x: number; y: number },
    axis: SlotAxis,
    slot: PortSlotInfo | undefined,
    i: number,
    user: TopologyPortOffset | undefined
  ): { x: number; y: number } => {
    const gap = slot?.gap ?? (axis === 'y' ? SLOT_GAP_Y : SLOT_GAP_X)
    const step = i * gap
    return {
      x: base.x + (axis === 'x' ? step : 0) + (user?.x ?? 0),
      y: base.y + (axis === 'y' ? step : 0) + (user?.y ?? 0)
    }
  }

  return (
    <>
      <BaseEdge id={id} path={path} style={style} interactionWidth={18} />
      <EdgeLabelRenderer>
        {ports.from.map((p, i) => {
          const at = placeAt(srcBase, srcAxis, srcSlots[i], i, offsets?.from?.[i])
          return (
            <PortLabel
              key={`${id}:src${i}`}
              text={shortIf(p)}
              tip={pairTip(i)}
              x={at.x}
              y={at.y}
              selected={selected}
              compact={compact}
              dim={dim}
              baseOffset={offsets?.from?.[i]}
              onCommitOffset={onLabelCommit ? (o) => onLabelCommit(id, 'from', i, o) : undefined}
            />
          )
        })}
        {ports.to.map((p, i) => {
          const at = placeAt(dstBase, dstAxis, dstSlots[i], i, offsets?.to?.[i])
          return (
            <PortLabel
              key={`${id}:dst${i}`}
              text={shortIf(p)}
              tip={pairTip(i)}
              x={at.x}
              y={at.y}
              selected={selected}
              compact={compact}
              dim={dim}
              baseOffset={offsets?.to?.[i]}
              onCommitOffset={onLabelCommit ? (o) => onLabelCommit(id, 'to', i, o) : undefined}
            />
          )
        })}
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


/**
 * 区块分组框（B4 第二批）：把「汇聚交换机 + 它的子树」圈成一块，随画布缩放平移。
 *
 * 用 `ViewportPortal` 放进视口层（坐标即世界坐标），靠 `z-index: -1` 压在连线与设备之下、
 * 网格之上；关掉 pointer-events，免得挡住拖拽、框选与右键菜单。
 */
export const TopoBlockFrames = memo(function TopoBlockFrames(props: {
  blocks: TopologyBlock[]
  nameOf: Map<string, string>
}): ReactNode {
  if (props.blocks.length === 0) return null
  return (
    <ViewportPortal>
      {props.blocks.map((b) => (
        <div
          key={b.headId}
          className="topo-block"
          style={{
            transform: `translate(${b.box.x}px, ${b.box.y}px)`,
            width: b.box.w,
            height: b.box.h
          }}
        >
          {/* 标题：源图保真内核按模块给语义名（外网 / 分校 / ×× 区）；树形内核没标题，退回区块头设备名 */}
          <span className="topo-block-name">{b.title ?? props.nameOf.get(b.headId) ?? b.headId}</span>
        </div>
      ))}
    </ViewportPortal>
  )
})

export interface MenuState {
  x: number
  y: number
  kind: 'node' | 'edge' | 'pane'
  nodeId?: string
  edgeId?: string
  sub?: 'roles'
}

/** 拓扑操作指南浮窗提示组件（悬停展示完整快捷键与操作说明，节约工具栏空间） */
