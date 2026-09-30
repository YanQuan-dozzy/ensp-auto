/**
 * 布局网格与区块基元（「源图保真」重构时从 autoLayout.ts 抽出）。
 *
 * 为什么单独一个文件：现在有**两个布局内核**——
 * - `autoLayout.ts` 的树形内核（`layoutTopologyTree`）：按连接关系分层，父居中于子树；
 * - `autoLayoutModule.ts` 的源图保真内核（`layoutTopologyBySource`）：**源坐标骨架**
 *   （整体等比放大 → 落格点 → 行内防重叠 → 独苗终端对齐父设备）。
 *
 * 两个内核都要「160px 格点、320px 层距、区块包围盒」这一套口径，但**互相不引用**
 * （避免 ESM 循环）；于是把共用件放这里，`autoLayout.ts` 继续 re-export 出去，
 * 既有调用点与 harness 导出清单都不用改。
 */
import type { TopologyNode, TopologyRole } from '@shared/types'
import { estimateNodeSizeAligned } from './nodeSize'

export interface NodePoint {
  x: number
  y: number
}

/**
 * 布局坐标 ↔ 画布坐标的换算：**布局坐标 = 设备框中心，画布坐标 = 设备框左上角**。
 *
 * ## 为什么要有这一层（用户口径，2026-09-29）
 *
 * 用户原话：**「现在的对齐网格错了，应该是网格的十字中心」** —— 背景方格的十字交点
 * 必须压在设备框的**正中心**（eNSP 的观感）。而 React Flow 的 `node.position` 是
 * 左上角，于是两套语义必须在**一个**地方换算，不能散落在各处各减一半。
 *
 * ## 三条不变式（改动前请先读完）
 *
 * 1. 布局输出的每个坐标都是 `LAYOUT_GRID` 的整数倍，且**语义是设备框中心**；
 * 2. 设备框尺寸必须是**偶数**（`estimateNodeSizeAligned` 保证）—— 否则「中心落格点」
 *    与「左上角落格点」不可能同时成立，二者只能取其一；
 * 3. 于是换算后的左上角仍在格点上 —— `alignToGrid`（把画布坐标取整到格点）、
 *    背景方格、走线内核的矩形全部自动对齐，无需各自再补偏移。
 *
 * 若把第 2 条去掉（用原始奇数尺寸），画布坐标会落在半格上；用户点一次「对齐到网格」
 * 又会把它挪到最近格点 —— 网格立刻歪半个格，就是这次报的现象。
 */
export function centerToTopLeft(pos: NodePoint, size: { w: number; h: number }): NodePoint {
  return { x: pos.x - size.w / 2, y: pos.y - size.h / 2 }
}

/** `centerToTopLeft` 的逆：画布坐标（左上角）→ 布局坐标（中心） */
export function topLeftToCenter(pos: NodePoint, size: { w: number; h: number }): NodePoint {
  return { x: pos.x + size.w / 2, y: pos.y + size.h / 2 }
}

/**
 * 节点 id → 尺寸（**偶数**口径，与布局同源）。布局内核、画布、走线内核都必须走它，
 * 否则「同一个设备在三处算出三种尺寸」，中心换算就对不齐。
 */
export function alignNodeSizes(nodes: TopologyNode[]): Map<string, { w: number; h: number }> {
  return new Map(nodes.map((n) => [n.id, estimateNodeSizeAligned(n.name, n.role, n.model)]))
}

/**
 * 把**画布坐标**（左上角）批量换算成**布局坐标**（中心）。
 *
 * 布局与走线全部按中心口径计算（`rectOfNode` 再用 `centerRect` 还原成矩形），
 * 而 store 里存的、用户拖出来的都是画布坐标 —— 交界处一律经过这里，避免各处手写 ±w/2。
 */
export function toCenterPositions(
  raw: Map<string, NodePoint>,
  sizes: Map<string, { w: number; h: number }>
): Map<string, NodePoint> {
  const out = new Map<string, NodePoint>()
  for (const [id, p] of raw) {
    const s = sizes.get(id)
    out.set(id, s ? topLeftToCenter(p, s) : { x: p.x, y: p.y })
  }
  return out
}

/** `toCenterPositions` 的逆：布局坐标（中心）→ 画布坐标（左上角），供 `toFlowNodes` 用 */
export function toTopLeftPositions(
  raw: Map<string, NodePoint>,
  sizes: Map<string, { w: number; h: number }>
): Map<string, NodePoint> {
  const out = new Map<string, NodePoint>()
  for (const [id, p] of raw) {
    const s = sizes.get(id)
    out.set(id, s ? centerToTopLeft(p, s) : { x: p.x, y: p.y })
  }
  return out
}

/** 区块（B4 第二批）：一个汇聚交换机及其子树 —— 分组框与走线避让都以它为单位 */
export interface TopologyBlock {
  /** 区块头（汇聚/接入交换机） */
  headId: string
  /** 区块成员（含区块头） */
  nodeIds: string[]
  /** 世界坐标包围盒（成员节点并集 + 内边距） */
  box: { x: number; y: number; w: number; h: number }
  /**
   * 分组框标题。源图保真内核按模块给语义名（外网 / 分校）或「×× 区」；
   * 树形内核不填 —— 渲染层缺省退回区块头的设备名。
   */
  title?: string
}

