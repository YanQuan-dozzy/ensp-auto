import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { McpClientManager } from '../.build/harness.mjs'

/**
 * MCP 客户端的进程生命周期（B3：N14 / N49 / N50）。
 *
 * 为什么这些必须用**真子进程**测：这三条的失效模式都是「进程层面」的 —— 子进程成为孤儿、
 * 子进程死了界面还显示已连接、stderr 被丢掉导致查不到失败原因。用 mock 替身测不出来。
 * 这里直接 spawn `node -e` 起的桩服务器（不依赖任何外部可执行文件，CI 可跑）。
 */

const require = createRequire(import.meta.url)

let seq = 0
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ensp-mcp-${++seq}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待条件成立（用于「进程退出」「状态变更」这类异步信号） */
async function waitFor(fn, timeoutMs = 5000, stepMs = 50) {
  const until = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > until) return false
    await delay(stepMs)
  }
}

/** 进程是否存活（signal 0 只做权限/存在性检查） */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const stdioCfg = (id, script, extra = {}) => ({
  id,
  name: id,
  transport: 'stdio',
  url: '',
  command: process.execPath,
  args: ['-e', script],
  enabled: true,
  trusted: false,
  ...extra
})

test('N50 MCP：stdio 命令含 shell 分隔符 → 直接拒绝，不启动进程', async () => {
  const mgr = new McpClientManager()
  const [st] = await mgr.sync([stdioCfg('m-bad', '/*never*/', { command: 'node; rm -rf /' })])
  assert.equal(st.connected, false)
  assert.match(String(st.error), /分隔符/)
})

test('N14/N50 MCP：connect 超时不留孤儿子进程，且子进程 stderr 被收进日志', async (t) => {
  const dir = tmpDir(t)
  const pidFile = path.join(dir, 'pid.txt')
  // 桩：写出自己的 pid、往 stderr 吐一行诊断，然后永久挂起（永不响应 MCP initialize）
  const script = [
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    `process.stderr.write('BOOT-DIAG-LINE\\n')`,
    `setInterval(() => {}, 1000)`
  ].join(';')

  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => {
    warns.push(a.map(String).join(' '))
  }
  let pid = null
  try {
    const mgr = new McpClientManager({ connectTimeoutMs: 700 })
    const [st] = await mgr.sync([stdioCfg('m-hang', script)])
    assert.equal(st.connected, false)
    assert.match(String(st.error), /超时/)

    assert.ok(await waitFor(() => fs.existsSync(pidFile), 3000), '桩子进程应已写出 pid')
    pid = Number(fs.readFileSync(pidFile, 'utf8'))
    await mgr.closeAll()

    // N14：超时后必须 close 掉子进程 —— 否则每次 sync（启动 / 改配置都会触发）泄漏一个孤儿
    assert.equal(await waitFor(() => !isAlive(pid), 5000), true, `超时后子进程 ${pid} 仍是孤儿`)

    // N50：stderr 不再 ignore，启动失败/崩溃的线索必须可见
    assert.ok(
      warns.some((w) => w.includes('BOOT-DIAG-LINE')),
      `子进程 stderr 应进日志：${JSON.stringify(warns)}`
    )
  } finally {
    console.warn = origWarn
    if (pid !== null && isAlive(pid)) {
      try {
        process.kill(pid)
      } catch {
        /* 清理失败忽略 */
      }
    }
  }
})

test('N49 MCP：子进程连接后退出 → 状态如实变为「已断开」（不再长期假 connected）', async (t) => {
  const dir = tmpDir(t)
  const pidFile = path.join(dir, 'pid.txt')
  // 用真实 SDK 起一个 stdio MCP 服务器，连上后 400ms 自杀 —— 模拟「服务器崩溃」
  const serverEntry = require.resolve('@modelcontextprotocol/sdk/server/index.js')
  const stdioEntry = require.resolve('@modelcontextprotocol/sdk/server/stdio.js')
  const typesEntry = require.resolve('@modelcontextprotocol/sdk/types.js')
  const script = [
    `const { Server } = require(${JSON.stringify(serverEntry)})`,
    `const { StdioServerTransport } = require(${JSON.stringify(stdioEntry)})`,
    `const { ListToolsRequestSchema } = require(${JSON.stringify(typesEntry)})`,
    `const srv = new Server({ name: 'crashy', version: '1.0.0' }, { capabilities: { tools: {} } })`,
    `srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))`,
    `srv.connect(new StdioServerTransport()).then(() => {`,
    `  require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    `  setTimeout(() => process.exit(7), 400)`,
    `})`
  ].join(';')

  let changes = 0
  const mgr = new McpClientManager({ onChange: () => changes++ })
  try {
    const [st] = await mgr.sync([stdioCfg('m-crash', script)])
    assert.equal(st.connected, true, st.error ?? '')
    assert.ok(await waitFor(() => fs.existsSync(pidFile), 3000), '桩服务器应已启动')

    // 子进程 400ms 后退出 → onclose 应把状态改成未连接
    const died = await waitFor(
      () => mgr.list().some((s) => s.id === 'm-crash' && s.connected === false),
      6000
    )
    assert.equal(died, true, '子进程崩溃后状态必须变为未连接（否则界面长期显示已连接）')
    const after = mgr.list().find((s) => s.id === 'm-crash')
    assert.match(String(after.error), /断开/)
    assert.ok(changes > 0, '状态变化应触发 onChange（渲染层才会刷新）')
  } finally {
    await mgr.closeAll()
  }
})