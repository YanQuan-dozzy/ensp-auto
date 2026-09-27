/**
 * 任务级一键封装工具（v1.8 / 参照 jmsgfc/ensp-mcp 的 execute_task）。
 *
 * 把「执行常见实验」从模型自由发挥变成结构化任务：
 * - execute_task：按 task 类型（pc_connectivity / ospf / vlan / dhcp）生成标准化配置步骤，
 *   逐台走 apply_config 管道（快照 → 危险拦截 → 下发 → 期望校验 → 变更记录），
 *   收尾按需跑 verify_ping。
 * - batch_configure：对多台设备下发各自的命令组，逐台独立快照/校验，单台失败不阻断其余。
 *
 * internals 复用了 applyConfig 的 handler 与 verifyPing 的 handler ——
 * 任务层只负责「生成计划 + 编排执行」，不重复实现安全管道。
 */

import type { Expectation, ToolResult } from '@shared/types'
import { fail, ok, Type, type ToolSpec, type ToolContext } from './registry'
import { applyConfig } from './config'
import { verifyPing } from './verify'
import {
  attachCapture,
  startCapture,
  stopCapture,
  type CaptureOutcome
} from '../core/wireshark/capture'
import {
  planAclNat,
  planDhcp,
  planEthTrunk,
  planOspf,
  planPcConnectivity,
  planRip,
  planStaticRoute,
  planVlan,
  type AclNatSpec,
  type DhcpSpec,
  type EthTrunkSpec,
  type OspfRouterSpec,
  type PcPair,
  type RipRouterSpec,
  type StaticRouteSpec,
  type TaskStep,
  type VlanSwitchSpec
} from '../core/tasks/plans'

// —— schema 片段 ——

const expectationSchema = Type.Object(
  {
    command: Type.String({ description: '校验命令，如 display ospf peer' }),
    expect: Type.String({ description: '期望内容（contains 子串 / regex 正则）' }),
    mode: Type.Union([Type.Literal('contains'), Type.Literal('notContains'), Type.Literal('regex')]),
    times: Type.Optional(Type.Number({ description: '重试次数（含首次），用于等待收敛' }))
  },
  { additionalProperties: false }
)

const ospfNetworkSchema = Type.Object(
  {
    network: Type.String({ description: '宣告网段，如 10.0.12.0' }),
    wildcard: Type.String({ description: '反掩码，如 0.0.0.255 或特定主机 0.0.0.0' }),
    area: Type.Optional(Type.String({ description: '区域，如 0.0.0.0；缺省 area 0.0.0.0' }))
  },
  { additionalProperties: false }
)

const ospfRouterSchema = Type.Object(
  {
    deviceId: Type.String({ description: '路由器设备 ID' }),
    routerId: Type.Optional(Type.String({ description: 'OSPF router-id；缺省按顺序取 X.X.X.X/32 兜底' })),
    loopback: Type.Optional(Type.String({ description: 'LoopBack0 地址；提供则先配回环口' })),
    networks: Type.Array(ospfNetworkSchema, { description: '要在 OSPF 里宣告的网段清单' })
  },
  { additionalProperties: false }
)

const vlanPortSchema = Type.Object(
  {
    port: Type.String({ description: '接口名，如 GigabitEthernet 0/0/1' }),
    vlan: Type.Union([Type.Number(), Type.Array(Type.Number())], {
      description: 'access 的默认 vlan / trunk 放行 vlan 集'
    }),
    mode: Type.Union([Type.Literal('access'), Type.Literal('trunk')], { description: 'access 或 trunk' })
  },
  { additionalProperties: false }
)

const vlanIfSchema = Type.Object(
  {
    vlan: Type.Number({ description: 'VLAN ID' }),
    ip: Type.String({ description: 'Vlanif 地址，如 192.168.10.1' }),
    prefix: Type.Number({ description: '掩码长度，如 24' })
  },
  { additionalProperties: false }
)

