/**
 * 结构化验证解析器（v1.2，参照 ensp-mcp connectivity_analysis / dhcp_verification_service）。
 *
 * 把 VRP 回显解析成结构化判定：ping 统计、display interface brief 状态行、DHCP 池信息。
 * 全部纯函数，供 verify_* 工具与单测复用。
 */

export interface PingStats {
  transmitted: number
  received: number
  lossPercent: number
  minMs?: number
  avgMs?: number
  maxMs?: number
  unreachable: boolean
}

/** 解析 `ping -c N <ip>` 的 VRP 回显（英文统计行；乱码/未命中返回 null） */
export function parsePingOutput(text: string): PingStats | null {
  const stats = /(\d+)\s+packet\(s\)\s+transmitted,\s+(\d+)\s+packet\(s\)\s+received[^,]*,\s*([\d.]+)%\s+packet\s+loss/i.exec(text)
  if (!stats) return null
  const transmitted = Number.parseInt(stats[1]!, 10)
  const received = Number.parseInt(stats[2]!, 10)
  const lossPercent = Number.parseFloat(stats[3]!)
  const rtt = /round-trip\s+min\/avg\/max\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/i.exec(text)
  return {
    transmitted,
    received,
    lossPercent,
    ...(rtt ? { minMs: Number.parseFloat(rtt[1]!), avgMs: Number.parseFloat(rtt[2]!), maxMs: Number.parseFloat(rtt[3]!) } : {}),
    unreachable: received === 0
  }
}

export interface InterfaceStatusRow {
  name: string
  /** 物理层状态 up/down */
  phy: string
  /** 协议状态 up/down */
  protocol: string
  description?: string
}

/** 解析 `display interface brief` 表格（Interface | PHY | Protocol | …），描述列可选 */
export function parseInterfaceBrief(text: string): InterfaceStatusRow[] {
  const rows: InterfaceStatusRow[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^Interface\s/i.test(line)) continue
    if (/^[-=+\s]+$/.test(line)) continue
    const m = /^(\S+)\s+(up|down)\s+(up|down)(?:\s+(\S.*))?$/i.exec(line)
    if (!m) continue
    const name = m[1]!
    if (!/^[A-Za-z]/.test(name)) continue
    rows.push({
      name,
      phy: m[2]!.toLowerCase(),
      protocol: m[3]!.toLowerCase(),
      ...(m[4]?.trim() ? { description: m[4].trim() } : {})
    })
  }
  return rows
}

/** 当前配置文本里是否存在 DHCP 服务/池相关配置 */
export function hasDhcpConfig(text: string): boolean {
  return /dhcp\s+select\b|\bdhcp\s+server\b|\bip\s+pool\b|\bdhcp\s+relay\b|\bdhcp\s+enable\b/i.test(text)
}

export interface DhcpPool {
  name: string
  networkSection?: string
  startAddress?: string
  endAddress?: string
  totalAddresses?: number
  usedAddresses?: number
}

/** 解析 `display ip pool` 回显（多池/单池皆可；只取 ≤12 池，块头丢失时用未命名池占位） */
export function parseDhcpPools(text: string): DhcpPool[] {
  const out: DhcpPool[] = []
  // 按 Pool name 分块；无 `Pool name:` 头（自由格式）时整体视为一个未命名池
  const nameRe = /^\s*Pool\s+name\s*:\s*(\S+)/gm
  const matches = [...text.matchAll(nameRe)]
  const blocks: { name: string; block: string }[] = []
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i]![1]!
    const start = matches[i]!.index + matches[i]![0].length
    const end = i + 1 < matches.length ? matches[i + 1]!.index : text.length
    blocks.push({ name, block: text.slice(start, end) })
  }
  if (blocks.length === 0 && text.trim()) blocks.push({ name: '', block: text })

  for (const part of blocks) {
    const num = (k: RegExp): number | undefined => {
      const m = k.exec(part.block)
      return m && m[1] ? Number.parseInt(m[1]!.replace(/[^\d]/g, ''), 10) : undefined
    }
    const pool: DhcpPool = { name: part.name || `pool${out.length + 1}` }
    const net = /Network\s+section\s*[:：]\s*([\d.]+)\s+.*?netmask\s*[:：]\s*([\d.]+)/i.exec(part.block)
    if (net) pool.networkSection = `${net[1]}/${maskToPrefix(net[2]!)}`
    const start = /Start-address\s*[:：]?[\s]*([\d.]+)/i.exec(part.block)
    if (start) pool.startAddress = start[1]
    const end = /End-address\s*[:：]?[\s]*([\d.]+)/i.exec(part.block)
    if (end) pool.endAddress = end[1]
    const total = num(/Total\s+addresses\s*[:：]\s*(\d+)/i)
    if (total !== undefined) pool.totalAddresses = total
    const used = num(/Used\s+addresses\s*[:：]\s*(\d+)/i)
    if (used !== undefined) pool.usedAddresses = used
    out.push(pool)
    if (out.length >= 12) break
  }
  return out
}

