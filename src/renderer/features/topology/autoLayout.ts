import type { TopologyLink, TopologyNode, TopologyRole } from '@shared/types'
import {
  LAYER_GAP,
  LAYOUT_GRID,
  ROLE_TIER,
  computeBlockBoxes,
  naturalCompare,
  sourcePosOf
} from './layoutGrid'
import type { LayoutMode, LayoutModel, LayoutOptions, NodePoint } from './layoutGrid'
import { layoutTopologyBySource } from './autoLayoutModule'

/**
 * 共用件（网格常量 / 区块基元 / 源坐标 / 名称自然序）已抽到 `layoutGrid.ts` —— 因为
 * 现在有两个布局内核（本文件的树形内核 + `autoLayoutModule.ts` 的源图保真内核）都要用。
 * 这里**原样 re-export**，既有调用点（TopologyCanvas / TopoRender / topoRouting /
 * dataActions / tests harness entry）的导入路径一个字都不用改。
 */
export {
  BLOCK_PAD,
  LAYER_GAP,
  LAYOUT_GRID,
  ROLE_TIER,
  computeBlockBoxes,
  naturalCompare,
  sourcePosOf
} from './layoutGrid'
export type { LayoutMode, LayoutModel, LayoutOptions, NodePoint, TopologyBlock } from './layoutGrid'

/**
 * 同层相邻设备的**中心距下限**（格）—— 3 格 = 480px（树形内核用）。
 *
 * 下限由几何决定：设备框最宽可达 ≈ 150px，框两侧还要摆接口标注（锚在框外 32px、
 * 自身半宽 ≈ 26px，两侧合计 ≈ 116px）→ 中心距至少要 ≈ 266px；1 格（160px）必然重叠
 * （用户报的「同层设备挤成一团、文字重叠」）。这是**下限**：实际间距由子树宽度算出来，
 * 能贴多近就多近，但不小于它。
 *
 * 注意：源图保真内核（autoLayoutModule.ts）**不用这个下限** —— 它按「同行相邻两台
 * 都是终端 → 1 格，含网络设备 → 2 格」走（用户拍板，见 pitchCells）。
 */
const MEMBER_PITCH = 3

/** 同层设备的横向中心距（骨干链、对等下挂、孤立矩阵行内都用它）—— 与主树同节拍 */
const PEER_GAP_X = LAYOUT_GRID * MEMBER_PITCH
const DEFAULT_LAYER_GAP_Y = LAYER_GAP
const DEFAULT_ISOLATED_COLS = 4

/**
 * 「外部网 / 公网」这类旁挂分支的关键词：命中则这一支整棵子树**横排**（细节见
 * layoutComponentTidy 第 4.5 步）。命名习惯来自 eNSP 工程（外部网汇聚 / 公网互联网云 …）。
 * 只能用名字判：这类分支与楼宇分支结构完全同形（深 3 层、每层 ≤ 2 台），结构上区分不开。
 */
const WAN_BRANCH_RE = /外部网|外网|公网|互联网|运营商|wan|internet/i

/** 按节点名排序的比较器（取不到名字时退回 id，保证顺序稳定） */
function byName(nodeMap: Map<string, TopologyNode>): (a: string, b: string) => number {
  return (a, b) => naturalCompare(nodeMap.get(a)?.name ?? a, nodeMap.get(b)?.name ?? b)
}

/**
 * 同级次序比较器：**源坐标（eNSP 原始摆放）优先，名称为辅**。
 *
 * `axis` 指「同级之间铺开的那根轴」：自上而下的金字塔里同级是横向铺开的 → 比源 x；
 * 横向思维导图里同一列是纵向铺开的 → 比源 y。源坐标缺失（手动新建 / 工程未写坐标）
 * 时一路退到名称自然序，保证任何数据都有确定的顺序。
 */
function makeOrderCmp(
  nodeMap: Map<string, TopologyNode>,
  sourcePos: Map<string, { x: number; y: number }> | undefined,
  axis: 'x' | 'y'
): (a: string, b: string) => number {
  const nameCmp = byName(nodeMap)
  return (a, b) => {
    const pa = sourcePos?.get(a)
    const pb = sourcePos?.get(b)
    if (pa && pb) {
      const va = axis === 'x' ? pa.x : pa.y
      const vb = axis === 'x' ? pb.x : pb.y
      if (va !== vb) return va - vb
    }
    return nameCmp(a, b)
  }
}

/**
 * 布局入口（两个内核的总闸）：按数据自动选内核，或由 `options.mode` 强制指定。
 *
 * 为什么要有「自动」这一层：源图保真内核吃的是 eNSP 源坐标（srcX/srcY），拿不到坐标时
 * 它会退化成「所有设备挤成一行」—— 对手工新建的拓扑是灾难。而手工拓扑在树形内核下
 * 本来就是对的。于是：
 * - 带源坐标（**≥2 台且过半**）→ 源图保真（module）：保住 eNSP 原图的骨架（等比放大 + 防重叠）；
 * - 没有源坐标 → 树形（tree）：按连接关系分层 + 父居中于子树（旧行为，一个字没改）。
 * 判定阈值取「过半」是保守的：混合数据（一半手工一半导入）宁可走树形，也不排出一行糊。
 */
