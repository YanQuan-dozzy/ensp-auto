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
import { DEFAULT_CONCURRENCY, type ConcurrencySettings } from './concurrency'
import { DEFAULT_REPEAT_GUARD, type RepeatGuardSettings } from './repeat-guard'
import { DEFAULT_TITLE_SETTINGS, type TitleSettings } from './session-title'
import type { QuestionAnswers, QuestionItem, TodoItem } from './interaction'
import type { TurnUsage } from './turn-usage'

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
  // —— 附件读取（v2.1）——
  // 与 BAD_PARAM 分开：参数错意味着「换个参数再试」，格式错意味着「这条路走不通」
  | 'NOT_TEXT'
  | 'PDF_ENCRYPTED'
  | 'PDF_NO_TEXT'
  | 'DOC_ENCRYPTED'
  | 'DOC_UNREADABLE'
  // v2.13：分页 offset 越界（已到末尾/翻过头）—— 与 BAD_PARAM 分开，模型据此停止翻页
  | 'OFFSET_OUT_OF_RANGE'
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

/**
 * 终端回放缓冲的一段（2026-09-25）。
 *
 * 为什么放这里：主进程 core（TerminalBuffer / DeviceSession）要产出它、
 * 渲染层要消费它，与 CommandResult 同层次，不属于纯 IPC 载荷。
 *
 * `data` 是 latin1 字符串：**每个 code unit 恰好一个原始字节**，
 * 渲染层 `Uint8Array.from(data, (c) => c.charCodeAt(0))` 无损还原后交给 xterm 解码。
 * 不要在传输层做文本解码 —— 终端显示必须是设备原始字节。
 */
export interface TerminalBufferSegment {
  data: string
  fromAgent: boolean
  /** 全局单调序号（从 1 开始）。渲染层用它与实时事件对齐、去重 */
  seq: number
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
  /**
   * v2.7：会话根 ID。任务清单按它分桶 —— 不能用 `sessionId`（恒为 `'main'`），
   * 否则切换历史会话时会看到上一段对话残留的清单，而模型会把别人的任务当成自己的。
   */
  rootId?: string
  /** v2.7：计划模式（只读探索 + 产出方案，用户批准后才允许写操作） */
  planMode?: boolean
}

