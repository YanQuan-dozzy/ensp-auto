import { Type } from './registry'
import { fail, ok, type ToolSpec, type ToolContext } from './registry'
import {
  buildExperimentPlan,
  type ExperimentPlan,
  type TaskKind
} from '../core/tasks/experiment-plan'

/**
 * 实验规划工具（F4，2026-09-26）—— 「目标 → 结构化计划」的转换层。
 *
 * 读取拓扑与目标文本，自动产出：设备编号、互联网段（10.0.AB.0/24）、回环口（X.X.X.X/32）、
 * 主机网段（192.168.<V>.0/24），并组装成**可直接喂给 execute_task 的参数包**。
 *
 * 为什么需要它：execute_task 的参数由模型自己填，IP 规划全靠心算 ——
 * `10.0.1213.0` 这类坏地址是真实发生过的（ipPlan 只能 fail-fast 拦住，拦住了任务还是要重来）。
 * 本工具把地址在本地**算好**，模型只确认不发明。
 *
 * 纯只读：不连接设备、不改配置、不写任何存储。
 */
export const planExperiment: ToolSpec<{
  goal: string
  kind?: TaskKind
  vlans?: number[]
}> = {
  name: 'plan_experiment',
  description:
    '根据拓扑与自然语言实验目标生成本地地址规划与 execute_task 参数包（设备编号 / 互联网段 10.0.AB.x/24 / ' +
    '回环口 X.X.X.X/32 / 主机网段 192.168.<V>.0/24），taskArgs 可原样传给 execute_task 下发。' +
    '在下发任何配置前先用本工具规划，避免手算地址出错；kind 缺省由目标文本推断。纯只读，不碰设备。',
  risk: 'read',
  scope: 'local',
  concurrencySafe: true,
  schema: Type.Object(
    {
      goal: Type.String({
        description: '一句话实验目标，如 "R1 R2 R3 跑 OSPF 全通"、"vlan10/20 划分并互访"、"静态路由全网互通"'
      }),
      kind: Type.Optional(
        Type.Union(
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
          { description: '任务类型；缺省由 goal 文本推断，推断错了显式指定' }
        )
      ),
      vlans: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1, maximum: 4094 }), {
          description: 'vlan/dhcp 场景的 VLAN 清单；缺省 [10, 20]'
        })
      )
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as Partial<ExperimentPlan> | undefined
    return `实验规划：${d?.kind ?? args.kind ?? '?'} · ${d?.numbering?.length ?? 0} 台设备 · ${d?.interlinks?.length ?? 0} 条互联网段`
  },
  handler: async (args, ctx: ToolContext) => {
    const t0 = Date.now()
    const goal = (args?.goal ?? '').trim()
    if (!goal) return fail('BAD_PARAM', 'goal 不能为空：请描述实验目标', { ms: Date.now() - t0 })

    const topo = ctx.topology.snapshot()
    const deviceCount = topo.nodes.filter(
      (n) => n.deviceId && !n.deleted && ['router', 'switch', 'firewall'].includes(n.role)
    ).length
    if (deviceCount === 0) {
      return fail(
        'BAD_PARAM',
        '拓扑为空：先用 scan_devices / connect_device 连接设备，或 import_topology_file 导入拓扑，再运行规划。',
        { ms: Date.now() - t0 }
      )
    }

    const plan = buildExperimentPlan(topo, goal, {
      ...(args?.kind ? { kind: args.kind } : {}),
      ...(args?.vlans?.length ? { vlans: args.vlans } : {})
    })

    return ok(
      {
        kind: plan.kind,
        kindInferred: plan.kindInferred,
        numbering: plan.numbering,
        interlinks: plan.interlinks,
        loopbacks: plan.loopbacks,
        hostSegments: plan.hostSegments,
        taskArgs: plan.taskArgs,
        notes: plan.notes,
        warnings: plan.warnings
      },
      { ms: Date.now() - t0 }
    )
  }
}