const vlanSwitchSchema = Type.Object(
  {
    deviceId: Type.String({ description: '交换机设备 ID' }),
    vlans: Type.Array(Type.Number(), { description: '要创建的 VLAN ID 列表' }),
    ports: Type.Optional(Type.Array(vlanPortSchema, { description: '接口划分（access/trunk）' })),
    vlanifs: Type.Optional(Type.Array(vlanIfSchema, { description: '三层 vlanif 配置' }))
  },
  { additionalProperties: false }
)

const dhcpPoolSchema = Type.Object(
  {
    name: Type.String({ description: '地址池名，如 vlan10' }),
    network: Type.String({ description: '网段，如 192.168.10.0' }),
    prefix: Type.Number({ description: '掩码长度，如 24' }),
    gateway: Type.String({ description: '网关地址，如 192.168.10.1' }),
    dns: Type.Optional(Type.String({ description: 'DNS 服务器，如 223.5.5.5' })),
    rangeStart: Type.Optional(Type.String({ description: '地址段起始（缺省整段）' })),
    rangeEnd: Type.Optional(Type.String({ description: '地址段结束（缺省整段）' }))
  },
  { additionalProperties: false }
)

const pcCheckSchema = Type.Object(
  {
    from: Type.String({ description: '源设备 ID（PC/路由器）' }),
    target: Type.String({ description: '目标 IPv4 地址' })
  },
  { additionalProperties: false }
)

const staticRouteDefSchema = Type.Object(
  {
    destination: Type.String({ description: '目标网段，如 10.0.12.0' }),
    prefix: Type.Number({ description: '掩码长度 1..32' }),
    nextHop: Type.String({ description: '下一跳地址，如 192.168.1.1' })
  },
  { additionalProperties: false }
)

const staticRouteRouterSchema = Type.Object(
  {
    deviceId: Type.String({ description: '路由器设备 ID' }),
    routes: Type.Array(staticRouteDefSchema, { description: '该设备要下发的静态路由清单' })
  },
  { additionalProperties: false }
)

const ripRouterSchema = Type.Object(
  {
    deviceId: Type.String({ description: '路由器设备 ID' }),
    process: Type.Optional(Type.Integer({ description: 'RIP 进程号，缺省 1' })),
    // 协议版本 1 或 2，缺省 2
    version: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])),
    networks: Type.Array(Type.String({ description: '直连网段（不含掩码），如 192.168.1.0' }))
  },
  { additionalProperties: false }
)

const aclBlockSchema = Type.Object(
  {
    number: Type.Number({ description: 'ACL 编号：基本 2000-2999 / 高级 3000-3999' }),
    rules: Type.Array(Type.String(), { description: '完整 rule 行，如 rule 5 permit source 192.168.1.0 0.0.0.255' })
  },
  { additionalProperties: false }
)

const natEasyIpSchema = Type.Object(
  {
    acl: Type.Number({ description: '引用的基本 ACL 编号（须已在 acls 中定义）' }),
    interface: Type.String({ description: '出接口，如 GigabitEthernet 0/0/0' })
  },
  { additionalProperties: false }
)

const natServerSchema = Type.Object(
  {
    interface: Type.String({ description: '出接口，如 GigabitEthernet 0/0/0' }),
    protocol: Type.Union([Type.Literal('tcp'), Type.Literal('udp')]),
    globalPort: Type.Integer({ description: '公网端口 1..65535' }),
    insideAddr: Type.String({ description: '内网服务器地址' }),
    insidePort: Type.Integer({ description: '内网端口 1..65535' })
  },
  { additionalProperties: false }
)

const aclNatDeviceSchema = Type.Object(
  {
    deviceId: Type.String({ description: '设备 ID（路由器/防火墙）' }),
    acls: Type.Optional(Type.Array(aclBlockSchema, { description: '要创建的 ACL（编号 + 规则）' })),
    // Easy IP 上网：nat outbound（引用的 ACL 须已在 acls 中定义）
    easyIp: Type.Optional(natEasyIpSchema),
    natServers: Type.Optional(Type.Array(natServerSchema, { description: '端口映射：nat server' }))
  },
  { additionalProperties: false }
)

