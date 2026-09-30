/**
 * 拓扑走线内核（B4 第二批）—— 方案 B：**分层树干成束**。
 *
 * 修掉的两个病（第一批只治了标注重合）：
 * 1. **折点压框**：旧实现交给 `getSmoothStepPath`，它在两点中点插折段，折点正落在
 *    中间那台设备的框上（截图里 Building1 被横线穿过）。
 * 2. **共线/交叉**：同层节点 y 相同 → 所有横向长链路贴在同一条线上；同层链路还必然是
 *    直线，与跨层竖段交叉（截图里 Core 层那条贯穿全宽的「干线」）。
 *
 * 走线模型（三类，按行模型分类）：
 * - **相邻行（父子）**：从父的底部出线 → 垂直下到行间走廊 → 沿**共享树干**水平铺开 →
 *   各自垂直到子的顶部。同一父节点、同一方向的链路共用一条干线（方案 B），
 *   末端才分叉 —— 线条数量从 N 条降到 1 主干 + N 分叉。
 * - **同层**：走「层间车道」（行上方/下方的水平车道），不再横穿整层；车道按
 *   区间着色的贪心分配，x 区间不重叠的链路复用同一条车道。
 * - **跨层（跳级）**：经由**垂直通道**穿过中间各行 —— 通道从「全局自由 x」（不与任何
 *   设备框相交的 x）里就近取，并登记占用，避免两条线挤在同一条通道上。
 *
 * 所有几何都是轴对齐折线，因此 4 条验收断言（不共线重合 / 不穿节点框 / 标注不相交 /
 * 不穿区块框）可以在 `checkRouteInvariants` 里逐段判定 —— 单测与真实数据探针共用它。
 */
import type { TopologyLink, TopologyNode } from '@shared/types'
import type { TopologyBlock } from './autoLayout'
import { estimateNodeSizeAligned, type NodeSize } from './nodeSize'
import { shortIf, splitPortLabel } from './portLabel'
import {
  assignLinkPorts,
  assignPortSlots,
  chipWidthOf,
  portPointOf,
  positionOfSide8,
  sideOf,
  slotAxisOf,
  type LinkPortMaps,
  type LinkPortTable,
  type PortSlotTable,
  type Side8
} from './portSlots'

export interface RoutePoint {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 折线**首/末段**的方向：'v' 竖直（上下连接点进出）、'h' 水平（左右连接点进出）。
 * 注意与 `SlotAxis`（标注沿哪个坐标排开：'x'|'y'）不是一回事 —— 后者是标注排开方向。
 */
export type RouteAxis = 'v' | 'h'

export interface TopoRow {
  /** 该行的 y（取行内节点最小 y） */
  y: number
  /** 行内节点在垂直方向上的上/下边界 */
  top: number
  bottom: number
  nodeIds: string[]
}

export interface LinkRoute {
  linkId: string
  from: string
  to: string
  /** 折线顶点（含首尾）。首尾点是**估算**的连接点位置，渲染层会用实测连接点坐标覆盖 */
  points: RoutePoint[]
  /** 首段方向：'v' = 竖直（上下连接点进出），'h' = 水平（左右连接点进出） */
  startAxis: RouteAxis
  endAxis: RouteAxis
  /** 两端标注锚点（已含槽位错开；手调偏移由渲染层叠加） */
  fromPoint: RoutePoint
  toPoint: RoutePoint
  /** 标注估算宽度（0 = 该端没有端口标注）；验收断言用它算标注矩形 */
  fromW: number
  toW: number
  /** 成束归属：同一束内的链路**允许**共线（那就是「共干」的含义） */
  bundle: string
  /** 是否退化为两点直连兜底（避让无解时） */
  fallback: boolean
  /**
   * 直线路径（B4 第五批「像 eNSP 一样两点直连」）：源端口点 → 目标端口点一条直线段。
   * 直线只在**不穿过任何别的设备框**时采用 —— 穿框就走正交折线避让。
   * 直线允许穿过区块框（框是画在背景层的高亮，不是物理隔断）。
   */
  straight: boolean
}

// ——————————————————————————— 区块框的取舍 ———————————————————————————

/**
 * 区块框的取舍（面积比阈值）。
 *
 * 为什么需要这一层：双核心冗余接线下，一个区块可能吸走十几台设备（真实数据里 Core1
 * 的区块有 18 台），它的包围盒会罩住大半张图 —— 那既不是「分组」（它是整张图本身），
 * 也无法让别的线绕开。判据用**面积比**：框面积超过整张图面积的这个比例就不画，
 * 只有落在它里面的线才把它当障碍。
 */
export const FRAME_AREA_RATIO = 0.33
/** 单台设备的「区块」不构成分组，不画框 */
export const MIN_FRAME_NODES = 2

/** 若干矩形的并集包围盒（0 尺寸时返回最小合法值，避免面积比除零） */
export function drawingBounds(rects: Iterable<Rect>): Rect {
  let x1 = Number.POSITIVE_INFINITY
  let y1 = Number.POSITIVE_INFINITY
  let x2 = Number.NEGATIVE_INFINITY
  let y2 = Number.NEGATIVE_INFINITY
  for (const r of rects) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w)
    y2 = Math.max(y2, r.y + r.h)
  }
  if (!Number.isFinite(x1)) return { x: 0, y: 0, w: 1, h: 1 }
  return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) }
}

/** 值得画框、且应当作为走线障碍的区块 */
export function selectFramedBlocks(blocks: TopologyBlock[], bounds: Rect): TopologyBlock[] {
  const total = Math.max(1, bounds.w * bounds.h)
  return blocks.filter(
    (b) => b.nodeIds.length >= MIN_FRAME_NODES && (b.box.w * b.box.h) / total <= FRAME_AREA_RATIO
  )
}

export interface RouteModel {
  routes: Map<string, LinkRoute>
  rows: TopoRow[]
  /** nodeId → 区块头 id（不属于任何区块的节点不在表里） */
  blockOf: Map<string, string>
  rects: Map<string, Rect>
  /** 实际画框、且作为走线障碍的区块（已按面积比取舍） */
  framedBlocks: TopologyBlock[]
}

