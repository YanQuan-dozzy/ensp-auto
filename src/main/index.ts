import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { app, BrowserWindow, session, shell, nativeImage } from 'electron'
import { EVENT } from '@shared/channels'
import { Services } from './services'
import { registerIpc } from './ipc'
import { applyBootstrapStorage } from './core/storage/bootstrap'

// 启动前引导：若用户配置了自定义 userData 目录，在此重定向生效
applyBootstrapStorage()

// ===== 应用身份（对标 Boss-claw 的图标实现）=====
// Windows 通知（Toast）的来源名称与图标由「进程 AUMID + 系统里该 AUMID 的注册信息」决定：
// 1) setAppUserModelId 声明进程身份，**必须与 electron-builder.yml 的 appId 完全一致**——
//    NSIS 安装版注册的快捷方式/注册表键用的就是 appId，对不上 → 系统查无此身份，
//    通知回退显示默认的 "Electron" 名称与图标（v2.12 修的正是这个不一致）。
// 2) dev / start.cmd / 便携版没有安装器代为注册 → 运行时自写
//    HKCU\Software\Classes\AppUserModelId\<APP_ID> 的 DisplayName + IconUri，
//    Explorer 查到该键即显示应用名与图标；查不到才回退 Electron 默认值。
//    ★ 任务栏按钮的名称/图标在设置 AUMID 后按「AUMID → 关联快捷方式」解析，注册表键
//    只服务 Toast 通知 —— start.ps1 创建 eNSPAuto.lnk 时会把同一 AUMID 写进 .lnk
//    （IPropertyStore/PKEY_AppUserModel_ID），两处必须一致，任务栏身份才不会退回 Electron。
// 3) IconUri 是给系统进程（explorer）读的真实文件路径，不能指向 asar 内部虚拟路径
//    → ico 随包解到 app.asar.unpacked（见 electron-builder.yml 的 asarUnpack），dev 下用项目 resources/。
const APP_NAME = 'eNSPAuto'
const APP_ID = 'cn.enspauto.workbench'

app.setName(APP_NAME)

/** 通知身份用的 ico 真实路径（asar 内的虚拟路径系统进程读不到，读 unpacked）。 */
function toastIconPath(): string | undefined {
  const base = app.getAppPath().replace('app.asar', 'app.asar.unpacked')
  for (const name of ['enspauto.ico', 'app.ico']) {
    const p = path.join(base, 'resources', name)
    if (fs.existsSync(p)) return p
  }
  return undefined
}

/** 确保 AUMID 在系统里有 DisplayName + IconUri（幂等覆盖写；失败静默——通知降级为系统默认显示）。 */
function ensureToastIdentity(): void {
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`
  const set = (name: string, value: string): void => {
    execFile('reg', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], () => undefined)
  }
  set('DisplayName', APP_NAME)
  const icon = toastIconPath()
  if (icon) set('IconUri', icon)
}

if (process.platform === 'win32') {
  // 所有 Windows 场景（安装版 / 便携版 / dev）都声明 AUMID 并自注册身份。
  // 任务栏分组行为不变：安装版对齐 NSIS 注册的身份；未注册场景仍跟随窗口图标。
  app.setAppUserModelId(APP_ID)
  ensureToastIdentity()
}

const DEV_URL = process.env['ELECTRON_RENDERER_URL']
const isDev = !!DEV_URL

/** 应用图标（nativeImage：窗口/任务栏/缩略图共用）。resources/ 在 dev 与打包后都位于 app 根下。 */
function appIcon(): Electron.NativeImage | undefined {
  const icoPath = path.join(app.getAppPath(), 'resources', 'enspauto.ico')
  const fallbackIco = path.join(app.getAppPath(), 'resources', 'app.ico')
  const p = fs.existsSync(icoPath) ? icoPath : fallbackIco
  if (!fs.existsSync(p)) return undefined
  const img = nativeImage.createFromPath(p)
  return img.isEmpty() ? undefined : img
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

let mainWindow: BrowserWindow | null = null
let services: Services | null = null

function createWindow(): BrowserWindow {
  const icon = appIcon()
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    frame: false, // 隐藏原生系统标题栏与控制按钮，由页面顶部栏托管
    autoHideMenuBar: true,
    backgroundColor: '#0f111a',
    title: 'eNSPAuto',
    icon,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => {
    // Windows 任务栏缩略图 / 右键预览小窗取的是窗口 ICON_SMALL，
    // 仅构造参数 icon 不足，需在这里显式重设一次（对标 Boss-claw 的实现）。
    if (process.platform === 'win32' && icon) win.setIcon(icon)
    win.show()
  })

  win.on('maximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send(EVENT.windowStateChanged, { isMaximized: true })
    }
  })

  win.on('unmaximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send(EVENT.windowStateChanged, { isMaximized: false })
    }
  })

  // 外链一律交给系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 阻断任何试图导航到非本地内容的请求
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  if (isDev && DEV_URL) {
    void win.loadURL(DEV_URL)
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP]
        }
      })
    })
  }

  services = new Services(() => mainWindow)
  registerIpc(services, () => mainWindow)

  // v0.4：按设置启动 MCP 服务（本地 HTTP，仅 127.0.0.1）
  void services.applyMcp().catch(() => undefined)

  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  services?.shutdown()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  services?.shutdown()
})