export function inferLayoutMode(nodes: TopologyNode[], options: LayoutOptions = {}): LayoutMode {
  if (options.mode) return options.mode
  const src = options.sourcePos ?? sourcePosOf(nodes)
  return src.size >= 2 && src.size * 2 >= nodes.length ? 'module' : 'tree'
}

/**
 * 布局入口：`mode: 'module'`（缺省自动判定为它时）走源图保真内核，其余走树形内核。
 * 坐标语义、区块归属、网格粒度两个内核完全一致 —— 上层（画布 / 导入后自动重排 /
 * 走线）不需要知道用的是哪一个。
 */
export function layoutTopology(
  nodes: TopologyNode[],
  links: TopologyLink[],
  options: LayoutOptions = {}
): LayoutModel {
  if (inferLayoutMode(nodes, options) === 'module') return layoutTopologyBySource(nodes, links, options)
  return layoutTopologyTree(nodes, links, options)
}

/**
 * 分区块智能自适应布局引擎（Block-Based Hierarchical Layout）—— **树形内核**：
 *
 * 核心设计原则（符合网络工程真实规范）：
 * 1. 核心骨干置顶：出口云、路由器、核心交换机（Core）居于顶层居中展开。
 * 2. 交换机分区块（Block）：每个汇聚/接入交换机分支独立划分为一个「区块」，各区块水平左右并排。
 * 3. 区块内部向下延伸：
 *    - 汇聚交换机在区块顶部；
 *    - 二层接入交换机垂直挂在汇聚下方；
 *    - 终端（PC、Server）垂直挂在对应的二层接入交换机下方，左右微调对齐。
 * 4. 杜绝全网所有交换机被压扁在单一行、所有终端在另一行的拉长现象。
 *
 * 按连接关系分层，**不看 eNSP 源坐标的位置**（源坐标只用来定同级左右次序）。
 * 对「所有路由器互连成一张网」的综合拓扑，它会把这十几台路由器全判成第 0 层根节点、
 * 一字排开 → 画布被撑到 8000px 宽。那类图请走源图保真内核（autoLayoutModule.ts）。
 */
export function layoutTopologyTree(
  nodes: TopologyNode[],
  links: TopologyLink[],
  options: LayoutOptions = {}
): LayoutModel {
  const result = new Map<string, NodePoint>()
  if (nodes.length === 0) return { positions: result, blocks: [] }

  const layerGapY = options.layerGapY ?? DEFAULT_LAYER_GAP_Y
  const isolatedCols = options.isolatedCols ?? DEFAULT_ISOLATED_COLS

  const nodeMap = new Map<string, TopologyNode>(nodes.map((n) => [n.id, n]))
  /**
   * 同一层内设备的左右顺序：**eNSP 源坐标优先**（源里在左边的排左边），
   * 拿不到源坐标才退回名称自然序（3 在 4 左、A 在 B 左、PC2 在 PC10 左）。
   */
  const orderCmp = makeOrderCmp(nodeMap, options.sourcePos, 'x')

  // 1. 构建邻接图
  const adj = new Map<string, Set<string>>()
  for (const n of nodes) adj.set(n.id, new Set())
  for (const l of links) {
    if (nodeMap.has(l.from) && nodeMap.has(l.to) && l.from !== l.to) {
      adj.get(l.from)?.add(l.to)
      adj.get(l.to)?.add(l.from)
    }
  }

  // 2. 划分连通子图与孤立节点
  const visited = new Set<string>()
  const components: string[][] = []
  const isolatedNodes: string[] = []

  for (const n of nodes) {
    if (visited.has(n.id)) continue
    const neighbors = adj.get(n.id)
    if (!neighbors || neighbors.size === 0) {
      isolatedNodes.push(n.id)
      visited.add(n.id)
      continue
    }

    const comp: string[] = []
    const queue = [n.id]
    visited.add(n.id)
    while (queue.length > 0) {
      const cur = queue.shift()!
      comp.push(cur)
      for (const nb of adj.get(cur) ?? []) {
        if (!visited.has(nb)) {
          visited.add(nb)
          queue.push(nb)
        }
      }
    }
    components.push(comp)
  }

  // 优先排布设备数最多的主网络
  components.sort((a, b) => b.length - a.length)

  // 3. 对每个连通分量进行「分区块」排布计算
  interface SubgraphBox {
    positions: Map<string, NodePoint>
    width: number
    height: number
    /** 该分量内的区块（只有区块头 + 成员，包围盒在全局平移后统一算） */
    blocks: Array<{ headId: string; nodeIds: string[] }>
  }

  const subgraphs: SubgraphBox[] = components.map((comp) =>
    layoutComponentTidy(comp, adj, nodeMap, orderCmp)
  )

  // 4. 分量摆放（B4 第四批）：
  //    - **主分量**（设备最多那个）走金字塔树形，摆在左上角；
  //    - **副分量**走**横向思维导图**（根在最左、层级向右展开），并叠在上一块**下方** ——
  //      金字塔本身已经很宽，副区域再往右就基本找不到了。
  let cursorY = 0
  const compGapY = LAYOUT_GRID
  const orderCmpY = makeOrderCmp(nodeMap, options.sourcePos, 'y')
  const rawBlocks: Array<{ headId: string; nodeIds: string[] }> = []

  subgraphs.forEach((sub, idx) => {
    if (idx === 0) {
      for (const [id, pt] of sub.positions) result.set(id, { x: pt.x, y: pt.y })
      rawBlocks.push(...sub.blocks)
      cursorY = sub.height
      return
    }
    const horiz = layoutComponentHorizontal(components[idx] ?? [], adj, orderCmpY)
    const baseY = cursorY + compGapY
    for (const [id, pt] of horiz.positions) result.set(id, { x: pt.x, y: pt.y + baseY })
    cursorY = baseY + horiz.height
    // 副区域不画分组框（横向展开本身已经是一块独立区域，再套框只会更花）
  })

  // 5. 孤立设备以整齐的 2D 矩阵收拢在网络底部
  if (isolatedNodes.length > 0) {
    isolatedNodes.sort((a, b) => {
      const ta = ROLE_TIER[nodeMap.get(a)?.role ?? 'unknown']
      const tb = ROLE_TIER[nodeMap.get(b)?.role ?? 'unknown']
      if (ta !== tb) return ta - tb
      return orderCmp(a, b)
    })

    const cols = Math.min(isolatedCols, Math.max(2, Math.ceil(Math.sqrt(isolatedNodes.length))))
    const isoGapX = PEER_GAP_X
    const isoGapY = LAYOUT_GRID
    const startY = cursorY + layerGapY

    isolatedNodes.forEach((id, idx) => {
      const col = idx % cols
      const row = Math.floor(idx / cols)
      result.set(id, {
        x: col * isoGapX,
        y: startY + row * isoGapY
      })
    })
  }

  // 6. 全局坐标平移到正坐标空间（预留画布边距）
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const p of result.values()) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
  }

  // 平移量取整到格点 —— 布局坐标已按 LAYOUT_GRID 铺放，平移后必须仍落在格点上
  //（否则与背景方格、「对齐到网格」全部错位半个格）
  const padX = LAYOUT_GRID
  const padY = LAYOUT_GRID
  const shiftX = Number.isFinite(minX) ? Math.round((padX - minX) / LAYOUT_GRID) * LAYOUT_GRID : 0
  const shiftY = Number.isFinite(minY) ? Math.round((padY - minY) / LAYOUT_GRID) * LAYOUT_GRID : 0

  for (const p of result.values()) {
    p.x = Math.round(p.x + shiftX)
    p.y = Math.round(p.y + shiftY)
  }

  return { positions: result, blocks: computeBlockBoxes(rawBlocks, nodeMap, result) }
}

