/**
 * 源图保真布局内核（2026-10-01 **第七版：源坐标骨架**）。
 *
 * 用户口径（本版）：「**保留源坐标骨架，只做防重叠 + 父居中**」——
 * 上一版（第六版「源图方位骨架」）虽然模块归属跟了拓扑，但**模块内部仍被强行改成居中树形**
 * （层次沿一个轴铺、层距固定 2 格），于是输出与 eNSP 原图差得远：实测「企业网实例」26 台，
 * 输出的 x 与源坐标的线性拟合斜率是 **−0.40**（左右被翻乱），「最终」40 台的平均坐标偏差
 * 553px。用户要的是**原图长什么样、放大了还是什么样**。
 *
 * ## 第七版算法（4 步，全部围绕「保住源坐标骨架」）
 *
 * 1. **整体等比放大**（`skeletonScaleOf`）：求一个统一倍数 `S`（下限 2），使「同一输出行内
 *    相邻设备的中心距」满足紧凑档、「同一输出列内相邻设备」不上下压框。倍数取**最小可行值**
 *    并迭代收敛（行/列的组成会随倍数变化）。
 *    *为什么必须放大*：源图相邻网络设备只隔 ≈100 单位，而设备框宽 ≈140px，1:1 摆上去必然重叠。
 *    *为什么必须统一倍数*：等比放大是**相似变换** —— 列对齐、「父居中于子」逐台不变，
 *    长宽比也保住。分轴各放一个倍数会把图横向拉长，看着就是「和原图不一样」。
 * 2. **落格点**：坐标 = 源坐标 × S 吸附到 `LAYOUT_GRID`(160) 的整数倍（硬约束，见 `layoutGrid.ts`）。
 * 3. **防重叠**（`separateRows`）：同一行（同一个 y）内相邻中心距不足 → 把右边那台整格右推。
 *    落格点后**只有同一行才可能压框**（不同行至少差 160px > 设备框高 52px），所以这一步就是
 *    完整的防重叠，不需要动 y。
 * 4. **父居中**（`centerParents`）：父设备在「它**下一层直接邻居**」的铺开轴上居中（偏差 ≤ 半格
 *    才算达标；要挪就整格挪，且**挪完压框/过近就撤销**）。3、4 交替迭代到稳定（实测 3~8 轮）。
 *    单子设备：父与子在不铺开的那根轴上对齐（用户口径「单个终端设备垂直或者水平放置」）。
 *    *为什么用「下一层直接邻居」而不是 BFS 树的孩子*：双核心共享同一批楼宇时（`H-SW1/H-SW2`
 *    都接 `cwb`），各自只该居中于**自己连到的那几台** —— 源图里就是这么摆的。
 *
 * ## 被前六版否掉、**不要再走**的路（都有实测依据）
 *
 * - **源 x 一维间隙聚类分模块**：紧邻摆放的工程必然把一棵子树劈两半（图书馆跑进外网列）。
 * - **源图二维递归分区 + 分块摆位**：40 台被切成 6~8 个站点块后画布 4000×3040 → 11520×5280
 *   （平均边长 558 → 1665），多出 6~14 条跨块长线。
 * - **模块内居中树形 / 模块按方位摆开**（第六版本体）：见文件头第一段，x 与源坐标反相关。
 * - **逐行局部拉开到 2 格**（本轮试过）：只有密集行变宽 → 密集行里的子设备被推离父设备列
 *   1~3 格（实测教学区 3 处、企业网实例 4 处父子偏差 160~480px）。等比放大才是既够宽又对齐。
 *
 * ## 不变式（改动前先读）
 *
 * - 坐标语义 = **设备框中心**，且全部是 `LAYOUT_GRID`(160) 的整数倍；
 * - **不重叠**：同一行相邻满足「中心距 ≥ 角色最小间距」**且**「≥ 两者半宽之和」；
 * - **父居中**：父设备在「下一层直接邻居」的铺开轴上居中，误差 ≤ 半格（80px）；
 * - 间距档位（紧凑）：终端↔终端 1 格、含网络设备 2 格 —— 见 `pitchCells`。
 *
 * 分组框（`blocks`）仍由模块划分（`splitIntoModules`）决定**成员与语义标题**，
 * 但**不再参与摆位** —— 框只是罩在源图那一簇设备外面的壳。
 */
import type { TopologyLink, TopologyNode, TopologyRole } from '@shared/types'
import { estimateNodeSizeAligned } from './nodeSize'
import {
  LAYER_GAP,
  LAYOUT_GRID,
  ROLE_TIER,
  computeBlockBoxes,
  naturalCompare,
  sourcePosOf
} from './layoutGrid'
import type { LayoutModel, LayoutOptions, NodePoint, TopologyBlock } from './layoutGrid'

/** 展布轴：模块的层次沿哪个轴展开（`moduleAxisOf` / 侧挂判定用） */
export type SpreadAxis = 'x' | 'y'

/** 孤立设备矩阵每行台数 */
const DEFAULT_ISOLATED_COLS = 4

/** 方向判定的层步长下限（px）：源图上「一层」跨得极小（小于它）时按它算，避免阈值退化成 0 */
const MIN_LAYER_STEP = 40

/** 终端角色：同层相邻**两台都是终端**才允许贴近到 1 格 */
const TERMINAL_ROLES: ReadonlySet<TopologyRole> = new Set<TopologyRole>(['pc', 'server'])

/**
 * 同层相邻两台设备的**中心距**（格）—— 用户拍板：
 * 两台都是终端（PC / 服务器）→ 1 格（160px）；只要有一台是路由器 / 交换机 / 防火墙
 * → 2 格（320px）。全 1 格会让网络设备的接口标注互相压字，全 2 格又会超宽度上限。
 */
export function pitchCells(a: TopologyRole, b: TopologyRole): number {
  return TERMINAL_ROLES.has(a) && TERMINAL_ROLES.has(b) ? 1 : 2
}

/** 源图骨架的放大倍数下限 —— 源图相邻设备 ≈100 单位，×2 ≈ 200px，与设备框同量级 */
const SOURCE_SCALE_MIN = 2

/** 骨架迭代轮数上限（防重叠只右推 x，单调收敛，实测 2~3 轮） */
const SKELETON_MAX_ROUNDS = 40

/**
 * 模块列的**语义名**规则（用户拍板：语义名优先，取不到退回「×× 区」）。
 * 命名带语义是唯一可行的区分手段：这类分支与楼宇分支**结构完全同形**。
 */
const MODULE_TITLE_RULES: ReadonlyArray<{ re: RegExp; title: string }> = [
  { re: /分校/, title: '分校' },
  { re: /外部网|外网|公网|互联网|运营商|\bwan\b|\binternet\b/i, title: '外网' },
  { re: /图书|library/i, title: '图书馆' },
  { re: /教学|teaching|实验/i, title: '教学区' },
  { re: /办公|行政|office/i, title: '办公区' },
  { re: /宿舍|寝|dorm/i, title: '宿舍区' },
  { re: /服务|server|ftp|http|dns|web/i, title: '服务器区' }
]

/** 模块头挑选时的角色偏好（越靠前越像「这一块的入口设备」） */
const ROLE_RANK: Record<TopologyRole, number> = {
  cloud: 0,
  router: 1,
  firewall: 2,
  switch: 3,
  wlan: 4,
  unknown: 5,
  server: 6,
  pc: 7
}