export interface PlanRoutesInput {
  nodes: TopologyNode[]
  links: TopologyLink[]
  positions: Map<string, { x: number; y: number }>
  /** 区块（布局产出）；不传 = 不画分组框、也不按区块避让 */
  blocks?: TopologyBlock[]
  /** 节点尺寸覆盖（渲染层可传入实测尺寸，缺省用估算） */
  sizes?: Map<string, NodeSize>
  /**
   * 已算好的标注槽位（渲染层 `assignPortSlots` 产出）。
   *
   * 传入是为了**消除重复计算**：画布本来就要一份给 `toFlowEdges` 用，内核再算一遍
   * 纯属浪费（大图上各 1~1.5ms）。语义与内核自算完全一致，只是复用同一份结果。
   * 不传 = 内核自算（保持既有调用点与单测行为不变）。
   */
  slots?: Map<string, PortSlotTable>
  /** 已算好的每链路端口点（渲染层 `assignLinkPorts` 产出）；同上，不传则自算 */
  linkPorts?: LinkPortMaps
  /**
   * `positions` 的坐标口径：**true = 设备框中心**（布局内核的原始输出）。
   *
   * 必须显式声明而不能猜：布局给的中心与 store/画布给的左上角混用会让障碍框整体偏移
   * 半个设备高，走线会绕开一个「不存在的障碍」。缺省 false = 左上角（历史口径）。
   */
  positionsAreCenters?: boolean
}

/** 终点与设备框之间的净空：贴太近会看不清是哪台设备 */
const CLEAR = 8
/** 连接点向外推的距离（与渲染层的 portOffset 保持一致：±32） */
const PORT_OUT = 32
/** 行间车道的层高与首条车道到行的间距 */
const LANE_H = 14
const LANE_GAP = 16
/** 通道/折点的搜索步长与最大搜索距离 */
const SEARCH_STEP = 4
const SEARCH_MAX = 1200

// ——————————————————————————— 基础几何 ———————————————————————————

/**
 * 节点矩形（走线内核的障碍框 / 端口点基准）。
 *
 * ⚠️ **坐标口径（2026-09-29 起）**：`positions` 传进来的可能是「设备框中心」
 * （布局内核的原始输出）或「左上角」（画布/store 里的坐标，用户拖过的就是这种）。
 * 是否做中心换算由 `PlanRoutesInput.positionsAreCenters` 显式声明 —— **不靠猜**：
 * 混两种口径会让障碍框整体偏移半个设备，走线就会「看起来绕开了一台不存在的设备」。
 */
function rectOfNode(
  id: string,
  positions: Map<string, { x: number; y: number }>,
  size: NodeSize,
  /** true = 入参坐标是中心，需换算成左上角 */
  centered: boolean
): Rect | null {
  const p = positions.get(id)
  if (!p) return null
  if (!centered) return { x: p.x, y: p.y, w: size.w, h: size.h }
  return { x: p.x - size.w / 2, y: p.y - size.h / 2, w: size.w, h: size.h }
}

function vOverlap(r: Rect, y1: number, y2: number): boolean {
  return r.y < y2 && r.y + r.h > y1
}

/** 轴对齐/斜线段是否穿过矩形**内部**（擦边不算；斜线用 Liang-Barsky 精确裁剪） */
export function segHitsRect(x1: number, y1: number, x2: number, y2: number, r: Rect, eps = 0.5): boolean {
  const rx1 = r.x + eps
  const ry1 = r.y + eps
  const rx2 = r.x + r.w - eps
  const ry2 = r.y + r.h - eps
  if (Math.abs(y1 - y2) <= eps) {
    // 水平段
    return y1 > ry1 && y1 < ry2 && Math.min(x1, x2) < rx2 && Math.max(x1, x2) > rx1
  }
  if (Math.abs(x1 - x2) <= eps) {
    // 竖直段
    return x1 > rx1 && x1 < rx2 && Math.min(y1, y2) < ry2 && Math.max(y1, y2) > ry1
  }
  // 斜线段（直线优先的连线）：Liang-Barsky 精确裁剪 —— 包围盒粗判会把「只是路过旁边」
  // 的斜线全部误判成穿框，密集布局里直线就一条都活不下来
  const dx = x2 - x1
  const dy = y2 - y1
  let t0 = 0
  let t1 = 1
  const edges: Array<[number, number]> = [
    [-dx, x1 - rx1], // 左边界
    [dx, rx2 - x1], // 右边界
    [-dy, y1 - ry1], // 上边界
    [dy, ry2 - y1] // 下边界
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false // 与该边界平行且在外侧
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return t1 > t0
}

// ——————————————————————————— 障碍空间索引 ———————————————————————————

/**
 * 障碍矩形的**均匀网格索引**（2026-09-29 导入性能治理）。
 *
 * 为什么必须有：走线内核里两处查询都是「一条线段 / 一条走廊 × **全部**障碍」——
 * ① 每条链路的直线优先探测；② 每个束选走廊高度时最多 17 档 × 全部障碍 × 各竖段。
 * 实测 300 台拓扑下这两处合计 ≈ 108ms（直线 31ms + 走廊 77ms），其中**绝大多数
 * 障碍与当前线段毫无 y 交集**，纯属白跑。
 *
 * 做法：把障碍按矩形分桶到 `CELL` 见方的网格，查询时只取「线段包围盒覆盖的格子」。
 * 复杂线段退化为「取 bbox 内所有格子」；但**候选集仍用 `segHitsRect` 精确判定**，
 * 因此结果与全量扫描**逐位一致**（索引只做排除，不改判据）。
 *
 * 索引是纯读取结构，不改变 `planRoutes` 的任何几何语义 —— 这是它能安全替换
 * 「全量扫描」的前提（既有黄金用例 / 走线断言一个字都不用改）。
 */
export class ObstacleIndex {
  private readonly cells = new Map<string, number[]>()
  private readonly cell: number
  private readonly items: Rect[]

  constructor(rects: Rect[], cell = 320) {
    this.cell = cell
    this.items = rects
    for (let i = 0; i < rects.length; i += 1) {
      const r = rects[i]!
      const x1 = Math.floor(r.x / cell)
      const x2 = Math.floor((r.x + r.w) / cell)
      const y1 = Math.floor(r.y / cell)
      const y2 = Math.floor((r.y + r.h) / cell)
      for (let cx = x1; cx <= x2; cx += 1) {
        for (let cy = y1; cy <= y2; cy += 1) {
          const k = `${cx},${cy}`
          const list = this.cells.get(k)
          if (list) list.push(i)
          else this.cells.set(k, [i])
        }
      }
    }
  }

  /**
   * 与给定包围盒相交的候选障碍（**已去重**）。
   * 只做粗筛；调用方仍需用 `segHitsRect` 精确判定。
   */
  candidates(x1: number, y1: number, x2: number, y2: number): Rect[] {
    const lo = (a: number, b: number): number => Math.floor(Math.min(a, b) / this.cell)
    const hi = (a: number, b: number): number => Math.floor(Math.max(a, b) / this.cell)
    const cx1 = lo(x1, x2)
    const cx2 = hi(x1, x2)
    const cy1 = lo(y1, y2)
    const cy2 = hi(y1, y2)
    const out: Rect[] = []
    const seen = new Set<number>()
    for (let cx = cx1; cx <= cx2; cx += 1) {
      for (let cy = cy1; cy <= cy2; cy += 1) {
        const list = this.cells.get(`${cx},${cy}`)
        if (!list) continue
        for (const i of list) {
          if (seen.has(i)) continue
          seen.add(i)
          out.push(this.items[i]!)
        }
      }
    }
    return out
  }

  /** 空索引（无障碍时用它，避免到处判空） */
  static readonly EMPTY = new ObstacleIndex([], 320)
}

// ——————————————————————————— 行模型 ———————————————————————————

/**
 * 把节点按 y 聚成「行」（同一行 = 垂直位置基本一致）。
 *
 * 布局输出的同一层 y 完全相同；手工摆放的坐标则允许半个节点高度内的偏差仍算同一行 ——
 * 否则任意坐标下的行模型会退化成「一行一台设备」，车道与树干就都没法用了。
 */
export function buildRowModel(
  nodes: TopologyNode[],
  positions: Map<string, { x: number; y: number }>,
  sizes: Map<string, NodeSize>,
  /** true = `positions` 是设备框中心（布局内核输出），需换算成左上角（见 rectOfNode） */
  centered = false
): { rows: TopoRow[]; rects: Map<string, Rect>; rowOf: Map<string, number> } {
  const rects = new Map<string, Rect>()
  for (const n of nodes) {
    const size = sizes.get(n.id) ?? estimateNodeSizeAligned(n.name, n.role, n.model)
    const r = rectOfNode(n.id, positions, size, centered)
    if (r) rects.set(n.id, r)
  }
  const entries = [...rects.entries()].map(([id, r]) => ({ id, r })).sort((a, b) => a.r.y - b.r.y)

  const rows: TopoRow[] = []
  const rowOf = new Map<string, number>()
  for (const e of entries) {
    const cur = rows[rows.length - 1]
    // 与当前行「垂直位置基本一致」→ 归入同一行（阈值 = 半个节点高）
    if (cur && Math.abs(e.r.y - cur.y) <= e.r.h / 2) {
      cur.nodeIds.push(e.id)
      cur.top = Math.min(cur.top, e.r.y)
      cur.bottom = Math.max(cur.bottom, e.r.y + e.r.h)
      rowOf.set(e.id, rows.length - 1)
      continue
    }
    rows.push({ y: e.r.y, top: e.r.y, bottom: e.r.y + e.r.h, nodeIds: [e.id] })
    rowOf.set(e.id, rows.length - 1)
  }
  return { rows, rects, rowOf }
}

// ——————————————————————————— 车道 / 通道分配 ———————————————————————————

/**
 * 区间着色的贪心车道分配：x 区间不重叠的链路可以复用同一条车道（否则线会叠在一起）。
 * 返回每条链路的车道序号，用于把车道 y 错开。
 */
export function allocateLanes(spans: Array<{ id: string; x1: number; x2: number }>): Map<string, number> {
  const laneEnds: number[] = []
  const out = new Map<string, number>()
  for (const s of [...spans].sort((a, b) => a.x1 - b.x1)) {
    let lane = laneEnds.findIndex((end) => end < s.x1)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(s.x2)
    } else {
      laneEnds[lane] = s.x2
    }
    out.set(s.id, lane)
  }
  return out
}

