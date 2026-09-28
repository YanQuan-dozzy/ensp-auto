import { Type } from './registry'
import { fail, ok, type ToolContext, type ToolSpec } from './registry'
import { isReadOnlyCommand } from '@shared/risk'
import {
  isIpv4Address,
  isTolerablePingFailure,
  networkPrefix,
  parseArpTable,
  parseDhcpPools,
  parseEthTrunk,
  parseInterfaceBrief,
  parseNatOutbound,
  parseNatServer,
  parseOspfPeers,
  parsePingOutput,
  parseRoutingTable,
  routeMatches
} from '../core/verify/parsers'

/**
 * 实验验收检查（F7，2026-09-26）—— 「实验目标 → 逐项验收结论」的闭环。
 *
 * 与 `verify_*` 的区别：`verify_*` 是**单点检查**（一次调用只回答一个问题），
 * 本工具把一整张「验收清单」一次跑完，逐项给 ✔/✘ + 证据回显 + 失败原因，
 * 让任务收尾有确定性的验收报告。
 *
 * ★ 刻意**不打分**：验收只回答「这条目标达成没有」，不产出 0~100 之类的分数 ——
 * 分数会诱导只看数字不看失败项，而验收的价值恰恰在于「哪一项没达成、为什么」。
 *
 * 全部 risk=read（只执行只读命令），解析器与判定逻辑是纯函数，可单测。
 */

export type CheckKind =
  | 'ping'
  | 'interface'
  | 'ospf'
  | 'dhcp'
  | 'route'
  | 'arp'
  | 'nat'
  | 'eth_trunk'
  | 'config'

export interface AcceptanceCheck {
  kind: CheckKind
  /** 设备 ID，形如 127.0.0.1:2008 */
  deviceId: string
  /** 人类可读的目标描述；缺省由 describeCheck 生成 */
  label?: string
  /** ping 目标 IP / route 目标网段或裸 IP / ospf 指定的邻居 Router ID 或接口名 */
  target?: string
  /** arp 目标 IP */
  ip?: string
  /** interface 检查的接口名（精确或子串匹配，如 GE0/0/1） */
  iface?: string
  /** eth_trunk 的聚合组号 */
  trunkId?: number
  /** dhcp 指定的地址池名 */
  pool?: string
  /** config 检查要求出现的配置子串（作为 display current-configuration | include 的过滤词） */
  contains?: string
}

export type CheckStatus = 'pass' | 'fail' | 'error'

export interface CheckOutcome {
  ok: boolean
  /** pass = 达成；fail = 未达成（有明确证据）；error = 无法判定（未连接/命令失败/参数不全） */
  status: CheckStatus
  /** 证据回显（截断后的关键事实，如 ping 统计 / 接口状态 / 邻居状态） */
  evidence: string
  /** 未达成或无法判定时的原因 */
  reason?: string
}

/**
 * 该验收项需要执行的只读命令（按顺序）。返回空数组 = 参数不完整，无法判定。
 *
 * 单独抽出来是为了可测：命令选择是「验收项 → 设备操作」的唯一映射，
 * 不依赖真实设备即可断言（evaluateCheck 同理）。
 */
export function commandsForCheck(c: AcceptanceCheck): string[] {
  switch (c.kind) {
    case 'ping': {
      const target = c.target?.trim() ?? ''
      // N12：target 会被拼进命令，只接受严格 IPv4（不是合法地址就不生成命令）
      return isIpv4Address(target) ? [`ping -c 3 ${target}`] : []
    }
    case 'interface':
      return ['display interface brief']
    case 'ospf':
      return ['display ospf peer brief']
    case 'dhcp':
      return ['display ip pool']
    case 'route':
      return c.target?.trim() ? ['display ip routing-table'] : []
    case 'arp':
      return c.ip?.trim() ? ['display arp'] : []
    case 'nat':
      return ['display nat outbound', 'display nat server']
    case 'eth_trunk':
      return [c.trunkId ? `display eth-trunk ${c.trunkId}` : 'display eth-trunk']
    case 'config': {
      const needle = c.contains?.trim() ?? ''
      // N12：contains 会被拼进 `| include <词>`，含换行/分隔符一律不生成命令
      return needle && !INCLUDE_FILTER_FORBIDDEN_RE.test(needle)
        ? [`display current-configuration | include ${needle}`]
        : []
    }
  }
}

