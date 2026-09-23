import fs from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { guessRole, type Topology, type TopologyLink, type TopologyNode } from './model'

/**
 * 工程文件解析（来源一 / F-5.2）：eNSP .topo → 拓扑，三层降级的第一层。
 *
 * .topo 以明文 XML 为主（<topo …><devices><device name= model= x= y= devid= com_port= />…
 * <interfacePair>…），小部分为 gzip 压缩；文件头可能声明 encoding="UNICODE"（实为 UTF-16BOM）。
 *
 * 解析策略：**容错正则 tokenizer，不引 XML 依赖**。只提取能力所需属性，未知元素一律忽略；
 * 真实 eNSP 各版本字段名有差异，解析结果带结构报告（设备/链路数 + warnings）供 UI 与代理
 * 判断可靠度；解析到 0 设备时告警「真机格式待校准」，不抛错。
 */

export interface TopoParseReport {
  devices: number
  links: number
  encoding: string
  gzipped: boolean
  warnings: string[]
}

export interface TopoParseResult {
  topology: Topology
  report: TopoParseReport
}

export interface DecodedTopo {
  xml: string
  gzipped: boolean
  encoding: string
}

/**
 * 文本字节解码：严格 UTF-8 优先；非法（真机中文版 .topo 实为 GBK，且头部谎称
 * encoding="UNICODE"）时回退 GBK。与通信层 encoding.ts 同一套判据（严格校验优先）。
 */
function decodeText(buf: Buffer): { text: string; encoding: 'utf8' | 'gbk' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8' }
  } catch {
    return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' }
  }
}

/** 解码原始字节：gzip 魔数 → gunzip；BOM → utf-16le/be；否则按 UTF-8/GBK 智能解码 */
export function decodeTopo(buf: Buffer): DecodedTopo {
  const gzipped = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b
  let xml: string
  let encoding = 'utf8'
  if (gzipped) {
    const d = decodeText(gunzipSync(buf))
    xml = d.text
    encoding = d.encoding
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    xml = buf.subarray(2).toString('utf16le')
    encoding = 'utf16le'
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    xml = swapBytes(buf.subarray(2)).toString('utf16le')
    encoding = 'utf16be'
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const d = decodeText(buf.subarray(3))
    xml = d.text
    encoding = d.encoding
  } else {
    const d = decodeText(buf)
    xml = d.text
    encoding = d.encoding
  }
  return { xml, gzipped, encoding }
}

function swapBytes(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length)
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out[i] = buf[i + 1]!
    out[i + 1] = buf[i]!
  }
  return out
}

interface ParsedDevice {
  name: string
  model?: string
  x?: number
  y?: number
  devid?: string
  comPort?: number
}

const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/gi

/** 最小 XML 实体解码（写回自产的 &amp;/&lt;/&gt;/&quot;/&apos; 与真机同名） */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(ATTR_RE)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? '')
  }
  return out
}

interface DeviceElement {
  /** 开标签属性原文（进 parseAttrs） */
  attrs: string
  /** 成对元素内部 XML（含 <slot>/<interface> 等接口定义），自闭合为空串 */
  inner: string
}

/** 在 XML 里提取设备元素（优先 <devices> 容器；找不到则排除 interfacePair 块后全量扫）。
 *  兼容成对 `<dev …>…</dev>`（取内部接口定义）与自闭合 `<dev …/>` 两种形态。 */
function extractDeviceElements(xml: string): DeviceElement[] {
  const devBlock = /<devices[^>]*>([\s\S]*?)<\/devices>/i.exec(xml)
  const source = devBlock ? devBlock[1]! : xml.replace(/<interfacePair[\s\S]*?<\/interfacePair>/gi, '')
  const out: DeviceElement[] = []
  // 成对优先（非贪婪取到首个闭合标签），否则按自闭合
  const re =
    /<\s*(?:device|dev)\b([^>]*)>([\s\S]*?)<\/\s*(?:device|dev)\s*>|<\s*(?:device|dev)\b([^>]*?)\/\s*>/gi
  for (const m of source.matchAll(re)) {
    if (m[1] !== undefined) out.push({ attrs: m[1] ?? '', inner: m[2] ?? '' })
    else out.push({ attrs: m[3] ?? '', inner: '' })
  }
  return out
}

