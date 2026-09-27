import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionNode, SessionNodeMeta, TurnFinishRecord } from '@shared/types'
import { atomicWriteFileSync, atomicWriteJsonSync } from '../fs/atomic'

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
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile(), 'utf8')) as IndexFile
      const sessions = raw?.sessions ?? {}
      for (const m of Object.values(sessions)) {
        if (m && typeof m.id === 'string') {
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
      // v2.8：有新节点进来说明任务在推进 → 重新标记为「未收尾」。
      // 不能只在 createRoot 时置 true：用户续跑完一个会话、并把它标成了
      // 「已收尾」，若后续再发一条新指令（新节点入树），它又变成未收尾了。
      meta.resumable = true
      this.persistIndex()
    }
    this.appendLine(rootId, full)
    this.notify()
    return full
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
   * 同步维护四件事，缺一就是静默腐化：
   * ① jsonl 整份重写（只追加的格式表达不了删除）；
   * ② owner 引用清理（孤儿 nodeId 还能定位到 root）；
   * ③ 索引 nodeCount / updatedAt；
   * ④ root 的 lastDoneNodeId 悬挂修正（指向被删节点时改指新尾部）。
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