const ethTrunkDeviceSchema = Type.Object(
  {
    deviceId: Type.String({ description: '交换机/路由器设备 ID' }),
    trunkId: Type.Optional(Type.Integer({ description: '聚合组号，缺省 1' })),
    // 聚合模式：manual（缺省）或 lacp-static 静态 LACP
    mode: Type.Optional(Type.Union([Type.Literal('manual'), Type.Literal('lacp-static')])),
    members: Type.Array(Type.String({ description: '成员接口，如 GigabitEthernet 0/0/9' }))
  },
  { additionalProperties: false }
)

/**
 * execute_task 的入参 schema。
 *
 * ⚠️ 根**必须**是 object。OpenAI 兼容端点的函数入参校验只认根 `type: 'object'`，
 * 而 `Type.Union([...])` 生成的是 `{ anyOf: [...] }`（没有 type 字段）→ 整轮请求被拒：
 * `400 ... schema must be a JSON Schema of 'type': "object", got 'type': null'`。
 * 这个 400 与「本轮是否要调用 execute_task」无关 —— 只要它在工具表里，每次发消息
 * 都会失败（2026-09-25 用户实测：会话直接不可用，只能靠截图看报错）。
 *
 * 所以这里改成判别式写法：`task` 必填，各分支字段可选 + 在描述里写清归属。
 * 代价是丢掉了「按分支的必填约束」，但：
 * ① 分支参数本来就在 handler 里逐条校验（BAD_PARAM + 可读原因，见 withPlan）；
 * ② 分支字段的合法性由下游 plan* 纯函数兜底；
 * ③ 模型看到的是「先选 task，再按字段说明填」的线性结构，比 anyOf 更好填。
 * 也就是说，这里的宽松是**换来了可用性**，而核约束仍在下游把着。
 */
const executeTaskSchema = Type.Object(
  {
    task: Type.Union(
      [
        Type.Literal('pc_connectivity'),
        Type.Literal('ospf'),
        Type.Literal('vlan'),
        Type.Literal('dhcp'),
        Type.Literal('static_route'),
        Type.Literal('rip'),
        Type.Literal('acl_nat'),
        Type.Literal('eth_trunk')
      ],
      { description: '任务类型；决定下面哪些字段生效（见各字段说明）' }
    ),
    checks: Type.Optional(
      Type.Array(pcCheckSchema, {
        description: 'pc_connectivity：纯连通性验证清单（不下发任何配置），在 from 上 ping target'
      })
    ),
    routers: Type.Optional(
      Type.Array(Type.Union([ospfRouterSchema, staticRouteRouterSchema, ripRouterSchema]), {
        description:
          'ospf / static_route / rip：路由器清单，形状随 task 变化 —— ' +
          'ospf 用 { deviceId, routerId?, loopback?, networks:[{network,wildcard,area?}] }（校验邻居 Full）；' +
          'static_route 用 { deviceId, routes:[{destination,prefix,nextHop}] }（校验路由表命中）；' +
          'rip 用 { deviceId, process?, version?, networks:["192.168.1.0"] }（校验进程存在）'
      })
    ),
    switches: Type.Optional(
      Type.Array(vlanSwitchSchema, { description: 'vlan：交换机清单（vlan batch + 端口划分 + vlanif）' })
    ),
    server: Type.Optional(Type.String({ description: 'dhcp：DHCP 服务器设备 ID（核心交换机/路由器）' })),
    pools: Type.Optional(Type.Array(dhcpPoolSchema, { description: 'dhcp：地址池清单' })),
    bindings: Type.Optional(
      Type.Array(Type.Object({ vlanif: Type.Number() }, { additionalProperties: false }), {
        description: 'dhcp：要启用 dhcp select global 的 vlanif 编号列表'
      })
    ),
    devices: Type.Optional(
      Type.Array(Type.Union([aclNatDeviceSchema, ethTrunkDeviceSchema]), {
        description:
          'acl_nat / eth_trunk：设备清单，形状随 task 变化 —— ' +
          'acl_nat 用 { deviceId, acls?（ACL 规则）, easyIp?（Easy IP 上网）, natServers?（端口映射） }；' +
          'eth_trunk 用 { deviceId, trunkId?, mode?, members:["GigabitEthernet 0/0/9"] }（应成对：两端分别建聚合组并加入成员）'
      })
    )
  },
  { additionalProperties: false }
)

