import { INVOKE } from '@shared/channels'
import { activeProfile } from '@shared/profiles'
import { app, ipcMain } from 'electron'
import { getApiKey } from '../settings/secrets'
import { locateEnsp } from '../core/ensp/launcher'
import { runDiagnostics } from '../core/diagnose'
import { showOpenDialogSafe } from './dialogs'
import type { Services } from '../services'
import type { BrowserWindow } from 'electron'

/**
 * eNSP 定位与一键体检。
 *
 * 本模块只做「校验 → 调服务 → 回传」，业务逻辑在 services / core。
 */
export function registerEnspIpc(services: Services, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(INVOKE.enspLocate, async () => locateEnsp(services.getSettings().ensp.exePath))

  // 手动指定：弹系统文件选择框（dialog 天然限定用户选中的文件，规避任意路径注入）
  ipcMain.handle(INVOKE.enspPickExe, async () => {
    const win = getWindow()
    const result = await showOpenDialogSafe(win, {
          title: '选择 eNSP 客户端主程序',
          filters: [{ name: 'eNSP 客户端', extensions: ['exe'] }],
          properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return { exePath: result.filePaths[0] }
  })

  // ————————————————— v1.4：环境体检 —————————————————

  ipcMain.handle(INVOKE.diagRun, async () => {
    const settings = services.getSettings()
    return runDiagnostics({
      settings,
      // 密钥不出主进程：体检需要它做探活，但报告里只回末 4 位。
      // v1.5：探活用的是当前活跃档案那把密钥（体检项与代理实际请求保持一致）。
      apiKey: getApiKey(activeProfile(settings.agent).id),
      userDataDir: app.getPath('userData'),
      mcp: services.getMcpStatus()
    })
  })

  // ————————————————— 技能（v1.3） —————————————————
}