interface Ctx {
  nodeMap: Map<string, TopologyNode>
  size: Map<string, { w: number; h: number }>
  src: Map<string, { x: number; y: number }>
  adj: Map<string, Set<string>>
  nameCmp: (a: string, b: string) => number
  roleOf: (id: string) => TopologyRole
}

function buildCtx(nodes: TopologyNode[], links: TopologyLink[], options: LayoutOptions): Ctx {
  const nodeMap = new Map<string, TopologyNode>(nodes.map((n) => [n.id, n]))
  // 尺寸必须与画布/走线同源（偶数口径）——「布局坐标 = 设备框中心」的换算要靠它
  const size = new Map(nodes.map((n) => [n.id, estimateNodeSizeAligned(n.name, n.role, n.model)]))
  const src = options.sourcePos ?? sourcePosOf(nodes)
  const adj = new Map<string, Set<string>>()
  for (const n of nodes) adj.set(n.id, new Set())
  for (const l of links) {
    if (nodeMap.has(l.from) && nodeMap.has(l.to) && l.from !== l.to) {
      adj.get(l.from)?.add(l.to)
      adj.get(l.to)?.add(l.from)
    }
  }
  const nameCmp = (a: string, b: string): number =>
    naturalCompare(nodeMap.get(a)?.name ?? a, nodeMap.get(b)?.name ?? b)
  const roleOf = (id: string): TopologyRole => nodeMap.get(id)?.role ?? 'unknown'
  return { nodeMap, size, src, adj, nameCmp, roleOf }
}

