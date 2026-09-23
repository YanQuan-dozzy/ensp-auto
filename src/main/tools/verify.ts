import type { Device } from '@shared/types'
import { fail, failFromCommand, ok, Type, type ToolSpec } from './registry'
import {
  hasDhcpConfig,
  networkPrefix,
  parseArpTable,
  parseDhcpPools,
  parseEthTrunk,
  parseInterfaceBrief,
  parseNatOutbound,
  parseNatServer,
  parsePingOutput,
  parseRoutingTable,
  routeMatches,
  type DhcpPool
} from '../core/verify/parsers'

/**
 * 结构化验证工具（v1.2 / F-：参照 ensp-mcp connectivity_analysis / dhcp_verification_service）。
 *
 * 把「验证实验结果」从 LLM 自由发挥变成确定性的只读检查：
 * - verify_ping：源设备 ping 目标 IP，解析丢包/时延并给出判定
 * - verify_connectivity：聚合多台设备的 display interface brief 状态，统计 up/down
 * - verify_dhcp：在 DHCP 服务器设备上核对配置存在性与地址池
 *
 * 全部 risk=read（只执行只读命令），可被代理与 MCP 安全调用；解析器纯函数可单测。
 */

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/

export const verifyPing: ToolSpec<{ from: string; target: string }> = {
  name: 'verify_ping',
  description:
    '在指定设备上 ping 目标 IP 并判定连通性：返回发包/收包/丢包率/时延统计与结论' +
    '（reachable / unreachable / unknown）。用于验证实验拓扑连通性（如 pc_connectivity）。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      from: Type.String({ description: '源设备 ID，形如 127.0.0.1:2008' }),
      target: Type.String({ description: '目标 IPv4 地址，如 10.0.0.2' })
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { verdict?: string } | undefined
    return `ping ${args.from} → ${args.target}：${d?.verdict ?? '失败'}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const session = ctx.sessions.get(args.from)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${args.from}`, { ms: Date.now() - t0 })
    }
    if (!IPV4_RE.test(args.target)) {
      return fail('BAD_PARAM', `目标不是合法 IPv4：${args.target}`, { ms: Date.now() - t0 })
    }

    const r = await session.exec(`ping -c 3 ${args.target}`, {
      timeoutMs: 20000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    const meta = { ms: Date.now() - t0, deviceId: args.from, settled: r.settled }
    if (!r.ok && !r.clean.includes('packet')) {
      return failFromCommand(r, 'FAILED', meta)
    }

    const stats = parsePingOutput(r.clean)
    if (!stats) {
      return ok(
        { verdict: 'unknown', clean: r.clean.slice(0, 2000) } as never,
        meta
      )
    }
    const verdict = stats.received > 0 ? 'reachable' : 'unreachable'
    return ok({ verdict, ...stats, clean: r.clean.slice(0, 2000) } as never, meta)
  }
}

export const verifyConnectivity: ToolSpec<{ deviceIds?: string[] }> = {
  name: 'verify_connectivity',
  description:
    '批量读取设备接口状态（display interface brief）并聚合：每台设备的 up/down 接口数、' +
    '接口明细与整体判定。验证实验前可先跑一遍确认链路是否拉起。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      deviceIds: Type.Optional(
        Type.Array(Type.String({ description: '设备 ID 列表；缺省为所有已连接设备' }))
      )
    },
    { additionalProperties: false }
  ),
  summarize: (_args, result) => {
    const d = result.data as { devices?: unknown[] } | undefined
    return `接口状态聚合：${d?.devices?.length ?? 0} 台设备`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const sessions = args.deviceIds?.length
      ? args.deviceIds.map((id) => ctx.sessions.get(id)).filter((s): s is NonNullable<typeof s> => !!s)
      : ctx.sessions.list().filter((d: Device) => d.connected).map((d) => ctx.sessions.get(d.id)).filter((s): s is NonNullable<typeof s> => !!s)

    if (sessions.length === 0) {
      return fail('NOT_CONNECTED', '没有可检查的已连接设备（或用 deviceIds 显式指定）', { ms: Date.now() - t0 })
    }

    const report: Array<Record<string, unknown>> = []
    for (const s of sessions) {
      const r = await s.exec('display interface brief', {
        timeoutMs: 12000,
        ...(ctx.signal ? { signal: ctx.signal } : {})
      })
      if (!r.ok) {
        report.push({ deviceId: s.id, name: s.name, error: r.error ?? '命令执行失败', verdict: 'error' })
        continue
      }
      const rows = parseInterfaceBrief(r.clean)
      const up = rows.filter((x) => x.phy === 'up' && x.protocol === 'up').length
      const down = rows.filter((x) => x.phy === 'down' || x.protocol === 'down').length
      report.push({
        deviceId: s.id,
        name: s.name,
        up,
        down,
        count: rows.length,
        verdict: up > 0 ? 'up' : rows.length === 0 ? 'no-interfaces' : 'down',
        interfaces: rows.slice(0, 48)
      })
    }

    const upCount = report.filter((r) => r.verdict === 'up').length
    return ok(
      {
        devices: report,
        summary: `检查 ${report.length} 台设备：${upCount} 台有接口在线`,
        allUp: upCount === report.length
      } as never,
      { ms: Date.now() - t0 }
    )
  }
}

