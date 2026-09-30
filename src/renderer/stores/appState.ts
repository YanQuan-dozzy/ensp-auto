/**
 * 渲染层全局 store 的状态形状（T5.8 拆分后由 app.ts 装配各 slice）。
 * 只放接口不放实现 —— 实现按域拆到 slices.*（deviceActions / agentActions / dataActions）。
 */
import type {
  AgentEvent,
  Device,
  DeviceId,
  GateDecision,
  McpServerStatus,
  SessionNode,
  SessionNodeMeta,
  Settings,
  SkillSummary,
  Topology,
  TopologyLink,
  TopologyNode
} from '@shared/types'
import type {
  AgentEventPayload,
  ScanProgress,
  SkillImportPayload,
  SshConnectInput,
  TerminalClosedPayload,
  TopoFindPayload,
  TopoImportPayload
} from '@shared/api'
import type { Attachment } from '@shared/attachments'
import type { ConnectAllProgress, GateView, MainTab, QuestionView, TopoLoadProgress, UiMessage } from './storeUtil'
import type { QuestionAnswers, TodoItem } from '@shared/interaction'

export interface AppState {
  ready: boolean
  /** v1.0 前置：启动失败时不白屏，把错误亮给用户 */
  startupError: string | null
  settings: Settings
  /** 当前活跃档案是否已配置密钥 */
  hasApiKey: boolean
  /** v1.5：已配置密钥的档案 id（逐档标「已配置」，密钥本身不出主进程） */
  configuredProfileIds: string[]

  devices: Device[]
  scanning: boolean
  scanProgress: ScanProgress | null
  scanError: string | null
  /** 一键连接进度（null 表示当前没有批量连接在跑） */
  connectAllProgress: ConnectAllProgress | null

  activeDeviceId: DeviceId | null
  activeTab: MainTab

  messages: UiMessage[]
  /**
   * R3（PERF-MEM-REVIEW-2026-09-29 §三）：**正在流式输出的那条** assistant 正文。
   *
   * 为什么它不在 `messages` 里：
   * ① `messages` 每来一个 delta 就换引用，于是 `AgentPanel` 的渲染管线
   *    （`dropEmptyMessages` → `hoistTrailingThinking` → `groupMessages` → `splitTurns`）
   *    每个 token 重跑一遍 —— 200 条消息的会话就是每 token 4 趟 O(n) 遍历
   *    + 约 200 个对象/数组分配，50 token/s 即 4 万次遍历/秒；
   * ② 更要命的是 `messages` 一换引用，历史轮的 `FinalResponseView` 虽然靠
   *    memo 跳过了 React 工作，可 `MarkdownView` 的 `text` 正是这条正在增长的
   *    字符串 —— `react-markdown` 对一篇持续变长的文档**全量重新解析**，
   *    成本 O(len²)（R1）。
   *
   * 提成独立字段后，`messages` 在**整段流式输出期间保持同一引用** ⇒ 上面的
   * 四趟遍历全被 useMemo 命中、`MarkdownView` 的 memo 也自然命中。
   * 段落被「收束」（下一个非 text 事件 / `done`）时才并进 `messages`。
   */
  streamingText: string | null
  agentRunning: boolean
  agentRuntime: 'react' | 'mock'
  gate: GateView | null
  /**
   * v2.7：待回答的结构化提问（模型提问 / 计划模式方案评审）。
   * 与 gate 同级别：都是「任务正在等用户」的状态，同一时刻只可能有一个。
   */
  question: QuestionView | null
  /** v2.7：当前会话的任务清单（界面上常驻展示进度） */
  agentTodos: TodoItem[]
  /** v2.7：计划模式开关（下一条指令以「只探索、出方案」的方式执行） */
  planMode: boolean
  /**
   * v2.11：引用待插入输入框的文本（引用消息气泡的 hover 操作条写入）。
   *
   * 为什么走 store 而不是回调：`MessageView` 是 `React.memo` 的，往它的 props 里
   * 塞一个「引用」回调会让**每一条**历史消息的回调都变引用 → 整个消息流失去 memo 优化。
   * 走 store 则只有 AgentPanel 顶层订阅一次，消息组件完全不用知道这件事。
   * 消费端（AgentPanel）读走之后**必须清空**，否则会重复插入。
   */
  quoteDraft: string | null
  queueHint: number
  /**
   * 快捷键录制中（R24）。
   *
   * 为什么必须放到 store：录制监听与 App 的全局监听都是 window 捕获阶段的，
   * 而 App 的监听先注册、先执行 —— 面板里的 stopPropagation 拦不住它，
   * 于是录制时按 Esc 会顺手把设置弹窗关掉、按 Ctrl+, 会再开一个弹窗。
   * App 侧只能靠这个共享标志早退。
   */
  shortcutRecording: boolean

