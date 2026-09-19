import { create } from 'zustand'
import { DEFAULT_SETTINGS, type AgentEvent, type Device, type DeviceId, type GateDecision, type RiskLevel, type SessionNode, type SessionNodeMeta, type Settings, type Topology, type TopologyLink, type TopologyNode } from '@shared/types'
import type { AgentEventPayload, McpStatusPayload, ScanProgress, TerminalDataPayload, TerminalClosedPayload, TopoImportPayload } from '@shared/api'
import { EVENT } from '@shared/channels'

export type UiMessage =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'plan'; id: string; steps: string[] }
  | {
      kind: 'tool'
      id: string
      callId: string
      name: string
      args: unknown
      risk: RiskLevel
      status: 'running' | 'ok' | 'fail'
      ms?: number
      summary?: string
      raw?: string
      errorCode?: string
    }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'error' }

export interface GateView {
  gateId: string
  name: string
  args: unknown
  reason: string
}

export type MainTab = 'terminal' | 'topology'

let seq = 0
const nextId = (): string => `m${++seq}`

interface AppState {
  ready: boolean
  /** v1.0 前置：启动失败时不白屏，把错误亮给用户 */
  startupError: string | null
  settings: Settings
  hasApiKey: boolean

  devices: Device[]
  scanning: boolean
  scanProgress: ScanProgress | null
  scanError: string | null

  activeDeviceId: DeviceId | null
  activeTab: MainTab

  messages: UiMessage[]
  agentRunning: boolean
  agentRuntime: 'react' | 'mock'
  gate: GateView | null
  queueHint: number

  /** v0.4：会话树 */
  sessions: SessionNodeMeta[]
  activeRootId: string | null
  /** 回溯起始节点（非 null 时下一轮 run 从该节点继续） */
  activeStartNodeId: string | null
  queueCount: number
  /** v0.4：MCP 服务运行态 */
  mcpStatus: { running: boolean; url: string; error: string | null }

  terminalQueueHint: number
  connectedIds: string[]

  topology: Topology
  topologyRefreshing: boolean

  init: () => Promise<void>
  refreshDevices: () => Promise<void>
  scan: () => Promise<void>
  connect: (port: number) => Promise<void>
  disconnect: (deviceId: DeviceId) => Promise<void>
  rename: (deviceId: DeviceId, name: string) => Promise<void>

  refreshTopology: () => Promise<void>
  saveManualTopology: (input: { nodes: TopologyNode[]; links: TopologyLink[] }) => Promise<void>
  /** v1.0 前置：弹窗选择 .topo 导入（F-5.2）；返回 null 表示用户取消或失败 */
  importTopology: () => Promise<TopoImportPayload | null>
  retryStartup: () => void

  loadSessions: () => Promise<void>
  newSession: () => void
  /** 从历史节点「换路重走」：载入该会话视图并设置回溯起点 */
  continueFrom: (rootId: string, node: SessionNode) => Promise<void>

  setActiveDevice: (deviceId: DeviceId | null) => void
  setTab: (tab: MainTab) => void

  send: (text: string) => Promise<void>
  abort: () => void
  resolveGate: (decision: GateDecision) => Promise<void>
  clearConversation: () => void

  setTheme: (theme: 'dark' | 'light') => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  setApiKey: (key: string) => Promise<void>

  applyAgentEvent: (p: AgentEventPayload) => void
  pushTerminalData: (p: TerminalDataPayload) => void
  markTerminalClosed: (p: TerminalClosedPayload) => void
  bumpTerminalQueue: (n: number) => void
  setConnectedIds: (ids: string[]) => void
}

const SESSION_ID = 'main'

/** 会话树节点 → AI 面板消息（历史浏览/回溯载入用） */
function nodesToMessages(nodes: SessionNode[]): UiMessage[] {
  return nodes.map((n) => {
    if (n.role === 'user') return { kind: 'user', id: n.id, text: n.content }
    if (n.role === 'assistant') return { kind: 'assistant', id: n.id, text: n.content }
    const tc = n.toolCall
    return {
      kind: 'tool',
      id: n.id,
      callId: tc?.callId ?? n.id,
      name: tc?.name ?? n.content,
      args: tc?.args,
      risk: 'read' as RiskLevel,
      status: tc?.ok === false ? 'fail' : 'ok',
      ...(tc?.ms !== undefined ? { ms: tc.ms } : {}),
      summary: n.content
    }
  })
}

