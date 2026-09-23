import { INVOKE } from '@shared/channels'
import { ipcMain } from 'electron'
import { findTopologyFiles } from '../core/topology/findFiles'
import { showOpenDialogSafe } from './dialogs'
import type { TopologyLink, TopologyNode } from '@shared/types'
import { importTopoPath, toStr } from './helpers'
import type { Services } from '../services'
import type { BrowserWindow } from 'electron'

/**
 * 拓扑：读取 / 刷新 / 手动落库 / 导入导出 / 工程文件查找、节点与链路的入场校验（本文件末尾）。
 *
 * 本模块只做「校验 → 调服务 → 回传」，业务逻辑在 services / core。
 */
export function registerTopologyIpc(services: Services, getWindow: () => BrowserWindow | null): void {
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

  ipcMain.handle(
    INVOKE.topologyRemove,
    async (_e, args: { nodeIds?: unknown; linkKeys?: unknown }) => {
      // 删除墓碑（v0.6 F-5.6）：id/端点为白名单字符串数组，逐条校验
      const nodeIds = Array.isArray(args?.nodeIds)
        ? args.nodeIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : []
      const linkKeys = Array.isArray(args?.linkKeys)
        ? args.linkKeys.filter(
            (v): v is string => typeof v === 'string' && /^[^|]+\|[^|]+$/.test(v)
          )
        : []
      return services.topology.remove({ nodeIds, linkKeys })
    }
  )

  ipcMain.handle(INVOKE.topologyImportFile, async () => {
    // 弹系统文件选择框（dialog 天然限定用户选中文件，规避任意路径注入）
    const win = getWindow()
    const result = await showOpenDialogSafe(win, {
      title: '导入 eNSP 工程文件',
      filters: [{ name: 'eNSP 工程', extensions: ['topo'] }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return importTopoPath(services, result.filePaths[0])
  })

  // v1.2：拓扑发现（找 .topo，UI 快捷导入）
  ipcMain.handle(INVOKE.topologyFindFiles, async (_e, args: { directory?: string }) => {
    const directory = toStr(args?.directory) || undefined
    return findTopologyFiles({
      ...(directory ? { directory } : {}),
      activePath: services.topology.fileSourcePath
    })
  })

  // v1.2：按路径导入 .topo（校验在主进程做，与 import_topology_file 工具同规则）
  ipcMain.handle(INVOKE.topologyImportPath, async (_e, args: { filePath?: string }) => {
    const filePath = toStr(args?.filePath)
    if (!filePath) return null
    return importTopoPath(services, filePath)
  })

  // ————————————————— 设置与密钥 —————————————————
}

const ROLES = new Set(['router', 'switch', 'firewall', 'wlan', 'server', 'cloud', 'pc', 'unknown'])
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
    const ifaces = Array.isArray(o.interfaces)
      ? (o.interfaces as unknown[]).filter((v): v is string => typeof v === 'string')
      : undefined
    out.push({
      id,
      name,
      role,
      ...(toStr(o.model) ? { model: toStr(o.model) } : {}),
      ...(toStr(o.deviceId) ? { deviceId: toStr(o.deviceId) } : {}),
      ...(ifaces && ifaces.length > 0 ? { interfaces: ifaces } : {}),
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
