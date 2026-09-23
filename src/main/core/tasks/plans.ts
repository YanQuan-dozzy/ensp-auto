/**
 * 任务计划生成器（纯函数）—— 「任务级一键封装」的底层。
 *
 * 参照 jmsgfc/ensp-mcp 的 execute_task：把常见实验（pc_connectivity / ospf / vlan / dhcp）
 * 由「模型自由发挥拼命令」变成「按结构化输入生成标准化配置步骤」。
 *
 * 每个 PlanResult 只描述「做什么」，不直接触碰设备：
 * - steps：每台设备要下发的命令组（供 execute_task 走 apply_config 管道）
 * - verifyPairs：任务收尾的连通性验证清单
 *
 * 纯函数可单测；命令生成遵循 src/main/skills/builtin.ts 里 ensp-config 的配置规范。
 */

import type { Expectation } from '@shared/types'
import { dottedMask, loopbackIp } from './ipPlan'

export interface TaskStep {
  /** 目标设备 ID */
  deviceId: string
  /** 按顺序下发的配置命令（不含 system-view，由向下管道统一进入） */
  commands: string[]
  /** 变更意图说明（写入变更记录） */
  description: string
  /** 下发成功后的期望校验（等待收敛类场景给 times>1） */
  expectation?: Expectation
}

export interface PcPair {
  /** 源设备 ID */
  from: string
  /** 目标 IPv4 */
  target: string
}

export interface PlanResult {
  steps: TaskStep[]
  /** 收尾连通性验证：from 上 ping target（执行层走 verify_ping） */
  verifyPairs?: PcPair[]
}

// ———————————————————— OSPF ————————————————————

export interface OspfNetwork {
  network: string
  wildcard: string
  area?: string
}

export interface OspfRouterSpec {
  deviceId: string
  /** 缺省用 loopbackIp(index+1).ip 兜底 */
  routerId?: string
  /** LoopBack0 地址；缺省不配置 loopback */
  loopback?: string
  networks: OspfNetwork[]
}

/** 逐台路由器生成 OSPF 配置步骤（含 loopback → router-id → 网络宣告） */
export function planOspf(routers: OspfRouterSpec[]): PlanResult {
  const steps: TaskStep[] = routers.map((r, i) => {
    const routerId = r.routerId ?? loopbackIp(i + 1).ip
    const commands: string[] = []
    if (r.loopback) {
      commands.push(
        'interface LoopBack 0',
        `ip address ${r.loopback} 255.255.255.255`,
        'quit',
        'ospf 1 router-id ' + routerId
      )
    } else {
      commands.push('ospf 1 router-id ' + routerId)
    }
    for (const n of r.networks) {
      const area = n.area ?? '0.0.0.0'
      commands.push(`area ${area}`, `network ${n.network} ${n.wildcard}`)
    }
    commands.push('quit')
    return {
      deviceId: r.deviceId,
      commands,
      description: `OSPF 1 配置（router-id ${routerId}${r.loopback ? `，loopback ${r.loopback}` : ''}）`,
      expectation: {
        command: 'display ospf peer',
        expect: 'Full',
        mode: 'contains' as const,
        times: 3
      }
    }
  })
  return { steps }
}

// ———————————————————— VLAN ————————————————————

export interface VlanPortAssign {
  /** 接口名，如 GigabitEthernet 0/0/1 */
  port: string
  /** access 模式的默认 vlan，或 trunk 允许放行的 vlan 集 */
  vlan: number | number[]
  mode: 'access' | 'trunk'
}

export interface VlanIfSpec {
  vlan: number
  ip: string
  prefix: number
}

export interface VlanSwitchSpec {
  deviceId: string
  /** 创建的 vlan id 列表 */
  vlans: number[]
  ports?: VlanPortAssign[]
  vlanifs?: VlanIfSpec[]
}

