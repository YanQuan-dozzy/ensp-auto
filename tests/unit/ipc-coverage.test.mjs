import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ipcSourceFiles, readHandledKeys, readInvokeKeys } from '../harness/ipc-scan.mjs'

/**
 * IPC 通道覆盖率（T5.1 的守卫）。
 *
 * 为什么需要：把 1100 行的 `ipc/index.ts` 按域拆开是纯代码搬移，
 * 而「漏搬一个 handler」不会有任何编译期信号 —— 渲染层调用时才在运行期
 * 报 "No handler registered for ..."（而且往往要等用户点到那个按钮才发现）。
 *
 * 这里改从**源码**做静态对账：`shared/channels.ts` 的 INVOKE 每一项，
 * 都必须能在 `src/main/ipc/**` 里找到对应的 `ipcMain.handle(INVOKE.x)`。
 *
 * N82/N83：扫描正则与路径推导已抽到 `tests/harness/ipc-scan.mjs`，与 channel-parity 共用。
 */

test('T5.1 每个 INVOKE 通道都有对应的 ipcMain.handle（拆分时漏搬会被这里抓住）', () => {
  const wanted = readInvokeKeys()
  const handled = readHandledKeys()

  const missing = [...wanted].filter((k) => !handled.has(k))
  assert.deepEqual(missing, [], `以下通道没有处理器：${missing.join(', ')}`)
})

test('T5.1 没有为已不存在的通道注册处理器（反向对账）', () => {
  const wanted = readInvokeKeys()
  const extra = [...readHandledKeys()].filter((k) => !wanted.has(k))
  assert.deepEqual(extra, [], `以下处理器指向了不存在的通道：${extra.join(', ')}`)
})

test('T5.1 IPC 路由层单文件不超过 300 行', () => {
  const tooBig = ipcSourceFiles()
    .map(({ name, source }) => ({ name, lines: source.split('\n').length }))
    .filter((f) => f.lines > 300)
    .map((f) => `${f.name}(${f.lines} 行)`)
  assert.deepEqual(tooBig, [], `需要继续拆分：${tooBig.join(', ')}`)
})