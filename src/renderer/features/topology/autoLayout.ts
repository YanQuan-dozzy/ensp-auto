import type { TopologyLink, TopologyNode, TopologyRole } from '@shared/types'

export interface LayoutOptions {
  /** 同层设备水平间距 */
  nodeGapX?: number
  /** 层级间纵向垂直间距 */
  layerGapY?: number
  /** 孤立设备矩阵每行数量 */
  isolatedCols?: number
}

export interface NodePoint {
  x: number
  y: number
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

const DEFAULT_PC_GAP_X = 180
const DEFAULT_SW_GAP_X = 220
const DEFAULT_LAYER_GAP_Y = 150
const DEFAULT_BLOCK_GAP_X = 70
const DEFAULT_ISOLATED_COLS = 4

/**
 * 分区块智能自适应布局引擎（Block-Based Hierarchical Layout）：
 * 
 * 核心设计原则（符合网络工程真实规范）：
 * 1. 核心骨干置顶：出口云、路由器、核心交换机（Core）居于顶层居中展开。
 * 2. 交换机分区块（Block）：每个汇聚/接入交换机分支独立划分为一个「区块」，各区块水平左右并排。
 * 3. 区块内部向下延伸：
 *    - 汇聚交换机在区块顶部；
 *    - 二层接入交换机垂直挂在汇聚下方；
 *    - 终端（PC、Server）垂直挂在对应的二层接入交换机下方，左右微调对齐。
 * 4. 杜绝全网所有交换机被压扁在单一行、所有终端在另一行的拉长现象。
 */
export function computeAutoLayout(
  nodes: TopologyNode[],
  links: TopologyLink[],
  options: LayoutOptions = {}
): Map<string, NodePoint> {
  const result = new Map<string, NodePoint>()
  if (nodes.length === 0) return result

  const layerGapY = options.layerGapY ?? DEFAULT_LAYER_GAP_Y
  const isolatedCols = options.isolatedCols ?? DEFAULT_ISOLATED_COLS

  const nodeMap = new Map<string, TopologyNode>(nodes.map((n) => [n.id, n]))

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
  }

  const subgraphs: SubgraphBox[] = components.map((comp) =>
    layoutComponentBlocks(comp, adj, nodeMap, layerGapY)
  )

  // 4. 将各连通分量水平横向并排
  let curOffsetX = 0
  let maxCompHeight = 0
  const compGapX = 120

  for (const sub of subgraphs) {
    for (const [id, pt] of sub.positions) {
      result.set(id, {
        x: pt.x + curOffsetX,
        y: pt.y
      })
    }
    curOffsetX += sub.width + compGapX
    maxCompHeight = Math.max(maxCompHeight, sub.height)
  }

