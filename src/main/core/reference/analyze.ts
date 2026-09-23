/**
 * 参考配置能力学习（v1.2，参照 ensp-mcp reference_config_service / analyze_reference_configs）。
 *
 * 把一份 VRP 参考配置（实验指导书样例 / 标准配置）解析成「能力摘要」：按协议关键字把
 * 配置切段归类，抽取关键命令行，供 AI 代理按图索骥（照参考配置执行任务），也用于生成
 * reference_capabilities 工件。
 *
 * 全部为纯函数，不依赖 Electron 与网络，便于单测。
 */

export type CapabilityKind =
  | 'ospf'
  | 'vlan'
  | 'mstp'
  | 'stp'
  | 'dhcp'
  | 'dhcp-relay'
  | 'vrrp'
  | 'nat'
  | 'acl'
  | 'traffic-filter'
  | 'ipsec'
  | 'gre'
  | 'wifi'
  | 'route'
  | 'interface'
  | 'aaa'
  | 'telnet'
  | 'other'

export interface ConfigSegment {
  kind: CapabilityKind
  keywords: string[]
  /** 所属设备名（取最近一条 sysname；无则不带） */
  device?: string
  /** 段落代表性命令（去重，最多 12 行） */
  lines: string[]
}

export interface CapabilitySummary {
  kind: CapabilityKind
  devices: string[]
  commandCount: number
  highlights: string[]
}

export interface ReferenceAnalysis {
  /** 能力摘要（覆盖的设备/命令量/代表命令） */
  capabilities: CapabilitySummary[]
  /** 出现过的设备名（sysname） */
  devices: string[]
  /** 原始段落（供报告含原始配置片段） */
  segments: ConfigSegment[]
  segmentCount: number
  warning?: string
}

const KIND_RULES: { kind: CapabilityKind; label: string; re: RegExp }[] = [
  { kind: 'mstp', label: 'MSTP', re: /\b(mstp|stp\s+(mode\s+)?mst)\b/i },
  { kind: 'dhcp-relay', label: 'DHCP Relay', re: /\bdhcp\s+relay\b|dhcp\s+select\s+relay/i },
  { kind: 'ospf', label: 'OSPF', re: /\bospf\b|\brid\s+\d+\.\d+\.\d+\.\d+\b|network\s+\S+\s+(area\b|\.\d+\.\d+\.\d+\b|wildcard)/i },
  { kind: 'vlan', label: 'VLAN', re: /\bvlan\s+(batch\s+)?\d+|\bvlan\b.*\b(access|trunk|hybrid)\b/i },
  { kind: 'dhcp', label: 'DHCP', re: /\bdhcp\s+(select|server)\b|\bip\s+pool\b|\bdhcp\s+server\b|\binterface\s+dhcp/i },
  { kind: 'wifi', label: 'WiFi', re: /\b(ssid|vap|ap-group|wlan|fat-ap|fit-ap)\b/i },
  { kind: 'vrrp', label: 'VRRP', re: /\bvrrp\b|\bvirtual-ip\b|\bstandby\s+\d+\.\d+\.\d+\.\d+(\s+vip)?/i },
  { kind: 'ipsec', label: 'IPSec', re: /\bipsec\b|\bproposal\b|\bike\b|\bsa\s+authentication\b|\btunnel\s+transport\b/i },
  { kind: 'gre', label: 'GRE', re: /\btunnel-protocol\s+gre\b|\bgre\s+key\b|interface\s+tunnel/i },
  { kind: 'nat', label: 'NAT', re: /\b(?:nat\b|easy-ip\b|nat-policy\b|address-group\b|acl\s+number\s+\d+\b)/i },
  { kind: 'traffic-filter', label: '流量过滤', re: /\btraffic-filter\b|\btraffic-policy\b|\bclassifier\b|\bbehavior\b/i },
  { kind: 'stp', label: 'STP', re: /\bstp\b|\bportfast\b|\bbpdu-filter\b/i },
  { kind: 'acl', label: 'ACL', re: /\bacl\b|\brule\s+\d+\s+(permit|deny)\b|\bpacket-filter\b/i },
  { kind: 'route', label: '路由', re: /\bip\s+route-static\b|\bdefault-route\b|\bstatic\s+route\b|\bimport\s+direct\b/i },
  { kind: 'interface', label: '接口', re: /^interface\s+\S+/i },
  { kind: 'aaa', label: 'AAA', re: /\baaa\b|\blocal-user\b|\bauthentication-mode\b/i },
  { kind: 'telnet', label: 'Telnet', re: /\bstelnet\b|\btelnet\s+(server|client)?\b|\bvty\b/i },
  { kind: 'other', label: '其他', re: /^[\s\S]+$/ }
]

