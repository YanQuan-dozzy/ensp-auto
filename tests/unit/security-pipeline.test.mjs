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
  TelnetClient,
  TOOLS,
  toMcpTools,
  classifyDanger,
  isReadOnlyCommand,
  planDangerGate,
  GATE_DENIED_SUMMARY,
  parsePort,
  parsePortOr
} from '../.build/harness.mjs'
import { MockVrp } from '../mock-device/MockVrp.mjs'

/**
 * 第 1 轮「安全管道」回归用例（T1.1~T1.8）。
 *
 * 每条用例对应 CODE-REVIEW / OPTIMIZATION-PLAN 里的一个缺陷编号：
 * 闸门反向接线（R3）、命令内嵌 CR/LF 绕过（R4）、VRP 缩写绕过（R7）、
 * 确认提示被当成应答（R6）、[Y/N] 期间的半途下发（R5）、
 * 端口参数静默兜底（R8）、计划生成器抛裸异常（R9）、MCP 出口口径漂移（R31）。
 */

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ———————————————————— T1.1 危险闸门语义（决策 D1） ————————————————————

test('T1.1 闸门策略：read 直接跑，danger 默认问用户', () => {
  assert.deepEqual(planDangerGate({ risk: 'read', confirmDanger: true }), { kind: 'run' })
  assert.equal(planDangerGate({ risk: 'danger', confirmDanger: true }).kind, 'ask')
})

test('T1.1 闸门策略：关掉确认框 = 跳过确认直接执行（不是「一律拒绝」）', () => {
  const plan = planDangerGate({ risk: 'danger', confirmDanger: false })
  assert.equal(plan.kind, 'skip-confirm')
  assert.notEqual(plan.kind, 'deny', 'R3：false 曾被当成拒绝，导致危险工具永久失败')
  assert.ok(plan.note.includes('跳过确认'))
})

test('T1.1 闸门策略：被否的文案不谎称「用户拒绝」', () => {
  const denied = planDangerGate({ risk: 'danger', confirmDanger: true, aborted: true })
  assert.equal(denied.kind, 'deny')
  assert.ok(denied.reason.includes('未获批准'))
  assert.ok(!GATE_DENIED_SUMMARY.includes('用户拒绝'), '轨迹摘要不能把三种来源一律说成用户拒绝')
  assert.ok(!denied.summary.includes('用户拒绝'))
})

test('T1.1 命令级危险清单不受「关掉确认框」影响', () => {
  // 闸门开关只管“要不要问人”，清单拦截是另一层，永远生效
  assert.equal(classifyDanger('save').dangerous, true)
  assert.equal(classifyDanger('reboot').dangerous, true)
})

// ———————————————————— T1.2 命令内嵌 CR/LF（R4） ————————————————————

test('T1.2 多行命令：风险判定入口一律视为危险', () => {
  assert.equal(classifyDanger('display version\rreset saved-configuration').dangerous, true)
  assert.equal(classifyDanger('display version\nreboot').dangerous, true)
  assert.equal(classifyDanger('quit\rreboot').dangerous, true)
})

test('T1.2 多行命令：只读白名单不放行', () => {
  assert.equal(isReadOnlyCommand('display version\rreset saved-configuration'), false)
  assert.equal(isReadOnlyCommand('display version\nreboot'), false)
  assert.equal(isReadOnlyCommand('display version'), true, '单行正常命令不受影响')
  // 只有尾随换行、没有第二段内容 → 仍是「一条命令」，不算多行绕过；
  // 但换行符本身由 writeCommand 拒掉（INVALID_INPUT），不会原样发给设备。
  assert.equal(isReadOnlyCommand('display version\n'), true)
})

test('T1.2 TelnetClient：含换行的命令被拒绝下发，设备一个字节都收不到', async () => {
  const mock = new MockVrp()
  const port = await mock.listen()
  const client = new TelnetClient()
  try {
    await client.connect(port)
    const r = await client.exec('display version\rreset saved-configuration')
    assert.equal(r.ok, false)
    assert.equal(r.errorCode, 'INVALID_INPUT')
    assert.equal(
      mock.receivedCommands.some((c) => /reset saved-configuration/i.test(c)),
      false,
      '换行后的第二段命令绝不能到达设备'
    )

    // 连「尾随换行」也一并拒掉：载荷层不区分意图，只认「命令行不得跨行」
    const r2 = await client.exec('display version\n')
    assert.equal(r2.errorCode, 'INVALID_INPUT')
    assert.equal(mock.receivedCommands.includes('display version'), false)
  } finally {
    client.close()
    await mock.close()
  }
})