export type AgentEvent =
  | { type: 'plan'; steps: string[] }
  | { type: 'text'; delta: string }
  /** v2.2：一段思考结束（模型 reasoning），界面渲染为可折叠的「思考」行，与正文分离 */
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_start'
      callId: string
      name: string
      args: unknown
      risk: RiskLevel
      /** v2.5：本次调用处于并行批次中（界面据此提示「这一批同时在跑」） */
      parallel?: boolean
    }
  | {
      type: 'tool_end'
      callId: string
      ok: boolean
      ms: number
      summary: string
      raw?: string
      errorCode?: string
      /**
       * v2.9：工具返回的结构化载荷（`ToolResult.data`）。
       *
       * 为什么值得往上抬：像 `diff_with_snapshot` 这类工具的结论是**结构化**的
       * （`{added[], removed[]}`），只渲染成一行 `summary` 就等于把「改了哪几行」
       * 这个最有价值的信息丢掉了 —— 用户要核对代理改了什么，只能去看原始回显自己找。
       * 体积上限由工具自己保证（只抬小对象，不抬整份配置正文）。
       */
      data?: unknown
      /**
       * H（v2.14）：**可回放**的卡片数据（`ToolSpec.presentationMeta` 的产物，纯函数）。
       *
       * 与 `data` 的区别说清：`data` 是「当次界面用」的（几乎每个结构化工具都有），
       * 而 `cardMeta` 会被**落进会话树节点**（`SessionNode.toolCall.cardMeta`），
       * 供回放/演示模式重画卡片 —— 所以它只由少数「卡片本身就是结论」的工具声明，
       * 且有体积上限（超限整块丢弃，见 `cardMetaOf`）。
       */
      cardMeta?: unknown
    }
  | { type: 'gate_request'; gateId: string; name: string; args: unknown; reason: string }
  | { type: 'gate_resolved'; gateId: string; decision: 'approve' | 'reject' }
  /** v1.7：临时性失败，已安排退避重试（界面必须看得见，否则「卡住 2 秒」会被当成死掉） */
  | { type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  /** v1.7：上下文压缩已执行（v2.6 起分「本地修剪」与「模型摘要」两种模式） */
  | {
      type: 'compact'
      /** trim = 本地修剪（只改内容）；summary = 模型摘要（按轮整段替换） */
      mode?: 'trim' | 'summary'
      shrunkMessages: number
      beforeChars: number
      afterChars: number
      detail: string
      /** summary 模式：生成的摘要原文（界面可折叠查看） */
      summary?: string
      /** 压缩前的真实/估算 prompt tokens 与窗口，用于向用户说明「压到了多少」 */
      promptTokens?: number
      contextWindow?: number
      rounds?: number
    }
  /**
   * v2.6：真实用量计量。每次成功的模型请求后下发一次 ——
   * 数字来自 provider 返回的 `usage`（经缓存分项补全），不是字符估算。
   */
  | {
      type: 'usage'
      promptTokens: number
      outputTokens: number
      contextWindow: number
      /** promptTokens / contextWindow */
      ratio: number
      /** true = 至少有过一次真实测量；false = 只有字符估算 */
      measured: boolean
    }
  /**
   * v2.7：结构化提问。运行时在此处**就地暂停**，等界面回传答案后继续 ——
   * 与 gate_request 同一套机制，区别是它收集的是内容而不是批准。
   * source: 'tool' = 模型调 ask_user_question；'plan' = 计划模式方案评审。
   */
  | {
      type: 'question_request'
      questionId: string
      questions: QuestionItem[]
      source: 'tool' | 'plan'
    }
  /** 提问已裁决（cancelled = 用户关掉/任务中止，agent 会退回假设继续） */
  | {
      type: 'question_resolved'
      questionId: string
      answers: QuestionAnswers
      cancelled?: boolean
      /** 与 request 一致：界面据此选择措辞，不必自己记状态 */
      source: 'tool' | 'plan'
    }
  /**
   * v2.7：任务清单整表更新（含本轮开始时的「恢复」下发，让用户重开会话也能看到当前进度）。
   * 事件带全量清单，界面直接替换即可，不需要自己合并。
   */
  | { type: 'todo_update'; todos: TodoItem[]; detail: string; ownerId: string }
  /**
   * v2.7：计划模式的方案评审已裁决。
   * 用三态而不是布尔：`revising`（带了修改意见继续规划）与 `stopped`（结束，不碰设备）
   * 都「未获批准」，但用户看到的话完全不同 —— 一个说「继续改」，一个说「到此为止」。
   */
  | {
      type: 'plan_reviewed'
      action: 'approved' | 'revising' | 'stopped'
      /** 本轮已消耗的轮数（批准时会被补回执行预算） */
      rounds: number
    }
  /**
   * v2.8：会话标题已更新（AI 生成，或兜底截断）。
   *
   * 为什么走事件而不是让渲染层改完再刷新列表：标题是**主进程生成、主进程落盘**的，
   * 渲染层拿到它时列表已经刷新过一次；这里再把标题捎带回来，界面可以直接就地更新那一行，
   * 不必等 `session:list-updated` 的整表广播（那个也会到，但存在时序差）。
   */
  | { type: 'title_updated'; rootId: string; title: string; source: 'auto' | 'user' }
  /**
   * v2.12：本轮任务绑定的会话根 ID。新建会话时渲染层此前无从得知 rootId
   * （标题事件只在开了自动命名时才发），消息删除/重新生成都依赖它定位会话树。
   * 由宿主（services）在 startAgent 定位到 runRootId 后立刻下发，每次 run 都发。
   */
  | { type: 'session_bound'; rootId: string }
  | { type: 'error'; message: string; recoverable: boolean }
  /** v2.2：任务收尾事件；ms 为本轮任务耗时（毫秒），界面据此渲染「完成 + 耗时」收尾卡 */
  | { type: 'done'; reason: 'completed' | 'aborted' | 'failed'; ms: number }

export type GateDecision = 'approve' | 'reject'

/** v2.7：一次提问的裁决结果（null 由运行时内部表示「取消」，跨进程用 cancelled 标记） */
export interface QuestionDecision {
  answers: QuestionAnswers
}

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

// —— 配置变更记录（F-4.5；F6 变更审计时间线的数据源，主进程与渲染层共用） ——

export type ChangeKind = 'apply' | 'restore' | 'save'

export type ChangeResult = 'ok' | 'failed' | 'rejected' | 'blocked'

export interface ChangeRecord {
  id: string
  deviceId: DeviceId
  at: number
  kind: ChangeKind
  /** v0.2 只有代理通道；用户手动操作通道预留 */
  actor: 'agent' | 'user'
  /** 本次变更依据的快照（apply 前自动采集 / restore 的目标快照） */
  snapshotId?: string
  description: string
  commands?: string[]
  expectation?: Expectation
  result: ChangeResult
  /** apply 流程里的期望校验结果 */
  verified?: boolean
  error?: { code: string; message: string }
}

// —— 分支对比（F8；主进程计算、渲染层展示，两端共用同一份类型） ——

export interface ToolStep {
  nodeId: string
  at: number
  name: string
  ok?: boolean
  ms?: number
  summary?: string
  errorCode?: string
  /** 参数签名（键排序后的稳定序列化，用于判断「是不是同一次调用」） */
  argKey: string
}

export interface BranchSide {
  /** 该侧的代表节点（通常是分支起点） */
  headId: string
  label: string
  steps: ToolStep[]
  tools: number
  failed: number
  totalMs: number
}

export type DiffKind = 'same' | 'onlyA' | 'onlyB'

export interface DiffRow {
  kind: DiffKind
  a?: ToolStep
  b?: ToolStep
}

export interface BranchComparison {
  a: BranchSide
  b: BranchSide
  rows: DiffRow[]
  /** 一句话结论（工具数 / 失败数 / 耗时的对比） */
  verdict: string
}

// —— 会话树 ——

export interface SessionNode {
  id: string
  parentId: string | null
  /** v2.2：thinking = 模型思考段（界面渲染为可折叠「思考」行，不注入模型上下文） */
  role: 'user' | 'assistant' | 'tool' | 'thinking'
  content: string
  toolCall?: {
    callId: string
    name: string
    args: unknown
    ok?: boolean
    ms?: number
    /**
     * v2.8：工具结果的一句话摘要（`summarizeToolCall` 的产物）。
     *
     * 为什么要落盘：断点续跑时 `historyToMessages` 只回放「工具名(参数) → 完成/失败」，
     * 模型据此**不知道那次调用到底看到了什么**（比如「接口 GE0/0/1 已 up」），
     * 于是续跑后可能把已经做对的事重做一遍。落摘要是最小代价的补全 ——
     * 不落原始回显（那会把会话树撑爆），只落人可读的结论行。
     */
    summary?: string
    /** v2.8：失败时的错误码（续跑时模型据此判断「这条路走不通」） */
    errorCode?: string
    /**
     * H（v2.14）：**可回放**的卡片数据（`ToolSpec.presentationMeta` 的产物）。
     *
     * 为什么要落盘：`tool_end.data` 是当次事件，回放时拿不到 —— 于是
     * `diff_with_snapshot` 的「改了哪几行」、`check_experiment` 的「哪几项没达成」
     * 在历史里只剩一行摘要。这里存一份**小体积**的副本（≤4000 字符，超限由
     * `cardMetaOf` 整块丢弃），供回放/演示模式还原卡片。
     */
    cardMeta?: unknown
  }
  createdAt: number
  /** 仅 root 节点携带：会话标题（首次为截断的首条用户消息，开启后由 AI 重写） */
  title?: string
  /**
   * F8（v2.12）：书签 —— 用户把某个节点标为「阶段完成点」。
   *
   * 与会话树同落盘（节点字段，靠整份重写表达增删），用于在长任务里标出里程碑、
   * 并作为「从书签继续 / 对比两条路线」的定位点。
   */
  bookmarked?: boolean
  /**
   * v2.8：会话收尾标记（仅 root 节点携带）。
   *
   * 值为**最后一次任务结束时尾部节点的 id**。存在即说明「上一轮任务走到了 done」；
   * 缺失则说明进程在任务中途被关掉/崩溃 → 该会话可续跑。
   * 用它而不是「树里最后一个节点是不是 assistant」来判断：任务可能以
   * 「达到最大轮次」或「失败」收尾，那些路径的尾部也不是 assistant，
   * 但它们同样已经收尾完毕，不该被反复提示续跑。
   */
  lastDoneNodeId?: string
  /**
   * v2.16：逐轮收尾信息（仅 root 节点携带），键 = 该轮指令的 user 节点 id。
   *
   * 为什么落盘：实时流的收尾卡（耗时 / 用量 / 模型）是渲染层从 `usage`/`done`
   * 事件现攒的，历史回放里没有这些事件 —— 不落盘历史就只剩一行光秃秃的
   * 「已完成」。键按轮的 user 节点（而不是树尾部节点）取：回溯/重走会产生
   * 新分支，按 user 节点找才能对上「这一轮指令的收尾」。
   */
  turnFinishes?: Record<string, TurnFinishRecord>
}

/** v2.16：一轮任务的收尾信息（与会话树同落盘；渲染层据此在历史里合成收尾卡） */
export interface TurnFinishRecord {
  reason: 'completed' | 'aborted' | 'failed'
  ms: number
  usage?: TurnUsage
  model?: string
}

/** 会话（根节点）摘要，供列表展示与排序 */
export interface SessionNodeMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  nodeCount: number
  /** v2.2：置顶（列表排序置顶优先） */
  pinned?: boolean
  /**
   * v2.8：标题来源。`user` = 用户手动重命名过 → 钉住，任何自动生成都不得覆盖。
   * `auto` = AI 生成（或兜底截断）；`undefined` 归一化为 `auto`。
   */
  titleSource?: 'user' | 'auto'
  /** v2.8：该会话是否有未收尾的任务（可断点续跑） */
  resumable?: boolean
  /**
   * v2.14：日志完整性。`damaged` = 该会话的 jsonl 里存在**非尾部截断**的坏行
   * （即坏行之后仍有合法节点），说明丢掉的节点不是「最后一行写了一半」，
   * 而是真的损坏了 —— 那几个节点不可恢复。
   *
   * 只作提示，**不阻断加载**：少几条消息也比整个会话打不开强。
   * 标记是粘性的（写盘只能把文件写干净，补不回已丢的节点），
   * 归一化见 session-tree/store.ts#parseTree。
   */
  integrity?: 'damaged'
  /**
   * v2.15：AI 是否已经**成功**给过标题（`isUsefulTitle` 通过的那次）。
   * 与 `titleSource` 的区别：兜底截断也把 titleSource 记为 `auto`，但那不是
   * AI 起的名 —— 只有 aiTitled 才能终结「后续成功收尾的轮次补起标题」的重试。
   * 归一化：缺字段视为 false（老会话视为还欠一个 AI 标题）。
   */
  aiTitled?: boolean
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
  /**
   * 上下文窗口（输入 token）。模型档案页里可逐档改。
   *
   * 为什么从「写死的 262144」改成逐档可配：不同模型窗口差一个数量级，
   * 而应用侧要用它做溢出判定与压缩预算 —— 用一个统一值必然出现
   * 「窗口大的模型被提前压缩」或「窗口小的模型撞溢出」。
   */
  contextWindow: number
  /** 单次回复的输出 token 上限（对应请求里的 max_tokens / max_completion_tokens） */
  maxOutputTokens: number
  maxRounds: number
  temperature: number
  /** 该档是否支持图片输入（决定请求里是否允许携带图片内容块） */
  supportsImage: boolean
  /** 思考模式：跟随模型默认 / 强制开启 / 关闭 */
  thinking: ThinkingMode
  /**
   * 思考强度（思考模式开启时下发的档位）。
   *
   * 与 thinking 分开的原因：一个是「开不开」，一个是「开多大」——
   * 合并成一个枚举会让「关掉思考」这件事没法保留用户上次选的强度。
   */
  reasoningEffort: ReasoningEffort
  /**
   * 更大上下文（Max）。开启时上下文窗口按 MAX_CONTEXT_WINDOW 计，
   * 但**保留** contextWindow 里用户填的基数 —— 关掉之后能回到原来的值。
   */
  maxContext: boolean
  /** Top P 采样；null = 留空，用服务商默认 */
  topP: number | null
  /** Top K 采样；null = 留空，用服务商默认 */
  topK: number | null
  /**
   * 是否启用。
   *
   * 关闭的档案不出现在输入框的模型切换器里，但配置与密钥都保留 ——
   * 与「删除」的区别正是「还想留着，只是暂时不用」。
   */
  enabled: boolean
}