/**
 * 兼容出口：坐标语义与历史完全一致。
 * 布局的额外产物（区块归属 + 包围盒）走 layoutTopology —— 这样既有调用点与
 * 黄金用例（逐节点坐标冻结）都不受影响。
 */
export function computeAutoLayout(
  nodes: TopologyNode[],
  links: TopologyLink[],
  options: LayoutOptions = {}
): Map<string, NodePoint> {
  return layoutTopology(nodes, links, options).positions
}

/**
 * 横向思维导图排布（B4 第四批）—— 给**副区域**用。
 *
 * 与主分量的金字塔相反：根在最左，层级沿 x 向右展开，同一列内的设备沿 y 纵向铺开
 * （像一个向右倒下来的金字塔）。副区域通常就是「一台入口设备 + 下挂几台」的小网络，
 * 横过来排既不占宽度，也能和主金字塔一眼区分开。
 *
 * 同一列内的纵向次序仍走「源坐标优先、名称为辅」；根取度数最大者（并列时按名称）。
 */
function layoutComponentHorizontal(
  compNodeIds: string[],
  adj: Map<string, Set<string>>,
  orderCmpY: (a: string, b: string) => number
): { positions: Map<string, NodePoint>; width: number; height: number } {
  const positions = new Map<string, NodePoint>()
  if (compNodeIds.length === 0) return { positions, width: 160, height: 60 }

  const idSet = new Set(compNodeIds)
  const root = [...compNodeIds].sort(
    (a, b) => (adj.get(b)?.size ?? 0) - (adj.get(a)?.size ?? 0) || orderCmpY(a, b)
  )[0]!
  const level = new Map<string, number>([[root, 0]])
  const layers: string[][] = [[root]]
  const queue = [root]
  while (queue.length > 0) {
    const cur = queue.shift()!
    const col = level.get(cur) ?? 0
    const kids = [...(adj.get(cur) ?? [])]
      .filter((nb) => idSet.has(nb) && !level.has(nb))
      .sort(orderCmpY)
    for (const nb of kids) {
      level.set(nb, col + 1)
      const bucket = layers[col + 1] ?? []
      bucket.push(nb)
      layers[col + 1] = bucket
      queue.push(nb)
    }
  }

  /** 列 = 父子（2 格），行 = 同层（≥ 3 格）—— 与主树同一套规则，只是把两个轴对调 */
  const COL_GAP = LAYER_GAP
  const ROW_GAP = LAYOUT_GRID * MEMBER_PITCH
  layers.forEach((ids, col) => {
    ids.forEach((id, i) => {
      // 行方向取整到格点：偶数台时居中会落在半格上，吸附回整格（否则会破坏 160 格点一致性）
      const raw = (i - (ids.length - 1) / 2) * ROW_GAP
      positions.set(id, { x: col * COL_GAP, y: Math.round(raw / LAYOUT_GRID) * LAYOUT_GRID })
    })
  })

  // 归一到 0 起点的局部坐标（与竖向布局同口径，外层还会做一次全局平移）
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  for (const p of positions.values()) {
    p.x -= minX
    p.y -= minY
  }
  return {
    positions,
    width: Math.max(160, maxX - minX),
    height: Math.max(60, maxY - minY)
  }
}

