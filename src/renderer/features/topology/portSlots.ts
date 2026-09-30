/**
 * 接口标注的槽位几何（B4）—— 纯函数，与 React 渲染无关。
 *
 * 为什么单独成一个模块：这套几何被**两个方向**同时使用 ——
 * ① 渲染层（`TopoEdge` 摆放标注、叠加手调偏移）；
 * ② 走线内核（`topoRouting` 计算标注锚点，并据此做「标注矩形不相交」的验收断言）。
 * 若继续留在 `TopoRender` 里，走线内核就得反向 import 渲染模块，形成循环依赖。
 *
 * ## v2.32「像图片那样接线」的方位口径（改这里前先读）
 *
 * 出线方位由**家族关系**决定，不再由角度硬分八扇区：
 * - 父亲（对端在更上面的层）→ `top`；子节点（更下面的层）→ `bottom`；
 * - 兄弟（同一层）→ `left` / `right`；
 * - 同一侧**优先用边中点**，只有超过 2 条才把最外侧的挤到该侧的两个**边角**。
 *
 * 权威的「同层」判据是行模型（`topoRouting.buildRowModel` 的 `rowOf`），不是角度：
 * 自动布局里父子相隔 `LAYER_GAP`(320)、兄弟相隔 `PEER_GAP_X`(480)，一棵宽子树的父设备
 * 与最外侧子设备可能横跨两格 —— 只看角度会把这种**明确的父子**判成兄弟，于是线从父设备
 * 左右边甩出去（倒八），与「走线按父子成束」的分类自相矛盾。拿不到行模型（单测兜底）
 * 时退回 `sideOf` 的几何口径。
 */
import { Position } from '@xyflow/react'
import type { TopologyLink } from '@shared/types'
import { shortIf, splitPortLabel } from './portLabel'

/** 连接点所在侧（取值与 React Flow 的 Position 同形） */
export type Side = 'left' | 'right' | 'top' | 'bottom'

/**
 * 8 方向连接点的**类型**（B4 第五批遗留）。
 *
 * v2.32 起出线方位只取四边（父亲/子节点/兄弟），角点不再由方位判断产生 ——
 * 「超过两条才用边角」是**同侧容量**问题，由 `portPcts` 用 pct=0/1 落在两条邻边的
 * 端点（即边角）来表达，几何上与 `Side8` 的角点等价，但保留「这条线从哪条边进出」
 * 的语义，走线首段方向才不会算错。类型与 `handlePlacementOf` 的角点分支保留，
 * 供渲染层与单测继续使用。
 */
export type Side8 = Side | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export const CORNER_SIDES: readonly Side8[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

export function isCornerSide(s: Side8): boolean {
  return CORNER_SIDES.includes(s)
}

/**
 * 依据两节点中心的相对方位判断连线该从哪一侧进出（决定使用上下还是左右连接点）。
 *
 * v2.32 起**向上下层偏置**：只有横向明显占优（`|dx| > 1.5·|dy|`）才算「同层兄弟」走
 * 左右，其余（含 45° 斜向）一律按「父亲在上层、子节点在下层」走 top/bottom。
 * 阈值 1.5 就是从旧口径继承下来的：过去 1.5:1 以内算「对角」而给角点，现在这段
 * 对角带改判为上下层 —— 父设备连着斜下方的子设备时不再从左右边甩线。
 */
export function sideOf(a: { x: number; y: number }, b: { x: number; y: number }): Side {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) > Math.abs(dy) * 1.5) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/**
 * 链路一端的方位 = **家族方位**（v2.32）：父亲 → `top`、子节点 → `bottom`、
 * 兄弟 → `left`/`right`。同层判据来自行模型（`rowOf`），拿不到时退回 `sideOf`。
 *
 * 为什么必须与行模型同源：走线内核用行号决定打法（相邻行＝树干成束、同行＝层间车道），
 * 连接点若按另一套口径给出方位，线就会在端口处多拐一个直角（走线按父子竖向、端口却
 * 在左右边）。`TopologyCanvas` 与 `planRoutes` 都传同一份 `rowOf`。
 */