/** 思考模式（模型档案级） */
export type ThinkingMode = 'auto' | 'on' | 'off'

/**
 * 思考强度档位。
 *
 * 取值集合对齐 pi-ai 的中立档位（ThinkingLevel），因为运行时是靠它把档位翻译成
 * 各家自己的字段：GLM / Kimi 用 low·high·max，豆包用 minimal·low·medium·high，
 * Gemini 用 thinking_level，Claude 用 output_config.effort。
 * 「某档模型支持哪几档」由 shared/model-thinking.ts 的能力表决定 —— 不在这里写死。
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max'

/** 全部档位（由低到高）；某一档模型支持哪几档由 shared/model-thinking.ts 决定 */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'max'
]

/** 「更大上下文（Max）」开启后生效的窗口（1M token） */
export const MAX_CONTEXT_WINDOW = 1000000

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
  centerCollapsed: boolean
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
  /**
   * F10（v2.12）：任务生命周期自动抓包。
   *
   * 开启后 `execute_task` / `batch_configure` 开始时会自动调用「已挂载的外部 MCP 抓包工具」，
   * 结束时停止，并把抓包结果附在任务结果里。默认 **false** —— 抓包会持续写盘、
   * 也可能拖慢设备交互，必须由用户显式打开；识别不到抓包工具时静默跳过，绝不影响实验。
   */
  autoCapture?: boolean
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
  /** 自定义拓扑工程目录（留空为默认搜索路径；Agent 查找拓扑与导入首选此目录；即时生效） */
  topologyDir: string
}

