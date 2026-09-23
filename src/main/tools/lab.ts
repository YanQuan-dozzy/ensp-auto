import fs from 'node:fs'
import path from 'node:path'
import { buildLabGuide } from '../core/lab/guide'
import { fail, ok, Type, type ToolSpec } from './registry'
import { safeFileName } from '@shared/naming'

/**
 * 备课文档导出（v1.8 / 参照 ensp-skills 的 ensp-lab-authoring Phase 5「产出教程」）。
 *
 * export_lab_guide：把当前拓扑 + 设备清单 + 可选规划/步骤/验证清单排版成 markdown，
 * 写入 userData/exports/lab-guides/，返回文件路径。生成逻辑在 core/lab/guide.ts（纯函数）。
 */

export const exportLabGuide: ToolSpec<{
  title: string
  objective?: string
  ipPlan?: Array<{ device: string; iface: string; ip: string; purpose?: string }>
  steps?: string[]
  checks?: Array<{ from: string; target: string }>
}> = {
  name: 'export_lab_guide',
  description:
    '生成教学设计/实验指导文档（markdown）。以当前拓扑（get_topology 的合并结果）为骨架，' +
    '补齐目标、IP 规划、配置步骤与验证清单后写入应用导出目录。' +
    '典型用途：备课流水线收尾，让实验结果沉淀为教程。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object(
    {
      title: Type.String({ description: '文档标题，如「VLAN 划分实验」' }),
      objective: Type.Optional(Type.String({ description: '实验目标描述（可选）' })),
      ipPlan: Type.Optional(
        Type.Array(
          Type.Object({
            device: Type.String({ description: '设备名' }),
            iface: Type.String({ description: '接口，如 GigabitEthernet 0/0/0' }),
            ip: Type.String({ description: 'IP/掩码，如 10.0.12.1/24' }),
            purpose: Type.Optional(Type.String({ description: '用途说明（可选）' }))
          }),
          { description: 'IP 规划表（可选）' }
        )
      ),
      steps: Type.Optional(Type.Array(Type.String(), { description: '配置步骤清单（可选）' })),
      checks: Type.Optional(
        Type.Array(
          Type.Object(
            { from: Type.String({ description: '源设备 ID' }), target: Type.String({ description: '目标 IP' }) },
            { additionalProperties: false }
          ),
          { description: '验证清单（可选）' }
        )
      )
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { path?: string } | undefined
    return `导出备课文档「${args.title}」→ ${d?.path ?? '失败'}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    if (!args.title?.trim()) {
      return fail('BAD_PARAM', 'title 不能为空', { ms: Date.now() - t0 })
    }

    const topo = ctx.topology.snapshot()
    const devices = ctx.sessions
      .list()
      .filter((d) => d.connected)
      .map((d) => {
        const node = topo.nodes.find((n) => n.deviceId === d.id || n.id === d.id)
        return {
          deviceId: d.id,
          name: d.name,
          model: d.model ?? node?.model,
          role: node?.role ?? d.name
        }
      })

    const links = topo.links.map((l) => ({ from: l.from, to: l.to }))
    const body = buildLabGuide({
      title: args.title.trim(),
      ...(args.objective ? { objective: args.objective } : {}),
      devices: devices.length ? devices : undefined,
      links: links.length ? links : undefined,
      ...(args.ipPlan ? { ipPlan: args.ipPlan } : {}),
      ...(args.steps ? { steps: args.steps } : {}),
      ...(args.checks ? { checks: args.checks } : {})
    })

    // T5.3：与 sessions/safeFileName 同口径
    const safe = safeFileName(args.title, { fallback: 'lab-guide', maxLen: 40 })
    const dir = path.join(ctx.exportsDir, 'lab-guides')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${safe}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`)
    fs.writeFileSync(file, body, 'utf8')
    return ok({ path: file, deviceCount: devices.length, linkCount: links.length } as never, {
      ms: Date.now() - t0
    })
  }
}