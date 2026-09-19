import path from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import { Services } from './services'
import { registerIpc } from './ipc'

/**
 * 主进程入口。
 *
 * 安全配置是本文件最重要的部分（README 的安全红线在这里落地）：
 * - contextIsolation + nodeIntegration:false + sandbox
 * - 生产环境下发严格 CSP
 * - 拒绝一切新窗口与非本机导航
 */

const DEV_URL = process.env['ELECTRON_RENDERER_URL']
const isDev = !!DEV_URL

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
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#11111B',
    title: 'ensp-auto',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

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
