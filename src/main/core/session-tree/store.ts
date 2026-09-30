import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionNode, SessionNodeMeta, TurnFinishRecord } from '@shared/types'
import { atomicWriteFileSync, atomicWriteJsonSync } from '../fs/atomic'
import { quarantineFile } from '../fs/quarantine'
import { describeShapeWarning, isFiniteNumber, isNonEmptyString, sanitizeIndexItems } from '../store/index-shape'

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

/** N19：会话列表广播的合流窗口（同一窗口内的多次变更只推一份） */
const NOTIFY_COALESCE_MS = 60

/**
 * D1（PERF-MEM-REVIEW-2026-09-29 §三）：索引落盘的去抖窗口。
 *
 * 为什么必须去抖：`append()` 每落一个节点就整份重写索引（原子写 + fsync +
 * mkdir + rename，全同步）。一次 30 轮的典型实验约 130 个节点 ⇒ 130 次全量
 * 索引写 + 130 次 `fsyncSync`（Windows 上是 FlushFileBuffers，单次 0.1~数 ms，
 * 撞上杀软扫描可达数十 ms），**全部同步阻塞主进程** —— 而主进程同时还在
 * 扛渲染层 IPC、telnet/SSH 通信与工具执行。索引只有 25KB 量级，一秒落一次
 * 完全够，而 D4 的退避最坏还能冻 70ms。
 *
 * 索引是**派生数据**（`tree-*.jsonl` 才是真相，见类注释），推迟落盘不丢信息：
 * 进程被 kill 时最多丢失「最近一次去抖窗口内」的 nodeCount/updatedAt/resumable，
 * 而节点本身已经 append 进了 jsonl。
 */
const INDEX_PERSIST_DEBOUNCE_MS = 600

/**
 * M1/D8（PERF-MEM-REVIEW-2026-09-29 §三）：`cache` 里最多留几棵树。
 *
 * 一次被打开过的会话，它的**整棵**节点数组（含每条 assistant 正文、thinking
 * 全文、`toolCall.args/summary/cardMeta`）就永久驻留 —— 唯一的清理点是
 * deleteSession / deleteFromNode / resetAll，也就是说**用户「关掉会话窗口」
 * 一点内存都不释放**。一周点开 50 个历史会话就是 50 份完整节点数组钉在主进程。
 *
 * 上界取 8：足够覆盖「列表 + 正在看的那棵 + 刚对比过的几棵」，又能让
 * 跨会话的常驻量封顶。淘汰只是**内存**行为 —— 被淘汰的树随时能从
 * `tree-*.jsonl` 重新解析出来，不丢任何数据。
 */
const CACHE_MAX_TREES = 8

/**
 * 索引条目的形状判定（N44）：只要求 id 存在，其余字段在归一化阶段补齐。
 *
 * 为什么不像 snapshots/changes 那样要求全部字段：id 缺失的条目无法被寻址（等于垃圾），
 * 但 title/updatedAt 等字段缺失的老索引**仍对应一个可打开的会话**，丢掉整条就是丢会话。
 * 所以这里宽进，缺的数值字段在 loadIndex 里补（避免 list() 排序出 NaN）。
 */
function isSessionNodeMeta(v: unknown): v is SessionNodeMeta {
  if (!v || typeof v !== 'object') return false
  return isNonEmptyString((v as Partial<SessionNodeMeta>).id)
}

export class SessionTreeStore {
  private index: Map<string, SessionNodeMeta> = new Map()
  /** rootId → 已加载的节点数组（惰性，按 LRU 上界，见 CACHE_MAX_TREES） */
  private cache = new Map<string, SessionNode[]>()
  /** nodeId → rootId（追加时定位所属会话） */
  private owner = new Map<string, string>()
  /** N19：列表广播的待发定时器（合流用，见 notify） */
  private notifyTimer: ReturnType<typeof setTimeout> | null = null
  /** D1：索引待落盘的合流定时器（见 scheduleIndexPersist） */
  private indexTimer: ReturnType<typeof setTimeout> | null = null
  /** D1：定时器已到期但落盘还没成功（退避重试用） */
  private indexDirty = false

