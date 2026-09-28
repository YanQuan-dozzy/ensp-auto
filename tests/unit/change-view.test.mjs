import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DeviceSession,
  SnapshotStore,
  ChangeStore,
  applyConfig,
  changeView,
  runShowCommand,
  ensureSystemView,
  ensureUserView,
  enterInterfaceView,
  normalizeViewTarget,
  isSafeInterfaceName,
  isReadOnlyCommand,
  isViewNavigationCommand,
  loneViewNavCommand
} from '../.build/harness.mjs'
import { MockVrp } from '../mock-device/MockVrp.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * v2.24：视图切换（change_view）。
 *
 * 修的是一个**工具面缺位**导致的错，而不是通信层 bug：
 * `quit` / `return` 既不在只读白名单里、也不属于配置变更，过去无处可去 ——
 * 模型调 run_show_command 被拒（报错），改调 apply_config 又会先被顶到系统视图，
 * 于是 `quit` 从「退回上一层」变成「回到用户视图」，**报成功却去错地方**。
 *
 * 这里钉住四条不变量：
 * ① 导航命令按「当前视图 → 目标视图」生成最少命令（且幂等：已在该视图不发命令）；
 * ② 接口名先校验再发字节（拼进命令的模型参数不得成为第二条命令）；
 * ③ 用户视图不认 `return` —— 跟踪滞后时按成功处理，不把必然结果报成故障；
 * ④ run_show_command 对 quit / return 给出指向本工具的文案，而不是一句「不允许」。
 */

const IFACE = 'GigabitEthernet 0/0/1'
/** 真实 VRP 提示符里接口名不带空格（[Huawei-GigabitEthernet0/0/1]）——
 *  带空格的提示符连通信层都不认（PROMPT_REJECT_RE 把含空白的括号内容判为正文） */
const IFACE_PROMPT = 'GigabitEthernet0/0/1'

function navHandlers(extra = []) {
  // extra 在前：MockVrp 取第一个命中的处理器，这样用例可以覆盖基线的行为（如 quit 的去向）
  return [
    ...extra,
    { match: /^system-view$/i, respond: () => ({ text: '', prompt: '[Huawei]' }) },
    { match: /^return$/i, respond: () => ({ text: '', prompt: '<Huawei>' }) },
    { match: /^quit$/i, respond: () => ({ text: '', prompt: '<Huawei>' }) },
    {
      match: new RegExp(`^interface ${IFACE}$`, 'i'),
      respond: () => ({ text: '', prompt: `[Huawei-${IFACE_PROMPT}]` })
    }
  ]
}