/**
 * 子树居中树形布局（B4 第六批「像 eNSP 一样」）：
 *
 * 与旧「层行均铺」的根本区别：**每台父设备悬在自己子树的正上方**（父 x = 子树质心），
 * 兄弟子树左右并排互不重叠，层内严格同高 —— Core 正好悬在它下挂楼宇的中间，
 * 不再出现「父在右侧、子甩到最左」的横跨斜线。
 *
 * 结构规则（用户拍板）：
 * - **同层互联合并成簇**：Core1↔Core2 这类同层互联合并为一个布局簇（并查集），两台
 *   并排悬在共同子设备上方，互连是一条短水平线，整体左右对称；双归属设备（同时接
 *   两台核心）天然属于这个簇，到两台核心的冗余线对称展开。
 * - **坐标全部落在格点上**：x = 格 × LAYOUT_GRID（一格 = 背景方格），y = 层 ×
 *   LAYER_GAP —— 与背景网格、对齐按钮同一套粒度。
 * - **水平定位 = 按子树宽度自适应**（第 5 步）：每棵子树只占它真正需要的宽度（轮廓打包），
 *   同层相邻设备的**最小中心距按角色给**（PC 1 格 / 服务器 2 格 / 其余 3 格）；
 *   **每个父设备各自居中于它名下那段子树的中点**（同层互联的多台按成员数均分子簇）；
 *   **父子两代之间 = LAYER_GAP（2 格 = 320px）**。
 * - **「外部网」旁挂分支横排**（第 4.5 步）：名字命中 WAN_BRANCH_RE 的整棵子树转置
 *   （深度 → 向左、格位 → 向下），摆在主树左侧顶部带，不占纵向层数。
 * - **兄弟次序 = 源坐标优先**（makeOrderCmp），名称自然序兜底。
 * - 分组框：splitLevel 上的每个簇仍是一个区块（成员 = 树后代）；横排的外部网分支不套框。
 */