test('T1.2 apply_config：命令集里夹带多行命令 → 整体拦在闸门前', async () => {
  const { mock, deviceId, changes, ctx, teardown } = await setup()
  try {
    const res = await applyConfig.handler(
      { deviceId, commands: ['sysname IT', 'quit\rreboot'], description: '夹带多行' },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'DANGER_COMMAND_BLOCKED')
    assert.equal(mock.receivedCommands.includes('reboot'), false)
    const recs = changes.list(deviceId)
    assert.equal(recs.some((i) => i.result === 'blocked'), true, '拦截必须进变更记录')
  } finally {
    await teardown()
  }
})

// ———————————————————— T1.3 VRP 命令缩写（R7） ————————————————————

test('T1.3 缩写：危险命令的缩写形式全部命中', () => {
  for (const cmd of [
    'reb',
    'rebo',
    'sa',
    'sav',
    'res saved-configuration',
    'rese saved-configuration',
    'del flash:/vrpcfg.zip /unreserved',
    'und startup saved-configuration'
  ]) {
    assert.equal(classifyDanger(cmd).dangerous, true, `${cmd} 应被判为危险`)
  }
})

test('T1.3 缩写：只读命令的缩写形式可执行', () => {
  for (const cmd of ['dis ver', 'disp version', 'sho version', 'mor flash:/vrpcfg.zip']) {
    assert.equal(isReadOnlyCommand(cmd), true, `${cmd} 应通过白名单`)
  }
})

test('T1.3 缩写：正常配置命令不被误杀', () => {
  for (const cmd of ['vlan 10', 'system-view', 'undo shutdown', 'interface GigabitEthernet0/0/0']) {
    assert.equal(classifyDanger(cmd).dangerous, false, `${cmd} 不应被判为危险`)
  }
  for (const cmd of ['system-view', 'vlan 10', 'save', 'reboot']) {
    assert.equal(isReadOnlyCommand(cmd), false, `${cmd} 不应通过只读白名单`)
  }
})

// ———————————————————— T1.4 确认提示期间中止下发（R5 / D3） ————————————————————

test('T1.4 apply_config：命中 [Y/N] 立即停止，后续命令不下发、已下发列表准确', async () => {
  const { mock, deviceId, ctx, teardown } = await setup({
    handlers: [
      { match: /^sysname IT$/i, respond: () => ({ text: '' }) },
      {
        match: /^delete flash:\/test\.cfg$/i,
        respond: () => ({ text: 'Delete flash:/test.cfg? [Y/N]:', noPrompt: true })
      },
      { match: /^vlan 10$/i, respond: () => ({ text: '' }) }
    ]
  })
  try {
    const res = await applyConfig.handler(
      {
        deviceId,
        commands: ['sysname IT', 'delete flash:/test.cfg', 'vlan 10'],
        description: '验证确认提示中止'
      },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'INCOMPLETE')
    assert.deepEqual(res.data.applied, ['sysname IT'], '只有第一台真正生效的命令算 applied')
    assert.equal(res.data.awaitingConfirm.command, 'delete flash:/test.cfg')
    assert.ok(res.data.awaitingConfirm.prompt.includes('[Y/N]'))
    assert.equal(res.data.needsUserInput, true)
    assert.equal(mock.receivedCommands.includes('vlan 10'), false, '确认提示之后的命令绝不能再下发')
    assert.ok(res.error.message.includes('未自动回滚'))
  } finally {
    await teardown()
  }
})

// ———————————————————— T1.5 确认提示期间暂停队列推进（R6） ————————————————————

