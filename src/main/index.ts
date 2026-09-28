import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { app, BrowserWindow, session, shell, nativeImage } from 'electron'
import { EVENT } from '@shared/channels'
import { CONTENT_SECURITY_POLICY } from '@shared/csp'
import { Services } from './services'
import { registerIpc } from './ipc'
import { applyBootstrapStorage } from './core/storage/bootstrap'

// 启动前引导：若用户配置了自定义 userData 目录，在此重定向生效
applyBootstrapStorage()

// ===== 应用身份（v2.23 定稿；Windows 三条身份链互不相同，勿混）=====
// ① 节点 A「进程 AUMID」→ 决定任务栏按钮的名称/图标。
//    规则：**设了 AUMID，就按「AUMID → 带该 AUMID 的快捷方式(.lnk)」解析**；解析不到
//    回退通用身份 electron.app.Electron（显示 "Electron"，且被 FeatureUsage/AppResolver
//    缓存住，改 exe 元数据也不刷新）。本机 Win11 无法给 .lnk 写 AUMID（STG_E_ACCESSDENIED，
//    HRESULT 级实测）→ **只有安装版能靠 NSIS 的快捷方式闭环**，故仅 app.isPackaged 时设。
// ② 节点 B「exe 元数据」→ 未设 AUMID 时的任务栏回退来源，也是通知显示名来源。
//    tools/patch-electron-exe.cjs 已把 electron.exe / eNSPAuto.exe 的 FileDescription、
//    ProductName、图标补成 eNSPAuto（postinstall + dev 前置自动重打）。
// ③ 节点 C「AUMID 注册表键」→ **只服务 Toast 通知**的名称/图标，不参与任务栏解析。
//    dev / 便携等无安装器场景由 ensureToastIdentity() 运行时自写。
//    改 AUMID 字面量必须全查 4 处：本文件 APP_ID / electron-builder.yml appId /
//    start.ps1 $AppAumid / tools/ensure-shortcut.ps1 $appAumid。
// ④ IconUri 是给系统进程（explorer）读的真实文件路径，不能指向 asar 虚拟路径
//    → ico 随包解到 app.asar.unpacked（见 electron-builder.yml asarUnpack），dev 下用项目 resources/。
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
  // ★ 只在「已安装」时声明 AUMID（v2.23 修正）。
  //
  // 为什么不能全场景设（上一版踩的坑）：一旦进程带显式 AUMID，任务栏解析名称/图标
  // 的第一优先来源就是「带该 AUMID 的快捷方式(.lnk)」；而本机（Win11）**无法用标准
  // API 给 .lnk 写 AUMID**（SHGetPropertyStoreFromParsingName → STG_E_ACCESSDENIED；
  // CLSID_ShellLink 对象 set/commit 返回 S_OK 但属性不落盘，已 HRESULT 级实测）。
  // 该来源永久缺失时，系统回退到通用身份 electron.app.Electron → 任务栏显示 "Electron"，
  // 且这个错误身份会被 FeatureUsage/AppResolver 缓存住，改 exe 元数据也不刷新。
  //
  // 安装版没这个问题：NSIS 注册的快捷方式天然带 appId 对应的 AUMID，解析链完整。
  // start.cmd / 便携 / dev 没有安装器 → 改为**不设 AUMID**，Explorer 走「启动快捷方式
  // 的名称/图标」或 exe 元数据（tools/patch-electron-exe.cjs 已把 eNSPAuto.exe 补成
  // 正确身份）→ 名称正确。这与 Boss-claw 的做法（dev 不设 AUMID）一致。
  //
  // 通知身份不依赖 setAppUserModelId：Electron 的 Notification 直接用进程默认 AUMID
  // （未显式设置时 Electron 会自动生成），其显示名取 exe 元数据 → 已是 eNSPAuto。
  // 注册表键仍然写：安装版之外的自定义 AUMID 场景（若将来启用）靠它兜底。
  if (app.isPackaged) {
    app.setAppUserModelId(APP_ID)
  }
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

let mainWindow: BrowserWindow | null = null
let services: Services | null = null

/** 打包态唯一允许加载的文档 URL（`file://` 精确匹配，见 N5）。 */
function rendererIndexUrl(): string {
  return pathToFileURL(path.join(import.meta.dirname, '../renderer/index.html')).href
}

/**
 * N5：导航白名单必须按**精确 URL/origin** 判定，不能用「协议前缀」。
 *
 * 旧写法 `url.startsWith('file://')` 会放行任意本地 HTML —— 而 preload 对每一次文档加载
 * 都生效，导航到 `file:///.../evil.html` 就等于把完整 `window.api`（含 `app:clear-data`、
 * `settings:set`）交给该页面。dev 态按 origin 比较，避免 dev server 的路径变化被误拦。
 */
function isAllowedNavigation(url: string): boolean {
  if (isDev && DEV_URL) {
    try {
      return new URL(url).origin === new URL(DEV_URL).origin
    } catch {
      return false
    }
  }
  return url === rendererIndexUrl()
}

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

  // 阻断任何试图导航到非白名单地址的请求（N5：精确 URL/origin，非协议前缀）
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  win.on('closed', () => {
    // N34-1：关闭后必须置 null —— 否则 second-instance 唤起与事件回传会一直指向已销毁窗口
    mainWindow = null
  })

  if (isDev && DEV_URL) {
    void win.loadURL(DEV_URL)
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}

/**
 * N4：单实例锁（重开决策 D6）。
 *
 * 为什么必须加：本仓 6 个 store 的 `persist` 都是「把整份内存态写盘」
 * （store/store.ts、topology/store.ts、skills/store.ts、session-tree/store.ts、
 * todo/store.ts、goals/store.ts）。两个实例并行时，后启动者会用自己启动时的快照
 * 覆盖对方刚写入的内容 —— 表现为「改过的设置自己回去了」「会话列表回退」这类
 * **不可复现的数据丢失**；两个实例还会争抢同一个 MCP 端口。T2.5 的唯一临时名只解决
 * 「写撕裂（半截文件）」，解决不了并发语义覆盖，故必须由锁来保证单写者。
 *
 * 副作用：会同时挡掉「dev 实例 + start.cmd 实例并存」的旧调试方式 ——
 * 要验证新代码请先彻底退出旧实例，再启动新实例。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  // 已有实例在跑：本进程直接退出，绝不初始化 Services / 建窗口（否则就是双份内存态）。
  app.quit()
} else {
  // 第二个实例被唤起时，把已有窗口拉到前台（用户双击两次 exe 只出一个窗口）。
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    // N5：CSP 的响应头通道（dev 之外）。打包态 `file://` 不经响应头，靠构建期注入的
    // `<meta>` 兜底（见 shared/csp.ts 与 electron.vite.config.ts）。
    if (!isDev) {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [CONTENT_SECURITY_POLICY]
          }
        })
      })
    }

    // N5：本应用不需要任何媒体 / 定位 / 通知 / 剪贴板读等权限 —— 一律拒绝。
    // 渲染层没有任何正当的权限请求来源，放行只会给将来的注入点留口子。
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

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
}