  // 5. 孤立设备以整齐的 2D 矩阵收拢在网络底部
  if (isolatedNodes.length > 0) {
    isolatedNodes.sort((a, b) => {
      const na = nodeMap.get(a)
      const nb = nodeMap.get(b)
      const ta = ROLE_TIER[na?.role ?? 'unknown']
      const tb = ROLE_TIER[nb?.role ?? 'unknown']
      if (ta !== tb) return ta - tb
      return (na?.name ?? a).localeCompare(nb?.name ?? b)
    })

    const cols = Math.min(isolatedCols, Math.max(2, Math.ceil(Math.sqrt(isolatedNodes.length))))
    const isoGapX = DEFAULT_SW_GAP_X
    const isoGapY = 85
    const startY = subgraphs.length > 0 ? maxCompHeight + layerGapY : 0

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

  const padX = 60
  const padY = 50
  const shiftX = Number.isFinite(minX) ? padX - minX : 0
  const shiftY = Number.isFinite(minY) ? padY - minY : 0

  for (const p of result.values()) {
    p.x = Math.round(p.x + shiftX)
    p.y = Math.round(p.y + shiftY)
  }

  return result
}

/**
 * 连通网络的分区块排布算法：
 * - 找到网络核心起点（出口路由器、或核心交换机）
 * - 沿拓扑距离 BFS 分配层级（核心 0/1 -> 汇聚区块头 2 -> 二层交换机 3 -> 终端 4）
 * - 自动聚合每个分支为一个独立 Block，各 Block 左右并排
 * - Block 内垂直延伸：二层交换机向下挂载，终端垂直在二层交换机下方居中分布
 */
function layoutComponentBlocks(
  compNodeIds: string[],
  adj: Map<string, Set<string>>,
  nodeMap: Map<string, TopologyNode>,
  layerGapY: number
): { positions: Map<string, NodePoint>; width: number; height: number } {
  const compSet = new Set(compNodeIds)

  // 1. 识别核心根节点 (Roots)
  let roots: string[] = []

  // 优先路由器与云节点
  for (const id of compNodeIds) {
    const role = nodeMap.get(id)?.role ?? 'unknown'
    if (role === 'router' || role === 'firewall' || role === 'cloud') {
      roots.push(id)
    }
  }

  // 若无路由器/云节点，寻找核心交换机（名称包含 Core / 核心 / Spine，或度数最大的交换机群）
  if (roots.length === 0) {
    const coreCandidates: string[] = []
    let maxDeg = -1

    for (const id of compNodeIds) {
      const node = nodeMap.get(id)
      const name = (node?.name ?? '').toLowerCase()
      const isNamedCore = name.includes('core') || name.includes('核心') || name.includes('spine')
      const deg = adj.get(id)?.size ?? 0

      if (isNamedCore) {
        coreCandidates.push(id)
      }
      if (deg > maxDeg) {
        maxDeg = deg
      }
    }

    if (coreCandidates.length > 0) {
      roots = coreCandidates
    } else {
      // 取度数最高的所有核心交换机（例如互联的双核心）
      roots = compNodeIds.filter((id) => (adj.get(id)?.size ?? 0) === maxDeg)
    }
  }

  // 2. 从根节点开始进行多源 BFS，计算拓扑深度距离
  const levelOf = new Map<string, number>()
  const parentOf = new Map<string, string>()

  for (const r of roots) {
    levelOf.set(r, 0)
  }

  const queue = [...roots]
  while (queue.length > 0) {
    const cur = queue.shift()!
    const curL = levelOf.get(cur)!
    for (const nb of adj.get(cur) ?? []) {
      if (!compSet.has(nb)) continue
      // 若邻居同属 roots（如双核心互联），保持在同一顶层
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

  // 若全网只有一层（如纯路由器链、对等交换机环），直接水平左右排开
  if (maxLevel === 0) {
    return layoutPeerNetwork(compNodeIds, adj, layerGapY)
  }

  // 3. 确定分区块切分层（splitLevel）与核心层（Core）
  // 如果深度 >= 3（如 Router -> Core -> Building -> Teaching -> PC），splitLevel 为 2（以 Building 为各区块头）
  // 否则（如 Core -> Access -> PC，深度为 2），splitLevel 为 1（以 Access 为各区块头）
  // 深度为 1（如 Core -> Access），splitLevel 为 1
  let splitLevel = 1
  if (maxLevel >= 3) {
    // 检查是否有中间汇聚层（Level 1 往往是核心交换机，Level 2 是各汇聚交换机）
    const nodesAt1 = compNodeIds.filter((id) => levelOf.get(id) === 1)
    const nodesAt2 = compNodeIds.filter((id) => levelOf.get(id) === 2)
    if (nodesAt1.length <= 2 && nodesAt2.length >= 2) {
      // 经典三层架构：Level 1 是双核心/核心交换机，Level 2 是各楼宇汇聚交换机
      splitLevel = 2
    }
  }

  const coreNodeIds = compNodeIds.filter((id) => (levelOf.get(id) ?? 0) < splitLevel)
  const blockHeadIds = compNodeIds.filter((id) => levelOf.get(id) === splitLevel)

  // 若切分出的区块头为空，回退到对等布局
  if (blockHeadIds.length === 0) {
    return layoutPeerNetwork(compNodeIds, adj, layerGapY)
  }

  // 4. 将各下属节点划分到最近的区块头（Voronoi 聚合）
  const blockOf = new Map<string, string>()
  for (const h of blockHeadIds) {
    blockOf.set(h, h)
  }

  // 从 splitLevel 向下追溯归属
  const assignQueue = [...blockHeadIds]
  const assigned = new Set(blockHeadIds)
  while (assignQueue.length > 0) {
    const cur = assignQueue.shift()!
    const head = blockOf.get(cur)!
    for (const nb of adj.get(cur) ?? []) {
      if (!compSet.has(nb) || coreNodeIds.includes(nb)) continue
      if ((levelOf.get(nb) ?? 0) > (levelOf.get(cur) ?? 0) && !assigned.has(nb)) {
        assigned.add(nb)
        blockOf.set(nb, head)
        assignQueue.push(nb)
      }
    }
  }

  // 组织各区块成员
  const blockMembers = new Map<string, string[]>()
  for (const h of blockHeadIds) {
    blockMembers.set(h, [])
  }
  for (const id of compNodeIds) {
    const h = blockOf.get(id)
    if (h && blockMembers.has(h)) {
      blockMembers.get(h)!.push(id)
    }
  }

  // 5. 对每个区块单独进行内部排布（汇聚 -> 二层交换机 -> 终端）
  interface BlockLayout {
    headId: string
    positions: Map<string, NodePoint>
    width: number
    headCenterX: number
  }

  const blockLayouts: BlockLayout[] = []

  for (const headId of blockHeadIds) {
    const members = blockMembers.get(headId) ?? []
    if (members.length === 0) continue
    const blk = layoutSingleBlock(headId, members, adj, nodeMap, layerGapY)
    blockLayouts.push(blk)
  }

  // 6. 各区块在水平方向（左右）并排铺开
  const positions = new Map<string, NodePoint>()
  let curBlockX = 0
  const blockGapX = DEFAULT_BLOCK_GAP_X
  const blockBaseY = splitLevel * layerGapY

  for (const blk of blockLayouts) {
    const offsetX = curBlockX
    for (const [id, pt] of blk.positions) {
      positions.set(id, {
        x: pt.x + offsetX,
        y: blockBaseY + pt.y
      })
    }
    curBlockX += blk.width + blockGapX
  }

  const totalBlocksWidth = Math.max(DEFAULT_SW_GAP_X * 2, curBlockX - blockGapX)

  // 7. 核心层设备（Core）在各区块上方居中对齐排布
  // 按 level 分组排布核心设备
  for (let l = 0; l < splitLevel; l++) {
    const coresAtL = coreNodeIds.filter((id) => levelOf.get(id) === l)
    if (coresAtL.length === 0) continue

    const y = l * layerGapY
    if (coresAtL.length === 1) {
      positions.set(coresAtL[0], { x: totalBlocksWidth / 2, y })
    } else if (coresAtL.length === 2) {
      // 双核心对称分布
      const midX = totalBlocksWidth / 2
      const spacing = 240
      positions.set(coresAtL[0], { x: midX - spacing / 2, y })
      positions.set(coresAtL[1], { x: midX + spacing / 2, y })
    } else {
      // 多核心水平等距居中
      const totalWidth = (coresAtL.length - 1) * DEFAULT_SW_GAP_X
      const startX = (totalBlocksWidth - totalWidth) / 2
      coresAtL.forEach((id, idx) => {
        positions.set(id, { x: startX + idx * DEFAULT_SW_GAP_X, y })
      })
    }
  }

  // 8. 局部边界盒计算并平移至 0
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
 * 单个区块内部排布（树形分层，贴近手工拓扑图习惯）：
 * - 汇聚交换机（head）位于区块顶端；
 * - 区块内交换机按“距离汇聚的拓扑深度”分排：第二层交换机一排，第三层交换机再往下一排，逐层纵向延伸；
 * - 终端紧贴各自父交换机下落：直接挂在交换机下方的那一行，不再往全区块最深行强行下沉。
 *   这样每个「交换机 + 其下终端」自然形成一簇紧凑竖列（类似参考图中按楼宇/分部划分的色块），
 *   深浅不一的子树不会出现中间断层空白。
 */
function layoutSingleBlock(
  headId: string,
  memberIds: string[],
  adj: Map<string, Set<string>>,
  nodeMap: Map<string, TopologyNode>,
  layerGapY: number
): {
  headId: string
  positions: Map<string, NodePoint>
  width: number
  headCenterX: number
} {
  const positions = new Map<string, NodePoint>()
  const ids = new Set<string>([headId, ...memberIds])
  const isSwitchRole = (r: TopologyRole): boolean => r === 'switch' || r === 'wlan'
  const KID_GAP = 20

  // 1. 自汇聚交换机 BFS 求区块内拓扑深度（第二层 =1，第三层 =2 …）
  const depth = new Map<string, number>([[headId, 0]])
  const queue = [headId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    const d = depth.get(cur)!
    for (const nb of adj.get(cur) ?? []) {
      if (!ids.has(nb) || depth.has(nb)) continue
      depth.set(nb, d + 1)
      queue.push(nb)
    }
  }

  // memberIds 含区块头自身：头归类为根，不再作子交换机/终端处理
  const switches = memberIds.filter((id) => id !== headId && isSwitchRole(nodeMap.get(id)?.role ?? 'unknown'))
  const terminals = memberIds.filter((id) => id !== headId && !isSwitchRole(nodeMap.get(id)?.role ?? 'unknown'))
  const maxSwDepth = switches.reduce((m, s) => Math.max(m, depth.get(s) ?? 0), 0)

  // 2. 构建树形父子关系：交换机的父 = 深度更浅的邻接交换机（否则挂头）；
  //    终端的父 = 可达的最深交换机（否则挂头）。父节点决定子树的水平位置。
  const childrenOf = new Map<string, string[]>()
  childrenOf.set(headId, [])
  for (const s of switches) childrenOf.set(s, [])

  // T4.6：池子改成 Set —— `pool.includes` 在每节点上都是一次线性扫描，
  // 大图上是彻底的 O(n²)；判定语义（成员资格）完全不变。
  const pickParent = (id: string, pool: ReadonlySet<string>): string | undefined => {
    let best: string | undefined
    for (const nb of adj.get(id) ?? []) {
      if (!ids.has(nb) || !pool.has(nb)) continue
      if (best === undefined || (depth.get(nb) ?? 0) > (depth.get(best) ?? 0)) best = nb
    }
    return best
  }

  const swSorted = [...switches].sort(
    (a, b) => (depth.get(a) ?? Number.MAX_SAFE_INTEGER) - (depth.get(b) ?? Number.MAX_SAFE_INTEGER)
  )
  // T4.6：一次算好每个交换机的「更浅层池」，替代过去每个节点都 filter 一遍的 O(n²)。
  // 语义等价：swSorted 按深度升序，逐深度分组累积，同深度的互相不进对方的池子
  // （原式 `depth(s) < d` 排除同深度），headId 始终在池子里。
  const shallowerPoolOf = new Map<string, Set<string>>()
  {
    const acc = new Set<string>([headId])
    let i = 0
    while (i < swSorted.length) {
      const d = depth.get(swSorted[i]!) ?? 0
      const group: string[] = []
      while (i < swSorted.length && (depth.get(swSorted[i]!) ?? 0) === d) {
        group.push(swSorted[i]!)
        i += 1
      }
      const pool = new Set(acc)
      for (const sw of group) shallowerPoolOf.set(sw, pool)
      for (const sw of group) acc.add(sw)
    }
  }
  for (const sw of swSorted) {
    const pool = shallowerPoolOf.get(sw) ?? new Set<string>([headId])
    childrenOf.get(pickParent(sw, pool) ?? headId)!.push(sw)
  }
  const switchSet = new Set(switches)
  for (const t of terminals) {
    childrenOf.get(pickParent(t, switchSet) ?? headId)!.push(t)
  }

  // 3. 后序计算子树宽度（叶终端 = 终端间距；叶交换机 = 交换机间距；父 = 子树之和 + 间距）
  const leafWidth = (id: string): number =>
    isSwitchRole(nodeMap.get(id)?.role ?? 'unknown') ? DEFAULT_SW_GAP_X : DEFAULT_PC_GAP_X

  const widthOf = new Map<string, number>()
  const computeWidth = (id: string): number => {
    const kids = childrenOf.get(id) ?? []
    if (kids.length === 0) {
      const w = leafWidth(id)
      widthOf.set(id, w)
      return w
    }
    const total = kids.reduce((s, k) => s + computeWidth(k), 0) + (kids.length - 1) * KID_GAP
    const w = Math.max(leafWidth(id), total)
    widthOf.set(id, w)
    return w
  }
  computeWidth(headId)

  // 4. 前序分配坐标：所有成员都按「距汇聚的拓扑深度」逐行下落（终端不另行沉底），
  //    每组「父交换机 + 其终端」呈紧凑竖列
  const fallbackRow = (maxSwDepth + 1) * layerGapY
  const yOf = (id: string): number => {
    if (id === headId) return 0
    const d = depth.get(id)
    return d === undefined ? fallbackRow : d * layerGapY
  }

  const place = (id: string, x: number): void => {
    const w = widthOf.get(id) ?? leafWidth(id)
    positions.set(id, { x: x + w / 2, y: yOf(id) })
    let kx = x
    for (const k of childrenOf.get(id) ?? []) {
      place(k, kx)
      kx += (widthOf.get(k) ?? leafWidth(k)) + KID_GAP
    }
  }
  place(headId, 0)

  const blockWidth = Math.max(DEFAULT_SW_GAP_X, widthOf.get(headId) ?? DEFAULT_SW_GAP_X)
  const headCenterX = positions.get(headId)?.x ?? blockWidth / 2

  return {
    headId,
    positions,
    width: blockWidth,
    headCenterX
  }
}

/**
 * 纯对等结构网络（如纯路由器链、环网等全同级设备）的水平左右排布
 */
function layoutPeerNetwork(
  compNodeIds: string[],
  adj: Map<string, Set<string>>,
  layerGapY: number
): { positions: Map<string, NodePoint>; width: number; height: number } {
  const positions = new Map<string, NodePoint>()
  const nodeGapX = DEFAULT_SW_GAP_X

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
    for (const nb of adj.get(cur) ?? []) {
      if (!compNodeIds.includes(nb) || visited.has(nb)) continue
      visited.add(nb)
      levelOf.set(nb, curL + 1)
      queue.push(nb)
      positions.set(nb, {
        x: parentX + childIdx * DEFAULT_PC_GAP_X,
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
