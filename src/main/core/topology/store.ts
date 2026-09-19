import fs from 'node:fs'
import path from 'node:path'
import { emptyTopology, mergeLayers, type Topology, type TopologyLink, type TopologyNode } from './model'

/**
 * TopologyStore —— 主进程持有的拓扑状态（v0.3+ 三层降级）。
 *
 * 三个独立层，snapshot() 出口即合并结果：
 * - file       来源一：eNSP 工程文件解析（最权威）
 * - discovered 来源二：LLDP 实采推导
 * - manual     来源三：画布手动补画（坐标/名称覆盖）
 *
 * 职责：持有三层 → 变化持久化（JSON 文件）→ 变化通知（Services 转发 topology:updated）。
 * 不依赖 Electron 与网络，便于测试。
 */

export interface TopologyStoreOptions {
  file: string
  onChange?: (t: Topology) => void
}

interface Persisted {
  version: 2
  file?: Topology | null
  discovered?: Topology
  manual?: { nodes: TopologyNode[]; links: TopologyLink[] }
}

export class TopologyStore {
  private fileLayer: Topology | null = null
  private discoveredLayer: Topology = emptyTopology()
  private manualLayer: { nodes: TopologyNode[]; links: TopologyLink[] } = { nodes: [], links: [] }

  constructor(private readonly opts: TopologyStoreOptions) {
    this.load()
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.opts.file)) return
      const parsed = JSON.parse(fs.readFileSync(this.opts.file, 'utf8')) as Partial<Persisted>
      if (parsed.version === 2) {
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
    try {
      const dir = path.dirname(this.opts.file)
      fs.mkdirSync(dir, { recursive: true })
      const data: Persisted = {
        version: 2,
        file: this.fileLayer,
        discovered: this.discoveredLayer,
        manual: this.manualLayer
      }
      const tmp = `${this.opts.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      fs.renameSync(tmp, this.opts.file)
    } catch {
      /* 持久化失败不阻塞核心功能 */
    }
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

  /** 手动补画：整体替换 manual 层（并入结果、持久化并通知） */
  applyManual(manual: { nodes: TopologyNode[]; links: TopologyLink[] }): Topology {
    this.manualLayer = { nodes: [...manual.nodes], links: [...manual.links] }
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