/** 逐台交换机生成 VLAN 配置步骤（vlan batch → 端口划分 → vlanif 三层） */
export function planVlan(switches: VlanSwitchSpec[]): PlanResult {
  const steps: TaskStep[] = switches.map((sw) => {
    // 去重 + 升序，避免 `vlan batch 2 2` 之类重复 id；同时不再原地 sort 调用方的数组
    const vlans = [...new Set(sw.vlans)].sort((a, b) => a - b)
    // v1.8：空 vlans → `vlan batch ` 必失败，且 expectation 的 Math.max(...[]) = -Infinity
    // 永远不命中 → apply_config 误报 EXPECTATION_UNMET
    if (vlans.length === 0) {
      throw new Error(`交换机 ${sw.deviceId} 未指定任何 VLAN（vlans 为空），无法生成配置`)
    }
    const commands: string[] = [`vlan batch ${vlans.join(' ')}`]
    for (const p of sw.ports ?? []) {
      const vlanList = Array.isArray(p.vlan) ? p.vlan.join(' ') : `${p.vlan}`
      if (p.mode === 'access') {
        commands.push(
          `interface ${p.port}`,
          'port link-type access',
          `port default vlan ${vlanList}`,
          'quit'
        )
      } else {
        commands.push(
          `interface ${p.port}`,
          'port link-type trunk',
          `port trunk allow-pass vlan ${vlanList}`,
          'quit'
        )
      }
    }
    for (const v of sw.vlanifs ?? []) {
      commands.push(
        `interface Vlanif ${v.vlan}`,
        `ip address ${v.ip} ${dottedMask(v.prefix)}`,
        'quit'
      )
    }
    return {
      deviceId: sw.deviceId,
      commands,
      description: `创建 VLAN ${vlans.join(',')}${sw.ports?.length ? `，划分 ${sw.ports.length} 个接口` : ''}${sw.vlanifs?.length ? `，配置 ${sw.vlanifs.length} 个 vlanif` : ''}`,
      expectation: {
        command: 'display vlan',
        expect: String(vlans[vlans.length - 1]),
        mode: 'contains' as const
      }
    }
  })
  return { steps }
}

// ———————————————————— DHCP ————————————————————

export interface DhcpPoolSpec {
  name: string
  network: string
  prefix: number
  /** 网关地址，如 192.168.10.1 */
  gateway: string
  dns?: string
  /** 起始/结束地址（缺省不写 range，用整段 network） */
  rangeStart?: string
  rangeEnd?: string
}

export interface DhcpBinding {
  /** 绑定到哪个 vlanif（Vlanif N 上执行 dhcp select global） */
  vlanif: number
}

export interface DhcpSpec {
  /** DHCP 服务器设备 ID */
  deviceId: string
  pools: DhcpPoolSpec[]
  /** 接口绑定：在哪些 vlanif 上启用 global 选择 */
  bindings?: DhcpBinding[]
}

/** 在服务器设备上生成 DHCP 配置步骤（dhcp enable → ip pool → vlanif 绑定） */
export function planDhcp(spec: DhcpSpec): PlanResult {
  const commands: string[] = ['dhcp enable']
  for (const p of spec.pools) {
    commands.push(`ip pool ${p.name}`, `network ${p.network} mask ${dottedMask(p.prefix)}`, `gateway-list ${p.gateway}`)
    if (p.rangeStart && p.rangeEnd) {
      commands.push(`range ${p.rangeStart} ${p.rangeEnd}`)
    }
    if (p.dns) commands.push(`dns-list ${p.dns}`)
    commands.push('quit')
  }
  for (const b of spec.bindings ?? []) {
    commands.push(`interface Vlanif ${b.vlanif}`, 'dhcp select global', 'quit')
  }

  const steps: TaskStep[] = [
    {
      deviceId: spec.deviceId,
      commands,
      description: `DHCP 配置：${spec.pools.length} 个地址池${spec.bindings?.length ? `，绑定 ${spec.bindings.length} 个 vlanif` : ''}`,
      expectation: {
        command: 'display ip pool',
        expect: spec.pools[0]?.name ?? '',
        mode: 'contains' as const
      }
    }
  ]
  return { steps, verifyPairs: spec.pools.map((p) => ({ from: spec.deviceId, target: p.gateway })) }
}

// ———————————————————— 静态路由 ————————————————————

export interface StaticRouteDef {
  /** 目标网段，如 10.0.12.0 */
  destination: string
  /** 掩码长度（1..32） */
  prefix: number
  /** 下一跳地址，如 192.168.1.1 */
  nextHop: string
  /** 用途说明（写入变更记录里的路由描述） */
  description?: string
}

export interface StaticRouteSpec {
  deviceId: string
  routes: StaticRouteDef[]
}

