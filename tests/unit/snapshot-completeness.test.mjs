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
  saveConfigSnapshot,
  restoreSnapshot
} from '../.build/harness.mjs'
import { MockVrp } from '../mock-device/MockVrp.mjs'

/**
 * D3（2026-09-23）：截断快照不能当回滚基线。
 *
 * 反例来源：通信层超出 maxBytes 后缓冲是「头 256KB + 尾 256KB，中间丢弃」，
 * 但 CommandResult.ok 仍为 true（只挂一个 TRUNCATED 错误码）；而 apply_config
 * 只看 `cur.ok` 就把它存成回滚基线 → rollback 按段 diff 会漏撤销/误撤销，
 * 且回滚**报成功**，事后无人能发现。
 */

const DEV = '127.0.0.1:2008'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-snapc-'))
}

/** 手工伪造一份「旧版索引」（没有 complete 字段），验证向后兼容 */
function writeLegacyIndex(dir, id) {
  const file = path.join(dir, 'snapshots.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      items: [
        {
          id,
          deviceId: DEV,
          label: '旧索引快照',
          sizeBytes: 3,
          hashShort: 'abc123',
          createdAt: Date.now()
        }
      ]
    }),
    'utf8'
  )
  fs.mkdirSync(path.join(dir, 'snapshots', DEV.replace(/[^0-9a-zA-Z.-]/g, '_')), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'snapshots', DEV.replace(/[^0-9a-zA-Z.-]/g, '_'), `${id}.txt`),
    'cfg',
    'utf8'
  )
}

// ———————————————— 存储层 ————————————————

test('D3：save 的 complete 标记落盘，旧索引缺字段读回为 true', () => {
  const dir = tmpDir()
  try {
    const store = new SnapshotStore(dir)
    const full = store.save(DEV, 'sysname A\n', '完整')
    const partial = store.save(DEV, 'sysname B\n', '截断', { complete: false })
    assert.equal(full.complete, true)
    assert.equal(partial.complete, false)

    // 跨实例读回（真正走一次 JSON 解析 + 形状校验）
    const reloaded = new SnapshotStore(dir)
    assert.equal(reloaded.get(DEV, full.id).complete, true)
    assert.equal(reloaded.get(DEV, partial.id).complete, false)

    // 旧索引（无 complete 字段）：形状校验不丢条目，读回视为完整
    const legacyDir = tmpDir()
    try {
      writeLegacyIndex(legacyDir, 'legacy01')
      const legacy = new SnapshotStore(legacyDir)
      const meta = legacy.get(DEV, 'legacy01')
      assert.ok(meta, '缺 complete 字段不应导致条目被丢弃')
      assert.equal(meta.complete, true)
      assert.deepEqual(legacy.warnings, [])
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ———————————————— 采集端 ————————————————

async function setup({ handlers = [], mockOpts = {} } = {}) {
  const mock = new MockVrp({ ...mockOpts, handlers })
  const port = await mock.listen()
  const dir = tmpDir()
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

test('D3：设备回显被截断 → 快照标记不完整且回传 snapshotComplete:false', async () => {
  // 把 maxBytes 调小，让一次 display current-configuration 必然超限
  const big = ['sysname Big', '#'].concat(
    Array.from({ length: 4000 }, (_, i) => `interface LoopBack${i}\n description filler-${i}`),
    ['#', 'return']
  )
  const mock = new MockVrp({
    handlers: [
      {
        match: /^display current-configuration$/i,
        respond: () => ({ text: big.join('\r\n') })
      }
    ]
  })
  const port = await mock.listen()
  const { session } = await DeviceSession.open(port, 'BIG', { maxBytes: 8 * 1024 }, {
    onRaw() {},
    onClosed() {},
    onStateChanged() {}
  })
  const id = session.id
  const dir = tmpDir()
  try {
    const snaps = new SnapshotStore(path.join(dir, 's'))
    const ctx2 = {
      sessions: { get: () => session, require: () => session },
      settings: {},
      snapshots: snaps,
      changes: new ChangeStore(path.join(dir, 'c')),
      requestGate: async () => true
    }
    const res = await saveConfigSnapshot.handler({ deviceId: id, label: '大配置' }, ctx2)
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.equal(res.data.complete, false, '超限采集应标记不完整')
    assert.equal(res.data.snapshotComplete, false)
    assert.equal(snaps.latest(id).complete, false)

    // 不完整快照不能当回滚基线
    const rollback = await restoreSnapshot.handler({ deviceId: id, reason: '试图回滚' }, ctx2)
    assert.equal(rollback.ok, false)
    assert.equal(rollback.error.code, 'SNAPSHOT_INCOMPLETE')
    assert.match(rollback.error.message, /重新采集/)
    assert.ok(!mock.receivedCommands.includes('system-view'), '拒绝应发生在下发之前')

    // apply_config 显式指定不完整快照 → 同样拒绝，且不进系统视图
    const applied = await applyConfig.handler(
      { deviceId: id, commands: ['sysname X'], description: 'x', snapshotId: snaps.latest(id).id },
      ctx2
    )
    assert.equal(applied.ok, false)
    assert.equal(applied.error.code, 'SNAPSHOT_INCOMPLETE')
    assert.ok(!mock.receivedCommands.includes('system-view'))
  } finally {
    session.close()
    await mock.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('D3：完整采集的快照正常回滚（不回归）', async () => {
  const { deviceId, snapshots, ctx, teardown } = await setup({
    handlers: [
      {
        match: /^display current-configuration$/i,
        respond: () => ({
          text: ['sysname Huawei', '#', 'interface GigabitEthernet0/0/0', ' shutdown', '#', 'return'].join(
            '\r\n'
          )
        })
      },
      { match: /^system-view$/i, respond: () => ({ text: '', prompt: '[Huawei]' }) },
      {
        match: /^interface GigabitEthernet0\/0\/0$/i,
        respond: () => ({ text: '', prompt: '[Huawei-GigabitEthernet0/0/0]' })
      },
      { match: /^undo shutdown$/i, respond: () => ({ text: '' }) },
      {
        match: /^ip address 10\.0\.0\.1 255\.255\.255\.0$/i,
        respond: () => ({ text: '' })
      }
    ]
  })
  try {
    const base =
      'sysname Huawei\n#\ninterface GigabitEthernet0/0/0\n ip address 10.0.0.1 255.255.255.0\n#\nreturn'
    snapshots.save(deviceId, base, 'baseline')
    assert.equal(snapshots.latest(deviceId).complete, true)
    const res = await restoreSnapshot.handler({ deviceId, reason: '回归' }, ctx)
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.ok(res.data.appliedCommands > 0)
  } finally {
    await teardown()
  }
})
