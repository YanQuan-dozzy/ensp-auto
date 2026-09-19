import { contextBridge, ipcRenderer } from 'electron'
import { EVENT, INVOKE } from '@shared/channels'
import type { RendererApi } from '@shared/api'
import type { Device, DeviceId, GateDecision, Settings, TopologyLink, TopologyNode } from '@shared/types'

/**
 * preload —— 渲染进程唯一的对外出口。
 *
 * 只暴露白名单方法，不暴露 ipcRenderer 本体，也不暴露任何 Node 能力。
 * 事件订阅同样走白名单，防止渲染层监听任意通道。
 */

const EVENT_WHITELIST = new Set<string>(Object.values(EVENT))

const api: RendererApi = {
  device: {
    scan: (start: number, end: number): Promise<Device[]> =>
      ipcRenderer.invoke(INVOKE.deviceScan, { start, end }),
    connect: (port: number, name?: string): Promise<Device> =>
      ipcRenderer.invoke(INVOKE.deviceConnect, { port, name }),
    disconnect: (deviceId: DeviceId): Promise<void> =>
      ipcRenderer.invoke(INVOKE.deviceDisconnect, { deviceId }),
    rename: (deviceId: DeviceId, name: string): Promise<Device> =>
      ipcRenderer.invoke(INVOKE.deviceRename, { deviceId, name }),
    list: (): Promise<Device[]> => ipcRenderer.invoke(INVOKE.deviceList)
  },
  terminal: {
    write: (deviceId, data) => ipcRenderer.invoke(INVOKE.terminalWrite, { deviceId, data }),
    resize: (deviceId, cols, rows) =>
      ipcRenderer.invoke(INVOKE.terminalResize, { deviceId, cols, rows }),
    buffer: (deviceId) => ipcRenderer.invoke(INVOKE.terminalBuffer, { deviceId }),
    clear: (deviceId) => ipcRenderer.invoke(INVOKE.terminalClear, { deviceId })
  },
  agent: {
    run: (
      sessionId: string,
      text: string,
      opts?: { rootId?: string | null; startNodeId?: string | null }
    ) => ipcRenderer.invoke(INVOKE.agentRun, { sessionId, text, ...(opts ?? {}) }),
    abort: (sessionId: string) => ipcRenderer.invoke(INVOKE.agentAbort, { sessionId }),
    gate: (sessionId: string, gateId: string, decision: GateDecision) =>
      ipcRenderer.invoke(INVOKE.agentGate, { sessionId, gateId, decision }),
    enqueue: (sessionId: string, text: string) =>
      ipcRenderer.invoke(INVOKE.agentEnqueue, { sessionId, text })
  },
  session: {
    list: () => ipcRenderer.invoke(INVOKE.sessionList),
    get: (rootId: string) => ipcRenderer.invoke(INVOKE.sessionGet, { rootId }),
    export: (rootId: string, format: 'md' | 'json') =>
      ipcRenderer.invoke(INVOKE.sessionExport, { rootId, format })
  },
  topology: {
    get: () => ipcRenderer.invoke(INVOKE.topologyGet),
    refresh: () => ipcRenderer.invoke(INVOKE.topologyRefresh),
    saveManual: (input: { nodes: TopologyNode[]; links: TopologyLink[] }) =>
      ipcRenderer.invoke(INVOKE.topologySaveManual, input),
    importFile: () => ipcRenderer.invoke(INVOKE.topologyImportFile)
  },
  settings: {
    get: () => ipcRenderer.invoke(INVOKE.settingsGet),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke(INVOKE.settingsSet, patch),
    hasApiKey: () => ipcRenderer.invoke(INVOKE.secretHas),
    setApiKey: (key: string) => ipcRenderer.invoke(INVOKE.secretSet, { key })
  },
  on: <T,>(channel: string, cb: (payload: T) => void): (() => void) => {
    if (!EVENT_WHITELIST.has(channel)) {
      throw new Error(`不允许监听未授权通道：${channel}`)
    }
    const listener = (_e: unknown, payload: T): void => cb(payload)
    ipcRenderer.on(channel, listener as never)
    return () => ipcRenderer.off(channel, listener as never)
  }
}

contextBridge.exposeInMainWorld('api', api)
