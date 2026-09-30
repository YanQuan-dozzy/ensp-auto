import { Type, type TSchema } from '@earendil-works/pi-ai'
import type { RiskLevel, Settings, ToolResult, ToolScope } from '@shared/types'
import type { QuestionAnswers, QuestionItem } from '@shared/interaction'
import type { SshCredentialMeta } from '@shared/api'
import type { SessionManager } from '../core/session/SessionManager'
import type { TodoStore } from '../core/todo/store'
import type { SnapshotStore } from '../core/store/snapshots'
import type { ChangeStore } from '../core/store/changes'
import type { TopologyStore } from '../core/topology/store'
import type { SessionTreeStore } from '../core/session-tree/store'
import type { AttachmentStore } from '../core/attachments/store'

/**
 * Tool Registry —— 工具定义的单一真相源。
 *
 * 一份 schema 双出口：
 *   toLLMTools()  → 进程内自研 Agent（pi-ai 的 function calling，TypeBox schema）
 *   toMcpTools()  → 对外 MCP 服务（v0.4，TypeBox 对象本身即 JSON Schema）
 *
 * schema 用 TypeBox（由 @earendil-works/pi-ai 反出，不额外引依赖）：
 * 与 JSON Schema 同构，可同时喂给 LLM 与 MCP，且得到静态类型推导。
 *
 * ⚠️ 新增工具时 schema 的**根必须是 `Type.Object`** —— 根为 `Type.Union` 时
 * 生成的 `{anyOf:[...]}` 没有 type 字段，会让整轮 LLM 请求被 400 拒绝（见
 * normalizeToolSchema 的说明与 tools/tasks.ts 的 execute_task 注释）。
 *
 * v1.5：外部 MCP 工具（mcp__<server>__<tool>）在运行期动态并入同一张表，
 * 由 core/mcp/tools.ts 转换 —— 对外 MCP 服务只暴露内置工具，不外露外部工具（避免自环）。
 */

export interface ToolContext {
  sessions: SessionManager
  settings: Settings
  snapshots: SnapshotStore
  /** v0.2：配置变更记录（F-4.5） */
  changes: ChangeStore
  /** v0.3：拓扑（F-5.5 拓扑数据喂给代理） */
  topology: TopologyStore
  /** v0.4：会话树（F-6.2，报告导出的数据源） */
  sessionTree: SessionTreeStore
  /** v0.4：报告导出目录（userData/exports） */
  exportsDir: string
  /** v1.5：附件归档（read_attachment 的沙箱边界） */
  attachments: AttachmentStore
  /** 危险操作闸门裁决回调；返回 true 表示获准执行 */
  requestGate: (req: GateRequest) => Promise<boolean>
  /**
   * v2.28：命令级危险清单是否可被「关掉确认框」这一策略放行。
   *
   * **只有内置人工闸门通道的出口才能置 true** —— 也就是应用内的代理运行时
   * （`ReactRuntime`，且仅当 `permission.confirmDanger === false`）。
   *
   * 为什么必须显式传递而不是让工具层直接读 `settings.permission.confirmDanger`：
   * 对外 MCP 出口复用同一个 `apply_config`（risk: write，在暴露白名单内），
   * 却**没有任何确认 UI**（它的 `requestGate` 恒为 `false`，"外部客户端一律视为拒绝"）。
   * 若工具层直接读全局设置，用户在本机为「一台可随时重装的实验设备」关掉确认框，
   * 会顺带把**远程 MCP 客户端**的破坏性命令也放行 —— 那是一处没有人授权过的提权。
   * 缺省 false = 保守拦截，与改动前完全一致。
   */
  commandGateRelease?: boolean
  /**
   * v2.7：结构化提问回调（`ask_user_question` 的唯一出口）。
   * 返回答案映射；用户取消或任务中止时返回 null。
   * 缺省 = 当前出口没有提问通道（对外 MCP），工具会返回 UNSUPPORTED。
   */
  askUser?: (req: {
    questions: QuestionItem[]
    source: 'tool' | 'plan'
  }) => Promise<QuestionAnswers | null>
  /** v2.7：任务清单存储（`todo_write` 的唯一出口），键为会话根 ID */
  todos?: TodoStore
  /** v2.7：当前任务的会话根 ID（清单分桶用）；缺省时 todo_write 返回 UNSUPPORTED */
  todoOwnerId?: string
  /**
   * F10：外部 MCP 调用面 —— 只有「主进程主动调外部工具」的场景需要（任务生命周期抓包）。
   *
   * 用结构化的最小接口而不是 `McpClientManager`：registry 是工具层的公共底座，
   * 引入 MCP 客户端类型会把整条依赖链拖进来（且 harness 里拿不到）。
   * 缺省 = 当前出口没有外部 MCP（对外 MCP 出口、单测的 fake ctx），抓包逻辑自动跳过。
   */
  mcp?: {
    tools: () => ReadonlyArray<{ namespaced: string; name: string; description?: string }>
    call: (namespaced: string, args: unknown) => Promise<{ ok: boolean; text: string; error?: string }>
  }
  /** v2.0：SSH 已保存连接摘要（只回 meta 不含密码；由 Services 注入，避免工具层依赖凭据库） */
  sshCredentials?: () => SshCredentialMeta[]
  signal?: AbortSignal
}