/** config 检查的过滤词里禁止出现的字符（会破坏 `| include <词>` 的单命令结构） */
const INCLUDE_FILTER_FORBIDDEN_RE = /[\r\n|;&]/

/**
 * N12：验收项的安全校验 —— 命令是**由参数拼出来**的，所以必须在执行前校验。
 *
 * 返回 null = 合法；否则返回给模型的失败原因（handler 会整体返回 BAD_PARAM）。
 *
 * 两道：
 * 1. 逐个 kind 校验被插值的参数（ping 的 target / config 的 contains）；
 * 2. 兜底：无论哪种 kind，凡 `commandsForCheck` 拼出来的命令都必须通过 `isReadOnlyCommand`
 *    —— 将来新增「把参数拼进命令」的 kind 时，即使忘了第 1 条也不会漏。
 */
export function checkInputError(c: AcceptanceCheck): string | null {
  if (c.kind === 'ping') {
    const t = (c.target ?? '').trim()
    if (t && !isIpv4Address(t)) return `ping 的 target 必须是合法 IPv4 地址：${t}`
  }
  if (c.kind === 'config') {
    const s = (c.contains ?? '').trim()
    if (s && INCLUDE_FILTER_FORBIDDEN_RE.test(s)) {
      return `config 的 contains 不得包含换行或命令分隔符（| ; &）：${s}`
    }
  }
  for (const cmd of commandsForCheck(c)) {
    if (!isReadOnlyCommand(cmd)) return `验收命令必须是只读命令：${cmd}`
  }
  return null
}

/** 验收项的一行目标描述（清单缺 label 时的兜底） */
export function describeCheck(c: AcceptanceCheck): string {
  const d = c.deviceId
  switch (c.kind) {
    case 'ping':
      return `${d} ping ${c.target ?? '?'} 可达`
    case 'interface':
      return `${d} 接口 ${c.iface ?? '?'} up`
    case 'ospf':
      return `${d} OSPF 邻居${c.target ? ` ${c.target}` : ''} Full`
    case 'dhcp':
      return `${d} DHCP${c.pool ? ` 池 ${c.pool}` : ''} 已分配地址`
    case 'route':
      return `${d} 路由 ${c.target ?? '?'} 存在`
    case 'arp':
      return `${d} ARP 学到 ${c.ip ?? '?'}`
    case 'nat':
      return `${d} NAT 已配置`
    case 'eth_trunk':
      return `${d} Eth-Trunk${c.trunkId ?? ''} up`
    case 'config':
      return `${d} 配置包含「${c.contains ?? '?'}」`
  }
}

/** 截断证据，避免一条 check 把整屏回显灌进结果 */
function clip(s: string, max = 200): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 用命令回显判定单个验收项（纯函数）。
 *
 * `outputs` 与 `commandsForCheck` 的返回值一一对应；缺失的按空串处理。
 * 回显无法解析时返回 `error`（无法判定）而不是 `fail` —— 二者语义不同：
 * 「没达成」和「根本没测出来」不能混为一谈，否则验收报告会谎报失败。
 */