export const verifyDhcp: ToolSpec<{ server: string }> = {
  name: 'verify_dhcp',
  description:
    '核对 DHCP 服务器设备：配置里是否存在 dhcp/ip pool 配置，并读取地址池（display ip pool）' +
    '的名称/网段/起始结束地址/总地址与已用地址。返回判定 configured / partial / not-configured。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    { server: Type.String({ description: 'DHCP 服务器设备 ID（通常为核心交换机/路由器）' }) },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { verdict?: string; pools?: unknown[] } | undefined
    return `DHCP 验证 ${args.server}：${d?.verdict ?? '失败'}（${d?.pools?.length ?? 0} 个池）`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const session = ctx.sessions.get(args.server)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${args.server}`, { ms: Date.now() - t0 })
    }

    const cfg = await session.exec('display current-configuration | include dhcp', {
      timeoutMs: 15000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    const configured = cfg.ok && hasDhcpConfig(cfg.clean)

    const poolsRes = await session.exec('display ip pool', {
      timeoutMs: 15000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    let pools: DhcpPool[] = []
    let poolWarn: string | undefined
    if (poolsRes.ok) {
      pools = parseDhcpPools(poolsRes.clean)
    } else {
      poolWarn = poolsRes.error ?? 'display ip pool 执行失败'
    }

    const verdict = !configured ? 'not-configured' : pools.length > 0 ? 'configured' : 'partial'
    return ok(
      {
        server: args.server,
        dhcpConfigured: configured,
        pools,
        verdict,
        ...(poolWarn ? { warning: poolWarn } : {})
      } as never,
      { ms: Date.now() - t0, deviceId: args.server }
    )
  }
}

// ———————————————————— v2：路由 / ARP / NAT / Eth-Trunk 验证 ————————————————————
// 与任务库新增（static_route / rip / acl_nat / eth_trunk）配套的只读结构化验证。

export const verifyRoute: ToolSpec<{ deviceId: string; destination?: string }> = {
  name: 'verify_route',
  description:
    '检查设备路由表（display ip routing-table）：可指定目标（网段如 10.0.12.0/24，或裸 IP 如 10.0.12.2）判定是否存在对应路由；' +
    '不指定则返回路由总数与路由摘要。用于验证静态路由/OSPF/RIP 是否收敛。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID，形如 127.0.0.1:2008' }),
      destination: Type.Optional(
        Type.String({ description: '目标网段/前缀（形如 10.0.12.0/24）或裸 IP（形如 10.0.12.2）' })
      )
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { verdict?: string } | undefined
    return `${args.deviceId} 路由${args.destination ? ` ${args.destination}` : ''}：${d?.verdict ?? '失败'}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const session = ctx.sessions.get(args.deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${args.deviceId}`, { ms: Date.now() - t0 })
    }
    const r = await session.exec('display ip routing-table', {
      timeoutMs: 15000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    const meta = { ms: Date.now() - t0, deviceId: args.deviceId, settled: r.settled }
    if (!r.ok) return failFromCommand(r, 'FAILED', meta)
    const entries = parseRoutingTable(r.clean)
    const dest = args.destination
    if (!dest) {
      return ok({ routeCount: entries.length, entries: entries.slice(0, 40) } as never, meta)
    }
    const matched = entries.filter((e) => routeMatches(e, dest))
    // D10：结论取**最长前缀**条目，而不是 preference 最小的条目 ——
    // preference 是路由优先级（与「谁更具体」无关），次选才用它排序。
    // 默认路由 0.0.0.0/0 现在能命中目标（parseNetwork 已接受 prefix 0）。
    const preferred = matched.sort((a, b) => {
      const pa = networkPrefix(a.network)
      const pb = networkPrefix(b.network)
      if (pb !== pa) return pb - pa
      return (a.preference ?? 0) - (b.preference ?? 0)
    })[0]
    return ok(
      {
        destination: dest,
        matchedCount: matched.length,
        matched: matched.slice(0, 10),
        bestMatch: preferred ?? null,
        verdict: preferred && preferred.protocol !== 'UNR' ? 'reachable' : 'absent',
        ...(matched.length === 0
          ? { hint: '路由表中无匹配条目；若该目标走默认路由可达，请确认 0.0.0.0/0 条目已配置且回显包含它' }
          : {})
      } as never,
      meta
    )
  }
}

export const verifyArp: ToolSpec<{ deviceId: string; ip?: string }> = {
  name: 'verify_arp',
  description:
    '检查设备 ARP 表（display arp）：可指定 IP 判断是否学到 MAC（即邻居可达）；不指定则返回 MAC 条目数与摘要。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID，形如 127.0.0.1:2008' }),
      ip: Type.Optional(Type.String({ description: '目标 IP（可选）；给出则判定 learned/unknown' }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { verdict?: string } | undefined
    return `${args.deviceId} ARP${args.ip ? ` ${args.ip}` : ''}：${d?.verdict ?? '失败'}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const session = ctx.sessions.get(args.deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${args.deviceId}`, { ms: Date.now() - t0 })
    }
    const r = await session.exec('display arp', {
      timeoutMs: 15000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    const meta = { ms: Date.now() - t0, deviceId: args.deviceId, settled: r.settled }
    if (!r.ok) return failFromCommand(r, 'FAILED', meta)
    const entries = parseArpTable(r.clean)
    if (!args.ip) {
      return ok({ arpCount: entries.length, entries: entries.slice(0, 40) } as never, meta)
    }
    const hit = entries.find((e) => e.ip === args.ip)
    return ok(
      {
        ip: args.ip,
        entry: hit ?? null,
        verdict: hit?.type === 'S' || hit?.type === 'I' ? 'learned' : hit ? 'entry' : 'unknown'
      } as never,
      meta
    )
  }
}

export const verifyNat: ToolSpec<{ deviceId: string }> = {
  name: 'verify_nat',
  description:
    '检查设备 NAT 配置（display nat outbound + display nat server）：返回 Easy IP/出接口与端口映射清单，' +
    '判定 configured（有任一 NAT 配置）/ not-configured。用于验证 acl_nat 任务效果。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    { deviceId: Type.String({ description: '设备 ID（出口路由器）' }) },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { verdict?: string } | undefined
    return `NAT 验证 ${args.deviceId}：${d?.verdict ?? '失败'}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const session = ctx.sessions.get(args.deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${args.deviceId}`, { ms: Date.now() - t0 })
    }
    const ob = await session.exec('display nat outbound', {
      timeoutMs: 12000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    const obEntries = ob.ok ? parseNatOutbound(ob.clean) : []
    const sr = await session.exec('display nat server', {
      timeoutMs: 12000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    const srEntries = sr.ok ? parseNatServer(sr.clean) : []
    const verdict = obEntries.length || srEntries.length ? 'configured' : 'not-configured'
    return ok(
      {
        natOutbound: obEntries.slice(0, 20),
        natServers: srEntries.slice(0, 20),
        easyIpCount: obEntries.length,
        natServerCount: srEntries.length,
        verdict
      } as never,
      { ms: Date.now() - t0, deviceId: args.deviceId }
    )
  }
}

export const verifyEthTrunk: ToolSpec<{ deviceId: string; trunkId?: number }> = {
  name: 'verify_eth_trunk',
  description:
    '检查链路聚合状态（display eth-trunk [N]）：返回聚合组工作模式、运行状态、up 成员数与成员明细，' +
    '判定 up（运行状态 up）/ down / absent（未配置）。用于验证 eth_trunk 任务效果。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      deviceId: Type.String({ description: '设备 ID（交换机/路由器）' }),
      trunkId: Type.Optional(Type.Integer({ description: '聚合组号；缺省查看全部并取第一个' }))
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { verdict?: string } | undefined
    return `${args.deviceId} Eth-Trunk：${d?.verdict ?? '失败'}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const session = ctx.sessions.get(args.deviceId)
    if (!session) {
      return fail('NOT_CONNECTED', `设备未连接：${args.deviceId}`, { ms: Date.now() - t0 })
    }
    const cmd = args.trunkId ? `display eth-trunk ${args.trunkId}` : 'display eth-trunk'
    const r = await session.exec(cmd, {
      timeoutMs: 12000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    const meta = { ms: Date.now() - t0, deviceId: args.deviceId, settled: r.settled }
    if (!r.ok) return failFromCommand(r, 'FAILED', meta)
    const info = parseEthTrunk(r.clean)
    if (!info) {
      return ok({ verdict: 'absent', trunkId: args.trunkId ?? null, members: [] } as never, meta)
    }
    return ok(
      {
        trunk: info.trunk,
        workingMode: info.workingMode ?? null,
        operateStatus: info.operateStatus ?? null,
        upPorts: info.upPorts ?? info.members.filter((m) => m.status === 'up').length,
        members: info.members.slice(0, 32),
        verdict: info.operateStatus === 'up' ? 'up' : 'down'
      } as never,
      meta
    )
  }
}