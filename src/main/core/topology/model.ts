import type {
  Topology,
  TopologyLink,
  TopologyNode,
  TopologyRole,
  TopologySource
} from '@shared/types'

/**
 * 拓扑领域模型（v0.3 / F-5.x）。
 *
 * 拓扑是**结构化数据**（设备节点 + 链路 + 端口 + 角色），画布只是它的一个视图。
 * 类型定义统一放在 @shared/types（渲染层与控制层共用），这里只留纯函数。
 */

export type { Topology, TopologyLink, TopologyNode, TopologyRole, TopologySource }

export function emptyTopology(): Topology {
  return { nodes: [], links: [], updatedAt: 0 }
}

/** 由设备型号/名字推测角色。heuristic：AR/NE/CE 路由器，S 系列交换机，PC/Cloud 终端 */
export function guessRole(name: string, model?: string): TopologyRole {
  const hay = `${model ?? ''} ${name}`.toUpperCase()
  if (/\b(AR|NE|CE|AX|USG)\d+/.test(hay)) return 'router'
  if (/\bS\d|S[57]00/.test(hay)) return 'switch'
  if (/\b(PC|CLOUD|SERVER)\b/.test(hay)) return 'pc'
  return 'unknown'
}

function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * 把「实采/文件」拓扑与「手动补画」合并（手工优先）。
 * 兼容旧两参调用；语义 = mergeLayers(null, discovered, manual)。
 */
export function mergeTopology(
  discovered: Topology,
  manual: { nodes: TopologyNode[]; links: TopologyLink[] }
): Topology {
  return mergeLayers(null, discovered, manual)
}

/**
 * 三层降级合并（v0.3 落地为两层，v0.3+ 补上 file 层作为第一来源）：
 * - 节点按 id 归并，并支持按 deviceId 对齐（文件节点 id=name、deviceId=127.0.0.1:<com_port>，
 *   与实采节点的 id 同形，两边按 deviceId 认亲）；
 *   file 最权威（已有节点则保留其 id/坐标/角色/deviceId），discovered 补缺，manual 覆盖坐标/名称
 * - 链路按 (from,to) 去重：file 优先，discovered 仅补 file 缺失的端点对，manual 的 label 始终覆盖
 */
export function mergeLayers(
  file: Topology | null,
  discovered: Topology,
  manual: { nodes: TopologyNode[]; links: TopologyLink[] }
): Topology {
  const nodeById = new Map<string, TopologyNode>()

  const findByDevice = (deviceId: string): string | undefined => {
    for (const [id, n] of nodeById) {
      if (n.deviceId === deviceId || id === deviceId) return id
    }
    return undefined
  }

  const applyLayer = (
    nodes: TopologyNode[],
    source: TopologySource,
    override: boolean
  ): void => {
    for (const n of nodes) {
      const existingId = nodeById.has(n.id) ? n.id : n.deviceId ? findByDevice(n.deviceId) : undefined
      if (!existingId) {
        nodeById.set(n.id, { ...n, source })
        continue
      }
      const prev = nodeById.get(existingId)!
      nodeById.set(
        existingId,
        override
          ? { ...prev, ...n, source: 'manual', deviceId: n.deviceId ?? prev.deviceId, model: n.model ?? prev.model }
          : { ...n, ...prev, source: prev.source, deviceId: prev.deviceId ?? n.deviceId, model: prev.model ?? n.model }
      )
    }
  }

  if (file) applyLayer(file.nodes, 'file', false)
  applyLayer(discovered.nodes, 'discovered', false)
  applyLayer(manual.nodes, 'manual', true)

  const byKey = new Map<string, TopologyLink>()
  const putLink = (l: TopologyLink): void => {
    const key = linkKey(l.from, l.to)
    const prevLink = byKey.get(key)
    if (!prevLink) {
      byKey.set(key, { ...l, id: l.id || `l-${key}` })
      return
    }
    if (l.source === 'manual') {
      // 手动链路的 label/端口永远覆盖
      byKey.set(key, { ...prevLink, ...l, source: 'manual', id: prevLink.id || l.id })
      return
    }
    if (prevLink.source === 'file') return // file 权威：同端点不再被 discovered 覆盖
    byKey.set(key, { ...prevLink, ...l, id: prevLink.id || l.id })
  }

  for (const l of [...(file?.links ?? []), ...discovered.links, ...manual.links]) {
    putLink(l)
  }

  return { nodes: [...nodeById.values()], links: [...byKey.values()], updatedAt: Date.now() }
}