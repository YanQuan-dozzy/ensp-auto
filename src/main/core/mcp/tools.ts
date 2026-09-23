import type { TSchema } from '@earendil-works/pi-ai'
import type { ToolResult } from '@shared/types'
import { fail, ok, type ToolSpec } from '../../tools/registry'
import type { ExternalToolDef, McpClientManager } from './client'
import { splitExternalToolName } from './client'

/**
 * 外部 MCP 工具 → 内置工具表（v1.5）。
 *
 * 每次取工具表时现场生成：MCP 连接是运行期可变的（用户随时改配置、服务器随时掉线），
 * 缓存工具表只会带来「工具列表和实际连接不一致」的幽灵问题。
 *
 * 风险等级：默认 danger（走人工闸门）。用户对某台服务器勾了「信任」才降为 write；
 * v1.6 起再加一个总闸 forceConfirm（见 ExternalToolOptions）—— 打开后信任也失效。
 * 理由：外部工具的行为我们完全不了解，而内置工具的 danger 判定是按命令语义写死的。
 */

function summarizeExternal(def: ExternalToolDef): string {
  return `外部 MCP 工具：${def.serverName} / ${def.toolName}`
}

export interface ExternalToolOptions {
  /**
   * v1.6：一律按 danger 处理（设置 → 权限与审批里的「外部工具一律确认」）。
   * 打开后，逐台服务器勾的「信任」不再降级 —— 这是给「外部工具我都不想免确认」
   * 的用户准备的总闸，优先级高于服务器级设置。
   */
  forceConfirm?: boolean
  /** 注入总预算：外部工具条数与单工具 schema 字符上限（D14 预算闸） */
  maxTools?: number
  maxSchemaChars?: number
}

export interface ExternalToolBudget {
  /** 最多注入多少把外部工具（默认 64） */
  maxTools: number
  /** 单工具 inputSchema 的字符上限；超限的工具整把跳过（默认 12_000） */
  maxSchemaChars: number
}

export const DEFAULT_EXTERNAL_TOOL_BUDGET: ExternalToolBudget = {
  maxTools: 64,
  maxSchemaChars: 12_000
}

/**
 * 外部工具预算裁剪（纯函数，可测）。
 *
 * 两条截断都遵循「整把跳过 + 可解释」而不是半截注入：
 *  - 总条数超预算：后面的一律不注入（给模型看的工具表过大本身就推高溢出率）；
 *  - 单工具 schema 超长：整把跳过 —— 半截 schema 会让模型生成注定校验失败的参数。
 * 返回 { kept, skipped }，调用方决定如何标注（改到外部工具的摘要 / 日志）。
 */
export function fitExternalTools(
  defs: readonly ExternalToolDef[],
  budget: ExternalToolBudget = DEFAULT_EXTERNAL_TOOL_BUDGET
): { kept: ExternalToolDef[]; skipped: string[] } {
  const kept: ExternalToolDef[] = []
  const skipped: string[] = []
  for (const def of defs) {
    if (kept.length >= Math.max(0, budget.maxTools)) {
      skipped.push(def.namespaced)
      continue
    }
    let schemaChars = 0
    try {
      schemaChars = JSON.stringify(def.inputSchema ?? {}).length
    } catch {
      schemaChars = 0
    }
    if (budget.maxSchemaChars > 0 && schemaChars > budget.maxSchemaChars) {
      skipped.push(def.namespaced)
      continue
    }
    kept.push(def)
  }
  return { kept, skipped }
}

export function externalToolSpecs(mgr: McpClientManager, opts: ExternalToolOptions = {}): ToolSpec[] {
  // D14：注入侧总闸 —— 工具条数与单工具 schema 都设上限，超限整体跳过。
  // 否则外部工具表全量并入 system prompt 侧的工具定义，与技能注入一起把上下文撑爆。
  const { kept, skipped } = fitExternalTools(mgr.externalTools(), {
    maxTools: opts.maxTools ?? DEFAULT_EXTERNAL_TOOL_BUDGET.maxTools,
    maxSchemaChars: opts.maxSchemaChars ?? DEFAULT_EXTERNAL_TOOL_BUDGET.maxSchemaChars
  })
  if (skipped.length > 0) {
    // 没有面向场景的告警通道就用 console —— 至少留痕，避免「工具消失了」无从查起
    console.warn(`外部 MCP 工具预算裁剪：跳过 ${skipped.length} 把（${skipped.join('、')}）`)
  }
  return kept.map((def) => {
    const spec: ToolSpec = {
      name: def.namespaced,
      description: `[MCP · ${def.serverName}] ${def.description}`,
      risk: !opts.forceConfirm && def.trusted ? 'write' : 'danger',
      scope: 'local',
      schema: (def.inputSchema ?? { type: 'object', properties: {} }) as unknown as TSchema,
      summarize: () => summarizeExternal(def),
      handler: async (args): Promise<ToolResult> => {
        const t0 = Date.now()
        const split = splitExternalToolName(def.namespaced)
        const res = await mgr.callTool(def.namespaced, args)
        if (!res.ok) {
          return fail(
            'EXTERNAL_MCP_ERROR',
            res.error ?? '外部 MCP 工具调用失败',
            { ms: Date.now() - t0 },
            res.text || undefined
          )
        }
        return ok(
          {
            server: split?.server ?? def.serverName,
            tool: split?.tool ?? def.toolName,
            text: res.text
          },
          { ms: Date.now() - t0 }
        )
      }
    }
    return spec
  })
}

/** 用于 UI 展示：把外部工具表压成一行摘要 */
export function externalToolSummary(mgr: McpClientManager): string {
  const list = mgr.externalTools()
  if (list.length === 0) return '未连接任何外部工具'
  return list.map((t) => t.namespaced).join('、')
}
