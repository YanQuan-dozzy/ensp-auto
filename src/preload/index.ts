import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { EVENT, INVOKE } from '@shared/channels'
import type { RendererApi, StorageScopeId } from '@shared/api'
import type { Attachment } from '@shared/attachments'
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
    forget: (deviceId: DeviceId): Promise<void> =>
      ipcRenderer.invoke(INVOKE.deviceForget, { deviceId }),
    list: (): Promise<Device[]> => ipcRenderer.invoke(INVOKE.deviceList),
    // v2.0：SSH 连接（凭据加密存主进程，密码/私钥不经 IPC 回传）
    ssh: {
      list: () => ipcRenderer.invoke(INVOKE.deviceSshList),
      save: (input) => ipcRenderer.invoke(INVOKE.deviceSshSave, input),
      remove: (id: string) => ipcRenderer.invoke(INVOKE.deviceSshDelete, { id }),
      connect: (input) => ipcRenderer.invoke(INVOKE.deviceSshConnect, input)
    }
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
      opts?: { rootId?: string | null; startNodeId?: string | null; attachments?: Attachment[] }
    ) => ipcRenderer.invoke(INVOKE.agentRun, { sessionId, text, ...(opts ?? {}) }),
    abort: (sessionId: string) => ipcRenderer.invoke(INVOKE.agentAbort, { sessionId }),
    gate: (sessionId: string, gateId: string, decision: GateDecision) =>
      ipcRenderer.invoke(INVOKE.agentGate, { sessionId, gateId, decision }),
    enqueue: (sessionId: string, text: string) =>
      ipcRenderer.invoke(INVOKE.agentEnqueue, { sessionId, text }),
    // v1.5：附件导入（弹框 / 按路径）与一键增强提示词
    pickAttachments: (sessionId: string) =>
      ipcRenderer.invoke(INVOKE.agentPickAttachments, { sessionId }),
    importAttachments: (sessionId: string, paths: string[]) =>
      ipcRenderer.invoke(INVOKE.agentImportAttachments, { sessionId, paths }),
    enhancePrompt: (draft: string) => ipcRenderer.invoke(INVOKE.agentEnhancePrompt, { draft })
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
    remove: (input: { nodeIds?: string[]; linkKeys?: string[] }) =>
      ipcRenderer.invoke(INVOKE.topologyRemove, input),
    importFile: () => ipcRenderer.invoke(INVOKE.topologyImportFile),
    findFiles: (directory?: string) =>
      ipcRenderer.invoke(INVOKE.topologyFindFiles, { ...(directory ? { directory } : {}) }),
    importPath: (filePath: string) =>
      ipcRenderer.invoke(INVOKE.topologyImportPath, { filePath })
  },
  settings: {
    get: () => ipcRenderer.invoke(INVOKE.settingsGet),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke(INVOKE.settingsSet, patch),
    // v1.5：密钥按档案分档 —— 不传 profileId 时主进程落给当前活跃档案
    hasApiKey: (profileId?: string) => ipcRenderer.invoke(INVOKE.secretHas, { profileId }),
    setApiKey: (profileId: string, key: string) =>
      ipcRenderer.invoke(INVOKE.secretSet, { profileId, key })
  },
  // v1.10：一句话实验目标存档（只读；渲染层本地随机抽三条展示）
  goals: {
    list: () => ipcRenderer.invoke(INVOKE.goalsGet)
  },
  ensp: {
    locate: () => ipcRenderer.invoke(INVOKE.enspLocate),
    pickExe: () => ipcRenderer.invoke(INVOKE.enspPickExe)
  },
  // v1.5：外部 MCP 服务器（本应用作为客户端连出去）
  mcp: {
    servers: () => ipcRenderer.invoke(INVOKE.mcpServers),
    sync: () => ipcRenderer.invoke(INVOKE.mcpSync),
    testServer: (id: string) => ipcRenderer.invoke(INVOKE.mcpTestServer, { id })
  },
  // v1.9：Wireshark 抓包分析接入
  wireshark: {
    probe: (opts?: { force?: boolean }) => ipcRenderer.invoke(INVOKE.wiresharkProbe, opts),
    install: () => ipcRenderer.invoke(INVOKE.wiresharkInstall),
    attach: (opts?: { profile?: 'analysis' | 'full' }) =>
      ipcRenderer.invoke(INVOKE.wiresharkAttach, opts ?? {}),
    detach: () => ipcRenderer.invoke(INVOKE.wiresharkDetach),
    pickDir: () => ipcRenderer.invoke(INVOKE.wiresharkPickDir)
  },
  // v1.5：拖拽文件取真实路径（Electron 32 起 File.path 已移除，官方推荐 webUtils）
  files: {
    pathFor: (file: unknown): string => {
      try {
        // 不写 File 类型：preload 侧 tsconfig 无 DOM 库，用入参类型反推
        return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0])
      } catch {
        return ''
      }
    }
  },
  diag: {
    run: () => ipcRenderer.invoke(INVOKE.diagRun)
  },
  // v1.6：应用信息与数据目录维护（设置 → 通用）
  app: {
    info: () => ipcRenderer.invoke(INVOKE.appInfo),
    storage: () => ipcRenderer.invoke(INVOKE.appStorage),
    openPath: (target: 'userData' | 'exports' | 'attachments' | 'snapshots') =>
      ipcRenderer.invoke(INVOKE.appOpenPath, { target }),
    clearData: (scope: StorageScopeId) => ipcRenderer.invoke(INVOKE.appClearData, { scope }),
    pickDirectory: (title?: string) => ipcRenderer.invoke(INVOKE.appPickDir, { title }),
    changeUserDataDir: (args: { targetDir: string; migrateData: boolean }) =>
      ipcRenderer.invoke(INVOKE.appChangeUserDataDir, args),
    resetUserDataDir: () => ipcRenderer.invoke(INVOKE.appResetUserDataDir),
    relaunch: () => ipcRenderer.invoke(INVOKE.appRelaunch)
  },
  skill: {
    list: () => ipcRenderer.invoke(INVOKE.skillList),
    get: (id: string) => ipcRenderer.invoke(INVOKE.skillGet, { id }),
    save: (input) => ipcRenderer.invoke(INVOKE.skillSave, input),
    remove: (id: string) => ipcRenderer.invoke(INVOKE.skillRemove, { id }),
    setEnabled: (ids: string[]) => ipcRenderer.invoke(INVOKE.skillSetEnabled, { ids }),
    importFiles: () => ipcRenderer.invoke(INVOKE.skillImportFiles),
    importDirectory: () => ipcRenderer.invoke(INVOKE.skillImportDirectory),
    importPath: (filePath: string) =>
      ipcRenderer.invoke(INVOKE.skillImportPath, { filePath })
  },
  window: {
    minimize: () => ipcRenderer.invoke(INVOKE.windowMinimize),
    maximize: () => ipcRenderer.invoke(INVOKE.windowMaximize),
    close: () => ipcRenderer.invoke(INVOKE.windowClose),
    isMaximized: () => ipcRenderer.invoke(INVOKE.windowIsMaximized),
    setAlwaysOnTop: (enabled?: boolean) => ipcRenderer.invoke(INVOKE.windowSetAlwaysOnTop, { enabled }),
    isAlwaysOnTop: () => ipcRenderer.invoke(INVOKE.windowIsAlwaysOnTop)
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
