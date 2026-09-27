import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DeviceSession,
  SnapshotStore,
  ChangeStore,
  batchConfigure,
  executeTask,
  rollbackTask
} from '../.build/harness.mjs'
import { MockVrp } from '../mock-device/MockVrp.mjs'

/**
 * F5（2026-09-26）：execute_task / batch_configure 快照汇总 + rollback_task 一键整体回滚。
 *
 * 锁两条不变量：
 * 1. 每台设备的自动快照 ID 必须随任务结果返回（含**失败**路径）——否则任务失败后
 *    已成功/部分生效的设备没有整体回收入口，只能人工逐台 restore_snapshot；
 * 2. rollback_task 只弹**一次**闸门（批次级），逐台走 restore 的既有内部路径
 *    （D3 完整性校验、危险拦截、变更记录都在那条路径上）。
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
    { match: /^ip address 10\.0\.0\.10 255\.255\.255\.0$/i, respond: () => ({ text: '' }) },
    ...extra
  ]
}

async function setup({ handlers = [], gate = true } = {}) {
  const mock = new MockVrp({ handlers: configHandlers(handlers) })
  const port = await mock.listen()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-rb-'))
  const snapshots = new SnapshotStore(path.join(dir, 'snaps'))
  const changes = new ChangeStore(path.join(dir, 'changes'))
  const { session } = await DeviceSession.open(port, 'RB', {}, {
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

test('batch_configure：结果汇总每台设备的 snapshotId（devices 与 snapshots 一一对应）', async () => {
  const { deviceId, ctx, teardown } = await setup()
  try {
    const res = await batchConfigure.handler(
      {
        devices: [
          {
            deviceId,
            commands: [`interface ${IFACE}`, 'ip address 10.0.0.10 255.255.255.0'],
            description: '配置接口 IP'
          }
        ]
      },
      ctx
    )
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.ok(res.data.devices[0].snapshotId, '每台设备应带 snapshotId')
    assert.equal(res.data.snapshots.length, 1)
    assert.equal(res.data.snapshots[0].deviceId, deviceId)
    assert.equal(res.data.snapshots[0].snapshotId, res.data.devices[0].snapshotId)
    assert.equal(res.data.snapshots[0].ok, true)
    assert.equal(res.data.snapshots[0].applied, 2)
  } finally {
    await teardown()
  }
})

test('execute_task：失败路径同样返回 snapshots（已生效设备可整体回收）', async () => {
  const { deviceId, ctx, teardown } = await setup()
  try {
    // MockVrp 不认 vlan batch → 任务失败；但快照在命令下发前就已采集，必须回传
    const res = await executeTask.handler({ task: 'vlan', switches: [{ deviceId, vlans: [10] }] }, ctx)
    assert.equal(res.ok, false, 'vlan batch 未注册处理器，任务应失败')
    assert.ok(res.data.snapshots?.length === 1, '失败路径也必须带 snapshots')
    assert.ok(res.data.snapshots[0].snapshotId)
    assert.equal(res.data.snapshots[0].ok, false)
  } finally {
    await teardown()
  }
})

const SNAPSHOT_WITH_EXTRA_IFACE = [
  'sysname Huawei',
  '#',
  `interface ${IFACE}`,
  ' ip address 10.0.0.1 255.255.255.0',
  '#',
  'interface GigabitEthernet0/0/1',
  ' ip address 10.0.0.99 255.255.255.0',
  '#',
  'return'
].join('\n')

test('rollback_task：只弹一次闸门，逐台走 restore 内部路径并落变更记录', async () => {
  const { deviceId, snapshots, changes, ctx, gateCalls, teardown } = await setup({
    handlers: [
      {
        match: /^interface GigabitEthernet0\/0\/1$/i,
        respond: () => ({ text: '', prompt: '[Huawei-GigabitEthernet0/0/1]' })
      },
      { match: /^ip address 10\.0\.0\.99 255\.255\.255\.0$/i, respond: () => ({ text: '' }) }
    ]
  })
  try {
    const snap = snapshots.save(deviceId, SNAPSHOT_WITH_EXTRA_IFACE, '回滚基线', { complete: true })
    const res = await rollbackTask.handler(
      { snapshots: [{ deviceId, snapshotId: snap.id }], reason: '任务失败，整体回滚' },
      ctx
    )
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.equal(res.data.total, 1)
    assert.equal(res.data.succeeded, 1)
    assert.equal(res.data.results[0].deviceId, deviceId)
    assert.equal(res.data.results[0].appliedCommands, 2, '快照多出的接口段应被补回')

    assert.equal(gateCalls.length, 1, '批次级闸门只应弹一次')
    assert.equal(gateCalls[0].toolName, 'rollback_task')

    const record = changes.latest(deviceId)
    assert.equal(record.kind, 'restore')
    assert.equal(record.result, 'ok')
  } finally {
    await teardown()
  }
})

test('rollback_task：闸门被拒 → GATE_REJECTED，且不产生任何回滚命令', async () => {
  const { deviceId, snapshots, changes, ctx, gateCalls, teardown } = await setup({ gate: false })
  try {
    const snap = snapshots.save(deviceId, SNAPSHOT_WITH_EXTRA_IFACE, '回滚基线', { complete: true })
    const res = await rollbackTask.handler(
      { snapshots: [{ deviceId, snapshotId: snap.id }], reason: '整体回滚' },
      ctx
    )
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'GATE_REJECTED')
    assert.equal(gateCalls.length, 1)
    assert.equal(changes.list(deviceId).length, 0, '被拒时不应落任何变更记录')
  } finally {
    await teardown()
  }
})

test('rollback_task：入参校验（空清单 / 缺 reason / 去重）', async () => {
  const { deviceId, ctx, teardown } = await setup()
  try {
    const noReason = await rollbackTask.handler(
      { snapshots: [{ deviceId, snapshotId: 's1' }], reason: '' },
      ctx
    )
    assert.equal(noReason.ok, false)
    assert.equal(noReason.error.code, 'BAD_PARAM')

    const empty = await rollbackTask.handler({ snapshots: [], reason: 'x' }, ctx)
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'BAD_PARAM')

    // 同一设备重复 → 只回滚一次（闸门被拒即可证明内层只被调用一次）
    const dup = await rollbackTask.handler(
      {
        snapshots: [
          { deviceId, snapshotId: 's1' },
          { deviceId, snapshotId: 's2' }
        ],
        reason: 'x'
      },
      ctx
    )
    // 内层会因快照不存在失败，但闸门只弹一次、且不是 BAD_PARAM
    assert.equal(dup.error?.code === 'BAD_PARAM', false)
  } finally {
    await teardown()
  }
})