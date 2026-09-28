import { Type } from './registry'
import { ok, type ToolSpec } from './registry'
import { listTopics, lookupVrpTopic } from '../core/knowledge/vrp-commands'
import { listVrpErrorCodes } from '../core/knowledge/vrp-errors'

/**
 * VRP 命令知识库查询（F1，2026-09-26；三级检索 v2.27，2026-09-28）。
 *
 * 只读、零设备交互 —— 从内置词典返回某主题的合法语法 / 参数 / 示例 / 易错点。
 * 目标是把「模型靠记忆编命令」变成「先查证再下发」：反掩码写错、network 宣告漏网段
 * 这类幻觉在词典的 pitfalls 里都有对应条目。
 *
 * 与 `run_show_command` 的白名单正交：本工具不产生任何设备流量，纯本地数据查询。
 *
 * v2.27 起支持三种查法（见 core/knowledge/vrp-commands#lookupVrpTopic）：
 * 主题名/别名 → 别名子串 → **正文全文检索**（按命令关键字或报错现象查，如 "allow-pass"、"反掩码"）。
 * 命中方式通过 `matchedBy` 回传，`content` 命中时提示模型先核对 summary 再照抄命令。
 */
export const lookupVrpCommand: ToolSpec<{ topic: string }> = {
  name: 'lookup_vrp_command',
  description:
    '查询 VRP（华为 eNSP）命令知识库：按主题返回合法命令语法、参数、可直接照抄的示例与易错点。' +
    '主题：ospf / vlan / l3_switch（三层交换·VLANIF）/ single_arm（单臂路由·子接口）/ dhcp / dhcp_relay / ' +
    'acl / nat / static_route / rip / route_adv（路由引入）/ stp / vrrp / eth_trunk / interface / ipv6 / ' +
    'device_mgmt（telnet·ssh 登录）/ basics / troubleshoot / error_ref（报错速查）。' +
    'topic 也可直接填**命令关键字或报错现象**（如 "allow-pass"、"反掩码"、"arp broadcast enable"），会走正文检索命中相关主题；' +
    'topic 留空则返回全部主题清单。' +
    '在不确定命令写法、或设备报错后不确定原因时先查本工具再下发，避免反掩码、宣告范围等常见幻觉。',
  risk: 'read',
  scope: 'local',
  concurrencySafe: true,
  schema: Type.Object(
    {
      topic: Type.String({
        description:
          '主题关键词，如 "ospf"、"静态路由"、"vlan trunk"、"acl"；' +
          '也可以是命令关键字 / 报错现象（如 "allow-pass"、"反掩码"）；留空返回全部主题清单'
      })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as
      | { matched?: boolean; entry?: { title?: string }; matchedBy?: string }
      | undefined
    if (d?.matched && d.entry?.title) {
      const via = d.matchedBy === 'content' ? '（正文命中）' : ''
      return `命令查询：${d.entry.title}${via}`
    }
    return `命令查询：${args.topic || '（全量清单）'}`
  },
  handler: async (args, _ctx) => {
    const t0 = Date.now()
    const topic = (args?.topic ?? '').trim()

    // 空 topic 不是错误：直接把全量清单给模型，省掉一次「猜主题名」的失败往返
    if (!topic) {
      return ok(
        {
          matched: false,
          hint: '未指定主题，下面是全部可用主题（也可直接用命令关键字或报错现象作为 topic 检索）：',
          available: listTopics(),
          errorCodes: listVrpErrorCodes()
        },
        { ms: Date.now() - t0 }
      )
    }

    const r = lookupVrpTopic(topic)
    if (!r.matched) {
      // 未命中不算工具失败：把可用清单给模型，让它换个词重查
      return ok(
        {
          matched: false,
          hint:
            '未命中主题。可从下列主题中选一个重查，也可改用命令关键字（如 "allow-pass"）' +
            '或报错现象（如 "参数越界"）作为 topic：',
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
        matchedBy: r.matchedBy ?? 'exact',
        // 正文命中的主题不一定完全对题 —— 明确提示先核对再照抄
        ...(r.matchedBy === 'content'
          ? { note: '本次是按正文关键字命中的相关主题，请先核对下面的 summary 是否与你的场景一致再照抄命令。' }
          : {}),
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