async function setup({ handlers = [], omitReturn = false } = {}) {
  const all = navHandlers(handlers).filter((h) => !(omitReturn && /return/i.test(h.match.source)))
  const mock = new MockVrp({ handlers: all })
  const port = await mock.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-nav-'))
  const snapshots = new SnapshotStore(path.join(dir, 'snaps'))
  const changes = new ChangeStore(path.join(dir, 'changes'))
  const { session } = await DeviceSession.open(port, 'NAV', {}, {
    onRaw() {},
    onClosed() {},
    onStateChanged() {}
  })
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

/** 只留真正「命令通道下发过」的那几条（握手/screen-length 不算业务命令） */
const business = (mock) => mock.receivedCommands.filter((c) => c.trim() !== '' && !/^screen-length/i.test(c.trim()))

test('change_view：接口视图 → system，按「return → system-view」最少命令切过去', async () => {
  const { mock, session, deviceId, ctx, teardown } = await setup()
  try {
    await session.exec('system-view') // 设备进入系统视图（会话跟踪同步更新）
    await session.exec(`interface ${IFACE}`) // 再进接口视图
    assert.equal(session.view, 'interface')
    const before = business(mock).length

    const res = await changeView.handler({ deviceId, target: 'system' }, ctx)
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.deepEqual(res.data.commands, ['return', 'system-view'])
    assert.equal(res.data.changed, true)
    assert.equal(res.data.view, 'system')
    assert.equal(res.data.from, 'interface')
    assert.deepEqual(business(mock).slice(before), ['return', 'system-view'])
  } finally {
    await teardown()
  }
})

test('change_view：已在目标视图 → 一个字都不发（幂等）', async () => {
  const { mock, session, deviceId, ctx, teardown } = await setup()
  try {
    // 起点：用户视图 → 目标是用户视图，不应有任何命令
    assert.equal(session.view, 'user')
    const before = business(mock).length
    const asUser = await changeView.handler({ deviceId, target: 'user' }, ctx)
    assert.ok(asUser.ok, JSON.stringify(asUser.error))
    assert.equal(asUser.data.changed, false)
    assert.deepEqual(asUser.data.commands, [])
    assert.equal(business(mock).length, before, '已在用户视图时不得下发 return（设备会回 Unrecognized）')

    // 进系统视图后再要 system，同样什么都不发
    await session.exec('system-view')
    const before2 = business(mock).length
    const asSystem = await changeView.handler({ deviceId, target: 'system' }, ctx)
    assert.ok(asSystem.ok, JSON.stringify(asSystem.error))
    assert.equal(asSystem.data.changed, false)
    assert.equal(business(mock).length, before2, '已在系统视图时不得再发 system-view')
  } finally {
    await teardown()
  }
})

test('change_view：接口视图 → user 用一条 return（绝对导航）', async () => {
  const { mock, session, deviceId, ctx, teardown } = await setup()
  try {
    await session.exec('system-view')
    await session.exec(`interface ${IFACE}`)
    const before = business(mock).length
    const res = await changeView.handler({ deviceId, target: 'user' }, ctx)
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.deepEqual(res.data.commands, ['return'])
    assert.equal(res.data.view, 'user')
    assert.deepEqual(business(mock).slice(before), ['return'])
  } finally {
    await teardown()
  }
})

test('change_view：跟踪说在接口视图、设备其实在用户视图 → 按成功处理并标 trackingStale', async () => {
  // 不给 return 处理器：设备对 return 回 Unrecognized = 它本来就在用户视图
  const { session, deviceId, ctx, teardown } = await setup({ omitReturn: true })
  try {
    session.view = 'interface' // 人为制造跟踪滞后（用户在交互终端里切过视图）
    const res = await changeView.handler({ deviceId, target: 'user' }, ctx)
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.equal(res.data.trackingStale, true, '靠 Unrecognized 兜回时要如实标记')
    assert.deepEqual(res.data.commands, ['return'])
    assert.equal(res.data.changed, true)
  } finally {
    await teardown()
  }
})

test('change_view：target=interface 必须给 interfaceName，且校验在发字节之前', async () => {
  const { mock, deviceId, ctx, teardown } = await setup()
  try {
    const missing = await changeView.handler({ deviceId, target: 'interface' }, ctx)
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'BAD_PARAM')
    assert.equal(business(mock).length, 0, '参数不全时不得下发任何命令')
  } finally {
    await teardown()
  }
})

test('change_view：接口名注入（换行 / 管道 / 分号）整体拒绝，设备一个字节都收不到', async () => {
  const { mock, deviceId, ctx, teardown } = await setup()
  try {
    for (const bad of [
      `GE0/0/1\r\nreboot`,
      `GE0/0/1 | include x`,
      `GE0/0/1;quit`,
      `GE0/0/1?`,
      `${'A'.repeat(60)}`
    ]) {
      const res = await changeView.handler({ deviceId, target: 'interface', interfaceName: bad }, ctx)
      assert.equal(res.ok, false, `应拒绝：${JSON.stringify(bad)}`)
      assert.equal(res.error.code, 'BAD_PARAM')
    }
    assert.equal(business(mock).length, 0, '非法接口名不得走到设备（连 ensureSystemView 也不许抢跑）')
  } finally {
    await teardown()
  }
})

test('change_view：合法接口名可进接口视图，且先确保系统视图', async () => {
  const { session, deviceId, ctx, teardown } = await setup()
  try {
    await session.exec('system-view')
    await session.exec(`interface ${IFACE}`) // 先待在接口视图，制造「不是 system」的起点
    const res = await changeView.handler({ deviceId, target: 'interface', interfaceName: IFACE }, ctx)
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.deepEqual(res.data.commands, ['return', 'system-view', `interface ${IFACE}`])
    assert.equal(res.data.view, 'interface')
  } finally {
    await teardown()
  }
})

