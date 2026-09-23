import { EVENT, INVOKE } from '@shared/channels'
import { app, dialog, ipcMain, shell } from 'electron'
import { formatBytes } from '@shared/attachments'
import { getDefaultUserDataDir } from '../core/storage/bootstrap'
import { showOpenDialogSafe } from './dialogs'
import type { StorageScope } from '../core/storage/usage'
import { toStr } from './helpers'
import type { Services } from '../services'
import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 应用级：信息、数据占用、清理、数据目录切换、重启、窗口控制。
 *
 * 本模块只做「校验 → 调服务 → 回传」，业务逻辑在 services / core。
 */
export function registerAppIpc(services: Services, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(INVOKE.appInfo, async () => {
    const defaultUserDataDir = getDefaultUserDataDir()
    const isCustomUserData = path.resolve(services.userDataDir) !== path.resolve(defaultUserDataDir)
    return {
      name: 'eNSPAuto',
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      platform: `${process.platform} ${process.arch}`,
      userDataDir: services.userDataDir,
      defaultUserDataDir,
      isCustomUserData,
      exportsDir: services.exportsDir,
      attachmentsDir: services.attachmentsDir,
      snapshotsDir: services.snapshotsDir
    }
  })

  ipcMain.handle(INVOKE.appStorage, async () => {
    const report = services.storageReport()
    return {
      ...report,
      // clearable 由主进程标注：渲染层不该自己维护「哪些能清」的名单
      entries: report.entries.map((e) => ({
        ...e,
        clearable: e.key === 'sessions' || e.key === 'attachments' || e.key === 'exports'
      }))
    }
  })

  ipcMain.handle(INVOKE.appOpenPath, async (_e, args: { target?: string }) => {
    let target = services.userDataDir
    if (args?.target === 'exports') target = services.exportsDir
    else if (args?.target === 'attachments') target = services.attachmentsDir
    else if (args?.target === 'snapshots') target = services.snapshotsDir
    else target = services.userDataDir

    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
    const err = await shell.openPath(target)
    if (err) throw new Error(err)
    return true
  })

  ipcMain.handle(INVOKE.appClearData, async (_e, args: { scope?: unknown }) => {
    const raw = toStr(args?.scope)
    const scope: StorageScope | null =
      raw === 'sessions' || raw === 'attachments' || raw === 'exports' ? raw : null
    if (!scope) throw new Error('不支持清理该数据范围')

    const entry = services.storageReport().entries.find((e) => e.key === scope)
    let dir = services.userDataDir
    if (scope === 'sessions') dir = path.join(services.userDataDir, 'sessions')
    else if (scope === 'attachments') dir = services.attachmentsDir
    else if (scope === 'exports') dir = services.exportsDir

    // 危险动作走原生确认框：文案里给出「多少文件、多大、哪个目录」，
    // 用户在系统弹窗上点确认，比在页面里点两下按钮更难误触
    const opts = {
      type: 'warning' as const,
      buttons: ['取消', '确认清理'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: `清理${entry?.label ?? ''}`,
      message: `确认清理「${entry?.label ?? scope}」？`,
      detail: `将删除 ${entry?.files ?? 0} 个文件（约 ${formatBytes(entry?.bytes ?? 0)}），此操作不可撤销。\n\n目录：${dir}`
    }
    const win = getWindow()
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts)
    if (response !== 1) {
      return { cancelled: true, scope: null, removedFiles: 0, freedBytes: 0 }
    }
    const r = services.clearData(scope)
    return { cancelled: false, ...r }
  })

  ipcMain.handle(INVOKE.appPickDir, async (_e, args?: { title?: string; defaultPath?: string }) => {
    const win = getWindow()
    const opts = {
      title: args?.title || '选择目录',
      defaultPath: args?.defaultPath,
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    }
    const result = await showOpenDialogSafe(win, opts)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, path: null }
    return { canceled: false, path: result.filePaths[0]! }
  })

  ipcMain.handle(
    INVOKE.appChangeUserDataDir,
    async (_e, args?: { targetDir?: unknown; migrateData?: unknown }) => {
      // R18：渲染层传来的任何东西都不可信 —— 空串/非字符串在这里就挡掉，
      // 别让 path.resolve('') 变成「把数据目录设成 cwd」
      const targetDir = toStr(args?.targetDir).trim()
      if (!targetDir) {
        throw new Error('目标路径无效：请选择一个具体目录')
      }
      // T4.4：把迁移进度桥到渲染层，让「换目录」期间界面有真实进度而不是假死
      return services.changeUserDataDir(targetDir, args?.migrateData === true, (p) => {
        getWindow()?.webContents.send(EVENT.storageMigrateProgress, p)
      })
    }
  )

  ipcMain.handle(INVOKE.appResetUserDataDir, async () => {
    return services.resetUserDataDir()
  })

  ipcMain.handle(INVOKE.appRelaunch, async () => {
    app.relaunch()
    app.exit(0)
  })

  // ————————————————— 窗口控制 —————————————————

  ipcMain.handle(INVOKE.windowMinimize, async () => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.minimize()
  })

  ipcMain.handle(INVOKE.windowMaximize, async () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return false
    if (win.isMaximized()) {
      win.unmaximize()
      return false
    } else {
      win.maximize()
      return true
    }
  })

  ipcMain.handle(INVOKE.windowClose, async () => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.close()
  })

  ipcMain.handle(INVOKE.windowIsMaximized, async () => {
    const win = getWindow()
    return win && !win.isDestroyed() ? win.isMaximized() : false
  })

  ipcMain.handle(INVOKE.windowSetAlwaysOnTop, async (_e, args: { enabled?: boolean } = {}) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return false
    const next = typeof args.enabled === 'boolean' ? args.enabled : !win.isAlwaysOnTop()
    win.setAlwaysOnTop(next, 'floating')
    return next
  })

  ipcMain.handle(INVOKE.windowIsAlwaysOnTop, async () => {
    const win = getWindow()
    return win && !win.isDestroyed() ? win.isAlwaysOnTop() : false
  })
}

