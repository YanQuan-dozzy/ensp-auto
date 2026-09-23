import fs from 'node:fs'
import { emptyTopology, linkKey, mergeLayers, type Topology, type TopologyLink, type TopologyNode } from './model'
import { atomicWriteJsonSync } from '../fs/atomic'

/**
 * TopologyStore —— 主进程持有的拓扑状态（v0.3+ 三层降级）。
 *
 * 三个独立层，snapshot() 出口即合并结果：
 * - file       来源一：eNSP 工程文件解析（最权威）
 * - discovered 来源二：LLDP 实采推导
 * - manual     来源三：画布手动补画（坐标/名称覆盖）
 *
 * v0.6（F-5.6）：删除墓碑（deleted 标记）放在 manual 层内持久化。
 * applyManual 是「整体替换 manual 层」，若原样替换会把墓碑冲掉导致删除的
 * 节点/链路在刷新或重启后复活，因此替换时把 manual 层里既有的墓碑重新并入。
 *
 * 职责：持有三层 → 变化持久化（JSON 文件）→ 变化通知（Services 转发 topology:updated）。
 * 不依赖 Electron 与网络，便于测试。
 */

export interface TopologyStoreOptions {
  file: string
  onChange?: (t: Topology) => void
}

interface Persisted {
  version: 2 | 3
  file?: Topology | null
  discovered?: Topology
  manual?: { nodes: TopologyNode[]; links: TopologyLink[] }
}

export class TopologyStore {
  private fileLayer: Topology | null = null
  private discoveredLayer: Topology = emptyTopology()
  private manualLayer: { nodes: TopologyNode[]; links: TopologyLink[] } = { nodes: [], links: [] }
  /** 最近一次 file 层来源 .topo 路径（仅运行时，不落盘；find_topology_files 用它标 is_active） */
  private fileSourcePathValue: string | null = null
  /** 最后一次**成功落盘**的三层状态；写失败时用它回滚内存（R21） */
  private committed: {
    file: Topology | null
    discovered: Topology
    manual: { nodes: TopologyNode[]; links: TopologyLink[] }
  } | null = null

