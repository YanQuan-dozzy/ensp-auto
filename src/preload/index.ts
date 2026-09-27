import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { EVENT, INVOKE } from '@shared/channels'
import type { RendererApi, StorageScopeId } from '@shared/api'
import type { Attachment } from '@shared/attachments'
import type { Device, DeviceId, GateDecision, Settings, TopologyLink, TopologyNode } from '@shared/types'
import type { QuestionAnswers } from '@shared/interaction'

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
      opts?: {
        rootId?: string | null
        startNodeId?: string | null
        attachments?: Attachment[]
        planMode?: boolean
      }
    ) => ipcRenderer.invoke(INVOKE.agentRun, { sessionId, text, ...(opts ?? {}) }),
    abort: (sessionId: string) => ipcRenderer.invoke(INVOKE.agentAbort, { sessionId }),
    gate: (sessionId: string, gateId: string, decision: GateDecision) =>
      ipcRenderer.invoke(INVOKE.agentGate, { sessionId, gateId, decision }),
    // v2.7：答案传 null 表示取消（关掉卡片），主进程会把它转成「按最合理假设继续」
    question: (sessionId: string, questionId: string, answers: QuestionAnswers | null) =>
      ipcRenderer.invoke(INVOKE.agentQuestion, { sessionId, questionId, answers }),
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
      ipcRenderer.invoke(INVOKE.sessionExport, { rootId, format }),
    // v2.2：会话管理（历史列表右键菜单）
    delete: (rootId: string) => ipcRenderer.invoke(INVOKE.sessionDelete, { rootId }),
    // v2.12：从某消息节点起截断分支（消息删除 / 重新生成）；keepSelf=true 只删后代（root 复位用）
    deleteNode: (rootId: string, nodeId: string, keepSelf?: boolean) =>
      ipcRenderer.invoke(INVOKE.sessionDeleteNode, { rootId, nodeId, keepSelf }),
    rename: (rootId: string, title: string) =>
      ipcRenderer.invoke(INVOKE.sessionRename, { rootId, title }),
    pin: (rootId: string, pinned: boolean) =>
      ipcRenderer.invoke(INVOKE.sessionPin, { rootId, pinned }),
    openInExplorer: (rootId: string) =>
      ipcRenderer.invoke(INVOKE.sessionOpenInExplorer, { rootId }),
    openDir: () => ipcRenderer.invoke(INVOKE.sessionOpenDir),
    // v2.7：任务清单（切入历史会话时恢复进度显示）
    todos: (rootId: string) => ipcRenderer.invoke(INVOKE.todoGet, { rootId }),
    // v2.8：可续跑会话（上次任务未收尾就被关掉/崩溃）
    resumable: () => ipcRenderer.invoke(INVOKE.sessionResumable),
    // F8：书签（阶段完成点）与分支对比
    setBookmark: (rootId: string, nodeId: string, bookmarked: boolean) =>
      ipcRenderer.invoke(INVOKE.sessionBookmark, { rootId, nodeId, bookmarked }),
    compare: (rootId: string, aNodeId: string, bNodeId: string, exportFile?: boolean) =>
      ipcRenderer.invoke(INVOKE.sessionCompare, {
        rootId,
        aNodeId,
        bNodeId,
        ...(exportFile ? { export: true } : {})
      })
  },
  // F6：跨设备的配置变更时间线（只读；纯消费 ChangeStore）
  changes: {
    list: (limit?: number) =>
      ipcRenderer.invoke(INVOKE.changesList, { ...(limit !== undefined ? { limit } : {}) }),
    remove: (id: string) => ipcRenderer.invoke(INVOKE.changesRemove, { id }),
    clear: () => ipcRenderer.invoke(INVOKE.changesClear),
    // v2.20：命令报告导出（参数直接透传，白名单校验在主进程 handler 里做）
    exportReport: (req) => ipcRenderer.invoke(INVOKE.changesExport, req ?? {})
  },
  topology: {
    clear: () => ipcRenderer.invoke(INVOKE.topologyClear),
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
      ipcRenderer.invoke(INVOKE.secretSet, { profileId, key }),
    // v2.3：模型管理页每行的连通性测试
    testProfile: (profileId: string) =>
      ipcRenderer.invoke(INVOKE.settingsTestProfile, { profileId })
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
    openPath: (target: 'userData' | 'exports' | 'attachments' | 'snapshots' | 'topology') =>
      ipcRenderer.invoke(INVOKE.appOpenPath, { target }),
    clearData: (scope: StorageScopeId) => ipcRenderer.invoke(INVOKE.appClearData, { scope }),
    pickDirectory: (title?: string) => ipcRenderer.invoke(INVOKE.appPickDir, { title }),
    changeUserDataDir: (args: { targetDir: string; migrateData: boolean }) =>
      ipcRenderer.invoke(INVOKE.appChangeUserDataDir, args),
    resetUserDataDir: () => ipcRenderer.invoke(INVOKE.appResetUserDataDir),
    relaunch: () => ipcRenderer.invoke(INVOKE.appRelaunch),
    // v2.3：外部链接（服务商密钥申请页）交给系统浏览器
    openExternal: (url: string) => ipcRenderer.invoke(INVOKE.appOpenExternal, { url })
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
      ipcRenderer.invoke(INVOKE.skillImportPath, { filePath }),
    // F13：从会话轨迹自动沉淀排障技能（默认不启用，需人工核对）
    distill: (rootId: string) => ipcRenderer.invoke(INVOKE.skillDistill, { rootId })
  },
  window: {
    minimize: () => ipcRenderer.invoke(INVOKE.windowMinimize),
    maximize: () => ipcRenderer.invoke(INVOKE.windowMaximize),
    close: () => ipcRenderer.invoke(INVOKE.windowClose),
    isMaximized: () => ipcRenderer.invoke(INVOKE.windowIsMaximized),
    setAlwaysOnTop: (enabled?: boolean) => ipcRenderer.invoke(INVOKE.windowSetAlwaysOnTop, { enabled }),
    isAlwaysOnTop: () => ipcRenderer.invoke(INVOKE.windowIsAlwaysOnTop)
  },
  // v2.1：剪贴板纯文本读写（会话的「复制」/「粘贴」按钮）
  clipboard: {
    readText: () => ipcRenderer.invoke(INVOKE.clipboardReadText),
    writeText: (text: string) => ipcRenderer.invoke(INVOKE.clipboardWriteText, { text })
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
