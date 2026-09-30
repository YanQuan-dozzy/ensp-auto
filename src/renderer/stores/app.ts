/**
 * 渲染层全局 store（T5.8 拆分）。
 *
 * 现状是多个域 action 散在同一个 create() 里（device / agent / sessions / topology /
 * skills / settings / mcp / init），共 944 行 —— 已按域拆成三个 slice：
 *   - deviceActions.ts：设备连接 / 扫描 / 终端回调
 *   - agentActions.ts：会话消息 / 附件 / MCP 客户端 / 闸门
 *   - dataActions.ts：启动 / 设置 / 会话树 / 拓扑 / 技能
 * 状态形状 AppState 与共享纯工具分别在 appState.ts / storeUtil.ts。
 * 本文件只保留「初始状态 + 装配」，行为与拆分前逐行等价。
 */
import { create } from 'zustand'
import { DEFAULT_SETTINGS, type AgentEvent } from '@shared/types'
import type { AppState } from './appState'
import { deviceActions } from './deviceActions'
import { agentActions } from './agentActions'
import { dataActions } from './dataActions'
import { SESSION_ID, formatMessageTime, type UiMessage } from './storeUtil'

export type { AppState }
export { SESSION_ID, formatMessageTime }
export type { UiMessage }
export type { AgentEvent }

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  startupError: null,
  settings: DEFAULT_SETTINGS,
  hasApiKey: false,
  configuredProfileIds: [],

  devices: [],
  scanning: false,
  scanProgress: null,
  scanError: null,
  connectAllProgress: null,

  activeDeviceId: null,
  activeTab: 'terminal',

  messages: [],
  // R3：流式中的 assistant 正文不进 messages（见 appState.streamingText）
  streamingText: null,
  agentRunning: false,
  agentRuntime: 'react',
  gate: null,
  // v2.7：结构化提问 / 任务清单 / 计划模式
  question: null,
  agentTodos: [],
  planMode: false,
  // v2.11：气泡「引用」动作写入，由输入框消费后清空
  quoteDraft: null,
  queueHint: 0,
  shortcutRecording: false,

  sessions: [],
  activeRootId: null,
  activeStartNodeId: null,
  queueCount: 0,
  // v2.8：可续跑会话；null = 尚未查询（启动后由 loadResumable 填）
  resumable: null,
  mcpStatus: { running: false, url: '', error: null },
  attachments: [],
  enhancing: false,
  mcpServers: [],
  mcpBusy: false,

  terminalQueueHint: 0,
  connectedIds: [],

  topology: { nodes: [], links: [], updatedAt: 0 },
  topologyRefreshing: false,
  topoLoading: null,
  // F11 回放：由「轨迹」标签页写入，拓扑画布只读消费
  topoHighlightDeviceId: null,

  skills: [],

  ...deviceActions(set, get),
  ...agentActions(set, get),
  ...dataActions(set, get),

  // 纯 UI 瞬时状态（跨标签页共享），不属于任何一个域 slice，故留在装配层
  setTopoHighlight(deviceId) {
    set({ topoHighlightDeviceId: deviceId })
  }
}))