function layoutComponentTidy(
  compNodeIds: string[],
  adj: Map<string, Set<string>>,
  nodeMap: Map<string, TopologyNode>,
  orderCmp: (a: string, b: string) => number,
  /**
   * 是否允许摘出「外部网」分支做横排（第 4.5 步）。
   * 递归排外部网那棵子树时必须置 false —— 那一支的设备名本身就叫「外部网接入1/2」，
   * 再命中一次就会把子树又转置一遍，排出乱码般的图。
   */
  allowWanBranch = true
): {
  positions: Map<string, NodePoint>
  width: number
  height: number
  blocks: Array<{ headId: string; nodeIds: string[] }>
} {
  const compSet = new Set(compNodeIds)

  // —— 1. 根节点识别（与旧口径一致：路由器/云优先，其次名字带 core 的交换机，最后度数最大者）——
  let roots: string[] = []
  for (const id of compNodeIds) {
    const role = nodeMap.get(id)?.role ?? 'unknown'
    if (role === 'router' || role === 'firewall' || role === 'cloud') roots.push(id)
  }
  if (roots.length === 0) {
    const coreCandidates: string[] = []
    let maxDeg = -1
    for (const id of compNodeIds) {
      const name = (nodeMap.get(id)?.name ?? '').toLowerCase()
      if (name.includes('core') || name.includes('核心') || name.includes('spine')) coreCandidates.push(id)
      const deg = adj.get(id)?.size ?? 0
      if (deg > maxDeg) maxDeg = deg
    }
    roots = coreCandidates.length > 0 ? coreCandidates : compNodeIds.filter((id) => (adj.get(id)?.size ?? 0) === maxDeg)
  }
  roots = [...roots].sort(orderCmp)

  // —— 2. 多源 BFS 定层（与旧口径一致；根互联保持在第 0 层）——
  const levelOf = new Map<string, number>()
  const parentOf = new Map<string, string>()
  for (const r of roots) levelOf.set(r, 0)
  const queue = [...roots]
  while (queue.length > 0) {
    const cur = queue.shift()!
    const curL = levelOf.get(cur)!
    for (const nb of adj.get(cur) ?? []) {
      if (!compSet.has(nb)) continue
      if (roots.includes(nb) && levelOf.get(nb) !== 0) {
        levelOf.set(nb, 0)
        continue
      }
      if (!levelOf.has(nb)) {
        levelOf.set(nb, curL + 1)
        parentOf.set(nb, cur)
        queue.push(nb)
      }
    }
  }

  const maxLevel = Math.max(...levelOf.values())
  if (maxLevel === 0) {
    return { ...layoutPeerNetwork(compNodeIds, adj, LAYER_GAP, orderCmp), blocks: [] }
  }

  // —— 3. 同层互联合并成簇（并查集，簇代表取 orderCmp 最小者保证确定性）——
  const clusterOf = new Map<string, string>()
  for (const id of compNodeIds) clusterOf.set(id, id)
  const find = (x: string): string => {
    let r = x
    while (clusterOf.get(r) !== r) r = clusterOf.get(r)!
    clusterOf.set(x, r)
    return r
  }
  for (const id of compNodeIds) {
    for (const nb of adj.get(id) ?? []) {
      if (!compSet.has(nb)) continue
      if ((levelOf.get(id) ?? 0) !== (levelOf.get(nb) ?? 0)) continue
      const ra = find(id)
      const rb = find(nb)
      if (ra === rb) continue
      const keep = orderCmp(ra, rb) <= 0 ? ra : rb
      const drop = keep === ra ? rb : ra
      clusterOf.set(drop, keep)
    }
  }

  // —— 4. 簇树：簇 = 同层互联的节点集合；树父 = BFS 首达父所在的簇（双归属的其余连线是冗余直线）——
  interface ClusterNode {
    id: string
    members: string[]
    level: number
    parent: string | null
    children: string[]
  }
  const clusters = new Map<string, ClusterNode>()
  for (const id of compNodeIds) {
    const rep = find(id)
    let c = clusters.get(rep)
    if (!c) {
      c = {
        id: rep,
        members: [],
        level: levelOf.get(rep) ?? 0,
        parent: null,
        children: []
      }
      clusters.set(rep, c)
    }
    c.members.push(id)
  }
  for (const c of clusters.values()) c.members.sort(orderCmp)
  for (const c of clusters.values()) {
    if (c.level === 0) continue // 根簇没有父
    for (const mid of c.members) {
      const p = parentOf.get(mid)
      if (p === undefined) continue
      const prep = find(p)
      if (prep === c.id) continue
      c.parent = prep
      break // 取第一个成员的 BFS 父 —— 确定性；双归属的第二个父走冗余直线
    }
  }
  for (const c of clusters.values()) {
    if (c.parent !== null) clusters.get(c.parent)?.children.push(c.id)
  }
  for (const c of clusters.values()) {
    c.children.sort((a, b) => orderCmp(clusters.get(a)!.members[0]!, clusters.get(b)!.members[0]!))
  }
  const rootClusters = [...clusters.values()]
    .filter((c) => c.parent === null)
    .sort((a, b) => orderCmp(a.members[0]!, b.members[0]!))

  // —— 4.5 「外部网 / 公网」旁挂分支横排（用户拍板：外部网横着）——
  //
  // 识别：**根簇的直接子簇**里，头节点名命中 WAN_BRANCH_RE 的那一支（多支时取排序最前者）。
  // 处理：把这一支整棵子树从纵向树里摘掉，单独排布后**转置**（深度 → 向左、格位 → 向下），
  // 摆在主树左侧的顶部带。于是它不再占用三层纵向高度，整条外部网链在顶部横向铺开
  // —— eNSP 与手绘图纸里公网侧本来就是这么画的。
  // 判据只能是名字：这类分支与楼宇分支**结构完全同形**（深 3 层、每层 ≤ 2 台），
  // 靠结构区分不开。
  let wanClusterId: string | null = null
  let wanHeadId = ''
  for (const rc of allowWanBranch ? rootClusters : []) {
    for (const ch of rc.children) {
      const head = clusters.get(ch)?.members[0]
      if (head && WAN_BRANCH_RE.test(nodeMap.get(head)?.name ?? '')) {
        wanClusterId = ch
        wanHeadId = head
        break
      }
    }
    if (wanClusterId) break
  }
  const wanIds = new Set<string>()
  if (wanClusterId) {
    const collect = (id: string): void => {
      const c = clusters.get(id)
      if (!c) return
      for (const m of c.members) wanIds.add(m)
      for (const ch of c.children) collect(ch)
    }
    collect(wanClusterId)
    const parentId = clusters.get(wanClusterId)!.parent
    if (parentId) {
      const p = clusters.get(parentId)!
      p.children = p.children.filter((x) => x !== wanClusterId)
    }
  }

  // —— 5. 水平定位：轮廓打包 + **每个父设备各自居中于「它名下的子树」** ——
  //
  // 三条用户拍板的规则：
  //   1) 同层相邻设备的**最小中心距按角色**给：终端最紧（PC 1 格 = 160px、服务器 2 格 = 320px），
  //      交换机 / 路由器 / 云 3 格（480px）—— 用户原话「最后一层的终端不用三格隔开」；
  //   2) **每个父设备各自居中于它名下的子设备中点**：同层互联的双核不再「成对居中于整体中点」，
  //      而是 Core1 居中于它管的楼宇、Core2 居中于它管的那几栋 —— 子簇按成员数**均分成连续段**，
  //      每个成员认领一段并居中于该段首末子簇的中点；
  //   3) 坐标全部落在 LAYOUT_GRID（160px）格点上 —— 为此做**奇偶修正**：中点若落在半格，
  //      就把该段最右的子簇再右推 1 格（只加宽间距，不破最小间距）。
  interface ProfileEdge {
    cell: number
    role: TopologyRole
  }
  interface Packed {
    /** 子树内每台设备相对本簇原点的格位 + 相对层偏移 */
    cells: Array<{ id: string; cell: number; level: number; role: TopologyRole }>
    /** 每个相对深度层的最左/最右格（含角色，用于角色相关的最小间距）—— 打包用的轮廓 */
    left: ProfileEdge[]
    right: ProfileEdge[]
    /** 本簇成员的横向中点（相对本簇原点），供父设备居中 */
    center: number
  }
  const roleOf = (id: string): TopologyRole => nodeMap.get(id)?.role ?? 'unknown'
  /** 同层相邻设备的最小中心距（格）：终端更紧（PC 一格、服务器两格） */
  const minPitchOf = (role: TopologyRole): number =>
    role === 'pc' ? 1 : role === 'server' ? 2 : MEMBER_PITCH
  const gapBetween = (a: TopologyRole, b: TopologyRole): number =>
    Math.max(minPitchOf(a), minPitchOf(b))

  /** 从左到右紧邻排开（每个共同深度 ≥ 角色相关最小间距），返回各自位移 */
  const packShifts = (items: Packed[]): number[] => {
    const shifts: number[] = []
    const right: ProfileEdge[] = []
    items.forEach((item, idx) => {
      let need = 0
      if (idx > 0) {
        const depths = Math.min(right.length, item.left.length)
        for (let d = 0; d < depths; d++) {
          const a = right[d]!
          const b = item.left[d]!
          need = Math.max(need, a.cell + gapBetween(a.role, b.role) - b.cell)
        }
      }
      // 向上取整到整格：只会更松，不会破最小间距
      const shift = Math.ceil(need)
      shifts.push(shift)
      for (let d = 0; d < item.right.length; d++) {
        const r = { cell: item.right[d]!.cell + shift, role: item.right[d]!.role }
        if (!right[d] || r.cell > right[d]!.cell) right[d] = r
      }
    })
    return shifts
  }

  /** 子簇里有没有设备直连到某台成员设备 —— 决定它算不算在这台成员的「窗口」里 */
  const childLinksMember = (childId: string, memberId: string): boolean => {
    const nb = adj.get(memberId)
    const kid = clusters.get(childId)
    if (!nb || !kid) return false
    return kid.members.some((m) => nb.has(m))
  }

  const buildSubtree = (id: string): Packed => {
    const c = clusters.get(id)!
    const members = c.members
    const m = members.length
    const kids = c.children.map((ch) => buildSubtree(ch))
    const n = kids.length

    // 1) 子簇先按最小间距（角色相关）紧邻排开
    const shifts = packShifts(kids)

    // 2) 「窗口」：大小 ⌈n/m⌉，**首尾靠边依次滑窗**（用户拍板）；窗口里只保留
    //    **与本成员有连线**的子簇 —— 没连线的那些「分开计算」，不参与本成员的中点。
    const w = n === 0 ? 0 : Math.max(1, Math.ceil(n / m))
    const rangeOf = (j: number): [number, number] => {
      if (n === 0 || w === 0) return [0, -1]
      if (m === 1) return [0, n - 1]
      const start = Math.round((j * (n - w)) / (m - 1))
      return [start, Math.min(n - 1, start + w - 1)]
    }
    const cellOf = (i: number): number => kids[i]!.center + shifts[i]!
    const windowIdx = (j: number): number[] => {
      const [a, b] = rangeOf(j)
      if (b < a) return []
      const all: number[] = []
      for (let i = a; i <= b; i++) all.push(i)
      const linked = all.filter((i) => childLinksMember(c.children[i]!, members[j]!))
      return linked.length > 0 ? linked : all
    }
    const anchorOf = (j: number): number => {
      const idx = windowIdx(j)
      if (idx.length === 0) return 0
      return (cellOf(idx[0]!) + cellOf(idx[idx.length - 1]!)) / 2
    }
    /** 把 idx 起的子簇整体右移 delta：只加宽一处间距，不动相对次序、不破最小间距 */
    const bumpFrom = (idx: number, delta: number): void => {
      for (let i = idx; i < n; i++) shifts[i]! += delta
    }

    // 3) 奇偶修正（坐标必须是 160 的整数倍）
    //    a) 每台成员都要精确落在自己窗口的中点上 → 首末中点若为半格，窗口末子簇整体右移 1
    if (w > 0) {
      for (let j = 0; j < m; j++) {
        const idx = windowIdx(j)
        if (idx.length < 2) continue
        const first = cellOf(idx[0]!)
        const end = cellOf(idx[idx.length - 1]!)
        if ((first + end) % 2 !== 0) bumpFrom(idx[idx.length - 1]!, 1)
      }
    }
    //    b) 首末成员的中点要落在整格（父设备要用它居中）→ 末成员窗口末子簇右移 2（只翻奇偶）
    if (m >= 2 && w > 0) {
      const idx = windowIdx(m - 1)
      if (idx.length > 0 && (anchorOf(0) + anchorOf(m - 1)) % 2 !== 0) {
        bumpFrom(idx[idx.length - 1]!, 2)
      }
    }

    // 4) 成员落位：优先「精确居中于窗口中点」；相邻不足最小间距时往右顶（兜底，会牺牲该台的居中）
    const anchors: number[] = []
    for (let j = 0; j < m; j++) {
      const idx = windowIdx(j)
      const centered = idx.length > 0 ? anchorOf(j) : null
      const need =
        j === 0 ? 0 : anchors[j - 1]! + gapBetween(roleOf(members[j - 1]!), roleOf(members[j]!))
      anchors.push(centered === null ? need : Math.max(centered, need))
    }
    // 顶位可能翻掉「首末成员中点」的奇偶 → 末成员再右移 1（此时它已非精确居中，属兜底）
    if (m >= 2 && (anchors[0]! + anchors[m - 1]!) % 2 !== 0) anchors[m - 1]! += 1

    // 5) 组装（成员层号 0，子簇整体 +1 层）
    const cells: Packed['cells'] = members.map((mid, j) => ({
      id: mid,
      cell: anchors[j]!,
      level: 0,
      role: roleOf(mid)
    }))
    kids.forEach((kp, i) => {
      const off = shifts[i]!
      for (const e of kp.cells) {
        cells.push({ id: e.id, cell: e.cell + off, level: e.level + 1, role: e.role })
      }
    })
    const left: ProfileEdge[] = []
    const right: ProfileEdge[] = []
    const put = (d: number, cell: number, role: TopologyRole): void => {
      if (!left[d]) {
        left[d] = { cell, role }
        right[d] = { cell, role }
        return
      }
      if (cell < left[d]!.cell) left[d] = { cell, role }
      if (cell > right[d]!.cell) right[d] = { cell, role }
    }
    members.forEach((mid, j) => put(0, anchors[j]!, roleOf(mid)))
    kids.forEach((kp, i) => {
      for (let d = 0; d < kp.left.length; d++) {
        put(d + 1, kp.left[d]!.cell + shifts[i]!, kp.left[d]!.role)
        put(d + 1, kp.right[d]!.cell + shifts[i]!, kp.right[d]!.role)
      }
    })
    return {
      cells,
      left,
      right,
      center: m >= 2 ? (anchors[0]! + anchors[m - 1]!) / 2 : (anchors[0] ?? 0)
    }
  }

  const positions = new Map<string, NodePoint>()
  {
    // 根簇之间同样只留最小间距（根簇的层号恒为 0，故 Packed.level 就是绝对层号）
    const rootsPacked = rootClusters.filter((rc) => rc.id !== wanClusterId).map((rc) => buildSubtree(rc.id))
    const shifts = packShifts(rootsPacked)
    rootsPacked.forEach((rp, i) => {
      const off = shifts[i]!
      for (const e of rp.cells) {
        positions.set(e.id, { x: (e.cell + off) * LAYOUT_GRID, y: e.level * LAYER_GAP })
      }
    })
  }

  // —— 5.5 外部网分支：单独排布后转置（深度 → 向左、格位 → 向下），摆在主树左侧顶部带 ——
  // 转置的妙处：竖向布局里「x = 格位（≥ 3 格自适应）、y = 层 × 2 格」，对调两轴后自动得到
  // 「同层 ≥ 3 格（纵向）、父子 2 格（横向）」—— 与主树同一套规则，不必另定常量。
  if (wanClusterId) {
    const wanModel = layoutComponentTidy([...wanIds], adj, nodeMap, orderCmp, false)
    const wanPos = wanModel.positions
    let minCell = Number.POSITIVE_INFINITY
    const headVert = wanPos.get(wanHeadId)
    for (const p of wanPos.values()) {
      minCell = Math.min(minCell, p.x)
    }
    // 主树整体右移，给横排的外部网链让出左侧空间：横排链的最右设备在格位 0，
    // 主树的实际最左格与它拉开 3 格（= 同层最小间距）即可。
    // 注意主树的格位可能是负的（打包时允许向左贴），所以按**实际最左格**算位移，
    // 否则外部网链会和主树左边那几台交错在同一行上。
    let mainMinX = Number.POSITIVE_INFINITY
    for (const p of positions.values()) mainMinX = Math.min(mainMinX, p.x)
    const mainShiftX = LAYOUT_GRID * MEMBER_PITCH - (Number.isFinite(mainMinX) ? mainMinX : 0)
    for (const p of positions.values()) p.x += mainShiftX
    for (const [id, p] of wanPos) {
      positions.set(id, { x: -(p.y - (headVert?.y ?? 0)), y: p.x - minCell })
    }
  }

  // —— 6. 分组框：splitLevel 上的簇（成员 = 树后代），口径与旧实现一致 ——
  // 注意切分层按「簇数」判定：外部网汇聚这类挂在出口路由器上的 level-1 簇会把
  // nodesAt1 顶到 3，按节点数判就永远切不到楼宇层
  let splitLevel = 1
  if (maxLevel >= 3) {
    const clustersAt1 = new Set(compNodeIds.filter((id) => levelOf.get(id) === 1).map(find)).size
    const nodesAt2 = compNodeIds.filter((id) => levelOf.get(id) === 2).length
    if (clustersAt1 <= 2 && nodesAt2 >= 2) splitLevel = 2
  }
  const blocks: Array<{ headId: string; nodeIds: string[] }> = []
  {
    const descendants = (id: string, out: string[]): void => {
      const c = clusters.get(id)
      if (!c) return
      out.push(...c.members)
      for (const ch of c.children) descendants(ch, out)
    }
    for (const c of clusters.values()) {
      if (c.level !== splitLevel || c.members.length === 0) continue
      // 横排的外部网分支不套区块框：它的成员已经不在树形网格上，框会把相邻阶梯一起圈进去
      if (c.members.some((m) => wanIds.has(m))) continue
      const nodeIds: string[] = []
      descendants(c.id, nodeIds)
      blocks.push({ headId: c.members[0]!, nodeIds })
    }
  }

  // —— 7. 边界归一（min 本身是格点倍数，平移后仍落格点）——
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  for (const p of positions.values()) {
    p.x -= minX
    p.y -= minY
  }

  return {
    positions,
    width: maxX - minX + LAYOUT_GRID,
    height: maxY - minY + LAYOUT_GRID,
    blocks
  }
}