// —— 执行编排 ——

/** 单台设备下发的结果汇总 */
interface DeviceOutcome {
  deviceId: string
  ok: boolean
  applied: number
  /** F5：该台设备本次变更自动采集的快照 ID（整体回滚的输入） */
  snapshotId?: string
  verified?: boolean
  error?: { code: string; message: string }
}

async function runSteps(steps: TaskStep[], ctx: ToolContext): Promise<DeviceOutcome[]> {
  const outcomes: DeviceOutcome[] = []
  for (const step of steps) {
    const r = await applyConfig.handler(
      {
        deviceId: step.deviceId,
        commands: step.commands,
        description: step.description,
        ...(step.expectation ? { expectation: step.expectation as Expectation } : {})
      },
      ctx
    )
    // F5：快照 ID 在 apply_config 的 data 里（成功与失败路径都带），必须一并汇总 ——
    // 否则多台设备任一失败时，前序已成功的设备无从整体回收（只能手动逐台 restore_snapshot）。
    const data = r.data as { applied?: unknown[]; verified?: boolean; snapshotId?: string } | undefined
    outcomes.push({
      deviceId: step.deviceId,
      ok: r.ok,
      applied: data?.applied?.length ?? 0,
      ...(data?.snapshotId ? { snapshotId: data.snapshotId } : {}),
      ...(step.expectation ? { verified: data?.verified } : {}),
      ...(r.ok ? {} : { error: { code: r.error?.code ?? 'UNKNOWN', message: r.error?.message ?? '执行失败' } })
    })
  }
  return outcomes
}

async function runVerifies(
  pairs: PcPair[] | undefined,
  ctx: ToolContext
): Promise<Array<{ from: string; target: string; verdict: string }>> {
  if (!pairs?.length) return []
  const results: Array<{ from: string; target: string; verdict: string }> = []
  for (const p of pairs) {
    const r = await verifyPing.handler({ from: p.from, target: p.target }, ctx)
    results.push({
      from: p.from,
      target: p.target,
      verdict: r.ok ? ((r.data as { verdict?: string } | undefined)?.verdict ?? 'unknown') : 'error'
    })
  }
  return results
}

/** 汇聚任务结果：有任一失败即整体失败，但返回全部明细 */
/**
 * 跑一个计划生成器（plan* 是纯函数），失败一律转 BAD_PARAM。
 *
 * 计划生成器抛错只可能是「入参不合法」（漏了 members、ACL 引用不存在…），
 * 若不接住就会以 `Cannot read properties of undefined` 的形式泄漏给模型（R9）——
 * 模型拿不到可读原因，只能反复重试同一份错误参数。
 */
function withPlan<T>(
  build: () => T,
  t0: number
): { ok: true; plan: T } | { ok: false; result: ToolResult } {
  try {
    return { ok: true, plan: build() }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, result: fail('BAD_PARAM', `任务参数不合法：${message}`, { ms: Date.now() - t0 }) }
  }
}