/** 已占用的垂直通道（同 x 附近且 y 区间重叠 → 不能复用） */
interface Channel {
  x: number
  y1: number
  y2: number
}

const CHANNEL_SEP = 10

function channelFree(channels: Channel[], x: number, y1: number, y2: number): boolean {
  return !channels.some((c) => Math.abs(c.x - x) < CHANNEL_SEP && c.y1 < y2 && c.y2 > y1)
}

/**
 * 就近找一条「全局自由」的垂直通道：穿过 [y1,y2] 的行时不能让任何设备框/外部区块框挡住。
 * 先试首选 x，不行就左右交替外扩（步长 4px）。无解时返回首选 x（宁可穿框也不绕远）。
 */
function nearestFreeChannel(
  obstacles: Rect[],
  channels: Channel[],
  x: number,
  y1: number,
  y2: number,
  bounds: { min: number; max: number }
): number {
  const blocked = (cx: number): boolean => {
    if (cx < bounds.min || cx > bounds.max) return true
    if (!channelFree(channels, cx, y1, y2)) return true
    return obstacles.some((o) => vOverlap(o, y1, y2) && cx > o.x - CLEAR && cx < o.x + o.w + CLEAR)
  }
  if (!blocked(x)) return x
  for (let d = SEARCH_STEP; d <= SEARCH_MAX; d += SEARCH_STEP) {
    if (!blocked(x - d)) return x - d
    if (!blocked(x + d)) return x + d
  }
  return x
}

// ——————————————————————————— 主入口 ———————————————————————————

