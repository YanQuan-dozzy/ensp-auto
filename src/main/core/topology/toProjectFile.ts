import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Topology, TopologyNode } from './model'
import { guessRole } from './model'
import { parseDeviceId } from '@shared/transport'
import { atomicWriteFileSync } from '../fs/atomic'

/**
 * 工程文件写回（v1.1 / F-5.7 反向）：Topology → eNSP .topo 明文 XML。
 *
 * 与 fromProjectFile 成对：解析器能读的字段，这里原样写回（<dev> / <line> / 自闭合
 * interfacePair / cx/cy / com_port），保证 round-trip 自洽。写法贴近真机新版：
 * - <dev id=UUID>（uuid 由 name+model 确定性哈希生成，同拓扑多次保存不抖动）
 * - com_port：有 deviceId（127.0.0.1:<port>）沿用其端口；无则从 startPort 起递增分配
 * - 坐标：有 x/y 用之，无则网格布局
 * - 端口序号：每节点独立递增，作为 interfacePair 的 srcIndex/tarIndex
 * - 编码默认 UTF-16LE + BOM（真机 encoding="UNICODE" 形态），解析器自动识别
 *
 * 已知边界（防过度工程，留注释）：
 * - 不建模各型号真实接口表（s5700 等型号接口各异），只写 GE count = 该节点用到的
 *   最大端口序号 + 1，保证 eNSP 打开后接口数量够用；
 * - 不写 srcBoundRectX/Y 等布线坐标，交给 eNSP 打开后自动布线；
 * - eNSP 加载生成工程的稳定性属真机联调事项（与 README 已知限制同类）。
 */

export interface TopoWriteOptions {
  /** 起始 console 端口（默认 2000；分配时跳过拓扑内已占用端口） */
  startPort?: number
  /** 输出编码：utf16le（BOM，贴近真机）或 utf8（便于 diff），默认 utf16le */
  encoding?: 'utf16le' | 'utf8'
  /** 无坐标节点的网格布局间距（默认 180，横向隔 1.5 倍、4 列换行） */
  gridSpacing?: number
}

export interface TopoWriteReport {
  devices: number
  links: number
  encoding: 'utf16le' | 'utf8'
  /** 设备 name → com_port 分配表（含沿用已有与本次新分配） */
  ports: Record<string, number>
  /** 生成过程提示（如端口冲突重分配） */
  warnings: string[]
}

/** 确定性 UUID（seed 相同则结果相同），供 <dev id> 使用 */
export function stableGuid(seed: string): string {
  const h = createHash('md5').update(seed).digest()
  h[6] = (h[6]! & 0x0f) | 0x50
  h[8] = (h[8]! & 0x3f) | 0x80
  const hex = h.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase()
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 从 deviceId（127.0.0.1:<port> 或 ssh:<host>:<port>）提取端口；无法解析返回 NaN */
function portFromDeviceId(deviceId: string | undefined): number {
  if (!deviceId) return Number.NaN
  const t = parseDeviceId(deviceId)
  if (!t || t.port < 1 || t.port > 65535) return Number.NaN
  return t.port
}

/** 每个节点分配唯一的 console 端口：已有 deviceId 沿用，新节点从 startPort 递增跳过已用 */
function assignPorts(
  nodes: TopologyNode[],
  startPort: number
): { ports: Map<string, number>; warnings: string[] } {
  const ports = new Map<string, number>()
  const used = new Set<number>()
  const warnings: string[] = []
  let next = startPort
  const take = (): number => {
    while (used.has(next)) next++
    used.add(next)
    return next++
  }
  for (const n of nodes) {
    const existing = portFromDeviceId(n.deviceId)
    if (Number.isFinite(existing) && !used.has(existing)) {
      used.add(existing)
      ports.set(n.id, existing)
      continue
    }
    if (Number.isFinite(existing)) {
      warnings.push(`节点 ${n.name} 端口 ${existing} 与其它设备冲突，重新分配`)
    }
    ports.set(n.id, take())
  }
  return { ports, warnings }
}

/** 坐标：有 x/y 用之；无则网格布局（产能稳定性优先，同一拓扑顺序确定不变） */
function assignPositions(nodes: TopologyNode[], gridSpacing: number): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  const hasCoord = (n: TopologyNode): boolean =>
    n.x !== undefined && n.y !== undefined && Number.isFinite(n.x) && Number.isFinite(n.y)
  let col = 0
  let row = 0
  for (const n of nodes) {
    if (hasCoord(n)) {
      pos.set(n.id, { x: n.x!, y: n.y! })
      continue
    }
    const x = 100 + col * (gridSpacing * 1.5)
    const y = 100 + row * gridSpacing
    col += 1
    if (col >= 4) {
      col = 0
      row += 1
    }
    pos.set(n.id, { x, y })
  }
  return pos
}

