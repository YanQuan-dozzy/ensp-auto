import { Type, type TSchema } from '@earendil-works/pi-ai'
import type { RiskLevel, Settings, ToolResult, ToolScope } from '@shared/types'
import type { SessionManager } from '../core/session/SessionManager'
import type { SnapshotStore } from '../core/store/snapshots'
import type { ChangeStore } from '../core/store/changes'
import type { TopologyStore } from '../core/topology/store'
import type { SessionTreeStore } from '../core/session-tree/store'

/**
 * Tool Registry —— 工具定义的单一真相源。
 *
 * 一份 schema 双出口：
 *   toLLMTools()  → 进程内自研 Agent（pi-ai 的 function calling，TypeBox schema）
 *   toMcpTools()  → 对外 MCP 服务（v0.4，TypeBox 对象本身即 JSON Schema）
 *
 * schema 用 TypeBox（由 @earendil-works/pi-ai 反出，不额外引依赖）：
 * 与 JSON Schema 同构，可同时喂给 LLM 与 MCP，且得到静态类型推导。
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
  /** 危险操作闸门裁决回调；返回 true 表示获准执行 */
  requestGate: (req: GateRequest) => Promise<boolean>
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

export { Type }