export function planRoutes(input: PlanRoutesInput): RouteModel {
  const { nodes, links, positions } = input
  const blocks = input.blocks ?? []
  const centered = input.positionsAreCenters ?? false
  const sizes = new Map<string, NodeSize>()
  for (const n of nodes) {
    sizes.set(n.id, input.sizes?.get(n.id) ?? estimateNodeSizeAligned(n.name, n.role, n.model))
  }
  const { rows, rects, rowOf } = buildRowModel(nodes, positions, sizes, centered)

  // 区块框先按面积比取舍：**画不出来的框不该成为走线障碍** —— 否则线会为了绕开一个
  // 用户根本看不见的框而绕远，等于把布局的缺陷转嫁到走线上。
  const framed = selectFramedBlocks(blocks, drawingBounds(rects.values()))
  const blockOf = new Map<string, string>()
  const blockRectOf = new Map<string, Rect>()
  for (const b of framed) {
    blockRectOf.set(b.headId, b.box)
    for (const id of b.nodeIds) blockOf.set(id, b.headId)
  }

  const bounds = (() => {
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    for (const r of rects.values()) {
      minX = Math.min(minX, r.x)
      maxX = Math.max(maxX, r.x + r.w)
    }
    for (const r of blockRectOf.values()) {
      minX = Math.min(minX, r.x)
      maxX = Math.max(maxX, r.x + r.w)
    }
    return Number.isFinite(minX) ? { min: minX - 40, max: maxX + 40 } : { min: -40, max: 400 }
  })()

  const routes = new Map<string, LinkRoute>()
  // 槽位表：优先复用调用方算好的（画布已有一份给 toFlowEdges 用），否则自算
  // （方位判据一律带 rowOf：连接点与走线分类必须同源，见 portSlots.endSideOf）
  const slotTable = input.slots ?? assignPortSlots(links, positions, { rowOf })

  /** 立即可用的链路：两端都在画布上（与 toFlowEdges 同口径） */
  const drawable = links.filter((l) => rects.has(l.from) && rects.has(l.to))
  // 每条链路独立的连接点（eNSP 式端口点）：同侧按对端方位排序后沿边框铺开。
  // 同上，优先复用外部结果（画布侧已算过一份）。
  const linkPorts = input.linkPorts ?? assignLinkPorts(drawable, positions, { rowOf })

  /**
   * 障碍空间索引（性能治理核心，见 ObstacleIndex 注释）。
   *
   * 旧实现里「每条链路 × 全部其它设备框」有两处：
   * ① 直线优先探测 ② 走廊选高。大图上这两处就是全部耗时的大头。
   * 现在统一走索引粗筛 + segHitsRect 精判 —— 结果逐位不变，只是不再白跑无关障碍。
   */
  const allRects = [...rects.entries()]
  const nodeObstacleIndex = new ObstacleIndex(allRects.map(([, r]) => r))
  /** 反查：矩形 → 所属节点 id（束选走廊高度时要排除「束内自己的设备」） */
  const rectOwner = new Map<Rect, string>(allRects.map(([id, r]) => [r, id] as const))

  // —— 1. 分类 + 成束分组 ——
  interface Task {
    link: TopologyLink
    a: Rect
    b: Rect
    rowA: number
    rowB: number
    dir: -1 | 0 | 1
    bundle: string
    /** 两端的端口点（在设备边框上；正交走线从这些点进出，不再都挤在边中点） */
    pA: RoutePoint
    pB: RoutePoint
    portTable: LinkPortTable | undefined
  }
  const tasks: Task[] = []
  for (const l of drawable) {
    const a = rects.get(l.from)!
    const b = rects.get(l.to)!
    const rowA = rowOf.get(l.from) ?? 0
    const rowB = rowOf.get(l.to) ?? 0
    const dir: -1 | 0 | 1 = rowB > rowA ? 1 : rowB < rowA ? -1 : 0
    // 成束键：同源 + 同方向 + 同目标行（相邻行的父子扇出正是要成束的形态）
    const bundle = dir === 0 ? `row:${rowA}:${l.id}` : `bundle:${l.from}:${dir}:${rowB}`
    const portTable = linkPorts.byLink.get(l.id)
    tasks.push({
      link: l,
      a,
      b,
      rowA,
      rowB,
      dir,
      bundle,
      pA: portTable ? portPointOf(a, portTable.src) : { x: a.x + a.w / 2, y: a.y + a.h / 2 },
      pB: portTable ? portPointOf(b, portTable.dst) : { x: b.x + b.w / 2, y: b.y + b.h / 2 },
      portTable
    })
  }

  // —— 2. 行间走廊：为每个**束**选一条干线高度 ——
  //
  // 为什么按「束」而不是按链路定高度：同束链路共享同一条水平干线（共干），
  // 高度若按链路各算各的，共干就散了。高度同时要满足两件事：
  // ① 同一走廊里的多个束彼此错开车道（否则两条树干共线重叠）；
  // ② 干线的水平段与两端竖直段都不穿设备框 —— 任意坐标下，走廊里可能正好有别的设备。
  const spineYOf = new Map<string, number>()
  {
    interface SpineGroup {
      id: string
      dir: 1 | -1
      gap: number
      axs: number[]
      bxs: number[]
      srcY: number[]
      dstY: number[]
      nodeIds: Set<string>
    }
    const groups = new Map<string, SpineGroup>()
    for (const t of tasks) {
      if (t.dir === 0 || Math.abs(t.rowB - t.rowA) !== 1) continue
      const g =
        groups.get(t.bundle) ??
        ({
          id: t.bundle,
          dir: t.dir,
          gap: Math.min(t.rowA, t.rowB),
          axs: [],
          bxs: [],
          srcY: [],
          dstY: [],
          nodeIds: new Set<string>()
        } as SpineGroup)
      g.axs.push(t.pA.x)
      g.bxs.push(t.pB.x)
      g.srcY.push(t.dir > 0 ? t.a.y + t.a.h : t.a.y)
      g.dstY.push(t.dir > 0 ? t.b.y : t.b.y + t.b.h)
      g.nodeIds.add(t.link.from)
      g.nodeIds.add(t.link.to)
      groups.set(t.bundle, g)
    }

    const byGap = new Map<number, Array<{ id: string; x1: number; x2: number }>>()
    for (const g of groups.values()) {
      const list = byGap.get(g.gap) ?? []
      list.push({ id: g.id, x1: Math.min(...g.axs, ...g.bxs), x2: Math.max(...g.axs, ...g.bxs) })
      byGap.set(g.gap, list)
    }
    const laneOf = new Map<string, number>()
    for (const list of byGap.values()) {
      for (const [id, lane] of allocateLanes(list)) laneOf.set(id, lane)
    }

    for (const g of groups.values()) {
      const midY = (Math.min(...g.srcY, ...g.dstY) + Math.max(...g.srcY, ...g.dstY)) / 2
      const lane = laneOf.get(g.id) ?? 0
      const base = midY + lane * LANE_H
      const x1 = Math.min(...g.axs, ...g.bxs)
      const x2 = Math.max(...g.axs, ...g.bxs)
      const tries: number[] = [base]
      for (let k = 1; k <= 8; k += 1) tries.push(base + k * LANE_H, base - k * LANE_H)
      /**
       * 障碍集用索引粗筛（性能治理）：只需**水平跨度与 x1..x2 有交集**的框 ——
       * 干线的水平段只跨越这一段 x。旧实现每条束都把**全部**设备框收进 obstacles
       * 并逐档全扫，是「束数 × 17 档 × 全图设备」的乘积（实测 300 台时 77ms）。
       *
       * 注意竖向 dropsFree 的判据：竖段在 ax/bx 处、y 区间 [sy,y]。只保留与
       * [x1,x2] 有交集的框**不会**丢掉任何真正相撞的项 —— 相撞意味着框的 x 区间
       * 覆盖了 ax/bx ∈ [x1,x2]，故必与 [x1,x2] 相交。结果逐位不变。
       */
      const ownRects = new Set<string>()
      for (const nid of g.nodeIds) ownRects.add(nid)
      const obstacles = nodeObstacleIndex
        .candidates(
          x1 - CLEAR,
          Math.min(base - 8 * LANE_H, ...g.srcY, ...g.dstY),
          x2 + CLEAR,
          Math.max(base + 8 * LANE_H, ...g.srcY, ...g.dstY)
        )
        .filter((o) => !ownRects.has(rectOwner.get(o) ?? '') && o.x < x2 + CLEAR && o.x + o.w > x1 - CLEAR)
      let chosen = Math.round(base)
      for (const raw of tries) {
        const y = Math.round(raw)
        const spineFree = !obstacles.some((o) => segHitsRect(x1, y, x2, y, o))
        const dropsFree =
          g.axs.every((ax, i) => {
            const sy = g.srcY[i] ?? y
            return !obstacles.some((o) => segHitsRect(ax, Math.min(sy, y), ax, Math.max(sy, y), o))
          }) &&
          g.bxs.every((bx, i) => {
            const dy = g.dstY[i] ?? y
            return !obstacles.some((o) => segHitsRect(bx, Math.min(y, dy), bx, Math.max(y, dy), o))
          })
        if (spineFree && dropsFree) {
          chosen = y
          break
        }
      }
      spineYOf.set(g.id, chosen)
    }
  }

  // —— 3. 同层链路的车道分配（按行，x 区间不重叠可复用同一条车道） ——
  const rowLane = new Map<string, number>()
  {
    const byRow = new Map<number, Array<{ id: string; x1: number; x2: number }>>()
    for (const t of tasks) {
      if (t.dir !== 0) continue
      const list = byRow.get(t.rowA) ?? []
      list.push({ id: t.link.id, x1: Math.min(t.a.x, t.b.x), x2: Math.max(t.a.x + t.a.w, t.b.x + t.b.w) })
      byRow.set(t.rowA, list)
    }
    for (const list of byRow.values()) {
      for (const [id, lane] of allocateLanes(list)) rowLane.set(id, lane)
    }
  }

  const channels: Channel[] = []

  // —— 4. 逐条链路生成路径 ——
  for (const t of tasks) {
    const id = t.link.id
    const points: RoutePoint[] = []
    let startAxis: RouteAxis = 'v'
    let endAxis: RouteAxis = 'v'
    let fallback = false
    let straight = false

    const axisOf = (side: Side8): 'v' | 'h' => axisOfPort(side, t.pB.x - t.pA.x, t.pB.y - t.pA.y)

    // —— 0. 直线优先（eNSP 观感）：源端口点 → 目标端口点一条直线段。
    // 只有**穿过别的设备框**才退回正交折线避让（用户拍板的取舍：直线天然不与别的线
    // 重叠、也没有横跨全图的长干线；区块框是背景高亮，直线穿过它可接受）。
    {
      // 用「源→目标」包围盒查索引，避开全量扫描（L×N → 只碰沿线附近的框）。
      // 精判仍交给 segHitsRect，故与旧实现结果逐位一致。
      const near = nodeObstacleIndex.candidates(
        Math.min(t.pA.x, t.pB.x),
        Math.min(t.pA.y, t.pB.y),
        Math.max(t.pA.x, t.pB.x),
        Math.max(t.pA.y, t.pB.y)
      )
      const nodeObstacles = near.filter(
        (r) => r !== t.a && r !== t.b && vOverlap(r, Math.min(t.pA.y, t.pB.y), Math.max(t.pA.y, t.pB.y))
      )
      // 注意判空写法：segmentViolations 返回**数组**，`!arr` 对空数组也是 false
      // （空数组是真值）—— 写成 `!segmentViolations(...)` 会让直线分支永远进不去。
      if (segmentViolations([t.pA, t.pB], nodeObstacles).length === 0) {
        points.push(t.pA, t.pB)
        straight = true
        if (t.portTable) {
          startAxis = axisOf(t.portTable.src.side)
          endAxis = axisOf(t.portTable.dst.side)
        }
      }
    }

    if (!straight) {
      // 该链路的障碍集：所有设备框 + **外部**区块框（自己所属区块的框必须穿过，否则进不去）。
      // 索引粗筛：正交绕行段全部落在「两端设备的并集包围盒 + 两侧外扩」内，
      // 之外的框不可能被碰到（相撞意味着框与某段 bbox 相交，而所有段都在这个 bbox 里）。
      const ownBlock = blockOf.get(t.link.from)
      const box = {
        x1: Math.min(t.a.x, t.b.x) - SEARCH_MAX,
        y1: Math.min(t.a.y, t.b.y) - SEARCH_MAX,
        x2: Math.max(t.a.x + t.a.w, t.b.x + t.b.w) + SEARCH_MAX,
        y2: Math.max(t.a.y + t.a.h, t.b.y + t.b.h) + SEARCH_MAX
      }
      const obstacles: Rect[] = [
        ...nodeObstacleIndex
          .candidates(box.x1, box.y1, box.x2, box.y2)
          .filter((r) => r !== t.a && r !== t.b),
        ...[...blockRectOf.entries()]
          .filter(([head]) => head !== ownBlock && head !== blockOf.get(t.link.to))
          .map(([, r]) => r)
      ]
      startAxis = t.portTable ? axisOf(t.portTable.src.side) : 'v'
      endAxis = t.portTable ? axisOf(t.portTable.dst.side) : 'v'

      if (t.dir !== 0 && Math.abs(t.rowB - t.rowA) === 1) {
        // —— 相邻行：树干 + 分叉（方案 B） ——
        const gapTop = Math.min(t.a.y, t.b.y)
        const gapBottom = Math.max(t.a.y + t.a.h, t.b.y + t.b.h)
        const midY = (gapTop + gapBottom) / 2
        // 干线高度由第 2 步按「束」统一选好（同束共享；并能避开走廊里的别的设备）
        const spineY = spineYOf.get(t.bundle) ?? Math.round(midY)
        points.push({ x: t.pA.x, y: t.pA.y }, { x: t.pA.x, y: spineY }, { x: t.pB.x, y: spineY }, { x: t.pB.x, y: t.pB.y })
      } else if (t.dir === 0) {
        // —— 同层：走行外的层间车道 ——
        const row = rows[t.rowA]
        const lane = rowLane.get(id) ?? 0
        const useAbove = t.rowA > 0
        const laneY = useAbove
          ? Math.round(row.top - LANE_GAP - lane * LANE_H)
          : Math.round(row.bottom + LANE_GAP + lane * LANE_H)
        const sign = t.pA.x <= t.pB.x ? 1 : -1
        const yFrom = t.pA.y
        const yTo = t.pB.y
        const jx1 = nearestFreeChannel(obstacles, channels, sign > 0 ? t.a.x + t.a.w + CLEAR : t.a.x - CLEAR, Math.min(yFrom, laneY), Math.max(yFrom, laneY), bounds)
        const jx2 = nearestFreeChannel(obstacles, channels, sign > 0 ? t.b.x - CLEAR : t.b.x + t.b.w + CLEAR, Math.min(laneY, yTo), Math.max(laneY, yTo), bounds)
        channels.push({ x: jx1, y1: Math.min(yFrom, laneY), y2: Math.max(yFrom, laneY) }, { x: jx2, y1: Math.min(yTo, laneY), y2: Math.max(yTo, laneY) })
        points.push(
          { x: t.pA.x, y: t.pA.y },
          { x: jx1, y: t.pA.y },
          { x: jx1, y: laneY },
          { x: jx2, y: laneY },
          { x: jx2, y: t.pB.y },
          { x: t.pB.x, y: t.pB.y }
        )
        startAxis = 'h'
        endAxis = 'h'
      } else {
        // —— 跨层：垂直通道穿过中间各行 + 目标行上方的接近车道 ——
        const chanX = nearestFreeChannel(obstacles, channels, t.pA.x, Math.min(t.pA.y, t.pB.y), Math.max(t.pA.y, t.pB.y), bounds)
        channels.push({ x: chanX, y1: Math.min(t.pA.y, t.pB.y), y2: Math.max(t.pA.y, t.pB.y) })
        points.push(
          { x: t.pA.x, y: t.pA.y },
          { x: chanX, y: t.pA.y },
          { x: chanX, y: t.pB.y },
          { x: t.pB.x, y: t.pB.y }
        )
      }

      // —— 5. 兜底：任何一段穿过了别的设备框/外部区块框 → 退回端口点直连（宁可直也不绕远） ——
      if (segmentViolations(points, obstacles).length > 0) {
        fallback = true
        straight = true
        points.length = 0
        points.push(t.pA, t.pB)
      }
    }

    routes.set(id, {
      linkId: id,
      from: t.link.from,
      to: t.link.to,
      points,
      startAxis,
      endAxis,
      ...labelAnchors(t, slotTable, t.portTable),
      bundle: t.bundle,
      fallback,
      straight
    })
  }

  // —— 6. 标注避让：端口点沿边铺开后，相邻设备的标注仍可能因「宽度 > 点距」相撞
  //（父→两台并排子的 to 标注、短链路两端标注互撞）。把相交的标注矩形沿 x 推开。
  declutterLabels(routes)

  return { routes, rows, blockOf, rects, framedBlocks: framed }
}