function maskToPrefix(mask: string): number {
  let bits = 0
  let seenZero = false
  for (const raw of mask.split('.')) {
    const p = Number.parseInt(raw, 10)
    if (Number.isNaN(p) || p < 0 || p > 255) return 32
    for (let b = 7; b >= 0; b--) {
      if (((p >> b) & 1) === 1) {
        if (seenZero) return bits // 1 出现在 0 之后：非法掩码，按已计位数返回
        bits += 1
      } else {
        seenZero = true
      }
    }
  }
  return bits
}

// ———————————————————— v2：路由 / ARP / NAT / Eth-Trunk ————————————————————
// 与任务库新增（static_route / rip / acl_nat / eth_trunk）配套的结构化解析器，
// 供 verify_route / verify_arp / verify_nat / verify_eth_trunk 与单测复用。

const IPV4_TOKEN_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
// VRP 的 MAC 有三种形态：xx-xx-xx-xx-xx-xx、xxxx-xxxx-xxxx、xxxx.xxxx.xxxx
const MAC_TOKEN_RE =
  /^(?:[0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2}$|^(?:[0-9a-fA-F]{4}[-.]){2}[0-9a-fA-F]{4}$/

export interface RoutingEntry {
  /** 目标网段，如 10.0.12.0/24 */
  network: string
  /** 协议：Direct / Static / OSPF / RIP / UNR 等 */
  protocol: string
  preference?: number
  cost?: number
  nextHop: string
  interface?: string
}

/** 解析 `display ip routing-table` 回显（IPv4 路由行；表头/汇总/分隔线跳过） */
export function parseRoutingTable(text: string): RoutingEntry[] {
  const rows: RoutingEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^Destinations\s*:/i.test(line)) continue
    if (/^Routes\s*:/i.test(line)) continue
    if (/^Routing\s+Table/i.test(line)) continue
    if (/^Route\s+Flags/i.test(line)) continue
    if (/^Destination\/Mask/i.test(line)) continue
    if (/^Huawei|^Total|^---+/i.test(line)) continue
    const m = /^(\S+\/\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+\S+\s+(\S+)(?:\s+(\S.*))?$/.exec(line)
    if (!m) continue
    const extra = m[6]?.trim() ?? ''
    const entry: RoutingEntry = {
      network: m[1]!,
      protocol: m[2]!,
      preference: Number.parseInt(m[3]!, 10),
      cost: Number.parseInt(m[4]!, 10),
      nextHop: m[5]!
    }
    if (extra && !IPV4_TOKEN_RE.test(extra)) entry.interface = extra
    rows.push(entry)
    if (rows.length >= 200) break
  }
  return rows
}

export interface ArpEntry {
  ip: string
  mac: string
  /** I（接口学习）/ O / S / D 等 */
  type?: string
  interface?: string
}

/** 解析 `display arp` 回显：兼容带 VLAN 列与路由器 EXPIRE 列的两种表格 */
export function parseArpTable(text: string): ArpEntry[] {
  const out: ArpEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const tokens = line.split(/\s+/)
    if (!IPV4_TOKEN_RE.test(tokens[0] ?? '')) continue
    const macIdx = tokens.findIndex((t, i) => i > 0 && MAC_TOKEN_RE.test(t))
    if (macIdx < 0) continue
    const mac = tokens[macIdx]!
    const after = tokens.slice(macIdx + 1)
    const typeRe = /^[IOSD]$/i
    const type = after.find((t) => typeRe.test(t))
    // 接口列排除：表格里的 VLAN/EXPIRE 数字、分隔线
    const iface = after.find((t) => !typeRe.test(t) && !/^-+$/.test(t) && !/^\d+$/.test(t))
    out.push({
      ip: tokens[0]!,
      mac,
      ...(type ? { type: type.toUpperCase() } : {}),
      ...(iface ? { interface: iface } : {})
    })
    if (out.length >= 200) break
  }
  return out
}

export interface NatOutboundEntry {
  interface: string
  acl: number
  /** 地址/接口：current-interface / 地址池名等 */
  address: string
  /** easyip / address-group 等 */
  type: string
}

/** 解析 `display nat outbound` 的表格部分 */
export function parseNatOutbound(text: string): NatOutboundEntry[] {
  const out: NatOutboundEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)/.exec(line)
    if (!m) continue
    if (/Interface|------/.test(line)) continue
    out.push({ interface: m[1]!, acl: Number.parseInt(m[2]!, 10), address: m[3]!, type: m[4]! })
    if (out.length >= 50) break
  }
  return out
}

