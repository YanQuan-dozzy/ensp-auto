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
  verifyExpectation,
  restoreSnapshot,
  saveConfiguration
} from '../.build/harness.mjs'
import { MockVrp } from '../mock-device/MockVrp.mjs'

const IFACE = 'GigabitEthernet0/0/0'

/**
 * 配置变更链路集成测试：真 TelnetClient + 真 MockVrp，验证
 * apply_config 的「自动快照 → 危险拦截 → 逐条下发 → 失败即停 → 期望校验」，
 * restore_snapshot 的「差异生成 + 主动回滚闸门」，以及变更记录落库。
 */

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

async function setup({ handlers = [], mockOpts = {}, gate = true } = {}) {
  const mock = new MockVrp({ ...mockOpts, handlers: configHandlers(handlers) })
  const port = await mock.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-it-'))
  const snapshots = new SnapshotStore(path.join(dir, 'snaps'))
  const changes = new ChangeStore(path.join(dir, 'changes'))
  const { session } = await DeviceSession.open(port, 'IT', {}, {
    onRaw() {},
    onClosed() {},
    onStateChanged() {}
  })
  const gateCalls = []
  const deviceId = session.id
  const ctx = {
    sessions: {
      get: (id) => (id === deviceId ? session : undefined),
      require: (id) => {
        if (id !== deviceId) throw new Error('设备未连接')
        return session
      }
    },
    settings: {},
    snapshots,
    changes,
    requestGate: async (req) => {
      gateCalls.push(req)
      return gate
    },
    signal: undefined
  }
  const teardown = async () => {
    session.close()
    await mock.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { mock, session, deviceId, snapshots, changes, ctx, gateCalls, teardown }
}

const okCommand = (clean, fields = {}) => ({
  ok: true,
  clean,
  raw: clean,
  prompt: '[Huawei]',
  view: 'system',
  settled: 'prompt',
  awaitingConfirm: false,
  ms: 1,
  ...fields
})

test('apply_config：自动快照 → 逐条下发 → 期望校验通过 → 变更记录落库', async () => {
  const { mock, deviceId, snapshots, changes, ctx, teardown } = await setup({
    handlers: [
      {
        match: /^display ip interface brief$/i,
        respond: () => ({
          text: `${IFACE}        10.0.0.10/24     up                up`
        })
      }
    ]
  })
  try {
    const res = await applyConfig.handler(
      {
        deviceId,
        commands: [`interface ${IFACE}`, 'ip address 10.0.0.10 255.255.255.0'],
        description: '配置接口 IP',
        expectation: { command: 'display ip interface brief', expect: '10.0.0.10', mode: 'contains' }
      },
      ctx
    )
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.deepEqual(res.data.applied, [`interface ${IFACE}`, 'ip address 10.0.0.10 255.255.255.0'])
    assert.ok(res.data.snapshotId)
    assert.equal(res.data.verified, true)
    assert.ok(snapshots.latest(deviceId), '写操作前应自动采集快照')

    const change = changes.latest(deviceId)
    assert.equal(change.kind, 'apply')
    assert.equal(change.result, 'ok')
    assert.equal(change.verified, true)
    assert.equal(change.snapshotId, res.data.snapshotId)
    assert.deepEqual(change.commands, [`interface ${IFACE}`, 'ip address 10.0.0.10 255.255.255.0'])
    assert.ok(mock.receivedCommands.includes('system-view'), '下发前应先进入系统视图')
  } finally {
    await teardown()
  }
})

test('apply_config：危险命令整体拦截，不进入系统视图', async () => {
  const { mock, deviceId, changes, ctx, teardown } = await setup()
  try {
    const res = await applyConfig.handler(
      { deviceId, commands: ['save'], description: '非法尝试' },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'DANGER_COMMAND_BLOCKED')
    assert.ok(!mock.receivedCommands.includes('system-view'))
    assert.ok(!mock.receivedCommands.includes('save'))
    assert.equal(changes.latest(deviceId).result, 'blocked')
  } finally {
    await teardown()
  }
})

test('apply_config：中途失败停在失败点，后续命令不下发', async () => {
  const { mock, deviceId, changes, ctx, teardown } = await setup()
  try {
    const res = await applyConfig.handler(
      {
        deviceId,
        commands: [`interface ${IFACE}`, 'ip address 10.0.0.10 255.255.255.0', 'made-up-command'],
        description: '包含一条错误命令'
      },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'UNRECOGNIZED')
    assert.deepEqual(res.data.applied, [`interface ${IFACE}`, 'ip address 10.0.0.10 255.255.255.0'])
    assert.equal(res.data.failed.index, 2)
    assert.equal(res.data.failed.command, 'made-up-command')
    assert.equal(changes.latest(deviceId).result, 'failed')
    assert.ok(mock.receivedCommands.includes('made-up-command'))
  } finally {
    await teardown()
  }
})

test('apply_config：期望未达标 → EXPECTATION_UNMET 且 verified=false', async () => {
  const { deviceId, changes, ctx, teardown } = await setup()
  try {
    const res = await applyConfig.handler(
      {
        deviceId,
        commands: [`interface ${IFACE}`, 'ip address 10.0.0.10 255.255.255.0'],
        description: '改 IP',
        expectation: { command: 'display ip interface brief', expect: '10.0.0.99', mode: 'contains' }
      },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'EXPECTATION_UNMET')
    assert.equal(res.data.verified, false)
    assert.ok(
      typeof res.data.actual === 'string' && res.data.actual.includes('GigabitEthernet0/0/0'),
      '应带回实际回显供代理判断'
    )
    assert.equal(changes.latest(deviceId).result, 'failed')
  } finally {
    await teardown()
  }
})

test('apply_config：指定的快照不存在 → NO_SNAPSHOT，不执行任何命令', async () => {
  const { mock, deviceId, ctx, teardown } = await setup()
  try {
    const res = await applyConfig.handler(
      { deviceId, commands: ['x'], description: 'x', snapshotId: 'nope' },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'NO_SNAPSHOT')
    assert.ok(!mock.receivedCommands.includes('system-view'))
  } finally {
    await teardown()
  }
})

test('verify_expectation：三种模式各判一遍', async () => {
  const { deviceId, ctx, teardown } = await setup()
  try {
    const contains = await verifyExpectation.handler(
      { deviceId, command: 'display ospf peer', expect: 'Full', mode: 'contains' },
      ctx
    )
    assert.ok(contains.ok && contains.data.pass === true)

    const regex = await verifyExpectation.handler(
      { deviceId, command: 'display ospf peer', expect: 'State: F\\w+', mode: 'regex' },
      ctx
    )
    assert.ok(regex.ok && regex.data.pass === true)

    const notContains = await verifyExpectation.handler(
      { deviceId, command: 'display ospf peer', expect: 'Down', mode: 'notContains' },
      ctx
    )
    assert.ok(notContains.ok && notContains.data.pass === true)

    const failed = await verifyExpectation.handler(
      { deviceId, command: 'display ospf peer', expect: 'State: D\\w+', mode: 'regex' },
      ctx
    )
    assert.ok(failed.ok && failed.data.pass === false)
  } finally {
    await teardown()
  }
})

test('verify_expectation：非法正则 → BAD_PARAM', async () => {
  const { deviceId, ctx, teardown } = await setup()
  try {
    const res = await verifyExpectation.handler(
      { deviceId, command: 'display ospf peer', expect: 'State: [', mode: 'regex' },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'BAD_PARAM')
  } finally {
    await teardown()
  }
})

test('verify_expectation：times 重试直到收敛（协议等待场景，用桩会话）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-retry-'))
  try {
    let calls = 0
    const stub = {
      exec: async () => {
        calls++
        if (calls === 1) {
          return { ok: false, clean: '', raw: '', prompt: '', view: 'user', error: '忙', errorCode: 'BUSY', settled: 'prompt', awaitingConfirm: false, ms: 1 }
        }
        return okCommand('OSPF Process 1\n State: Full')
      }
    }
    const ctx2 = {
      sessions: { get: () => stub, require: () => stub },
      settings: {},
      snapshots: new SnapshotStore(path.join(dir, 's')),
      changes: new ChangeStore(path.join(dir, 'c')),
      requestGate: async () => true
    }
    const res = await verifyExpectation.handler(
      { deviceId: 'x', command: 'display ospf peer', expect: 'Full', mode: 'contains', times: 2 },
      ctx2
    )
    assert.ok(res.ok && res.data.pass === true)
    assert.equal(calls, 2, '首次失败后应重试')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function currentConfigResponse() {
  return {
    match: /^display current-configuration$/i,
    respond: () => ({
      text: [
        'sysname Huawei',
        '#',
        `interface ${IFACE}`,
        ' ip address 10.0.0.2 255.255.255.0',
        ' undo shutdown',
        '#',
        'return'
      ].join('\r\n')
    })
  }
}

test('restore_snapshot：配置与快照一致 → 不弹闸门、无需回滚', async () => {
  const baseline =
    'sysname Huawei\n#\ninterface GigabitEthernet0/0/0\n ip address 10.0.0.1 255.255.255.0\n#\nreturn'
  const { deviceId, snapshots, changes, ctx, gateCalls, teardown } = await setup()
  try {
    snapshots.save(deviceId, baseline, 'baseline')
    const res = await restoreSnapshot.handler({ deviceId, reason: '无差异测试' }, ctx)
    assert.ok(res.ok)
    assert.equal(res.data.appliedCommands, 0)
    assert.equal(res.data.upToDate, true)
    assert.equal(gateCalls.length, 0, '无差异时不弹闸门')
    assert.equal(changes.latest(deviceId).result, 'ok')
  } finally {
    await teardown()
  }
})

test('restore_snapshot：有差异 → 弹闸门 → 逐条撤销到底', async () => {
  const oldCfg = [
    'sysname Huawei',
    '#',
    `interface ${IFACE}`,
    ' ip address 10.0.0.1 255.255.255.0',
    ' description Link-A',
    '#',
    'return'
  ].join('\n')
  const { deviceId, snapshots, changes, ctx, gateCalls, teardown } = await setup({
    handlers: [
      currentConfigResponse(),
      { match: /^undo ip address 10\.0\.0\.2 255\.255\.255\.0$/i, respond: () => ({ text: '' }) },
      { match: /^shutdown$/i, respond: () => ({ text: '' }) },
      { match: /^ip address 10\.0\.0\.1 255\.255\.255\.0$/i, respond: () => ({ text: '' }) },
      { match: /^description Link-A$/i, respond: () => ({ text: '' }) }
    ]
  })
  try {
    snapshots.save(deviceId, oldCfg, 'baseline')
    const res = await restoreSnapshot.handler({ deviceId, reason: '跑错参数了' }, ctx)
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.equal(gateCalls.length, 1, '主动回滚必须弹闸门')
    assert.equal(gateCalls[0].toolName, 'restore_snapshot')
    assert.equal(res.data.appliedCommands, 6)
    const change = changes.latest(deviceId)
    assert.equal(change.kind, 'restore')
    assert.equal(change.result, 'ok')
    assert.equal(change.snapshotId, snapshots.latest(deviceId).id)
  } finally {
    await teardown()
  }
})

test('restore_snapshot：用户拒绝闸门 → GATE_REJECTED 且记录 rejected', async () => {
  const oldCfg =
    'sysname Huawei\n#\ninterface GigabitEthernet0/0/0\n ip address 10.0.0.1 255.255.255.0\n#\nreturn'
  const { deviceId, snapshots, changes, ctx, gateCalls, teardown } = await setup({
    handlers: [currentConfigResponse()],
    gate: false
  })
  try {
    snapshots.save(deviceId, oldCfg, 'baseline')
    const res = await restoreSnapshot.handler({ deviceId, reason: '再确认一次' }, ctx)
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'GATE_REJECTED')
    assert.equal(gateCalls.length, 1)
    assert.equal(changes.latest(deviceId).result, 'rejected')
    assert.ok(!changes.latest(deviceId).verified)
  } finally {
    await teardown()
  }
})

test('save_configuration：获闸门批准后代答 [Y/N] 并留变更记录', async () => {
  const { mock, deviceId, changes, ctx, teardown } = await setup({
    handlers: [
      {
        match: /^save$/i,
        respond: () => ({ text: 'Are you sure to continue? [Y/N]:', noPrompt: true })
      },
      { match: /^y$/i, respond: () => ({ text: 'Now saving the current configuration...' }) }
    ]
  })
  try {
    const res = await saveConfiguration.handler({ deviceId }, ctx)
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.ok(mock.receivedCommands.includes('save'))
    assert.ok(mock.receivedCommands.includes('y'), '获批后代为应答确认')
    const change = changes.latest(deviceId)
    assert.equal(change.kind, 'save')
    assert.equal(change.result, 'ok')
    assert.deepEqual(change.commands, ['save'])
  } finally {
    await teardown()
  }
})