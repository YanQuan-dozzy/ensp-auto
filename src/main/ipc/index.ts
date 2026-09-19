import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { EVENT, INVOKE } from '@shared/channels'
import type { ScanProgress } from '@shared/api'
import type { DeviceId, GateDecision, Settings, TopologyLink, TopologyNode } from '@shared/types'
import type { Services } from '../services'
import { setApiKey } from '../settings/secrets'
import { readTopoFile } from '../core/topology/fromProjectFile'

/**
 * IPC 路由层。
 *
 * 两条纪律（ARCHITECTURE.md §3.2）：
 * 1. 渲染层传入的任何参数都在这里重新校验，绝不信任
 * 2. 本层不含业务逻辑，只做「校验 → 调服务 → 回传」
 */

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function requireDeviceId(v: unknown): DeviceId {
  const s = toStr(v)
  if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(s)) throw new Error(`非法设备 ID：${s}`)
  return s
}

export function registerIpc(services: Services, getWindow: () => BrowserWindow | null): void {
  const emit = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  // ————————————————— 设备 —————————————————

  ipcMain.handle(INVOKE.deviceScan, async (_e, args: { start?: number; end?: number }) => {
    const start = Math.max(1, Math.min(65535, toInt(args?.start, 2000)))
    const end = Math.max(1, Math.min(65535, toInt(args?.end, 2050)))
    if (end < start) throw new Error('结束端口必须不小于起始端口')
    const devices = await services.sessions.scan(start, end, {
      onProgress: (p: ScanProgress) => emit(EVENT.scanProgress, p)
    })
    return devices
  })

  ipcMain.handle(INVOKE.deviceConnect, async (_e, args: { port?: number; name?: string }) => {
    const port = toInt(args?.port, 0)
    if (port < 1 || port > 65535) throw new Error('端口非法')
    const device = await services.sessions.connect(port, args?.name || undefined)
    // 型号探测异步补，不阻塞连接返回
    void services.sessions.probeDevice(device.id)
    return device
  })

  ipcMain.handle(INVOKE.deviceDisconnect, async (_e, args: { deviceId?: string }) => {
    services.sessions.disconnect(requireDeviceId(args?.deviceId))
  })

  ipcMain.handle(INVOKE.deviceRename, async (_e, args: { deviceId?: string; name?: string }) => {
    const device = services.sessions.rename(requireDeviceId(args?.deviceId), toStr(args?.name))
    if (!device) throw new Error('别名不能为空')
    return device
  })

  ipcMain.handle(INVOKE.deviceList, async () => services.sessions.list())

  // ————————————————— 终端 —————————————————

  ipcMain.handle(INVOKE.terminalWrite, async (_e, args: { deviceId?: string; data?: string }) => {
    const session = services.sessions.get(requireDeviceId(args?.deviceId))
    if (!session) return { accepted: false, queued: false }
    return session.writeInteractive(toStr(args?.data))
  })

  ipcMain.handle(
    INVOKE.terminalResize,
    async (_e, args: { deviceId?: string; cols?: number; rows?: number }) => {
      // resize 只影响渲染层排版；设备侧不做窗口尺寸协商（eNSP 场景不需要）
      const cols = toInt(args?.cols, 80)
      const rows = toInt(args?.rows, 24)
      return { cols, rows }
    }
  )

  ipcMain.handle(INVOKE.terminalBuffer, async () => '')
  ipcMain.handle(INVOKE.terminalClear, async () => true)

  // ————————————————— Agent —————————————————

  ipcMain.handle(INVOKE.agentRun, async (_e, args: { sessionId?: string; text?: string; rootId?: string | null; startNodeId?: string | null }) => {
    const sessionId = toStr(args?.sessionId)
    const text = toStr(args?.text).trim()
    if (!sessionId) throw new Error('缺少会话 ID')
    if (!text) throw new Error('指令不能为空')
    if (services.isAgentRunning(sessionId)) throw new Error('该会话已有任务在运行')
    const rootId = args?.rootId && /^s-[0-9a-f]{8}$/.test(args.rootId) ? args.rootId : null
    const startNodeId = args?.startNodeId && /^n-/.test(toStr(args.startNodeId)) ? toStr(args.startNodeId) : null
    void services.startAgent(sessionId, text, { rootId, startNodeId })
    return { started: true }
  })

  ipcMain.handle(INVOKE.agentAbort, async (_e, args: { sessionId?: string }) => ({
    aborted: services.abortAgent(toStr(args?.sessionId))
  }))

  ipcMain.handle(INVOKE.agentEnqueue, async (_e, args: { sessionId?: string; text?: string }) => {
    const sessionId = toStr(args?.sessionId)
    const text = toStr(args?.text).trim()
    if (!sessionId || !text) return { queued: false }
    return { queued: services.enqueueInput(sessionId, text) }
  })

  ipcMain.handle(
    INVOKE.agentGate,
    async (_e, args: { sessionId?: string; gateId?: string; decision?: string }) => {
      const decision: GateDecision = args?.decision === 'approve' ? 'approve' : 'reject'
      return {
        resolved: services.resolveGate(toStr(args?.sessionId), toStr(args?.gateId), decision)
      }
    }
  )

  // ————————————————— 会话树与报告 —————————————————

  ipcMain.handle(INVOKE.sessionList, async () => services.sessionTree.list())

  ipcMain.handle(INVOKE.sessionGet, async (_e, args: { rootId?: string }) => {
    const rootId = toStr(args?.rootId)
    if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')
    return services.sessionTree.getTree(rootId)
  })

  ipcMain.handle(INVOKE.sessionExport, async (_e, args: { rootId?: string; format?: string }) => {
    const rootId = toStr(args?.rootId)
    if (!/^s-[0-9a-f]{8}$/.test(rootId)) throw new Error('非法会话 ID')
    const format = args?.format === 'json' ? 'json' : 'md'
    return services.exportSessionReport(rootId, format)
  })

  // ————————————————— 拓扑 —————————————————

  ipcMain.handle(INVOKE.topologyGet, async () => services.topology.snapshot())

  ipcMain.handle(INVOKE.topologyRefresh, async () => services.refreshTopology())

  ipcMain.handle(
    INVOKE.topologySaveManual,
    async (_e, args: { nodes?: unknown[]; links?: unknown[] }) => {
      // 只接受白名单字段，防止渲染层污染持久化文件
      const nodes: TopologyNode[] = sanitizeNodes(args?.nodes)
      const links: TopologyLink[] = sanitizeLinks(args?.links)
      return services.topology.applyManual({ nodes, links })
    }
  )

  ipcMain.handle(INVOKE.topologyImportFile, async () => {
    // 弹系统文件选择框（dialog 天然限定用户选中文件，规避任意路径注入）
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '导入 eNSP 工程文件',
          filters: [{ name: 'eNSP 工程', extensions: ['topo'] }],
          properties: ['openFile']
        })
      : await dialog.showOpenDialog({
          title: '导入 eNSP 工程文件',
          filters: [{ name: 'eNSP 工程', extensions: ['topo'] }],
          properties: ['openFile']
        })
    if (result.canceled || !result.filePaths[0]) return null
    const { topology, report } = readTopoFile(result.filePaths[0])
    services.topology.setFile(topology)
    return { topology, report }
  })

  // ————————————————— 设置与密钥 —————————————————

  ipcMain.handle(INVOKE.settingsGet, async () => ({
    settings: services.getSettings(),
    hasApiKey: services.hasApiKey()
  }))

  ipcMain.handle(INVOKE.settingsSet, async (_e, patch: Partial<Settings>) => {
    // 只接受已知字段，避免渲染层塞入任意键污染持久化文件
    const safe: Partial<Settings> = {}
    if (patch?.theme === 'dark' || patch?.theme === 'light') safe.theme = patch.theme
    if (typeof patch?.deviceEncoding === 'string') safe.deviceEncoding = patch.deviceEncoding
    if (typeof patch?.terminalEchoAgentCommands === 'boolean') {
      safe.terminalEchoAgentCommands = patch.terminalEchoAgentCommands
    }
    if (Number.isFinite(patch?.scanStart)) safe.scanStart = toInt(patch?.scanStart, 2000)
    if (Number.isFinite(patch?.scanEnd)) safe.scanEnd = toInt(patch?.scanEnd, 2050)
    if (patch?.agent && typeof patch.agent === 'object') {
      const a = patch.agent
      const allowedProviders = ['deepseek', 'openai', 'anthropic', 'google', 'custom']
      safe.agent = {
        runtime: a.runtime === 'mock' ? 'mock' : 'react',
        provider: allowedProviders.includes(toStr(a.provider))
          ? (toStr(a.provider) as Settings['agent']['provider'])
          : 'deepseek',
        baseUrl: toStr(a.baseUrl),
        model: toStr(a.model),
        maxRounds: Math.max(1, Math.min(50, toInt(a.maxRounds, 12))),
        temperature: typeof a.temperature === 'number' ? a.temperature : 0.2
      }
    }
    if (patch?.panels && typeof patch.panels === 'object') {
      const p = patch.panels
      safe.panels = {
        left: Math.max(180, Math.min(420, toInt(p.left, 240))),
        right: Math.max(320, Math.min(640, toInt(p.right, 380))),
        leftCollapsed: !!p.leftCollapsed,
        rightCollapsed: !!p.rightCollapsed
      }
    }
    if (patch?.mcp && typeof patch.mcp === 'object') {
      safe.mcp = {
        enabled: !!patch.mcp.enabled,
        port: Math.max(1024, Math.min(65535, toInt(patch.mcp.port, 49150)))
      }
    }
    return {
      settings: services.updateSettings(safe),
      hasApiKey: services.hasApiKey()
    }
  })

  ipcMain.handle(INVOKE.secretHas, async () => ({ has: services.hasApiKey() }))

  ipcMain.handle(INVOKE.secretSet, async (_e, args: { key?: string }) => {
    setApiKey(toStr(args?.key))
    return { has: services.hasApiKey() }
  })
}

