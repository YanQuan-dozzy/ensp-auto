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

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(ATTR_RE)) {
    out[m[1]!.toLowerCase()] = m[2] ?? ''
  }
  return out
}

/** 在 XML 里提取设备元素（优先 <devices> 容器；找不到则排除 interfacePair 块后全量扫） */
function extractDeviceTags(xml: string): string[] {
  const devBlock = /<devices[^>]*>([\s\S]*?)<\/devices>/i.exec(xml)
  const source = devBlock ? devBlock[1]! : xml.replace(/<interfacePair[\s\S]*?<\/interfacePair>/gi, '')
  const tags: string[] = []
  // 真机用 <dev id=…>，旧版/他版用 <device …>：两种都认
  for (const m of source.matchAll(/<\s*(?:device|dev)\b([^>]*?)\/?\s*>/gi)) {
    tags.push(m[1] ?? '')
  }
  return tags
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

  const tags = extractDeviceTags(xml)
  for (const tagAttr of tags) {
    const d = parseDevice(parseAttrs(tagAttr))
    if (!d) continue
    const id = d.name
    idByKey.set(id.toLowerCase(), id)
    if (d.devid) idByKey.set(d.devid.toLowerCase(), id)
    nodes.push({
      id,
      name: d.name,
      role: guessRole(d.name, d.model),
      ...(d.model ? { model: d.model } : {}),
      ...(d.comPort ? { deviceId: `127.0.0.1:${d.comPort}` } : {}),
      ...(d.x !== undefined ? { x: d.x } : {}),
      ...(d.y !== undefined ? { y: d.y } : {})
    })
  }
  if (nodes.length === 0) {
    warnings.push('未识别到任何设备。若为新版格式或压缩变体，需按真机 .topo 样例校准解析器。')
  }

  const seen = new Set<string>()
  const addFileLink = (rawA: string, rawB: string): void => {
    const a = idByKey.get(rawA.toLowerCase()) ?? rawA
    const b = idByKey.get(rawB.toLowerCase()) ?? rawB
    if (a === b) return
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (seen.has(key)) return // 同端点对去重（一条 line 可有多个 interfacePair）
    seen.add(key)
    links.push({ id: `file-${a}->${b}`, from: a, to: b, source: 'file' })
  }

  // 1) 真机新版：<line srcDeviceID destDeviceID>（内部是自闭合 interfacePair，仅含端口序号）
  for (const m of xml.matchAll(/<\s*line\b([^>]*?)\/?\s*>/gi)) {
    const ids = extractLineEndpoints(m[1] ?? '')
    if (ids) addFileLink(ids[0], ids[1])
  }
  // 2) 旧版/他版：interfacePair 自带 name 端点（<fromdevice name="…"/>），兼容自闭合与成对
  for (const m of xml.matchAll(/<\s*interfacePair\b([^>]*?)(?:\/>|>([\s\S]*?)<\/interfacePair>)/gi)) {
    const pair = extractLinkEndpoints(`${m[1] ?? ''} ${m[2] ?? ''}`)
    if (pair) addFileLink(pair[0], pair[1])
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