test('change_view：设备拒绝命令时如实报错并带出已下发命令', async () => {
  const { deviceId, ctx, teardown } = await setup({
    handlers: [{ match: /^interface LoopBack 9$/i, respond: () => ({ text: '', unknown: true }) }]
  })
  try {
    const res = await changeView.handler({ deviceId, target: 'interface', interfaceName: 'LoopBack 9' }, ctx)
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'UNRECOGNIZED')
    assert.deepEqual(res.data.commands, ['system-view', 'interface LoopBack 9'])
    assert.match(res.error.message, /change_view|视图/, '错误信息要能指导模型下一步')
  } finally {
    await teardown()
  }
})

test('change_view：未连接设备 / 非法 target → NOT_CONNECTED / BAD_PARAM', async () => {
  const { deviceId, ctx, teardown } = await setup()
  try {
    const notConnected = await changeView.handler({ deviceId: '127.0.0.1:1', target: 'system' }, ctx)
    assert.equal(notConnected.ok, false)
    assert.equal(notConnected.error.code, 'NOT_CONNECTED')

    const badTarget = await changeView.handler({ deviceId, target: 'ospf' }, ctx)
    assert.equal(badTarget.ok, false)
    assert.equal(badTarget.error.code, 'BAD_PARAM')
  } finally {
    await teardown()
  }
})

test('run_show_command：quit / return 被拒时文案指向 change_view（而不是只说不允许）', async () => {
  const { deviceId, ctx, teardown } = await setup()
  try {
    for (const cmd of ['quit', 'return']) {
      const res = await runShowCommand.handler({ deviceId, command: cmd }, ctx)
      assert.equal(res.ok, false)
      assert.equal(res.error.code, 'NOT_ALLOWED_IN_READ_MODE')
      assert.match(res.error.message, /change_view/, `${cmd} 的拒绝文案必须给出替代工具`)
    }
    // 普通写命令仍走原来的文案（不要把所有拒绝都说成「请用 change_view」）
    const other = await runShowCommand.handler({ deviceId, command: 'sysname X' }, ctx)
    assert.equal(other.ok, false)
    assert.doesNotMatch(other.error.message, /change_view/)
  } finally {
    await teardown()
  }
})

test('导航命令与只读白名单是两套判据（quit/return 不进只读白名单）', () => {
  assert.equal(isViewNavigationCommand('quit'), true)
  assert.equal(isViewNavigationCommand(' return '), true)
  assert.equal(isViewNavigationCommand('return\nreboot'), false, '多行一律不算导航')
  assert.equal(isViewNavigationCommand('display version'), false)

  assert.equal(isReadOnlyCommand('quit'), false, 'quit 不得进只读白名单（否则 verify_expectation 也能切视图）')
  assert.equal(isReadOnlyCommand('return'), false)

  assert.equal(normalizeViewTarget('SYSTEM'), 'system')
  assert.equal(normalizeViewTarget('系统视图'), 'system')
  assert.equal(normalizeViewTarget('ospf'), null)

  assert.equal(isSafeInterfaceName('GigabitEthernet 0/0/1'), true)
  assert.equal(isSafeInterfaceName('GE0/0/1'), true)
  assert.equal(isSafeInterfaceName('Vlanif 10'), true)
  assert.equal(isSafeInterfaceName('Eth-Trunk 1'), true)
  assert.equal(isSafeInterfaceName('ge0/0/1\nquit'), false)
  assert.equal(isSafeInterfaceName(''), false)
})

test('change_view 不是并发安全工具（视图切换必须是并发屏障）', () => {
  assert.notEqual(changeView.concurrencySafe, true)
  assert.equal(changeView.risk, 'read', '不改配置，计划模式探索阶段也要能用')
})

