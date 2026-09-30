import type {
  Topology,
  TopologyLink,
  TopologyNode,
  TopologyRole,
  TopologySource
} from '@shared/types'
import { linkIdentity, linkPairKey } from '@shared/topology-link'

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

/** 无向**设备对** key（≠ 一条线：两台设备之间可以并接多条，见 @shared/topology-link） */
export function linkKey(a: string, b: string): string {
  return linkPairKey(a, b)
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

  /**
   * —— 链路合并：身份分两级（这是「两台设备多条并接」修复的核心）——
   *
   * - **按条**：链路带 `lineKey`（工程文件、LLDP 实采、画布上手拖的线都有）→ 按
   *   「设备对 + 线标识」各自成条。同一个设备对有几条线就出几条，互不覆盖 ——
   *   修复前按设备对去重，并联的第二条线会被吞掉（画布上只有一根线）。
   * - **按设备对**：链路没有 `lineKey`（旧版本持久化的条目）→ 保持历史语义：同设备对
   *   去重、手动条目覆盖 file/discovered、墓碑压掉整对。旧数据因此无需迁移，
   *   也不会因为「身份变了」而多出幽灵线或让已删除的链路复活。
   */
  const lines = new Map<string, TopologyLink>()
  /** 设备对 → 该设备对下已登记的条目 key（保序，供「按设备对」的旧语义条目落位） */
  const linesOfPair = new Map<string, string[]>()
  const indexLine = (key: string, pair: string): void => {
    const list = linesOfPair.get(pair)
    if (list) {
      if (!list.includes(key)) list.push(key)
      return
    }
    linesOfPair.set(pair, [key])
  }
  const putLine = (l: TopologyLink, pair: string): void => {
    const key = linkIdentity(l)
    const prev = lines.get(key)
    if (!prev) {
      lines.set(key, { ...l, id: l.id || `l-${key}` })
      indexLine(key, pair)
      return
    }
    const prevDeleted = !!prev.deleted
    const nextDeleted = !!l.deleted
    const prevManual = prev.source === 'manual'
    const nextManual = l.source === 'manual'
    // 1) 手动层内部墓碑/活条目并存：活条目优先（重连复活语义，并兼容旧持久化数据的两种顺序）
    if (prevManual && nextManual && prevDeleted !== nextDeleted) {
      if (!nextDeleted) lines.set(key, { ...l, id: l.id || prev.id, deleted: false })
      return
    }
    // 2) 手动条目覆盖：label/lineType 只有显式给了才覆盖（旧行为：不带 label 的覆盖条目
    //    不得把 file 的接口标注冲掉），其余字段（portOffsets）以手动层为准
    if (nextManual) {
      lines.set(key, {
        ...prev,
        ...l,
        deleted: l.deleted,
        source: 'manual',
        id: prev.id || l.id,
        lineKey: prev.lineKey ?? l.lineKey,
        label: l.label ?? prev.label,
        lineType: l.lineType ?? prev.lineType
      })
      return
    }
    // 3) 手动层已就位（含墓碑）→ file/discovered 不得覆盖；file 权威，discovered 仅补缺
    if (prevManual || prev.source === 'file') return
    lines.set(key, { ...prev, ...l, id: prev.id || l.id })
  }

  /** 「按设备对」的旧语义条目（无 lineKey）：同设备对只留一条，file 权威 */
  const putPairLine = (l: TopologyLink, pair: string): void => {
    const key = `${pair}|`
    const prev = lines.get(key)
    if (!prev) {
      lines.set(key, { ...l, id: l.id || `l-${key}` })
      indexLine(key, pair)
      return
    }
    if (prev.source === 'file' || prev.deleted || prev.source === 'manual') return
    lines.set(key, { ...prev, ...l, id: prev.id || l.id })
  }

  // 第一层/第二层：file 最权威，discovered 补缺 —— 均按「条」登记
  for (const l of [...(file?.links ?? []), ...discovered.links]) {
    const pair = linkPairKey(l.from, l.to)
    if (l.lineKey) putLine(l, pair)
    else putPairLine(l, pair) // 旧持久化数据里的条目（无 lineKey）
  }

  // 第三层：手动层
  // 3a) 带 lineKey 的条目 → 按条合并（标注偏移就落在这一支：身份与目标线一致才算同一条线）
  for (const l of manual.links) {
    if (!l.lineKey) continue
    putLine(l, linkPairKey(l.from, l.to))
  }
  // 3b) 不带 lineKey 的历史条目 → 按设备对：活条目覆盖该设备对的**首条**线（旧行为里
  //     一个设备对只有一条线，故等价），墓碑压掉该设备对的**全部**线（整对断开语义）
  const pairTombstones = new Set<string>()
  const pairLive = new Map<string, TopologyLink>()
  for (const l of manual.links) {
    if (l.lineKey) continue
    const pair = linkPairKey(l.from, l.to)
    if (l.deleted) pairTombstones.add(pair)
    else pairLive.set(pair, l)
  }
  for (const [pair, entry] of pairLive) {
    pairTombstones.delete(pair) // 活条目复活同设备对的墓碑（重连语义）
    const first = linesOfPair.get(pair)?.[0]
    if (!first) {
      const key = `${pair}|`
      lines.set(key, { ...entry, id: entry.id || `l-${key}` })
      indexLine(key, pair)
      continue
    }
    const prev = lines.get(first)!
    lines.set(first, {
      ...prev,
      ...entry,
      deleted: false,
      source: 'manual',
      id: prev.id || entry.id,
      lineKey: prev.lineKey ?? entry.lineKey,
      label: entry.label ?? prev.label,
      lineType: entry.lineType ?? prev.lineType
    })
  }
  for (const pair of pairTombstones) {
    for (const key of linesOfPair.get(pair) ?? []) {
      const prev = lines.get(key)
      if (prev && !prev.deleted) lines.set(key, { ...prev, deleted: true, source: 'manual' })
    }
  }

  // 删除墓碑（v0.6 F-5.6）：manual 层的 deleted 标记过滤对应节点/链路，跨刷新与跨层生效。
  // 注意：链路不做「端点节点存在性」过滤——旧行为允许 deviceId 对齐/占位邻居等
  // 端点不在当前节点集内的链路保留，渲染层会用 roleOf 自行过滤。
  const liveNodes = [...nodeById.values()].filter((n) => !n.deleted)
  const liveLinks = [...lines.values()].filter((l) => !l.deleted)

  return { nodes: liveNodes, links: liveLinks, updatedAt: Date.now() }
}