export function evaluateCheck(c: AcceptanceCheck, outputs: string[]): CheckOutcome {
  const out = (i: number): string => outputs[i] ?? ''

  switch (c.kind) {
    case 'ping': {
      const stats = parsePingOutput(out(0))
      if (!stats) {
        return { ok: false, status: 'error', evidence: '', reason: 'ping 回显无法解析（命令失败或输出不完整）' }
      }
      const ok = stats.received > 0
      return {
        ok,
        status: ok ? 'pass' : 'fail',
        evidence: `${stats.transmitted} 发包 / ${stats.received} 收包 / ${stats.lossPercent}% 丢包`,
        ...(ok ? {} : { reason: '目标不可达：0 收包' })
      }
    }

    case 'interface': {
      const want = c.iface?.trim()
      if (!want) {
        return { ok: false, status: 'error', evidence: '', reason: 'interface 检查需要给出 iface（接口名）' }
      }
      const rows = parseInterfaceBrief(out(0))
      const lower = want.toLowerCase()
      const row =
        rows.find((r) => r.name.toLowerCase() === lower) ??
        rows.find((r) => r.name.toLowerCase().includes(lower))
      if (!row) {
        return {
          ok: false,
          status: 'fail',
          evidence: rows.map((r) => r.name).slice(0, 12).join(', '),
          reason: `display interface brief 中未找到接口 ${want}`
        }
      }
      const ok = row.phy === 'up' && row.protocol === 'up'
      return {
        ok,
        status: ok ? 'pass' : 'fail',
        evidence: `${row.name}: PHY ${row.phy} / Protocol ${row.protocol}`,
        ...(ok ? {} : { reason: '接口未处于 up/up' })
      }
    }

    case 'ospf': {
      const peers = parseOspfPeers(out(0))
      if (peers.length === 0) {
        return {
          ok: false,
          status: 'fail',
          evidence: '',
          reason: 'display ospf peer brief 未解析到任何邻居（OSPF 未启用或未建立邻居）'
        }
      }
      const want = c.target?.trim()
      const scope = want
        ? peers.filter((p) => p.neighborId === want || p.interface.toLowerCase() === want.toLowerCase())
        : peers
      const listed = peers.map((p) => `${p.neighborId}@${p.interface} ${p.state}`).join(', ')
      if (scope.length === 0) {
        return { ok: false, status: 'fail', evidence: clip(listed), reason: `未找到指定的 OSPF 邻居 ${want}` }
      }
      const ok = scope.some((p) => p.state === 'Full')
      return {
        ok,
        status: ok ? 'pass' : 'fail',
        evidence: clip(scope.map((p) => `${p.neighborId}@${p.interface} ${p.state}`).join(', ')),
        ...(ok ? {} : { reason: '邻居未达到 Full 状态' })
      }
    }

    case 'dhcp': {
      const pools = parseDhcpPools(out(0))
      if (pools.length === 0) {
        return {
          ok: false,
          status: 'fail',
          evidence: '',
          reason: 'display ip pool 未解析到地址池（DHCP 未配置）'
        }
      }
      const want = c.pool?.trim()
      const scope = want ? pools.filter((p) => p.name === want) : pools
      if (scope.length === 0) {
        return {
          ok: false,
          status: 'fail',
          evidence: pools.map((p) => p.name).join(', '),
          reason: `未找到指定的地址池 ${want}`
        }
      }
      const evidence = clip(
        scope
          .map((p) => `${p.name}${p.networkSection ? `(${p.networkSection})` : ''} 已用 ${p.usedAddresses ?? 0}/${p.totalAddresses ?? '?'}`)
          .join(', ')
      )
      const ok = scope.some((p) => (p.usedAddresses ?? 0) > 0)
      return {
        ok,
        status: ok ? 'pass' : 'fail',
        evidence,
        ...(ok ? {} : { reason: '地址池存在但无已分配地址（客户端未成功获取地址）' })
      }
    }

    case 'route': {
      const dest = c.target?.trim()
      if (!dest) {
        return { ok: false, status: 'error', evidence: '', reason: 'route 检查需要给出 target（网段或裸 IP）' }
      }
      const entries = parseRoutingTable(out(0))
      const matched = entries.filter((e) => routeMatches(e, dest))
      const best = matched.sort((a, b) => {
        const pa = networkPrefix(a.network)
        const pb = networkPrefix(b.network)
        if (pb !== pa) return pb - pa
        return (a.preference ?? 0) - (b.preference ?? 0)
      })[0]
      const ok = !!best && best.protocol !== 'UNR'
      return {
        ok,
        status: ok ? 'pass' : 'fail',
        evidence: best ? `${best.network} via ${best.nextHop} (${best.protocol})` : '路由表中无匹配条目',
        ...(ok ? {} : { reason: best ? `最佳匹配协议为 ${best.protocol}（不可达）` : '路由表中无匹配条目' })
      }
    }

    case 'arp': {
      const ip = c.ip?.trim()
      if (!ip) {
        return { ok: false, status: 'error', evidence: '', reason: 'arp 检查需要给出 ip' }
      }
      const hit = parseArpTable(out(0)).find((e) => e.ip === ip)
      return {
        ok: !!hit,
        status: hit ? 'pass' : 'fail',
        evidence: hit ? `${hit.ip} → ${hit.mac}${hit.type ? ` (${hit.type})` : ''}` : 'ARP 表中无该 IP',
        ...(hit ? {} : { reason: '未学到该 IP 的 MAC（邻居不可达或尚未通信）' })
      }
    }

    case 'nat': {
      const ob = parseNatOutbound(out(0))
      const sr = parseNatServer(out(1))
      const ok = ob.length + sr.length > 0
      return {
        ok,
        status: ok ? 'pass' : 'fail',
        evidence: `NAT outbound ${ob.length} 条 / nat server ${sr.length} 条`,
        ...(ok ? {} : { reason: '未检出任何 NAT 配置' })
      }
    }

    case 'eth_trunk': {
      const info = parseEthTrunk(out(0))
      if (!info) {
        return {
          ok: false,
          status: 'fail',
          evidence: '',
          reason: 'display eth-trunk 未解析到聚合组（未配置链路聚合）'
        }
      }
      const ok = info.operateStatus === 'up'
      const up = info.upPorts ?? info.members.filter((m) => m.status === 'up').length
      return {
        ok,
        status: ok ? 'pass' : 'fail',
        evidence: `${info.trunk} ${info.operateStatus ?? '?'} / up 成员 ${up}`,
        ...(ok ? {} : { reason: '聚合组运行状态非 up' })
      }
    }

    case 'config': {
      const needle = c.contains?.trim()
      if (!needle) {
        return { ok: false, status: 'error', evidence: '', reason: 'config 检查需要给出 contains（配置子串）' }
      }
      const text = out(0)
      const ok = text.trim().length > 0
      return {
        ok,
        status: ok ? 'pass' : 'fail',
        evidence: ok ? clip(text) : '',
        ...(ok ? {} : { reason: `配置中未找到包含「${needle}」的行` })
      }
    }
  }
}

