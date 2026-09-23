import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * IPC 通道覆盖率（T5.1 的守卫）。
 *
 * 为什么需要：把 1100 行的 `ipc/index.ts` 按域拆开是纯代码搬移，
 * 而「漏搬一个 handler」不会有任何编译期信号 —— 渲染层调用时才在运行期
 * 报 "No handler registered for ..."（而且往往要等用户点到那个按钮才发现）。
 *
 * 这里改从**源码**做静态对账：`shared/channels.ts` 的 INVOKE 每一项，
 * 都必须能在 `src/main/ipc/**` 里找到对应的 `ipcMain.handle(INVOKE.x)`。
 */

const ROOT = 'src'
const CHANNELS = path.join(ROOT, 'shared', 'channels.ts')
const IPC_DIR = path.join(ROOT, 'main', 'ipc')

function readInvokeKeys() {
  const s = fs.readFileSync(CHANNELS, 'utf8')
  const block = s.match(/export const INVOKE = \{([\s\S]*?)\n\} as const/)
  assert.ok(block, '没能解析 INVOKE 定义（channels.ts 结构变了？）')
  const keys = [...block[1].matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1])
  assert.ok(keys.length > 50, `INVOKE 通道数异常：${keys.length}`)
  return keys
}

function readHandledKeys() {
  const handled = new Set()
  const files = fs
    .readdirSync(IPC_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(IPC_DIR, f))
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8')
    // 允许换行，也允许注释夹在中间（主进程里写了不少解释性注释）
    for (const m of s.matchAll(/ipcMain\.handle\((?:[\s\S]{0,500}?)INVOKE\.([A-Za-z0-9_]+)/g)) {
      handled.add(m[1])
    }
  }
  return handled
}

test('T5.1 每个 INVOKE 通道都有对应的 ipcMain.handle（拆分时漏搬会被这里抓住）', () => {
  const wanted = readInvokeKeys()
  const handled = readHandledKeys()

  const missing = wanted.filter((k) => !handled.has(k))
  assert.deepEqual(missing, [], `以下通道没有处理器：${missing.join(', ')}`)
})

test('T5.1 没有为已不存在的通道注册处理器（反向对账）', () => {
  const wanted = new Set(readInvokeKeys())
  const handled = [...readHandledKeys()]
  const extra = handled.filter((k) => !wanted.has(k))
  assert.deepEqual(extra, [], `以下处理器指向了不存在的通道：${extra.join(', ')}`)
})

test('T5.1 IPC 路由层单文件不超过 300 行', () => {
  const files = fs.readdirSync(IPC_DIR).filter((f) => f.endsWith('.ts'))
  const tooBig = []
  for (const f of files) {
    const n = fs.readFileSync(path.join(IPC_DIR, f), 'utf8').split('\n').length
    if (n > 300) tooBig.push(`${f}(${n} 行)`)
  }
  assert.deepEqual(tooBig, [], `需要继续拆分：${tooBig.join(', ')}`)
})
