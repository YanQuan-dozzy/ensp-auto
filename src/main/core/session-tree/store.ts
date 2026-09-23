import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionNode, SessionNodeMeta } from '@shared/types'
import { atomicWriteJsonSync } from '../fs/atomic'

/**
 * 会话树存储（v0.4 / F-6.2）。
 *
 * pi 方法论落地：会话历史是**树**，不是线性列表 —— 每条消息一个节点（parentId 指向前一条，
 * null 为根），任意节点可回溯换路重走。
 *
 * 落盘：
 * - 每个会话一个 JSONL：`<dir>/tree-<rootId>.jsonl`，一行一个节点 JSON，root 为第一行（追加写，不重写）
 * - root 摘要（title/updatedAt/nodeCount）不落 JSONL（避免重写首行损坏），
 *   走内存索引 + `<dir>/sessions-index.json` 原子写
 *
 * 不依赖 Electron 与网络，路径注入便于测试。
 */

export interface SessionTreeStoreOptions {
  dir: string
  /** 会话列表变化（新建/追加）时回调，主进程接上转发给渲染层 */
  onChange?: (list: SessionNodeMeta[]) => void
}

interface IndexFile {
  version: 1
  sessions: Record<string, SessionNodeMeta>
}

export class SessionTreeStore {
  private index: Map<string, SessionNodeMeta> = new Map()
  /** rootId → 已加载的节点数组（惰性） */
  private cache = new Map<string, SessionNode[]>()
  /** nodeId → rootId（追加时定位所属会话） */
  private owner = new Map<string, string>()

  constructor(private readonly opts: SessionTreeStoreOptions) {
    fs.mkdirSync(opts.dir, { recursive: true })
    this.loadIndex()
  }

  private indexFile(): string {
    return path.join(this.opts.dir, 'sessions-index.json')
  }

  private treeFile(rootId: string): string {
    return path.join(this.opts.dir, `tree-${rootId}.jsonl`)
  }

  private loadIndex(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile(), 'utf8')) as IndexFile
      const sessions = raw?.sessions ?? {}
      for (const m of Object.values(sessions)) {
        if (m && typeof m.id === 'string') this.index.set(m.id, m)
      }
    } catch {
      this.index.clear()
    }
  }

  private persistIndex(): void {
    const data: IndexFile = { version: 1, sessions: Object.fromEntries(this.index) }
    // T2.5：统一原子写（此前是 `${indexFile}.tmp` 固定名，并发写会互相顶掉半成品）
    atomicWriteJsonSync(this.indexFile(), data)
  }

  private notify(): void {
    this.opts.onChange?.(this.list())
  }

  private parseTree(rootId: string): void {
    const nodes: SessionNode[] = []
    try {
      if (fs.existsSync(this.treeFile(rootId))) {
        const lines = fs.readFileSync(this.treeFile(rootId), 'utf8').split('\n')
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const node = JSON.parse(line) as SessionNode
            // 坏尾行（如断电写了一半）容忍：跳过，不破坏整棵树
            if (node && typeof node.id === 'string') {
              nodes.push(node)
              this.owner.set(node.id, rootId)
            }
          } catch {
            /* 容忍坏行 */
          }
        }
      }
    } catch {
      /* 读失败视为空，下次写入重建 */
    }
    this.cache.set(rootId, nodes)
  }

  private tree(rootId: string): SessionNode[] {
    if (!this.cache.has(rootId)) this.parseTree(rootId)
    return this.cache.get(rootId) ?? []
  }

  private appendLine(rootId: string, node: SessionNode): void {
    const file = this.treeFile(rootId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(node)}\n`, 'utf8')
  }

  // ———————————————————— 写 ————————————————————

  /** 新建会话：root 节点（role=user，内容=标题） */
  createRoot(title: string): SessionNode {
    const root: SessionNode = {
      id: `s-${randomUUID().slice(0, 8)}`,
      parentId: null,
      role: 'user',
      content: title,
      title,
      createdAt: Date.now()
    }
    const meta: SessionNodeMeta = {
      id: root.id,
      title,
      createdAt: root.createdAt,
      updatedAt: root.createdAt,
      nodeCount: 1
    }
    this.index.set(root.id, meta)
    this.cache.set(root.id, [root])
    this.owner.set(root.id, root.id)
    this.persistIndex()
    this.appendLine(root.id, root)
    this.notify()
    return root
  }

  /** 在指定父节点下追加一条消息节点 */
  append(parentId: string, node: Omit<SessionNode, 'parentId' | 'createdAt'> & { createdAt?: number }): SessionNode {
    const rootId = this.owner.get(parentId)
    if (!rootId) throw new Error(`未知父节点：${parentId}`)
    const full: SessionNode = {
      id: node.id,
      parentId,
      role: node.role,
      content: node.content,
      ...(node.toolCall ? { toolCall: node.toolCall } : {}),
      createdAt: node.createdAt ?? Date.now()
    }
    this.tree(rootId).push(full)
    this.owner.set(full.id, rootId)

    const meta = this.index.get(rootId)
    if (meta) {
      meta.updatedAt = full.createdAt
      meta.nodeCount += 1
      this.persistIndex()
    }
    this.appendLine(rootId, full)
    this.notify()
    return full
  }

  // ———————————————————— 读 ————————————————————

  /** 会话摘要列表，按 updatedAt 降序 */
  list(): SessionNodeMeta[] {
    return [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getById(nodeId: string): SessionNode | undefined {
    const rootId = this.owner.get(nodeId)
    if (!rootId) return undefined
    return this.tree(rootId).find((n) => n.id === nodeId)
  }

  getTree(rootId: string): SessionNode[] {
    return [...this.tree(rootId)]
  }

  /** 从 nodeId 到 root 的祖先链（含 nodeId 自身，根在前） */
  pathTo(rootId: string, nodeId: string): SessionNode[] {
    const tree = this.tree(rootId)
    const byId = new Map(tree.map((n) => [n.id, n]))
    const path: SessionNode[] = []
    let cur: SessionNode | undefined = byId.get(nodeId)
    while (cur) {
      path.unshift(cur)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return path
  }

  childrenOf(rootId: string, nodeId: string): SessionNode[] {
    return this.tree(rootId).filter((n) => n.parentId === nodeId)
  }

  // ———————————————————— 维护（v1.6） ————————————————————

  /**
   * 清空全部会话（设置 → 通用 → 数据与存储）。
   *
   * 内存里的三张表必须和磁盘一起清：只删文件的话，进程内还留着旧索引，
   * 之后任何一次 append/notify 都会把已经不存在的会话重新列出来 ——
   * 用户看到的就是「点了清空，列表还在」。
   * 返回删掉的会话文件数（一个会话一个 jsonl）。
   */
  resetAll(): number {
    let removed = 0
    try {
      for (const f of fs.readdirSync(this.opts.dir)) {
        if (!/^tree-.*\.jsonl$/.test(f)) continue
        try {
          fs.rmSync(path.join(this.opts.dir, f), { force: true })
          removed += 1
        } catch {
          /* 被占用就跳过，不中断清理 */
        }
      }
      fs.rmSync(this.indexFile(), { force: true })
    } catch {
      /* 目录不存在等：按「已经是空的」处理 */
    }
    this.index.clear()
    this.cache.clear()
    this.owner.clear()
    this.notify()
    return removed
  }
}