/**
 * 从设备元素内部 XML 解析「有序接口名数组」。
 * - 标准格式：<slot …><interface sztype="Ethernet" interfacename="GE" count="4"/></slot>
 *   → 按 count 展开（interfacename + 0/0/{n}，与 ensp-mcp interface_mapping 同构）；
 *     同名类型跨多个 <interface> 分组时连续编号不减号（如 AR2220 的 GE×1 + GE×2
 *     → GE0/0/0、GE0/0/1、GE0/0/2），避免 0/0/0 重复重置
 * - 编号起点对齐 VRP 真机命名（关键修复，参照 ensp-mcp）：
 *     GE：交换机从 GE0/0/1 起（eNSP 交换机端口标签 1-based），路由器等从 GE0/0/0 起；
 *     Ethernet/Eth：一律从 0/0/1 起（eNSP 中仅交换机出现 Ethernet 口）；
 *     其他类型（Serial/POS/…）：保持 0/0/{n} 原样
 * - 防火墙格式：<interface type="GE" slotIndex="0" cardIndex="0" interfaceIndex="0"/>
 *   → GE0/0/0（slot/card/interface 三段拼接，不做偏移）
 * - 无任何接口定义 → 返回 []（调用方不写 interfaces 字段）
 */
export function parseDeviceInterfaces(innerXml: string, opts?: { isSwitch?: boolean }): string[] {
  const out: string[] = []
  const nameCounters = new Map<string, number>() // interfacename → 已累计数量（同名字段跨分组连续编号）
  const isSwitch = opts?.isSwitch ?? false
  for (const m of innerXml.matchAll(/<interface\b([^>]*?)\/?\s*>/gi)) {
    const a = parseAttrs(m[1] ?? '')
    const base = a['interfacename'] || a['name'] || a['sztype'] || a['type'] || ''
    if (!base) continue
    const hasTriplet = a['slotindex'] !== undefined || a['cardindex'] !== undefined || a['interfaceindex'] !== undefined
    if (hasTriplet) {
      out.push(`${base}${a['slotindex'] ?? 0}/${a['cardindex'] ?? 0}/${a['interfaceindex'] ?? 0}`)
      continue
    }
    const countRaw = a['count']
    const count = countRaw && Number.isFinite(Number(countRaw)) ? Number.parseInt(countRaw, 10) : 1
    const total = Math.max(1, count)
    const start = nameCounters.get(base) ?? 0
    const baseUpper = base.toUpperCase()
    const offset =
      baseUpper === 'GE'
        ? isSwitch
          ? 1
          : 0
        : baseUpper === 'ETHERNET' || baseUpper === 'ETH'
          ? 1
          : 0
    for (let k = 0; k < total; k++) out.push(`${base}0/0/${start + k + offset}`)
    nameCounters.set(base, start + total)
  }
  return out
}

/** 端口序号 → 接口名；越界容错返回 GE0/0/{index}（真机端口序号与接口表不对位时不抛错）。
 *  isSwitch 时兜底也加 1（交换机无 GE0/0/0）。 */
export function resolveInterfaceName(ifaces: string[], index: number, isSwitch?: boolean): string {
  if (index >= 0 && index < ifaces.length && ifaces[index]) return ifaces[index]!
  return `GE0/0/${index + (isSwitch ? 1 : 0)}`
}

/** 从 interfacePair 属性提端口序号 (src, tar)；缺任一/非数字 → null */
function extractPairIndices(attrs: Record<string, string>): [number, number] | null {
  const sRaw = attrs['srcindex'] ?? attrs['src'] ?? attrs['fromindex']
  const tRaw = attrs['tarindex'] ?? attrs['dstindex'] ?? attrs['targetindex'] ?? attrs['toindex']
  if (sRaw === undefined || tRaw === undefined) return null
  const s = Number.parseInt(sRaw, 10)
  const t = Number.parseInt(tRaw, 10)
  if (!Number.isFinite(s) || !Number.isFinite(t)) return null
  return [s, t]
}