export const DEFAULT_STORAGE: StorageSettings = {
  userDataDir: '',
  exportsDir: '',
  attachmentsDir: '',
  snapshotsDir: '',
  topologyDir: ''
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
  /** v2.5：跨设备只读并发（同设备仍严格串行） */
  concurrency: ConcurrencySettings
  /** v2.14：重复工具调用防护（同一工具 + 同一参数连续重复时提醒模型换做法） */
  repeatGuard: RepeatGuardSettings
  /** v2.8：会话标题（AI 生成，默认关闭 —— 它多花一次请求） */
  title: TitleSettings
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
  /**
   * F12（v2.12）：绑定目录（实验/工程目录）。
   *
   * 空数组 = 全局技能（任何上下文都注入，与 v1.3 行为一致）；
   * 非空 = **只在当前上下文目录命中时才注入** —— 技能库变大以后，
   * 「全量注入每次请求」既浪费上下文又稀释注意力，按实验目录绑定是最直接的解法。
   * 落盘在 frontmatter 的 `scope` 键（`;` 分隔，见 skills/parse.ts）。
   */
  scope: string[]
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
  /** F12：绑定目录（空 = 全局技能） */
  scope: string[]
  updatedAt: number
}

/**
 * v2.9：预置档的默认上下文窗口。
 *
 * 原先是逐档 128k / 200k / 256k —— eNSP 实验一次要连着调几十次小工具
 * （连设备 → 配接口 → 起协议 → 验证 → 抓包），窗口不够就会在任务中途
 * 触发压缩甚至溢出。统一抬到 256k，给工具回显留出余量。
 */