/**
 * F10：把一次任务包进「抓包生命周期」。
 *
 * 三道闸门缺一不可：① 设置里开了 `wireshark.autoCapture`；② 当前出口有外部 MCP 调用面；
 * ③ 从工具清单里认得出「起抓 / 停抓」这一对。任一不满足就原样跑 ——
 * 抓包是增强项，**绝不允许**因为它让实验本身失败或变慢到不可用。
 *
 * 抓包结论并进结果的 `capture` 字段：停止抓包的输出里通常带 pcap 路径，
 * 交给代理用它已有的 wireshark 工具接着分析（自动「选分析工具 + 拼参数」的猜错成本太高）。
 */
function withAutoCapture<A>(
  label: string,
  handler: (args: A, ctx: ToolContext) => Promise<ToolResult>
): (args: A, ctx: ToolContext) => Promise<ToolResult> {
  return async (args, ctx) => {
    const mcp = ctx.mcp
    if (!mcp || ctx.settings.wireshark?.autoCapture !== true) return handler(args, ctx)
    const session = await startCapture(mcp, label)
    let capture: CaptureOutcome | null = null
    try {
      const res = await handler(args, ctx)
      capture = await stopCapture(mcp, session, label)
      return attachCapture(res, capture)
    } catch (e) {
      // 任务抛错也必须停抓，否则抓包进程会一直挂着（下次再抓就会冲突）
      if (!capture) await stopCapture(mcp, session, label)
      throw e
    }
  }
}

/**
 * F5：从逐台结果里抽出「回滚输入」清单。
 *
 * 失败设备也带上 —— 失败可能发生在中途（部分命令已生效），它的快照同样需要能回收。
 * 用 `ok` 标注该台是否整体成功，交给调用方（或模型）决定回滚哪些。
 */
function snapshotsOf(outcomes: DeviceOutcome[]): Array<{
  deviceId: string
  snapshotId: string
  applied: number
  ok: boolean
}> {
  return outcomes
    .filter((o): o is DeviceOutcome & { snapshotId: string } => !!o.snapshotId)
    .map((o) => ({ deviceId: o.deviceId, snapshotId: o.snapshotId, applied: o.applied, ok: o.ok }))
}

function finish(
  t0: number,
  outcomes: DeviceOutcome[],
  verifies: Array<{ from: string; target: string; verdict: string }>,
  hasConfig: boolean
): ToolResult {
  const failed = outcomes.filter((o) => !o.ok)
  const allOk = failed.length === 0
  const meta = { ms: Date.now() - t0 }
  const snapshots = snapshotsOf(outcomes)
  if (!allOk) {
    return {
      ok: false,
      error: { code: 'TASK_FAILED', message: `任务执行失败：${failed.map((f) => `${f.deviceId}(${f.error?.message ?? 'failed'})`).join('；')}` },
      data: { devices: outcomes, verifies, snapshots } as never,
      meta
    }
  }
  return ok(
    {
      devices: outcomes,
      snapshots,
      ...(hasConfig ? { appliedDevices: outcomes.filter((o) => o.applied > 0).length } : {}),
      ...(verifies.length ? { verifies, allConnected: verifies.every((v) => v.verdict === 'reachable') } : {})
    } as never,
    meta
  )
}

// —— 工具定义 ——

