import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { Notification, app } from 'electron'
import {
  writeBootstrapStorage,
  migrateDirectory,
  type MigrateProgress
} from './core/storage/bootstrap'
import type { AgentEvent, GateDecision, McpServerStatus, SessionNode, Settings } from '@shared/types'
import type { QuestionAnswers, TodoItem } from '@shared/interaction'
import type { GoalArchivePayload } from '@shared/api'
import { EVENT } from '@shared/channels'
import { activeProfile } from '@shared/profiles'
import { accumulateUsage, EMPTY_TURN_USAGE, type TurnUsage } from '@shared/turn-usage'
import { createStores, storageDirs } from './services/stores'
import { builtinTools, createAgentDeps } from './services/agent-wiring'
import { GoalArchiveStore } from './goals/store'
import type { TodoStore } from './core/todo/store'
import { attachmentNoteLine, type Attachment } from '@shared/attachments'
// v2.22（F17）：图片附件的模型能力闸门（起任务前拦截）
import { imageAttachmentsOf, modelImageGate } from '@shared/image-attach'
import {
  checkClearTarget,
  emptyDir,
  measureStorage,
  validateUserDataTarget,
  type ClearResult,
  type StorageReport,
  type StorageScope
} from './core/storage/usage'
import { JsonStore } from './core/store/store'
import { SnapshotStore } from './core/store/snapshots'
import { ChangeStore } from './core/store/changes'
import { TopologyStore } from './core/topology/store'
import { deriveTopology } from './core/topology/fromNeighbors'
import type { Topology } from './core/topology/model'
import { SessionTreeStore } from './core/session-tree/store'
import { AttachmentStore } from './core/attachments/store'
import { McpClientManager } from './core/mcp/client'
import { SkillStore } from './skills/store'
import { collectSessionReport, writeCompareReport } from './tools/sessions'
import {
  branchLabelOf,
  compareBranches,
  renderComparisonMarkdown,
  type BranchComparison
} from './core/session-tree/compare'
import { probesFromSessions } from './tools/topology'
import { createMcpServer, type McpServerHandle } from './mcp/server'
import { SessionManager } from './core/session/SessionManager'
import { MockRuntime } from './agent/mock.runtime'
import { ReactRuntime } from './agent/react.runtime'
import type { AgentDeps, AgentRuntime } from './agent/runtime.iface'
import { getApiKey, hasApiKey, listKeyedProfileIds, removeApiKey } from './settings/secrets'

interface ActiveAgent {
  sessionId: string
  controller: AbortController
  runtime: AgentRuntime
}

/**
 * 服务容器：把持久化、会话、工具、Agent 运行时装配起来。
 *
 * 主进程里只有这一个装配点，IPC 层只做「校验参数 → 调用服务 → 回传结果」，
 * 不持有业务逻辑。这样 IPC 层可以很薄，也容易审查。
 */
/** 迁移进度回调（IPC 层桥到渲染层事件） */
export type MigrateProgressHandler = (p: MigrateProgress) => void

export class Services {
  readonly store: JsonStore
  readonly snapshots: SnapshotStore
  readonly changes: ChangeStore
  readonly sessions: SessionManager
  readonly topology: TopologyStore
  readonly sessionTree: SessionTreeStore
  /** v1.3：技能（导入/编辑/启停，启用内容注入 agent system prompt） */
  readonly skills: SkillStore
  /** v1.10：一句话实验目标（内置丰富预设实验目标） */
  readonly goals: GoalArchiveStore
  /** v1.6：数据根目录（设置 → 通用 里要展示路径、算占用、开文件夹） */
  readonly userDataDir: string
  /** v1.5：附件归档（用户从输入框导入的文件复制到这里，代理只能在此目录内读） */
  readonly attachments: AttachmentStore
  /** v1.5：外部 MCP 客户端（本应用连出去的 MCP 服务器） */
  readonly mcpClients: McpClientManager
  /** v2.7：任务清单（按会话根 ID 分桶；agent 与界面共用一份） */
  readonly todos: TodoStore

  /**
   * 三个受管目录（报告导出 / 附件归档 / 配置快照）。
   *
   * T5.2：解析口径统一到 `services/stores.ts` 的 `storageDirs` ——
   * 过去这三段 getter 与构造函数里的目录解析是两处独立实现，改一处忘一处就会
   * 「设置里改了、实际写到了别处」。
   */
  private get managedDirs(): { exportsDir: string; attachmentsDir: string; snapshotsDir: string; topologyDir: string } {
    return storageDirs(this.userDataDir, this.store.getSettings())
  }

  get exportsDir(): string {
    return this.managedDirs.exportsDir
  }

  get attachmentsDir(): string {
    return this.managedDirs.attachmentsDir
  }

  get snapshotsDir(): string {
    return this.managedDirs.snapshotsDir
  }

  get topologyDir(): string {
    return this.managedDirs.topologyDir
  }

