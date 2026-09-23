import path from 'node:path'
import fs from 'node:fs'
import { app, BrowserWindow, session, shell, nativeImage } from 'electron'
import { EVENT } from '@shared/channels'
import { Services } from './services'
import { registerIpc } from './ipc'
import { applyBootstrapStorage } from './core/storage/bootstrap'

// 启动前引导：若用户配置了自定义 userData 目录，在此重定向生效
applyBootstrapStorage()

// ===== 应用身份（对标 Boss-claw 的图标实现）=====
// - setName 决定系统（任务栏右键 / 窗口标题 / 通知等）显示的应用名；
// - setAppUserModelId 决定 Windows 任务栏按钮的分组与图标来源：
//   打包安装版由 NSIS 注册了同 AUMID 的快捷方式 → 显示项目图标（正常）；
//   dev / 便携运行（electron.exe .）没有该快捷方式 → Explorer 回退显示 exe 图标
//   （electron.exe = Electron 默认图标），BrowserWindow.icon 不生效 → 任务栏图标错误。
//   故仅在打包（app.isPackaged）时设置 AUMID；非打包运行让任务栏跟随窗口图标
//   （resources/app.ico），从而在 start.cmd / start.exe 下也能显示项目图标。
const APP_NAME = 'eNSPAuto'
const APP_ID = 'com.enspauto.desktop'

app.setName(APP_NAME)
if (process.platform === 'win32' && app.isPackaged) {
  app.setAppUserModelId(APP_ID)
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