export interface GateRequest {
  toolName: string
  deviceId?: string
  args: unknown
  reason: string
  consequence: string
}

export interface ToolSpec<A = Record<string, unknown>> {
  name: string
  description: string
  risk: RiskLevel
  scope: ToolScope
  /**
   * 是否可以与「同一轮里相邻的其它调用」并发执行（v2.5）。
   *
   * **缺省 false —— 保守串行，必须显式开启。** 反过来的默认值会让将来新增的工具
   * 在无人察觉时拿到并发资格。
   *
   * 注意 `risk: 'read'` **不足以**当作并发资格：`connect_device` / `disconnect_device` /
   * `register_device` / `save_config_snapshot` 的 risk 同样是 read，但它们改的是连接状态
   * 或磁盘内容，并发就是静默竞态。只有「不改设备状态、不改本地数据、且参数能唯一确定
   * 一台设备」的幂等读操作才配这一位。
   *
   * 调度规则见 `shared/concurrency.ts`：只有**连续的一段**并发安全调用会被并行执行，
   * 任何写操作都是屏障（保证「写 → 读」的可见性语义与串行执行一致）。
   */
  concurrencySafe?: boolean
  /**
   * v2.22（F17）：是否外露给**外部 MCP 客户端**（缺省 true）。
   *
   * 为什么需要这一位：有些工具的**结果只有调用方自己能消费**。
   * 典型是 `read_image` —— 它产出的是一张图片，而「外部客户端那头的模型能不能看图」
   * 在这里**无法判定**（它不告诉我们也无从查起）。照发等于把「不支持视觉的客户端
   * 会不会 400」这个后果交给运气；而按应用自己的档案去判又是错的（判的不是同一个模型）。
   * 于是对齐 dsh 的口径：**能力未知即不外露**（unknown capability refuses）。
   *
   * 注意：`risk: 'danger'` 的外露过滤与它是两条独立规则，都要过。
   */
  mcpExposed?: boolean
  schema: TSchema
  /** 给 UI 与执行轨迹用的一行摘要 */
  summarize?: (args: A, result: ToolResult) => string
  /**
   * H（v2.14）：**可回放**的卡片数据投影（纯函数，可缺省）。
   *
   * 执行轨迹 / 回放模式重画卡片时，需要的是「结果期的事实」（`diff_with_snapshot`
   * 改了哪几行、`check_experiment` 哪几项没达成），而 `tool_end` 事件是**当次**的、
   * 不落盘 —— 于是回放只能降级成一行摘要。声明了这个投影的工具，其返回值会进
   * `tool_end.cardMeta`，并**落进会话树节点**（`toolCall.cardMeta`），供回放还原卡片。
   *
   * 三条纪律（由 `cardMetaOf` 兜底执行，见 runtime.iface.ts）：
   * - **必须是纯函数**：实时流与回放两条路径都会跑它，不得读时钟 / 文件 / 会话状态；
   * - **只返回小对象**：有体积上限（4000 字符，超了一律丢弃），而且它会进 jsonl
   *   —— 会话树在重命名 / 收尾 / 书签时会**整份重写**，大对象等于放大写放大；
   * - **大列表要在投影里自己截断**（截到 N 条 + 带上总数）：超上限是**整块丢弃**，
   *   卡片会凭空消失，比截断更糟。
   *
   * 缺省 = 不落盘任何卡片数据（绝大多数工具的 `data` 只在当次有用）。
   */
  presentationMeta?: (args: A, result: ToolResult) => unknown
  handler: (args: A, ctx: ToolContext) => Promise<ToolResult>
}

