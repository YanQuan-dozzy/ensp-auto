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
import type { GoalArchivePayload } from '@shared/api'
import { EVENT } from '@shared/channels'
import { activeProfile } from '@shared/profiles'
import { createStores, storageDirs } from './services/stores'
import { builtinTools, createAgentDeps } from './services/agent-wiring'
import { GoalArchiveStore } from './goals/store'
import { attachmentNoteLine, type Attachment } from '@shared/attachments'
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
import { collectSessionReport } from './tools/sessions'
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

  /**
   * 三个受管目录（报告导出 / 附件归档 / 配置快照）。
   *
   * T5.2：解析口径统一到 `services/stores.ts` 的 `storageDirs` ——
   * 过去这三段 getter 与构造函数里的目录解析是两处独立实现，改一处忘一处就会
   * 「设置里改了、实际写到了别处」。
   */
  private get managedDirs(): { exportsDir: string; attachmentsDir: string; snapshotsDir: string } {
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
  private agentDeps(): AgentDeps {
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
      exportsDir: () => this.exportsDir
    })
  }

  createRuntime(): { runtime: AgentRuntime; kind: 'react' | 'mock' } {
    const settings = this.store.getSettings()
    // v1.5：密钥按档案分档 —— 取当前活跃档案自己的那把，而不是「第一把」
    const apiKey = getApiKey(activeProfile(settings.agent).id)
    const wantReact = settings.agent.runtime === 'react'
    if (wantReact && apiKey) {
      return {
        runtime: new ReactRuntime(this.agentDeps(), {
          apiKey,
          // v1.6：permission.confirmDanger 关掉时，危险工具不再弹闸门 —— 语义是「直接执行」
          // （与界面横幅一致），不是「一律拒绝」；跳过确认的事实会写进 tool_end 摘要。
          allowDangerousWithGate: settings.permission.confirmDanger
        }),
        kind: 'react'
      }
    }
    return { runtime: new MockRuntime(this.agentDeps()), kind: 'mock' }
  }

  /**
   * 启动一轮代理任务。
   * v0.4：会话树落盘 —— 无 rootId 则新建会话，有 startNodeId 则在该节点下「换路重走」；
   * 运行期把 user/assistant/tool 节点增量写入树，供回溯与报告使用。
   */
  async startAgent(
    sessionId: string,
    text: string,
    opts?: { rootId?: string | null; startNodeId?: string | null; attachments?: Attachment[] }
  ): Promise<void> {
    if (this.active.has(sessionId)) {
      throw new Error('该会话已有任务在运行')
    }
    // v1.5：附件只在这一轮生效；会话树里只留「清单」不落预览，避免历史把上下文越滚越大
    const attachments = opts?.attachments ?? []

    // —— 会话树：定位父节点并写好本次 user 节点 ——
    let history: SessionNode[] = []
    let tail: SessionNode
    if (opts?.rootId && opts?.startNodeId && this.sessionTree.getById(opts.startNodeId)) {
      history = this.sessionTree.pathTo(opts.rootId, opts.startNodeId)
      tail = this.sessionTree.append(opts.startNodeId, {
        id: `n-${randomUUID()}`,
        role: 'user',
        content: withAttachmentNote(text, attachments)
      })
    } else {
      const root = this.sessionTree.createRoot(text.slice(0, 60))
      tail = root
    }

    const controller = new AbortController()
    const { runtime, kind } = this.createRuntime()
    this.active.set(sessionId, { sessionId, controller, runtime })

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
    /** v1.6：通知文案要写「完成了 / 失败 / 中止」，所以得记住最后一个 done 的原因 */
    let doneReason: 'completed' | 'aborted' | 'failed' | null = null
    /** 本轮出现过的错误摘要（通知里带上，省得用户还得切回来才知道发生了什么） */
    let lastError: string | null = null

    const collect = (event: AgentEvent): void => {
      switch (event.type) {
        case 'text':
          pendingAssistant = (pendingAssistant ?? '') + event.delta
          return
        case 'tool_start':
          flushAssistant()
          pendingTools.set(event.callId, {
            callId: event.callId,
            name: event.name,
            args: event.args
          })
          return
        case 'tool_end': {
          const tc = pendingTools.get(event.callId)
          if (tc) {
            const node = this.sessionTree.append(tail.id, {
              id: `n-${randomUUID()}`,
              role: 'tool',
              content: `${tc.name}(${safeJsonPeek(tc.args)})`,
              ...(tc ? { toolCall: { ...tc, ok: event.ok, ms: event.ms } } : {})
            })
            tail = node
            pendingTools.delete(event.callId)
          }
          return
        }
        case 'gate_request':
          // v1.6：需要人工确认时提醒（此时窗口几乎一定不在前台，用户看不到弹窗）
          if (this.store.getSettings().notify.onGate) {
            this.notify('代理需要你确认', `${event.name} 等待批准：${firstLine(event.reason)}`)
          }
          return
        case 'error':
          lastError = event.message
          return
        case 'done':
          doneReason = event.reason
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
        attachments
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
        event: { type: 'done', reason: 'failed' } satisfies AgentEvent,
        runtime: kind
      })
    } finally {
      flushAssistant()
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
    sendAgentEvent({ type: 'done', reason: 'failed' })
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