/** Topology → 明文 XML（无文件副作用） */
export function topologyToXml(topo: Topology, opts?: TopoWriteOptions): { xml: string; report: TopoWriteReport } {
  const startPort = opts?.startPort && opts.startPort > 0 ? opts.startPort : 2000
  const gridSpacing = opts?.gridSpacing && opts.gridSpacing > 0 ? opts.gridSpacing : 180

  // 过滤删除墓碑（合并结果已过滤，再做一次兜底）
  const nodes = topo.nodes.filter((n) => !n.deleted)
  const links = topo.links.filter((l) => !l.deleted)

  const { ports, warnings } = assignPorts(nodes, startPort)
  const pos = assignPositions(nodes, gridSpacing)
  const nodeIds = new Set(nodes.map((n) => n.id))
  const visibleLinks = links.filter((l) => nodeIds.has(l.from) && nodeIds.has(l.to))

  const out: string[] = ['<?xml version="1.0" encoding="UNICODE" ?>', '<topo version="1.3.00.100">']
  out.push('    <devices>')
  for (const n of nodes) {
    const id = stableGuid(`ensp-auto:${n.id}`)
    const p = pos.get(n.id) ?? { x: 100, y: 100 }
    const port = ports.get(n.id) ?? 0
    out.push(
      `        <dev id="${id}" name="${escapeXml(n.name)}" model="${escapeXml(n.model ?? '')}" com_port="${port}" bootmode="0" cx="${p.x.toFixed(6)}" cy="${p.y.toFixed(6)}">`
    )
    // 终端类设备（PC/Cloud/Server）真机样例无 slot 声明；网络设备给足 GE 数量
    const role = guessRole(n.name, n.model)
    if (role !== 'pc' && role !== 'server' && role !== 'cloud') {
      out.push('            <slot number="slot17" isMainBoard="1">')
      out.push('                <interface sztype="Ethernet" interfacename="GE" count="32" />')
      out.push('            </slot>')
    }
    out.push('        </dev>')
  }
  out.push('    </devices>')
  out.push('    <lines>')
  // 每节点独立递增接口序号：src 侧节点用 srcIndex、tar 侧节点用 tarIndex
  const nextIndex = new Map<string, number>()
  const takeIndex = (id: string): number => {
    const c = nextIndex.get(id) ?? 0
    nextIndex.set(id, c + 1)
    return c
  }
  for (const l of visibleLinks) {
    const srcId = stableGuid(`ensp-auto:${l.from}`)
    const dstId = stableGuid(`ensp-auto:${l.to}`)
    const srcIndex = takeIndex(l.from)
    const tarIndex = takeIndex(l.to)
    out.push(
      `        <line srcDeviceID="${srcId}" destDeviceID="${dstId}">` +
        `<interfacePair lineName="Copper" srcIndex="${srcIndex}" srcBoundRectIsMoved="1" tarIndex="${tarIndex}" tarBoundRectIsMoved="1" /></line>`
    )
  }
  out.push('    </lines>')
  out.push('    <shapes />')
  out.push('    <txttips />')
  out.push('</topo>')

  const portsByName: Record<string, number> = {}
  for (const n of nodes) {
    const p = ports.get(n.id)
    if (p !== undefined) portsByName[n.name] = p
  }

  return {
    xml: out.join('\n'),
    report: {
      devices: nodes.length,
      links: visibleLinks.length,
      encoding: opts?.encoding ?? 'utf16le',
      ports: portsByName,
      warnings
    }
  }
}

/** 编码 output：UTF-16LE 时追加 BOM + utf16le 字节；UTF-8 直写 */
function encodeXml(xml: string, encoding: 'utf16le' | 'utf8'): Buffer {
  if (encoding === 'utf8') return Buffer.from(xml, 'utf8')
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])
}

/** 写 .topo 到磁盘（tmp + rename 原子写），并返回解析回读自检通过的结果 */
export function writeTopoFile(
  filePath: string,
  topo: Topology,
  opts?: TopoWriteOptions
): { report: TopoWriteReport; xml: string } {
  const encoding = opts?.encoding ?? 'utf16le'
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const { xml, report } = topologyToXml(topo, { ...opts, encoding })
  // T2.5：统一原子写。.topo 是 utf16le，因此走字节版（不做 UTF-8 转码）
  atomicWriteFileSync(filePath, encodeXml(xml, encoding))
  return { report, xml }
}