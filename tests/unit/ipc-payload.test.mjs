import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * IPC 载荷形状对账（N1 引入的守卫）。
 *
 * 为什么需要：`ipc-coverage` / `channel-parity` 只对 **名字层** 闭合（用了 = 处理了 = 声明了），
 * 抓不到「主进程返回对象、渲染层按字符串用」这类**返回值漂移**。
 * `app:pick-dir` 就是这样漂移了：`api.ts` 声明 `Promise<string | null>`，
 * 主进程却返回 `{ canceled, path }` —— 对象恒为 truthy，四个目录功能在 UI 上 100% 失败。
 *
 * 与上述两个对账用例一致，这里也**用源码文本扫描而不是 import**（ipc 层 import 了 electron）。
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const APP_IPC = path.join(ROOT, 'src/main/ipc/app.ts')
const API = path.join(ROOT, 'src/shared/api.ts')

function handlerBlock(source, channelKey) {
  const start = source.indexOf(`INVOKE.${channelKey}`)
  assert.ok(start >= 0, `未找到 ${channelKey} 处理器（ipc/app.ts 结构变了？）`)
  const rest = source.slice(start + `INVOKE.${channelKey}`.length)
  const next = rest.indexOf('ipcMain.handle')
  return next >= 0 ? rest.slice(0, next) : rest
}

test('N1 app:pick-dir 的处理器返回形状与 api.ts 声明一致（string | null，不是对象）', () => {
  const app = fs.readFileSync(APP_IPC, 'utf8')
  const block = handlerBlock(app, 'appPickDir')

  assert.ok(
    !/\{\s*canceled\s*:/.test(block),
    'appPickDir 不得返回 { canceled, path } 对象 —— 渲染层按 string | null 消费'
  )
  assert.match(block, /return\s+null/, '取消时应返回 null')
  assert.match(block, /filePaths\[0\]/, '选中时应返回路径字符串')
})

test('N1 api.ts 的 pickDirectory 声明为 string | null，且不再保留半成品 PickDirResult', () => {
  const api = fs.readFileSync(API, 'utf8')
  assert.match(
    api,
    /pickDirectory\(title\?: string\):\s*Promise<string \| null>/,
    'pickDirectory 契约应为 Promise<string | null>'
  )
  assert.ok(
    !/PickDirResult/.test(api),
    'PickDirResult 是 N1 的半成品残留（全仓 0 引用），应已删除'
  )
})