export const CHECK_CARD_LIMIT = 40

interface CheckItemResult extends CheckOutcome {
  label: string
  kind: CheckKind
  deviceId: string
}

/** 执行单个验收项：取连接 → 跑只读命令 → 判定。命令失败记为 error，绝不谎报 fail */
async function runCheck(c: AcceptanceCheck, ctx: ToolContext): Promise<CheckItemResult> {
  const base = { label: c.label?.trim() || describeCheck(c), kind: c.kind, deviceId: c.deviceId }
  const cmds = commandsForCheck(c)
  if (cmds.length === 0) {
    return { ...base, ok: false, status: 'error', evidence: '', reason: '验收项参数不完整（缺少 target / ip / iface / contains 等必填项）' }
  }
  const session = ctx.sessions.get(c.deviceId)
  if (!session) {
    return { ...base, ok: false, status: 'error', evidence: '', reason: `设备未连接：${c.deviceId}` }
  }
  const outputs: string[] = []
  for (const cmd of cmds) {
    const r = await session.exec(cmd, {
      timeoutMs: 15000,
      ...(ctx.signal ? { signal: ctx.signal } : {})
    })
    // ping 不可达时命令可能整体不算 ok，但回显里有统计行 —— 与 verify_ping 共用同一份判据（N26）
    const tolerable = c.kind === 'ping' && isTolerablePingFailure(r)
    if (!r.ok && !tolerable) {
      return { ...base, ok: false, status: 'error', evidence: '', reason: `命令失败：${cmd} —— ${r.error ?? '未知错误'}` }
    }
    outputs.push(r.clean)
  }
  return { ...base, ...evaluateCheck(c, outputs) }
}

