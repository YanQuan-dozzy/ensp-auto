#!/usr/bin/env node
/**
 * patch-electron-exe.cjs —— 给 node_modules/electron/dist/electron.exe 打应用身份补丁，
 * 并产出 dev 进程本体 eNSPAuto.exe（任务栏名称的最后兜底）。
 *
 * Windows 任务栏身份链（v2.17 / v2.18 身份修复的实测结论）：
 *   1. 进程 setAppUserModelId 后，任务栏按「AUMID → 开始菜单/桌面里带同 AUMID 的 .lnk」
 *      解析名称/图标；实测本机 .lnk 的 AUMID 属性无法通过 IPropertyStore 写入
 *      （文件路径存储 ACCESSDENIED，ShellLink 对象 set/commit 成功也不落盘 ——
 *      现代 Windows 对 .lnk 属性写入有安全限制），此路不通。
 *   2. AUMID 无关联快捷方式时，任务栏名称回退 = 进程映像名（electron.exe → "Electron"），
 *      图标回退 = exe 资源（rcedit 补丁后已正确 —— 这就是「图标对、名称错」的由来）。
 *   3. 因此把进程本体改名：复制 electron.exe → eNSPAuto.exe（rcedit 补丁后的副本），
 *      并把 node_modules/electron/path.txt 指向它 —— electron 包与 electron-vite 的
 *      getElectronPath() 都读 path.txt，dev 启动链（npm run dev / start.cmd）全部生效。
 *
 * 步骤：
 *   A. rcedit 改 electron.exe 的 FileDescription/ProductName/图标/版本（幂等，已打跳过）；
 *   B. 复制为 dist/eNSPAuto.exe（仅当源较新或大小不同）；
 *   C. path.txt 写为 eNSPAuto.exe（eNSPAuto.exe 就位才写，防止悬空）。
 *
 * 幂等；electron/eNSPAuto.exe 被占用（应用正在运行）时仅警告不失败 ——
 * postinstall 里抛错会让 npm install 失败。npm install / postinstall 自动重打。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const rcedit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe')
const icon = ['enspauto.ico', 'app.ico']
  .map((n) => path.join(root, 'resources', n))
  .find((p) => fs.existsSync(p))
const version = require(path.join(root, 'package.json')).version

if (!fs.existsSync(electronExe)) {
  console.log('[patch-electron] electron.exe not found, skip')
  process.exit(0)
}
if (!fs.existsSync(rcedit)) {
  console.log('[patch-electron] rcedit not found, skip')
  process.exit(0)
}

// 幂等检查：FileDescription 已是 eNSPAuto 就不再动（rcedit 改资源 ~100ms，省则省）
const probe = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${electronExe.replace(/'/g, "''")}').VersionInfo.FileDescription`],
  { encoding: 'utf8' }
)
if (probe.status === 0 && String(probe.stdout).trim() === 'eNSPAuto') {
  console.log('[patch-electron] already patched, skip')
} else {
  // 逐项调用 rcedit（vendor 老版 rcedit 对一次传多个 --set-* 的组合调用会静默失败，
  // 单项调用实测稳定；某项失败单独告警，不拖垮其余项）
  const patchArgs = []
  if (icon) patchArgs.push(['--set-icon', icon])
  patchArgs.push(
    ['--set-version-string', 'FileDescription', 'eNSPAuto'],
    ['--set-version-string', 'ProductName', 'eNSPAuto'],
    ['--set-file-version', version],
    ['--set-product-version', version]
  )
  let failed = 0
  for (const one of patchArgs) {
    const r = spawnSync(rcedit, [electronExe, ...one], { encoding: 'utf8' })
    if (r.status !== 0 || r.error) {
      failed++
      console.warn(
        `[patch-electron] rcedit ${one[0]} failed (electron running? close it and rerun):`,
        String(r.stderr || r.stdout || (r.error && r.error.message) || '').trim()
      )
    }
  }
  if (failed === 0) {
    console.log('[patch-electron] patched:', electronExe)
  }
}

// ---- B/C：产出 dist/eNSPAuto.exe 并把 path.txt 重定向（dev 进程本体 = eNSPAuto）----
const appExe = path.join(root, 'node_modules', 'electron', 'dist', 'eNSPAuto.exe')
const pathTxt = path.join(root, 'node_modules', 'electron', 'path.txt')
try {
  const src = fs.statSync(electronExe)
  let needCopy = true
  try {
    const dst = fs.statSync(appExe)
    needCopy = src.size !== dst.size || src.mtimeMs > dst.mtimeMs
  } catch {}
  if (needCopy) {
    fs.copyFileSync(electronExe, appExe)
    console.log('[patch-electron] copied dist/eNSPAuto.exe')
  }
  if (fs.existsSync(appExe) && fs.readFileSync(pathTxt, 'utf-8') !== 'eNSPAuto.exe') {
    fs.writeFileSync(pathTxt, 'eNSPAuto.exe', 'utf-8')
    console.log('[patch-electron] path.txt -> eNSPAuto.exe')
  }
} catch (e) {
  // eNSPAuto.exe 正在运行时复制会被锁 —— 保持现状即可，下次启动前会再补
  console.warn('[patch-electron] eNSPAuto.exe sync failed (running? ignore):', e.message)
}
process.exit(0)