  /** v2.2：会话树数据目录（右键菜单「文件管理」打开的就是这里） */
  get sessionDir(): string {
    return path.join(this.userDataDir, 'sessions')
  }

  /** v2.2：某会话的 jsonl 文件路径（不存在返回 null；右键「在资源管理器打开」用） */
  sessionFileOf(rootId: string): string | null {
    const file = path.join(this.sessionDir, `tree-${rootId}.jsonl`)
    return fs.existsSync(file) ? file : null
  }

  private readonly active = new Map<string, ActiveAgent>()
  /** v0.4：MCP 服务运行态 */
  private mcpHandle: McpServerHandle | null = null
  private mcpRunning = false
  private mcpUrl = ''
  private mcpError: string | null = null

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    const userData = app.getPath('userData')
    this.userDataDir = userData

    // T5.2：10 个 store 的创建顺序与互相依赖集中到 services/stores.ts，
    // 这里只做「持有 + 转发」（顺序语义见 createStores 的注释）。
    const stores = createStores({
      userDataDir: userData,
      emit: (channel, payload) => this.send(channel, payload)
    })
    this.store = stores.store
    this.snapshots = stores.snapshots
    this.changes = stores.changes
    this.sessions = stores.sessions
    this.topology = stores.topology
    this.sessionTree = stores.sessionTree
    this.skills = stores.skills
    this.goals = stores.goals
    this.attachments = stores.attachments
    this.mcpClients = stores.mcpClients
    this.todos = stores.todos
  }

  private send(channel: string, payload: unknown): void {
    const win = this.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  getSettings(): Settings {
    return this.store.getSettings()
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const before = this.store.getSettings()
    const after = this.store.updateSettings(patch)
    // MCP 开关/端口变化 → 重启服务（幂等，失败只记状态不抛给渲染层）
    if (before.mcp.enabled !== after.mcp.enabled || before.mcp.port !== after.mcp.port) {
      void this.applyMcp().catch(() => undefined)
    }
    // D7 备注：对外 MCP 出口的工具集**恒为**内置工具（builtinTools()），与
    // mcp.exposeToAgent 无关 —— 所以 exposeToAgent 变更无需触发 applyMcp 重建，
    // 进程内代理下一轮取工具表（agentTools）时自然生效。
    // v1.5：外部 MCP 服务器配置变化 → 重连（sync 单飞，并发改配置不会互相打断）
    if (JSON.stringify(before.mcp.servers) !== JSON.stringify(after.mcp.servers)) {
      void this.syncMcpClients().catch(() => undefined)
    }
    // v1.5：档案被删除 → 连带清掉它的密钥，避免密钥文件里留下孤儿条目
    const liveIds = new Set(after.agent.profiles.map((p) => p.id))
    for (const p of before.agent.profiles) {
      if (!liveIds.has(p.id)) removeApiKey(p.id)
    }
    // 存储目录自定义变更时即时同步 store 根目录
    if (patch.storage) {
      this.attachments.setRootDir(this.attachmentsDir)
      this.snapshots.setBaseDir(this.snapshotsDir)
      this.changes.setBaseDir(this.snapshotsDir)
    }
    // 回显编码改了 → 即时应用到活动会话（不必重连）。
    // 只在下次连接时生效的话，用户改完盯着终端看「怎么还是乱码」，
    // 这条设置就等于坏掉了 —— 而它正是排查中文乱码时要来回试的一项。
    if (before.deviceEncoding !== after.deviceEncoding) {
      this.sessions.applyEncodingPref(after.deviceEncoding)
    }
    // D9：任何来源的设置变更都广播给渲染层。
    // 旧实现只有「渲染层自己发起 updateSettings 的返回值」这一条刷新路径，
    // 主进程直改设置的路径（Wireshark 挂载 / 数据目录切换）在界面上不可见，
    // 且会被同窗口的下一次写回（用旧闭包）静默抹掉。广播后界面永远与主进程一致。
    this.send(EVENT.settingsUpdated, after)
    return after
  }

  /** v1.10：一句话实验目标存档（内置丰富预设，渲染层只读，随机抽三条展示） */
  getGoalsPayload(): GoalArchivePayload {
    return this.goals.list()
  }

  /** 按当前设置启停 MCP 服务（app ready 与设置变更共用） */
  async applyMcp(): Promise<void> {
    const s = this.store.getSettings().mcp
    try {
      if (!s.enabled) {
        if (this.mcpHandle) {
          await this.mcpHandle.close()
          this.mcpHandle = null
        }
        this.mcpRunning = false
        this.mcpUrl = ''
        this.mcpError = null
      } else {
        if (this.mcpHandle && this.mcpHandle.port === s.port) {
          // 同端口已运行，幂等跳过
        } else {
          if (this.mcpHandle) {
            await this.mcpHandle.close()
            this.mcpHandle = null
          }
          const handle = await createMcpServer({
            // D7：对外出口只给**内置**工具表（agentTools 里含外部工具，会造成自环）
            deps: { tools: builtinTools(), buildContext: this.agentDeps().buildContext },
            port: s.port
          })
          this.mcpHandle = handle
          this.mcpRunning = true
          this.mcpUrl = handle.url
          this.mcpError = null
        }
      }
    } catch (e) {
      this.mcpRunning = false
      this.mcpError = e instanceof Error ? e.message : String(e)
    }
    this.send(EVENT.mcpStatus, {
      running: this.mcpRunning,
      url: this.mcpUrl,
      error: this.mcpError
    })
  }

  getMcpStatus(): { running: boolean; url: string; error: string | null } {
    return { running: this.mcpRunning, url: this.mcpUrl, error: this.mcpError }
  }

  // ———————————————————————— 外部 MCP（v1.5） ————————————————————————

  /** 按设置重连外部 MCP 服务器；返回各台状态 */
  async syncMcpClients(): Promise<McpServerStatus[]> {
    return this.mcpClients.sync(this.store.getSettings().mcp.servers)
  }

  /** 当前已连接服务器状态（不触发重连，供 UI 首次拉取） */
  mcpServerStatuses(): McpServerStatus[] {
    return this.mcpClients.list()
  }

  /** 测试单台服务器：连接 + 列工具后立即断开，不影响已有连接 */
  async testMcpServer(id: string): Promise<McpServerStatus | null> {
    const cfg = this.store.getSettings().mcp.servers.find((s) => s.id === id)
    if (!cfg) return null
    return this.mcpClients.test(cfg)
  }

  /** 注入模型的外部工具名清单（UI 与日志用；工具本身在 agentDeps 里动态生成） */
  externalToolNames(): string[] {
    return this.mcpClients.externalTools().map((t) => t.namespaced)
  }

  // ———————————————————————— Agent ————————————————————————

  /** 代理这一轮能看到什么（工具表 / 技能 / 自定义指令 / 工具上下文）见 services/agent-wiring.ts */
  private agentDeps(emitEvent?: (event: AgentEvent) => void): AgentDeps {
    return createAgentDeps({
      getSettings: () => this.store.getSettings(),
      skills: this.skills,
      mcpClients: this.mcpClients,
      sessions: this.sessions,
      snapshots: this.snapshots,
      changes: this.changes,
      topology: this.topology,
      sessionTree: this.sessionTree,
      attachments: this.attachments,
      // v2.7：任务清单（todo_write 的出口）
      todos: this.todos,
      exportsDir: () => this.exportsDir,
      // v2.15：流外事件直发（收尾后的标题生成），由 createRuntime 按本轮会话装配
      emitEvent
    })
  }

  createRuntime(sessionId: string): { runtime: AgentRuntime; kind: 'react' | 'mock' } {
    const settings = this.store.getSettings()
    // v1.5：密钥按档案分档 —— 取当前活跃档案自己的那把，而不是「第一把」
    const apiKey = getApiKey(activeProfile(settings.agent).id)
    const wantReact = settings.agent.runtime === 'react'
    // v2.15：流外事件通道 —— 收尾后的标题生成发生在事件流 close() 之后，
    // title_updated 必须经这里直发渲染层（带本轮的 sessionId 与 runtime 类型）。
    const emitEvent = (event: AgentEvent): void => {
      this.send(EVENT.agentEvent, {
        sessionId,
        event,
        runtime: wantReact && apiKey ? 'react' : 'mock'
      })
    }
    if (wantReact && apiKey) {
      return {
        runtime: new ReactRuntime(this.agentDeps(emitEvent), {
          apiKey,
          // v1.6：permission.confirmDanger 关掉时，危险工具不再弹闸门 —— 语义是「直接执行」
          // （与界面横幅一致），不是「一律拒绝」；跳过确认的事实会写进 tool_end 摘要。
          allowDangerousWithGate: settings.permission.confirmDanger
        }),
        kind: 'react'
      }
    }
    return { runtime: new MockRuntime(this.agentDeps(emitEvent)), kind: 'mock' }
  }

  /**
   * 启动一轮代理任务。
   * v0.4：会话树落盘 —— 无 rootId 则新建会话，有 startNodeId 则在该节点下「换路重走」；
   * 运行期把 user/assistant/tool 节点增量写入树，供回溯与报告使用。
   */
  async startAgent(
    sessionId: string,
    text: string,
    opts?: {
      rootId?: string | null
      startNodeId?: string | null
      attachments?: Attachment[]
      /** v2.7：计划模式（只读探索 + 方案评审批准后才允许写操作） */
      planMode?: boolean
    }
  ): Promise<void> {
    if (this.active.has(sessionId)) {
      throw new Error('该会话已有任务在运行')
    }
    // v1.5：附件只在这一轮生效；会话树里只留「清单」不落预览，避免历史把上下文越滚越大
    const attachments = opts?.attachments ?? []
    /**
     * v2.22（F17）：图片附件 + 不支持的模型 → **在起任务之前**拒绝。
     *
     * 这是「阻止用户」的第二道（第一道在渲染层，负责把原因讲清楚并留住输入框里的字）。
     * 为什么主进程也要拦：IPC 是唯一的起任务入口，但渲染层的判定随时可能被绕开
     * （将来加命令行、脚本调用、或界面判定的那份能力数据过期）。放行的后果不是
     * 「图片被忽略」，而是整轮请求被端点 400 拒绝 —— 用户看到的是一个与图片毫无
     * 关联的报错，最难排查。判错方向取保守：能力未知 = 拒绝。
     */
    const imageAttachments = imageAttachmentsOf(attachments)
    if (imageAttachments.length > 0) {
      const imageGate = modelImageGate(activeProfile(this.store.getSettings().agent))
      if (!imageGate.ok) {
        throw new Error(
          `${imageGate.message}\n本次未发送任何内容（任务未启动），图片：` +
            imageAttachments.map((a) => a.name).join('、')
        )
      }
    }
    // v2.2：本轮任务开始时间（收尾通知 / done 事件带耗时）
    const taskStartedAt = Date.now()

    // —— 会话树：定位父节点并写好本次 user 节点 ——
    // 三条路径：
    //   1) 有 rootId + 有效 startNodeId → 「换路重走」：从该节点开新分支
    //   2) 只有 rootId（进入旧会话继续）→ 追加到该会话当前尾部，历史注入整条祖先链
    //   3) 无 rootId → 新建会话
    const rootId = opts?.rootId ?? null
    // v2.7：本轮的会话根 ID（新建会话时由 createRoot 决定，见下）
    let runRootId = rootId
    const startNode = opts?.startNodeId ? this.sessionTree.getById(opts.startNodeId) : undefined
    let history: SessionNode[] = []
    let tail: SessionNode
    if (rootId && startNode) {
      history = this.sessionTree.pathTo(rootId, startNode.id)
      tail = this.sessionTree.append(startNode.id, {
        id: `n-${randomUUID()}`,
        role: 'user',
        content: withAttachmentNote(text, attachments)
      })
    } else if (rootId && this.sessionTree.getTree(rootId).length > 0) {
      const tree = this.sessionTree.getTree(rootId)
      const last = tree[tree.length - 1]!
      history = this.sessionTree.pathTo(rootId, last.id)
      tail = this.sessionTree.append(last.id, {
        id: `n-${randomUUID()}`,
        role: 'user',
        content: withAttachmentNote(text, attachments)
      })
    } else {
      const root = this.sessionTree.createRoot(text.slice(0, 60))
      tail = root
      // v2.7：新建会话时根节点 id 就是本轮的 rootId —— 任务清单按它分桶
      runRootId = root.id
    }
    // v2.16：本轮指令的 user 节点 id —— 收尾信息（turnFinishes）按它落盘，
    // 历史回放据此在「这轮的末尾」合成收尾卡。必须在运行前捕获：tail 会随
    // assistant / tool 节点落盘不断后移。
    const turnUserNodeId = tail.id

    const controller = new AbortController()
    const { runtime, kind } = this.createRuntime(sessionId)
    this.active.set(sessionId, { sessionId, controller, runtime })

    // v2.12：把本轮的会话根 ID 告诉渲染层。新建会话时渲染层的 activeRootId 是 null
    // （root 由这里 createRoot 产生），而消息删除/重新生成都需要它定位会话树。
    // 放在事件流启动前发，保证渲染层在收到任何内容事件前就完成绑定。
    // 三条路径走到这里 runRootId 必为 string（新建分支由 createRoot 赋值），
    // 守卫只为收窄类型 —— 真到不了这里。
    if (!runRootId) throw new Error('无法确定本轮会话根 ID')
    this.send(EVENT.agentEvent, {
      sessionId,
      event: { type: 'session_bound', rootId: runRootId } satisfies AgentEvent,
      runtime: kind
    })

    // 增量节点收集：assistant 文本按「工具调用边界」收束成节点，工具成对落节点
    let pendingAssistant: string | null = null
    const flushAssistant = (): void => {
      if (pendingAssistant === null || !pendingAssistant.trim()) return
      const node = this.sessionTree.append(tail.id, {
        id: `n-${randomUUID()}`,
        role: 'assistant',
        content: pendingAssistant.trimEnd()
      })
      tail = node
      pendingAssistant = null
    }
    const pendingTools = new Map<string, NonNullable<SessionNode['toolCall']>>()
    /** v2.5：已回来的工具结果（按 callId），等在它前面的调用落盘后才写树 */
    const resolvedToolResults = new Map<
      string,
      { ok: boolean; ms: number; summary: string; errorCode?: string; cardMeta?: unknown }
    >()
    /**
     * v2.5 并发落盘：`tool_end` 的到达顺序取决于**哪台设备先回**，而会话树
     * （历史回溯 + 报告导出）必须保持模型给出的调用顺序。
     *
     * 做法：Map 的迭代顺序就是 `tool_start` 的登记顺序，从头往后遇到第一个还没回来的
     * 就停下 —— 这样既保证顺序，又不会为了等一台慢设备而压住后面已完成的节点。
     * 注意不能「谁回来就先写谁」：那会让历史会话里的工具顺序与当次看到的不一致，
     * 而这种错位在报告里是看不出来的（顺序看着就是随机的）。
     */
    const flushToolNodes = (): void => {
      const ready: Array<{
        callId: string
        tc: NonNullable<SessionNode['toolCall']>
        r: { ok: boolean; ms: number; summary: string; errorCode?: string; cardMeta?: unknown }
      }> = []
      for (const [callId, tc] of pendingTools) {
        const r = resolvedToolResults.get(callId)
        if (!r) break
        ready.push({ callId, tc, r })
      }
      for (const { callId, tc, r } of ready) {
        const node = this.sessionTree.append(tail.id, {
          id: `n-${randomUUID()}`,
          role: 'tool',
          content: `${tc.name}(${safeJsonPeek(tc.args)})`,
          // v2.8：把一句话摘要与错误码一起落盘 —— 断点续跑时模型据此知道
          // 「那次调用到底看到了什么」，避免把已经做对的事重做一遍。
          toolCall: {
            ...tc,
            ok: r.ok,
            ms: r.ms,
            ...(r.summary ? { summary: r.summary } : {}),
            ...(r.errorCode ? { errorCode: r.errorCode } : {}),
            // H（v2.14）：可回放卡片数据（只有声明了 presentationMeta 的工具才有）。
            // 它必须落盘 —— `tool_end.data` 是当次事件，回放/演示模式拿不到。
            ...(r.cardMeta !== undefined ? { cardMeta: r.cardMeta } : {})
          }
        })
        tail = node
        pendingTools.delete(callId)
        resolvedToolResults.delete(callId)
      }
    }
    /** v1.6：通知文案要写「完成了 / 失败 / 中止」，所以得记住最后一个 done 的原因 */
    let doneReason: 'completed' | 'aborted' | 'failed' | null = null
    /** 本轮出现过的错误摘要（通知里带上，省得用户还得切回来才知道发生了什么） */
    let lastError: string | null = null
    // v2.16：本轮累计用量与收尾耗时 —— done 时折进 turnFinishes 落盘，
    // 历史回放据此合成带用量/模型的收尾卡（与实时流一致）。
    let turnUsage: TurnUsage = EMPTY_TURN_USAGE
    let doneMs = 0

    const collect = (event: AgentEvent): void => {
      switch (event.type) {
        case 'text':
          pendingAssistant = (pendingAssistant ?? '') + event.delta
          return
        case 'thinking': {
          // v2.2：思考段落节点 —— 否则历史会话里「思考」行会整段消失。
          // 它只是界面可回溯的展示内容，不参与模型上下文注入（见 historyToMessages）。
          flushAssistant()
          const node = this.sessionTree.append(tail.id, {
            id: `n-${randomUUID()}`,
            role: 'thinking',
            content: event.text
          })
          tail = node
          return
        }
        case 'tool_start':
          flushAssistant()
          pendingTools.set(event.callId, {
            callId: event.callId,
            name: event.name,
            args: event.args
          })
          // 上一个（或更早的）调用可能已经回来了，先落盘
          flushToolNodes()
          return
        case 'tool_end': {
          if (pendingTools.has(event.callId)) {
            resolvedToolResults.set(event.callId, {
              ok: event.ok,
              ms: event.ms,
              summary: event.summary,
              ...(event.errorCode ? { errorCode: event.errorCode } : {}),
              // H（v2.14）：卡片数据跟着结果一起攒着，等它前面的调用落盘后一并写树
              ...(event.cardMeta !== undefined ? { cardMeta: event.cardMeta } : {})
            })
          }
          flushToolNodes()
          return
        }
        case 'gate_request':
          // v1.6：需要人工确认时提醒（此时窗口几乎一定不在前台，用户看不到弹窗）
          if (this.store.getSettings().notify.onGate) {
            this.notify('代理需要你确认', `${event.name} 等待批准：${firstLine(event.reason)}`)
          }
          return
        case 'usage':
          // v2.16：与渲染层同一口径累加（promptTokens 是整段上下文，按轮相加即「累计用量」）
          turnUsage = accumulateUsage(
            turnUsage,
            { promptTokens: event.promptTokens, outputTokens: event.outputTokens },
            { measured: event.measured, contextWindow: event.contextWindow, ratio: event.ratio }
          )
          return
        case 'error':
          lastError = event.message
          return
        case 'done':
          doneReason = event.reason
          doneMs = event.ms
          return
        default:
          return
      }
    }

    try {
      for await (const event of runtime.run({
        sessionId,
        text,
        signal: controller.signal,
        history,
        attachments,
        // v2.7：清单分桶与计划模式都要传给运行时 —— 它们是运行时才知道的事
        ...(runRootId ? { rootId: runRootId } : {}),
        ...(opts?.planMode ? { planMode: true } : {})
      })) {
        collect(event)
        this.send(EVENT.agentEvent, {
          sessionId,
          event,
          runtime: kind
        } satisfies { sessionId: string; event: AgentEvent; runtime: 'react' | 'mock' })
      }
    } catch (e) {
      flushAssistant()
      this.send(EVENT.agentEvent, {
        sessionId,
        event: {
          type: 'error',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false
        } satisfies AgentEvent,
        runtime: kind
      })
      this.send(EVENT.agentEvent, {
        sessionId,
        event: { type: 'done', reason: 'failed', ms: Date.now() - taskStartedAt } satisfies AgentEvent,
        runtime: kind
      })
      // v2.16：这条 done 没经过事件循环，补记收尾信息，让 finally 统一落盘
      //（走 collect 而不是直接赋值：赋值会让 TS 把 doneReason 窄化成 'failed'）
      collect({ type: 'done', reason: 'failed', ms: Date.now() - taskStartedAt } satisfies AgentEvent)
    } finally {
      flushAssistant()
      // v2.5：收尾时把还没落盘的已回结果补上（中途 abort 时，某一批可能只回了一部分）
      flushToolNodes()
      // v2.16：把本轮收尾信息落进会话树（历史回放据此合成带用量/模型的收尾卡，
      // 与实时流一致）。所有收尾路径都经这里；失败静默 —— 它是锦上添花。
      if (doneReason) {
        try {
          this.sessionTree.recordTurnFinish(runRootId, turnUserNodeId, {
            reason: doneReason,
            ms: doneMs || Date.now() - taskStartedAt,
            ...(turnUsage.rounds > 0 ? { usage: turnUsage } : {}),
            model: activeProfile(this.store.getSettings().agent).label
          })
        } catch {
          /* 收尾信息落盘失败不影响任务收尾 */
        }
      }
      // v1.6：任务收尾通知。跑到这一步的路径有三条（正常结束 / 异常 / 用户中止），
      // 都要给一份回执 —— 否则去别的窗口等的人永远不知道「已经结束了」。
      if (this.store.getSettings().notify.onTaskEnd) {
        const label =
          doneReason === 'completed'
            ? '任务完成'
            : doneReason === 'aborted'
              ? '任务已中止'
              : '任务结束（未确认完成）'
        this.notify(`eNSP 实验代理 · ${label}`, lastError ? firstLine(lastError) : firstLine(text))
      }
      // R3：任务结束时队列里还有输入，明确提示，不静默丢掉
      const remains = runtime.takePendingInput?.() ?? []
      this.active.delete(sessionId)
      if (remains.length > 0) {
        this.send(EVENT.agentEvent, {
          sessionId,
          event: {
            type: 'error',
            message: `以下输入在本轮任务结束后未执行：${remains.map((s) => `「${s}」`).join('、')}。可再次发送。`,
            recoverable: true
          } satisfies AgentEvent,
          runtime: kind
        })
      }
    }
  }

  /** 向正在运行的任务投递纠偏消息（仅运行时支持时有效） */
  enqueueInput(sessionId: string, text: string): boolean {
    const a = this.active.get(sessionId)
    if (!a || !a.runtime.enqueue) return false
    return a.runtime.enqueue(text)
  }

  abortAgent(sessionId: string): boolean {
    const a = this.active.get(sessionId)
    if (!a) return false
    a.controller.abort()
    return true
  }

  isAgentRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  resolveGate(sessionId: string, gateId: string, decision: GateDecision): boolean {
    const a = this.active.get(sessionId)
    if (!a) return false
    a.runtime.resolveGate(gateId, decision)
    return true
  }

  /**
   * v2.7：裁决一次结构化提问。
   * 传 null = 取消（界面关掉卡片）—— 运行时会让模型退回「按最合理假设继续」，
   * 而不是把整轮任务判失败。
   */
  resolveQuestion(sessionId: string, questionId: string, answers: QuestionAnswers | null): boolean {
    const a = this.active.get(sessionId)
    if (!a || !a.runtime.resolveQuestion) return false
    a.runtime.resolveQuestion(questionId, answers)
    return true
  }

  /** v2.7：读某会话的任务清单（界面在切入历史会话时恢复进度用） */
  todoList(rootId: string): TodoItem[] {
    return this.todos.get(rootId)
  }

  /** 不传 profileId 时查当前活跃档案（v1.5：密钥按档案分档） */
  hasApiKey(profileId?: string): boolean {
    return hasApiKey(profileId ?? activeProfile(this.store.getSettings().agent).id)
  }

  /** v1.5：已配置密钥的档案 id 列表（供设置页逐档标「已配置」，不回传密钥本身） */
  configuredProfileIds(): string[] {
    return listKeyedProfileIds()
  }

  /** 对已连接设备实采 LLDP 邻居，重推拓扑并持久化（IPC topology:refresh 用） */
  async refreshTopology(): Promise<Topology> {
    const t = await deriveTopology(probesFromSessions(this.sessions))
    this.topology.set(t)
    return t
  }

  // ———————————————————————— 通知（v1.6） ————————————————————————

  /**
   * 系统通知的统一口径：**只在窗口不在前台时弹**。
   *
   * 正在看应用的人不需要被自己眼前的进度再提醒一次；反过来，去别的窗口等结果的人
   * 才真正需要「跑完了」这个信号。提示音走 Notification.silent，不额外发声。
   */
  private notify(title: string, body: string): void {
    try {
      if (!Notification.isSupported()) return
      const win = this.getWindow()
      if (win && !win.isDestroyed() && win.isFocused()) return
      const n = new Notification({
        title,
        body,
        silent: this.store.getSettings().notify.sound === 'none'
      })
      n.on('click', () => {
        const w = this.getWindow()
        if (w && !w.isDestroyed()) {
          if (w.isMinimized()) w.restore()
          w.show()
          w.focus()
        }
      })
      n.show()
    } catch {
      /* 通知失败绝不能影响任务本身 */
    }
  }

  /**
   * 任务「启动段」失败回执（v1.8 补的洞）：
   * startAgent 的 async 启动段（active 检查 / 会话树落盘 / 运行时装配）一旦抛错，
   * 若调用方 fire-and-forget 会变成 unhandled rejection，且渲染层收不到任何事件、
   * agentRunning 卡死在 true。这里统一转成 error + done 收尾事件，让 UI 按同一路径自愈。
   */
  emitAgentFailure(sessionId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    const sendAgentEvent = (event: AgentEvent): void => {
      this.send(EVENT.agentEvent, { sessionId, event, runtime: 'react' })
    }
    sendAgentEvent({ type: 'error', message: `任务启动失败：${message}`, recoverable: false })
    sendAgentEvent({ type: 'done', reason: 'failed', ms: 0 })
  }

  private currentStoragePaths(): {
    userDataDir: string
    exportsDir: string
    attachmentsDir: string
    snapshotsDir: string
  } {
    return {
      userDataDir: this.userDataDir,
      exportsDir: this.exportsDir,
      attachmentsDir: this.attachmentsDir,
      snapshotsDir: this.snapshotsDir
    }
  }

  /** 设置 → 通用：数据占用分布 + 所在卷容量（支持独立自定义目录） */
  storageReport(): StorageReport {
    return measureStorage(this.currentStoragePaths())
  }

  /**
   * 清理自管数据。scope 白名单由 IPC 层把关，这里只负责「先量后清、再量一次」，
   * 回收量用前后差值算，不用估算。
   *
   * R17：删之前必须先证明目录确实归我们管。
   * **D4（2026-09-23）**：R17 原来的判据是「目标必须在 userData 之下」，但那是**过紧**的 ——
   * attachments / exports 都支持在设置里指到任意自定义目录（`resolveStorageDir` 会 resolve），
   * 于是「用了自定义附件目录」的用户清一次数据必然抛「拒绝操作数据目录之外的路径」，
   * 而且报的是安全告警式文案，会让人以为自己的设置违法。
   *
   * 现在的判据是**受管根白名单**（三者之一，或其子目录），并单独拒绝「数据根本身」与盘根：
   * 前者一清就把设置/技能/快照全带走，后者 `emptyDir('D:\\')` 会删掉整个盘。
   */
  clearData(scope: StorageScope): ClearResult {
    const paths = this.currentStoragePaths()
    // 校验放在 emptyDir 之前：不合法时在删除任何文件之前就退出（判据见 checkClearTarget）
    checkClearTarget(
      {
        userDataDir: paths.userDataDir,
        attachmentsDir: this.attachmentsDir,
        exportsDir: this.exportsDir
      },
      this.clearTargetDir(scope)
    )
    const before = measureStorage(paths).entries.find((e) => e.key === scope)
    let removedFiles = 0
    if (scope === 'sessions') {
      // 会话必须走 store 清：内存索引与缓存要跟着一起复位，否则「删了但列表还在」
      removedFiles = this.sessionTree.resetAll()
    } else if (scope === 'attachments') {
      removedFiles = emptyDir(this.attachments.root)
    } else {
      removedFiles = emptyDir(this.exportsDir)
    }
    const after = measureStorage(paths).entries.find((e) => e.key === scope)
    return {
      scope,
      removedFiles,
      freedBytes: Math.max(0, (before?.bytes ?? 0) - (after?.bytes ?? 0))
    }
  }

  /** 各清理范围实际要清空的目录（会话固定落在 userData/sessions 下） */
  private clearTargetDir(scope: StorageScope): string {
    if (scope === 'sessions') return path.join(this.userDataDir, 'sessions')
    if (scope === 'attachments') return this.attachments.root
    return this.exportsDir
  }

  /** 切换数据主目录并可选迁移现有数据 */
  async changeUserDataDir(
    targetDir: string,
    migrateData: boolean,
    onProgress?: MigrateProgressHandler
  ): Promise<{
    success: boolean
    needsRestart: boolean
    migratedFiles?: number
    migratedBytes?: number
    conflicts?: string[]
    failedFiles?: string[]
  }> {
    // R18：`path.resolve('')` 返回 cwd，永远不为假 → 原来的 `if (!resolved)` 是死代码。
    // 空串/非字符串/盘根/与当前相同，全部在这里带可读原因拒绝。
    const resolved = validateUserDataTarget(targetDir, this.userDataDir)
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true })
    }

    let stats: { files: number; bytes: number; conflicts: string[]; failed: string[] } = {
      files: 0,
      bytes: 0,
      conflicts: [],
      failed: []
    }
    if (migrateData) {
      // T4.4：异步分片迁移 + 进度回报（大目录不再冻住主进程）
      stats = await migrateDirectory(this.userDataDir, resolved, {
        ...(onProgress ? { onProgress } : {})
      })
    }

    writeBootstrapStorage({ userDataDir: resolved })
    this.updateSettings({
      storage: {
        ...this.store.getSettings().storage,
        userDataDir: resolved
      }
    })

    return {
      success: true,
      needsRestart: true,
      migratedFiles: stats.files,
      migratedBytes: stats.bytes,
      // 决策 D4=B：冲突不覆盖，但必须把清单交回界面（含失败项），否则用户以为迁全了
      ...(stats.conflicts.length ? { conflicts: stats.conflicts } : {}),
      ...(stats.failed.length ? { failedFiles: stats.failed } : {})
    }
  }

  /** 恢复默认数据主目录 */
  resetUserDataDir(): { success: boolean; needsRestart: boolean } {
    writeBootstrapStorage({ userDataDir: undefined })
    this.updateSettings({
      storage: {
        ...this.store.getSettings().storage,
        userDataDir: ''
      }
    })
    return {
      success: true,
      needsRestart: true
    }
  }

  /** 导出会话报告到 userData/exports（IPC session:export 与工具共用） */
  exportSessionReport(rootId: string, format: 'md' | 'json'): { path: string } {
    return collectSessionReport(this.sessionTree, this.exportsDir, rootId, format)
  }

  /**
   * F8（v2.12）：对比同一起点下的两条分支（按工具调用序列逐项 diff）。
   *
   * 预览与导出共用同一份 `markdown` —— 否则「界面看到的」和「导出的文件」会有两种口径。
   * `exportFile=false` 时只算不落盘（预览不该在磁盘上堆文件）。
   */
  compareSessionBranches(
    rootId: string,
    aNodeId: string,
    bNodeId: string,
    exportFile: boolean
  ): { comparison: BranchComparison; markdown: string; path: string | null } {
    const meta = this.sessionTree.list().find((m) => m.id === rootId)
    if (!meta) throw new Error(`会话不存在：${rootId}`)
    const nodes = this.sessionTree.getTree(rootId)
    const aHead = nodes.find((n) => n.id === aNodeId)
    const bHead = nodes.find((n) => n.id === bNodeId)
    if (!aHead) throw new Error(`分支 A 的起点不存在：${aNodeId}`)
    if (!bHead) throw new Error(`分支 B 的起点不存在：${bNodeId}`)
    const comparison = compareBranches(
      aHead,
      this.sessionTree.subtree(rootId, aNodeId),
      bHead,
      this.sessionTree.subtree(rootId, bNodeId),
      { a: branchLabelOf(aHead, '分支 A'), b: branchLabelOf(bHead, '分支 B') }
    )
    const markdown = renderComparisonMarkdown(comparison, meta.title)
    return {
      comparison,
      markdown,
      path: exportFile ? writeCompareReport(this.exportsDir, meta.title, markdown).path : null
    }
  }

  shutdown(): void {
    for (const a of this.active.values()) a.controller.abort()
    this.active.clear()
    this.sessions.closeAll()
    void this.mcpHandle?.close().catch(() => undefined)
    this.mcpHandle = null
    this.mcpRunning = false
    // 外部 MCP 连接（含 stdio 子进程）必须显式收掉，否则进程会挂在后台
    void this.mcpClients.closeAll().catch(() => undefined)
  }
}

/** 把附件清单拼到用户指令末尾（会话树/报告里可见，但不含正文预览） */
function withAttachmentNote(text: string, attachments: readonly Attachment[]): string {
  const note = attachmentNoteLine(attachments)
  return note ? `${text}\n\n${note}` : text
}

function safeJsonPeek(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s && s.length > 120 ? `${s.slice(0, 120)}…` : (s ?? '')
  } catch {
    return String(v)
  }
}

/** 通知正文只取首行 + 截断：系统通知的可读区域就那么大，塞多行反而看不到重点 */
function firstLine(text: string, max = 80): string {
  const line = (text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? ''
  const t = line.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}