export function endSideOf(
  nodeId: string,
  peerId: string,
  a: { x: number; y: number },
  b: { x: number; y: number },
  rowOf?: Map<string, number>
): Side {
  const selfRow = rowOf?.get(nodeId)
  const peerRow = rowOf?.get(peerId)
  if (selfRow !== undefined && peerRow !== undefined) {
    // 不同行 = 上下层（父子）→ 对端在下走底边、在上走顶边；同一行 = 兄弟 → 左右
    if (selfRow !== peerRow) return b.y >= a.y ? 'bottom' : 'top'
    return b.x >= a.x ? 'right' : 'left'
  }
  return sideOf(a, b)
}

/** 槽位排开方向：top/bottom 连接点沿节点横边排（x），left/right 沿竖边排（y） */
export type SlotAxis = 'x' | 'y'

export function slotAxisOf(pos: Position): SlotAxis {
  return pos === Position.Top || pos === Position.Bottom ? 'x' : 'y'
}

/**
 * 相邻槽位的中心间距（B4）。
 *
 * 间距必须**大于标注自身尺寸**才谈得上「不重合」，而两个方向的约束不同：
 * - 竖排（left/right 连接点）：只受标注**高度**限制（10px 字号 × 1.5 行高 + 边框 ≈ 17px），取常量 22；
 * - 横排（top/bottom 连接点）：受标注**宽度**限制，而宽度随接口名变长（`GE0/0/1` 与
 *   `Serial0/0/1` 差 35px）—— 所以横排的间距按该组最长名字算，SLOT_GAP_X 只是下限。
 *
 * 用间距换「不重叠」，而不是事后做碰撞检测：可预测、可单测，拖动时也不会抖。
 */
export const SLOT_GAP_X = 70
export const SLOT_GAP_Y = 22
/** 标注宽度估算：10px 等宽字 ≈ 6.2px/字符，加左右 padding 与边框 */
const CHIP_CHAR_W = 6.2
const CHIP_PAD = 14

/** 估算一枚接口标注的像素宽度（与 topology.css 的 .topo-link-port 字号/padding 对齐） */
export function chipWidthOf(text: string): number {
  return Math.round(shortIf(text).length * CHIP_CHAR_W + CHIP_PAD)
}

/**
 * 同一连接点内的槽位：
 * - index / count = 组内序号与总数；
 * - gap = 沿排开方向的相邻中心间距（横排按组内最长接口名算出，竖排为常量）。
 */
export interface PortSlotInfo {
  index: number
  count: number
  gap: number
}

/** 链路两端的槽位表：与 splitPortLabel 的端口顺序一一对应 */
export interface PortSlotTable {
  from: PortSlotInfo[]
  to: PortSlotInfo[]
}

/**
 * 方位判据的共享入参：**行模型**（`topoRouting.buildRowModel` 产出的 `rowOf`）。
 * 缺省 = 拿不到层信息（单测/离线调用），退回 `sideOf` 的纯几何口径。
 */
export interface SideContext {
  rowOf?: Map<string, number>
}

/** 一个「连接点上的端口」：同 (节点, 侧) 归为一组统一编号 */
interface PortSlotEntry {
  linkId: string
  end: 'from' | 'to'
  axis: SlotAxis
  ports: number
  /** 该端最长接口名的字符数（横排据此算间距；无标注的链路为 0） */
  chars: number
  /** 对端坐标：用来决定槽位顺序（让标注顺序与连线在画布上的左右/上下顺序一致） */
  peer: { x: number; y: number }
}

/** 该端最长接口名的字符数（无端口标注 → 0，不去撑大间距） */
function widestPortChars(ports: string[] | undefined): number {
  if (!ports || ports.length === 0) return 0
  return ports.reduce((m, s) => Math.max(m, shortIf(s).length), 0)
}

