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
import type { ConnectAllProgress, GateView, MainTab, UiMessage } from './storeUtil'

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
  agentRunning: boolean
  agentRuntime: 'react' | 'mock'
  gate: GateView | null
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
  disconnect: (deviceId: DeviceId) => Promise<void>
  rename: (deviceId: DeviceId, name: string) => Promise<void>
  /** 右键删除设备：断开连接 + 从列表移除（下次扫描仍可重新发现） */
  forgetDevice: (deviceId: DeviceId) => Promise<void>

  refreshTopology: () => Promise<void>
  saveManualTopology: (input: { nodes: TopologyNode[]; links: TopologyLink[] }) => Promise<void>
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

  setActiveDevice: (deviceId: DeviceId | null) => void
  setTab: (tab: MainTab) => void

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
  abort: () => void
  resolveGate: (decision: GateDecision) => Promise<void>
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