/** 逐台路由器生成静态路由配置（ip route-static 目的网段/掩码/下一跳），收尾校验路由表命中首条 */
export function planStaticRoute(routers: StaticRouteSpec[]): PlanResult {
  const steps: TaskStep[] = routers.map((r) => {
    if (!r.routes.length) {
      throw new Error(`设备 ${r.deviceId} 未指定任何静态路由（routes 为空）`)
    }
    const commands: string[] = []
    for (const rt of r.routes) {
      if (!Number.isInteger(rt.prefix) || rt.prefix < 1 || rt.prefix > 32) {
        throw new Error(`静态路由 ${rt.destination} 前缀非法：${rt.prefix}（须为 1..32 整数）`)
      }
      commands.push(`ip route-static ${rt.destination} ${dottedMask(rt.prefix)} ${rt.nextHop}`)
    }
    return {
      deviceId: r.deviceId,
      commands,
      description: `静态路由 ${r.routes.map((x) => `${x.destination}/${x.prefix} → ${x.nextHop}`).join('、')}`,
      expectation: {
        command: 'display ip routing-table',
        expect: `${r.routes[0]!.destination}/${r.routes[0]!.prefix}`,
        mode: 'contains' as const,
        times: 2
      }
    }
  })
  return { steps }
}

// ———————————————————— RIP ————————————————————

export interface RipRouterSpec {
  deviceId: string
  /** RIP 进程号，缺省 1 */
  process?: number
  /** 协议版本 1 或 2，缺省 2 */
  version?: number
  /** 直连网段（不含掩码），如 192.168.1.0 */
  networks: string[]
}

/** 逐台路由器生成 RIP 配置（rip → version → network 宣告），收尾校验 RIP 进程存在 */
export function planRip(routers: RipRouterSpec[]): PlanResult {
  const steps: TaskStep[] = routers.map((r) => {
    if (!r.networks.length) {
      throw new Error(`设备 ${r.deviceId} 未指定 RIP 宣告网段（networks 为空）`)
    }
    const version = r.version === 1 ? 1 : 2
    const process = r.process && Number.isInteger(r.process) && r.process >= 1 ? r.process : 1
    const commands: string[] = [`rip ${process}`, `version ${version}`]
    for (const n of r.networks) commands.push(`network ${n}`)
    commands.push('quit')
    return {
      deviceId: r.deviceId,
      commands,
      description: `RIP ${process} 配置（version ${version}，宣告 ${r.networks.join('、')}）`,
      expectation: {
        command: `display rip ${process}`,
        expect: 'RIP process',
        mode: 'contains' as const
      }
    }
  })
  return { steps }
}

// ———————————————————— ACL + NAT ————————————————————

export interface AclBlock {
  /** ACL 编号：基本 2000-2999 / 高级 3000-3999 */
  number: number
  /** 完整 rule 行，如 'rule 5 permit source 192.168.1.0 0.0.0.255' */
  rules: string[]
}

export interface NatEasyIp {
  /** 引用的基本 ACL 编号（须在 acls 中定义） */
  acl: number
  /** 出接口，如 GigabitEthernet 0/0/0 */
  interface: string
}

export interface NatServer {
  /** 出接口，如 GigabitEthernet 0/0/0 */
  interface: string
  protocol: 'tcp' | 'udp'
  /** 公网端口（global current-interface 上的端口） */
  globalPort: number
  /** 内网服务器地址 */
  insideAddr: string
  /** 内网端口 */
  insidePort: number
}

export interface AclNatSpec {
  deviceId: string
  /** 要创建的 ACL（编号 + 规则列表） */
  acls?: AclBlock[]
  /** Easy IP 上网（nat outbound <acl>） */
  easyIp?: NatEasyIp
  /** 端口映射（nat server） */
  natServers?: NatServer[]
}