  constructor(private readonly opts: TopologyStoreOptions) {
    this.load()
    // 装载完成即视为「已落盘基线」，后续任何一次写失败都回滚到这里
    this.committed = {
      file: this.fileLayer,
      discovered: this.discoveredLayer,
      manual: this.manualLayer
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.opts.file)) return
      const parsed = JSON.parse(fs.readFileSync(this.opts.file, 'utf8')) as Partial<Persisted>
      if (parsed.version === 3 || parsed.version === 2) {
        this.fileLayer = parsed.file ? sanitizeTopology(parsed.file) : null
        this.discoveredLayer = parsed.discovered ? sanitizeTopology(parsed.discovered) : emptyTopology()
        this.manualLayer = parsed.manual
          ? { nodes: sanitizeNodes(parsed.manual.nodes), links: sanitizeLinks(parsed.manual.links) }
          : { nodes: [], links: [] }
      } else {
        // 兼容 v0.3 旧格式 {nodes, links, updatedAt}（当时是合并结果，视为 discovered 层）
        const legacy = sanitizeTopology(parsed as Topology)
        this.discoveredLayer = legacy
      }
    } catch {
      this.fileLayer = null
      this.discoveredLayer = emptyTopology()
      this.manualLayer = { nodes: [], links: [] }
    }
  }

  private persist(): void {
    // T2.5：统一原子写。T2.6：失败不再被吞 —— 拓扑写操作（拖动落位/编辑/导入）
    // 若没写进磁盘却对界面报成功，用户会以为图纸已保存，下次打开发现全没了。
    // T2.7：写失败要把内存三层回滚到「上次成功落盘」的状态，
    // 否则界面显示的图纸与磁盘上的永远不一致（下一次读到的是旧图，看起来像"随机丢失"）。
    const baseline = this.committed
    const data: Persisted = {
      version: 3,
      file: this.fileLayer,
      discovered: this.discoveredLayer,
      manual: this.manualLayer
    }
    try {
      atomicWriteJsonSync(this.opts.file, data)
    } catch (e) {
      if (baseline) {
        this.fileLayer = baseline.file
        this.discoveredLayer = baseline.discovered
        this.manualLayer = baseline.manual
      }
      throw e
    }
    this.committed = { file: this.fileLayer, discovered: this.discoveredLayer, manual: this.manualLayer }
  }

  private publish(): void {
    this.opts.onChange?.(this.snapshot())
  }

  /** 当前三层合并结果（深拷贝，调用方自由修改不影响内部状态） */
  snapshot(): Topology {
    return structuredClone(mergeLayers(this.fileLayer, this.discoveredLayer, this.manualLayer)) as Topology
  }

  /** 整体替换 discovered 层（实采推导）；file/manual 层保留 */
  set(t: Topology): void {
    this.discoveredLayer = { ...t, updatedAt: Date.now() }
    this.persist()
    this.publish()
  }

  /** 设置 file 层（工程文件解析结果，最权威） */
  setFile(t: Topology): void {
    this.fileLayer = { ...t, updatedAt: Date.now() }
    this.persist()
    this.publish()
  }

  /** 记录 file 层来源 .topo 路径（运行时；find_topology_files 用 is_active 区分当前活动拓扑） */
  setFileSource(path: string | null): void {
    this.fileSourcePathValue = path
  }

  get fileSourcePath(): string | null {
    return this.fileSourcePathValue
  }

  /**
   * 手动补画：按 id/端点对与 manual 层**合并**（v0.6.1 修复「断开后无法重连」）。
   *
   * - 传入条目以 id（链路按端点对）为准替换同 id 的既有手动条目；未传入的既有
   *   条目**保留**——不再整体替换，避免连续快速保存（多次拖线/拖动）互相覆盖丢失
   * - 传入的**非删除**条目自动「复活」同 id/端点对的删除墓碑：用户重连/重排即恢复
   * - 删除仍只由 remove() 打墓碑；applyManual 不接受 deleted 条目（直接忽略）
   */
  applyManual(manual: { nodes: TopologyNode[]; links: TopologyLink[] }): Topology {
    const liveNodeIds = new Set(manual.nodes.filter((n) => !n.deleted).map((n) => n.id))
    const liveLinkKeys = new Set(manual.links.filter((l) => !l.deleted).map((l) => linkKey(l.from, l.to)))

    const nodes = new Map<string, TopologyNode>()
    for (const n of this.manualLayer.nodes) {
      // 同 id 已有复活条目（本次传入）→ 顶掉旧墓碑
      if (n.deleted && liveNodeIds.has(n.id)) continue
      if (!nodes.has(n.id)) nodes.set(n.id, n)
    }
    for (const n of manual.nodes) {
      if (n.deleted) continue
      nodes.set(n.id, n)
    }

    const links = new Map<string, TopologyLink>()
    for (const l of this.manualLayer.links) {
      const k = linkKey(l.from, l.to)
      if (l.deleted && liveLinkKeys.has(k)) continue
      if (!links.has(k)) links.set(k, l)
    }
    for (const l of manual.links) {
      if (l.deleted) continue
      links.set(linkKey(l.from, l.to), l)
    }

    this.manualLayer = { nodes: [...nodes.values()], links: [...links.values()] }
    this.persist()
    this.publish()
    return this.snapshot()
  }

  /**
   * 删除（v0.6 F-5.6）：节点 → 打墓碑并连带墓碑其全部链路；
   * 单条链路 → 只打链路墓碑。所有墓碑并入 manual 层，跨层（file/discovered）生效。
   */
  remove(target: { nodeIds?: string[]; linkKeys?: string[] }): Topology {
    const nodeIds = new Set(target.nodeIds ?? [])
    const linkKeys = new Set(target.linkKeys ?? [])
    if (nodeIds.size === 0 && linkKeys.size === 0) return this.snapshot()

    // 删除节点时连带其全部链路（链路墓碑与显式 linkKeys 同效）
    const merged = this.snapshot()
    for (const l of merged.links) {
      if (nodeIds.has(l.from) || nodeIds.has(l.to)) linkKeys.add(linkKey(l.from, l.to))
    }

    const tombNodes: TopologyNode[] = []
    const tombLinks: TopologyLink[] = []
    const tombstonedNodes = new Set<string>()
    const tombstonedLinks = new Set<string>()

    const tombstoneNode = (n: TopologyNode): void => {
      if (tombstonedNodes.has(n.id)) return
      tombstonedNodes.add(n.id)
      tombNodes.push({ id: n.id, name: n.name, role: n.role, deleted: true, source: 'manual' })
    }
    const tombstoneLink = (l: TopologyLink): void => {
      const key = linkKey(l.from, l.to)
      if (tombstonedLinks.has(key)) return
      tombstonedLinks.add(key)
      tombLinks.push({ ...l, deleted: true, source: 'manual' })
    }

    // 已在 manual 层的条目直接从层里移除（墓碑统一新增），避免同 id 双写
    const keepNodes: TopologyNode[] = []
    for (const n of this.manualLayer.nodes) {
      if (nodeIds.has(n.id) && !n.deleted) tombstoneNode(n)
      else keepNodes.push(n)
    }
    const keepLinks: TopologyLink[] = []
    const seenKeys = new Set<string>()
    for (const l of this.manualLayer.links) {
      const key = linkKey(l.from, l.to)
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      if (linkKeys.has(key) && !l.deleted) tombstoneLink(l)
      else keepLinks.push(l)
    }
    // 合并结果里非 manual 来源的节点/链路（file/discovered）也需要墓碑
    for (const n of merged.nodes) {
      if (nodeIds.has(n.id) && !n.deleted) tombstoneNode(n)
    }
    for (const l of merged.links) {
      if (linkKeys.has(linkKey(l.from, l.to)) && !l.deleted) tombstoneLink(l)
    }

    this.manualLayer = { nodes: [...keepNodes, ...tombNodes], links: [...keepLinks, ...tombLinks] }
    this.persist()
    this.publish()
    return this.snapshot()
  }

  clear(): void {
    this.fileLayer = null
    this.discoveredLayer = emptyTopology()
    this.manualLayer = { nodes: [], links: [] }
    this.persist()
    this.publish()
  }
}

function sanitizeTopology(t: Partial<Topology>): Topology {
  return {
    nodes: sanitizeNodes(t.nodes),
    links: sanitizeLinks(t.links),
    updatedAt: t.updatedAt ?? Date.now()
  }
}

function sanitizeNodes(list: unknown): TopologyNode[] {
  if (!Array.isArray(list)) return []
  return list.filter((n): n is TopologyNode => !!n && typeof n === 'object' && typeof (n as TopologyNode).id === 'string')
}

function sanitizeLinks(list: unknown): TopologyLink[] {
  if (!Array.isArray(list)) return []
  return list.filter(
    (l): l is TopologyLink =>
      !!l && typeof l === 'object' && typeof (l as TopologyLink).from === 'string' && typeof (l as TopologyLink).to === 'string'
  )
}