/** 连通分量 + 孤立设备拆分（与树形内核同一口径） */
function splitComponents(
  nodes: TopologyNode[],
  adj: Map<string, Set<string>>
): { components: string[][]; isolated: string[] } {
  const visited = new Set<string>()
  const components: string[][] = []
  const isolated: string[] = []
  for (const n of nodes) {
    if (visited.has(n.id)) continue
    const neighbors = adj.get(n.id)
    if (!neighbors || neighbors.size === 0) {
      isolated.push(n.id)
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
  return { components, isolated }
}

/** 一个设备集合是否**自我连通**（只看集合内部的边）—— 判「候选核心簇是否连成一片」用 */
function isConnectedSubset(subset: string[], ctx: Ctx): boolean {
  if (subset.length <= 1) return true
  const set = new Set(subset)
  const seen = new Set<string>([subset[0]!])
  const q = [subset[0]!]
  while (q.length > 0) {
    const cur = q.shift()!
    for (const nb of ctx.adj.get(cur) ?? []) {
      if (set.has(nb) && !seen.has(nb)) {
        seen.add(nb)
        q.push(nb)
      }
    }
  }
  return seen.size === subset.length
}

/** 集合的源坐标质心（无源坐标的设备不参与；一台都没有时返回 null） */
function centroidOf(ids: string[], ctx: Ctx): { x: number; y: number } | null {
  let sx = 0
  let sy = 0
  let n = 0
  for (const id of ids) {
    const p = ctx.src.get(id)
    if (!p) continue
    sx += p.x
    sy += p.y
    n++
  }
  return n > 0 ? { x: sx / n, y: sy / n } : null
}

// ============================================================================
// 模块划分：只决定**分组框**的成员与标题，不参与摆位
// ============================================================================

/**
 * 把一个连通分量切成模块：`[核心区, ...各汇聚子树]`。
 *
 * 认不出汇聚层（返回 null，或只切出 1 块）→ **整个分量当作一个模块**。
 *
 * ⚠️ 这里试过两条「兜底分区」的路，**都实测更差，别再走回头路**（2026-10-01）：
 * - **源 x 一维间隙聚类**：紧邻摆放的工程里必然把一棵子树劈成两半（图书馆被甩进外网列）。
 * - **源图二维递归分区 + 分块摆位**：对「40 台路由器织成的骨干网」切出 8 个站点块后，
 *   块间要拉开间距 → 画布从 4000×3040 涨到 6880×2240 / 11520×5280，平均边长从 558
 *   涨到 1096~1665，还多出 6~14 条跨块长线。**整块按一棵树排反而更紧凑、线更短**。
 */
function splitIntoModules(comp: string[], ctx: Ctx): string[][] {
  const r = splitByAggregationSubtrees(comp, ctx)
  if (r && r.length >= 2) return hoistLateralSubtrees(r, ctx)
  return [comp]
}

/**
 * 把「**侧向旁挂**的子树」从主模块里摘出来，单独成模块（例：用户那份工程里的**外部网分支**）。
 *
 * 判据（与模块级方向判定同一口径）：某个树子节点 `C` 的**子树质心**相对其父 `D` 的偏移，
 * 若「垂直于模块展布轴的分量」更占优（且超过半层），`C` 这一支就是侧挂分支 →
 * 摘成独立模块（于是在分组框上独立成框，不再混进核心区的框里）。
 *
 * 实测（用户那份工程，主模块轴 = 'y'）：`AR3 → 外部网汇聚` 的子树质心偏移 (302, 17) →
 * `|perp|=302 > |along|=17` → 摘出 ✓；而 `AR3 → Core1` 的子树质心偏移 (122, 220) →
 * `|perp| < |along|` → 不摘 ✓。
 */
function hoistLateralSubtrees(modules: string[][], ctx: Ctx): string[][] {
  const main = modules[0]
  if (!main || main.length < 3) return modules
  const info = moduleAxisOf(main, ctx)
  const step = Math.max(info.layerStep, MIN_LAYER_STEP)
  const set = new Set(main)

  // 主模块内的 BFS 树（唯一父，保证「子树」有定义）—— 从**根簇**出发（只从第一台出发会把
  // 簇里其余核心当成它的子设备，进而被当侧挂子树摘出去）
  const roots = pickRoots(main, ctx)
  const childrenOf = new Map<string, string[]>()
  const seen = new Set<string>(roots)
  const q = [...roots]
  while (q.length > 0) {
    const cur = q.shift()!
    for (const nb of ctx.adj.get(cur) ?? []) {
      if (!set.has(nb) || seen.has(nb)) continue
      seen.add(nb)
      childrenOf.set(cur, [...(childrenOf.get(cur) ?? []), nb])
      q.push(nb)
    }
  }
  const subtreeOf = (id: string): string[] => {
    const out: string[] = []
    const stack = [id]
    while (stack.length > 0) {
      const cur = stack.pop()!
      out.push(cur)
      for (const k of childrenOf.get(cur) ?? []) stack.push(k)
    }
    return out
  }

  const hoisted: string[][] = []
  const removed = new Set<string>()
  for (const d of main) {
    const a = ctx.src.get(d)
    if (!a) continue
    for (const c of childrenOf.get(d) ?? []) {
      if (removed.has(c)) continue
      const sub = subtreeOf(c)
      const cent = centroidOf(sub, ctx)
      if (!cent) continue
      const dx = cent.x - a.x
      const dy = cent.y - a.y
      const perp = info.axis === 'y' ? dx : dy
      const along = info.axis === 'y' ? dy : dx
      if (Math.abs(perp) >= step * 0.5 && Math.abs(perp) > Math.abs(along)) {
        hoisted.push(sub)
        for (const id of sub) removed.add(id)
      }
    }
  }
  if (hoisted.length === 0) return modules
  const rest = main.filter((id) => !removed.has(id))
  return [rest, ...hoisted, ...modules.slice(1)]
}

/**
 * 按**汇聚子树**切模块（v2.30，2026-09-29 的判据原样保留）。
 *
 * 三步：找核心簇（度数最高且自我连通的那批）→ 认聚集锚（核心第一跳里度数 ≥ 3、且**不是纯中继**
 * 的设备）→ 每棵子树 BFS 扩到全部后代。认不出来时返回 `null`，调用方退回「整块」。
 */
function splitByAggregationSubtrees(ids: string[], ctx: Ctx): string[][] | null {
  if (ids.length < 4) return null
  const deg = (id: string): number => ctx.adj.get(id)?.size ?? 0

  // —— 1. 核心簇：度数最高的那批（必须自我连通、数量不多），否则逐级降标准 ——
  const byDeg = [...ids].sort((a, b) => deg(b) - deg(a) || naturalCompare(a, b))
  const degList = [...new Set(byDeg.map((id) => deg(id)))].filter((d) => d >= 3).sort((a, b) => b - a)
  let cores: string[] = []
  for (const d of degList) {
    const cand = ids.filter((id) => deg(id) >= d)
    if (cand.length > Math.max(2, Math.ceil(ids.length / 6))) continue
    if (!isConnectedSubset(cand, ctx)) continue
    cores = cand
    break
  }
  if (cores.length === 0) return null
  const coreSet = new Set(cores)

  // —— 2. 认领锚（汇聚）——只认核心的**第一跳**里度数 ≥ 3 的设备 ——
  const subOf = new Map<string, string[]>()
  const anchorOf = new Map<string, string>()
  const coreIds: string[] = []
  const claimed = new Set<string>()
  for (const c of cores) {
    coreIds.push(c)
    claimed.add(c)
  }
  const rawFrontier: string[] = []
  for (const c of cores) {
    for (const nb of ctx.adj.get(c) ?? []) {
      if (claimed.has(nb)) continue
      if (deg(nb) < 3) continue // 直接挂在核心上的终端/服务器 → 留核心模块
      claimed.add(nb)
      rawFrontier.push(nb)
    }
  }

  // —— ★ 桥接设备剔除（v2.30）：不是所有「核心第一跳 + 度数 ≥ 3」都是汇聚锚 ——
  //
  // 实测：`AR3`(deg 3) 的非核心邻居只有 `外部网汇聚`(deg 3) 一个、自己不接任何叶子 →
  // 它只是核心与真正汇聚之间的**传输/桥接设备**（transit）。而 `Library`(deg 4) 的下行有
  // `Library-1/Library-2` **两个**汇聚型邻居 → 是真扇出汇聚，**不得**误杀。
  const isHubLike = (id: string): boolean => !coreSet.has(id) && deg(id) >= 3
  const hubNeighborsOf = (id: string): string[] =>
    [...(ctx.adj.get(id) ?? [])].filter((x) => x !== id && !coreSet.has(x) && isHubLike(x))
  const leafNeighborsOf = (id: string): number =>
    [...(ctx.adj.get(id) ?? [])].filter((x) => x !== id && !coreSet.has(x) && !isHubLike(x)).length
  const frontier = rawFrontier.filter((nb) => {
    const hubs = hubNeighborsOf(nb)
    if (hubs.length === 1 && leafNeighborsOf(nb) === 0) return false // 纯中继 → 是桥
    return true
  })
  // 被剔除的桥设备（如 `AR3`）**不认领**，留给核心模块
  for (const b of rawFrontier) {
    if (!frontier.includes(b)) claimed.add(b)
  }

  // 锚之间若相邻（同一层的两个汇聚连在一起，极少见）→ 只保留一个，避免两棵树互相咬
  for (const a of [...frontier].sort((x, y) => deg(y) - deg(x) || naturalCompare(x, y))) {
    if (anchorOf.has(a)) continue
    anchorOf.set(a, a)
    subOf.set(a, [a])
    for (const nb of ctx.adj.get(a) ?? []) {
      if (frontier.includes(nb) && !anchorOf.has(nb)) claimed.add(nb)
    }
  }
  if (subOf.size < 2) return null // 认不出 ≥2 棵子树 → 这张图不是「核心 + 多楼宇」形态

  // —— 3. 每棵子树 BFS 扩到全部后代（撞到别的锚 / 核心就停）——
  for (const anchor of subOf.keys()) {
    const q = [anchor]
    const seen = new Set([anchor])
    while (q.length > 0) {
      const cur = q.shift()!
      for (const nb of ctx.adj.get(cur) ?? []) {
        if (coreSet.has(nb) || seen.has(nb)) continue
        if (anchorOf.has(nb) && anchorOf.get(nb) !== anchor) continue // 已属别的锚 → 停
        if (anchorOf.has(nb)) continue // 已属本锚（多路径重复到达）→ 不重复入队
        seen.add(nb)
        anchorOf.set(nb, anchor)
        subOf.get(anchor)!.push(nb)
        q.push(nb)
      }
    }
  }

  // —— 4. 核心模块：核心簇 + 没被任何子树认领的设备（桥接设备、直挂核心的终端）——
  for (const id of ids) {
    if (anchorOf.has(id)) continue
    coreIds.push(id)
  }

  const out: string[][] = [coreIds.filter((id, i, a) => a.indexOf(id) === i)]
  const anchors = [...subOf.keys()].sort((a, b) => {
    const pa = ctx.src.get(a)
    const pb = ctx.src.get(b)
    if (pa && pb && pa.x !== pb.x) return pa.x - pb.x
    return naturalCompare(a, b)
  })
  for (const a of anchors) out.push([...new Set(subOf.get(a)!)])
  // 每个设备只能属于一个模块：后面的模块里去掉前面已认领的（顺序即优先级）
  const taken = new Set<string>()
  const dedup: string[][] = []
  for (const mod of out) {
    const keep = mod.filter((id) => !taken.has(id))
    for (const id of keep) taken.add(id)
    if (keep.length > 0) dedup.push(keep)
  }
  const lost = ids.filter((id) => !taken.has(id))
  if (lost.length > 0) dedup[0]!.push(...lost)
  if (dedup.length < 2 || dedup[0]!.length === 0) return null
  return dedup
}

// ============================================================================
// 模块的展布轴与方向（侧挂判定用；摆位已不看它）
// ============================================================================

interface AxisInfo {
  axis: SpreadAxis
  /** 子节点相对根的生长方向：+1 = 沿轴正方向（右 / 下），-1 = 负方向（左 / 上） */
  sign: 1 | -1
  /** 源图上「一层」跨多少 px（沿 axis），供子模块的方向判定用 */
  layerStep: number
  /** 模块的根设备 */
  rootId: string
}

/**
 * 模块的**根**（BFS 分层的起点；`bfsLevels` 与侧挂判定都用它）。
 *
 * 判据顺序：
 * 1. **与「本模块度数最大的设备」直接相邻的网关**（router/firewall/cloud，度数 ≥ 3），
 *    度数最大者优先（并列按源图读图次序）—— 只有「贴在核心上的出口设备」才配当根。
 *    「用户那份 31 台」的核心模块里 `AR3`(deg 3) 正好接在 `Core1/Core2`(deg 5) 上 → 选它 ✓；
 * 2. 没有这样的网关 → **度数最大者**（并列时网关角色优先，再按源图读图次序）——
 *    「企业网实例」里 `fwqq`(deg 5) 是上联链中间的一台、离核心还有两跳 → 这一步挑到核心 ✓；
 * 3. 否则用「核心簇」：度数最高的那批**同层互联**、且每台都向外扇出的设备。
 */
function pickRoots(mod: string[], ctx: Ctx): string[] {
  if (mod.length === 0) return []
  const deg = (id: string): number => ctx.adj.get(id)?.size ?? 0
  const readKey = (id: string): number => {
    const p = ctx.src.get(id)
    return p ? p.y * 1e6 + p.x : Number.POSITIVE_INFINITY
  }
  const readOrder = (a: string, b: string): number => {
    const va = readKey(a)
    const vb = readKey(b)
    if (va !== vb) return va < vb ? -1 : 1
    return ctx.nameCmp(a, b)
  }
  const byDeg = (list: string[]): string =>
    [...list].sort((a, b) => deg(b) - deg(a) || readOrder(a, b))[0]!
  const isGateway = (id: string): boolean => {
    const r = ctx.roleOf(id)
    return r === 'router' || r === 'firewall' || r === 'cloud'
  }
  const maxDeg = Math.max(...mod.map(deg))
  const coreSet = new Set(mod.filter((id) => deg(id) === maxDeg))
  const gateways = mod.filter((id) => isGateway(id) && deg(id) >= 3)

  // ① 「贴在核心上、且位于核心上方」的网关 → 它就是整张图的入口。
  const minCoreKey = Math.min(...[...coreSet].map(readKey))
  const upstream = gateways.filter(
    (id) =>
      readKey(id) < minCoreKey && [...(ctx.adj.get(id) ?? [])].some((nb) => coreSet.has(nb))
  )
  if (upstream.length > 0) return [byDeg(upstream)]

  // ② 度数逼近最高的网关 → 它是骨干上的枢纽，比「只连一堆终端的服务器汇聚」更该当根。
  const nearMax = gateways.filter((id) => deg(id) >= maxDeg - 1)
  if (nearMax.length > 0) return [byDeg(nearMax)]

  // ③ 否则用「核心簇」：度数最高的那批同层互联、且每台都向外扇出。
  if (coreSet.size > 0) {
    const cand = [...coreSet]
    if (
      isConnectedSubset(cand, ctx) &&
      cand.every((id) => [...(ctx.adj.get(id) ?? [])].some((nb) => !coreSet.has(nb)))
    ) {
      return cand
    }
  }
  return [byDeg(mod)]
}

/**
 * 判模块的**展布轴 + 生长方向**（只看「根簇 → 第一层」在源图里往哪边长）。
 * 侧挂判定（`hoistLateralSubtrees`）需要它把「侧向」与「纵向」区分开。
 */
function moduleAxisOf(mod: string[], ctx: Ctx): AxisInfo {
  const roots = pickRoots(mod, ctx)
  const rootId = roots[0] ?? ''
  const set = new Set(mod)
  const level = new Map<string, number>()
  const q: string[] = []
  for (const r of roots) {
    level.set(r, 0)
    q.push(r)
  }
  while (q.length > 0) {
    const cur = q.shift()!
    const l = level.get(cur)!
    for (const nb of ctx.adj.get(cur) ?? []) {
      if (!set.has(nb) || level.has(nb)) continue
      level.set(nb, l + 1)
      q.push(nb)
    }
  }
  const L0 = mod.filter((id) => (level.get(id) ?? 0) === 0)
  const L1 = mod.filter((id) => level.get(id) === 1)
  const c0 = centroidOf(L0, ctx)
  const c1 = centroidOf(L1, ctx)
  if (!c0 || !c1) return { axis: 'y', sign: 1, layerStep: 0, rootId }
  const dx = c1.x - c0.x
  const dy = c1.y - c0.y

  // 方向**不明显**时（根簇与第一层的质心几乎重合）→ 退到「源图整体是横的还是竖的」。
  // 门槛取「源包围盒半对角的 10%」：实测「最终」那份 40 台这里只有 14px（半对角 791px）
  // → 判为「无方向」；而「企业网实例」的核心是 112px（半对角 632px）→ 有明显方向。
  const span = sourceSpan(mod, ctx)
  if (Math.max(Math.abs(dx), Math.abs(dy)) < span * 0.1) {
    const all = centroidOf(mod, ctx) ?? c0
    const box = sourceBoxOf(mod, ctx)
    const wx = all.x - c0.x
    const wy = all.y - c0.y
    if (box.w >= box.h) {
      return { axis: 'x', sign: wx < 0 ? -1 : 1, layerStep: Math.abs(wx), rootId }
    }
    return { axis: 'y', sign: wy < 0 ? -1 : 1, layerStep: Math.abs(wy), rootId }
  }

  if (Math.abs(dx) >= Math.abs(dy)) {
    return { axis: 'x', sign: dx < 0 ? -1 : 1, layerStep: Math.abs(dx), rootId }
  }
  return { axis: 'y', sign: dy < 0 ? -1 : 1, layerStep: Math.abs(dy), rootId }
}

/** 模块在源图上的包围盒（宽/高，px）—— 只作「整体朝向」的兜底判据 */
function sourceBoxOf(mod: string[], ctx: Ctx): { w: number; h: number } {
  let x1 = Number.POSITIVE_INFINITY
  let x2 = Number.NEGATIVE_INFINITY
  let y1 = Number.POSITIVE_INFINITY
  let y2 = Number.NEGATIVE_INFINITY
  for (const id of mod) {
    const p = ctx.src.get(id)
    if (!p) continue
    x1 = Math.min(x1, p.x)
    x2 = Math.max(x2, p.x)
    y1 = Math.min(y1, p.y)
    y2 = Math.max(y2, p.y)
  }
  if (!Number.isFinite(x1)) return { w: 0, h: 0 }
  return { w: x2 - x1, h: y2 - y1 }
}
/** 模块源包围盒的半对角（「方向是否明显」的参照尺度） */
function sourceSpan(mod: string[], ctx: Ctx): number {
  const b = sourceBoxOf(mod, ctx)
  return 0.5 * Math.hypot(b.w, b.h)
}

// ============================================================================
// 源坐标骨架：整体等比放大 + 防重叠 + 父居中
// ============================================================================

/** 归到 160 格点（坐标语义 = 设备框中心，必须是 `LAYOUT_GRID` 的整数倍） */
function snapGrid(v: number): number {
  return Math.round(v / LAYOUT_GRID) * LAYOUT_GRID
}

/** 同层相邻两台设备的**最小中心距**（px）：角色档位与「两者半宽之和」取大 */
function minCenterGap(a: string, b: string, ctx: Ctx): number {
  const sa = ctx.size.get(a) ?? { w: LAYOUT_GRID, h: LAYOUT_GRID }
  const sb = ctx.size.get(b) ?? { w: LAYOUT_GRID, h: LAYOUT_GRID }
  return Math.max(pitchCells(ctx.roleOf(a), ctx.roleOf(b)) * LAYOUT_GRID, (sa.w + sb.w) / 2)
}

/**
 * 按某个轴分组（同组 = 同一行 / 同一列），组内按另一轴排序 —— 防重叠就在组内做。
 * 组按坐标升序返回，保证结果确定（不依赖 Map 的插入次序）。
 */
function groupByAxis(pos: Map<string, NodePoint>, key: 'x' | 'y', ctx: Ctx): string[][] {
  const groups = new Map<number, string[]>()
  for (const [id, p] of pos) {
    const arr = groups.get(p[key])
    if (arr) arr.push(id)
    else groups.set(p[key], [id])
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, arr]) =>
      arr.sort((a, b) => {
        const pa = pos.get(a)!
        const pb = pos.get(b)!
        const va = key === 'y' ? pa.x : pa.y
        const vb = key === 'y' ? pb.x : pb.y
        if (va !== vb) return va - vb
        return ctx.nameCmp(a, b)
      })
    )
}