/**
 * 标注矩形去相交（B4 第六批）：**按水平带扫描**。
 *
 * 为什么不用两两推开：端口点聚拢到边中点附近后，同一排会挤 3~5 枚宽标注，
 * 两两推送要很多轮才收敛且可能来回震荡。改为：按 y 聚成「带」（相邻 y 差 < 带高
 * 视为同一排），带内按 x 排序后从左到右扫描，每个标注的左缘不得压过前一个的右缘
 * —— 一次扫描必然收敛，且只沿 x 平移、不动走线几何（不影响穿框/共线断言）。
 */
function declutterLabels(routes: Map<string, LinkRoute>): void {
  interface Box {
    route: LinkRoute
    end: 'from' | 'to'
    x: number
    y: number
    w: number
  }
  const boxes: Box[] = []
  for (const r of routes.values()) {
    if (r.fromW > 0) boxes.push({ route: r, end: 'from', x: r.fromPoint.x, y: r.fromPoint.y, w: r.fromW })
    if (r.toW > 0) boxes.push({ route: r, end: 'to', x: r.toPoint.x, y: r.toPoint.y, w: r.toW })
  }
  const apply = (b: Box, dx: number): void => {
    if (Math.abs(dx) < 0.5) return
    b.x += dx
    if (b.end === 'from') b.route.fromPoint = { ...b.route.fromPoint, x: b.route.fromPoint.x + dx }
    else b.route.toPoint = { ...b.route.toPoint, x: b.route.toPoint.x + dx }
  }
  // 按 y 聚带：标注高 18px，相邻 y 差 < 18 视为同一排
  const sortedY = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
  const LABEL_H = 18
  let band: Box[] = []
  const flush = (): void => {
    if (band.length === 0) return
    band.sort((a, b) => a.x - b.x)
    for (let i = 1; i < band.length; i += 1) {
      const prev = band[i - 1]!
      const cur = band[i]!
      const minCenterGap = (prev.w + cur.w) / 2 + 2
      if (cur.x - prev.x < minCenterGap) apply(cur, minCenterGap - (cur.x - prev.x))
    }
    band = []
  }
  for (const b of sortedY) {
    if (band.length === 0 || b.y - band[band.length - 1]!.y < LABEL_H) {
      band.push(b)
    } else {
      flush()
      band.push(b)
    }
  }
  flush()
}

