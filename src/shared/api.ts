import type { AgentEvent, Device, DeviceId, GateDecision, SessionNode, SessionNodeMeta, Settings, Topology, TopologyLink, TopologyNode } from './types'

/**
 * preload 暴露给渲染进程的 API 契约。
 *
 * 放在 shared 而不是 preload 里，是为了让渲染层能拿到类型但**不引入 electron 依赖** ——
 * 渲染层的 tsconfig 只包含 DOM 类型，一旦从 preload 导入，electron 的类型就会漏进来。
 */

export interface TerminalWriteResult {
  accepted: boolean
  queued: boolean
}

export interface SettingsPayload {
  settings: Settings
  hasApiKey: boolean
}

export interface AgentEventPayload {
  sessionId: string
  event: AgentEvent
  runtime: 'react' | 'mock'
}

export interface ScanProgress {
  scanned: number
  total: number
  found: number
  done: boolean
}

export interface TerminalDataPayload {
  deviceId: string
  chunk: Uint8Array
  fromAgent: boolean
}

export interface TerminalClosedPayload {
  deviceId: string
  reason: string
}

/** v0.4：MCP 服务运行态（EVENT.mcpStatus 载荷） */
export interface McpStatusPayload {
  running: boolean
  url: string
  error: string | null
}

/** v0.5 前置：.topo 解析结果（IPC topology:import-file 载荷） */
export interface TopoImportPayload {
  topology: Topology
  report: {
    devices: number
    links: number
    encoding: string
    gzipped: boolean
    warnings: string[]
  }
}

export interface RendererApi {
  device: {
    scan(start: number, end: number): Promise<Device[]>
    connect(port: number, name?: string): Promise<Device>
    disconnect(deviceId: DeviceId): Promise<void>
    rename(deviceId: DeviceId, name: string): Promise<Device>
    list(): Promise<Device[]>
  }
  terminal: {
    write(deviceId: DeviceId, data: string): Promise<TerminalWriteResult>
    resize(deviceId: DeviceId, cols: number, rows: number): Promise<unknown>
    buffer(deviceId: DeviceId): Promise<string>
    clear(deviceId: DeviceId): Promise<boolean>
  }
  agent: {
    run(
      sessionId: string,
      text: string,
      opts?: { rootId?: string | null; startNodeId?: string | null }
    ): Promise<{ started: boolean }>
    abort(sessionId: string): Promise<{ aborted: boolean }>
    gate(sessionId: string, gateId: string, decision: GateDecision): Promise<unknown>
    enqueue(sessionId: string, text: string): Promise<{ queued: boolean }>
  }
  session: {
    list(): Promise<SessionNodeMeta[]>
    get(rootId: string): Promise<SessionNode[]>
    export(rootId: string, format: 'md' | 'json'): Promise<{ path: string }>
  }
  topology: {
    get(): Promise<Topology>
    refresh(): Promise<Topology>
    saveManual(input: { nodes: TopologyNode[]; links: TopologyLink[] }): Promise<Topology>
    importFile(): Promise<TopoImportPayload | null>
  }
  settings: {
    get(): Promise<SettingsPayload>
    set(patch: Partial<Settings>): Promise<SettingsPayload>
    hasApiKey(): Promise<{ has: boolean }>
    setApiKey(key: string): Promise<{ has: boolean }>
  }
  on<T>(channel: string, cb: (payload: T) => void): () => void
}
