import type { Settings } from '@shared/types'
import type { ToolSpec } from './registry'
import { TOOLS } from './index'
import { externalToolSpecs } from '../core/mcp/tools'
import type { McpClientManager } from '../core/mcp/client'

/**
 * 两份工具集合的唯一出口（D7，2026-09-23）。
 *
 * 为什么必须是具名函数而不是「谁用谁现场拼」：`agentDeps()` 同时服务两个消费者
 * （进程内代理 / 对外 MCP 出口），而两者的工具集合**必须不同**。过去 applyMcp 直接
 * 复用 agentDeps()，注释写着「对外只暴露内置工具」、代码却把外部工具一起塞了进去
 * —— 受信任的外部工具 risk 降为 write，能穿过 MCP 出口的 danger 过滤，形成自环
 * （外部客户端调 `mcp__<server>__<tool>` → 主进程再转回外部服务器）。
 *
 * 本模块刻意保持零 electron 依赖（会进测试 harness 整体打包）。
 */

/** **内置**工具表 —— 对外 MCP 出口的唯一工具来源 */
export function builtinTools(): readonly ToolSpec[] {
  return TOOLS
}

/** **代理**看到的工具表：内置 + 运行期并入的外部 MCP 工具 */
export function agentTools(settings: Settings, mcpClients: McpClientManager): readonly ToolSpec[] {
  // v1.6：permission.externalToolConfirm 打开时，外部工具一律按 danger 处理 ——
  // 逐台「信任」的降级在它面前失效（给「一台都不想信任」的用户一个总闸）。
  if (!settings.mcp.exposeToAgent) return TOOLS
  return [
    ...TOOLS,
    ...externalToolSpecs(mcpClients, {
      forceConfirm: settings.permission.externalToolConfirm
    })
  ]
}
