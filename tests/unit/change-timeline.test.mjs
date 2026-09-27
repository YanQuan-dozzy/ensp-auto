import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChangeStore } from '../.build/harness.mjs'

/**
 * F6（2026-09-26）：变更审计时间线的数据层 —— ChangeStore.recent() 跨设备视图。
 *
 * 原 `list(deviceId)` 只能按设备查；时间线要的是「所有设备按时间倒序」。
 */

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-chg-'))
  return { s: new ChangeStore(dir), dir }
}

test('ChangeStore.recent：跨设备按时间倒序聚合', () => {
  const { s, dir } = store()
  try {
    s.add({ deviceId: 'A', kind: 'apply', actor: 'agent', description: 'a1', result: 'ok' })
    s.add({ deviceId: 'B', kind: 'apply', actor: 'agent', description: 'b1', result: 'ok' })
    s.add({ deviceId: 'A', kind: 'restore', actor: 'agent', description: 'a2', result: 'ok' })

    const all = s.recent()
    assert.equal(all.length, 3)
    assert.deepEqual(all.map((r) => r.description), ['a2', 'b1', 'a1'], '最新在前')
    assert.deepEqual([...new Set(all.map((r) => r.deviceId))].sort(), ['A', 'B'], '含多台设备')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ChangeStore.recent：limit 生效且不改变顺序', () => {
  const { s, dir } = store()
  try {
    for (let i = 0; i < 5; i++) {
      s.add({ deviceId: 'A', kind: 'apply', actor: 'agent', description: `c${i}`, result: 'ok' })
    }
    const two = s.recent(2)
    assert.equal(two.length, 2)
    assert.deepEqual(two.map((r) => r.description), ['c4', 'c3'])
    // 非数字 / 非法值回退到上限语义（至少返回 1 条，不炸）
    assert.ok(s.recent(Number.NaN).length >= 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ChangeStore：落盘后可重新加载（时间线跨重启可见）', () => {
  const { s, dir } = store()
  try {
    s.add({
      deviceId: 'A',
      kind: 'apply',
      actor: 'agent',
      snapshotId: 'snap-1',
      description: '配置接口',
      commands: ['interface GE0/0/0', 'ip address 10.0.0.1 255.255.255.0'],
      result: 'ok',
      verified: true
    })
    const reloaded = new ChangeStore(dir)
    const r = reloaded.recent()[0]
    assert.equal(r.deviceId, 'A')
    assert.equal(r.snapshotId, 'snap-1')
    assert.equal(r.verified, true)
    assert.equal(r.commands.length, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ———————————————————————— F6：删除 / 清空（信息量控制） ————————————————————————

test('ChangeStore.remove：删单条且落盘（重开后不再出现）', () => {
  const { s, dir } = store()
  try {
    s.add({ deviceId: 'A', kind: 'apply', actor: 'agent', description: 'a1', result: 'ok' })
    const b = s.add({ deviceId: 'B', kind: 'apply', actor: 'agent', description: 'b1', result: 'ok' })
    s.add({ deviceId: 'A', kind: 'restore', actor: 'agent', description: 'a2', result: 'ok' })

    assert.equal(s.remove(b.id), true)
    assert.deepEqual(s.recent().map((r) => r.description), ['a2', 'a1'])
    assert.equal(s.remove(b.id), false, '重复删同一条返回 false（不抛错）')
    assert.equal(s.remove('nope'), false)

    const reloaded = new ChangeStore(dir)
    assert.equal(reloaded.recent().length, 2, '删除必须落盘，重开后不能回弹')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ChangeStore.clear：清空全部并返回条数（重开后为空）', () => {
  const { s, dir } = store()
  try {
    assert.equal(s.clear(), 0, '本来就空 → 0，且不写盘')
    for (let i = 0; i < 3; i++) {
      s.add({ deviceId: 'A', kind: 'apply', actor: 'agent', description: `c${i}`, result: 'ok' })
    }
    assert.equal(s.clear(), 3)
    assert.deepEqual(s.recent(), [])
    assert.equal(new ChangeStore(dir).recent().length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})