const ROLES = new Set(['router', 'switch', 'pc', 'unknown'])
const SOURCES = new Set(['file', 'discovered', 'manual'])

function sanitizeNodes(list: unknown): TopologyNode[] {
  if (!Array.isArray(list)) return []
  const out: TopologyNode[] = []
  for (const n of list) {
    if (!n || typeof n !== 'object') continue
    const o = n as Record<string, unknown>
    const id = toStr(o.id)
    const name = toStr(o.name)
    if (!id || !name) continue
    const role = ROLES.has(toStr(o.role)) ? (toStr(o.role) as TopologyNode['role']) : 'unknown'
    const x = typeof o.x === 'number' ? o.x : undefined
    const y = typeof o.y === 'number' ? o.y : undefined
    out.push({
      id,
      name,
      role,
      ...(toStr(o.model) ? { model: toStr(o.model) } : {}),
      ...(toStr(o.deviceId) ? { deviceId: toStr(o.deviceId) } : {}),
      ...(Number.isFinite(x) ? { x } : {}),
      ...(Number.isFinite(y) ? { y } : {})
    })
  }
  return out
}

function sanitizeLinks(list: unknown): TopologyLink[] {
  if (!Array.isArray(list)) return []
  const out: TopologyLink[] = []
  for (const l of list) {
    if (!l || typeof l !== 'object') continue
    const o = l as Record<string, unknown>
    const from = toStr(o.from)
    const to = toStr(o.to)
    if (!from || !to) continue
    out.push({
      id: toStr(o.id) || `${from}|${to}`,
      from,
      to,
      ...(toStr(o.label) ? { label: toStr(o.label) } : {}),
      source: SOURCES.has(toStr(o.source)) ? (toStr(o.source) as TopologyLink['source']) : 'manual'
    })
  }
  return out
}