/**
 * 纯对等结构网络（如纯路由器链、环网等全同级设备）的水平左右排布
 */
function layoutPeerNetwork(
  compNodeIds: string[],
  adj: Map<string, Set<string>>,
  layerGapY: number,
  orderCmp: (a: string, b: string) => number
): { positions: Map<string, NodePoint>; width: number; height: number } {
  const positions = new Map<string, NodePoint>()
  const nodeGapX = PEER_GAP_X

  // N68：成员判定用具 Set —— 原来对数组做线性查找（成员判定写在「BFS 队列 ×
  // 邻居」双层循环里，每步扫一遍数组），设备多时是 O(n²)。
  // 同文件的 findBackboneChain 已刻意 Set 化（T4.6），这里是漏网的一处。
  const memberSet = new Set(compNodeIds)

  // 寻找骨干直径链
  const path = findBackboneChain(compNodeIds, adj)

  // 骨干沿水平左右排开
  path.forEach((id, idx) => {
    positions.set(id, { x: idx * nodeGapX, y: 0 })
  })

  // 非骨干分支向下挂接
  const queue = [...path]
  const visited = new Set(path)
  const levelOf = new Map<string, number>()
  path.forEach((id) => levelOf.set(id, 0))

  while (queue.length > 0) {
    const cur = queue.shift()!
    const curL = levelOf.get(cur)!
    const parentX = positions.get(cur)?.x ?? 0
    let childIdx = 0
    // 同级分支按「源坐标优先、名称兜底」从左到右（与分区布局同一口径）
    const kids = [...(adj.get(cur) ?? [])]
      .filter((nb) => memberSet.has(nb) && !visited.has(nb))
      .sort(orderCmp)
    for (const nb of kids) {
      visited.add(nb)
      levelOf.set(nb, curL + 1)
      queue.push(nb)
      positions.set(nb, {
        x: parentX + childIdx * PEER_GAP_X,
        y: (curL + 1) * layerGapY
      })
      childIdx++
    }
  }

  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const p of positions.values()) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }

  for (const p of positions.values()) {
    p.x -= minX
    p.y -= minY
  }

  return {
    positions,
    width: Math.max(160, maxX - minX),
    height: Math.max(60, maxY - minY)
  }
}