/**
 * 源图骨架的**统一放大倍数**（下限 2）。
 *
 * - **为什么要放大**：源图相邻网络设备只隔 ≈100 单位，而设备框宽 ≈140px —— 1:1 摆上去必然
 *   压框；而我们的格点只有 160px 一档，所以「拉开」只能靠整体放大。
 * - **为什么必须统一**：等比放大是相似变换 —— 列对齐、「父居中于子」逐台不变，长宽比也保住。
 *   分轴各算一个倍数会把图横向拉长（实测长宽比 1.94 → 2.57），一眼就是「和原图不一样」。
 * - **取最小可行值**：行/列的组成会随倍数变化（吸附到格点后相邻关系会变），所以迭代收敛。
 */
function skeletonScaleOf(ids: string[], ctx: Ctx): number {
  let s = SOURCE_SCALE_MIN
  for (let iter = 0; iter < 24; iter++) {
    const pos = new Map<string, NodePoint>()
    for (const id of ids) {
      const p = ctx.src.get(id)!
      pos.set(id, { x: snapGrid(p.x * s), y: snapGrid(p.y * s) })
    }
    let need = s
    // 同一输出行内：x 间距要满足紧凑档（按源 x 的差距反推倍数）。
    // 减去**半格**是给「两端各自吸附到格点」留的余量：连续域满足 320 不代表吸附后还满足，
    // 吸附后的差额由 `separateRows` 兜底（它只会在个别行右推一格）。
    const slack = LAYOUT_GRID / 2
    for (const row of groupByAxis(pos, 'y', ctx)) {
      for (let i = 1; i < row.length; i++) {
        const a = row[i - 1]!
        const b = row[i]!
        const d = ctx.src.get(b)!.x - ctx.src.get(a)!.x
        if (d <= 1e-6) continue
        need = Math.max(need, Math.max(0, minCenterGap(a, b, ctx) - slack) / d)
      }
    }
    // 同一输出列内：y 间距要够「两个设备框半高之和」（不上下压框）
    for (const col of groupByAxis(pos, 'x', ctx)) {
      for (let i = 1; i < col.length; i++) {
        const a = col[i - 1]!
        const b = col[i]!
        const d = ctx.src.get(b)!.y - ctx.src.get(a)!.y
        if (d <= 1e-6) continue
        const sa = ctx.size.get(a) ?? { w: LAYOUT_GRID, h: LAYOUT_GRID }
        const sb = ctx.size.get(b) ?? { w: LAYOUT_GRID, h: LAYOUT_GRID }
        need = Math.max(need, (sa.h + sb.h) / 2 / d)
      }
    }
    if (need <= s + 1e-6) break
    s = need
  }
  return s
}