/**
 * 保证工具 schema 的**根**是 object（v2.1）。
 *
 * 为什么必须强制：OpenAI 兼容端点的函数入参校验只认根 `type: 'object'`。
 * TypeBox 的 `Type.Union([...])` 生成 `{ anyOf: [...] }`（**没有 type 字段**），
 * 这种 schema 会让整轮请求被 400 拒绝：
 * `Invalid schema for function 'x': schema must be a JSON Schema of 'type': "object", got 'type': null'`
 * —— 它和「本轮是否真的调用那个工具」无关，只要工具在表里，**每次发消息都失败**，
 * 等于整个会话不可用（2026-09-25 实测：execute_task 的根曾是 Type.Union）。
 *
 * 正常路径上所有内置工具都应直接把根写成 `Type.Object`（有 tool-schema 用例守着）；
 * 这里的兜底是为了防两类「外部来源」：运行期并入的外部 MCP 工具（schema 由第三方
 * 服务器给，可能不合规），以及将来新增工具时的一时笔误 —— 一个工具的 schema 不该
 * 有能力炸掉整轮对话。
 */
export function normalizeToolSchema(schema: TSchema): TSchema {
  const s = schema as { type?: unknown; anyOf?: unknown } | null
  if (!s || typeof s !== 'object') return { type: 'object', properties: {} } as unknown as TSchema
  if (s.type === 'object') return schema
  // 根是 union：把它抬到 anyOf 上并补 type，语义不变（对象 + 满足原分支之一）
  if (Array.isArray(s.anyOf)) return { ...(schema as object), type: 'object' } as unknown as TSchema
  // 其它非对象根（数组/标量）：包一层对象，至少不让请求被拒
  return { type: 'object', anyOf: [schema] } as unknown as TSchema
}

/** pi-ai 的工具定义（TypeBox schema），直接是 Context.tools 的元素 */
export type LlmTool = {
  name: string
  description: string
  parameters: TSchema
}

export function toLLMTools(specs: readonly ToolSpec[]): LlmTool[] {
  return specs.map((s) => ({
    name: s.name,
    description: s.description,
    parameters: normalizeToolSchema(s.schema)
  }))
}

/** MCP 输出（v0.4 使用）。TypeBox schema 即 JSON Schema，直接使用 */
export function toMcpTools(specs: readonly ToolSpec[]): Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}> {
  // 对外出口默认不暴露破坏性工具：外部客户端不应拥有比应用内更强的权限
  return specs
    .filter((s) => s.risk !== 'danger' && s.mcpExposed !== false)
    .map((s) => ({
      name: s.name,
      description: s.description,
      // MCP 的 inputSchema 同样要求根为 object，与 LLM 出口共用同一个归一化
      inputSchema: normalizeToolSchema(s.schema) as Record<string, unknown>
    }))
}

export function ok<T>(data: T, meta: ToolResult['meta']): ToolResult<T> {
  return { ok: true, data, meta }
}

export function fail(
  code: string,
  message: string,
  meta: ToolResult['meta'],
  raw?: string
): ToolResult {
  return { ok: false, error: { code, message, ...(raw ? { raw } : {}) }, meta }
}

