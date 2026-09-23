import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  tempNameFor,
  SnapshotStore,
  ChangeStore,
  TopologyStore,
  GoalArchiveStore,
  JsonStore,
  DEFAULT_SETTINGS
} from '../.build/harness.mjs'

/**
 * 第 2 轮「落盘不再静默失败」的回归用例（T2.5 / T2.6 / T2.7 / T2.8）。
 *
 * 这些用例守的都是同一类事故：**界面说成了、磁盘没变**。
 * 表现形式从「设置重启后回弹」到「图纸下次打开全没了」，根因都是写盘那一步没人管。
 */

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ensp-write-${tag}-`))
}

/** 目录里有没有残留的 .tmp（原子写失败必须自己清干净） */
function tmpResidue(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
}

/** 造一个「父路径是文件」的目标：mkdirSync 必然失败，用来模拟不可写 */
function impossiblePath(dir) {
  const blocker = path.join(dir, 'blocker')
  fs.writeFileSync(blocker, 'x', 'utf8')
  return path.join(blocker, 'nested', 'target.json')
}

// ———————————————————— T2.5 统一原子写 ————————————————————

test('T2.5 tempNameFor：每个临时名唯一（并发写不会互相顶掉 rename 目标）', () => {
  const names = new Set(Array.from({ length: 200 }, () => tempNameFor('C:/x/a.json')))
  assert.equal(names.size, 200)
  for (const n of names) assert.ok(n.endsWith('.tmp'))
  assert.ok([...names].every((n) => n.includes(String(process.pid))))
})

test('T2.5 连续写 50 次：每次落盘都是完整 JSON，且无半成品、无 .tmp 残留', () => {
  const dir = tmpDir('atomic')
  const file = path.join(dir, 'data.json')

  for (let i = 0; i < 50; i++) {
    atomicWriteJsonSync(file, { i, payload: 'x'.repeat(2000) })
    // 任意时刻读到的都必须是合法且完整的 JSON（rename 的原子性）
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(parsed.i, i)
    assert.equal(parsed.payload.length, 2000)
  }
  assert.deepEqual(tmpResidue(dir), [], '正常路径不该留下临时文件')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('T2.5 写失败：抛错且清理临时文件；throwOnError:false 时返回 false', () => {
  const dir = tmpDir('fail')
  const bad = impossiblePath(dir)

  assert.throws(() => atomicWriteJsonSync(bad, { a: 1 }))
  assert.throws(() => atomicWriteFileSync(bad, 'hello'), '文本写同样要抛')
  assert.equal(
    atomicWriteJsonSync(bad, { a: 1 }, { throwOnError: false }),
    false,
    'throwOnError:false 时用返回值表达失败'
  )
  assert.deepEqual(tmpResidue(dir), [], '失败路径也不该留下 .tmp')
  assert.equal(fs.existsSync(path.join(dir, 'blocker')), true, '既有的 blocker 文件不受影响')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('T2.5 字节写：非 UTF-8 内容原样落盘（.topo 的 utf16le 不能被转码）', () => {
  const dir = tmpDir('bytes')
  const file = path.join(dir, 'a.topo')
  const bytes = Buffer.from('abc', 'utf16le')
  atomicWriteFileSync(file, bytes)
  assert.deepEqual(fs.readFileSync(file), bytes)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ———————————————————— T2.6 写失败不再被吞 ————————————————————

test('T2.6 TopologyStore：写盘失败必须抛出（拖动落位不能假报成功）', () => {
  const dir = tmpDir('topo-fail')
  const store = new TopologyStore({ file: impossiblePath(dir), onChange: () => {} })

  assert.throws(() => {
    store.applyManual({ nodes: [{ id: 'R1', name: 'R1', role: 'router', source: 'manual' }], links: [] })
  }, '写不进去就必须报错，而不是"存好了"')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('T2.6 TopologyStore：正常路径仍能写入并读回', () => {
  const dir = tmpDir('topo-ok')
  const file = path.join(dir, 'topology.json')
  const store = new TopologyStore({ file, onChange: () => {} })
  store.applyManual({
    nodes: [{ id: 'R1', name: 'R1', role: 'router', source: 'manual' }],
    links: []
  })
  const reloaded = new TopologyStore({ file, onChange: () => {} })
  assert.equal(reloaded.snapshot().nodes.length, 1)

  const reloaded2 = new TopologyStore({ file, onChange: () => {} })
  assert.equal(reloaded2.snapshot().nodes[0].name, 'R1')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ———————————————————— T2.7 内存与磁盘一致（写失败回滚内存） ————————————————————

test('T2.7 TopologyStore：写失败后内存回滚，快照与磁盘保持一致', () => {
  const dir = tmpDir('topo-rollback')
  const good = path.join(dir, 'topology.json')
  const store = new TopologyStore({ file: good, onChange: () => {} })
  store.applyManual({
    nodes: [{ id: 'R1', name: 'R1', role: 'router', source: 'manual' }],
    links: []
  })
  const committed = store.snapshot()
  assert.equal(committed.nodes.length, 1)

  // 换成不可写目标，再改一次 → 抛错 + 内存回到已落盘基线
  const broken = new TopologyStore({ file: impossiblePath(dir), onChange: () => {} })
  assert.throws(() => {
    broken.applyManual({
      nodes: [{ id: 'X', name: 'X', role: 'switch', source: 'manual' }],
      links: []
    })
  })
  assert.deepEqual(broken.snapshot().nodes, [], '失败后内存不该留着未落盘的改动')

  // 原 store 的磁盘内容仍是第一次那份
  const reread = new TopologyStore({ file: good, onChange: () => {} })
  assert.equal(reread.snapshot().nodes.length, 1)
  assert.equal(reread.snapshot().nodes[0].id, 'R1')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('T2.7 GoalArchiveStore：落盘失败时内存不认账（list 仍是旧值）', () => {
  const dir = tmpDir('goals-rollback')
  const store = new GoalArchiveStore(impossiblePath(dir))
  const before = store.list()
  assert.throws(() => store.replace(['新目标一']), '写不进去就抛出')
  assert.deepEqual(store.list(), before, '失败后 list() 必须还是旧值')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('T2.7 ChangeStore：追加记录落盘失败时回滚内存', () => {
  const dir = tmpDir('changes-rollback')
  const store = new ChangeStore(impossiblePath(dir))
  const record = {
    deviceId: 'dev-1',
    kind: 'apply',
    actor: 'agent',
    description: '改个名',
    commands: ['sysname R1'],
    result: 'ok'
  }
  assert.throws(() => store.add(record))
  assert.deepEqual(store.list('dev-1'), [], '失败后内存里不该留着这条记录')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('T2.7 JsonStore：设置写盘失败时内存回滚（settings 不会"看起来改了"）', () => {
  const dir = tmpDir('json-rollback')
  const store = new JsonStore(impossiblePath(dir))
  const before = store.getSettings()
  assert.throws(() => store.updateSettings({ theme: before.theme === 'dark' ? 'light' : 'dark' }))
  assert.deepEqual(store.getSettings(), before, '失败后设置必须回到旧值')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ———————————————————— T2.8 索引文件形状校验 ————————————————————

test('T2.8 SnapshotStore：索引 items 不是数组 → 仍可用（空列表 + 告警），不抛 TypeError', () => {
  const dir = tmpDir('snap-shape')
  const baseDir = path.join(dir, 'snaps')
  fs.mkdirSync(baseDir, { recursive: true })
  fs.writeFileSync(path.join(baseDir, 'snapshots.json'), JSON.stringify({ version: 1, items: 'x' }), 'utf8')

  const store = new SnapshotStore(baseDir)
  assert.deepEqual(store.list('dev-1'), [])
  assert.equal(store.warnings.length, 1)
  assert.match(store.warnings[0], /不是数组/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('T2.8 SnapshotStore：数组里的坏条目被丢弃并计数，好条目保留', () => {
  const dir = tmpDir('snap-shape2')
  const baseDir = path.join(dir, 'snaps')
  fs.mkdirSync(baseDir, { recursive: true })
  const good = {
    id: 's-1',
    deviceId: 'dev-1',
    label: '变更前',
    sizeBytes: 10,
    hashShort: 'abc',
    createdAt: 1
  }
  fs.writeFileSync(
    path.join(baseDir, 'snapshots.json'),
    JSON.stringify({ version: 1, items: [good, null, 42, { id: 'x' }] }),
    'utf8'
  )

  const store = new SnapshotStore(baseDir)
  const list = store.list('dev-1')
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 's-1')
  assert.match(store.warnings[0], /3 条记录形状不合法/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('T2.8 ChangeStore：坏索引不炸，且仍能正常追加新记录', () => {
  const dir = tmpDir('change-shape')
  const baseDir = path.join(dir, 'changes')
  fs.mkdirSync(baseDir, { recursive: true })
  fs.writeFileSync(path.join(baseDir, 'changes.json'), '{"items":"oops"}', 'utf8')

  const store = new ChangeStore(baseDir)
  assert.deepEqual(store.list('dev-1'), [])
  assert.match(store.warnings[0], /不是数组/)

  // 坏索引被降级为空列表后，追加必须照常工作（并覆盖写回一个健康索引）
  const rec = store.add({
    deviceId: 'dev-1',
    kind: 'save',
    actor: 'agent',
    description: '保存',
    commands: ['save'],
    result: 'ok'
  })
  assert.ok(rec.id)
  assert.equal(store.list('dev-1').length, 1)
  const reread = new ChangeStore(baseDir)
  assert.equal(reread.list('dev-1').length, 1)
  assert.deepEqual(reread.warnings, [])

  fs.rmSync(dir, { recursive: true, force: true })
})

test('T2.8 索引文件被截断（非法 JSON）→ 空列表 + 告警，不抛', () => {
  const dir = tmpDir('change-broken')
  const baseDir = path.join(dir, 'changes')
  fs.mkdirSync(baseDir, { recursive: true })
  fs.writeFileSync(path.join(baseDir, 'changes.json'), '{"items":[', 'utf8')

  const store = new ChangeStore(baseDir)
  assert.deepEqual(store.list('dev-1'), [])
  assert.match(store.warnings[0], /无法解析/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('T2.8 JsonStore 仍能从默认设置启动（形状校验没有误伤正常路径）', () => {
  const dir = tmpDir('json-shape')
  const store = new JsonStore(path.join(dir, 'ensp-auto.json'))
  assert.equal(store.getSettings().theme, DEFAULT_SETTINGS.theme)
  fs.rmSync(dir, { recursive: true, force: true })
})