  constructor(private readonly opts: SessionTreeStoreOptions) {
    fs.mkdirSync(opts.dir, { recursive: true })
    this.loadIndex()
    // D1：去抖落盘必须在进程退出前冲掉，否则「最后一批节点」只有 jsonl 没有索引条目
    //（表现为会话列表里的 nodeCount 停在旧值，排序位置也不对）。
    // 只挂一次、且 unref 掉以免拖住退出。
    this.onExit = (): void => {
      if (this.indexDirty) this.flushIndex()
    }
    process.once('beforeExit', this.onExit)
  }

  private readonly onExit: () => void

  private indexFile(): string {
    return path.join(this.opts.dir, 'sessions-index.json')
  }

  private treeFile(rootId: string): string {
    return path.join(this.opts.dir, `tree-${rootId}.jsonl`)
  }

  /**
   * v2.8：整份重写某棵树的 jsonl。
   *
   * 只在「改的是已落盘节点的字段」时才需要 —— 改 root 的 title / lastDoneNodeId
   * 无法靠追加一行表达（jsonl 是只追加的），只能整体重写。节点通常几十条、
   * 量很小，原子写保底已经够；三处调用点共用这一段，避免再长出第二份实现。
   */
  private writeTree(rootId: string, nodes: SessionNode[]): void {
    atomicWriteFileSync(
      this.treeFile(rootId),
      nodes.map((n) => JSON.stringify(n)).join('\n') + '\n'
    )
  }