/** 侧边的外法向（端口点在边框上，标注要沿法向推出去；角点用对角法向） */
const OUT_NORMAL: Record<Side8, RoutePoint> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  'top-left': { x: -0.707, y: -0.707 },
  'top-right': { x: 0.707, y: -0.707 },
  'bottom-left': { x: -0.707, y: 0.707 },
  'bottom-right': { x: 0.707, y: 0.707 }
}

/** 端口侧 → 折线首/末段方向；角点按连线的主导方向归（snap 会把端点拉到实测角点） */
function axisOfPort(side: Side8, dx: number, dy: number): 'v' | 'h' {
  if (side === 'left' || side === 'right') return 'h'
  if (side === 'top' || side === 'bottom') return 'v'
  return Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v'
}

/** 标注锚点：端口点 + 外法向偏移 + 槽位错开（与第一批的渲染口径一致），并给出标注估算宽度 */
function labelAnchors(
  t: { link: TopologyLink; a: Rect; b: Rect },
  slotTable: ReturnType<typeof assignPortSlots>,
  portTable: LinkPortTable | undefined
): { fromPoint: RoutePoint; toPoint: RoutePoint; fromW: number; toW: number } {
  const cx = (r: Rect): number => r.x + r.w / 2
  const cy = (r: Rect): number => r.y + r.h / 2
  const sideFrom = portTable?.src.side ?? sideOf({ x: cx(t.a), y: cy(t.a) }, { x: cx(t.b), y: cy(t.b) })
  const sideTo = portTable?.dst.side ?? sideOf({ x: cx(t.b), y: cy(t.b) }, { x: cx(t.a), y: cy(t.a) })
  const axisFrom = slotAxisOf(positionOfSide8(sideFrom))
  const axisTo = slotAxisOf(positionOfSide8(sideTo))
  const slots = slotTable.get(t.link.id)
  const ports = splitPortLabel(t.link.label)
  const widthOf = (name: string | undefined): number => (name ? chipWidthOf(shortIf(name)) : 0)

  // 端口在边框上 → 标注 = 端口点沿外法向推出 PORT_OUT；没有端口表的兜底回到「边中点外推」
  const baseOf = (rect: Rect, side: Side8, pct: number | undefined): RoutePoint => {
    const n = OUT_NORMAL[side]
    if (pct === undefined) {
      const center = { x: cx(rect), y: cy(rect) }
      const pp = side === 'left' || side === 'right'
        ? { x: side === 'right' ? rect.x + rect.w : rect.x, y: center.y }
        : { x: center.x, y: side === 'bottom' ? rect.y + rect.h : rect.y }
      return { x: pp.x + n.x * PORT_OUT, y: pp.y + n.y * PORT_OUT }
    }
    const pp = portPointOf(rect, { side, pct })
    return { x: pp.x + n.x * PORT_OUT, y: pp.y + n.y * PORT_OUT }
  }
  const spread = (info: { index: number; count: number; gap: number } | undefined): number => {
    if (!info || info.count < 2) return 0
    return (info.index - (info.count - 1) / 2) * info.gap
  }
  const baseFrom = baseOf(t.a, sideFrom, portTable?.src.pct)
  const baseTo = baseOf(t.b, sideTo, portTable?.dst.pct)
  const spFrom = spread(slots?.from?.[0])
  const spTo = spread(slots?.to?.[0])
  return {
    fromPoint: {
      x: baseFrom.x + (axisFrom === 'x' ? spFrom : 0),
      y: baseFrom.y + (axisFrom === 'y' ? spFrom : 0)
    },
    toPoint: {
      x: baseTo.x + (axisTo === 'x' ? spTo : 0),
      y: baseTo.y + (axisTo === 'y' ? spTo : 0)
    },
    fromW: widthOf(ports?.from?.[0]),
    toW: widthOf(ports?.to?.[0])
  }
}

