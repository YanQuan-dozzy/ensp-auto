/**
 * plan_experiment 底层规划器（F4，2026-09-26）—— 纯函数。
 *
 * 目标：把「拓扑 + 自然语言目标」变成可直接喂给 `execute_task` 的参数包。
 * 它治的是 execute_task 的已知痛点 —— 模型自己填参数时把地址抄错
 * （`10.0.1213.0` 就是真实翻车案例，ipPlan 因此加了 fail-fast）。
 * 规划器在这里把地址**算出来**，模型只负责确认与微调。
 *
 * 约定与 skills/builtin.ts 的 ip-planning 一致：
 * - 互联网段 10.0.AB.x/24（A、B 为设备编号，低侧 .1 高侧 .2，`interlinkPair`）
 * - 回环口 X.X.X.X/32（`loopbackIp`）
 * - 主机网段 192.168.<V>.0/24（V = VLAN ID），网关 .1，PC 从 .10 起（`hostInNetwork`）
 *
 * 不碰设备、不改任何存储：拓扑作为入参传入，返回纯数据。
 * 纯函数可进 harness 单测。
 */

import { hostInNetwork, interlinkPair, loopbackIp } from './ipPlan'
import type { Topology, TopologyNode, TopologyLink } from '@shared/types'

export type TaskKind =
  | 'pc_connectivity'
  | 'ospf'
  | 'vlan'
  | 'dhcp'
  | 'static_route'
  | 'rip'
  | 'acl_nat'
  | 'eth_trunk'

/** 从目标文本推断任务类型的关键词表（顺序即优先级） */
const KIND_HINTS: Array<{ kind: TaskKind; words: string[] }> = [
  { kind: 'ospf', words: ['ospf', '开放式最短路径', '动态路由'] },
  { kind: 'dhcp', words: ['dhcp', '地址池', '自动获取', '自动分配'] },
  { kind: 'static_route', words: ['静态路由', 'route-static', '默认路由', '缺省路由'] },
  { kind: 'rip', words: ['rip', '路由信息协议'] },
  { kind: 'acl_nat', words: ['acl', '过滤', 'nat', '上网', '地址转换', '端口映射'] },
  { kind: 'eth_trunk', words: ['eth-trunk', 'eth_trunk', '链路聚合', '聚合链路', 'lacp'] },
  { kind: 'vlan', words: ['vlan', '交换机划分', '端口划分', 'access', 'trunk'] },
  { kind: 'pc_connectivity', words: ['连通', '互通', 'ping', '互通性'] }
]

/** 从目标文本推断任务类型；无命中时回退 pc_connectivity（最保守，不下发配置） */
export function inferKind(goal: string): TaskKind {
  const q = goal.toLowerCase()
  for (const { kind, words } of KIND_HINTS) {
    if (words.some((w) => q.includes(w))) return kind
  }
  return 'pc_connectivity'
}