function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme
  // 这一行让原生滚动条与表单控件跟着切，否则浅色主题下滚动条还是黑的
  document.documentElement.style.colorScheme = theme
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  startupError: null,
  settings: DEFAULT_SETTINGS,
  hasApiKey: false,

  devices: [],
  scanning: false,
  scanProgress: null,
  scanError: null,

  activeDeviceId: null,
  activeTab: 'terminal',

  messages: [],
  agentRunning: false,
  agentRuntime: 'react',
  gate: null,
  queueHint: 0,

  sessions: [],
  activeRootId: null,
  activeStartNodeId: null,
  queueCount: 0,
  mcpStatus: { running: false, url: '', error: null },

  terminalQueueHint: 0,
  connectedIds: [],

  topology: { nodes: [], links: [], updatedAt: 0 },
  topologyRefreshing: false,

  async init() {
    try {
      const { settings, hasApiKey } = await window.api.settings.get()
    applyTheme(settings.theme)
    set({ settings, hasApiKey, ready: true })

    window.api.on<ScanProgress>(EVENT.scanProgress, (p) => {
      set({ scanProgress: p, scanning: !p.done })
      if (p.done) void get().refreshDevices()
    })
    window.api.on<Device>(EVENT.deviceStateChanged, (d) => {
      set((s) => {
        const idx = s.devices.findIndex((x) => x.id === d.id)
        const next = [...s.devices]
        if (idx >= 0) next[idx] = d
        else next.push(d)
        return {
          devices: sortDevices(next),
          connectedIds: next.filter((x) => x.connected).map((x) => x.id)
        }
      })
    })
    window.api.on<AgentEventPayload>(EVENT.agentEvent, (p) => get().applyAgentEvent(p))
    window.api.on<TerminalDataPayload>(EVENT.terminalData, (p) => get().pushTerminalData(p))
    window.api.on<TerminalClosedPayload>(EVENT.terminalClosed, (p) =>
      get().markTerminalClosed(p)
    )
    window.api.on<Topology>(EVENT.topologyUpdated, (t) => set({ topology: t }))
    window.api.on<SessionNodeMeta[]>(EVENT.sessionListUpdated, (list) => set({ sessions: list }))
    window.api.on<McpStatusPayload>(EVENT.mcpStatus, (s) =>
      set({ mcpStatus: { running: s.running, url: s.url, error: s.error } })
    )

    const topology = await window.api.topology.get()
    set({ topology })
    await get().loadSessions()
    await get().refreshDevices()
    } catch (e) {
      // 启动失败不白屏：把错误亮给用户并提供重试
      set({ startupError: e instanceof Error ? e.message : String(e), ready: false })
    }
  },

  async refreshDevices() {
    const devices = await window.api.device.list()
    set({
      devices: sortDevices(devices),
      connectedIds: devices.filter((d) => d.connected).map((d) => d.id)
    })
  },

  async scan() {
    const { settings } = get()
    set({ scanning: true, scanError: null, scanProgress: { scanned: 0, total: 0, found: 0, done: false } })
    try {
      await window.api.device.scan(settings.scanStart, settings.scanEnd)
      await get().refreshDevices()
    } catch (e) {
      set({ scanError: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ scanning: false })
    }
  },

  async connect(port) {
    try {
      const d = await window.api.device.connect(port)
      set({ activeDeviceId: d.id, activeTab: 'terminal' })
      await get().refreshDevices()
    } catch (e) {
      set({ scanError: e instanceof Error ? e.message : String(e) })
    }
  },

  async disconnect(deviceId) {
    await window.api.device.disconnect(deviceId)
    const remaining = get().devices.filter((d) => d.id !== deviceId && d.connected)
    set((s) => ({
      activeDeviceId: s.activeDeviceId === deviceId ? (remaining[0]?.id ?? null) : s.activeDeviceId
    }))
    await get().refreshDevices()
  },

  async rename(deviceId, name) {
    await window.api.device.rename(deviceId, name)
    await get().refreshDevices()
  },

  setActiveDevice(deviceId) {
    set({ activeDeviceId: deviceId })
  },

  setTab(tab) {
    set({ activeTab: tab })
  },

  async send(text) {
    const trimmed = text.trim()
    if (!trimmed) return

    // v0.4：执行中插话 → 入队，不另开新任务
    if (get().agentRunning) {
      let queued = false
      try {
        ;({ queued } = await window.api.agent.enqueue(SESSION_ID, trimmed))
      } catch {
        queued = false
      }
      set((s) => ({
        queueCount: queued ? s.queueCount + 1 : s.queueCount,
        messages: [
          ...s.messages,
          {
            kind: 'system',
            id: nextId(),
            text: queued ? '已加入执行队列，将在当前任务下一步处理' : '任务即将结束，消息未入队，请稍后重发',
            tone: queued ? 'info' : 'error'
          }
        ]
      }))
      return
    }

    set((s) => ({
      messages: [...s.messages, { kind: 'user', id: nextId(), text: trimmed }],
      agentRunning: true
    }))
    try {
      await window.api.agent.run(SESSION_ID, trimmed, {
        rootId: get().activeRootId,
        startNodeId: get().activeStartNodeId
      })
      // 本次已消费回溯起点，后续新消息从会话尾部继续
      if (get().activeStartNodeId) set({ activeStartNodeId: null })
    } catch (e) {
      set((s) => ({
        agentRunning: false,
        messages: [
          ...s.messages,
          { kind: 'system', id: nextId(), text: e instanceof Error ? e.message : String(e), tone: 'error' }
        ]
      }))
    }
  },

  abort() {
    void window.api.agent.abort(SESSION_ID)
  },

  async resolveGate(decision) {
    const gate = get().gate
    if (!gate) return
    set({ gate: null })
    await window.api.agent.gate(SESSION_ID, gate.gateId, decision)
  },

  clearConversation() {
    set({ messages: [], gate: null, queueHint: 0 })
  },

  async setTheme(theme) {
    applyTheme(theme)
    await get().updateSettings({ theme })
  },

  async refreshTopology() {
    set({ topologyRefreshing: true })
    try {
      const t = await window.api.topology.refresh()
      set({ topology: t })
    } finally {
      set({ topologyRefreshing: false })
    }
  },

  async saveManualTopology(input) {
    const t = await window.api.topology.saveManual(input)
    set({ topology: t })
  },

  async importTopology() {
    try {
      const r = await window.api.topology.importFile()
      if (r) set({ topology: r.topology })
      return r
    } catch (e) {
      return null
    }
  },

  retryStartup() {
    set({ startupError: null, ready: false })
    void get().init()
  },

  async loadSessions() {
    try {
      const sessions = await window.api.session.list()
      set({ sessions })
    } catch {
      /* 历史读取失败不阻塞主流程 */
    }
  },

  newSession() {
    set({ activeRootId: null, activeStartNodeId: null, messages: [], queueCount: 0 })
  },

  async continueFrom(rootId, node) {
    const nodes = await window.api.session.get(rootId)
    set({
      activeRootId: rootId,
      activeStartNodeId: node.id,
      messages: nodesToMessages(nodes),
      queueCount: 0
    })
  },

  async updateSettings(patch) {
    const { settings } = await window.api.settings.set(patch)
    set({ settings })
  },

  async setApiKey(key) {
    const { has } = await window.api.settings.setApiKey(key)
    set({ hasApiKey: has })
  },

  applyAgentEvent({ event, runtime }) {
    set({ agentRuntime: runtime })
    switch (event.type) {
      case 'plan':
        set((s) => ({ messages: [...s.messages, { kind: 'plan', id: nextId(), steps: event.steps }] }))
        break
      case 'text':
        set((s) => {
          const last = s.messages[s.messages.length - 1]
          if (last && last.kind === 'assistant') {
            const next = [...s.messages]
            next[next.length - 1] = { ...last, text: last.text + event.delta }
            return { messages: next }
          }
          return { messages: [...s.messages, { kind: 'assistant', id: nextId(), text: event.delta }] }
        })
        break
      case 'tool_start':
        set((s) => ({
          messages: [
            ...s.messages,
            {
              kind: 'tool',
              id: nextId(),
              callId: event.callId,
              name: event.name,
              args: event.args,
              risk: event.risk,
              status: 'running'
            }
          ]
        }))
        break
      case 'tool_end':
        set((s) => {
          const next = [...s.messages]
          for (let i = next.length - 1; i >= 0; i--) {
            const m = next[i]!
            if (m.kind === 'tool' && m.callId === event.callId) {
              next[i] = {
                ...m,
                status: event.ok ? 'ok' : 'fail',
                ms: event.ms,
                summary: event.summary,
                ...(event.raw ? { raw: event.raw } : {}),
                ...(event.errorCode ? { errorCode: event.errorCode } : {})
              }
              break
            }
          }
          return { messages: next }
        })
        break
      case 'gate_request':
        set({ gate: { gateId: event.gateId, name: event.name, args: event.args, reason: event.reason } })
        break
      case 'gate_resolved':
        set((s) => ({
          gate: null,
          messages: [
            ...s.messages,
            {
              kind: 'system',
              id: nextId(),
              text: event.decision === 'approve' ? '已批准危险操作' : '已拒绝危险操作',
              tone: event.decision === 'approve' ? 'info' : 'error'
            }
          ]
        }))
        break
      case 'error':
        set((s) => ({
          messages: [
            ...s.messages,
            { kind: 'system', id: nextId(), text: event.message, tone: 'error' }
          ]
        }))
        break
      case 'done':
        set({ agentRunning: false, gate: null, queueHint: 0, queueCount: 0 })
        break
      default:
        break
    }
  },

  pushTerminalData() {
    /* 终端数据由 TerminalPane 直接消费（xterm 实例在组件内），这里不落 store */
  },

  markTerminalClosed({ deviceId, reason }) {
    set((s) => ({
      connectedIds: s.connectedIds.filter((id) => id !== deviceId),
      messages: [
        ...s.messages,
        { kind: 'system', id: nextId(), text: `设备 ${deviceId} 连接已断开：${reason}`, tone: 'error' }
      ]
    }))
    void get().refreshDevices()
  },

  bumpTerminalQueue(n) {
    set({ terminalQueueHint: n })
  },

  setConnectedIds(ids) {
    set({ connectedIds: ids })
  }
}))

function sortDevices(list: Device[]): Device[] {
  return [...list].sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1
    return a.port - b.port
  })
}

export { SESSION_ID }
export type { AgentEvent }