// ——————————————————————————— 断言与度量 ———————————————————————————

/** 折线里穿过给定矩形的段（返回段的序号，便于定位） */
function segmentViolations(points: RoutePoint[], obstacles: Rect[]): number[] {
  const bad: number[] = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const p = points[i]!
    const q = points[i + 1]!
    if (obstacles.some((o) => segHitsRect(p.x, p.y, q.x, q.y, o))) bad.push(i)
  }
  return bad
}

export interface RouteInvariantReport {
  /** 不同束的连线出现共线重合（同束共干是设计意图，不算）；len = 重合长度 */
  overlaps: Array<{ a: string; b: string; at: string; len: number }>
  /** 同端点收口造成的重合（多条线汇入同一台设备的同一个连接点，必然重合，不算缺陷） */
  convergent: number
  /** 穿过别的设备框 */
  nodeHits: Array<{ linkId: string; nodeId: string }>
  /** 穿过外部区块框 */
  blockHits: Array<{ linkId: string; blockId: string }>
  /** 任意两条连线的交叉点个数（不违规，只用于「少了多少交叉」的量化） */
  crossings: number
  /** 标注矩形两两相交 */
  labelOverlaps: Array<{ a: string; b: string }>
}

/**
 * 「多条线汇聚到同一个连接点」造成的重合是**必然且无害**的：同一个连接点只有一个坐标，
 * 所有连到它的线都得在这里收口（eNSP 里也是这样）。因此重合只有超过这个长度才算缺陷 ——
 * 短于它的重合落在连接点附近，视觉上就是「线在这里汇合」。
 */
export const OVERLAP_TOLERANCE = 24

/**
 * 4 条验收断言（外加交叉数作为量化指标）：
 * ① 不同束的连线不得共线重合；② 不得穿过设备框；③ 标注矩形不得相交；④ 不得穿过外部区块框。
 */