/** 布局模型：坐标 + 区块归属。坐标语义与 computeAutoLayout 完全一致 */
export interface LayoutModel {
  positions: Map<string, NodePoint>
  blocks: TopologyBlock[]
}

/** 布局内核选择（见 `inferLayoutMode`） */
export type LayoutMode = 'tree' | 'module'

export interface LayoutOptions {
  /** 同层设备水平间距 */
  nodeGapX?: number
  /** 层级间纵向垂直间距 */
  layerGapY?: number
  /** 孤立设备矩阵每行数量 */
  isolatedCols?: number
  /**
   * 布局内核。缺省（undefined）时按数据自动判定：
   * 带 eNSP 源坐标的工程走「源图保真」（module），纯手工画的走树形（tree）。
   */
  mode?: LayoutMode
  /**
   * eNSP 工程里的**原始坐标**（B4 第四批「优先按 eNSP 原始排布」）。
   *
   * 树形内核用它定**同层左右次序**（源里在左边的就排左边），缺坐标退回名称自然序；
   * 源图保真内核用它定**模块的展布轴与生长方向**（第 0 层 → 第 1 层在源图里往哪边长）。
   */
  sourcePos?: Map<string, { x: number; y: number }>
}

/** 从节点列表提取 eNSP 源坐标（只有工程导入的节点带 srcX/srcY；手动新建的没有） */
export function sourcePosOf(nodes: TopologyNode[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    if (typeof n.srcX === 'number' && typeof n.srcY === 'number') out.set(n.id, { x: n.srcX, y: n.srcY })
  }
  return out
}

/** 角色基础层级权重 */
export const ROLE_TIER: Record<TopologyRole, number> = {
  cloud: 0,
  router: 1,
  firewall: 1,
  switch: 2,
  wlan: 2,
  server: 3,
  pc: 3,
  unknown: 2
}

/**
 * 布局网格：一格 = 背景方格 = 「对齐到网格」的粒度 = 160px。
 * 所有布局输出的坐标都是它的整数倍。
 */
export const LAYOUT_GRID = 160

/** 父子（层间）中心距 = 2 格（320px，用户拍板：父子节点两格）；源图保真内核里就是行高 */
export const LAYER_GAP = LAYOUT_GRID * 2

/** 区块内边距：分组框要圈住设备框并留出一点呼吸空间 */
export const BLOCK_PAD = 14

/**
 * 名称的自然序（B4 第三批）：**数字按数值**、字母按字母、大小写与全半角不敏感。
 *
 * 为什么不直接用逐字符比较：那样 `Teaching10` 会排到 `Teaching2` 前面、`PC2` 会排到
 * `PC10` 后面，画布上就成了「3 在 4 右边」。而「数字小的在左、A 在 B 左」是所有人
 * 对图纸的默认期待（用户原话：最低规则就是按命名排）。`Intl.Collator{numeric:true}`
 * 一次解决：中文按拼音、数字段按数值。
 */
const NAME_COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

export function naturalCompare(a: string, b: string): number {
  return NAME_COLLATOR.compare(a, b)
}

/**
 * 由成员节点的坐标并集算区块包围盒。
 *
 * 单独导出是因为**归属与包围盒的生命周期不同**：区块成员只由拓扑结构（连线）决定，
 * 而包围盒必须跟着当前坐标走 —— 用户在画布上拖过设备之后，框得跟着设备移动，
 * 否则框和里面的设备会错位。
 *
 * `title` **原样带过去**：调用方（画布）只拿 `headId`/`nodeIds` 重算包围盒，
 * 一旦这里丢掉标题，源图保真内核给模块起的语义名（外网 / 分校）就没了 ——
 * 渲染层会静默退回设备名，看着像「标题功能没做」。
 */
export function computeBlockBoxes(
  raw: Array<{ headId: string; nodeIds: string[]; title?: string }>,
  nodeMap: Map<string, TopologyNode>,
  positions: Map<string, NodePoint>
): TopologyBlock[] {
  const out: TopologyBlock[] = []
  for (const b of raw) {
    let x1 = Number.POSITIVE_INFINITY
    let y1 = Number.POSITIVE_INFINITY
    let x2 = Number.NEGATIVE_INFINITY
    let y2 = Number.NEGATIVE_INFINITY
    for (const id of b.nodeIds) {
      const p = positions.get(id)
      if (!p) continue
      const n = nodeMap.get(id)
      // 坐标是**设备框中心** → 还原成外框再并集（尺寸走偶数口径，与布局/走线同源）
      const size = estimateNodeSizeAligned(n?.name ?? id, n?.role ?? 'unknown', n?.model)
      x1 = Math.min(x1, p.x - size.w / 2)
      y1 = Math.min(y1, p.y - size.h / 2)
      x2 = Math.max(x2, p.x + size.w / 2)
      y2 = Math.max(y2, p.y + size.h / 2)
    }
    if (!Number.isFinite(x1)) continue
    out.push({
      headId: b.headId,
      nodeIds: [...b.nodeIds],
      box: {
        x: x1 - BLOCK_PAD,
        y: y1 - BLOCK_PAD,
        w: x2 - x1 + BLOCK_PAD * 2,
        h: y2 - y1 + BLOCK_PAD * 2
      },
      ...(b.title ? { title: b.title } : {})
    })
  }
  return out
}
