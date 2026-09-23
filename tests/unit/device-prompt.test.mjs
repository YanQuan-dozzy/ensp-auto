import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DeviceSession,
  SnapshotStore,
  ChangeStore,
  applyConfig,
  answerDevicePrompt
} from '../.build/harness.mjs'
import { MockVrp } from '../mock-device/MockVrp.mjs'

/**
 * D2（2026-09-23）：设备停在 [Y/N] 后的应答通道。
 *
 * 反例来源：TelnetClient 的「显式应答」语义挂在调用时序上（confirmPaused 状态下的
 * 下一次 exec 即应答并插队），但工具层没有任何可用动作暴露它 ——
 * `run_show_command('y')` 被只读白名单拒，代理只能改用 apply_config，
 * 而 apply_config 的第一步「采集快照」就被设备当成应答吃掉。
 */

const IFACE = 'GigabitEthernet0/0/0'

function configHandlers(extra = []) {
  return [
    { match: /^system-view$/i, respond: () => ({ text: '', prompt: '[Huawei]' }) },
    { match: /^quit$/i, respond: () => ({ text: '', prompt: '<Huawei>' }) },
    {
      match: new RegExp(`^interface ${IFACE}$`, 'i'),
      respond: () => ({ text: '', prompt: `[Huawei-${IFACE}]` })
    },
    {
      match: /^ip address 10\.0\.0\.10 255\.255\.255\.0$/i,
      respond: () => ({ text: '' })
    },
    ...extra
  ]
}

async function setup({ handlers = [], mockOpts = {} } = {}) {
  const mock = new MockVrp({ ...mockOpts, handlers: configHandlers(handlers) })
  const port = await mock.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-prompt-'))
  const snapshots = new SnapshotStore(path.join(dir, 'snaps'))
  const changes = new ChangeStore(path.join(dir, 'changes'))
  const { session } = await DeviceSession.open(port, 'IT', {}, {
    onRaw() {},
    onClosed() {},
    onStateChanged() {}
  })
  const deviceId = session.id
  const ctx = {
    sessions: { get: (id) => (id === deviceId ? session : undefined), require: () => session },
    settings: {},
    snapshots,
    changes,
    requestGate: async () => true,
    signal: undefined
  }
  const teardown = async () => {
    session.close()
    await mock.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { mock, session, deviceId, snapshots, changes, ctx, teardown }
}

/** 只回确认提示、不给提示符 —— 真实设备此时确实不会发提示符 */
const confirmHandler = (match, promptText) => ({
  match,
  respond: () => ({ text: promptText, noPrompt: true })
})

test('D2：apply_config 停在 [Y/N] → INCOMPLETE，后续命令不下发', async () => {
  const { mock, session, deviceId, ctx, changes, teardown } = await setup({
    handlers: [
      confirmHandler(/^delete flash:\/vrpcfg\.zip$/i, 'Delete flash:/vrpcfg.zip? [Y/N]:'),
      { match: /^y$/i, respond: () => ({ text: 'Delete file successfully.' }) }
    ]
  })
  try {
    const res = await applyConfig.handler(
      {
        deviceId,
        commands: ['delete flash:/vrpcfg.zip'],
        description: '清理旧配置备份'
      },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'INCOMPLETE')
    assert.equal(res.data.needsUserInput, true)
    assert.ok(res.data.awaitingConfirm, '应回报挂起的确认提示')
    assert.equal(session.isAwaitingConfirm, true, '通信层应处于挂起态')
    assert.ok(
      session.awaitingConfirmText.includes('Y/N'),
      `应带回提示原文，实际：${session.awaitingConfirmText}`
    )
    assert.ok(mock.receivedCommands.includes('delete flash:/vrpcfg.zip'))
    assert.ok(!mock.receivedCommands.includes('y'), '绝不自作主张应答')
    assert.match(res.error.message, /answer_device_prompt/, 'INCOMPLETE 文案应指向应答工具')
    assert.equal(changes.latest(deviceId).result, 'failed')
  } finally {
    await teardown()
  }
})

test('D2：answer_device_prompt 应答 y → 设备继续执行，挂起解除', async () => {
  const { mock, session, deviceId, ctx, teardown } = await setup({
    handlers: [
      confirmHandler(/^delete flash:\/vrpcfg\.zip$/i, 'Delete flash:/vrpcfg.zip? [Y/N]:'),
      { match: /^y$/i, respond: () => ({ text: 'Delete file successfully.' }) }
    ]
  })
  try {
    await applyConfig.handler(
      { deviceId, commands: ['delete flash:/vrpcfg.zip'], description: '清理旧配置备份' },
      ctx
    )
    const res = await answerDevicePrompt.handler(
      { deviceId, answer: 'y', reason: '确认删除旧备份' },
      ctx
    )
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.equal(res.data.answered, 'y')
    assert.ok(res.data.confirmText.includes('Y/N'))
    assert.ok(mock.receivedCommands.includes('y'), '应答应真的下发到设备')
    assert.equal(session.isAwaitingConfirm, false, '应答后挂起应解除')
  } finally {
    await teardown()
  }
})

test('D2：无挂起提示时先校验再下发（不把 y 当普通命令）', async () => {
  let execCalls = 0
  const stub = {
    isAwaitingConfirm: false,
    awaitingConfirmText: '',
    exec: async () => {
      execCalls++
      throw new Error('不应被调用')
    }
  }
  const ctx = { sessions: { get: () => stub }, settings: {}, signal: undefined }
  const res = await answerDevicePrompt.handler(
    { deviceId: 'x', answer: 'y', reason: '误用' },
    ctx
  )
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'NO_PENDING_PROMPT')
  assert.equal(execCalls, 0, '无挂起提示时绝不下发')
})

test('D2：answer 非法 / reason 缺失 → BAD_PARAM', async () => {
  const stub = {
    isAwaitingConfirm: true,
    awaitingConfirmText: 'Are you sure? [Y/N]:',
    exec: async () => ({ ok: true, clean: '', raw: '', prompt: '[Huawei]', view: 'system', settled: 'prompt', awaitingConfirm: false, ms: 1 })
  }
  const ctx = { sessions: { get: () => stub }, settings: {}, signal: undefined }
  const bad = await answerDevicePrompt.handler({ deviceId: 'x', answer: 'yes', reason: 'r' }, ctx)
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'BAD_PARAM')
  const noReason = await answerDevicePrompt.handler({ deviceId: 'x', answer: 'y', reason: '  ' }, ctx)
  assert.equal(noReason.ok, false)
  assert.equal(noReason.error.code, 'BAD_PARAM')
})

test('D2：应答后又出现新提示 → INCOMPLETE 且带 nextPrompt', async () => {
  const stub = {
    isAwaitingConfirm: true,
    awaitingConfirmText: 'Delete file? [Y/N]:',
    exec: async () => ({
      ok: true,
      clean: 'Confirm again? [Y/N]:',
      raw: 'Confirm again? [Y/N]:',
      prompt: '',
      view: 'other',
      settled: 'quiet',
      awaitingConfirm: true,
      confirmText: 'Confirm again? [Y/N]:',
      ms: 1
    })
  }
  const ctx = { sessions: { get: () => stub }, settings: {}, signal: undefined }
  const res = await answerDevicePrompt.handler({ deviceId: 'x', answer: 'y', reason: '确认' }, ctx)
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'INCOMPLETE')
  assert.equal(res.data.nextPrompt, 'Confirm again? [Y/N]:')
})