/** 分量内的层号（从 `pickRoots` 的根并行 BFS）—— 父居中的「下一层直接邻居」靠它定义 */
function bfsLevels(comp: string[], ctx: Ctx): Map<string, number> {
  const set = new Set(comp)
  const level = new Map<string, number>()
  const q: string[] = []
  for (const r of pickRoots(comp, ctx)) {
    level.set(r, 0)
    q.push(r)
  }
  while (q.length > 0) {
    const cur = q.shift()!
    const l = level.get(cur)!
    for (const nb of ctx.adj.get(cur) ?? []) {
      if (!set.has(nb) || level.has(nb)) continue
      level.set(nb, l + 1)
      q.push(nb)
    }
  }
  for (const id of comp) if (!level.has(id)) level.set(id, 0)
  return level
}

/**
 * **防重叠**：同一行（同一个 y）内相邻设备中心距不足 → 把右边那台整格右推。
 *
 * 落格点后**只有同一行才可能压框**（不同行至少差 160px > 设备框高 52px），所以这一步
 * 就是完整的防重叠，不需要动 y（动 y 会破坏源图的分行，反而离原图更远）。
 * 只推右边那台：源图的行内次序与左端起点都不变。
 */
function separateRows(pos: Map<string, NodePoint>, ctx: Ctx): boolean {
  let moved = false
  for (const row of groupByAxis(pos, 'y', ctx)) {
    for (let i = 1; i < row.length; i++) {
      const pa = pos.get(row[i - 1]!)!
      const pb = pos.get(row[i]!)!
      if (pb.x - pa.x >= minCenterGap(row[i - 1]!, row[i]!, ctx)) continue
      pb.x = Math.ceil((pa.x + minCenterGap(row[i - 1]!, row[i]!, ctx)) / LAYOUT_GRID) * LAYOUT_GRID
      moved = true
    }
  }
  return moved
}

/** 某台设备挪过之后是否与别的设备压框 / 同行过近 —— 父居中用它当「能不能动」的闸 */
function collides(id: string, pos: Map<string, NodePoint>, ctx: Ctx): boolean {
  const p = pos.get(id)
  if (!p) return false
  const s = ctx.size.get(id) ?? { w: LAYOUT_GRID, h: LAYOUT_GRID }
  for (const [o, q] of pos) {
    if (o === id) continue
    const so = ctx.size.get(o) ?? { w: LAYOUT_GRID, h: LAYOUT_GRID }
    if (Math.abs(p.x - q.x) < (s.w + so.w) / 2 && Math.abs(p.y - q.y) < (s.h + so.h) / 2) return true
    if (p.y === q.y && Math.abs(p.x - q.x) < minCenterGap(id, o, ctx)) return true
  }
  return false
}

/**
 * 「谁是谁的孩子」——**就近认父**：下一层的设备 n 归给「它在上一层的那些邻居里、
 * 坐标最近的那一台」。
 *
 * 为什么不直接取「上一层的全部邻居」：双归属的图里那样会算错窗口。实测那份 31 台
 * （`Building3/4` 与 `Library` 都同时挂在 `Core1` 与 `Core2` 上）：
 * - 全部邻居：`Core2` 的中点是 `mid(Building3, Library)` = 1120，而源图里它居中于
 *   `mid(Building4, Library)` = 1280 —— 会把一台本来正确的核心挪走 320px；
 * - 就近认父：`Building3→Core1`、`Library→Core2`、`Building4` 两边等距（归读图次序在前的
 *   `Core1`）→ `Core1` 的窗口 = `{Building3, Building4}`（中点 273 = 源图 ✓）、
 *   `Core2` 的窗口 = `{Library}`。
 * 就近认父与「人画图时把每台设备放在它主要连的那台下面」是同一个直觉。
 */
function childSetsOf(
  comp: string[],
  pos: Map<string, NodePoint>,
  ctx: Ctx
): Map<string, string[]> {
  const set = new Set(comp)
  const level = bfsLevels(comp, ctx)
  const downs = new Map<string, string[]>()
  for (const n of comp) {
    const l = level.get(n) ?? 0
    if (l === 0) continue
    const cands = [...(ctx.adj.get(n) ?? [])].filter((m) => set.has(m) && level.get(m) === l - 1)
    if (cands.length === 0) continue
    const p0 = pos.get(n)
    let best = cands[0]!
    let bestD = Number.POSITIVE_INFINITY
    for (const m of cands) {
      const pm = pos.get(m)
      const d = p0 && pm ? Math.hypot(p0.x - pm.x, p0.y - pm.y) : Number.POSITIVE_INFINITY
      if (d < bestD) {
        bestD = d
        best = m
      }
    }
    downs.set(best, [...(downs.get(best) ?? []), n])
  }
  return downs
}