  /** v0.4：会话树 */
  sessions: SessionNodeMeta[]
  activeRootId: string | null
  /** 回溯起始节点（非 null 时下一轮 run 从该节点继续） */
  activeStartNodeId: string | null
  queueCount: number
  /**
   * v2.8：可续跑会话（上次任务未收尾）。null = 还没查过；[] = 查过但无可续跑。
   * 与 sessions 分开：这个是「启动时的一次性提示」，用户点了「忽略」或「继续」后就清掉。
   */
  resumable: SessionNodeMeta[] | null
  /** v0.4：MCP 服务运行态（对外提供服务） */
  mcpStatus: { running: boolean; url: string; error: string | null }
  /** v1.5：输入框待发送附件（导入即归档到主进程附件目录） */
  attachments: Attachment[]
  /** v1.5：一键增强提示词进行中 */
  enhancing: boolean
  /** v1.5：外部 MCP 服务器状态（本应用作为客户端） */
  mcpServers: McpServerStatus[]
  /** v1.5：MCP 连接操作进行中 */
  mcpBusy: boolean

  terminalQueueHint: number
  connectedIds: string[]

  topology: Topology
  topologyRefreshing: boolean
  /**
   * 拓扑导入/加载进度（v2.29）：大工程导入时画布要跑布局 + 走线，几十毫秒到几百毫秒
   * 的同步计算会让界面「僵住」，用户会以为卡死。null = 当前没有加载在跑。
   */
  topoLoading: TopoLoadProgress | null
  /** F11 回放：高亮当前步骤操作的设备；null = 不高亮 */
  topoHighlightDeviceId: string | null

  /** v1.3：技能列表（不含内容，编辑时按需 get） */
  skills: SkillSummary[]

  init: () => Promise<void>
  refreshDevices: () => Promise<void>
  scan: () => Promise<void>
  connect: (port: number) => Promise<void>
  /** v2.0：SSH 连接（已存凭据或直接填主机与认证） */
  connectSsh: (input: SshConnectInput) => Promise<void>
  /** v一键连接：批量连接所有已发现但未连接的 telnet 设备（SSH 设备需凭据，不批量） */
  connectAll: () => Promise<void>
  /** v2.21：清空扫描 / 单设备连接的错误提示（提示条点击别处即消失） */
  clearScanError: () => void
  disconnect: (deviceId: DeviceId) => Promise<void>
  rename: (deviceId: DeviceId, name: string) => Promise<void>
  /** 右键删除设备：断开连接 + 从列表移除（下次扫描仍可重新发现） */
  forgetDevice: (deviceId: DeviceId) => Promise<void>

  clearTopology: () => Promise<void>
  refreshTopology: () => Promise<void>
  /** v2.29：写入/推进拓扑加载进度（null = 收尾，进度条消失） */
  setTopoLoading: (p: TopoLoadProgress | null) => void
  saveManualTopology: (input: { nodes: TopologyNode[]; links: TopologyLink[] }) => Promise<void>
  /**
   * v2.31：把全部设备坐标恢复成 eNSP 工程里的原始摆布（`srcX`/`srcY`）。
   *
   * 为什么需要：手动层（`source: 'manual'`）一旦被自适应布局/拖动写过坐标，就会**永久覆盖**
   * 工程文件里的摆放 —— 关掉「导入后自动重排」开关只防新的覆盖，防不了已经写进磁盘的旧坐标。
   * 于是历史上被重排过的工程，重新导入看到的仍是算法布局，用户会以为「开关没生效」。
   * 这个动作把手动层里的坐标改回源坐标（等价于撤销坐标覆盖），让画布回到工程原样。
   */
  restoreSourceLayout: () => Promise<void>
  /** v0.6 F-5.6：删除节点/链路（主进程打墓碑，跨刷新持久生效） */
  removeTopology: (input: { nodeIds?: string[]; linkKeys?: string[] }) => Promise<void>
  /** v1.0 前置：弹窗选择 .topo 导入（F-5.2）；返回 null 表示用户取消或失败 */
  importTopology: () => Promise<TopoImportPayload | null>
  /** v1.2：发现本机 .topo（桌面/文档/下载或指定目录）；失败返回 null */
  discoverTopoFiles: (directory?: string) => Promise<TopoFindPayload | null>
  /** v1.2：按路径导入 .topo（校验由主进程做）；失败返回 null */
  importTopoPath: (filePath: string) => Promise<TopoImportPayload | null>
  /** v1.3：技能管理 */
  loadSkills: () => Promise<void>
  saveSkill: (input: {
    id?: string
    name?: string
    description?: string
    content: string
    /** F12：绑定目录；缺省 = 不改动现有绑定，空数组 = 全局技能 */
    scope?: string[]
  }) => Promise<{ id: string } | null>
  removeSkill: (id: string) => Promise<boolean>
  toggleSkill: (id: string, enabled: boolean) => Promise<void>
  importSkillFiles: () => Promise<SkillImportPayload | null>
  importSkillDir: () => Promise<SkillImportPayload | null>
  importSkillPath: (filePath: string) => Promise<SkillImportPayload | null>
  retryStartup: () => void