/**
 * 接口标注分槽（B4）——治「同一连接点上的标注逐字重合」。
 *
 * 旧实现拿「链路内部」的端口序号算错开量，而同一个 handle 只有一个坐标：于是每条
 * 链路的第 0 个端口算出来的锚点完全相同，所有链路的第一个标注**整片叠死**（截图里
 * Core1 左侧两个 GE 标注压在一起）。这里改成**跨链路统一编号**：同一 (节点, 侧)
 * 上的所有端口先按对端位置排序，再依次编号，每条链路拿到自己的 index 与组内总数
 * count；渲染层据此把标注沿该侧的切向铺开。
 *
 * 约定：没有端口标注的链路（手动连线）**同样占一个槽位** —— 它的线确实占着那个
 * 连接点，留出空位比让别人的标注压在它的线上更诚实。
 */
export function assignPortSlots(
  links: TopologyLink[],
  pos: Map<string, { x: number; y: number }>,
  context: SideContext = {}
): Map<string, PortSlotTable> {
  const groups = new Map<string, PortSlotEntry[]>()

  for (const l of links) {
    const a = pos.get(l.from)
    const b = pos.get(l.to)
    // 与 toFlowEdges 同口径：端点没有坐标的链路不参与画布重建，也不占槽位
    if (!a || !b) continue
    const ports = splitPortLabel(l.label)
    const specs: Array<{
      end: 'from' | 'to'
      side: Side
      peer: { x: number; y: number }
      ports: number
      chars: number
    }> = [
      {
        end: 'from',
        side: endSideOf(l.from, l.to, a, b, context.rowOf),
        peer: b,
        ports: Math.max(1, ports?.from.length ?? 0),
        chars: widestPortChars(ports?.from)
      },
      {
        end: 'to',
        side: endSideOf(l.to, l.from, b, a, context.rowOf),
        peer: a,
        ports: Math.max(1, ports?.to.length ?? 0),
        chars: widestPortChars(ports?.to)
      }
    ]
    for (const s of specs) {
      const nodeId = s.end === 'from' ? l.from : l.to
      const key = `${nodeId}|${s.side}`
      const list = groups.get(key) ?? []
      list.push({
        linkId: l.id,
        end: s.end,
        axis: slotAxisOf(sideToPosition(s.side)),
        ports: s.ports,
        chars: s.chars,
        peer: s.peer
      })
      groups.set(key, list)
    }
  }

  const out = new Map<string, PortSlotTable>()
  for (const entries of groups.values()) {
    const axis = entries[0]?.axis ?? 'y'
    // 顺序即槽位顺序：按对端在切向轴上的位置排，其次另一轴、最后 linkId —— 保证同一
    // 份数据每次渲染得到同一个编号（否则拖动/刷新时标注会互相换位）
    const sorted = [...entries].sort((p, q) => {
      const pv = axis === 'x' ? p.peer.x : p.peer.y
      const qv = axis === 'x' ? q.peer.x : q.peer.y
      if (pv !== qv) return pv - qv
      const pw = axis === 'x' ? p.peer.y : p.peer.x
      const qw = axis === 'x' ? q.peer.y : q.peer.x
      if (pw !== qw) return pw - qw
      return p.linkId < q.linkId ? -1 : p.linkId > q.linkId ? 1 : 0
    })
    const count = sorted.reduce((sum, e) => sum + e.ports, 0)
    // 横排间距按组内最长接口名算（下限 SLOT_GAP_X）；竖排只看高度，是常量
    const widest = sorted.reduce((m, e) => Math.max(m, e.chars), 0)
    const gap = axis === 'y' ? SLOT_GAP_Y : Math.max(SLOT_GAP_X, Math.round(widest * CHIP_CHAR_W + CHIP_PAD))
    let cursor = 0
    for (const e of sorted) {
      const slots: PortSlotInfo[] = []
      for (let i = 0; i < e.ports; i += 1) slots.push({ index: cursor + i, count, gap })
      cursor += e.ports
      const table = out.get(e.linkId) ?? { from: [], to: [] }
      table[e.end] = slots
      out.set(e.linkId, table)
    }
  }
  return out
}

/** Side（字符串方位）→ Position（连接点所在侧） */
export function sideToPosition(side: Side): Position {
  switch (side) {
    case 'top':
      return Position.Top
    case 'bottom':
      return Position.Bottom
    case 'left':
      return Position.Left
    default:
      return Position.Right
  }
}