/** 一组设备在源坐标某轴上的跨度（缺源坐标的用当前坐标兜底） */
function sourceSpreadOf(
  ids: string[],
  axis: 'x' | 'y',
  pos: Map<string, NodePoint>,
  ctx: Ctx
): number {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const id of ids) {
    const p = ctx.src.get(id) ?? pos.get(id)
    if (!p) continue
    lo = Math.min(lo, p[axis])
    hi = Math.max(hi, p[axis])
  }
  return Number.isFinite(lo) ? hi - lo : 0
}

/**
 * **终端子节点对齐**：同一台设备名下的多台终端，按源图里的**铺开轴**拉齐到同一行 / 同一列。
 *
 * 要解决的是**吸附误差**：源图里 `SW3` 的三台服务器在 (690 / 705 / 695) —— 本来就是**同一排**，
 * 但等比放大后相邻两台刚好跨在 160 格点的两侧，吸附完一台落到上一行、两台落到下一行
 * （实测「最终」`ftp服务器@1440` 而 `web服务器/DNS服务器@1600`）。用户口径：
 * **「三个子节点要对齐」**。
 *
 * 三条判据：
 * - **铺开轴看源图**：这几台终端在源图里 x 铺得开就是「一排」（拉齐 y），y 铺得开就是
 *   「一列」（拉齐 x）。这样**不会把源图里有意的竖排柱**（如「最终」里 `LSW5` 左边
 *   上下叠放的 `PC4/PC5`）硬掰成一行。
 * - **拉齐后这一排/一列必须互不压框**：判据是「留坐标的那根轴上两两间隔 ≥ 角色档位」。
 *    反例（实测 31 台里的服务器区）：`HTTP服务器/DNS服务器/FTP服务器` 在源图里
 *    x 铺开 69.7、y 铺开 70.9（基本是个斜排），判成「一列」把三台的 x 都拉到 320 之后，
 *    本来分处两行的 `HTTP服务器` 与 `FTP服务器` 会撞在一起，`separateRows` 又把它推到 480 ——
 *    结果比不拉还散。这种「留坐标轴上已经有两台同档」的组合直接整组跳过。
 * - **目标档位取「多数已经在的那一档」**（并列取小的），避免被个别离散值带跑。
 *
 * 只对齐坐标、**不逐台做压框否决** —— 拉齐后的间距交给紧随其后的 `separateRows` 统一收拾，
 * 否则「先拉齐的会把后拉齐的顶掉」，同一排又散开。
 */
