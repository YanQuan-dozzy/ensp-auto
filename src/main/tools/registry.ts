import { Type, type TSchema } from '@earendil-works/pi-ai'
import type { RiskLevel, Settings, ToolResult, ToolScope } from '@shared/types'
import type { SshCredentialMeta } from '@shared/api'
import type { SessionManager } from '../core/session/SessionManager'
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
  schema: TSchema
  /** 给 UI 与执行轨迹用的一行摘要 */
  summarize?: (args: A, result: ToolResult) => string
  handler: (args: A, ctx: ToolContext) => Promise<ToolResult>
}

/** pi-ai 的工具定义（TypeBox schema），直接是 Context.tools 的元素 */
export type LlmTool = {
  name: string
  description: string
  parameters: TSchema
}

export function toLLMTools(specs: readonly ToolSpec[]): LlmTool[] {
  return specs.map((s) => ({ name: s.name, description: s.description, parameters: s.schema }))
}

/** MCP 输出（v0.4 使用）。TypeBox schema 即 JSON Schema，直接使用 */
export function toMcpTools(specs: readonly ToolSpec[]): Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}> {
  // 对外出口默认不暴露破坏性工具：外部客户端不应拥有比应用内更强的权限
  return specs
    .filter((s) => s.risk !== 'danger')
    .map((s) => ({ name: s.name, description: s.description, inputSchema: s.schema as Record<string, unknown> }))
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