  private loadIndex(): void {
    // 没有索引文件不是「损坏」：新目录直接以空索引开始，别误报损坏、更别去留档
    if (!fs.existsSync(this.indexFile())) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile(), 'utf8')) as Partial<IndexFile>
      // N44：与 snapshots/changes 复用同一套形状校验（此前是手写的 `raw?.sessions ?? {}`）。
      // 索引是「id → meta」的 map，先摊平成数组；sessions 不是对象/数组时由
      // sanitizeIndexItems 按 notArray 统一告警，坏条目丢弃并计数。
      const rawSessions = raw?.sessions
      const list =
        rawSessions && typeof rawSessions === 'object' && !Array.isArray(rawSessions)
          ? Object.values(rawSessions)
          : rawSessions
      const shaped = sanitizeIndexItems(list, isSessionNodeMeta)
      if (shaped.notArray) {
        // N22：sessions 整体不是「对象/数组」→ 与解析失败同等处置（留档 + 清空）
        this.recoverFromUnusableIndex('的 sessions 字段不是对象/数组')
        return
      }
      for (const m of shaped.items) {
        // 数值字段缺失会让 list() 的 `b.updatedAt - a.updatedAt` 算出 NaN、排序不稳定 ——
        // 一律归一化（宽进），而不是把整条会话丢掉
        if (!isFiniteNumber(m.createdAt)) m.createdAt = 0
        if (!isFiniteNumber(m.updatedAt)) m.updatedAt = m.createdAt
        if (!isFiniteNumber(m.nodeCount)) m.nodeCount = 0
        if (typeof m.title !== 'string') m.title = ''
        // v2.8：老索引缺字段一律归一化 —— 缺 `titleSource` 说明是用户/AI 之前留下的，
        // 视为 auto（可被 AI 重写）；缺 `resumable` 视为 false（不主动骚扰用户续跑）。
        if (m.titleSource !== 'user') m.titleSource = 'auto'
        m.resumable = m.resumable === true
        // v2.15：缺 `aiTitled` 视为 false —— 老会话视为「还欠一个 AI 标题」，
        // 之后成功收尾的轮次会补起（前提是标题没被用户钉住）。
        m.aiTitled = m.aiTitled === true
        // v2.14：完整性标记只认 'damaged' 这一个取值，别的（手改索引 / 老版本残留）一律清掉，
        // 免得界面读到一个无法解释的状态
        if (m.integrity !== 'damaged') delete m.integrity
        this.index.set(m.id, m)
      }
      const warning = describeShapeWarning('会话', shaped)
      if (warning) console.warn(`[session-tree] ${warning}（${this.indexFile()}）`)
    } catch {
      this.recoverFromUnusableIndex('无法解析（文件损坏）')
    }
  }

  /**
   * N22：索引不可用（解析失败 / sessions 整体形状错误）时的统一处置：留档 + 清空。
   * 会话索引可由 `tree-*.jsonl` 另行重建，但绝不静默覆盖损坏文件（否则无法人工抢救）。
   */
  private recoverFromUnusableIndex(reason: string): void {
    const archived = quarantineFile(this.indexFile())
    this.index.clear()
    console.warn(
      `[session-tree] 会话索引${reason}${archived ? `，原文件已留档为 ${archived}` : ''}，已按空列表处理：${this.indexFile()}`
    )
  }

  private persistIndex(): void {
    const data: IndexFile = { version: 1, sessions: Object.fromEntries(this.index) }
    // T2.5：统一原子写（此前是 `${indexFile}.tmp` 固定名，并发写会互相顶掉半成品）
    // D4：索引**不要 fsync** —— 它是从 `tree-*.jsonl` 可重建的派生数据
    //（类注释就是这么定位它的）。fsync 是单次 0.1~数 ms 的 FlushFileBuffers，
    // 索引一天被写上百次，却从来不是「读不出来就丢数据」的那一类。
    // 快照正文 / 拓扑 / 设置仍然保持 fsync。
    atomicWriteJsonSync(this.indexFile(), data, { fsync: false })
    // 落盘成功了，pending 的那批变更已经进磁盘
    this.indexDirty = false
  }

  /**
   * D1：把索引落盘**推迟**到合流窗口结束。
   *
   * 内存态（index / list()）是立即更新的 —— 去抖只推迟**写盘**，不影响任何可见性。
   * 用法纪律：调用点仍要保留原有的「写失败回滚」分支（见 §十 的提醒），
   * 只是把「同步写」换成「排一次延迟写」。
   */
  private scheduleIndexPersist(): void {
    this.indexDirty = true
    if (this.indexTimer) return
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null
      this.flushIndex()
    }, INDEX_PERSIST_DEBOUNCE_MS)
    this.indexTimer.unref?.()
  }

  /**
   * D1：立即把待落盘的索引写掉。
   *
   * 写失败**不抛**：调用方是定时器 / beforeExit / 收尾路径，抛出去只会变成
   * unhandled exception（退出钩子里抛更是直接改变退出码）。失败保持 dirty，
   * 下一次 append 会重新排定时器。
   */
  flushIndex(): void {
    if (!this.indexDirty) return
    try {
      this.persistIndex()
      this.indexDirty = false
    } catch (e) {
      console.warn(`[session-tree] 会话索引落盘失败（下次变更时重试）：${this.indexFile()}`, e)
    }
  }

  /**
   * M1/D8：把最久没用的那棵树从内存里挤掉。
   *
   * 淘汰必须**连带清 owner** —— 否则那些 nodeId 还能定位到一个「已经被挤出内存」
   * 的 root，`getById` 会去把它重新解析回来，白挤一场（这正是原实现
   * `deleteSession:573` 里已在做的事，抽出来复用）。
   *
   * 数据本身在 `tree-*.jsonl` 里，淘汰不丢任何东西。
   */
  private evictOldest(): void {
    if (this.cache.size <= CACHE_MAX_TREES) return
    // Map 的插入序 = 最久未重新插入的在前；`tree()` 命中时会重新 set 提到队尾
    const oldest = this.cache.keys().next()
    if (oldest.done) return
    const rootId = oldest.value
    const nodes = this.cache.get(rootId)
    this.cache.delete(rootId)
    for (const n of nodes ?? []) this.owner.delete(n.id)
  }

  /**
   * 会话列表变化广播（N19：合流）。
   *
   * 一次任务里 `append` 被调用得极密（每个节点一次），而每次都会 `this.list()`
   * 并把**整份**列表 IPC 推给渲染层 —— 长任务下这是纯浪费：渲染层只需要「最新那一份」。
   * 这里做短延迟合流，一个 60ms 窗口内多次变更只推一份。
   *
   * 三点边界：
   * ① 没接 `onChange`（测试里的纯存储实例）直接返回 —— 不创建任何定时器；
   * ② `unref()`：定时器不该拖住进程退出；
   * ③ 合流只影响**推送**；渲染层随时可以走 `session.list` 主动拉，语义不受影响。
   */
  private notify(): void {
    if (!this.opts.onChange) return
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.opts.onChange?.(this.list())
    }, NOTIFY_COALESCE_MS)
    this.notifyTimer.unref?.()
  }

  /**
   * 解析一棵树的 jsonl。
   *
   * v2.14：坏行分两种，处置完全不同（判据取自 dsh 的 session-format：
   * 「尾部截断可容忍，中段损坏不可静默**容忍**」）：
   *
   * - **尾部坏行**（断电 / 进程被杀，最后一行只写了一半）：静默跳过。
   *   文件仍是「前缀完整」的，下一次 writeTree 会把整份重写成干净版本。
   * - **中段坏行**（坏行之后还能解析出合法节点）：这不是截断，是**损坏**。
   *   旧实现把两者一并吞掉，于是一棵被挖掉几行的树在界面上「看起来完整」——
   *   而断点续跑正是靠 root 的 `lastDoneNodeId` 与索引的 `resumable` 判断进度的，
   *   在缺了节点的基线上接着干，比直接报错更危险。
   *
   * 处置：**告警 + 标记，但不阻断加载**（少几条消息总比整个会话打不开强）。
   * 标记是**粘性**的：那几行节点确实永久丢了，后续 writeTree 只能把文件写干净、
   * 补不回数据，所以这里不做「修好就清除」。
   */
  private parseTree(rootId: string): void {
    const nodes: SessionNode[] = []
    /** 坏行数、第一处坏行的下标、最后一处合法节点的下标（判「尾部」还是「中段」） */
    let badLines = 0
    let firstBadIndex = -1
    let lastValidIndex = -1
    try {
      if (fs.existsSync(this.treeFile(rootId))) {
        const lines = fs.readFileSync(this.treeFile(rootId), 'utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          if (!line.trim()) continue
          try {
            const node = JSON.parse(line) as SessionNode
            if (node && typeof node.id === 'string') {
              nodes.push(node)
              this.owner.set(node.id, rootId)
              lastValidIndex = i
              continue
            }
          } catch {
            /* 落到下面统一按坏行计数 */
          }
          // JSON 解析失败，或解析出来不是会话节点（缺 id）—— 两者都算坏行
          badLines += 1
          if (firstBadIndex < 0) firstBadIndex = i
        }
      }
    } catch {
      /* 读失败视为空，下次写入重建 */
    }
    this.cache.set(rootId, nodes)
    this.evictOldest()

    // 判据：坏行之后仍有合法节点（中段损坏），或整个文件没有一行是合法的（整体损坏）。
    // 只有「坏行全部落在最后一段、且之前有合法节点」才算可恢复的尾部截断。
    const damaged = badLines > 0 && (lastValidIndex < 0 || lastValidIndex > firstBadIndex)
    if (!damaged) return

    const meta = this.index.get(rootId)
    if (!meta) return
    console.warn(
      `[session-tree] 会话 ${rootId} 的日志有 ${badLines} 处损坏行（不是尾部截断），` +
        `已跳过并继续加载；这些节点不可恢复。文件：${this.treeFile(rootId)}`
    )
    if (meta.integrity === 'damaged') return
    meta.integrity = 'damaged'
    try {
      this.persistIndex()
    } catch {
      /* 索引写失败不影响加载：标记退化为「本次进程内有效」 */
    }
  }

  private tree(rootId: string): SessionNode[] {
    if (!this.cache.has(rootId)) this.parseTree(rootId)
    const hit = this.cache.get(rootId)
    if (hit) {
      // LRU 触达：删了重插，把这棵树提到队尾（Map 保持插入序）
      this.cache.delete(rootId)
      this.cache.set(rootId, hit)
    }
    return hit ?? []
  }

  private appendLine(rootId: string, node: SessionNode): void {
    const file = this.treeFile(rootId)
    // 目录由构造函数 / createRoot 那一轮建好，这里每次 append 再 mkdir 一次
    // 是 130 次多余的同步 syscall —— 但**不能删**：appendLine 也可能在
    // 目录被外部删掉（用户清了数据目录）之后被调用，那时它必须自己兜住。
    // 这里保留 mkdir 但改成「只在目录不存在时」（existsSync 比 mkdirSync 便宜得多），
    // 正常路径零 syscall。
    if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true })
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
      nodeCount: 1,
      // v2.8：新会话标题是截断出来的（非用户手写）→ auto，允许 AI 生成后覆盖
      titleSource: 'auto',
      // v2.8：刚建根节点、任务还没开始 → 视为「未收尾」。
      // 若进程在这一刻崩了，重启后确实应该提示续跑（用户刚下的指令还没执行）。
      resumable: true
    }
    this.index.set(root.id, meta)
    this.cache.set(root.id, [root])
    this.owner.set(root.id, root.id)
    // M1/D8：新建会话也要受 LRU 上界约束 —— 只在 `tree()` 的惰性加载路径淘汰的话，
    // **长期不重启的进程里 cache 仍会随 `createRoot` 次数单调增长**（用户开
    // 数十个会话不重启就是数十棵常驻），而那正是本条目要堵的那类无界驻留。
    // 刚 set 进去的这棵在队尾，不会被自己挤掉。
    this.evictOldest()
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
      // v2.8：有新节点进说明任务在推进 → 重新标记为「未收尾」。
      // 不能只在 createRoot 时置 true：用户续跑完一个会话、并把它标成了
      // 「已收尾」，若后续再发一条新指令（新节点入树），它又变成未收尾了。
      // ⚠️ D1 把落盘改成去抖时**误删了这一行**（注释还在、行为没了），
      // v28-session-title 的「append 后必须重新可续跑」用例当场抓到 ——
      // 内存态必须同步改，去抖只推迟**写盘**（见 scheduleIndexPersist 的头注释）。
      meta.resumable = true
      // D1：nodeCount/updatedAt/resumable 都不需要逐节点持久化 → 去抖落盘。
      // 磁盘写失败不阻塞追加：节点已经进了 jsonl，索引缺这几个字段不丢数据
      //（nodeCount 会在下次任意一次落盘时补齐；即使一直失败，list() 仍用内存值）。
      this.scheduleIndexPersist()
    }
    this.appendLine(rootId, full)
    this.notify()
    return full
  }

  /** 测试/诊断用：当前驻留内存的树（验证 LRU 上界，见 perf-mem-review.test.mjs） */
  cachedRootIds(): string[] {
    return [...this.cache.keys()]
  }

  /** 测试/诊断用：owner 表条目数 */
  ownerCount(): number {
    return this.owner.size
  }

  // ———————————————————— 读 ————————————————————

  /** 会话摘要列表：置顶优先，同置顶态按 updatedAt 降序 */
  list(): SessionNodeMeta[] {
    return [...this.index.values()].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
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

  /**
   * F8：以 nodeId 为根的**整棵子树**（含自身），按创建时间升序。
   *
   * 分支对比要的是「从分叉点往下的这条路线」，而不是整棵树 —— 整棵树会把
   * 另一条分支的调用也算进来，diff 出来毫无意义。
   */
  subtree(rootId: string, nodeId: string): SessionNode[] {
    const nodes = this.tree(rootId)
    const byParent = new Map<string, SessionNode[]>()
    for (const n of nodes) {
      if (!n.parentId) continue
      const list = byParent.get(n.parentId) ?? []
      list.push(n)
      byParent.set(n.parentId, list)
    }
    const head = nodes.find((n) => n.id === nodeId)
    if (!head) return []
    const out: SessionNode[] = []
    const walk = (n: SessionNode): void => {
      out.push(n)
      for (const c of byParent.get(n.id) ?? []) walk(c)
    }
    walk(head)
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /**
   * 重命名会话（v2.2）：改索引标题 + root 节点 title，重写 jsonl 首行。
   * 标题截断到 60 字（与建会话口径一致）；空标题 / 未变返回 false。
   *
   * v2.8：**手动重命名会把标题钉住**（`titleSource: 'user'`）—— 此后 AI 自动生成的
   * 标题不得覆盖它（`setAutoTitle` 会直接拒绝）。这是用户唯一能对抗「AI 起名不符合我口味」
   * 的手段；不钉住的话用户改完，下一轮任务结束又被模型改回去，改标题这个操作形同虚设。
   */
  renameSession(rootId: string, title: string): boolean {
    const meta = this.index.get(rootId)
    if (!meta) return false
    const clean = title.trim().slice(0, 60)
    if (!clean || clean === meta.title) return false
    const nodes = this.tree(rootId)
    const root = nodes[0]
    if (root) root.title = clean
    meta.title = clean
    meta.titleSource = 'user'
    // root 节点也在 tree jsonl 首行里，整体重写（节点少、量小，原子写保底）
    try {
      this.writeTree(rootId, nodes)
    } catch {
      // 重写失败（文件被占用等）不阻塞索引更新：下次追加节点时首行标题会滞后，
      // 但会话可用性不受影响 —— 标题以索引为准（列表与重命名都读索引）。
    }
    this.persistIndex()
    this.notify()
    return true
  }

  /**
   * v2.8：写入 AI 自动生成的标题。
   *
   * 三条守卫，缺一不可：
   * ① **用户改过的标题不得覆盖**（`titleSource === 'user'`）—— 见 renameSession；
   * ② 与当前标题相同 → 不写（避免无谓的 jsonl 重写与列表广播）；
   * ③ 空标题 → 不写（调用方兜底逻辑出问题时，宁可保留旧标题也不要清空）。
   *
   * v2.15：新增 `aiTitled` 参数 —— 只在**模型真的给出了可用标题**时传 true，
   * 兜底截断不算（那样后续轮次还能重试补起一个真正的 AI 标题）。
   *
   * 返回是否真的改了。
   */
  setAutoTitle(rootId: string, title: string, aiTitled = false): boolean {
    const meta = this.index.get(rootId)
    if (!meta) return false
    if (meta.titleSource === 'user') return false
    const clean = title.trim().slice(0, 60)
    if (!clean || clean === meta.title) return false
    const nodes = this.tree(rootId)
    const root = nodes[0]
    if (root) root.title = clean
    meta.title = clean
    meta.titleSource = 'auto'
    if (aiTitled) meta.aiTitled = true
    try {
      this.writeTree(rootId, nodes)
    } catch {
      /* 与 renameSession 同：索引为准，首行滞后不影响可用性 */
    }
    this.persistIndex()
    this.notify()
    return true
  }

  /** v2.8：该会话的标题是否允许被 AI 重写 */
  titleEditable(rootId: string): boolean {
    return this.index.get(rootId)?.titleSource !== 'user'
  }

  /**
   * v2.15：该会话是否「还欠一个 AI 标题」—— 标题没被用户钉住、且 AI 尚未
   * 成功起过名。收尾钩子据此决定是否发标题请求：既覆盖首轮，也覆盖
   * 「首轮失败/被中止，后续轮次补起」的重试，还保证 AI 起过名之后不再重复打扰。
   */
  needsAutoTitle(rootId: string): boolean {
    const meta = this.index.get(rootId)
    if (!meta) return false
    if (meta.titleSource === 'user') return false
    return meta.aiTitled !== true
  }

  /**
   * v2.8：标记会话「已收尾」。
   *
   * 由宿主在任务真正走到 `done` 时调用（**不是**每条消息落盘时）。
   * 传空串 = 该会话当前不可续跑（例如用户主动放弃）。
   */
  markSettled(rootId: string, doneNodeId: string): void {
    const meta = this.index.get(rootId)
    if (!meta) return
    const nodes = this.tree(rootId)
    const root = nodes[0]
    if (root) root.lastDoneNodeId = doneNodeId
    meta.resumable = false
    // 与 setAutoTitle 同：`lastDoneNodeId` 是 root 节点的字段，只在内存里改的话
    // 重启后就丢了（索引里没有它）—— 而它的用处正是「重启后判断上次走到哪」。
    try {
      this.writeTree(rootId, nodes)
    } catch {
      /* 重写失败不阻塞索引：resumable 已经落在索引里，续跑提示仍然正确 */
    }
    this.persistIndex()
    this.notify()
  }

  /**
   * v2.16：记录一轮任务的收尾信息（root.turnFinishes，键 = 该轮 user 节点 id）。
   *
   * 由宿主在收到 `done` 时调用。落盘理由与 `lastDoneNodeId` 同：渲染层历史回放
   * 拿不到当次的 `usage`/`done` 事件，不落盘历史里就合成不出带用量/模型的收尾卡。
   * 同一 user 节点重复收尾（重走/重试后同节点再跑）以最后一次为准 —— 与界面上
   * 「一轮一张收尾卡」的直觉一致。
   *
   * 写失败静默吞掉：收尾信息是锦上添花，不能让它把任务收尾本身拖垮。
   */
  recordTurnFinish(rootId: string, userNodeId: string, record: TurnFinishRecord): void {
    const meta = this.index.get(rootId)
    if (!meta) return
    const nodes = this.tree(rootId)
    const root = nodes[0]
    if (!root || root.id !== rootId) return
    root.turnFinishes = { ...(root.turnFinishes ?? {}), [userNodeId]: record }
    try {
      this.writeTree(rootId, nodes)
    } catch {
      return
    }
    this.persistIndex()
    this.notify()
  }

  /**
   * v2.8：列出可续跑的会话（未收尾的），按更新时间降序。
   * 只取最近一条给界面提示用 —— 一次崩溃可能留下多个未收尾会话，
   * 但一次性弹多个「继续上次任务」只会让用户困惑。
   */
  resumable(): SessionNodeMeta[] {
    return [...this.index.values()]
      .filter((m) => m.resumable === true)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * F8（v2.12）：把某个节点标记 / 取消标记为书签（阶段完成点）。
   *
   * 书签是**节点字段**（`SessionNode.bookmarked`），jsonl 只追加，表达不了「删字段」，
   * 所以这里整份重写 —— 与 `setAutoTitle` / `markSettled` 同一套做法。
   *
   * 写盘失败时把内存改回去再抛错：否则「界面上标上了、磁盘上没有」，
   * 重开会话后书签凭空消失（ChangeStore.add 的回滚同款理由）。
   *
   * @returns 节点是否存在（不存在返回 false，不抛错）
   */
  setBookmark(rootId: string, nodeId: string, bookmarked: boolean): boolean {
    const nodes = this.tree(rootId)
    const node = nodes.find((n) => n.id === nodeId)
    if (!node) return false
    const prev = node.bookmarked
    if (bookmarked) node.bookmarked = true
    else delete node.bookmarked
    try {
      this.writeTree(rootId, nodes)
    } catch (e) {
      if (prev === undefined) delete node.bookmarked
      else node.bookmarked = prev
      throw e
    }
    this.notify()
    return true
  }

  /** F8：该会话的全部书签节点（按创建时间升序） */
  bookmarks(rootId: string): SessionNode[] {
    return this.tree(rootId)
      .filter((n) => n.bookmarked === true)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 置顶 / 取消置顶会话（v2.2）：只改索引，不碰树内容 */
  setSessionPinned(rootId: string, pinned: boolean): void {
    const meta = this.index.get(rootId)
    if (!meta) return
    meta.pinned = pinned
    this.persistIndex()
    this.notify()
  }

  /**
   * 删除单个会话（v2.2）：删 jsonl + 索引 + 缓存与 owner 引用，内存磁盘一致。
   * 返回是否真的删掉了（会话不存在时返回 false，不抛错）。
   */
  deleteSession(rootId: string): boolean {
    const meta = this.index.get(rootId)
    if (!meta) return false
    // 先解析一次拿到全部节点，把 owner 引用清干净（否则孤儿 nodeId 还能定位到这个 root）
    for (const n of this.tree(rootId)) this.owner.delete(n.id)
    this.index.delete(rootId)
    this.cache.delete(rootId)
    try {
      fs.rmSync(this.treeFile(rootId), { force: true })
    } catch {
      /* 文件被占用等：内存已删，下次写入重建 */
    }
    this.persistIndex()
    this.notify()
    return true
  }

  /**
   * v2.12：从某节点起截断整条分支（该节点 + 全部后代），「删除消息 / 重新生成」的底层。
   *
   * 语义：树是**前缀稳定**的 —— 删中间一个节点必须连它整棵子树一起删
   * （否则子节点的 parentId 悬挂，祖先链断掉）。所以「删除单条消息」实际是
   * 「从这条起后面的都没了」，与主流 AI 应用的编辑语义一致。
   *
   * `keepSelf`：只删后代、保留节点自身。用于「重新生成第一条指令的回答」——
   * root 节点不能删（它是会话本体），只能把它下面的旧回答分支清掉再重跑。
   *
   * 同步维护五件事，缺一就是静默腐化：
   * ① jsonl 整份重写（只追加的格式表达不了删除）；
   * ② owner 引用清理（孤儿 nodeId 还能定位到 root）；
   * ③ 索引 nodeCount / updatedAt；
   * ④ root 的 lastDoneNodeId 悬挂修正（指向被删节点时改指新尾部）；
   * ⑤ root 的 turnFinishes 悬挂清理（v2.26：删掉的轮不该再合成收尾卡）。
   * resumable **不**翻回 true：用户手动编辑过的会话不该再弹「继续上次任务」。
   *
   * @returns 实际删除的节点数与新尾部节点 id（keepSelf 时为节点自身）
   * @throws 未知会话 / 未知节点 / 删根节点（未开 keepSelf）
   */
  deleteFromNode(
    rootId: string,
    nodeId: string,
    opts?: { keepSelf?: boolean }
  ): { removed: number; newTailId: string | null } {
    const meta = this.index.get(rootId)
    if (!meta) throw new Error(`未知会话：${rootId}`)
    const nodes = this.tree(rootId)
    const target = nodes.find((n) => n.id === nodeId)
    if (!target) throw new Error(`未知节点：${nodeId}`)
    if (target.parentId === null && !opts?.keepSelf) {
      throw new Error('不能删除会话根节点（如需清空请使用删除会话）')
    }

    // 收集待删集合：节点自身（除非 keepSelf）+ 全部后代
    const doomed = new Set<string>()
    const collect = (id: string, includeSelf: boolean): void => {
      if (includeSelf) doomed.add(id)
      for (const n of nodes) {
        if (n.parentId === id && !doomed.has(n.id)) collect(n.id, true)
      }
    }
    collect(nodeId, !opts?.keepSelf)

    const remaining = nodes.filter((n) => !doomed.has(n.id))
    const newTailId =
      opts?.keepSelf ? nodeId : (remaining.find((n) => n.id === target.parentId)?.id ?? null)

    // lastDoneNodeId 悬挂修正：指向被删节点 → 改指新尾部（新尾部是 root 或不存在则删字段）
    const root = remaining.find((n) => n.parentId === null)
    if (root?.lastDoneNodeId && doomed.has(root.lastDoneNodeId)) {
      if (newTailId && newTailId !== root.id) root.lastDoneNodeId = newTailId
      else delete root.lastDoneNodeId
    }

    /**
     * v2.26：清掉「已经不存在的轮」的收尾记录（`turnFinishes` 的键 = 该轮 user 节点 id）。
     *
     * 历史回放（`nodesToMessages`）按这份记录在每轮末尾合成收尾卡，截断时不清就会留下幽灵：
     * - 非 keepSelf：被删的 user 节点已经不在树里，那张卡再也不会被合成（残留但无害）；
     * - **keepSelf（重新生成第一条指令的回答）**：节点自身保留、旧回答全部删掉，记录却还挂着 ——
     *   重新载入一次会话，第一条指令下面就凭空多出一行「任务已完成 · 任务耗时 …」，
     *   看起来像「重新生成之后收尾卡还是旧的」，而它对应的回答早已被删。
     */
    if (root?.turnFinishes) {
      const kept = Object.keys(root.turnFinishes).filter(
        (key) => !doomed.has(key) && !(opts?.keepSelf && key === nodeId)
      )
      if (kept.length > 0) {
        const next: Record<string, TurnFinishRecord> = {}
        for (const key of kept) next[key] = root.turnFinishes[key]!
        root.turnFinishes = next
      } else {
        delete root.turnFinishes
      }
    }

    // 内存三张表同步
    for (const id of doomed) this.owner.delete(id)
    this.cache.set(rootId, remaining)
    meta.nodeCount = Math.max(1, meta.nodeCount - doomed.size)
    meta.updatedAt = Date.now()

    // 落盘：jsonl 整份重写 + 索引原子写
    this.writeTree(rootId, remaining)
    this.persistIndex()
    this.notify()
    return { removed: doomed.size, newTailId }
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