export const executeTask: ToolSpec<{
  task: 'pc_connectivity' | 'ospf' | 'vlan' | 'dhcp' | 'static_route' | 'rip' | 'acl_nat' | 'eth_trunk'
  [k: string]: unknown
}> = {
  name: 'execute_task',
  description:
    '任务级一键执行：按实验类型生成标准化配置并逐台下发校验（复用 apply_config 的安全管道：' +
    '快照 → 危险命令拦截 → 下发 → 期望校验 → 变更记录）。' +
    '支持 pc_connectivity（纯连通性验证，无配置）、ospf（router-id/loopback/宣告）、' +
    'vlan（vlan batch/端口划分/vlanif）、dhcp（地址池 + vlanif 绑定 global）、' +
    'static_route（ip route-static 逐台下发并查路由表命中）、rip（rip 进程/版本/network）、' +
    'acl_nat（ACL 规则 + Easy IP 上网 nat outbound + 端口映射 nat server）、' +
    'eth_trunk（链路聚合：创建聚合组 + 成员 eth-trunk 加入）。' +
    '返回每台设备的应用结果、每台自动快照 ID（snapshots，可直接喂给 rollback_task 整体回滚）与收尾连通性验证。',
  risk: 'write',
  scope: 'device',
  schema: executeTaskSchema,
  summarize: (args, result) => {
    const t = (args as { task?: string }).task ?? '?'
    if (!result.ok) return `任务 ${t} 执行失败`
    const d = result.data as { appliedDevices?: number; verifies?: unknown[] } | undefined
    return `任务 ${t}：下发 ${d?.appliedDevices ?? 0} 台设备${d?.verifies?.length ? `，验证 ${d.verifies.length} 条连通性` : ''}`
  },
  handler: withAutoCapture('execute_task', async (args, ctx) => {
    const t0 = Date.now()
    switch (args.task) {
      case 'pc_connectivity': {
        const built = withPlan(() => planPcConnectivity((args.checks ?? []) as PcPair[]), t0)
        if (!built.ok) return built.result
        const verifies = await runVerifies(built.plan.verifyPairs, ctx)
        const unreachable = verifies.filter((v) => v.verdict !== 'reachable')
        if (unreachable.length) {
          return {
            ok: false,
            error: {
              code: 'VERIFY_FAILED',
              message: `连通性验证未通过：${unreachable.map((v) => `${v.from} → ${v.target}=${v.verdict}`).join('；')}`
            },
            data: { verifies, allConnected: false } as never,
            meta: { ms: Date.now() - t0 }
          }
        }
        return ok({ verifies, allConnected: true } as never, { ms: Date.now() - t0 })
      }
      case 'ospf': {
        const routers = (args.routers ?? []) as OspfRouterSpec[]
        if (!routers.length) return fail('BAD_PARAM', 'ospf 任务需要至少一台路由器', { ms: Date.now() - t0 })
        const built = withPlan(() => planOspf(routers), t0)
        if (!built.ok) return built.result
        const outcomes = await runSteps(built.plan.steps, ctx)
        return finish(t0, outcomes, [], true)
      }
      case 'vlan': {
        const switches = (args.switches ?? []) as VlanSwitchSpec[]
        if (!switches.length) return fail('BAD_PARAM', 'vlan 任务需要至少一台交换机', { ms: Date.now() - t0 })
        const built = withPlan(() => planVlan(switches), t0)
        if (!built.ok) return built.result
        const outcomes = await runSteps(built.plan.steps, ctx)
        return finish(t0, outcomes, [], true)
      }
      case 'dhcp': {
        const spec = args as unknown as DhcpSpec & { server: string; bindings?: Array<{ vlanif: number }> }
        if (!spec.server || !(spec.pools ?? []).length) {
          return fail('BAD_PARAM', 'dhcp 任务需要 server 与至少一个地址池', { ms: Date.now() - t0 })
        }
        const built = withPlan(
          () =>
            planDhcp({
              deviceId: spec.server,
              pools: spec.pools,
              ...(spec.bindings ? { bindings: spec.bindings } : {})
            }),
          t0
        )
        if (!built.ok) return built.result
        const outcomes = await runSteps(built.plan.steps, ctx)
        const verifies = await runVerifies(built.plan.verifyPairs, ctx)
        return finish(t0, outcomes, verifies, true)
      }
      case 'static_route': {
        const routers = (args.routers ?? []) as StaticRouteSpec[]
        if (!routers.length) return fail('BAD_PARAM', 'static_route 任务需要至少一台路由器', { ms: Date.now() - t0 })
        const built = withPlan(() => planStaticRoute(routers), t0)
        if (!built.ok) return built.result
        const outcomes = await runSteps(built.plan.steps, ctx)
        return finish(t0, outcomes, [], true)
      }
      case 'rip': {
        const routers = (args.routers ?? []) as RipRouterSpec[]
        if (!routers.length) return fail('BAD_PARAM', 'rip 任务需要至少一台路由器', { ms: Date.now() - t0 })
        const built = withPlan(() => planRip(routers), t0)
        if (!built.ok) return built.result
        const outcomes = await runSteps(built.plan.steps, ctx)
        return finish(t0, outcomes, [], true)
      }
      case 'acl_nat': {
        const devices = (args.devices ?? []) as AclNatSpec[]
        if (!devices.length) return fail('BAD_PARAM', 'acl_nat 任务需要至少一台设备', { ms: Date.now() - t0 })
        const built = withPlan(() => planAclNat(devices), t0)
        if (!built.ok) return built.result
        const outcomes = await runSteps(built.plan.steps, ctx)
        return finish(t0, outcomes, [], true)
      }
      case 'eth_trunk': {
        const devices = (args.devices ?? []) as EthTrunkSpec[]
        if (!devices.length) return fail('BAD_PARAM', 'eth_trunk 任务需要至少一台设备', { ms: Date.now() - t0 })
        const built = withPlan(() => planEthTrunk(devices), t0)
        if (!built.ok) return built.result
        const outcomes = await runSteps(built.plan.steps, ctx)
        return finish(t0, outcomes, [], true)
      }
      default:
        return fail('BAD_PARAM', `不支持的任务类型：${(args as { task?: string }).task}`, { ms: Date.now() - t0 })
    }
  })
}