export function checkRouteInvariants(
  model: RouteModel,
  options: { blocks?: TopologyBlock[] } = {}
): RouteInvariantReport {
  const overlaps: RouteInvariantReport['overlaps'] = []
  const nodeHits: RouteInvariantReport['nodeHits'] = []
  const blockHits: RouteInvariantReport['blockHits'] = []
  const labelOverlaps: RouteInvariantReport['labelOverlaps'] = []
  let crossings = 0
  let convergent = 0

  const list = [...model.routes.values()]
  const segsOf = (r: LinkRoute): Array<{ x1: number; y1: number; x2: number; y2: number }> =>
    r.points.slice(0, -1).map((p, i) => ({ x1: p.x, y1: p.y, x2: r.points[i + 1]!.x, y2: r.points[i + 1]!.y }))
  /**
   * 两条链路是否共用同一台设备：共用时**必然**在收口处重合（同一台设备的同一个连接点
   * 只有一个坐标，所有连到它的线都得在这里并线）—— 这是汇合，不是「两条线糊在一起」。
   */
  const shareNode = (a: LinkRoute, b: LinkRoute): boolean =>
    a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to

  // ② 穿设备框（端点自身除外：走线本来就贴着它们进出）
  for (const r of list) {
    for (const [nid, rect] of model.rects) {
      if (nid === r.from || nid === r.to) continue
      if (segsOf(r).some((s) => segHitsRect(s.x1, s.y1, s.x2, s.y2, rect))) {
        nodeHits.push({ linkId: r.linkId, nodeId: nid })
      }
    }
  }

  // ④ 穿**外部**区块框：自己所属的区块必须穿进去（否则够不到设备），不算违规。
  // **直线豁免**：直线是 eNSP 观感的最高优先级，区块框只是背景高亮不是物理隔断。
  const frameList = options.blocks ?? model.framedBlocks
  for (const r of list) {
    if (r.straight) continue
    const own = new Set([model.blockOf.get(r.from), model.blockOf.get(r.to)])
    for (const b of frameList) {
      if (own.has(b.headId)) continue
      if (segsOf(r).some((s) => segHitsRect(s.x1, s.y1, s.x2, s.y2, b.box))) {
        blockHits.push({ linkId: r.linkId, blockId: b.headId })
      }
    }
  }

  // ① 共线重合（跨束） + 交叉计数
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const ra = list[i]!
      const rb = list[j]!
      const sameBundle = ra.bundle === rb.bundle
      const shared = shareNode(ra, rb)
      const record = (at: string, len: number): void => {
        if (sameBundle) return
        if (shared) {
          convergent += 1
          return
        }
        overlaps.push({ a: ra.linkId, b: rb.linkId, at, len })
      }
      for (const sa of segsOf(ra)) {
        for (const sb of segsOf(rb)) {
          const aH = Math.abs(sa.y1 - sa.y2) < 0.5
          const bH = Math.abs(sb.y1 - sb.y2) < 0.5
          if (aH && bH) {
            if (Math.abs(sa.y1 - sb.y1) < 0.5) {
              const lo = Math.max(Math.min(sa.x1, sa.x2), Math.min(sb.x1, sb.x2))
              const hi = Math.min(Math.max(sa.x1, sa.x2), Math.max(sb.x1, sb.x2))
              if (hi - lo > 1) record(`y=${sa.y1}`, hi - lo)
            }
            continue
          }
          const aV = Math.abs(sa.x1 - sa.x2) < 0.5
          const bV = Math.abs(sb.x1 - sb.x2) < 0.5
          if (aV && bV) {
            if (Math.abs(sa.x1 - sb.x1) < 0.5) {
              const lo = Math.max(Math.min(sa.y1, sa.y2), Math.min(sb.y1, sb.y2))
              const hi = Math.min(Math.max(sa.y1, sa.y2), Math.max(sb.y1, sb.y2))
              if (hi - lo > 1) record(`x=${sa.x1}`, hi - lo)
            }
            continue
          }
          // 一横一竖 → 交叉（不违规）
          const h = aH ? sa : sb
          const v = aH ? sb : sa
          const hy = h.y1
          const vx = v.x1
          if (vx > Math.min(h.x1, h.x2) + 0.5 && vx < Math.max(h.x1, h.x2) - 0.5 && hy > Math.min(v.y1, v.y2) + 0.5 && hy < Math.max(v.y1, v.y2) - 0.5) {
            crossings += 1
          }
        }
      }
    }
  }

  // ③ 标注矩形相交（宽度按接口名估算；该端没有端口标注就不计入）
  const flat: Array<{ id: string; x: number; y: number; w: number; h: number }> = []
  for (const r of list) {
    const push = (id: string, p: RoutePoint, w: number): void => {
      if (w <= 0) return
      flat.push({ id, x: p.x - w / 2, y: p.y - 9, w, h: 18 })
    }
    push(`${r.linkId}:from`, r.fromPoint, r.fromW)
    push(`${r.linkId}:to`, r.toPoint, r.toW)
  }
  for (let i = 0; i < flat.length; i += 1) {
    for (let j = i + 1; j < flat.length; j += 1) {
      const a = flat[i]!
      const b = flat[j]!
      const hit = a.x < b.x + b.w - 1 && a.x + a.w - 1 > b.x && a.y < b.y + b.h - 1 && a.y + a.h - 1 > b.y
      if (hit) labelOverlaps.push({ a: a.id, b: b.id })
    }
  }

  return { overlaps, convergent, nodeHits, blockHits, crossings, labelOverlaps }
}

/**
 * 把「按估算坐标算出的折线」**贴合到实测连接点**上（渲染层用）。
 *
 * 为什么必须有这一步：路由内核跑在纯函数里，用的是按 CSS 参数估算的设备框尺寸，
 * 而 React Flow 传给连线的 `sourceX/sourceY` 是 DOM 实测的连接点坐标。两者差几像素时，
 * 折线首段会斜一小段（看起来像没接上）。这里把首/末段的另一端也拉到同一个坐标轴上，
 * 折线便仍然处处轴对齐。
 */
export function snapRouteToHandles(
  points: RoutePoint[],
  source: RoutePoint,
  target: RoutePoint,
  startAxis: RouteAxis,
  endAxis: RouteAxis
): RoutePoint[] {
  if (points.length < 2) return points
  const out = points.map((p) => ({ x: p.x, y: p.y }))
  // 两点直连（兜底）：首末段是同一段，不能再去「拉直另一端的轴」—— 否则会凭空多出一个折点
  if (out.length === 2) {
    out[0] = { x: source.x, y: source.y }
    out[1] = { x: target.x, y: target.y }
    return out
  }
  const second = out[1]!
  out[0] = { x: source.x, y: source.y }
  out[1] = startAxis === 'v' ? { x: source.x, y: second.y } : { x: second.x, y: source.y }
  const last = out.length - 1
  const beforeLast = out[last - 1]!
  out[last] = { x: target.x, y: target.y }
  out[last - 1] = endAxis === 'v' ? { x: target.x, y: beforeLast.y } : { x: beforeLast.x, y: target.y }
  return out
}

/** 折线 → SVG path（直角 + 圆角；首尾点由渲染层用实测连接点覆盖） */
export function routeToPath(points: RoutePoint[], radius = 6): string {
  const pts: RoutePoint[] = []
  for (const p of points) {
    const prev = pts[pts.length - 1]
    if (!prev || Math.abs(prev.x - p.x) > 0.01 || Math.abs(prev.y - p.y) > 0.01) pts.push(p)
  }
  if (pts.length < 2) return ''
  if (pts.length === 2) return `M${pts[0]!.x},${pts[0]!.y} L${pts[1]!.x},${pts[1]!.y}`
  let d = `M${pts[0]!.x},${pts[0]!.y}`
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1]!
    const cur = pts[i]!
    const next = pts[i + 1]!
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y)
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y)
    const r = Math.max(0, Math.min(radius, inLen / 2, outLen / 2))
    if (r < 0.5) {
      d += ` L${cur.x},${cur.y}`
      continue
    }
    const i1 = { x: cur.x - ((cur.x - prev.x) / inLen) * r, y: cur.y - ((cur.y - prev.y) / inLen) * r }
    const o1 = { x: cur.x + ((next.x - cur.x) / outLen) * r, y: cur.y + ((next.y - cur.y) / outLen) * r }
    d += ` L${i1.x},${i1.y} Q${cur.x},${cur.y} ${o1.x},${o1.y}`
  }
  const last = pts[pts.length - 1]!
  d += ` L${last.x},${last.y}`
  return d
}
