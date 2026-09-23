import { INVOKE } from '@shared/channels'
import { ipcMain } from 'electron'
import { toStr } from './helpers'
import type { Services } from '../services'

/**
 * 外部 MCP 服务器：状态、同步、连通性测试。
 *
 * 本模块只做「校验 → 调服务 → 回传」，业务逻辑在 services / core。
 */
export function registerMcpIpc(services: Services): void {
  ipcMain.handle(INVOKE.mcpServers, async () => services.mcpServerStatuses())

  ipcMain.handle(INVOKE.mcpSync, async () => services.syncMcpClients())

  ipcMain.handle(INVOKE.mcpTestServer, async (_e, args: { id?: string }) => {
    const id = toStr(args?.id)
    if (!id) return null
    return services.testMcpServer(id)
  })

}

