import type { Settings } from '@shared/types'
import type { AgentDeps } from '../agent/runtime.iface'
import type { ToolContext } from '../tools/registry'
import { agentTools } from '../tools/toolsets'
// D7：两份工具集合（内置 / 代理视角）的具名出口在 tools/toolsets.ts；
// 这里 re-export 供 services.ts 单一入口引用。
export { builtinTools, agentTools } from '../tools/toolsets'
import type { McpClientManager } from '../core/mcp/client'
import type { SessionManager } from '../core/session/SessionManager'
import type { SnapshotStore } from '../core/store/snapshots'
import type { ChangeStore } from '../core/store/changes'
import type { TopologyStore } from '../core/topology/store'
import type { SessionTreeStore } from '../core/session-tree/store'
import type { AttachmentStore } from '../core/attachments/store'
import type { SkillStore } from '../skills/store'
import { listSshCredentials } from '../settings/sshSecrets'

/**
 * Agent 装配（T5.2 从 services.ts 抽出）。
 *
 * 这里回答一个问题：**代理这一轮到底能看到什么**。
 * 工具表（内置 + 运行期并入的外部 MCP）、技能内容、自定义指令、工具上下文
 * 全在这一个函数里组装，改动时不必再翻整个 services.ts。
 */

export interface AgentWiring {
  getSettings: () => Settings
  skills: SkillStore
  mcpClients: McpClientManager
  sessions: SessionManager
  snapshots: SnapshotStore
  changes: ChangeStore
  topology: TopologyStore
  sessionTree: SessionTreeStore
  attachments: AttachmentStore
  /** 报告导出目录（可能被设置项改过，故用函数形式取实时值） */
  exportsDir: () => string
}

export function createAgentDeps(w: AgentWiring): AgentDeps {
  // v1.5：外部 MCP 工具在取工具表时动态并入（连接是运行期可变的，缓存会导致
  // 「工具表与实际连接不一致」）；对外 MCP 出口用 builtinTools()（见 toolsets.ts 的说明）。
  return {
    tools: agentTools(w.getSettings(), w.mcpClients),
    getSettings: () => w.getSettings(),
    getSkills: () => w.skills.enabledContents(),
    // R53：自定义指令在 Settings.agent.systemPrompt（v1.5 起是 agent 级字段，不在档案里）。
    // 每次请求实时取，改设置后下一轮立即生效，无需重启。
    getCustomInstructions: () => w.getSettings().agent.systemPrompt,
    buildContext: (signal: AbortSignal): ToolContext => ({
      sessions: w.sessions,
      settings: w.getSettings(),
      snapshots: w.snapshots,
      changes: w.changes,
      topology: w.topology,
      sessionTree: w.sessionTree,
      exportsDir: w.exportsDir(),
      attachments: w.attachments,
      // v2.0：SSH 已保存连接摘要（供代理 ssh_list；密码/私钥在凭据库，永不出来）
      sshCredentials: () => listSshCredentials(),
      signal,
      // 默认闸门：一律拒绝。真实闸门由 ReactRuntime 覆盖为「问用户」。
      requestGate: async () => false
    })
  }
}