test('T1.5 确认提示挂起队列：排队命令不得被当成应答；显式应答插队', async () => {
  const mock = new MockVrp()
  const port = await mock.listen()
  const client = new TelnetClient()
  try {
    await client.connect(port)

    const p1 = client.exec('reboot')
    const p2 = client.exec('display version') // 设备正停在 [Y/N] 上，这条只能排队
    const r1 = await p1
    assert.equal(r1.awaitingConfirm, true)
    assert.equal(client.isAwaitingConfirm, true)

    await delay(150)
    assert.equal(
      mock.receivedCommands.includes('display version'),
      false,
      'R6：确认提示期间推进队列，会把排队的命令当成对 [Y/N] 的回答'
    )

    const r3 = await client.exec('n') // 显式应答
    assert.equal(r3.ok, false, '设备把 n 当未知命令，但应答本身已经发出')

    const r2 = await p2
    assert.equal(r2.ok, true)
    assert.equal(client.isAwaitingConfirm, false)

    const idx = (c) => mock.receivedCommands.indexOf(c)
    assert.ok(idx('n') >= 0 && idx('display version') >= 0)
    assert.ok(idx('n') < idx('display version'), '应答必须插队，排在早先排队的命令之前')
  } finally {
    client.close()
    await mock.close()
  }
})

// ———————————————————— T1.6 端口参数显式校验（R8） ————————————————————

test('T1.6 parsePort：缺失 / 非整数 / 越界一律拒绝，不兜底', () => {
  for (const bad of [undefined, null, '2004', 2004.5, 0, -1, 65536, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(parsePort(bad), null, `${String(bad)} 应被拒绝`)
  }
  assert.equal(parsePort(2004), 2004)
  assert.equal(parsePort(1), 1)
  assert.equal(parsePort(65535), 65535)
  // 默认值只对「未提供」生效
  assert.equal(parsePortOr(undefined, 2000), 2000)
  assert.equal(parsePortOr('abc', 2000), null)
})

test('T1.6 connect_device / register_device：缺端口或传字符串都报 BAD_PARAM，不去连默认端口', async () => {
  let connectCalls = 0
  const ctxStub = {
    settings: {},
    sessions: {
      connect: () => {
        connectCalls += 1
        throw new Error('端口非法时不应尝试连接')
      }
    }
  }
  for (const name of ['connect_device', 'register_device']) {
    const spec = TOOLS.find((t) => t.name === name)
    assert.ok(spec, `${name} 应存在于工具表`)

    const missing = await spec.handler({}, ctxStub)
    assert.equal(missing.ok, false, `${name} 缺端口必须失败`)
    assert.equal(missing.error.code, 'BAD_PARAM')

    const asString = await spec.handler({ port: '2004' }, ctxStub)
    assert.equal(asString.ok, false, `${name} 端口为字符串必须失败`)
    assert.equal(asString.error.code, 'BAD_PARAM')
  }
  assert.equal(connectCalls, 0, 'R8：绝不允许静默回退到 2000 端口去连一台不是目标设备')
})

// ———————————————————— T1.8 MCP 出口口径统一（R31） ————————————————————

test('T1.8 MCP 出口：danger 工具既不列出也不允许调用', () => {
  const danger = TOOLS.filter((t) => t.risk === 'danger')
  assert.ok(danger.length > 0, '必须真的存在 danger 工具，否则本例是空转')

  const exposed = toMcpTools(TOOLS).map((t) => t.name)
  assert.equal(exposed.length, TOOLS.length - danger.length, '外露集合 = 内置工具 − danger')
  for (const d of danger) {
    assert.equal(exposed.includes(d.name), false, `${d.name} 不应出现在 MCP 工具列表里`)
  }
})

// ———————————————————— 测试底座 ————————————————————

function configHandlers(extra = []) {
  return [
    { match: /^system-view$/i, respond: () => ({ text: '', prompt: '[Huawei]' }) },
    { match: /^quit$/i, respond: () => ({ text: '', prompt: '<Huawei>' }) },
    ...extra
  ]
}

async function setup({ handlers = [], mockOpts = {} } = {}) {
  const mock = new MockVrp({ ...mockOpts, handlers: configHandlers(handlers) })
  const port = await mock.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-sec-'))
  const snapshots = new SnapshotStore(path.join(dir, 'snaps'))
  const changes = new ChangeStore(path.join(dir, 'changes'))
  const { session } = await DeviceSession.open(port, 'SEC', {}, {
    onRaw() {},
    onClosed() {},
    onStateChanged() {}
  })
  const deviceId = session.id
  const ctx = {
    sessions: {
      get: (id) => (id === deviceId ? session : undefined),
      require: () => session
    },
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
