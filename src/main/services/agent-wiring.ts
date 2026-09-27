import type { AgentEvent, Settings } from '@shared/types'
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
import { readImagesForModel } from '../core/attachments/image'
import type { TodoStore } from '../core/todo/store'
import { SkillStore } from '../skills/store'
import { contextDirsOf, skillsForContext } from '../skills/prompt'
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
  /** v2.7：任务清单存储（todo_write 的唯一出口） */
  todos: TodoStore
  /** 报告导出目录（可能被设置项改过，故用函数形式取实时值） */
  exportsDir: () => string
  /**
   * v2.15：流外事件直发通道（标题生成在事件流关闭后完成，见 AgentDeps.emitEvent）。
   * 由 services.startAgent 按「本轮 sessionId + runtime 类型」装配；缺省 = 不直发。
   */
  emitEvent?: (event: AgentEvent) => void
}

export function createAgentDeps(w: AgentWiring): AgentDeps {
  // v1.5：外部 MCP 工具在取工具表时动态并入（连接是运行期可变的，缓存会导致
  // 「工具表与实际连接不一致」）；对外 MCP 出口用 builtinTools()（见 toolsets.ts 的说明）。
  return {
    tools: agentTools(w.getSettings(), w.mcpClients),
    getSettings: () => w.getSettings(),
    getSkills: () => {
      // F12：按当前上下文目录过滤 —— 全局技能恒注入，绑定技能只在命中实验/工程目录时注入。
      // 上下文 = 设置里的拓扑目录 + 当前打开的工程文件所在目录（每轮实时取，换工程立即生效）。
      const settings = w.getSettings()
      const dirs = contextDirsOf(settings.storage?.topologyDir ?? '', w.topology.fileSourcePath)
      return skillsForContext(w.skills.enabledContents(), dirs)
    },
    // v2.7：清单存储交给运行时 —— 运行时才知道本轮是哪个会话（rootId 在 RunInput 里）
    todos: w.todos,
    // v2.8：会话树交给运行时 —— 标题生成与「已收尾」标记都发生在运行时的收尾阶段
    sessionTree: w.sessionTree,
    // v2.14：溢出落盘 —— 归档到附件根下的 spills/，模型用 read_attachment 按行读回。
    // 目录与失败语义都由 AttachmentStore#saveSpill 决定（失败返回 null → 运行时退回纯截断）。
    spill: (input) => w.attachments.saveSpill(input.rootId, input.callId, input.text),
    // v2.22（F17）：图片读取 —— 沙箱口径与 read_attachment 完全一致（附件归档 + 导出目录）。
    // 同步的 fs 读取包成 Promise：运行时只依赖这个形状，将来换成异步 IO 不必改运行时。
    readImageParts: async (images) =>
      readImagesForModel(w.attachments, images, [w.exportsDir()]).map(({ id, result }) =>
        result.ok
          ? { id, ok: true, mimeType: result.mimeType, data: result.data }
          : { id, ok: false, error: result.error }
      ),
    // v2.15：收尾后的标题生成在事件流关闭之后才完成，title_updated 走这条直发通道。
    ...(w.emitEvent ? { emitEvent: w.emitEvent } : {}),
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
      // F10：外部 MCP 调用面 —— 任务生命周期抓包用（只在设置里打开 autoCapture 时才真的调）
      mcp: {
        tools: () =>
          w.mcpClients.externalTools().map((t) => ({
            namespaced: t.namespaced,
            name: t.toolName,
            description: t.description
          })),
        call: (namespaced, args) => w.mcpClients.callTool(namespaced, args)
      },
      signal,
      // 默认闸门：一律拒绝。真实闸门由 ReactRuntime 覆盖为「问用户」。
      // 同理 askUser / todos / todoOwnerId 也在 ReactRuntime.buildContext 里补上 ——
      // 这一层**不知道本轮是哪个会话**，只有运行时知道。
      requestGate: async () => false
    })
  }
}