/** 8 方向 → Handle 的 Position（角点按竖直分量归到 top/bottom，配合 style 横向定位到角） */
export function positionOfSide8(side: Side8): Position {
  if (side === 'left') return Position.Left
  if (side === 'right') return Position.Right
  if (side === 'top' || side.startsWith('top-')) return Position.Top
  return Position.Bottom
}

/** 8 方向端口 → Handle 内联定位样式（pct 沿边铺开；角点用 left: 0%/100% 钉在角上） */
export function handlePlacementOf(
  side: Side8,
  pct: number
): { position: Position; style: { top?: string; left?: string } } {
  switch (side) {
    case 'left':
      return { position: Position.Left, style: { top: `${pct * 100}%` } }
    case 'right':
      return { position: Position.Right, style: { top: `${pct * 100}%` } }
    case 'top':
      return { position: Position.Top, style: { left: `${pct * 100}%` } }
    case 'bottom':
      return { position: Position.Bottom, style: { left: `${pct * 100}%` } }
    case 'top-left':
      return { position: Position.Top, style: { left: '0%' } }
    case 'top-right':
      return { position: Position.Top, style: { left: '100%' } }
    case 'bottom-left':
      return { position: Position.Bottom, style: { left: '0%' } }
    default:
      return { position: Position.Bottom, style: { left: '100%' } }
  }
}

/**
 * —— 每条链路独立的连接点（B4 第五批「像 eNSP 一样两点直连」）——
 *
 * 之前所有链路共用每侧的一个 handle，线全从同一个点发散；eNSP 是**每条连线在设备
 * 边框上占一个独立圆点**。这里给每条链路的每一端分配一个端口：同 (节点, 侧) 上的
 * 链路按对端方位排序后沿该侧铺开（位置见 `portPcts`），渲染层用它生成 Handle
 * （React Flow 会实测 DOM 坐标，比例位置天然适配实际节点尺寸），走线内核用它作为
 * 直线/折线的端点锚点。
 */

/** 链路一端的端口：所在侧 + 沿该侧的比例位置（pct = 0/1 即该侧的两个**边角**） */
export interface LinkPortSpec {
  side: Side8
  /** left/right 侧：自上而下 0→1；top/bottom 侧：自左而右 0→1 */
  pct: number
}

/** 链路两端的端口表 */
export interface LinkPortTable {
  src: LinkPortSpec
  dst: LinkPortSpec
}

/** 节点边框上的一枚端口（渲染层据此生成 Handle） */
export interface NodePortHandle {
  linkId: string
  side: Side8
  kind: 'source' | 'target'
  pct: number
}

export interface LinkPortMaps {
  byNode: Map<string, NodePortHandle[]>
  byLink: Map<string, LinkPortTable>
}

/** 沿侧边铺开轴上取对端坐标：left/right 侧看对端 y，top/bottom 侧看对端 x */
function peerCoord(peer: { x: number; y: number }, side: Side): number {
  return side === 'left' || side === 'right' ? peer.y : peer.x
}

/**
 * 设备框的名义边长（像素）—— 与 `nodeSize` 的估算口径同源（min-width 130 → 对齐后 142）。
 * 只用来把「两条链路之间的像素间距」换算成沿边的比例。
 */
const NOMINAL_EDGE: Record<SlotAxis, number> = { x: 142, y: 52 }
/** 同一侧只有 2 条时的中线偏移（像素）：两条仍**贴着边中点**两侧对称排开 */
const PAIR_SPLIT_PX = 8

/**
 * 同一（节点, 侧）上 n 条链路的出线位置（沿该边的比例）—— v2.32 用户口径：
 *
 * - **优先中点**：1 条 → 正好落在边中点（与对端中点连成一条真正竖直/水平的线）；
 *   2 条 → 中点两侧各偏 8px（≈16px 间距），仍聚在中点附近而不是均摊到整条边；
 * - **超过两条才用边角**：≥3 条铺满整条边，最外侧两条正好落在该侧的两个**边角**
 *   （pct 0 / 1）—— 父设备下挂 3 台子设备时左右两条从两个下角出线，形成 eNSP 式的
 *   八字发散，而不是全部挤在中点附近互相挨着。
 */