export const checkExperiment: ToolSpec<{ checks: AcceptanceCheck[] }> = {
  name: 'check_experiment',
  description:
    '实验验收检查：一次传入整张验收清单，逐项执行只读命令并给出 ✔/✘ + 证据回显 + 失败原因。' +
    'check.kind 取值：ping（deviceId+target，判定可达）/ interface（+iface，判定 up/up）/ ' +
    'ospf（+target? 邻居 Router ID 或接口名，判定 Full）/ dhcp（+pool?，判定池已有分配）/ ' +
    'route（+target 网段或裸 IP，判定路由存在且非 UNR）/ arp（+ip，判定学到 MAC）/ ' +
    'nat（判定存在 NAT 配置）/ eth_trunk（+trunkId?，判定运行 up）/ config（+contains，判定配置含该子串）。' +
    '每项可选 label 作为目标描述。只报告「达成/未达成/无法判定」，不打分。任务收尾时用它做验收。',
  risk: 'read',
  scope: 'device',
  schema: Type.Object(
    {
      checks: Type.Array(
        Type.Object(
          {
            kind: Type.Union(
              [
                Type.Literal('ping'),
                Type.Literal('interface'),
                Type.Literal('ospf'),
                Type.Literal('dhcp'),
                Type.Literal('route'),
                Type.Literal('arp'),
                Type.Literal('nat'),
                Type.Literal('eth_trunk'),
                Type.Literal('config')
              ],
              { description: '验收项类型' }
            ),
            deviceId: Type.String({ description: '执行该检查的设备 ID，形如 127.0.0.1:2008' }),
            label: Type.Optional(Type.String({ description: '目标描述（如「PC1 能 ping 通 PC2」）；缺省自动生成' })),
            target: Type.Optional(
              Type.String({ description: 'ping 目标 IP / route 目标网段或裸 IP / ospf 邻居 Router ID 或接口名' })
            ),
            ip: Type.Optional(Type.String({ description: 'arp 检查的目标 IP' })),
            iface: Type.Optional(Type.String({ description: 'interface 检查的接口名（精确或子串，如 GE0/0/1）' })),
            trunkId: Type.Optional(Type.Integer({ description: 'eth_trunk 的聚合组号' })),
            pool: Type.Optional(Type.String({ description: 'dhcp 检查指定的地址池名' })),
            contains: Type.Optional(Type.String({ description: 'config 检查要求出现的配置子串' }))
          },
          { additionalProperties: false }
        ),
        { description: '验收项清单（至少一项）' }
      )
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { total?: number; passed?: number } | undefined
    if (!d?.total) return `验收检查：${args?.checks?.length ?? 0} 项（未执行）`
    return `验收检查：${d.passed ?? 0}/${d.total} 项达成`
  },
  /**
   * H（v2.14）：把「哪几项没达成」落进会话树，供回放/演示模式重画验收清单卡。
   *
   * 刻意**丢掉每一项的 `evidence`**（那是截断后的命令回显，最长的一块）：卡片要的是
   * 「哪项 pass / fail / error、为什么」，回显明细在 agent 消息流里本来就有。
   * 条目数同样在投影里截断（超上限是整块丢弃，不是截断）。
   */
  presentationMeta: (_args, result) => {
    const d = result.data as
      | {
          total?: number
          passed?: number
          failed?: number
          errors?: number
          allPassed?: boolean
          items?: CheckItemResult[]
        }
      | undefined
    if (!result.ok || !d) return undefined
    const items = d.items ?? []
    return {
      total: d.total ?? items.length,
      passed: d.passed ?? 0,
      failed: d.failed ?? 0,
      errors: d.errors ?? 0,
      allPassed: d.allPassed === true,
      items: items.slice(0, CHECK_CARD_LIMIT).map((i) => ({
        label: i.label,
        kind: i.kind,
        deviceId: i.deviceId,
        status: i.status,
        ...(i.reason ? { reason: i.reason } : {})
      })),
      itemsTotal: items.length
    }
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const checks = args?.checks ?? []
    if (!Array.isArray(checks) || checks.length === 0) {
      return fail('BAD_PARAM', 'checks 不能为空：请给出至少一项验收目标', { ms: Date.now() - t0 })
    }

    // N12：命令是由参数拼出来的 —— 在碰设备之前先把非法参数整体拒绝（BAD_PARAM），
    // 绝不让「拼进命令的模型输入」走到 session.exec。checks 可能来自外部 MCP 调用，
    // 故先挡掉非对象条目（否则后面的字段访问会直接抛）。
    for (const c of checks) {
      if (!c || typeof c !== 'object') {
        return fail('BAD_PARAM', 'checks 里存在非法条目（应为对象）', { ms: Date.now() - t0 })
      }
      const inputError = checkInputError(c)
      if (inputError) {
        return fail('BAD_PARAM', `验收项参数非法（${c.deviceId} / ${c.kind}）：${inputError}`, {
          ms: Date.now() - t0
        })
      }
    }

    const items: CheckItemResult[] = []
    for (const c of checks) items.push(await runCheck(c, ctx))

    const passed = items.filter((i) => i.status === 'pass').length
    const failed = items.filter((i) => i.status === 'fail').length
    const errors = items.filter((i) => i.status === 'error').length
    const allPassed = failed === 0 && errors === 0
    const summary =
      `验收 ${items.length} 项：${passed} 项达成` +
      (failed ? ` / ${failed} 项未达成` : '') +
      (errors ? ` / ${errors} 项无法判定` : '')

    return ok(
      { total: items.length, passed, failed, errors, allPassed, items, summary } as never,
      { ms: Date.now() - t0 }
    )
  }
}