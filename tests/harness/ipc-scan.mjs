import fs from 'node:fs'
import path from 'node:path'

/**
 * IPC 源码扫描的**共享实现**（N82 / N83）。
 *
 * 为什么必须共享：`ipc-coverage` 与 `channel-parity` 两个对账用例各自手写了一套扫描正则 ——
 * 一个允许 `ipcMain.handle(` 与 `INVOKE.x` 之间夹注释/换行，另一个不允许，
 * 于是同一份源码在一边通过、在另一边**假失败**（并会诱导人改错代码去迁就正则）。
 * 路径推导同理：一边用 `'src'` 这种依赖 cwd 的相对路径，从非项目根目录直接跑就崩。
 */

export const ROOT = path.resolve(import.meta.dirname, '../..')
export const CHANNELS = path.join(ROOT, 'src/shared/channels.ts')
export const PRELOAD = path.join(ROOT, 'src/preload/index.ts')
export const IPC_DIR = path.join(ROOT, 'src/main/ipc')

/**
 * 主进程处理器扫描：允许 `(` 与 `INVOKE.` 之间夹注释与换行（主进程里写了大量解释性注释），
 * 上限 500 字符防止跨 handler 误吞。
 */
const HANDLE_RE = /ipcMain\.handle\((?:[\s\S]{0,500}?)INVOKE\.([A-Za-z0-9_]+)/g

/** `channels.ts` 里声明的通道名（INVOKE 与 EVENT 同文件，故用行首缩进 + 冒号形式抽取） */
export function readDeclaredKeys(source) {
  const s = source ?? fs.readFileSync(CHANNELS, 'utf8')
  return new Set([...s.matchAll(/^\s+([A-Za-z0-9_]+):\s*['"]/gm)].map((m) => m[1]))
}

/** INVOKE 块的键名（用于「每个 INVOKE 都有 handler」的正向对账） */
export function readInvokeKeys(source) {
  if (source) return keysOf(source, /INVOKE\.([A-Za-z0-9_]+)/g)
  const s = fs.readFileSync(CHANNELS, 'utf8')
  const block = /export const INVOKE = \{([\s\S]*?)\n\} as const/.exec(s)
  if (!block) return keysOf(s, /INVOKE\.([A-Za-z0-9_]+)/g)
  return new Set([...block[1].matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]))
}

/** main/ipc/** 里 `ipcMain.handle(INVOKE.x)` 实际处理了哪些通道 */
export function readHandledKeys() {
  const src = fs
    .readdirSync(IPC_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => fs.readFileSync(path.join(IPC_DIR, f), 'utf8'))
    .join('\n')
  return keysOf(src, HANDLE_RE)
}

/** preload 暴露了哪些通道 */
export function readPreloadUsedKeys() {
  return keysOf(fs.readFileSync(PRELOAD, 'utf8'), /INVOKE\.([A-Za-z0-9_]+)/g)
}

/** 各 ipc 模块源码（用于按文件统计行数等） */
export function ipcSourceFiles() {
  return fs
    .readdirSync(IPC_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: f, source: fs.readFileSync(path.join(IPC_DIR, f), 'utf8') }))
}

function keysOf(source, re) {
  return new Set([...source.matchAll(re)].map((m) => m[1]))
}