const KIND_ORDER = new Map(KIND_RULES.map((r, i) => [r.kind, i]))

/** 按空行或 VRP `#` 块分隔符切段（display current-configuration 的块标记；参照 ensp-mcp 空行分段） */
export function splitConfigSegments(text: string): string[] {
  const chunks: string[] = []
  let cur: string[] = []
  const flush = (): void => {
    if (cur.some((l) => l.trim())) {
      chunks.push(cur.join('\n').trim())
      cur = []
    }
  }
  for (const line of text.split('\n')) {
    if (/^\s*#\s*$/.test(line) || /^\s*$/.test(line)) {
      flush()
      continue
    }
    cur.push(line)
  }
  flush()
  return chunks
}

/** 把一段配置归类为主能力类型，返回其匹配到的关键字 */
export function classifySegment(seg: string): { kind: CapabilityKind; keywords: string[] } {
  const hay = seg
  const keywords: string[] = []
  let best: { kind: CapabilityKind; rank: number } | null = null
  for (const rule of KIND_RULES) {
    const m = hay.match(rule.re)
    if (!m) continue
    keywords.push(m[0])
    // 越靠前的规则（特化）优先级越高
    const rank = KIND_ORDER.get(rule.kind) ?? 999
    if (!best || rank < best.rank) best = { kind: rule.kind, rank }
  }
  const kind = best?.kind ?? 'other'
  const unique = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, 6)
  return { kind, keywords: unique }
}

const SYSNAME_RE = /^\s*sysname\s+(\S+)/m

/** 从一行提取设备名（sysname）；无返回 null */
export function deviceFromLine(line: string): string | null {
  const m = SYSNAME_RE.exec(line)
  return m ? m[1]! : null
}

export interface AnalyzeOptions {
  /** 单段保留的最大命令行数（默认 12） */
  maxLinesPerSegment?: number
  /** 总行数上限（默认 3000，防超长输入拖垮） */
  maxTotalLines?: number
}

/** 分析参考配置 → 能力摘要 */
export function analyzeReferenceConfig(text: string, opts?: AnalyzeOptions): ReferenceAnalysis {
  const maxLines = Math.max(1, Math.min(50, opts?.maxLinesPerSegment ?? 12))
  const maxTotal = Math.max(100, Math.min(20000, opts?.maxTotalLines ?? 3000))

  const rawSegments = splitConfigSegments(text)
  let warning: string | undefined
  const totalLines = rawSegments.reduce((n, s) => n + s.split('\n').length, 0)
  if (totalLines > maxTotal) {
    warning = `配置超过 ${maxTotal} 行，分析可能不完整（实际 ${totalLines} 行）`
  }

  const devices: string[] = []
  const segments: ConfigSegment[] = []
  let currentDevice: string | undefined

  for (const seg of rawSegments) {
    // 设备名跟随 semantics：sysname 之后的段落归属该设备
    const sysname = deviceFromLine(seg)
    if (sysname) {
      currentDevice = sysname
      if (!devices.includes(sysname)) devices.push(sysname)
    }
    const { kind, keywords } = classifySegment(seg)
    segments.push({
      kind,
      keywords,
      ...(currentDevice ? { device: currentDevice } : {}),
      lines: uniqueLines(seg.split('\n')).slice(0, maxLines)
    })
  }

  // 汇总为按特化序排列的能力摘要
  const byKind = new Map<CapabilityKind, CapabilitySummary>()
  for (const seg of segments) {
    const cur = byKind.get(seg.kind) ?? {
      kind: seg.kind,
      devices: [] as string[],
      commandCount: 0,
      highlights: [] as string[]
    }
    cur.commandCount += seg.lines.length
    if (seg.device && !cur.devices.includes(seg.device)) cur.devices.push(seg.device)
    for (const l of seg.lines) {
      if (cur.highlights.length < 8 && !cur.highlights.includes(l)) cur.highlights.push(l)
    }
    byKind.set(seg.kind, cur)
  }
  const capabilities = [...byKind.values()]
    .filter((c) => c.kind !== 'other')
    .sort((a, b) => (KIND_ORDER.get(a.kind) ?? 999) - (KIND_ORDER.get(b.kind) ?? 999))

  return {
    capabilities,
    devices,
    segments,
    segmentCount: segments.length,
    ...(warning ? { warning } : {})
  }
}

function uniqueLines(lines: string[]): string[] {
  const out: string[] = []
  for (const raw of lines) {
    const t = raw.trim()
    if (!t) continue
    if (!out.includes(t)) out.push(t)
  }
  return out
}