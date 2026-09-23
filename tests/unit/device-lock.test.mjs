import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SessionManager,
  JsonStore,
  acquireDeviceLock,
  withDeviceLock
} from '../.build/harness.mjs'

/**
 * D6（2026-09-23）：设备级任务互斥。
 *
 * 反例来源：并发隔离只做在「会话」层（services.startAgent 的 sessionId 检查），
 * 而设备是物理共享资源 —— 同一台 127.0.0.1:2008 上两个会话各跑一个多步事务
 * （system-view → 逐条下发），TelnetClient 的串行保证是「单条命令」级的，
 * 命令会交错、视图栈错乱，且**双方都报成功**。
 */

function newManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-lock-'))
  const store = new JsonStore(path.join(dir, 'settings.json'))
  const sm = new SessionManager(store, {
    getSettings: () => ({}),
    onRaw() {},
    onClosed() {},
    onStateChanged() {}
  })
  return { sm, dir }
}

test('D6：SessionManager 锁原语 —— 互斥 / 不重入 / 非持有者不能释放', () => {
  const { sm, dir } = newManager()
  try {
    assert.equal(sm.tryAcquireDevice('d', 'A'), true, '第一个持有者应成功')
    assert.equal(sm.tryAcquireDevice('d', 'B'), false, '第二个持有者应被拒')
    // 同名 owner 也不重入：两个并发 apply_config 的 owner 相同，重入会架空互斥
    assert.equal(sm.tryAcquireDevice('d', 'A'), false, '同名 owner 不得重入')

    assert.equal(sm.deviceLockHolder('d').owner, 'A')
    assert.ok(sm.deviceLockHolder('d').heldMs >= 0)

    // 非持有者释放被忽略
    sm.releaseDevice('d', 'B')
    assert.equal(sm.deviceLockHolder('d').owner, 'A')
    // 持有者释放后彻底解锁
    sm.releaseDevice('d', 'A')
    assert.equal(sm.deviceLockHolder('d'), undefined)
    assert.equal(sm.tryAcquireDevice('d', 'B'), true, '释放后别人可获取')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('D6：持有超时（10 分钟）强制释放 —— 异常路径不把设备永久锁死', () => {
  const { sm, dir } = newManager()
  try {
    assert.equal(sm.tryAcquireDevice('d', 'stuck'), true)
    // 私有字段直改（.mjs 运行时无 private）：把持有时间拨回 11 分钟前
    const lock = sm.deviceLocks.get('d')
    lock.acquiredAt = Date.now() - 11 * 60 * 1000
    assert.equal(sm.tryAcquireDevice('d', 'fresh'), true, '超时后应可被抢占')
    assert.equal(sm.deviceLockHolder('d').owner, 'fresh')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('D6：断开 / 注销 / closeAll 释放锁', () => {
  const { sm, dir } = newManager()
  try {
    sm.tryAcquireDevice('d1', 't')
    sm.disconnect('d1')
    assert.equal(sm.deviceLockHolder('d1'), undefined, '断开应释放锁')

    sm.tryAcquireDevice('d2', 't')
    sm.forget('d2')
    assert.equal(sm.deviceLockHolder('d2'), undefined, '注销应释放锁')

    sm.tryAcquireDevice('d3', 't')
    sm.closeAll()
    assert.equal(sm.deviceLockHolder('d3'), undefined, 'closeAll 应清空全部锁')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('D6：withDeviceLock 包裹的 handler 独占设备，并发者收到 DEVICE_BUSY', async () => {
  const { sm, dir } = newManager()
  try {
    let inside = 0
    const handler = withDeviceLock('t_tool', async (args) => {
      inside++
      await new Promise((r) => setTimeout(r, 50))
      return { ok: true, data: { ran: args.deviceId }, meta: { ms: 1 } }
    })
    const ctx = { sessions: sm }

    const first = handler({ deviceId: '127.0.0.1:2008' }, ctx)
    // 第一个还没跑完时并发第二个：应直接拿到 DEVICE_BUSY，且不再进入 handler
    const second = await handler({ deviceId: '127.0.0.1:2008' }, ctx)
    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'DEVICE_BUSY')
    assert.match(second.error.message, /t_tool/, '报错应带占用者')
    assert.equal(second.meta.deviceId, '127.0.0.1:2008')
    await first
    assert.equal(inside, 1, '被拒的调用不得进入 handler')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('D6：withDeviceLock 正常路径 finally 释放，异常路径也释放', async () => {
  const calls = []
  const tracker = {
    tryAcquireDevice(id, owner) {
      calls.push(['acquire', id, owner])
      return calls.filter((c) => c[0] === 'acquire' && c[1] === id).length === 1
    },
    releaseDevice(id, owner) {
      calls.push(['release', id, owner])
    },
    deviceLockHolder() {
      return undefined
    }
  }
  const boom = withDeviceLock('t_tool', async () => {
    throw new Error('炸了')
  })
  await assert.rejects(() => boom({ deviceId: 'x' }, { sessions: tracker }), /炸了/)
  assert.deepEqual(calls, [
    ['acquire', 'x', 't_tool'],
    ['release', 'x', 't_tool']
  ])

  const fine = withDeviceLock('t_tool', async (args) => ({ ok: true, data: args, meta: { ms: 1 } }))
  const res = await fine({ deviceId: 'y' }, { sessions: tracker })
  assert.ok(res.ok)
  assert.deepEqual(calls.slice(-2), [
    ['acquire', 'y', 't_tool'],
    ['release', 'y', 't_tool']
  ])
})

test('D6：acquireDeviceLock 在被占用时返回可直返的失败结果（含持有时长）', () => {
  const { sm, dir } = newManager()
  try {
    sm.tryAcquireDevice('127.0.0.1:2008', 'apply_config')
    const busy = acquireDeviceLock({ sessions: sm }, '127.0.0.1:2008', 'restore_snapshot')
    assert.equal(busy.ok, false)
    assert.equal(busy.error.code, 'DEVICE_BUSY')
    assert.match(busy.error.message, /apply_config/)
    // 未被占用时返回 null（= 可以继续）
    assert.equal(acquireDeviceLock({ sessions: sm }, 'other-device', 'apply_config'), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
