/**
 * 主进程 / 渲染进程共享的类型定义。
 * 这个文件是两侧契约的唯一来源，改动必须同步检查两个 tsconfig 的 include。
 */

import type { LlmProvider } from './providers'
import type { Attachment } from './attachments'
import type { Transport } from './transport'
import {
  DEFAULT_COMPACTION,
  DEFAULT_RETRY,
  type CompactionSettings,
  type RetrySettings
} from './runtime-policy'

export type DeviceId = string // telnet 形如 "127.0.0.1:2008"；ssh 形如 "ssh:host:port"

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
  | 'SNAPSHOT_INCOMPLETE'
  | 'NO_PENDING_PROMPT'
  | 'EXPECTATION_UNMET'
  | 'UNKNOWN'

export interface Device {
  id: DeviceId
  port: number
  name: string
  /** 连接协议；缺省为 telnet（可选字段，避免大面积断言改动） */
  transport?: Transport
  /** 指向加密存储的 SSH 连接条目（ssh 且「保存此连接」时写入） */
  sshCredentialId?: string
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
  /** v1.5：随本轮指令一起提交的附件（清单 + 文本预览注入模型，完整内容由 read_attachment 取） */
  attachments?: Attachment[]
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
  /** v1.7：临时性失败，已安排退避重试（界面必须看得见，否则「卡住 2 秒」会被当成死掉） */
  | { type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  /** v1.7：上下文压缩已执行（把老轮次的工具输出换成摘要，消息结构不变） */
  | { type: 'compact'; shrunkMessages: number; beforeChars: number; afterChars: number; detail: string }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'done'; reason: 'completed' | 'aborted' | 'failed' }

export type GateDecision = 'approve' | 'reject'

// —— 拓扑（v0.3，F-5.x）——

export type TopologyRole = 'router' | 'switch' | 'firewall' | 'wlan' | 'server' | 'cloud' | 'pc' | 'unknown'

export type TopologySource = 'file' | 'discovered' | 'manual'

export interface TopologyNode {
  /** 稳定 ID：设备节点用 deviceId（形如 127.0.0.1:2008），未知邻居用 neighbor:<name> */
  id: string
  name: string
  role: TopologyRole
  model?: string
  /** 关联到可连接的设备 ID；无则说明是纯展示节点（如 PC/未匹配到的邻居） */
  deviceId?: string
  /** 有序接口名数组（file 层从工程文件 slot/interface 解析，供详情面板展示） */
  interfaces?: string[]
  x?: number
  y?: number
  /** 来源（手动补画节点在合并结果里标记为 manual，便于渲染层过滤重建手动集） */
  source?: TopologySource
  /** 删除墓碑：合并时该节点被过滤（跨刷新、跨层持久生效） */
  deleted?: boolean
}

export interface TopologyLink {
  id: string
  from: string
  to: string
  /** 端口标签，如 "GE0/0/1 ↔ GE0/0/2" */
  label?: string
  source: TopologySource
  /** 删除墓碑：合并时该链路被过滤 */
  deleted?: boolean
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

/**
 * v1.5：模型档案（Model Profile）。
 *
 * 引入理由：以前「provider / baseUrl / model」是全局唯一的三件套，换模型就得覆盖，
 * 换回来还得重填；密钥也只有一把，换个服务商就得把上把擦掉。档案把「一套可用的模型配置」
 * 收成一个具名对象，并且**每档独立保管密钥**（见 main/settings/secrets.ts）。
 * 顶栏/输入框的模型切换器切的就是 activeProfileId。
 */
export interface ModelProfile {
  /** 形如 p-xxxxxxxx */
  id: string
  /** 用户可见名，如「DeepSeek V4.1 Flash」 */
  label: string
  /** LLM provider：国产平台与自定义端点走 OpenAI 兼容线，openai/anthropic/google 走官方原生 API */
  provider: LlmProvider
  baseUrl: string
  model: string
  maxRounds: number
  temperature: number
}

export interface AgentSettings {
  runtime: 'react' | 'mock'
  /** v1.5：可切换的模型档案（至少一档） */
  profiles: ModelProfile[]
  /** 当前生效档案的 id；无效时按 profiles[0] 兜底 */
  activeProfileId: string
  /** v1.5：用户自定义指令，追加在基础系统提示词之后（提示词增强的常驻部分） */
  systemPrompt: string
}

export interface PanelSettings {
  left: number
  right: number
  leftCollapsed: boolean
  rightCollapsed: boolean
}

/**
 * v1.5：外部 MCP 服务器（本应用作为**客户端**连出去）。
 *
 * v0.4 做的是「对外提供 MCP 服务」（别人连我们）；v1.5 补上反方向 ——
 * 用户把自己别的 MCP 服务器（文件系统、数据库、内部平台…）挂进来，
 * 其工具以 `mcp__<服务器名>__<工具名>` 注入内置代理。
 *
 * 安全口径：外部工具默认按 danger 处理（走人工闸门），用户对某个服务器显式
 * 勾选「信任」后才降为 write（免闸门，但仍不进只读白名单）。
 */
export interface McpServerConfig {
  /** 形如 m-xxxxxxxx */
  id: string
  name: string
  transport: 'http' | 'stdio'
  /** transport = http 时使用，如 http://127.0.0.1:3000/mcp */
  url: string
  /** transport = stdio 时使用 */
  command: string
  args: string[]
  enabled: boolean
  /** 信任该服务器：其工具跳过人工闸门 */
  trusted: boolean
}

export interface McpToolInfo {
  /** 原始工具名（不含命名空间） */
  name: string
  description: string
}

/** 单个外部 MCP 服务器的运行态（IPC mcp:servers 返回，UI 直读） */
export interface McpServerStatus {
  id: string
  name: string
  transport: 'http' | 'stdio'
  enabled: boolean
  trusted: boolean
  connected: boolean
  toolCount: number
  tools: McpToolInfo[]
  error: string | null
  /** 连接 + 列工具耗时 */
  latencyMs?: number
}

/** v0.4：MCP 对外服务（Streamable HTTP，仅绑定 127.0.0.1）；v1.5 追加客户端侧配置 */
export interface McpSettings {
  enabled: boolean
  port: number
  /** v1.5：外部 MCP 服务器列表 */
  servers: McpServerConfig[]
  /** v1.5：是否把外部服务器的工具注入内置代理（关闭则仅做连通性/工具浏览） */
  exposeToAgent: boolean
}

/**
 * v1.4：eNSP 客户端定位。
 *
 * 之前只能靠 ENSP_EXE_PATH 环境变量，而默认路径 E:\eNSP 写死在代码里 ——
 * 用户把 eNSP 装在别处就完全打不开拓扑。这里给出正式的设置出口，
 * 留空时由主进程按「环境变量 → 注册表 .topo 关联 → 常见安装路径」自动探测。
 */
export interface EnspSettings {
  /** eNSP_Client.exe 绝对路径；空串表示自动探测 */
  exePath: string
}

/** 单个 Wireshark CLI 工具的探测结果 */
export interface WiresharkToolHitPayload {
  tool: 'tshark' | 'capinfos' | 'mergecap' | 'editcap' | 'dumpcap' | 'text2pcap'
  requirement: 'required' | 'recommended' | 'optional'
  path: string | null
  purpose: string
}

/** 探测 + 组件可用性（IPC wireshark:probe 载荷，UI 直读） */
export interface WiresharkAvailabilityPayload {
  /** 组件（隔离 venv 里的 MCP 服务器）是否已装好 */
  installed: boolean
  /** 装好了 且 tshark 在 —— 只有这时才能真正分析 */
  usable: boolean
  /** 是否已挂成外部 MCP 服务器 */
  attached: boolean
  /** tshark 探测结果 */
  probe: {
    ready: boolean
    canAnalyze: boolean
    canCapture: boolean
    tools: WiresharkToolHitPayload[]
    suiteDir: string | null
    source: 'setting' | 'env' | 'registry' | 'common' | 'none'
    version: string | null
    missing: string[]
  }
  /** 不可用原因（中文，可直接展示）；可用时为 null */
  reason: string | null
  /** tshark 所在目录，供 UI 显示 */
  tsharkDir: string | null
}

/**
 * v1.9：Wireshark 抓包分析。
 *
 * 只存「用户显式指定的安装目录」这一个字段 —— 分析组件本身（隔离 venv 里的
 * wireshark-mcp）装在哪由主进程按 userData 推导，不进设置项：那是实现细节，
 * 写进设置反而多一处能改坏的地方。
 * cachedProbe 保存最近一次探测结果，避免每次切换或打开面板都重新运行进程探测。
 */
export interface WiresharkSettings {
  /** Wireshark 安装目录（含 tshark.exe）；空串表示自动探测 */
  dir: string
  /** 上次探测的结果（持久化缓存，避免每次切换重复探测） */
  cachedProbe?: WiresharkAvailabilityPayload | null
}

/**
 * v1.6：系统通知偏好。
 *
 * 起因：代理一轮任务可能跑几分钟，用户在别的窗口里等 —— 跑完了却没有任何反馈，
 * 只能反复切回来瞄一眼。通知的默认口径是「只在窗口不在前台时弹」，
 * 正在看应用的人不需要被自己眼前的进度再提醒一次。
 */
export interface NotifySettings {
  /** 一轮任务结束（完成/失败/中止）时发系统通知 */
  onTaskEnd: boolean
  /** 代理需要人工确认（危险操作闸门）时提醒 */
  onGate: boolean
  /** 提示音：none = 静音，default = 系统默认提示音 */
  sound: 'none' | 'default'
}

/**
 * v1.6：权限与审批。
 *
 * 这两个开关是本应用安全模型的「松紧螺丝」，所以每一项都必须由用户显式选择，
 * 并在界面上写清后果 —— 用户看不懂后果的开关等于没有开关。
 * - confirmDanger：危险工具（重启设备、清空配置、恢复出厂…）默认一律拦在人工闸门之前；
 * - externalToolConfirm：外部 MCP 工具默认按 danger 处理（逐台「信任」后降为 write），
 *   这个开关是给「一台都不想信任」的用户准备的兜底 —— 打开后信任也失效。
 */
export interface PermissionSettings {
  /** 危险操作需要人工确认。关闭 = 危险工具直接执行（界面上必须明说不可撤销） */
  confirmDanger: boolean
  /** 外部 MCP 工具一律人工确认：开启后即使某台服务器已被「信任」也回到确认 */
  externalToolConfirm: boolean
}

export interface StorageSettings {
  /** 自定义数据主目录（若与当前不同，切换后需重启生效；留空为默认 AppData 路径） */
  userDataDir: string
  /** 自定义报告导出目录（留空则默认使用 userDataDir/exports；即时生效） */
  exportsDir: string
  /** 自定义附件归档目录（留空则默认使用 userDataDir/attachments；即时生效） */
  attachmentsDir: string
  /** 自定义配置快照目录（留空则默认使用 userDataDir/snapshots-data；即时生效） */
  snapshotsDir: string
}

export const DEFAULT_STORAGE: StorageSettings = {
  userDataDir: '',
  exportsDir: '',
  attachmentsDir: '',
  snapshotsDir: ''
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
  ensp: EnspSettings
  /** v1.6：系统通知偏好 */
  notify: NotifySettings
  /** v1.6：权限与审批 */
  permission: PermissionSettings
  /** v1.7：请求失败重试 */
  retry: RetrySettings
  /** v1.7：上下文压缩 */
  compaction: CompactionSettings
  /** v1.9：Wireshark 抓包分析接入 */
  wireshark: WiresharkSettings
  /** 存储目录自定义设置（数据主目录、报告导出、附件归档、配置快照） */
  storage: StorageSettings
  /** 用户自定义快捷键映射：id -> 按键名数组，如 { 'app:settings': ['Ctrl', ','] } */
  shortcuts?: Record<string, string[]>
}

// —— 技能（v1.3，Skill 模块）——

/**
 * 技能（Skill）：一段给 AI 代理的指令性 Markdown 内容（参考 Claude Code / Trae 的
 * SKILL.md 约定），支持前导 `---` frontmatter（name / description）。用户可导入、
 * 修改、启用/停用；启用的技能会被注入代理 system prompt。
 */
export interface Skill {
  id: string
  name: string
  description: string
  /** 完整 Markdown 内容（含 frontmatter 原文，可编辑） */
  content: string
  enabled: boolean
  /** 内置技能（首次启动预置），无特殊权限，可删除 */
  builtin: boolean
  createdAt: number
  updatedAt: number
}

/** 列表视图：不含 content（避免大数据量整包传输渲染层） */
export interface SkillSummary {
  id: string
  name: string
  description: string
  enabled: boolean
  builtin: boolean
  updatedAt: number
}

/**
 * v1.5：预置模型档案。
 *
 * 只留三档真正开箱可用的（DeepSeek 为默认，与 v1.4 的默认行为一致），
 * 其余留给用户在设置里自己加 —— 预置太多反而让人不知道选哪个。
 */
export const DEFAULT_PROFILES: ModelProfile[] = [
  {
    id: 'p-deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    maxRounds: 12,
    temperature: 0.2
  },
  {
    id: 'p-zhipu-glm',
    label: '智谱 GLM-5.3',
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
    maxRounds: 12,
    temperature: 0.2
  },
  {
    id: 'p-qwen-max',
    label: '通义千问 Qwen3.7-Max',
    provider: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-max',
    maxRounds: 12,
    temperature: 0.2
  }
]

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  scanStart: 2000,
  scanEnd: 2050,
  deviceEncoding: 'auto',
  terminalEchoAgentCommands: true,
  agent: {
    runtime: 'react',
    profiles: DEFAULT_PROFILES,
    activeProfileId: DEFAULT_PROFILES[0]!.id,
    systemPrompt: ''
  },
  panels: { left: 240, right: 380, leftCollapsed: false, rightCollapsed: false },
  mcp: { enabled: false, port: 49150, servers: [], exposeToAgent: true },
  ensp: { exePath: '' },
  notify: { onTaskEnd: true, onGate: true, sound: 'default' },
  permission: { confirmDanger: true, externalToolConfirm: false },
  retry: DEFAULT_RETRY,
  compaction: DEFAULT_COMPACTION,
  wireshark: { dir: '', cachedProbe: null },
  storage: DEFAULT_STORAGE,
  shortcuts: {}
}

// —— 环境体检（v1.4） ——

/**
 * 体检项的结论等级。
 * skipped 用于「前置条件不满足，无法检测」——例如没配密钥就不去探模型端点，
 * 这与 fail（检测了且失败）是两回事，UI 不能混为一谈。
 */
export type DiagLevel = 'ok' | 'warn' | 'fail' | 'skipped'

export type DiagId = 'llm-endpoint' | 'api-key' | 'ensp-client' | 'mcp-port' | 'data-dir'

export interface DiagCheck {
  id: DiagId
  /** 面板显示名 */
  label: string
  level: DiagLevel
  /** 一句话结论（如「通过 412ms」「密钥无效（401）」） */
  detail: string
  /** 失败/警告时的修复建议 */
  hint?: string
  /** 需要用户决策的检查项给出动作提示，具体怎么调由渲染层决定 */
  action?: 'pick-ensp'
  /** 耗时毫秒，仅网络探活类检查有 */
  ms?: number
}

export interface DiagReport {
  ranAt: number
  checks: DiagCheck[]
}

/** eNSP 候选来源，用于向用户解释「我是从哪儿找到的」 */
export type EnspSource = 'setting' | 'env' | 'registry' | 'common' | 'none'

/** 来源的中文说明：主进程写进体检结论、渲染层写进设置项状态，两处共用避免文案漂移 */
export const ENSP_SOURCE_LABEL: Record<EnspSource, string> = {
  setting: '设置指定',
  env: '环境变量 ENSP_EXE_PATH',
  registry: '.topo 文件关联',
  common: '常见安装路径',
  none: ''
}

export interface EnspCandidate {
  path: string
  source: EnspSource
  exists: boolean
}

export interface EnspLocatePayload {
  found: string | null
  source: EnspSource
  candidates: EnspCandidate[]
}