/** 逐台设备生成 ACL / NAT 配置；期望校验按配置形态自动选择回显命令 */
export function planAclNat(devices: AclNatSpec[]): PlanResult {
  const steps: TaskStep[] = devices.map((d) => {
    const commands: string[] = []
    const acls = d.acls ?? []
    const natServers = d.natServers ?? []
    const hasAcl = (num: number): boolean => acls.some((a) => a.number === num)

    // 三者全空时无事可做：必须显式报错，否则下面取 acls[0] 会抛
    // 「Cannot read properties of undefined」，代理拿不到可读原因（R9）
    if (!acls.length && !d.easyIp && !natServers.length) {
      throw new Error(
        `设备 ${d.deviceId} 未提供任何 ACL、Easy IP 或 nat server 配置，无法生成 ACL/NAT 任务`
      )
    }

    for (const a of acls) {
      if (!a.rules.length) {
        throw new Error(`设备 ${d.deviceId} 的 ACL ${a.number} 没有规则（rules 为空）`)
      }
      commands.push(`acl number ${a.number}`)
      for (const rule of a.rules) commands.push(rule)
      commands.push('quit')
    }
    if (d.easyIp) {
      if (!hasAcl(d.easyIp.acl)) {
        throw new Error(`Easy IP 引用的 ACL ${d.easyIp.acl} 未在 acls 中定义`)
      }
      commands.push(
        `interface ${d.easyIp.interface}`,
        `nat outbound ${d.easyIp.acl}`,
        'quit'
      )
    }
    for (const s of natServers) {
      if (s.protocol !== 'tcp' && s.protocol !== 'udp') {
        throw new Error(`nat server 协议非法：${s.protocol}（须为 tcp/udp）`)
      }
      if (!Number.isInteger(s.globalPort) || !Number.isInteger(s.insidePort) || s.globalPort < 1 || s.globalPort > 65535 || s.insidePort < 1 || s.insidePort > 65535) {
        throw new Error(`nat server 端口非法：${s.globalPort}/${s.insidePort}（须为 1..65535）`)
      }
      commands.push(
        `interface ${s.interface}`,
        `nat server protocol ${s.protocol} global current-interface ${s.globalPort} inside ${s.insideAddr} ${s.insidePort}`,
        'quit'
      )
    }

    let expectation: Expectation
    if (d.easyIp) {
      expectation = { command: 'display nat outbound', expect: String(d.easyIp.acl), mode: 'contains' as const }
    } else if (natServers.length) {
      expectation = { command: 'display nat server', expect: natServers[0]!.insideAddr, mode: 'contains' as const }
    } else {
      expectation = { command: 'display acl all', expect: `ACL ${acls[0]!.number}`, mode: 'contains' as const }
    }
    return {
      deviceId: d.deviceId,
      commands,
      description: `ACL/NAT 配置（${acls.length} 个 ACL${d.easyIp ? '，Easy IP' : ''}${natServers.length ? `，${natServers.length} 条端口映射` : ''}）`,
      expectation
    }
  })
  return { steps }
}

// ———————————————————— Eth-Trunk ————————————————————

export interface EthTrunkSpec {
  deviceId: string
  /** 聚合组号，缺省 1 */
  trunkId?: number
  /** manual（缺省）/ lacp-static 静态 LACP */
  mode?: 'manual' | 'lacp-static'
  /** 加入聚合的成员接口，如 GigabitEthernet 0/0/9 */
  members: string[]
}

/** 逐台设备生成 Eth-Trunk 链路聚合配置（创建聚合组 → 成员接口 eth-trunk 加入） */
export function planEthTrunk(devices: EthTrunkSpec[]): PlanResult {
  const steps: TaskStep[] = devices.map((d) => {
    if (!d.members.length) {
      throw new Error(`设备 ${d.deviceId} 未指定聚合成员（members 为空）`)
    }
    const trunkId = d.trunkId && Number.isInteger(d.trunkId) && d.trunkId >= 1 ? d.trunkId : 1
    const commands: string[] = [`interface Eth-Trunk ${trunkId}`]
    if (d.mode === 'lacp-static') commands.push('mode lacp-static')
    commands.push('quit')
    for (const m of d.members) {
      commands.push(`interface ${m}`, `eth-trunk ${trunkId}`, 'quit')
    }
    return {
      deviceId: d.deviceId,
      commands,
      description: `创建 Eth-Trunk ${trunkId}（${d.mode === 'lacp-static' ? 'lacp-static' : 'manual'}），加入 ${d.members.length} 个成员`,
      expectation: {
        command: `display eth-trunk ${trunkId}`,
        expect: `Eth-Trunk${trunkId}`,
        mode: 'contains' as const,
        times: 2
      }
    }
  })
  return { steps }
}

// ———————————————————— PC 连通性 ————————————————————

/** pc_connectivity：纯验证任务，无配置步骤 */
export function planPcConnectivity(pairs: PcPair[]): PlanResult {
  return { steps: [], verifyPairs: pairs }
}