test('apply_config：单独的 quit / return 被拒（工具选错了，且不该碰设备）', async () => {
  const { mock, deviceId, snapshots, ctx, teardown } = await setup()
  try {
    for (const cmd of ['quit', 'return']) {
      const res = await applyConfig.handler({ deviceId, commands: [cmd], description: '退一层视图' }, ctx)
      assert.equal(res.ok, false, `${cmd} 单独下发应被拒绝`)
      assert.equal(res.error.code, 'BAD_PARAM')
      assert.match(res.error.message, /change_view/, '拒绝文案必须给出正确的工具')
    }
    assert.equal(business(mock).length, 0, '误用不该碰到设备')
    assert.equal(snapshots.latest(deviceId), undefined, '这类调用没有变更意图，不该先采一份快照')
  } finally {
    await teardown()
  }
})

test('apply_config：批量下发中间的 quit 仍然合法（plans / 实验模板依赖这条写法）', async () => {
  const { mock, deviceId, ctx, teardown } = await setup({
    handlers: [
      // 中间这条 quit 是「接口视图 → 系统视图」，与单独一条 quit 的语义不同
      { match: /^quit$/i, respond: () => ({ text: '', prompt: '[Huawei]' }) },
      { match: /^ip address 10\.0\.0\.10 255\.255\.255\.0$/i, respond: () => ({ text: '' }) },
      { match: /^sysname X$/i, respond: () => ({ text: '' }) }
    ]
  })
  try {
    const res = await applyConfig.handler(
      {
        deviceId,
        commands: [`interface ${IFACE}`, 'ip address 10.0.0.10 255.255.255.0', 'quit', 'sysname X'],
        description: '接口配置后退回系统视图再改名'
      },
      ctx
    )
    assert.ok(res.ok, JSON.stringify(res.error))
    // 不钉整条时间线（快照/对比各自还有 display current-configuration），只钉「quit 夹在中间照常下发」
    const seq = business(mock)
    const i = seq.indexOf('ip address 10.0.0.10 255.255.255.0')
    assert.ok(i > 0, `应下发了接口配置：${seq.join(' | ')}`)
    assert.deepEqual(seq.slice(i - 1, i + 3), [
      `interface ${IFACE}`,
      'ip address 10.0.0.10 255.255.255.0',
      'quit',
      'sysname X'
    ])
    assert.deepEqual(res.data.applied, [
      `interface ${IFACE}`,
      'ip address 10.0.0.10 255.255.255.0',
      'quit',
      'sysname X'
    ])
  } finally {
    await teardown()
  }
})

test('loneViewNavCommand：只对「仅此一条」的导航命令生效', () => {
  assert.equal(loneViewNavCommand(['quit']), 'quit')
  assert.equal(loneViewNavCommand([' return ']), 'return')
  assert.equal(loneViewNavCommand(['quit', 'system-view']), null, '批量中间的 quit 不算误用')
  assert.equal(loneViewNavCommand([]), null)
  assert.equal(loneViewNavCommand(['display version']), null)
})

test('ensureSystemView / ensureUserView 的幂等与容错（供 apply_config 与 change_view 共用）', async () => {
  const { session, teardown } = await setup()
  try {
    // 视图未知（桩会话常见）→ 直接发 system-view
    const unknown = { view: undefined, exec: session.exec.bind(session) }
    const a = await ensureSystemView(unknown, undefined)
    assert.ok(a.ok)
    assert.deepEqual(a.commands, ['system-view'])

    // 已是用户视图 → 无命令
    const b = await ensureUserView({ ...unknown, view: 'user' }, undefined)
    assert.ok(b.ok)
    assert.deepEqual(b.commands, [])

    // 子视图 → return 后进系统视图
    const c = await ensureSystemView({ ...unknown, view: 'vlan' }, undefined)
    assert.ok(c.ok)
    assert.deepEqual(c.commands, ['return', 'system-view'])

    // 进接口视图：内部先确保系统视图
    const d = await enterInterfaceView({ ...unknown, view: 'user' }, IFACE, undefined)
    assert.ok(d.ok, JSON.stringify(d.error))
    assert.deepEqual(d.commands, ['system-view', `interface ${IFACE}`])
    assert.equal(d.last.view, 'interface')
  } finally {
    await teardown()
  }
})
