import type { ChangeKind, ChangeRecord, ChangeResult } from '@shared/types'

/**
 * 设备配置命令报告（v2.20，纯函数）。
 *
 * 数据源只有一处：`ChangeStore` 的变更记录（`ChangeRecord[]`）。
 * 本模块只做「记录列表 → Markdown」，取数据与写盘在调用方
 * （agent 工具 `export_change_report` 与 `changes:export` IPC 共用同一份正文，
 * 避免出现「预览一套口径、导出另一套」）。
 *
 * 样式取自 eNSP 综合实验教程的排版约定：编号章节 + 按设备分组 + 命令代码块 +
 * 设备内多次变更用虚线分隔，读者可整段复制回设备。
 *
 * ## 两处刻意不做的能力（都是数据源边界，不是偷懒）
 *
 * 1. **没有 `display` 回显**：`ChangeRecord` 不存回显（回显在会话树节点里，且
 *    `run_show_command` 这类只读命令根本不进变更记录）。报告里的「验证」只能是
 *    `ChangeRecord.expectation` + `verified` 这对结构化校验结论。
 * 2. **不追踪「被回滚掉的配置」**：地址池 / 接口 IP 两张表只扫 `result === 'ok'`
 *    的 apply 记录，按时间正序让后出现的覆盖先出现的。若之后执行过回滚，表内条目
 *    可能已不在设备上 —— 报告页脚会明确写出这条口径，不做猜测性推断。
 */

export interface ChangeReportOptions {
  title?: string
  /**
   * deviceId → 展示名。**设备别名只在 `SessionManager` 内存里**（`rename()` 不落盘），
   * 因此重启后导出历史记录时拿不到别名，只能回退到 deviceId（如 `127.0.0.1:2004`）。
   */
  deviceLabels?: Readonly<Record<string, string>>
  /** 只保留该设备的记录 */
  deviceId?: string
  /** 只保留该结果的记录；`'all'` 或不传 = 全部 */
  result?: ChangeResult | 'all'
}

export interface AddressPoolRow {
  device: string
  name: string
  network: string
  gateway: string
  range: string
  dns: string
}

export interface InterfaceIpRow {
  device: string
  iface: string
  ip: string
}

export interface ChangeReportInput {
  records: readonly ChangeRecord[]
  options?: ChangeReportOptions
  /** 生成时刻，默认 `Date.now()`；测试注入固定值 */
  now?: number
}

const KIND_LABEL: Record<ChangeKind, string> = { apply: '下发', restore: '回滚', save: '保存' }
const RESULT_LABEL: Record<ChangeResult, string> = {
  ok: '✔ 成功',
  failed: '✘ 失败',
  rejected: '⊘ 被拒',
  blocked: '⊘ 被拦截'
}
/** 概览表与筛选用的固定顺序，避免依赖对象键序 */
const KINDS: readonly ChangeKind[] = ['apply', 'restore', 'save']
const RESULTS: readonly ChangeResult[] = ['ok', 'failed', 'rejected', 'blocked']