export function portPcts(n: number, axis: SlotAxis): number[] {
  if (n <= 1) return [0.5]
  if (n === 2) {
    const d = PAIR_SPLIT_PX / NOMINAL_EDGE[axis]
    return [0.5 - d, 0.5 + d]
  }
  return Array.from({ length: n }, (_, i) => i / (n - 1))
}

export function assignLinkPorts(
  links: TopologyLink[],
  pos: Map<string, { x: number; y: number }>,
  context: SideContext = {}
): LinkPortMaps {
  const groups = new Map<
    string,
    Array<{ linkId: string; end: 'src' | 'dst'; side: Side; peer: { x: number; y: number } }>
  >()
  for (const l of links) {
    const a = pos.get(l.from)
    const b = pos.get(l.to)
    if (!a || !b) continue
    const specs = [
      { end: 'src' as const, nodeId: l.from, side: endSideOf(l.from, l.to, a, b, context.rowOf), peer: b },
      { end: 'dst' as const, nodeId: l.to, side: endSideOf(l.to, l.from, b, a, context.rowOf), peer: a }
    ]
    for (const s of specs) {
      const key = `${s.nodeId}|${s.side}`
      const list = groups.get(key) ?? []
      list.push({ linkId: l.id, end: s.end, side: s.side, peer: s.peer })
      groups.set(key, list)
    }
  }

  const byNode = new Map<string, NodePortHandle[]>()
  const byLink = new Map<string, LinkPortTable>()

  for (const [key, entries] of groups) {
    const sep = key.lastIndexOf('|')
    const nodeId = key.slice(0, sep)
    const side = entries[0]!.side
    // 铺开顺序 = 对端在铺开轴上的顺序（eNSP 语义：连线往左去的端口点排在边框左侧）
    const sorted = [...entries].sort((p, q) => {
      const d = peerCoord(p.peer, side) - peerCoord(q.peer, side)
      if (d !== 0) return d
      const py = p.peer.x + p.peer.y
      const qy = q.peer.x + q.peer.y
      if (py !== qy) return py - qy
      return p.linkId < q.linkId ? -1 : p.linkId > q.linkId ? 1 : 0
    })
    const pcts = portPcts(sorted.length, slotAxisOf(sideToPosition(side)))
    sorted.forEach((e, i) => {
      const pct = pcts[i] ?? 0.5
      const list = byNode.get(nodeId) ?? []
      list.push({ linkId: e.linkId, side, kind: e.end === 'src' ? 'source' : 'target', pct })
      byNode.set(nodeId, list)
      const table = byLink.get(e.linkId) ?? { src: { side, pct: 0.5 }, dst: { side, pct: 0.5 } }
      table[e.end === 'src' ? 'src' : 'dst'] = { side, pct }
      byLink.set(e.linkId, table)
    })
  }
  return { byNode, byLink }
}

/** 端口点在节点矩形上的坐标（rect = 节点外框；与渲染层 Handle 的定位同口径） */
export function portPointOf(
  rect: { x: number; y: number; w: number; h: number },
  spec: LinkPortSpec
): { x: number; y: number } {
  if (spec.side === 'left') return { x: rect.x, y: rect.y + rect.h * spec.pct }
  if (spec.side === 'right') return { x: rect.x + rect.w, y: rect.y + rect.h * spec.pct }
  if (spec.side === 'top') return { x: rect.x + rect.w * spec.pct, y: rect.y }
  if (spec.side === 'bottom') return { x: rect.x + rect.w * spec.pct, y: rect.y + rect.h }
  // 角点：正好在矩形顶点上
  const right = spec.side.endsWith('right')
  const bottom = spec.side.startsWith('bottom')
  return { x: right ? rect.x + rect.w : rect.x, y: bottom ? rect.y + rect.h : rect.y }
}