/** 解析设备标签的属性（容错字段名变体） */
function parseDevice(attrs: Record<string, string>): ParsedDevice | null {
  const name =
    attrs['name'] ||
    attrs['devicename'] ||
    attrs['label'] ||
    attrs['id'] ||
    attrs['devid'] ||
    attrs['uuid'] ||
    ''
  if (!name.trim()) return null

  const devid = attrs['devid'] || attrs['deviceid'] || attrs['id'] || attrs['uuid'] || undefined
  const portRaw = attrs['com_port'] || attrs['console'] || attrs['consoleport'] || attrs['porte'] || attrs['port']
  const port = portRaw ? Number.parseInt(portRaw, 10) : NaN
  // 真机坐标属性是 cx/cy，旧版/他版用 x/y
  const xRaw = attrs['cx'] ?? attrs['x']
  const yRaw = attrs['cy'] ?? attrs['y']

  return {
    name: name.trim(),
    ...(attrs['model'] ? { model: attrs['model'] } : {}),
    ...(Number.isFinite(Number(xRaw)) ? { x: Number(xRaw) } : {}),
    ...(Number.isFinite(Number(yRaw)) ? { y: Number(yRaw) } : {}),
    ...(devid ? { devid } : {}),
    ...(Number.isFinite(port) ? { comPort: port } : {})
  }
}

/**
 * 解析 interfacePair 端点对（容错：fromdevice/todevice、self/other、name 成对等变体）。
 * 不用泛化 name= 去匹配（会撞上 lineName 属性），端点名只认明确属性；旧版子元素
 * <fromdevice name="…"/> 风格走「两个 name= 兜底」。
 */
function extractLinkEndpoints(block: string): [string, string] | null {
  const picks: string[] = []
  const re =
    /(?:from(?:device|dev|node|name)?|to(?:device|dev|node|name)?|self|other|src(?:device|dev)?id|dst(?:device|dev)?id|dest(?:device|dev)?id|dev(?:ice)?[12]?|node[12]?|endpoint[12]?)="([^"]*)"/gi
  for (const m of block.matchAll(re)) {
    const v = (m[1] ?? '').trim()
    if (v && !picks.includes(v)) {
      picks.push(v)
      if (picks.length === 2) return [picks[0]!, picks[1]!]
    }
  }
  const cleaned = block.replace(/\blineName\s*=\s*"[^"]*"/gi, '')
  const namePair = cleaned.match(/\bname\s*=\s*"([^"]*)"[\s\S]*?\bname\s*=\s*"([^"]*)"/i)
  if (namePair) {
    const a = (namePair[1] ?? '').trim()
    const b = (namePair[2] ?? '').trim()
    if (a && b && a !== b) return [a, b]
  }
  return null
}

/**
 * 从 <line …> 开标签取两端设备 ID（真机新版：srcDeviceID/destDeviceID，值为设备 id/GUID）。
 * 解析器按 GUID/name 通过 idByKey 认亲（见 parseTopoXml）。
 */
function extractLineEndpoints(tag: string): [string, string] | null {
  const src = /(?:src|from|source)(?:device|dev)?id\s*=\s*"([^"]*)"/i.exec(tag)
  const dst = /(?:dst|dest|target|to)(?:device|dev)?id\s*=\s*"([^"]*)"/i.exec(tag)
  if (!src || !dst) return null
  const a = (src[1] ?? '').trim()
  const b = (dst[1] ?? '').trim()
  if (!a || !b || a === b) return null
  return [a, b]
}

/**
 * 解析 .topo XML → Topology。
 * 节点 id = 设备名（文件内唯一，且与 LLDP 邻居名/实采对齐）；
 * deviceId = 有 com_port → 127.0.0.1:<port>（可连接、与实采同形），无 → 缺省。
 */