/** 把 CommandResult 的失败态转成 ToolResult */
export function failFromCommand(
  r: { errorCode?: string; error?: string; raw: string },
  fallbackCode: string,
  meta: ToolResult['meta']
): ToolResult {
  return fail(r.errorCode ?? fallbackCode, r.error ?? '命令执行失败', meta, r.raw)
}

// ———————————————————————— 设备任务锁（D6，2026-09-23） ————————————————————————

/**
 * 抢占设备任务锁；抢不到返回可直接 return 的 DEVICE_BUSY 结果，抢到返回 null。
 *
 * 只给**多步事务**用（apply_config / restore_snapshot）：它们由多条命令组成，
 * 而通信层的串行保证是「单条命令」级的 —— 同一台设备上两个事务会互相插队，
 * 视图栈错乱且双方都报成功。只读工具（get_device_context / run_show_command / verify_*）
 * 刻意**不**占锁，保持「随时可观测」。
 *
 * 用法：
 * ```ts
 * const busy = acquireDeviceLock(ctx, deviceId, 'apply_config')
 * if (busy) return busy
 * try { ... } finally { releaseDeviceLock(ctx, deviceId, 'apply_config') }
 * ```
 */
export function acquireDeviceLock(
  ctx: Pick<ToolContext, 'sessions'>,
  deviceId: string,
  owner: string
): ToolResult | null {
  const sessions = ctx.sessions as SessionManager | undefined
  // 防御：只有真实 SessionManager 带锁 API。生产路径的 ctx 恒来自 agentDeps（真
  // SessionManager）；测试里的极简 fake session 刻意不实现锁，跳过即可 ——
  // 锁本身的互斥/超时/释放语义由 device-lock.test.mjs 用真实例覆盖。
  if (!sessions || typeof sessions.tryAcquireDevice !== 'function') return null
  if (sessions.tryAcquireDevice(deviceId, owner)) return null
  const held = sessions.deviceLockHolder(deviceId)
  const heldSec = held ? Math.round(held.heldMs / 1000) : 0
  return fail(
    'DEVICE_BUSY',
    `设备 ${deviceId} 正被另一个任务占用（占用者：${held?.owner ?? '未知'}，已持有 ${heldSec}s），` +
      '本次未下发任何命令。请稍后重试，或改在其它设备上执行 —— 同一设备上的多个配置事务必须串行，否则命令会交错。',
    { ms: 0, deviceId }
  )
}

/** 释放设备任务锁（非持有者调用会被忽略；fake session 同样安全跳过） */
export function releaseDeviceLock(
  ctx: Pick<ToolContext, 'sessions'>,
  deviceId: string,
  owner: string
): void {
  const sessions = ctx.sessions as SessionManager | undefined
  if (sessions && typeof sessions.releaseDevice === 'function') {
    sessions.releaseDevice(deviceId, owner)
  }
}

/**
 * 给**多步事务**工具包上设备任务锁（D6）。
 *
 * 锁在 handler 第一条语句之前抢占、无论成败（含抛错）都在 finally 释放，
 * 所以被包裹的 handler 一行都不用改。deviceId 非法时不下锁 ——
 * 后续 handler 自会用 NOT_CONNECTED / BAD_PARAM 拒绝，轮不到锁发言。
 *
 * execute_task / batch_configure 内部复用 applyConfig，因此自动获得同等保护；
 * 只读工具不要包（见 acquireDeviceLock 的说明）。
 */
export function withDeviceLock<A extends { deviceId?: unknown }>(
  owner: string,
  handler: (args: A, ctx: ToolContext) => Promise<ToolResult>
): (args: A, ctx: ToolContext) => Promise<ToolResult> {
  return async (args, ctx) => {
    const deviceId = typeof args?.deviceId === 'string' && args.deviceId ? args.deviceId : ''
    if (!deviceId) return handler(args, ctx)
    const busy = acquireDeviceLock(ctx, deviceId, owner)
    if (busy) return busy
    try {
      return await handler(args, ctx)
    } finally {
      releaseDeviceLock(ctx, deviceId, owner)
    }
  }
}

export { Type }