import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickCaptureTools,
  startCapture,
  stopCapture,
  attachCapture,
  executeTask
} from '../.build/harness.mjs'

/**
 * F10（2026-09-26）：事件驱动抓包 —— 从外部 MCP 工具清单里认出「起抓 / 停抓」，
 * 把它挂到 execute_task / batch_configure 的生命周期上。
 *
 * 三条不变量：
 * 1. 认不出工具就**什么都不做**（抓包是增强项，不能让实验失败）；
 * 2. 开关（wireshark.autoCapture，默认关）没开时一个外部工具都不调；
 * 3. 任务无论成功失败，停抓都要执行（否则抓包进程一直挂着）。
 */

const fakeMcp = (tools, calls, text = 'ok') => ({
  tools: () => tools,
  call: async (namespaced) => {
    calls.push(namespaced)
    return { ok: true, text: `${text}:${namespaced}` }
  }
})

// ———————————————————————— 工具名识别 ————————————————————————

test('pickCaptureTools：按名字认出起停配对', () => {
  const picked = pickCaptureTools([
    { namespaced: 'mcp__wireshark__start_capture', name: 'start_capture' },
    { namespaced: 'mcp__wireshark__stop_capture', name: 'stop_capture' }
  ])
  assert.equal(picked.start.name, 'start_capture')
  assert.equal(picked.stop.name, 'stop_capture')
  assert.equal(picked.reason, undefined)
})

test('pickCaptureTools：名字含蓄时回退到描述里找', () => {
  const picked = pickCaptureTools([
    { namespaced: 'a', name: 'live_iface', description: 'Begin packet capture on an interface' },
    { namespaced: 'b', name: 'halt_iface', description: 'Stop capture and return the pcap path' }
  ])
  assert.equal(picked.start.namespaced, 'a')
  assert.equal(picked.stop.namespaced, 'b')
})

test('pickCaptureTools：认不出时给出可读原因，且不给工具', () => {
  assert.match(pickCaptureTools([]).reason, /没有已连接/)
  const noStop = pickCaptureTools([{ namespaced: 'a', name: 'start_capture' }])
  assert.equal(noStop.start, null)
  assert.match(noStop.reason, /停止抓包/)
  const noStart = pickCaptureTools([{ namespaced: 'b', name: 'stop_capture' }])
  assert.equal(noStart.start, null)
  assert.match(noStart.reason, /开始抓包/)
})

test('pickCaptureTools：起停是同一把开关型工具 → 视为不可用（不猜参数）', () => {
  const picked = pickCaptureTools([
    { namespaced: 'mcp__wireshark__capture', name: 'capture', description: 'start or stop capture' }
  ])
  assert.equal(picked.start, null)
  assert.match(picked.reason, /开关型/)
})

// ———————————————————————— 起停编排 ————————————————————————

test('startCapture / stopCapture：认得出就起停各一次，并带回停止输出', async () => {
  const calls = []
  const mcp = fakeMcp(
    [
      { namespaced: 's', name: 'start_capture' },
      { namespaced: 'e', name: 'stop_capture' }
    ],
    calls
  )
  const session = await startCapture(mcp, '测试')
  assert.equal(session.active, true)
  const outcome = await stopCapture(mcp, session, '测试')
  assert.equal(outcome.started, true)
  assert.deepEqual(calls, ['s', 'e'])
  assert.match(outcome.text, /ok:e/, '停止工具的输出应被带回')
})

test('startCapture：认不出工具 → 不调用任何东西，只留原因', async () => {
  const calls = []
  const mcp = fakeMcp([{ namespaced: 'x', name: 'unrelated' }], calls)
  const session = await startCapture(mcp, '测试')
  assert.equal(session.active, false)
  assert.ok(session.note)
  assert.deepEqual(calls, [])
  const outcome = await stopCapture(mcp, session, '测试')
  assert.equal(outcome.started, false)
  assert.equal(outcome.text, undefined)
})

test('startCapture：启动失败也只是不抓（note 带原因）', async () => {
  const mcp = {
    tools: () => [
      { namespaced: 's', name: 'start_capture' },
      { namespaced: 'e', name: 'stop_capture' }
    ],
    call: async () => ({ ok: false, text: '', error: '需要管理员权限' })
  }
  const session = await startCapture(mcp, '测试')
  assert.equal(session.active, false)
  assert.match(session.note, /需要管理员权限/)
})

test('attachCapture：把抓包结论并进 data（data 不存在时兜底建对象）', () => {
  const merged = attachCapture({ ok: false, error: { code: 'X', message: 'y' }, meta: { ms: 1 } }, {
    started: true,
    text: '/tmp/a.pcap'
  })
  assert.equal(merged.ok, false)
  assert.equal(merged.data.capture.started, true)
  assert.equal(merged.data.capture.text, '/tmp/a.pcap')
})

// ———————————————————————— 生命周期闸门 ————————————————————————

const captureCtx = (autoCapture, calls) => ({
  settings: { wireshark: { autoCapture } },
  mcp: fakeMcp(
    [
      { namespaced: 'mcp__wireshark__start_capture', name: 'start_capture' },
      { namespaced: 'mcp__wireshark__stop_capture', name: 'stop_capture' }
    ],
    calls
  ),
  sessions: { get: () => undefined },
  requestGate: async () => false
})

test('execute_task：开启 autoCapture → 自动起停，并附 capture（失败路径也停）', async () => {
  const calls = []
  // vlan + 空 switches → 早期 BAD_PARAM 返回（data 不存在），正好验证「失败也要停抓 + 兜底建 data」
  const res = await executeTask.handler({ task: 'vlan', switches: [] }, captureCtx(true, calls))
  assert.equal(res.ok, false)
  assert.deepEqual(calls, ['mcp__wireshark__start_capture', 'mcp__wireshark__stop_capture'])
  assert.equal(res.data.capture.started, true)
})

test('execute_task：未开启 autoCapture → 一个外部工具都不调，也不附 capture', async () => {
  const calls = []
  const res = await executeTask.handler({ task: 'vlan', switches: [] }, captureCtx(false, calls))
  assert.equal(res.ok, false)
  assert.deepEqual(calls, [])
  assert.equal(res.data?.capture, undefined)
})

test('execute_task：没有外部 MCP 调用面时静默跳过（不因抓包影响任务）', async () => {
  const res = await executeTask.handler(
    { task: 'vlan', switches: [] },
    { settings: { wireshark: { autoCapture: true } }, sessions: { get: () => undefined } }
  )
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'BAD_PARAM')
})