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

/** 由设备型号/名字推测角色。heuristic：AR/NE/CE 路由器，S 系列交换机，USG 防火墙，AC/AP/WLAN 无线局域网，Server 服务器，Cloud/Hub 其他设备，PC/Client 终端 */
export function guessRole(name: string, model?: string): TopologyRole {
  const hay = `${model ?? ''} ${name}`.toUpperCase()
  if (/\bUSG\d+|\b(USG|FW|FIREWALL)\b/.test(hay)) return 'firewall'
  if (/\b(AC|AP)\d+|\b(AC|AP|WLAN|WIFI|FAT-AP|FIT-AP|STA)\b/.test(hay)) return 'wlan'
  if (/\b(AR|NE|CE|AX)\d+|\bROUTER\b/.test(hay)) return 'router'
  if (/\bS\d|S[57]00|\b(SW|LSW|SWITCH)\b|\bLSW\d+/.test(hay)) return 'switch'
  if (/\b(SERVER|SRV)\b/.test(hay)) return 'server'
  if (/\b(CLOUD|HUB|WAN|INTERNET)\b/.test(hay)) return 'cloud'
  if (/\b(PC|CLIENT|HOST|TERMINAL)\b/.test(hay)) return 'pc'
  return 'unknown'
}

export function linkKey(a: string, b: string): string {
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
  /**
   * deviceId / id → 已存在节点 id 的反查表（T4.7）。
   *
   * 原来判定「这个 deviceId 是不是已经认过亲」要线性扫一遍 nodeById，
   * 三层合并 200 节点就是 4 万次比较；维护一张反查表把它摊平成 O(1)。
   * 两个键都指向同一个 id，判定顺序与原实现一致（先 deviceId，后 id）。
   */
  const idByKey = new Map<string, string>()

  const findByDevice = (deviceId: string): string | undefined => idByKey.get(deviceId)

  const indexNode = (id: string, n: TopologyNode): void => {
    idByKey.set(id, id)
    if (n.deviceId) idByKey.set(n.deviceId, id)
  }

  // 手动层里存在「非删除」条目的 id：同 id 墓碑不得压过它（旧持久化数据可能两者并存，
  // 修复前墓碑追加在列表末尾、后写覆盖前写；这里让活条目优先，数据自愈）
  const liveManualIds = new Set(manual.nodes.filter((n) => !n.deleted).map((n) => n.id))

  const applyLayer = (
    nodes: TopologyNode[],
    source: TopologySource,
    override: boolean
  ): void => {
    for (const n of nodes) {
      const existingId = nodeById.has(n.id) ? n.id : n.deviceId ? findByDevice(n.deviceId) : undefined
      if (!existingId) {
        const created = { ...n, source }
        nodeById.set(n.id, created)
        indexNode(n.id, created)
        continue
      }
      const prev = nodeById.get(existingId)!
      const merged: TopologyNode = override
        ? n.deleted && liveManualIds.has(existingId)
          ? prev // 墓碑遇到同 id 复活条目 → 保留活条目
          : { ...prev, ...n, deleted: n.deleted, source: 'manual', deviceId: n.deviceId ?? prev.deviceId, model: n.model ?? prev.model, interfaces: n.interfaces ?? prev.interfaces }
        : { ...n, ...prev, source: prev.source, deviceId: prev.deviceId ?? n.deviceId, model: prev.model ?? n.model, interfaces: prev.interfaces ?? n.interfaces }
      nodeById.set(existingId, merged)
      // 合并后 deviceId 可能与登记时不同（file 层权威、manual 层可覆盖），
      // 把新键也登记上，保证反查表始终能认到这台设备
      indexNode(existingId, merged)
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
    const prevDeleted = !!prevLink.deleted
    const nextDeleted = !!l.deleted
    const prevManual = prevLink.source === 'manual'
    const nextManual = l.source === 'manual'
    // 1) 手动层内部墓碑/活条目并存：活条目优先（重连复活语义，并兼容旧持久化数据的两种顺序）
    if (prevManual && nextManual && prevDeleted !== nextDeleted) {
      if (!nextDeleted) byKey.set(key, { ...l, id: l.id || prevLink.id, deleted: false })
      return
    }
    // 2) 删除墓碑压制其它层（file/discovered）的同端点活条目：跨层删除跨刷新持久生效；
    //    重新导入文件也只代表「物理链路存在」，不自动复活用户显式删除的链路
    if (prevManual && prevDeleted) return
    if (nextManual && nextDeleted) {
      byKey.set(key, { ...l, id: l.id || prevLink.id })
      return
    }
    if (nextManual) {
      // 手动链路的 label/端口永远覆盖
      byKey.set(key, { ...prevLink, ...l, deleted: l.deleted, source: 'manual', id: prevLink.id || l.id })
      return
    }
    if (prevLink.source === 'file') return // file 权威：同端点不再被 discovered 覆盖
    byKey.set(key, { ...prevLink, ...l, id: prevLink.id || l.id })
  }

  for (const l of [...(file?.links ?? []), ...discovered.links, ...manual.links]) {
    putLink(l)
  }

  // 删除墓碑（v0.6 F-5.6）：manual 层的 deleted 标记过滤对应节点/链路，跨刷新与跨层生效。
  // 注意：链路不做「端点节点存在性」过滤——旧行为允许 deviceId 对齐/占位邻居等
  // 端点不在当前节点集内的链路保留，渲染层会用 roleOf 自行过滤。
  const liveNodes = [...nodeById.values()].filter((n) => !n.deleted)
  const liveLinks = [...byKey.values()].filter((l) => !l.deleted)

  return { nodes: liveNodes, links: liveLinks, updatedAt: Date.now() }
}