export interface NatServerEntry {
  iface: string
  /** 如 current-interface/8080 */
  global: string
  /** 如 192.168.1.100/80 */
  inside: string
  protocol?: string
}

/** 解析 `display nat server` 回显（按 Interface 分块） */
export function parseNatServer(text: string): NatServerEntry[] {
  const out: NatServerEntry[] = []
  let cur: NatServerEntry | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const ifaceM = /^Interface\s*:\s*(\S+)/i.exec(line)
    if (ifaceM) {
      cur = { iface: ifaceM[1]!, global: '', inside: '' }
      out.push(cur)
      continue
    }
    if (!cur) continue
    const g = /Global\s+IP\/Port\s*:\s*(\S+)/i.exec(line)
    if (g) cur.global = g[1]!
    const i = /Inside\s+IP\/Port\s*:\s*(\S+)/i.exec(line)
    if (i) cur.inside = i[1]!
    const p = /Protocol\s*:\s*(\S+)/i.exec(line)
    if (p) cur.protocol = p[1]!.toLowerCase()
  }
  return out.filter((e) => e.global || e.inside)
}

export interface EthTrunkMember {
  port: string
  status: string
}

export interface EthTrunkInfo {
  /** 如 Eth-Trunk1 */
  trunk: string
  /** NORMAL / STATIC 等 */
  workingMode?: string
  /** up / down */
  operateStatus?: string
  upPorts?: number
  members: EthTrunkMember[]
}

/** 解析 `display eth-trunk [N]` 回显（取第一个聚合组块） */
export function parseEthTrunk(text: string): EthTrunkInfo | null {
  const first = /^(\S+?)'s\s+state\s+information/i.exec(text)
  if (!first) return null
  const block = text.slice(first.index)
  const next = /^(\S+?)'s\s+state\s+information/im.exec(block.slice(first[0].length))
  const body = next ? block.slice(0, next.index + first[0].length) : block
  const info: EthTrunkInfo = { trunk: first[1]!, members: [] }
  const wm = /WorkingMode\s*:\s*(\S+)/i.exec(body)
  if (wm) info.workingMode = wm[1]!.toUpperCase()
  const os = /Operate\s+status\s*:\s*(\S+)/i.exec(body)
  if (os) info.operateStatus = os[1]!.toLowerCase()
  const up = /Number\s+Of\s+Up\s+Port\s+In\s+Trunk\s*:\s*(\d+)/i.exec(body)
  if (up) info.upPorts = Number.parseInt(up[1]!, 10)
  for (const raw of body.split('\n')) {
    const m = /^(\S+)\s+(up|down)\s+(\d+)/i.exec(raw.trim())
    if (!m) continue
    if (/^Eth-Trunk/.test(m[1]!)) continue
    info.members.push({ port: m[1]!, status: m[2]!.toLowerCase() })
  }
  return info
}

export interface IpNetwork {
  base: number
  prefix: number
}

/** 把 IPv4 点分十进制转 32 位整数 */
export function ipToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

/** 把 "10.0.12.0/24" 解析成 { base, prefix }；非法返回 null。
 *  默认路由 0.0.0.0/0（prefix=0）必须是合法输入（D10）：
 *  旧实现 `prefix < 1` 把它当非法，导致路由表里的默认路由永远匹配不上任何目标，
 *  走默认路由可达的目的地被 verify_route 误报 absent。 */
export function parseNetwork(network: string): IpNetwork | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(network.trim())
  if (!m) return null
  const base = ipToInt(m[1]!)
  const prefix = Number.parseInt(m[2]!, 10)
  if (base === null || prefix < 0 || prefix > 32) return null
  // prefix===0 时归一化为 0（覆盖全部地址）；JS 移位以 32 为模，直接 shift 会得到原值
  return { base: prefix === 0 ? 0 : (base >> (32 - prefix)) << (32 - prefix), prefix }
}

/** 从 "10.0.12.0/24" 这类条目里抽出前缀长度（用于最长前缀排序）；解析失败按 0 处理 */
export function networkPrefix(network: string): number {
  const m = /^\S+\/(\d+)$/.exec(network.trim())
  return m ? Number.parseInt(m[1]!, 10) : 0
}

/** 判断路由表条目是否匹配目标：支持网段（含掩码）或裸 IP（按最长前缀） */
export function routeMatches(entry: RoutingEntry, target: string): boolean {
  const net = parseNetwork(entry.network)
  if (!net) return false
  if (target.includes('/')) {
    const want = parseNetwork(target)
    return want !== null && want.base === net.base && want.prefix === net.prefix
  }
  const ip = ipToInt(target)
  if (ip === null) return false
  const mask = net.prefix === 0 ? 0 : (0xffffffff << (32 - net.prefix)) >>> 0
  return (ip & mask) === net.base
}