export function parseTopoXml(xml: string): TopoParseResult {
  const warnings: string[] = []
  const nodes: TopologyNode[] = []
  const links: TopologyLink[] = []
  const idByKey = new Map<string, string>() // name/devid → node id
  const ifacesById = new Map<string, string[]>() // node id → 有序接口名数组
  const switchByKey = new Map<string, boolean>() // node key → 是否交换机（接口编号从 1 起）

  const elements = extractDeviceElements(xml)
  for (const el of elements) {
    const d = parseDevice(parseAttrs(el.attrs))
    if (!d) continue
    const id = d.name
    idByKey.set(id.toLowerCase(), id)
    if (d.devid) idByKey.set(d.devid.toLowerCase(), id)
    const isSwitch = guessRole(d.name, d.model) === 'switch'
    switchByKey.set(id.toLowerCase(), isSwitch)
    const ifaces = parseDeviceInterfaces(el.inner, { isSwitch })
    if (ifaces.length > 0) ifacesById.set(id, ifaces)
    nodes.push({
      id,
      name: d.name,
      role: guessRole(d.name, d.model),
      ...(d.model ? { model: d.model } : {}),
      ...(ifaces.length > 0 ? { interfaces: ifaces } : {}),
      ...(d.comPort ? { deviceId: `127.0.0.1:${d.comPort}` } : {}),
      ...(d.x !== undefined ? { x: d.x } : {}),
      ...(d.y !== undefined ? { y: d.y } : {})
    })
  }
  if (nodes.length === 0) {
    warnings.push('未识别到任何设备。若为新版格式或压缩变体，需按真机 .topo 样例校准解析器。')
  }

  // label 合并器：同端点对多条 interfacePair → 「ifA ↔ ifB / ifA2 ↔ ifB2 …」，全部保留
  // （与 ensp- 参考实现每个 interfacePair 一条独立连线的展示等价：并联链路每对都有标注，不截断）
  const labelByKey = new Map<string, string[]>()
  const seen = new Set<string>()
  const resolveFor = (raw: string): string[] => {
    const id = idByKey.get(raw.toLowerCase()) ?? raw
    return ifacesById.get(id) ?? []
  }
  /** 端口序号 → 接口名（含交换机 1-based 偏移） */
  const resolveIfLabel = (raw: string, index: number): string => {
    const id = idByKey.get(raw.toLowerCase()) ?? raw
    return resolveInterfaceName(resolveFor(raw), index, switchByKey.get(id.toLowerCase()) ?? false)
  }
  const addFileLink = (rawA: string, rawB: string, label?: string): void => {
    const a = idByKey.get(rawA.toLowerCase()) ?? rawA
    const b = idByKey.get(rawB.toLowerCase()) ?? rawB
    if (a === b) return
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (!seen.has(key)) {
      seen.add(key)
      links.push({ id: `file-${a}->${b}`, from: a, to: b, source: 'file', ...(label ? { label } : {}) })
      return
    }
    const prev = links.find((l) => l.id === `file-${a}->${b}`)
    if (prev && label) {
      labelByKey.set(key, labelByKey.get(key) ?? (prev.label ? [prev.label] : []))
      const parts = labelByKey.get(key)!
      if (!parts.includes(label)) {
        parts.push(label)
        prev.label = parts.join(' / ')
      }
    }
  }

  // 1) 真机新版：<line srcDeviceID destDeviceID>（内部 interfacePair 仅含端口序号，无 name 端点）
  for (const m of xml.matchAll(/<\s*line\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\s*line\s*>)/gi)) {
    const ids = extractLineEndpoints(m[1] ?? '')
    if (!ids) continue
    const inner = m[2] ?? ''
    let matched = false
    for (const ip of inner.matchAll(/<interfacePair\b([^>]*?)\/?\s*>/gi)) {
      const idx = extractPairIndices(parseAttrs(ip[1] ?? ''))
      if (!idx) continue
      matched = true
      addFileLink(
        ids[0],
        ids[1],
        `${resolveIfLabel(ids[0], idx[0])} ↔ ${resolveIfLabel(ids[1], idx[1])}`
      )
    }
    if (!matched) addFileLink(ids[0], ids[1])
  }
  // 2) 旧版/他版：interfacePair 自带 name 端点（<fromdevice name="…"/>），兼容自闭合与成对
  for (const m of xml.matchAll(/<\s*interfacePair\b([^>]*?)(?:\/>|>([\s\S]*?)<\/interfacePair>)/gi)) {
    const pair = extractLinkEndpoints(`${m[1] ?? ''} ${m[2] ?? ''}`)
    if (!pair) continue
    const idx = extractPairIndices(parseAttrs(m[1] ?? ''))
    const label = idx
      ? `${resolveIfLabel(pair[0], idx[0])} ↔ ${resolveIfLabel(pair[1], idx[1])}`
      : undefined
    addFileLink(pair[0], pair[1], label)
  }

  return {
    topology: { nodes, links, updatedAt: Date.now() },
    report: { devices: nodes.length, links: links.length, encoding: 'xml', gzipped: false, warnings }
  }
}

/** 读 .topo 文件并解析（gzip / UTF-16 / UTF-8 自动识别） */
export function readTopoFile(filePath: string): TopoParseResult {
  const decoded = decodeTopo(fs.readFileSync(filePath))
  const result = parseTopoXml(decoded.xml)
  result.report.gzipped = decoded.gzipped
  result.report.encoding = decoded.encoding
  return result
}