/**
 * 寻找最长骨干链
 */
function findBackboneChain(nodeIds: string[], adj: Map<string, Set<string>>): string[] {
  // T4.6：BFS 里每访问一个邻居就 includes 一次 → O(n²)；Set 化后是 O(n)
  const idSet = new Set(nodeIds)
  const bfsFarthest = (start: string): string => {
    const q = [start]
    const seen = new Set([start])
    let last = start
    while (q.length > 0) {
      const cur = q.shift()!
      last = cur
      for (const nb of adj.get(cur) ?? []) {
        if (idSet.has(nb) && !seen.has(nb)) {
          seen.add(nb)
          q.push(nb)
        }
      }
    }
    return last
  }

  const endA = bfsFarthest(nodeIds[0])
  const endB = bfsFarthest(endA)

  const parent = new Map<string, string>()
  const q = [endA]
  const seen = new Set([endA])
  while (q.length > 0) {
    const cur = q.shift()!
    if (cur === endB) break
    for (const nb of adj.get(cur) ?? []) {
      if (idSet.has(nb) && !seen.has(nb)) {
        seen.add(nb)
        parent.set(nb, cur)
        q.push(nb)
      }
    }
  }

  const path: string[] = []
  let trace: string | undefined = endB
  while (trace) {
    path.push(trace)
    trace = parent.get(trace)
  }
  return path.reverse()
}