export const PRESET_CONTEXT_WINDOW = 256000
/** v2.9：预置档的默认工具调用轮数（原 12 —— 小工具可多次调用，12 轮常常配不完一个实验） */
export const PRESET_MAX_ROUNDS = 200

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
    contextWindow: PRESET_CONTEXT_WINDOW,
    maxOutputTokens: 16000,
    maxRounds: PRESET_MAX_ROUNDS,
    temperature: 0.2,
    supportsImage: false,
    thinking: 'auto',
    reasoningEffort: 'high',
    maxContext: false,
    topP: null,
    topK: null,
    enabled: true
  },
  {
    id: 'p-zhipu-glm',
    label: '智谱 GLM-5.3',
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
    contextWindow: PRESET_CONTEXT_WINDOW,
    maxOutputTokens: 16000,
    maxRounds: PRESET_MAX_ROUNDS,
    temperature: 0.2,
    supportsImage: false,
    thinking: 'auto',
    reasoningEffort: 'high',
    maxContext: false,
    topP: null,
    topK: null,
    enabled: true
  },
  {
    id: 'p-qwen-max',
    label: '通义千问 Qwen3.7-Max',
    provider: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-max',
    contextWindow: PRESET_CONTEXT_WINDOW,
    maxOutputTokens: 32000,
    maxRounds: PRESET_MAX_ROUNDS,
    temperature: 0.2,
    supportsImage: false,
    thinking: 'auto',
    reasoningEffort: 'high',
    maxContext: false,
    topP: null,
    topK: null,
    enabled: true
  }
]