function alignTerminalSiblings(pos: Map<string, NodePoint>, comp: string[], ctx: Ctx): boolean {
  const downs = childSetsOf(comp, pos, ctx)
  let moved = false
  for (const ks of downs.values()) {
    const terms = ks.filter((k) => TERMINAL_ROLES.has(ctx.roleOf(k)))
    if (terms.length < 2) continue
    const axis: SpreadAxis =
      sourceSpreadOf(terms, 'x', pos, ctx) >= sourceSpreadOf(terms, 'y', pos, ctx) ? 'y' : 'x'
    // 拉齐后这一排（一列）必须互不压框：留坐标的那根轴上两两间隔要够
    const keep: 'x' | 'y' = axis === 'x' ? 'y' : 'x'
    let blocked = false
    for (let i = 0; i < terms.length && !blocked; i++) {
      for (let j = i + 1; j < terms.length && !blocked; j++) {
        const a = pos.get(terms[i]!)
        const b = pos.get(terms[j]!)
        if (!a || !b) continue
        if (Math.abs(a[keep] - b[keep]) < minCenterGap(terms[i]!, terms[j]!, ctx)) blocked = true
      }
    }
    if (blocked) continue
    const counts = new Map<number, number>()
    for (const k of terms) {
      const v = pos.get(k)?.[axis]
      if (v === undefined) continue
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    if (counts.size <= 1) continue
    let target = Number.NaN
    let best = -1
    for (const v of [...counts.keys()].sort((a, b) => a - b)) {
      const c = counts.get(v)!
      if (c > best) {
        best = c
        target = v
      }
    }
    for (const k of terms) {
      const kp = pos.get(k)
      if (!kp || kp[axis] === target) continue
      kp[axis] = target
      moved = true
    }
  }
  return moved
}

/**
 * **父居中**：父设备在「它的孩子集」（见 `childSetsOf`）上居中。
 *
 * 两档，都只在**孩子全是终端**时动手：
 * - **独苗**：父与子在不铺开的那根轴上对齐（子在正下/正上 → 对齐 x；子在正左/正右 → 对齐 y）
 *   —— 用户口径的「单个终端设备垂直或者水平放置」；
 * - **一排/一列的终端**（`alignTerminalSiblings` 拉齐之后）：父在铺开轴上居中于这排终端。
 *
 * ## 为什么结构设备（交换机/路由器）的孩子不做（重要，别再扩回去）
 *
 * 多子情形依赖「谁是它的孩子」这个判断，而双归属的图里判不准。实测那份 31 台
 * （三栋楼都同时挂在 `Core1` 与 `Core2` 上）：按「下一层邻居」算中点得 `Core2 → 1120`，
 * 而源图里它居中于 `Building4 ↔ Library` 的中点（1280）—— 会把一台**本来正确**的核心挪走
 * 320px；就近认父（`childSetsOf`）能修好这一处，却又把 `Core1` 自己拖偏 480px。
 * 而**等比放大是相似变换**：结构设备之间的「父居中于子」本来就逐台原样保住，不需要二次居中。
 *
 * ## 三条刹车（缺一条都会把图拖离源图，实测逐条踩过）
 *
 * 1. **偏差 ≤ 一格才动**：剩下的偏差只来自「两端各自吸附到 160 格点」，上界正好一格。
 *    偏差更大说明判错了 → 不动。
 * 2. **不挪已经是父设备的子设备**：否则会把 `SW3` 这类结构设备从它的终端上拽走，
 *    而且会和它自己的居中互相推（实测 40 轮收敛不了，两台设备反复换位）。
 * 3. **挪完压框/过近就撤销**：居中不能以压框为代价。
 */
function centerParents(pos: Map<string, NodePoint>, comp: string[], ctx: Ctx): boolean {
  const downs = childSetsOf(comp, pos, ctx)
  const level = bfsLevels(comp, ctx)
  let moved = false
  const order = [...comp].sort((a, b) => (level.get(b) ?? 0) - (level.get(a) ?? 0))
  for (const p of order) {
    const ks = downs.get(p)
    const pp = pos.get(p)
    if (!ks || !pp || ks.length === 0) continue
    if (!ks.every((k) => TERMINAL_ROLES.has(ctx.roleOf(k)))) continue
    if (ks.length === 1) {
      const k = ks[0]!
      const kp = pos.get(k)
      if (!kp) continue
      const dx = Math.abs(pp.x - kp.x)
      const dy = Math.abs(pp.y - kp.y)
      // 子在正上/正下 → 对齐 x；子在正左/正右 → 对齐 y
      const axis: SpreadAxis = dy >= dx ? 'x' : 'y'
      const target = kp[axis]
      if (pp[axis] === target || Math.abs(target - pp[axis]) > LAYOUT_GRID) continue
      // 优先把**子设备**挪到父的正下方/正右侧 —— 它那一行通常更空，而父所在的汇聚层往往挤得
      // 挪不动（实测 `rlb` 想让位 `Client2` 会被同行的 `cwb` 顶住）。
      if (!downs.has(k)) {
        const kBefore = kp[axis]
        kp[axis] = pp[axis]
        if (!collides(k, pos, ctx)) {
          moved = true
          continue
        }
        kp[axis] = kBefore
      }
      const before = pp[axis]
      pp[axis] = target
      if (collides(p, pos, ctx)) pp[axis] = before
      else moved = true
      continue
    }
    // 一排 / 一列的终端：父在铺开轴上居中于它们
    const xs = ks.map((k) => pos.get(k)?.x ?? pp.x)
    const ys = ks.map((k) => pos.get(k)?.y ?? pp.y)
    const sameRow = ys.every((y) => y === ys[0])
    const sameColumn = xs.every((x) => x === xs[0])
    if (!sameRow && !sameColumn) continue
    const axis: SpreadAxis = sameRow ? 'x' : 'y'
    const vals = axis === 'x' ? xs : ys
    const target = snapGrid((Math.min(...vals) + Math.max(...vals)) / 2)
    if (pp[axis] === target || Math.abs(target - pp[axis]) > LAYOUT_GRID) continue
    const before = pp[axis]
    pp[axis] = target
    if (collides(p, pos, ctx)) pp[axis] = before
    else moved = true
  }
  return moved
}

/** 没有源坐标的设备：挂到最近的已定位邻居**下一格**，再靠防重叠 / 父居中修正 */
function placeMissing(comp: string[], pos: Map<string, NodePoint>, ctx: Ctx): void {
  const pending = comp.filter((id) => !pos.has(id))
  while (pending.length > 0) {
    let progressed = false
    for (let i = 0; i < pending.length; ) {
      const id = pending[i]!
      const nb = [...(ctx.adj.get(id) ?? [])].find((o) => pos.has(o))
      if (nb === undefined) {
        i++
        continue
      }
      const base = pos.get(nb)!
      pos.set(id, { x: base.x, y: base.y + LAYER_GAP })
      pending.splice(i, 1)
      progressed = true
    }
    if (!progressed) break // 剩下的整块都没坐标 → 交给出口的兜底
  }
}

/**
 * 源坐标骨架：放大 → 落格点 → 防重叠收敛 → 父居中一遍 → 防重叠再收敛。
 *
 * 三次的顺序不能换：`separateRows` 只右推 x（单调，必然收敛），`centerParents` 只走一遍
 * （见它的注释），最后那次 `separateRows` 负责收掉「居中撞出来的行内过近」。
 */
function skeletonOf(comp: string[], ctx: Ctx, scale: number): Map<string, NodePoint> {
  const pos = new Map<string, NodePoint>()
  for (const id of comp) {
    const p = ctx.src.get(id)
    if (p) pos.set(id, { x: snapGrid(p.x * scale), y: snapGrid(p.y * scale) })
  }
  placeMissing(comp, pos, ctx)
  for (let round = 0; round < SKELETON_MAX_ROUNDS; round++) if (!separateRows(pos, ctx)) break
  // 终端兄弟对齐 + 父居中走几趟：自底向上，下一级的修正会改变上一级的目标。
  // 每次拉齐后都要重新防重叠（拉齐会把同一排挤到一起，交给 separateRows 收拾）。
  for (let pass = 0; pass < 4; pass++) {
    const aligned = alignTerminalSiblings(pos, comp, ctx)
    const centered = centerParents(pos, comp, ctx)
    if (!aligned && !centered) break
    for (let round = 0; round < SKELETON_MAX_ROUNDS; round++) if (!separateRows(pos, ctx)) break
  }
  return pos
}

// ============================================================================
// 连通分量：源坐标骨架 + 分组框
// ============================================================================

interface Block {
  headId: string
  nodeIds: string[]
  title: string
}

/**
 * 一个连通分量的摆位：**源坐标骨架**（设备留在源图的位置上）。
 * 模块划分只用来决定**分组框**的成员与语义标题，不参与摆位。
 */
function layoutComponent(
  comp: string[],
  ctx: Ctx,
  scale: number
): { positions: Map<string, NodePoint>; blocks: Block[] } {
  const titleUsed = new Map<string, number>()
  const blocks: Block[] = splitIntoModules(comp, ctx).map((mod) => {
    const headId = moduleHead(mod, ctx)
    return { headId, nodeIds: [...mod], title: moduleTitle(mod, ctx, headId, titleUsed) }
  })
  return { positions: skeletonOf(comp, ctx, scale), blocks }
}

/**
 * 布局入口 —— 只处理带源坐标的图（调用方 `autoLayout.ts#layoutTopology` 已做判定）。
 *
 * 与前六版的根本差别：**没有模块内部重排、没有模块方位摆开、没有源 x 聚类** ——
 * 设备就留在 eNSP 原图的位置上（整体等比放大 + 落格点 + 防重叠 + 父居中）。
 */
export function layoutTopologyBySource(
  nodes: TopologyNode[],
  links: TopologyLink[],
  options: LayoutOptions = {}
): LayoutModel {
  const positions = new Map<string, NodePoint>()
  if (nodes.length === 0) return { positions, blocks: [] }

  const ctx = buildCtx(nodes, links, options)
  const { components, isolated } = splitComponents(nodes, ctx.adj)

  // —— 源图骨架的**全局统一放大倍数**：所有分量同一倍数 → 分量之间也保住源图的相对方位 ——
  const srcIds = nodes.filter((n) => ctx.src.has(n.id)).map((n) => n.id)
  const scale = srcIds.length >= 2 ? skeletonScaleOf(srcIds, ctx) : SOURCE_SCALE_MIN

  // 分量按源图读图次序排（只影响**分组框的先后**与标题去重的稳定性，不影响坐标）
  components.sort((a, b) => {
    const ca = centroidOf(a, ctx)
    const cb = centroidOf(b, ctx)
    const ya = ca?.y ?? Number.POSITIVE_INFINITY
    const yb = cb?.y ?? Number.POSITIVE_INFINITY
    if (ya !== yb) return ya - yb
    const xa = ca?.x ?? Number.POSITIVE_INFINITY
    const xb = cb?.x ?? Number.POSITIVE_INFINITY
    if (xa !== xb) return xa - xb
    return naturalCompare(a[0] ?? '', b[0] ?? '')
  })

  const rawBlocks: Block[] = []
  let bottom = Number.NEGATIVE_INFINITY
  for (const comp of components) {
    const lay = layoutComponent(comp, ctx, scale)
    for (const [id, p] of lay.positions) {
      positions.set(id, p)
      const s = ctx.size.get(id) ?? { w: LAYOUT_GRID, h: LAYOUT_GRID }
      bottom = Math.max(bottom, p.y + s.h / 2)
    }
    rawBlocks.push(...lay.blocks)
  }

  // —— 孤立设备（度为 0）：整齐的 2D 矩阵收拢在网络底部 ——
  if (isolated.length > 0) {
    const ordered = [...isolated].sort((a, b) => {
      const ta = ROLE_TIER[ctx.roleOf(a)]
      const tb = ROLE_TIER[ctx.roleOf(b)]
      if (ta !== tb) return ta - tb
      return ctx.nameCmp(a, b)
    })
    const cols = Math.min(
      options.isolatedCols ?? DEFAULT_ISOLATED_COLS,
      Math.max(2, Math.ceil(Math.sqrt(ordered.length)))
    )
    // 起始行必须吸附到格点：下面的孤立设备坐标是「startY + 行 × 1 格」，
    // startY 若落在半格上，整批孤立设备就整体偏离 160 格点（破坏「中心落格点」不变式）
    const base = Number.isFinite(bottom) ? bottom : 0
    const startY = Math.ceil((base + LAYER_GAP) / LAYOUT_GRID) * LAYOUT_GRID
    ordered.forEach((id, idx) => {
      positions.set(id, {
        x: (idx % cols) * LAYOUT_GRID * 2,
        y: startY + Math.floor(idx / cols) * LAYOUT_GRID
      })
    })
  }

  // —— 落盘前的不变式保险：**不允许两台设备占同一个点** ——
  // 上面对齐/平移的每一处都在尽力避免重叠，但「两台设备同坐标」是用户一眼就能看见的
  // 硬伤，所以这里再兜一道：撞了就沿 x 让位一格。
  {
    const used = new Set<string>()
    for (const p of positions.values()) {
      while (used.has(`${p.x},${p.y}`)) p.x += LAYOUT_GRID
      used.add(`${p.x},${p.y}`)
    }
  }

  // —— 全局平移到正坐标空间（平移量取整到格点，保证坐标仍落 160 格点）——
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const p of positions.values()) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
  }
  const shiftX = Number.isFinite(minX) ? Math.round((LAYOUT_GRID - minX) / LAYOUT_GRID) * LAYOUT_GRID : 0
  const shiftY = Number.isFinite(minY) ? Math.round((LAYOUT_GRID - minY) / LAYOUT_GRID) * LAYOUT_GRID : 0
  for (const p of positions.values()) {
    p.x = Math.round(p.x + shiftX)
    p.y = Math.round(p.y + shiftY)
  }

  // —— 缺坐标兜底：任何没被摆过的设备（异常数据）也要落到格点上，不能凭空消失 ——
  if (positions.size < nodes.length) {
    let fallbackX = 0
    let fallbackY = 0
    for (const p of positions.values()) {
      fallbackX = Math.max(fallbackX, p.x)
      fallbackY = Math.max(fallbackY, p.y)
    }
    fallbackY += LAYER_GAP
    for (const n of nodes) {
      if (positions.has(n.id)) continue
      positions.set(n.id, { x: fallbackX, y: fallbackY })
      fallbackX += LAYOUT_GRID * 2
    }
  }

  return { positions, blocks: mergeOverlappingBlocks(rawBlocks, ctx, positions) }
}

