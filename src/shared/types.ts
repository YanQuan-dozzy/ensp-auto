/**
 * 主进程 / 渲染进程共享的类型定义。
 * 这个文件是两侧契约的唯一来源，改动必须同步检查两个 tsconfig 的 include。
 */

export type DeviceId = string // 形如 "127.0.0.1:2008"

export type ViewKind = 'user' | 'system' | 'interface' | 'vlan' | 'ospf' | 'acl' | 'other'

export type Encoding = 'utf8' | 'gbk'

/** 回显终止判定的强度：prompt = 命中提示符（强），quiet = 静默兜底（弱） */
export type Settled = 'prompt' | 'quiet'

/** 结构化错误码。代理据此做修正决策，而不是读自然语言 */
export type ErrorCode =
  // —— 设备侧错误 ——
  | 'UNRECOGNIZED'
  | 'INCOMPLETE'
  | 'AMBIGUOUS'
  | 'BAD_PARAM'
  | 'TOO_MANY_PARAMS'
  | 'INVALID_INPUT'
  | 'BUSY'
  | 'NO_PERMISSION'
  | 'FAILED'
  // —— 本层错误 ——
  | 'TIMEOUT'
  | 'ABORTED'
  | 'CLOSED'
  | 'NOT_CONNECTED'
  | 'DECODE'
  | 'TRUNCATED'
  // —— 策略层错误 ——
  | 'NOT_ALLOWED_IN_READ_MODE'
  | 'DANGER_COMMAND_BLOCKED'
  | 'GATE_REJECTED'
  | 'NO_SNAPSHOT'
  | 'EXPECTATION_UNMET'
  | 'UNKNOWN'

export interface Device {
  id: DeviceId
  port: number
  name: string
  connected: boolean
  model?: string
  vrpVersion?: string
  view?: ViewKind
  encoding: Encoding
  lastSeenAt: number
}

export interface PromptInfo {
  raw: string
  host: string
  suffix: string
  view: ViewKind
  uncommitted: boolean
}

export interface CommandResult {
  ok: boolean
  /** 清洗后的回显：已剥离 IAC / ANSI / 退格 / 命令回显行 / 尾部提示符 */
  clean: string
  /** 原始回显（仅剥离 IAC），供「查看原始回显」与排错 */
  raw: string
  /** 结束时的提示符原文，如 "[Core-SW1]" */
  prompt: string
  /** 由提示符推断的当前视图 */
  view: ViewKind
  /** 终止判定强度 */
  settled: Settled
  /** 是否停在 [Y/N] 之类的确认提示上（绝不被自动应答） */
  awaitingConfirm: boolean
  /** 确认提示原文 */
  confirmText?: string
  /** 设备报错原文 */
  error?: string
  errorCode?: ErrorCode
  /** 回显中是否含 Warning（不算失败） */
  hasWarning?: boolean
  /** 是否因超过 maxBytes 被截断 */
  truncated?: boolean
  /** 是否出现解码替换符，说明文本可能有损 */
  decodeIssues?: boolean
  /** 耗时（毫秒） */
  ms: number
}

// —— 工具层 ——

/** 配置变更后的期望校验条件 */
export type ExpectationMode = 'contains' | 'notContains' | 'regex'

export interface Expectation {
  /** 校验时执行的命令，如 display ospf peer */
  command: string
  /** 期望内容：contains 时是子串，regex 时是正则表达式 */
  expect: string
  mode: ExpectationMode
  /** 重试次数（含首次），默认 1；>1 时用于等待协议收敛类场景 */
  times?: number
}

export type RiskLevel = 'read' | 'write' | 'danger'
/** risk 描述对设备的侵入性；scope 区分改本地数据还是改设备 */
export type ToolScope = 'device' | 'local'

export interface ToolResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: ErrorCode | string; message: string; raw?: string }
  meta: { ms: number; deviceId?: string; settled?: Settled }
}

// —— Agent 层 ——

export interface RunInput {
  sessionId: string
  text: string
  signal: AbortSignal
  /** 祖先链（根在前，含本次回溯起始节点），用于跨 run 历史注入；缺省则从空白开始 */
  history?: SessionNode[]
}

export type AgentEvent =
  | { type: 'plan'; steps: string[] }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; callId: string; name: string; args: unknown; risk: RiskLevel }
  | {
      type: 'tool_end'
      callId: string
      ok: boolean
      ms: number
      summary: string
      raw?: string
      errorCode?: string
    }
  | { type: 'gate_request'; gateId: string; name: string; args: unknown; reason: string }
  | { type: 'gate_resolved'; gateId: string; decision: 'approve' | 'reject' }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'done'; reason: 'completed' | 'aborted' | 'failed' }

export type GateDecision = 'approve' | 'reject'

// —— 拓扑（v0.3，F-5.x）——

export type TopologyRole = 'router' | 'switch' | 'pc' | 'unknown'

export type TopologySource = 'file' | 'discovered' | 'manual'

export interface TopologyNode {
  /** 稳定 ID：设备节点用 deviceId（形如 127.0.0.1:2008），未知邻居用 neighbor:<name> */
  id: string
  name: string
  role: TopologyRole
  model?: string
  /** 关联到可连接的设备 ID；无则说明是纯展示节点（如 PC/未匹配到的邻居） */
  deviceId?: string
  x?: number
  y?: number
  /** 来源（手动补画节点在合并结果里标记为 manual，便于渲染层过滤重建手动集） */
  source?: TopologySource
}

export interface TopologyLink {
  id: string
  from: string
  to: string
  /** 端口标签，如 "GE0/0/1 ↔ GE0/0/2" */
  label?: string
  source: TopologySource
}

export interface Topology {
  nodes: TopologyNode[]
  links: TopologyLink[]
  updatedAt: number
}

// —— 会话树 ——

export interface SessionNode {
  id: string
  parentId: string | null
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCall?: {
    callId: string
    name: string
    args: unknown
    ok?: boolean
    ms?: number
  }
  createdAt: number
  /** 仅 root 节点携带：会话标题（首条用户消息截断） */
  title?: string
}

/** 会话（根节点）摘要，供列表展示与排序 */
export interface SessionNodeMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  nodeCount: number
}

// —— 设置 ——

export interface AgentSettings {
  runtime: 'react' | 'mock'
  /** LLM provider：deepseek/custom 走 OpenAI 兼容线，openai/anthropic/google 走官方原生 API */
  provider: 'deepseek' | 'openai' | 'anthropic' | 'google' | 'custom'
  baseUrl: string
  model: string
  maxRounds: number
  temperature: number
}

export interface PanelSettings {
  left: number
  right: number
  leftCollapsed: boolean
  rightCollapsed: boolean
}

/** v0.4：MCP 对外服务（Streamable HTTP，仅绑定 127.0.0.1） */
export interface McpSettings {
  enabled: boolean
  port: number
}

export interface Settings {
  theme: 'dark' | 'light'
  scanStart: number
  scanEnd: number
  deviceEncoding: 'auto' | Encoding
  terminalEchoAgentCommands: boolean
  agent: AgentSettings
  panels: PanelSettings
  mcp: McpSettings
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  scanStart: 2000,
  scanEnd: 2050,
  deviceEncoding: 'auto',
  terminalEchoAgentCommands: true,
  agent: {
    runtime: 'react',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    maxRounds: 12,
    temperature: 0.2
  },
  panels: { left: 240, right: 380, leftCollapsed: false, rightCollapsed: false },
  mcp: { enabled: false, port: 49150 }
}