  loadSessions: () => Promise<void>
  newSession: () => void
  /** 从历史节点「换路重走」：载入该会话视图并设置回溯起点 */
  continueFrom: (rootId: string, node: SessionNode) => Promise<void>
  /** v2.2：进入旧会话 —— 载入完整消息流，后续发送追加到该会话尾部 */
  openSession: (rootId: string) => Promise<void>
  /** v2.2：删除会话（删的是当前活跃会话时同步清空视图） */
  deleteSession: (rootId: string) => Promise<void>
  /** v2.2：重命名会话标题 */
  renameSession: (rootId: string, title: string) => Promise<void>
  /** v2.2：置顶 / 取消置顶会话 */
  togglePinSession: (rootId: string) => Promise<void>
  /** v2.2：在资源管理器打开该会话的数据文件 */
  openSessionFile: (rootId: string) => Promise<void>
  /** v2.2：打开会话数据目录 */
  openSessionsDir: () => Promise<void>
  /** v2.8：查一次可续跑会话（启动时调） */
  loadResumable: () => Promise<void>
  /** v2.8：继续上次未完成的任务（进入该会话并重发上一次的指令） */
  resumeSession: (rootId: string) => Promise<void>
  /** v2.8：忽略续跑提示（不删会话，只是这次不续跑） */
  dismissResume: () => void
  /**
   * v2.12：删除一条消息（及其后整条分支）。
   * 需要会话树定位（activeRootId + 树节点映射）；执行中不可用。
   */
  deleteMessage: (msgId: string) => Promise<void>
  /**
   * v2.12：从产生这条回答的用户指令起重跑（重新生成）。
   * 对 assistant 回答：回到它的 user 指令，截断旧回答分支后用原指令重新执行。
   * 对 user 指令：直接截断该指令及其后所有内容并重发。
   */
  regenerateMessage: (msgId: string) => Promise<void>

  setActiveDevice: (deviceId: DeviceId | null) => void
  setTab: (tab: MainTab) => void
  /** F11 回放：高亮当前步骤操作的设备（null = 不高亮） */
  setTopoHighlight: (deviceId: string | null) => void

  send: (text: string) => Promise<void>
  /** v1.5：附件导入（弹框 / 按路径）与移除；导入后由主进程复制归档 */
  pickAttachments: () => Promise<void>
  importAttachmentPaths: (paths: string[]) => Promise<void>
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  /** v1.5：切换活跃模型档案（写 settings.agent.activeProfileId） */
  setActiveProfile: (profileId: string) => Promise<void>
  /** 快捷键录制开关（录制期间 App 的全局快捷键监听必须早退，见 R24） */
  setShortcutRecording: (recording: boolean) => void
  /** 往消息流写一条系统提示（失败反馈与未处理异常的兜底出口） */
  noteSystemMessage: (text: string, tone?: 'info' | 'error') => void
  /** v1.5：一键增强提示词；失败写入消息流并返回 null */
  enhanceDraft: (draft: string) => Promise<string | null>
  /** v1.5：外部 MCP 服务器 */
  loadMcpServers: () => Promise<void>
  syncMcpServers: () => Promise<void>
  testMcpServer: (id: string) => Promise<McpServerStatus | null>
  /** v2.21：收起某台服务器的「上次连接失败」结论（提示条点击别处即消失） */
  clearMcpServerError: (id: string) => void
  abort: () => void
  resolveGate: (decision: GateDecision) => Promise<void>
  /** v2.7：回答一次结构化提问；answers 传 null = 取消（模型会退回按最合理假设继续） */
  answerQuestion: (answers: QuestionAnswers | null) => Promise<void>
  /** v2.7：计划模式开关 */
  setPlanMode: (on: boolean) => void
  /** v2.11：把一条消息的正文引用到输入框（气泡 hover 操作条用） */
  quoteIntoInput: (text: string) => void
  /** v2.11：引用已被输入框消费，清空待插入文本 */
  clearQuoteDraft: () => void
  clearConversation: () => void

  setTheme: (theme: 'dark' | 'light') => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  /** v1.5：密钥按档案分档；key 传空串 = 清除该档密钥 */
  setProfileKey: (profileId: string, key: string) => Promise<void>

  applyAgentEvent: (p: AgentEventPayload) => void
  markTerminalClosed: (p: TerminalClosedPayload) => void
  bumpTerminalQueue: (n: number) => void
  setConnectedIds: (ids: string[]) => void
}

/** zustand 的 (set, get) 参数形状（slice 与 create 回调共用） */
export type SliceSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void
export type SliceGet = () => AppState

// 供类型导出兼容的历史名（外部从 @/stores/app 引用的类型）
export type { AgentEvent }