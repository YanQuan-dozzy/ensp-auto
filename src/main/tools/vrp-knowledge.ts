import { Type } from './registry'
import { fail, ok, type ToolSpec } from './registry'
import { listTopics, lookupVrpTopic } from '../core/knowledge/vrp-commands'

/**
 * VRP 命令知识库查询（F1，2026-09-26）。
 *
 * 只读、零设备交互 —— 从内置词典返回某主题的合法语法 / 参数 / 示例 / 易错点。
 * 目标是把「模型靠记忆编命令」变成「先查证再下发」：反掩码写错、network 宣告漏网段
 * 这类幻觉在词典的 pitfalls 里都有对应条目。
 *
 * 与 run_show_command 的白名单正交：本工具不产生任何设备流量，纯本地数据查询。
 */
export const lookupVrpCommand: ToolSpec<{ topic: string }> = {
  name: 'lookup_vrp_command',
  description:
    '查询 VRP（华为 eNSP）命令知识库：按主题返回合法命令语法、参数、可直接照抄的示例与易错点。' +
    '主题：ospf / vlan / dhcp / acl / nat / static_route / rip / eth_trunk / interface / ipv6 / basics / troubleshoot。' +
    '在不确定命令写法时先查本工具再下发，避免反掩码、宣告范围等常见幻觉；主题可用中英文关键词。',
  risk: 'read',
  scope: 'local',
  concurrencySafe: true,
  schema: Type.Object(
    {
      topic: Type.String({
        description: '主题关键词，如 "ospf"、"静态路由"、"vlan trunk"、"acl"；未命中会返回全部可用主题'
      })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { matched?: boolean; entry?: { title?: string } } | undefined
    if (d?.matched && d.entry?.title) return `命令查询：${d.entry.title}`
    return `命令查询：${args.topic}（未命中）`
  },
  handler: async (args, _ctx) => {
    const t0 = Date.now()
    const topic = (args?.topic ?? '').trim()
    if (!topic) return fail('BAD_PARAM', 'topic 不能为空', { ms: Date.now() - t0 })
    const r = lookupVrpTopic(topic)
    if (!r.matched) {
      // 未命中不算工具失败：把可用清单给模型，让它换个词重查
      return ok(
        {
          matched: false,
          hint: '未命中主题。请从下列主题中选一个重查（也可用其中的别名关键词）：',
          available: r.available
        },
        { ms: Date.now() - t0 }
      )
    }
    return ok(
      {
        matched: true,
        topic: r.entry!.id,
        title: r.entry!.title,
        summary: r.entry!.summary,
        commands: r.entry!.commands,
        pitfalls: r.entry!.pitfalls
      },
      { ms: Date.now() - t0 }
    )
  }
}

/** 词典元信息（设置页 / 报告展示用） */
export function vrpKnowledgeTopics(): ReturnType<typeof listTopics> {
  return listTopics()
}