/**
 * 分组框合并：**框相互压叠的模块并成一个大框**。
 *
 * 为什么必须合并而不是「把框推开」：源坐标骨架下模块在空间上是**咬合**的 —— 核心区横跨整张
 * 图，各汇聚子树就嵌在它中间，「一模块一框」必然互相压。第六版靠「把后一个模块整体右移」
 * 解决，那在骨架方案下会把画布越推越宽（实测教学区 2080 → 4960、某企业网 2400 → 4960，
 * 而且 x 与源坐标的秩相关从 1.0 掉到 0.66）。合并**不动任何设备**，骨架一点不破，框还更接近
 * 用户手画的「几个大区」。
 *
 * 合并后的标题：优先取**语义名**（`服务器区` / `外网` / `图书馆` 这类，不是「×× 区」），
 * 并列时取成员最多的那块；都没有语义名就取最大的那块。原始标题本来就互不相同，
 * 所以合并后的标题也互不相同。
 */
function mergeOverlappingBlocks(
  raw: Block[],
  ctx: Ctx,
  positions: Map<string, NodePoint>
): TopologyBlock[] {
  let list = raw
  for (let iter = 0; iter < 24; iter++) {
    const boxes = computeBlockBoxes(list, ctx.nodeMap, positions)
    if (boxes.length <= 1) return boxes
    const parent = boxes.map((_, i) => i)
    const find = (x: number): number => {
      let r = x
      while (parent[r] !== r) r = parent[r]!
      parent[x] = r
      return r
    }
    let merged = false
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!.box
        const b = boxes[j]!.box
        if (a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y) continue
        const ra = find(i)
        const rb = find(j)
        if (ra !== rb) parent[rb] = ra
        merged = true
      }
    }
    if (!merged) return boxes
    const groups = new Map<number, Block[]>()
    boxes.forEach((_, i) => {
      const r = find(i)
      groups.set(r, [...(groups.get(r) ?? []), list[i]!])
    })
    list = [...groups.values()].map((g) => mergeBlockGroup(g, ctx))
  }
  return computeBlockBoxes(list, ctx.nodeMap, positions)
}

/** 把一组互相压叠的模块并成一个分组框（成员取并集，标题按「语义名优先、其次成员多」挑） */
function mergeBlockGroup(group: Block[], ctx: Ctx): Block {
  const semantic = group.filter((b) => !b.title.endsWith(' 区'))
  const pool = semantic.length > 0 ? semantic : group
  const pick = [...pool].sort(
    (a, b) => b.nodeIds.length - a.nodeIds.length || ctx.nameCmp(a.title, b.title)
  )[0]!
  return {
    headId: pick.headId,
    nodeIds: [...new Set(group.flatMap((b) => b.nodeIds))],
    title: pick.title
  }
}

/**
 * 模块头（分组框标题挂接的设备）：取**连接最多**的那台，其次角色更像入口、其次更靠上。
 * 这样「×× 区」这类兜底标题落到该模块的汇聚设备上（例：`LSW4 区`）。
 */
function moduleHead(mod: string[], ctx: Ctx): string {
  const head = [...mod].sort((a, b) => {
    const da = ctx.adj.get(a)?.size ?? 0
    const db = ctx.adj.get(b)?.size ?? 0
    if (da !== db) return db - da
    const ra = ROLE_RANK[ctx.roleOf(a)]
    const rb = ROLE_RANK[ctx.roleOf(b)]
    if (ra !== rb) return ra - rb
    const ya = ctx.src.get(a)?.y ?? Number.POSITIVE_INFINITY
    const yb = ctx.src.get(b)?.y ?? Number.POSITIVE_INFINITY
    if (ya !== yb) return ya - yb
    return ctx.nameCmp(a, b)
  })[0]
  return head ?? mod[0]!
}

/** 模块标题：命中语义规则用语义名，否则用「模块头设备名 + 区」；重名时追加序号 */
function moduleTitle(mod: string[], ctx: Ctx, headId: string, used: Map<string, number>): string {
  const headName = ctx.nodeMap.get(headId)?.name ?? ''
  let title = ''
  // ⚠️ 语义名不能「任一成员命中就采用」：实测「最终」那份 40 台的大网里有 `分校pc1/2`
  // 两台，整张图就被命名成「分校」；放宽到「≥3 台」仍不行（那图里有 5 台 xx服务器 →
  // 40 台的大网被叫成「服务器区」）。判据取**占三分之一以上**。
  for (const rule of MODULE_TITLE_RULES) {
    const hits = mod.filter((id) => rule.re.test(ctx.nodeMap.get(id)?.name ?? '')).length
    if (hits > 0 && hits * 3 >= mod.length) {
      title = rule.title
      break
    }
  }
  if (!title) title = headName ? `${headName} 区` : '未命名区'
  // 重名去歧义：两张「教学区」并排会让用户分不清是哪一栋，追加「·模块头名」
  const n = (used.get(title) ?? 0) + 1
  used.set(title, n)
  if (n > 1) title = headName ? `${title}（${headName}）` : `${title}${n}`
  return title
}