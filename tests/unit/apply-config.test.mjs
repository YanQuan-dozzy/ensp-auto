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
  saveConfiguration,
  resetSavedConfiguration
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

async function setup({ handlers = [], mockOpts = {}, gate = true, confirmDanger = true } = {}) {
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
    // v2.28：命令级清单放行资格由出口显式给出（缺省 false = 保守拦截）
    commandGateRelease: confirmDanger === false,
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

test('apply_config：expectation.command 命中危险清单 → BAD_PARAM 且不下发（N13）', async () => {
  const { mock, deviceId, ctx, teardown } = await setup()
  try {
    const res = await applyConfig.handler(
      {
        deviceId,
        commands: [`interface ${IFACE}`],
        description: '带一条危险校验命令',
        expectation: { command: 'reset saved-configuration', expect: 'x', mode: 'contains' }
      },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'BAD_PARAM')
    assert.ok(
      !mock.receivedCommands.includes('reset saved-configuration'),
      '危险校验命令绝不能下发到设备（与 apply_config 的 commands 走同一道只读校验）'
    )
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

test('apply_config：设备已停在系统视图 → 跳过 system-view 直接下发（修复“无法进入系统视图”）', async () => {
  const { mock, session, deviceId, ctx, teardown } = await setup({
    handlers: [{ match: /^sysname Core-SW$/i, respond: () => ({ text: '' }) }]
  })
  try {
    // 上一段会话把设备留在了系统视图，连接后跟踪到的视图就是 system
    await session.exec('system-view')
    assert.equal(session.view, 'system')
    mock.receivedCommands.length = 0

    const res = await applyConfig.handler(
      { deviceId, commands: ['sysname Core-SW'], description: '改宿主名' },
      ctx
    )
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.ok(
      !mock.receivedCommands.includes('system-view'),
      '已在系统视图时不得再发 system-view（设备会回 Unrecognized command）'
    )
    assert.ok(mock.receivedCommands.includes('sysname Core-SW'))
  } finally {
    await teardown()
  }
})

test('apply_config：设备停在接口视图 → 先 return 回用户视图再进系统视图', async () => {
  const { mock, session, deviceId, ctx, teardown } = await setup({
    handlers: [
      { match: /^return$/i, respond: () => ({ text: '', prompt: '<Huawei>' }) },
      { match: /^sysname Core-SW$/i, respond: () => ({ text: '' }) }
    ]
  })
  try {
    await session.exec('system-view')
    await session.exec(`interface ${IFACE}`)
    assert.equal(session.view, 'interface')
    mock.receivedCommands.length = 0

    const res = await applyConfig.handler(
      { deviceId, commands: ['sysname Core-SW'], description: '改宿主名' },
      ctx
    )
    assert.ok(res.ok, JSON.stringify(res.error))
    const seq = mock.receivedCommands
    const iReturn = seq.indexOf('return')
    assert.ok(iReturn >= 0, '子视图应先 return 回用户视图')
    assert.equal(seq[iReturn + 1], 'system-view', 'return 之后应进系统视图')
    assert.ok(seq.indexOf('sysname Core-SW') > iReturn + 1)
  } finally {
    await teardown()
  }
})

test('apply_config：视图跟踪滞后于设备 → system-view 报错时退回重进，不判失败', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-viewstale-'))
  try {
    // 设备其实已在系统视图，但会话跟踪仍是 user（模拟用户在交互终端里手动切过视图）
    let inSystem = true
    const sent = []
    const exec = async (cmd) => {
      sent.push(cmd)
      if (cmd === 'return') {
        inSystem = false
        return okCommand('', { prompt: '<Huawei>', view: 'user' })
      }
      if (cmd === 'system-view') {
        if (inSystem) {
          return {
            ...okCommand('', { prompt: '[Huawei]', view: 'system' }),
            ok: false,
            errorCode: 'UNRECOGNIZED',
            error: '命令不存在'
          }
        }
        inSystem = true
        return okCommand('', { prompt: '[Huawei]', view: 'system' })
      }
      return okCommand('')
    }
    const stub = { view: 'user', exec }
    const ctx2 = {
      sessions: { get: () => stub, require: () => stub },
      settings: {},
      snapshots: new SnapshotStore(path.join(dir, 's')),
      changes: new ChangeStore(path.join(dir, 'c')),
      requestGate: async () => true
    }
    const res = await applyConfig.handler(
      { deviceId: '127.0.0.1:2008', commands: ['sysname X'], description: 'x' },
      ctx2
    )
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.deepEqual(
      sent.filter((c) => c !== 'display current-configuration'),
      ['system-view', 'return', 'system-view', 'sysname X'],
      '首次 system-view 报 Unrecognized 后应 return 重进，再下发'
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
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

test('verify_expectation：危险命令被拒且不下发（N2，曾架空计划模式硬约束）', async () => {
  const { mock, deviceId, ctx, teardown } = await setup()
  try {
    const res = await verifyExpectation.handler(
      { deviceId, command: 'reset saved-configuration', expect: 'x', mode: 'contains' },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'BAD_PARAM')
    assert.ok(
      !mock.receivedCommands.includes('reset saved-configuration'),
      'verify_expectation 是 risk:read，绝不能让危险命令经它下发'
    )
  } finally {
    await teardown()
  }
})

test('verify_expectation：非只读命令被拒（校验命令必须只读）', async () => {
  const { mock, deviceId, ctx, teardown } = await setup()
  try {
    const res = await verifyExpectation.handler(
      { deviceId, command: 'system-view', expect: 'x', mode: 'contains' },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'BAD_PARAM')
    assert.ok(!mock.receivedCommands.includes('system-view'))
  } finally {
    await teardown()
  }
})

test('N15 verify_expectation：嵌套量词正则 → BAD_PARAM 且立刻返回（不冻结主进程）', async () => {
  const { deviceId, ctx, teardown } = await setup()
  try {
    const t0 = Date.now()
    const res = await verifyExpectation.handler(
      { deviceId, command: 'display ospf peer', expect: '(a+)+$', mode: 'regex' },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'BAD_PARAM')
    assert.match(String(res.error.message), /嵌套量词|表达式不可用/)
    assert.ok(Date.now() - t0 < 5000, '必须在阈值内返回')
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

// ———————————————— v1.8：快照存储的信任边界回归 ————————————————

test('SnapshotStore.read：恶意/越权 id 一律拒绝（路径逃逸防护）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-snap-'))
  try {
    const store = new SnapshotStore(dir)
    const meta = store.save('127.0.0.1:2008', 'host config', 'base')
    // 合法 id 正常读
    assert.equal(store.read('127.0.0.1:2008', meta.id), 'host config')
    // 目录穿越 / 非法字符 / 超长 id 一律 null，不触碰磁盘
    assert.equal(store.read('127.0.0.1:2008', '../../etc/passwd'), null)
    assert.equal(store.read('127.0.0.1:2008', 'secret.txt'), null)
    assert.equal(store.read('127.0.0.1:2008', 'a'.repeat(100)), null)
    // 跨设备归属校验：别的设备读不到
    assert.equal(store.read('127.0.0.1:2009', meta.id), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('SnapshotStore：save 的 .txt 与索引原子一致，无孤儿文件（v1.8）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-snap-atom-'))
  try {
    const store = new SnapshotStore(dir)
    const meta = store.save('127.0.0.1:2008', 'cfg', 'base')
    // 正文落盘 + 索引可见
    assert.equal(store.latest('127.0.0.1:2008').id, meta.id)
    assert.equal(store.get('127.0.0.1:2008', meta.id).sizeBytes > 0, true)
    // 索引文件是唯一 JSON（无残留 .tmp）
    const leftovers = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.tmp') || f.includes('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// —— v2.27：失败带诊断、成功带预检（把「失败信号」变成「修正线索」） ——

test('apply_config：失败时带 diagnosis（错误码 → 根因/纠正/相关主题）', async () => {
  const { deviceId, ctx, teardown } = await setup()
  try {
    const res = await applyConfig.handler(
      {
        deviceId,
        commands: [`interface ${IFACE}`, 'made-up-command'],
        description: '包含一条错误命令'
      },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'UNRECOGNIZED')
    // 设备原文 + 诊断提示都要在 message 里（渲染层与 MCP 出口只看 message 也能拿到线索）
    assert.ok(res.error.message.includes('诊断提示'), '失败信息必须附诊断提示')
    assert.ok(res.error.message.includes('视图'), 'UNRECOGNIZED 的提示要点出「视图不对」这一主因')
    assert.ok(res.data.diagnosis, '结构化诊断要一并回传')
    assert.ok(res.data.diagnosis.causes.length > 0)
    assert.ok(res.data.diagnosis.fixes.length > 0)
    assert.ok(res.data.diagnosis.topics.includes('basics'))
  } finally {
    await teardown()
  }
})

test('apply_config：成功也回带 preflight 预检结论（trunk 未放行属「下发成功但业务不通」）', async () => {
  const { deviceId, ctx, teardown } = await setup({
    handlers: [{ match: /^port link-type trunk$/i, respond: () => ({ text: '' }) }]
  })
  try {
    const res = await applyConfig.handler(
      {
        deviceId,
        commands: [`interface ${IFACE}`, 'port link-type trunk'],
        description: '把上行口设为 trunk'
      },
      ctx
    )
    assert.equal(res.ok, true)
    assert.ok(Array.isArray(res.data.preflight), '成功返回里要带预检结论')
    const trunk = res.data.preflight.find((f) => f.rule === 'trunk-without-allow-pass')
    assert.ok(trunk, 'trunk 未放行必须被预检点出来')
    assert.equal(trunk.level, 'warn')
  } finally {
    await teardown()
  }
})

test('apply_config：规范命令集不产生 preflight 噪声', async () => {
  const { deviceId, ctx, teardown } = await setup({
    handlers: [
      { match: /^port link-type trunk$/i, respond: () => ({ text: '' }) },
      { match: /^port trunk allow-pass vlan 10 20$/i, respond: () => ({ text: '' }) }
    ]
  })
  try {
    const res = await applyConfig.handler(
      {
        deviceId,
        commands: [`interface ${IFACE}`, 'port link-type trunk', 'port trunk allow-pass vlan 10 20'],
        description: '规范化 trunk 口'
      },
      ctx
    )
    assert.equal(res.ok, true)
    assert.equal(
      res.data.preflight,
      undefined,
      '不该有预检告警：' + JSON.stringify(res.data.preflight)
    )
  } finally {
    await teardown()
  }
})

// ————————————————— v2.30：用户视图命令 / 目标视图 / 假成功安全网 / 清空启动配置 ————————————————

/** 只回确认提示、不给提示符 —— 真实设备此时确实不发提示符 */
const confirmHandler = (match, promptText) => ({
  match,
  respond: () => ({ text: promptText, noPrompt: true })
})

test('apply_config view:user：先 return 回用户视图，不再被顶到系统视图（实测翻车点的正解）', async () => {
  // confirmDanger:false = 用户已关掉「危险操作需人工确认」，与实测场景一致（否则危险命令会被闸门拦在视图问题之前）
  const { mock, session, deviceId, ctx, teardown } = await setup({
    confirmDanger: false,
    handlers: [
      { match: /^return$/i, respond: () => ({ text: '', prompt: '<Huawei>' }) },
      confirmHandler(
        /^reset saved-configuration$/i,
        'The configuration will be erased to reconfigure. Continue? [Y/N]:'
      )
    ]
  })
  try {
    // 上一段会话把设备留在系统视图
    await session.exec('system-view')
    assert.equal(session.view, 'system')
    mock.receivedCommands.length = 0

    const res = await applyConfig.handler(
      {
        deviceId,
        commands: ['reset saved-configuration'],
        description: '清空启动配置',
        view: 'user'
      },
      ctx
    )
    const seq = mock.receivedCommands
    assert.ok(!seq.includes('system-view'), 'view:user 时不得再进系统视图')
    assert.equal(seq[seq.indexOf('return') + 1], 'reset saved-configuration')
    // 命令确实到了设备并停在确认提示（与真实设备一致）
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'INCOMPLETE')
    assert.equal(session.isAwaitingConfirm, true)
  } finally {
    await teardown()
  }
})

test('apply_config 默认视图：用户视图命令失败时点破真正原因（不再是通用 Unrecognized 提示）', async () => {
  // confirmDanger:false = 用户已关掉「危险操作需人工确认」，与实测场景一致（命令被放行后才会撞上视图问题）
  const { mock, deviceId, ctx, teardown } = await setup({ confirmDanger: false })
  try {
    const res = await applyConfig.handler(
      { deviceId, commands: ['reset saved-configuration'], description: '清空启动配置' },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'UNRECOGNIZED')
    assert.ok(mock.receivedCommands.includes('system-view'), '默认视图下确实会先进系统视图')
    assert.match(res.error.message, /用户视图命令/, '失败文案必须点破「这是用户视图命令」')
    assert.match(res.error.message, /view:'user'/, '并给出可照做的参数写法')
    const rule = (res.data.preflight ?? []).find((f) => f.rule === 'user-view-command-in-system-view')
    assert.ok(rule, '结构化预检里也要有这条（模型先看预检就能少走一遍弯路）')
  } finally {
    await teardown()
  }
})

test('apply_config：回显收尾却没有提示符 → UNSETTLED，绝不报成功（AR3 假成功的出口）', async () => {
  const { mock, deviceId, changes, ctx, teardown } = await setup({
    handlers: [
      // 有回显、以换行收尾，但设备一个提示符都不发
      { match: /^sysname Silent$/i, respond: () => ({ text: 'Info: saving to flash...', noPrompt: true }) },
      { match: /^next-command$/i, respond: () => ({ text: 'should never run' }) }
    ]
  })
  try {
    const res = await applyConfig.handler(
      { deviceId, commands: ['sysname Silent', 'next-command'], description: '触发无提示符收尾' },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'UNSETTLED')
    assert.deepEqual(res.data.applied, [], '出问题的命令不算已下发')
    assert.equal(res.data.unsettled.command, 'sysname Silent')
    assert.ok(!mock.receivedCommands.includes('next-command'), '状态未知时绝不能继续下发')
    assert.ok(res.data.diagnosis, '带结构化诊断，便于模型取证')
    assert.equal(changes.latest(deviceId).result, 'failed')
  } finally {
    await teardown()
  }
})

test('apply_config：提示符没被宿主名锁定（ip pool 视图）也不算状态未知（防误报）', async () => {
  const { deviceId, ctx, teardown } = await setup({
    handlers: [{ match: /^ip pool vlan10$/i, respond: () => ({ text: '', prompt: '[Huawei-ip-pool-vlan10]' }) }]
  })
  try {
    /*
     * `[Huawei-ip-pool-vlan10]` 会被拆成 host=`Huawei-ip-pool`，与锁定的宿主名不符 →
     * 通信层不认它是提示符（settled=quiet、prompt=''），但设备其实是正常的。
     * 安全网必须靠「尾部形状」把它与「停在未识别提示上」区分开，否则 DHCP 这类视图会误报。
     */
    const res = await applyConfig.handler(
      { deviceId, commands: ['ip pool vlan10'], description: '建地址池' },
      ctx
    )
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.deepEqual(res.data.applied, ['ip pool vlan10'])
  } finally {
    await teardown()
  }
})

test('reset_saved_configuration：用户视图 + 自动代答 [Y/N] + 落变更记录（danger）', async () => {
  const { mock, session, deviceId, changes, ctx, teardown } = await setup({
    handlers: [
      { match: /^return$/i, respond: () => ({ text: '', prompt: '<Huawei>' }) },
      confirmHandler(
        /^reset saved-configuration$/i,
        'The configuration will be erased to reconfigure. Continue? [Y/N]:'
      ),
      { match: /^y$/i, respond: () => ({ text: 'Succeeded in clearing the configuration.' }) }
    ]
  })
  try {
    assert.equal(resetSavedConfiguration.risk, 'danger', '清空启动配置必须过人工闸门')
    await session.exec('system-view')
    mock.receivedCommands.length = 0

    const res = await resetSavedConfiguration.handler(
      { deviceId, reason: '实验前清空设备配置' },
      ctx
    )
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.equal(res.data.cleared, true)
    assert.equal(res.data.answered, true, '获批后应代答它自己触发的那次提示')
    const seq = mock.receivedCommands
    assert.ok(!seq.includes('system-view'), '这条命令只认用户视图，不得先顶到系统视图')
    assert.equal(seq[seq.indexOf('return') + 1], 'reset saved-configuration')
    assert.ok(seq.includes('y'))

    const change = changes.latest(deviceId)
    assert.equal(change.result, 'ok')
    assert.deepEqual(change.commands, ['reset saved-configuration'])
    assert.equal(change.description, '实验前清空设备配置')
  } finally {
    await teardown()
  }
})

test('reset_saved_configuration：设备不弹确认时照样成功，且不额外下发 y', async () => {
  const { mock, deviceId, ctx, teardown } = await setup({
    handlers: [
      { match: /^return$/i, respond: () => ({ text: '', prompt: '<Huawei>' }) },
      { match: /^reset saved-configuration$/i, respond: () => ({ text: 'Succeeded in clearing.' }) }
    ]
  })
  try {
    const res = await resetSavedConfiguration.handler({ deviceId, reason: '清空' }, ctx)
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.equal(res.data.answered, false)
    assert.ok(!mock.receivedCommands.includes('y'), '没有提示就绝不下发 y')
  } finally {
    await teardown()
  }
})