// ———————————————————— batch_configure ————————————————————

const batchDeviceSchema = Type.Object(
  {
    deviceId: Type.String({ description: '设备 ID' }),
    commands: Type.Array(Type.String(), { description: '按顺序下发的配置命令' }),
    description: Type.String({ description: '变更意图说明' }),
    expectation: Type.Optional(expectationSchema)
  },
  { additionalProperties: false }
)

export const batchConfigure: ToolSpec<{
  devices: Array<{
    deviceId: string
    commands: string[]
    description: string
    expectation?: Expectation
  }>
}> = {
  name: 'batch_configure',
  description:
    '批量配置：对多台设备分别下发各自命令组。每台设备独立走 apply_config 安全管道' +
    '（快照 → 危险拦截 → 下发 → 可选期望校验），单台失败不阻断其余设备。' +
    '返回逐台结果与整体汇总。',
  risk: 'write',
  scope: 'device',
  schema: Type.Object(
    {
      devices: Type.Array(batchDeviceSchema, { description: '每台设备的下发任务清单' })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    if (!result.ok) return '批量配置有失败'
    const d = result.data as { succeeded?: number; total?: number } | undefined
    return `批量配置：${d?.succeeded ?? 0}/${d?.total ?? args.devices.length} 台成功`
  },
  handler: withAutoCapture('batch_configure', async (args, ctx) => {
    const t0 = Date.now()
    if (!(args.devices ?? []).length) {
      return fail('BAD_PARAM', 'devices 不能为空', { ms: Date.now() - t0 })
    }
    const steps = args.devices.map((d) => ({
      deviceId: d.deviceId,
      commands: d.commands,
      description: d.description,
      ...(d.expectation ? { expectation: d.expectation } : {})
    }))
    const outcomes = await runSteps(steps, ctx)
    const succeeded = outcomes.filter((o) => o.ok).length
    const failed = outcomes.filter((o) => !o.ok)
    const snapshots = snapshotsOf(outcomes)
    if (failed.length) {
      return {
        ok: false,
        error: {
          code: 'PARTIAL_FAILED',
          message: `批量配置 ${succeeded}/${outcomes.length} 成功；失败：${failed.map((f) => f.deviceId).join('、')}`
        },
        data: { total: outcomes.length, succeeded, failed, devices: outcomes, snapshots } as never,
        meta: { ms: Date.now() - t0 }
      }
    }
    return ok({ total: outcomes.length, succeeded, devices: outcomes, snapshots } as never, {
      ms: Date.now() - t0
    })
  })
}