/** 提取设备编号：取名称末尾的数字（R1→1、AR2→2、Core-SW3→3）；无数字返回 null */
export function deviceNumber(name: string): number | null {
  const m = /(\d+)\s*$/.exec(name.trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

export interface NumberedDevice {
  deviceId: string
  name: string
  role: string
  /** 规划编号：名称带数字用原值，否则顺延编号；loopback/互联网段都以它为基准 */
  num: number
}

export interface PlannedLinkEnd {
  deviceId: string
  name: string
  num: number
  ip: string
  port?: string
}

export interface PlannedLink {
  a: PlannedLinkEnd
  b: PlannedLinkEnd
  network: string
  mask: string
  scheme: string
  /** 编号拼段非法（10.0.AB > 255）时该链路只给警告不出网段 */
  skipped?: string
}

export interface PlannedLoopback {
  deviceId: string
  name: string
  num: number
  ip: string
  mask: string
}

export interface PlannedHostSegment {
  vlan: number
  network: string
  mask: string
  /** 网关（三层网关 vlanif 地址，.1） */
  gateway: string
  /** 主机起始地址（.10 起，供 PC 手工配置或 DHCP 池参考） */
  hostStart: string
}

export interface ExperimentPlan {
  kind: TaskKind
  /** kind 是否由目标文本推断（false = 调用方显式指定） */
  kindInferred: boolean
  numbering: NumberedDevice[]
  interlinks: PlannedLink[]
  loopbacks: PlannedLoopback[]
  hostSegments: PlannedHostSegment[]
  /** 可直接喂给 execute_task 的参数包（task 字段 + 对应分支字段） */
  taskArgs: Record<string, unknown>
  /** 规划摘要（人可读，模型可据此向用户复述方案） */
  notes: string[]
  /** 需要用户确认/补齐的点（编号冲突、端口缺失、意图不明） */
  warnings: string[]
}

/** 解析链路 label「本端接口 ↔ 对端接口」（多条用 " / " 合并，取第一条） */
export function parseLinkPorts(label: string | undefined): { from?: string; to?: string } {
  if (!label) return {}
  // 必须按「 / 」（空格+斜杠+空格）切多对，绝不能按 '/' 切 ——
  // 接口名自带斜杠（GE0/0/0），按 '/' 切会把单对标注打散成 'GE0' 这样的碎片。
  // 与渲染层 portLabel.ts#splitPortLabel 同一约定（构造见 fromProjectFile.ts / fromNeighbors.ts）。
  const first = label.split(' / ')[0] ?? ''
  const [from, to] = first.split('↔')
  const clean = (s?: string): string | undefined => (s && s.trim() ? s.trim() : undefined)
  return { from: clean(from), to: clean(to) }
}

/**
 * BFS 首跳：从 from 到 to，返回「从 from 出发的第一个邻居」的设备 ID。
 * 同网段不可达（图不连通）返回 null。
 */
export function routeFirstHop(
  from: string,
  to: string,
  adjacency: Map<string, Map<string, { port?: string }>>
): string | null {
  if (from === to) return null
  const visited = new Set<string>([from])
  // 队列元素：当前节点 + 到达它所经过的「从 from 出发的第一个邻居」
  const queue: Array<{ node: string; firstHop: string | null }> = [{ node: from, firstHop: null }]
  while (queue.length > 0) {
    const cur = queue.shift()
    if (!cur) break
    for (const nb of adjacency.get(cur.node)?.keys() ?? []) {
      if (visited.has(nb)) continue
      const hop = cur.firstHop ?? nb
      if (nb === to) return hop
      visited.add(nb)
      queue.push({ node: nb, firstHop: hop })
    }
  }
  return null
}

interface PlanContext {
  numbering: NumberedDevice[]
  interlinks: PlannedLink[]
  loopbacks: PlannedLoopback[]
  hostSegments: PlannedHostSegment[]
  /** 设备级邻接表（deviceId → 邻居 → 本端端口） */
  adjacency: Map<string, Map<string, { port?: string }>>
  /** 原始拓扑链路（含 PC 等未编号端点） */
  rawLinks: TopologyLink[]
  /** 拓扑里 PC 节点的 id 集（hostName:xxx 或 neighbor:xxx） */
  pcNodeIds: Set<string>
  warnings: string[]
  notes: string[]
}

/**
 * 主规划入口。
 *
 * @param topology 合并后的拓扑（`TopologyStore.snapshot()` 的产物）
 * @param goal 自然语言目标（用于推断 kind）
 * @param opts.kind 显式指定 kind（跳过推断）
 * @param opts.vlans vlan/dhcp 场景的 VLAN 清单；缺省 [10, 20]
 */
export function buildExperimentPlan(
  topology: Topology,
  goal: string,
  opts?: { kind?: TaskKind; vlans?: number[] }
): ExperimentPlan {
  const warnings: string[] = []
  const notes: string[] = []

  // —— 1) 参与规划的设备：有 deviceId 的网络设备（PC/Cloud 是纯展示节点，不编号）——
  const devices = topology.nodes.filter(
    (n: TopologyNode) =>
      n.deviceId && !n.deleted && ['router', 'switch', 'firewall'].includes(n.role)
  )
  if (devices.length === 0) {
    warnings.push('拓扑里没有可规划的网络设备（router/switch/firewall）。请先连接设备或导入拓扑，再运行规划。')
  }

  // —— 2) 编号：名称末尾数字优先；冲突/缺号顺延兜底 ——
  const usedNums = new Set<number>()
  let nextSeq = 1
  const pickSeq = (): number => {
    while (usedNums.has(nextSeq)) nextSeq++
    return nextSeq++
  }
  const numbering: NumberedDevice[] = devices.map((d) => {
    const raw = deviceNumber(d.name)
    if (raw !== null && raw <= 255 && !usedNums.has(raw)) {
      usedNums.add(raw)
      return { deviceId: d.id, name: d.name, role: d.role, num: raw }
    }
    const num = pickSeq()
    if (raw !== null) {
      warnings.push(`设备「${d.name}」编号 ${raw} 冲突或超出 1..255，已顺延为 ${num}（名称与编号将不一致，建议重命名设备）`)
    }
    usedNums.add(num)
    return { deviceId: d.id, name: d.name, role: d.role, num }
  })
  const numOf = new Map(numbering.map((n) => [n.deviceId, n]))

  // —— 3) 互联网段：拓扑链路两端都是已编号设备才规划 ——
  const interlinks: PlannedLink[] = []
  const adjacency = new Map<string, Map<string, { port?: string }>>()
  for (const l of topology.links) {
    if (l.deleted) continue
    const na = numOf.get(l.from)
    const nb = numOf.get(l.to)
    if (!na || !nb) continue
    const ports = parseLinkPorts(l.label)
    // 邻接表（静态路由 BFS 用）；同一对设备多条链路只记首条端口
    if (!adjacency.has(l.from)) adjacency.set(l.from, new Map())
    const am = adjacency.get(l.from)
    if (am && !am.has(l.to)) am.set(l.to, { port: ports.from })
    if (!adjacency.has(l.to)) adjacency.set(l.to, new Map())
    const bm = adjacency.get(l.to)
    if (bm && !bm.has(l.from)) bm.set(l.from, { port: ports.to })

    const lo = Math.min(na.num, nb.num)
    const hi = Math.max(na.num, nb.num)
    let network = ''
    let mask = ''
    let scheme = ''
    try {
      const p = interlinkPair(lo, hi)
      network = p.network
      mask = p.mask
      scheme = p.scheme
    } catch (e) {
      warnings.push(
        `链路 ${na.name}–${nb.name}：${e instanceof Error ? e.message : String(e)}。该链路未产出网段，请调整设备编号后重试。`
      )
      interlinks.push({
        a: { deviceId: na.deviceId, name: na.name, num: na.num, ip: '', ...(ports.from ? { port: ports.from } : {}) },
        b: { deviceId: nb.deviceId, name: nb.name, num: nb.num, ip: '', ...(ports.to ? { port: ports.to } : {}) },
        network: '',
        mask: '',
        scheme: '',
        skipped: 'invalid-segment'
      })
      continue
    }
    // 低编号侧取 .1、高编号侧取 .2（与 ip-planning 技能口径一致）
    const [loDev, hiDev] = na.num < nb.num ? [na, nb] : [nb, na]
    const [loPort, hiPort] = na.num < nb.num ? [ports.from, ports.to] : [ports.to, ports.from]
    interlinks.push({
      a: {
        deviceId: loDev.deviceId,
        name: loDev.name,
        num: loDev.num,
        ip: `10.0.${lo}${hi}.1`,
        ...(loPort ? { port: loPort } : {})
      },
      b: {
        deviceId: hiDev.deviceId,
        name: hiDev.name,
        num: hiDev.num,
        ip: `10.0.${lo}${hi}.2`,
        ...(hiPort ? { port: hiPort } : {})
      },
      network,
      mask,
      scheme
    })
  }

  // —— 4) 回环口：路由器/防火墙按编号 X.X.X.X/32 ——
  const loopbacks: PlannedLoopback[] = []
  for (const n of numbering) {
    if (n.role !== 'router' && n.role !== 'firewall') continue
    try {
      const lp = loopbackIp(n.num)
      loopbacks.push({ deviceId: n.deviceId, name: n.name, num: n.num, ip: lp.ip, mask: lp.mask })
    } catch (e) {
      warnings.push(`「${n.name}」回环口规划失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // —— 5) 主机网段（vlan/dhcp）：192.168.<V>.0/24，网关 .1，主机 .10 起 ——
  const vlans = (opts?.vlans ?? [10, 20]).filter((v) => Number.isInteger(v) && v >= 1 && v <= 4094)
  const hostSegments: PlannedHostSegment[] = vlans.map((v) => {
    const seg = hostInNetwork(`192.168.${v}.0`, 24, 10)
    return {
      vlan: v,
      network: `192.168.${v}.0`,
      mask: seg.mask,
      gateway: `192.168.${v}.1`,
      hostStart: seg.ip
    }
  })

  // —— 6) kind 推断与 taskArgs 组装 ——
  const kind = opts?.kind ?? inferKind(goal)
  const kindInferred = opts?.kind === undefined

  const pcNodeIds = new Set(
    topology.nodes.filter((n) => !n.deleted && (n.role === 'pc' || n.role === 'server')).map((n) => n.id)
  )
  const ctx: PlanContext = {
    numbering,
    interlinks,
    loopbacks,
    hostSegments,
    adjacency,
    rawLinks: topology.links.filter((l) => !l.deleted),
    pcNodeIds,
    warnings,
    notes
  }
  const taskArgs = buildTaskArgs(kind, ctx)

  // —— 7) 摘要与提示 ——
  notes.push(
    `已按拓扑规划 ${numbering.length} 台设备、${interlinks.filter((l) => !l.skipped).length} 条互联网段、` +
      `${loopbacks.length} 个回环口` +
      (hostSegments.length > 0 ? `、${hostSegments.length} 个主机网段` : '') +
      `；任务类型 ${kind}${kindInferred ? '（由目标文本推断，可用 kind 参数显式指定）' : ''}。`
  )
  const missingPorts = interlinks.filter((l) => !l.skipped && (!l.a.port || !l.b.port))
  if (missingPorts.length > 0) {
    warnings.push(
      `${missingPorts.length} 条链路缺端口信息（拓扑层未给出接口标签）——配置时先用 get_device_context 核对接口名。`
    )
  }
  if (kind === 'vlan' || kind === 'dhcp') {
    notes.push('主机网段按 192.168.<VLAN>.0/24 规划，网关取 .1（三层网关 vlanif 地址），PC 从 .10 起手配或由 DHCP 分配。')
  }
  if (kind === 'acl_nat' || kind === 'eth_trunk') {
    warnings.push(
      `${kind} 的规则/成员口依赖具体意图（ACL 条目、聚合成员口），参数包只含地址规划骨架，下发前需补齐。`
    )
  }

  return { kind, kindInferred, numbering, interlinks, loopbacks, hostSegments, taskArgs, notes, warnings }
}

/** 一条静态路由的参数（destination/prefix/nextHop）—— static_route 参数包的行单元 */
interface StaticRoute {
  destination: string
  prefix: number
  nextHop: string
}

function buildTaskArgs(kind: TaskKind, ctx: PlanContext): Record<string, unknown> {
  const valid = ctx.interlinks.filter((l) => !l.skipped)
  const devById = new Map(ctx.numbering.map((n) => [n.deviceId, n]))
  const loopByDev = new Map(ctx.loopbacks.map((l) => [l.deviceId, l]))

  switch (kind) {
    case 'ospf': {
      // 每台路由器/防火墙宣告自己参与的互联网段 + 回环 /32；switch 不跑 OSPF（实验网惯例）
      const routers = ctx.numbering
        .filter((n) => n.role === 'router' || n.role === 'firewall')
        .map((n) => {
          const networks = valid
            .filter((l) => l.a.deviceId === n.deviceId || l.b.deviceId === n.deviceId)
            .map((l) => ({ network: l.network, wildcard: '0.0.0.255', area: '0.0.0.0' }))
          const lp = loopByDev.get(n.deviceId)
          if (lp) networks.push({ network: lp.ip, wildcard: '0.0.0.0', area: '0.0.0.0' })
          return {
            deviceId: n.deviceId,
            ...(lp ? { routerId: lp.ip, loopback: lp.ip } : {}),
            networks
          }
        })
      ctx.notes.push('OSPF 参数包：router-id 与回环口统一取 X.X.X.X；宣告覆盖全部互联网段与回环 /32。')
      return { task: 'ospf', routers }
    }
    case 'static_route': {
      // 对每台设备：到「非直连」的互联网段 + 他人回环 /32；nextHop = BFS 首跳邻居在本链路上的地址
      const routers = ctx.numbering
        .map((n) => {
          const routes: StaticRoute[] = []
          // 目标：互联网段（端点含自己 → 直连，跳过）+ 他人回环
          const targets: Array<{ destination: string; prefix: number; ownerId: string }> = []
          for (const l of valid) {
            if (l.a.deviceId === n.deviceId || l.b.deviceId === n.deviceId) continue
            targets.push({ destination: l.network, prefix: 24, ownerId: l.a.deviceId })
          }
          for (const lp of ctx.loopbacks) {
            if (lp.deviceId !== n.deviceId) targets.push({ destination: lp.ip, prefix: 32, ownerId: lp.deviceId })
          }
          for (const t of targets) {
            const hopDevId = routeFirstHop(n.deviceId, t.ownerId, ctx.adjacency)
            if (!hopDevId) continue
            const hopLink = valid.find(
              (l) =>
                (l.a.deviceId === n.deviceId && l.b.deviceId === hopDevId) ||
                (l.b.deviceId === n.deviceId && l.a.deviceId === hopDevId)
            )
            if (!hopLink) continue
            // 下一跳 = 邻居在本链路上的地址：a 端是低编号侧（.1），b 端是高编号侧（.2）。
            // 我在 a 端 → 邻居是 b；我在 b 端 → 邻居是 a。方向反了会把**自己的地址**
            // 写成下一跳，路由永远不通 —— 这是单测抓出来的真 bug（2026-09-27）。
            const nextHop = hopLink.a.deviceId === n.deviceId ? hopLink.b.ip : hopLink.a.ip
            routes.push({ destination: t.destination, prefix: t.prefix, nextHop })
          }
          return routes.length > 0 ? { deviceId: n.deviceId, routes } : null
        })
        .filter((r): r is { deviceId: string; routes: StaticRoute[] } => r !== null)
      ctx.notes.push('静态路由参数包：按 BFS 最短路径生成到各非直连网段/回环的路由。')
      return { task: 'static_route', routers }
    }
    case 'rip': {
      // RIP 按主类宣告：10.x → 10.0.0.0，回环 X.X.X.X → X.0.0.0
      const classful = (ip: string): string => `${ip.split('.')[0]}.0.0.0`
      const routers = ctx.numbering
        .filter((n) => n.role === 'router' || n.role === 'firewall')
        .map((n) => {
          const nets = new Set<string>()
          for (const l of valid) {
            if (l.a.deviceId === n.deviceId || l.b.deviceId === n.deviceId) nets.add('10.0.0.0')
          }
          const lp = loopByDev.get(n.deviceId)
          if (lp) nets.add(classful(lp.ip))
          return { deviceId: n.deviceId, version: 2 as const, networks: [...nets] }
        })
      ctx.notes.push('RIP 参数包：version 2、network 按**主类**网段宣告（10.0.0.0 / X.0.0.0）。')
      return { task: 'rip', routers }
    }
    case 'vlan': {
      // 交换机：vlan batch + 主机网段 vlanif + 交换机级联 trunk；交换机↔PC 链路给 access 建议
      const switches = ctx.numbering.filter((n) => n.role === 'switch')
      const swList = switches.map((sw) => {
        const ports: Array<{ port: string; vlan: number | number[]; mode: 'access' | 'trunk' }> = []
        for (const l of valid) {
          const isA = l.a.deviceId === sw.deviceId
          if (!isA && l.b.deviceId !== sw.deviceId) continue
          const port = isA ? l.a.port : l.b.port
          const other = isA ? devById.get(l.b.deviceId) : devById.get(l.a.deviceId)
          if (!port || !other) continue
          if (other.role === 'switch') {
            ports.push({ port, vlan: ctx.hostSegments.map((h) => h.vlan), mode: 'trunk' })
          }
        }
        const vlanifs = ctx.hostSegments.map((h) => ({ vlan: h.vlan, ip: h.gateway, prefix: 24 }))
        return { deviceId: sw.deviceId, vlans: ctx.hostSegments.map((h) => h.vlan), ports, vlanifs }
      })
      const accessNotes: string[] = []
      for (const l of ctx.rawLinks) {
        const swDev = ctx.numbering.find((n) => n.deviceId === l.from || n.deviceId === l.to)
        if (!swDev || swDev.role !== 'switch') continue
        const other = l.from === swDev.deviceId ? l.to : l.from
        if (!ctx.pcNodeIds.has(other)) continue
        const { from, to } = parseLinkPorts(l.label)
        const port = l.from === swDev.deviceId ? from : to
        if (port) {
          accessNotes.push(
            `「${swDev.name}」的 ${port} 接 PC（建议 access 划入 VLAN ${ctx.hostSegments[0]?.vlan ?? 10}，可在下发前调整）`
          )
        }
      }
      if (accessNotes.length > 0) ctx.notes.push(`PC 接入口建议：${accessNotes.join('；')}。`)
      return { task: 'vlan', switches: swList }
    }
    case 'dhcp': {
      const switches = ctx.numbering.filter((n) => n.role === 'switch')
      // 服务器选连接数最多的交换机（核心交换机惯例）
      const degree = new Map<string, number>()
      for (const l of valid) {
        degree.set(l.a.deviceId, (degree.get(l.a.deviceId) ?? 0) + 1)
        degree.set(l.b.deviceId, (degree.get(l.b.deviceId) ?? 0) + 1)
      }
      const server =
        [...switches].sort((x, y) => (degree.get(y.deviceId) ?? 0) - (degree.get(x.deviceId) ?? 0))[0]
          ?.deviceId ?? ctx.numbering[0]?.deviceId
      const pools = ctx.hostSegments.map((h) => ({
        name: `vlan${h.vlan}`,
        network: h.network,
        prefix: 24,
        gateway: h.gateway,
        dns: '223.5.5.5'
      }))
      const bindings = ctx.hostSegments.map((h) => ({ vlanif: h.vlan }))
      if (!server) ctx.warnings.push('拓扑里没有交换机可作 DHCP 服务器，参数包不完整，请指定 server。')
      return { task: 'dhcp', server, pools, bindings }
    }
    case 'eth_trunk': {
      ctx.notes.push('聚合成员口需按实际意图填写 members（成对的两端分别建聚合组）。')
      return { task: 'eth_trunk', devices: ctx.numbering.map((n) => ({ deviceId: n.deviceId, members: [] })) }
    }
    case 'acl_nat':
    case 'pc_connectivity':
    default:
      ctx.notes.push(
        kind === 'pc_connectivity'
          ? '连通性验证需要具体的 from/target 对：设备间用 deviceId+对方接口 IP，PC 侧先按主机网段手工配地址。'
          : 'acl_nat 需要具体的 ACL 条目与出接口，参数包只含地址规划。'
      )
      return { task: kind }
  }
}