/** 表格单元格转义：`|` 会截断列，换行会把一行拆成两行 */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** 空值统一成 `—` —— 留白会让读者分不清「没解析出来」和「本来就没有」 */
function orDash(s: string): string {
  return s.trim() ? s : '—'
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时间 `MM-DD HH:mm:ss`（详情行）/ `YYYY-MM-DD HH:mm:ss`（页脚） */
function fmtAt(ts: number, withDate = false): string {
  const d = new Date(ts)
  const head = withDate ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
  return `${head}${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 点分掩码 / 前缀长 → 前缀长；非法或非连续掩码返回 null（宁可不写，不写错） */
export function prefixOfMask(mask: string): number | null {
  if (/^\d+$/.test(mask)) {
    const p = Number(mask)
    return p >= 0 && p <= 32 ? p : null
  }
  const parts = mask.split('.')
  if (parts.length !== 4) return null
  let bits = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    bits = (bits << 8) | n
  }
  bits = bits >>> 0
  let ones = 0
  let seenZero = false
  for (let i = 31; i >= 0; i--) {
    if (((bits >>> i) & 1) === 1) {
      if (seenZero) return null
      ones++
    } else {
      seenZero = true
    }
  }
  return ones
}

/** 把 `ip address` 的 ip + mask 渲染成 `10.0.12.1/24`；掩码不可解析时保留原文 */
function ipWithMask(ip: string, mask: string): string {
  const p = prefixOfMask(mask)
  return p === null ? `${ip} ${mask}` : `${ip}/${p}`
}

// —— 命令解析（地址池 / 接口 IP）——

const RE_POOL_START = /^(?:ip pool|dhcp server ip-pool)\s+(\S+)$/i
const RE_NETWORK = /^network\s+(\S+)(?:\s+mask\s+(\S+))?$/i
const RE_GATEWAY = /^gateway-list\s+(.+)$/i
const RE_RANGE = /^range\s+(\S+)(?:\s+(\S+))?$/i
const RE_DNS = /^dns-list\s+(.+)$/i
const RE_IFACE = /^interface\s+(.+)$/i
const RE_IP_ADDR = /^ip address\s+(\S+)\s+(\S+)/i
const RE_QUIT = /^quit$/i

/** 逗号化列表（`gateway-list 1.1.1.1 2.2.2.2` → `1.1.1.1, 2.2.2.2`） */
function joinList(raw: string): string {
  return raw.trim().split(/\s+/).join(', ')
}

/**
 * 从已成功下发的 apply 记录里反推地址池（`dhcp server ip-pool` / `ip pool` 语法都认）。
 *
 * 同一设备同名池被多次下发时取**最后一次**（按时间正序覆盖），反映最终状态。
 */
export function parseAddressPools(
  records: readonly ChangeRecord[],
  label: (deviceId: string) => string
): AddressPoolRow[] {
  const byKey = new Map<string, AddressPoolRow & { seq: number }>()
  let seq = 0
  for (const r of orderedOkApplies(records)) {
    const device = label(r.deviceId)
    let cur: (AddressPoolRow & { seq: number }) | undefined
    for (const raw of r.commands) {
      const cmd = raw.trim()
      const start = RE_POOL_START.exec(cmd)
      if (start) {
        // 同名池重新定义 = 新的一条，覆盖旧值（key 相同故 Map 位置不变）
        cur = { device, name: start[1], network: '', gateway: '', range: '', dns: '', seq: seq++ }
        byKey.set(`${r.deviceId}|${start[1]}`, cur)
        continue
      }
      if (RE_QUIT.test(cmd)) {
        cur = undefined
        continue
      }
      if (!cur) continue
      const net = RE_NETWORK.exec(cmd)
      if (net) {
        cur.network = net[2] ? ipWithMask(net[1], net[2]) : net[1]
        continue
      }
      const gw = RE_GATEWAY.exec(cmd)
      if (gw) {
        cur.gateway = joinList(gw[1])
        continue
      }
      const rg = RE_RANGE.exec(cmd)
      if (rg) {
        cur.range = rg[2] ? `${rg[1]} ~ ${rg[2]}` : rg[1]
        continue
      }
      const dns = RE_DNS.exec(cmd)
      if (dns) cur.dns = joinList(dns[1])
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.device.localeCompare(b.device, 'zh') || a.name.localeCompare(b.name, 'zh'))
    .map(({ device, name, network, gateway, range, dns }) => ({
      device,
      name,
      network,
      gateway,
      range,
      dns
    }))
}

/**
 * 从已成功下发的 apply 记录里反推接口 IP。
 *
 * 跟踪 `interface` / `quit` 上下文栈 —— VRP 里 `ip address` 只在其所属接口块内有效，
 * 不跟踪就会把 `interface Vlanif 10` 的地址挂到上一个接口上。
 */
export function parseInterfaceIps(
  records: readonly ChangeRecord[],
  label: (deviceId: string) => string
): InterfaceIpRow[] {
  const byKey = new Map<string, InterfaceIpRow>()
  for (const r of orderedOkApplies(records)) {
    const device = label(r.deviceId)
    let iface: string | undefined
    for (const raw of r.commands) {
      const cmd = raw.trim()
      const ifc = RE_IFACE.exec(cmd)
      if (ifc) {
        iface = ifc[1]
        continue
      }
      if (RE_QUIT.test(cmd)) {
        iface = undefined
        continue
      }
      const ip = RE_IP_ADDR.exec(cmd)
      if (ip && iface) byKey.set(`${r.deviceId}|${iface}`, { device, iface, ip: ipWithMask(ip[1], ip[2]) })
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.device.localeCompare(b.device, 'zh') || a.iface.localeCompare(b.iface, 'zh')
  )
}

/**
 * 只保留成功的 apply、按时间正序 —— 两张 IP 表共用这一条口径。
 *
 * 返回类型把 `commands` 收窄成必填：`Array.prototype.filter` 不会把谓词里的收窄
 * 带到返回类型上，不显式收窄后面每处 `r.commands` 都要再写一次 `?.`。
 */
function orderedOkApplies(records: readonly ChangeRecord[]): Array<ChangeRecord & { commands: string[] }> {
  const out: Array<ChangeRecord & { commands: string[] }> = []
  for (const r of records) {
    if (r.kind === 'apply' && r.result === 'ok' && r.commands?.length) out.push(r as ChangeRecord & { commands: string[] })
  }
  return out.sort((a, b) => a.at - b.at)
}

// —— 正文 ——

/** 代码块围栏：正文里若出现 ``` 就升到 4 个反引号，否则块会被提前闭合 */
function fence(body: string): string[] {
  const ticks = body.includes('```') ? '````' : '```'
  return [ticks, ...body.split('\n'), ticks]
}

export function buildChangeReport(input: ChangeReportInput): string {
  const opts = input.options ?? {}
  const label = (deviceId: string): string => opts.deviceLabels?.[deviceId] ?? deviceId
  const all = filterRecords(input.records, opts)

  const lines: string[] = []
  const title = opts.title?.trim() || '设备配置命令报告'
  const note = describeScope(opts)

  lines.push(`# ${title}`, '')
  lines.push(`> 生成时间：${fmtAt(input.now ?? Date.now(), true)} · 数据来源：本地变更记录（changes.json）`)
  if (note) lines.push(`> 统计口径：${note}`)
  lines.push('')

  if (all.length === 0) {
    lines.push('## 一、概览', '', '本次筛选条件下没有配置变更记录。', '')
    lines.push(...footer())
    return lines.join('\n')
  }

  const asc = all.slice().sort((a, b) => a.at - b.at)

  lines.push(...overviewSection(all))
  lines.push(...ipSection(asc, label))
  lines.push(...processSection(asc, label))
  lines.push(...failureSection(asc, label))
  lines.push(...footer())

  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** 工具与 UI 两条出口共用同一份筛选逻辑（否则 agent 看到的和用户导出的不是一份东西） */
function filterRecords(records: readonly ChangeRecord[], opts: ChangeReportOptions): ChangeRecord[] {
  return records.filter((r) => {
    if (opts.deviceId && r.deviceId !== opts.deviceId) return false
    if (opts.result && opts.result !== 'all' && r.result !== opts.result) return false
    return true
  })
}

function describeScope(opts: ChangeReportOptions): string {
  const parts = ['仅统计代理实际下发的配置变更（下发 / 回滚 / 保存），不含 display、ping 等只读命令']
  if (opts.deviceId) parts.push(`仅限设备 ${opts.deviceId}`)
  if (opts.result && opts.result !== 'all') parts.push(`仅含「${RESULT_LABEL[opts.result]}」的记录`)
  return parts.join('；')
}

function overviewSection(all: readonly ChangeRecord[]): string[] {
  const lines: string[] = ['## 一、概览', '']
  const devices = new Set(all.map((r) => r.deviceId))
  const times = all.map((r) => r.at)

  lines.push('| 项目 | 值 |', '|---|---|')
  lines.push(`| 变更总数 | ${all.length} |`)
  lines.push(`| 涉及设备 | ${devices.size} |`)
  lines.push(`| 时间范围 | ${fmtAt(Math.min(...times))} ~ ${fmtAt(Math.max(...times))} |`)
  lines.push('')

  lines.push('| 类型 | 总数 | 成功 | 失败 | 被拒 | 被拦截 |', '|---|---|---|---|---|---|')
  for (const kind of KINDS) {
    const of = all.filter((r) => r.kind === kind)
    lines.push(
      `| ${KIND_LABEL[kind]} | ${of.length} | ${RESULTS.map((x) => of.filter((r) => r.result === x).length).join(' | ')} |`
    )
  }
  lines.push(
    `| **合计** | ${all.length} | ${RESULTS.map((x) => all.filter((r) => r.result === x).length).join(' | ')} |`
  )
  lines.push('')
  return lines
}

function ipSection(asc: readonly ChangeRecord[], label: (id: string) => string): string[] {
  const pools = parseAddressPools(asc, label)
  const ifaces = parseInterfaceIps(asc, label)
  const lines: string[] = ['## 二、IP 地址规划', '']

  if (pools.length === 0 && ifaces.length === 0) {
    lines.push('本次变更记录中未包含可推导的地址规划命令（`ip pool` / `network` / `ip address` 等）。', '')
    return lines
  }

  if (pools.length) {
    lines.push('### 2.1 DHCP 地址池', '')
    lines.push('| 设备 | 池名 | 网段 | 网关 | 地址范围 | DNS |', '|---|---|---|---|---|---|')
    for (const p of pools) {
      lines.push(
        `| ${cell(p.device)} | ${cell(p.name)} | ${cell(orDash(p.network))} | ${cell(orDash(p.gateway))} | ` +
          `${cell(orDash(p.range))} | ${cell(orDash(p.dns))} |`
      )
    }
    lines.push('')
  }

  if (ifaces.length) {
    lines.push('### 2.2 接口 IP', '')
    lines.push('| 设备 | 接口 | IP/掩码 |', '|---|---|---|')
    for (const r of ifaces) lines.push(`| ${cell(r.device)} | ${cell(r.iface)} | ${cell(r.ip)} |`)
    lines.push('')
  }

  lines.push(
    '> 两张表由**已成功下发**的 `apply_config` 命令推导，反映最近一次下发结果；' +
      '若之后执行过回滚，表内条目可能已不在设备上，请以设备当前配置为准。',
    ''
  )
  return lines
}

function processSection(asc: readonly ChangeRecord[], label: (id: string) => string): string[] {
  const lines: string[] = ['## 三、配置实施过程', '']

  // 设备顺序按首次变更时间正序 —— 与「实施过程」的叙事顺序一致，不按字典序
  const order: string[] = []
  for (const r of asc) if (!order.includes(r.deviceId)) order.push(r.deviceId)

  order.forEach((deviceId, di) => {
    const mine = asc.filter((r) => r.deviceId === deviceId)
    const name = label(deviceId)
    const head = name === deviceId ? deviceId : `${name}（${deviceId}）`
    lines.push(`### 3.${di + 1} ${head}`, '')

    lines.push('| # | 时间 | 类型 | 结果 | 依据快照 | 校验 | 说明 |', '|---|---|---|---|---|---|---|')
    mine.forEach((r, i) => {
      lines.push(
        `| ${i + 1} | ${fmtAt(r.at)} | ${KIND_LABEL[r.kind]} | ${RESULT_LABEL[r.result]} | ` +
          `${cell(r.snapshotId ?? '—')} | ${verifyText(r)} | ${cell(r.description)} |`
      )
    })
    lines.push('')

    const okCommands = mine.filter(
      (r): r is ChangeRecord & { commands: string[] } => r.result === 'ok' && !!r.commands?.length
    )
    if (okCommands.length) {
      const body = okCommands.map((r) => r.commands.join('\n')).join('\n------\n')
      lines.push('**配置命令**（按时间正序拼接，可直接整段复制回设备）', '')
      lines.push(...fence(body), '')
    } else {
      lines.push('**配置命令**：该设备没有成功生效的变更，命令原文见「四、失败与拦截记录」。', '')
    }

    const bad = mine.filter((r) => r.result !== 'ok')
    if (bad.length) {
      lines.push(
        `> ⚠ 另有 ${bad.length} 条未生效的变更（明细中的第 ${bad.map((r) => mine.indexOf(r) + 1).join('、')} 条），见第四部分。`,
        ''
      )
    }
  })

  return lines
}

/** 期望校验结论：没写 expectation 就是一栏 `—`，别把「未校验」渲染成「未通过」 */
function verifyText(r: ChangeRecord): string {
  if (r.verified === undefined) return r.expectation ? '未执行' : '—'
  const exp = r.expectation ? `\`${r.expectation.command}\`` : '期望校验'
  return `${exp} ${r.verified ? '✔ 通过' : '✘ 未通过'}`
}

function failureSection(asc: readonly ChangeRecord[], label: (id: string) => string): string[] {
  const bad = asc.filter((r) => r.result !== 'ok')
  const lines: string[] = ['## 四、失败与拦截记录', '']
  if (bad.length === 0) {
    lines.push('本次范围内所有变更均执行成功。', '')
    return lines
  }

  bad.forEach((r, i) => {
    const name = label(r.deviceId)
    const head = name === r.deviceId ? r.deviceId : `${name}（${r.deviceId}）`
    lines.push(`### 4.${i + 1} ${RESULT_LABEL[r.result]} · ${KIND_LABEL[r.kind]} · ${head} · ${fmtAt(r.at)}`, '')
    lines.push('| 项目 | 值 |', '|---|---|')
    lines.push(`| 说明 | ${cell(r.description)} |`)
    if (r.snapshotId) lines.push(`| 依据快照 | ${cell(r.snapshotId)} |`)
    if (r.expectation) {
      lines.push(
        `| 期望校验 | \`${cell(r.expectation.command)}\` ${r.expectation.mode} \`${cell(r.expectation.expect)}\` |`
      )
    }
    lines.push(`| 错误 | ${r.error ? `\`${cell(r.error.code)}\` ${cell(r.error.message)}` : '—'} |`)
    lines.push('')
    if (r.commands?.length) {
      lines.push(...fence(r.commands.join('\n')), '')
    } else {
      lines.push('（本条记录没有留下命令）', '')
    }
  })
  return lines
}

function footer(): string[] {
  return [
    '---',
    '',
    '> 本报告由 ensp-auto 依据本地变更记录自动生成。' +
      '变更记录每设备最多保留 200 条，更早的记录会被裁剪 —— 需要长期留档请及时导出。',
    ''
  ]
}
