import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 通道与处理器的一一对应（T5.3 引入的守卫）。
 *
 * 为什么值得一条用例：渲染层能调的一切都来自 preload 暴露的 `INVOKE.*`，
 * 而每个 `INVOKE.*` 必须在主进程有 `ipcMain.handle`。这类不一致（加了 preload
 * 忘了加 handler / 重构时删掉了 handler）在运行期表现为「点了按钮没反应」，
 * 是最难排查的一类故障，靠人眼审 1100 行的 ipc/index.ts 不现实。
 *
 * 这里刻意**用源码文本扫描**而不是 import：ipc 层 import 了 electron，
 * 一旦真去 import 就需要 Electron 运行时，测试就没法在纯 Node 下跑了。
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const PRELOAD = path.join(ROOT, 'src/preload/index.ts')
const CHANNELS = path.join(ROOT, 'src/shared/channels.ts')
const IPC_DIR = path.join(ROOT, 'src/main/ipc')

function readAll(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n')
}

function keysOf(source, re) {
  return new Set([...source.matchAll(re)].map((m) => m[1]))
}

test('每个 preload 暴露的通道，主进程都有对应处理器', () => {
  const preload = fs.readFileSync(PRELOAD, 'utf8')
  const channels = fs.readFileSync(CHANNELS, 'utf8')
  const ipc = readAll(IPC_DIR)

  const used = keysOf(preload, /INVOKE\.([A-Za-z0-9_]+)/g)
  const handled = keysOf(ipc, /ipcMain\.handle\(\s*INVOKE\.([A-Za-z0-9_]+)/g)
  const declared = keysOf(channels, /^\s+([A-Za-z0-9_]+):\s*['"]/gm)

  assert.ok(used.size > 0, '应当能扫到 preload 的通道引用')
  assert.deepEqual(
    [...used].filter((k) => !handled.has(k)).sort(),
    [],
    '以下通道在 preload 暴露了，但主进程没有处理器（点了没反应的根源）'
  )
  assert.deepEqual(
    [...handled].filter((k) => !declared.has(k)).sort(),
    [],
    '以下处理器引用了 channels.ts 里不存在的通道名'
  )
  assert.equal(handled.size, used.size, '通道数与处理器数应当一致')
})

test('事件通道名在 channels.ts 里唯一（避免两处同名互相顶掉）', () => {
  const channels = fs.readFileSync(CHANNELS, 'utf8')
  const names = [...channels.matchAll(/^\s+[A-Za-z0-9_]+:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  const seen = new Map()
  const dups = []
  for (const n of names) {
    if (seen.has(n)) dups.push(n)
    seen.set(n, true)
  }
  assert.deepEqual(dups, [], '通道字符串不得重复')
  assert.ok(names.length >= 70, `通道数量异常偏少：${names.length}`)
})