/** 模型档案数值的合法区间（设置页与主进程清洗共用，避免两处各写一套） */
export const PROFILE_BOUNDS = {
  contextWindow: { min: 1000, max: 2000000 },
  maxOutputTokens: { min: 256, max: 200000 },
  maxRounds: { min: 1, max: 400 },
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  topK: { min: 1, max: 100 }
} as const

/** 思考模式的中文标签（设置页与弹窗共用，避免文案漂移） */
export const THINKING_MODE_LABEL: Record<ThinkingMode, string> = {
  auto: '跟随模型默认配置',
  on: '开启',
  off: '关闭'
}

/** 思考强度的中文标签（模型切换器的浮层用它渲染档位按钮） */
export const REASONING_EFFORT_LABEL: Record<ReasoningEffort, string> = {
  minimal: '极简',
  low: '轻',
  medium: '中',
  high: '高',
  max: '最深'
}

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
  panels: { left: 240, right: 380, leftCollapsed: false, rightCollapsed: false, centerCollapsed: false },
  mcp: { enabled: false, port: 49150, servers: [], exposeToAgent: true },
  ensp: { exePath: '' },
  notify: { onTaskEnd: true, onGate: true, sound: 'default' },
  permission: { confirmDanger: true, externalToolConfirm: false },
  retry: DEFAULT_RETRY,
  compaction: DEFAULT_COMPACTION,
  concurrency: DEFAULT_CONCURRENCY,
  repeatGuard: DEFAULT_REPEAT_GUARD,
  title: DEFAULT_TITLE_SETTINGS,
  wireshark: { dir: '', cachedProbe: null, autoCapture: false },
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
