import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SnapshotStore,
  ChangeStore,
  SessionTreeStore,
  TodoStore,
  GoalArchiveStore,
  JsonStore,
  migrateDirectory
} from '../.build/harness.mjs'

/**
 * 数据完整性（B2）测试：索引损坏留档 / 从实体重建 / 写失败回滚 / 迁移不回传软链。
 *
 * 为什么需要：这些 store 的 `load()` 在解析失败时曾经直接「置空 + 继续」，而**下一次
 * 任意写入就会把空索引落盘** —— 原索引被永久覆盖，磁盘上的正文（快照 .txt / 会话 .jsonl）
 * 还在却再没人引用，用户看到的是「数据凭空消失且不可恢复」。这一批用例把这个口径锁死。
 */

let seq = 0
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ensp-b2-${++seq}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 目录下留档文件的个数（`<file>.bad-<ts>`） */
function badCount(dir) {
  return fs.readdirSync(dir).filter((f) => f.includes('.bad-')).length
}

const DEVICE = '127.0.0.1:2008'

// ———————————————————— N22：快照索引损坏 → 留档 + 从 .txt 重建 ————————————————————

test('N22 快照：索引截断/空文件 → 留档 + 从磁盘正文重建，后续写入不丢数据', (t) => {
  const dir = tmpDir(t)
  const s1 = new SnapshotStore(dir)
  const m1 = s1.save(DEVICE, 'sysname A', 'one')
  const m2 = s1.save(DEVICE, 'sysname B', 'two')

  // 破坏索引（截断成半截 JSON）
  fs.writeFileSync(path.join(dir, 'snapshots.json'), '{"version":1,"items":[', 'utf8')

  const s2 = new SnapshotStore(dir)
  const list = s2.list(DEVICE)
  assert.equal(list.length, 2, '应从磁盘正文重建出两份快照')
  assert.ok(list.some((m) => m.id === m1.id) && list.some((m) => m.id === m2.id))
  assert.ok(
    list.every((m) => m.complete === false),
    '重建条目一律标记为不完整 —— 内容里没有「是否被截断」的信息，不能当回滚基线'
  )
  assert.ok(list.every((m) => /^[0-9a-f]{12}$/.test(m.hashShort)), 'hashShort 应重新计算')
  assert.ok(list.every((m) => m.sizeBytes > 0))
  assert.equal(badCount(dir), 1, '损坏的原索引必须留档')
  assert.ok(s2.warnings.length > 0, '应给出加载告警')
  // 正文仍可读
  assert.equal(s2.read(DEVICE, m1.id), 'sysname A')

  // 后续写入不丢重建出的条目
  const m3 = s2.save(DEVICE, 'sysname C', 'three')
  const after = new SnapshotStore(dir).list(DEVICE)
  assert.equal(after.length, 3)
  assert.ok(after.some((m) => m.id === m1.id) && after.some((m) => m.id === m3.id))
})

test('N22 快照：items 字段不是数组（{"items":"x"}）同样留档 + 重建', (t) => {
  const dir = tmpDir(t)
  const s1 = new SnapshotStore(dir)
  const m1 = s1.save(DEVICE, 'sysname A', 'one')
  fs.writeFileSync(path.join(dir, 'snapshots.json'), JSON.stringify({ version: 1, items: 'x' }), 'utf8')

  const s2 = new SnapshotStore(dir)
  assert.equal(s2.list(DEVICE).length, 1)
  assert.equal(s2.list(DEVICE)[0].id, m1.id)
  assert.equal(badCount(dir), 1, 'items 整体不可用时也应留档，否则下一次写入即永久覆盖')
})

test('N22 快照：正文半截（索引 index 与正文脱节）时 read 返回 null，不抛异常', (t) => {
  const dir = tmpDir(t)
  const s = new SnapshotStore(dir)
  const m = s.save(DEVICE, 'sysname A', 'one')
  // 删掉正文但保留索引：模拟「有 meta 无文件」
  fs.rmSync(path.join(dir, 'snapshots', '127.0.0.1_2008', `${m.id}.txt`))
  assert.equal(s.read(DEVICE, m.id), null)
  assert.ok(s.get(DEVICE, m.id), 'meta 仍在索引里（由上层决定怎么提示）')
})

// ———————————————————— N20：prune 与失败回滚口径一致 ————————————————————

test('N20 快照：persist 失败时 prune 不生效（内存与磁盘正文都不脱节）', (t) => {
  const dir = tmpDir(t)
  const store = new SnapshotStore(dir)
  const metas = []
  for (let i = 0; i < 50; i++) metas.push(store.save(DEVICE, `sysname ${i}`, `s${i}`))
  assert.equal(store.list(DEVICE).length, 50)
  const oldest = metas[0]

  // 让下一次 persist 必然失败：把索引文件的位置换成同名目录（rename 到目录会失败）
  const idx = path.join(dir, 'snapshots.json')
  fs.rmSync(idx)
  fs.mkdirSync(idx)

  assert.throws(() => store.save(DEVICE, 'sysname new', 'new'))

  // 内存：仍是 50 条，且被 prune 的最早一条还在（旧实现会把它永久丢掉 → 49 条）
  const list = store.list(DEVICE)
  assert.equal(list.length, 50, 'persist 失败必须完整回滚，含被 prune 的条目')
  assert.ok(list.some((m) => m.id === oldest.id), '被淘汰的旧条目不因 persist 失败而消失')
  // 磁盘正文：最早那份 .txt 不能被提前删除（旧实现先删文件再 persist → 孤儿索引）
  assert.ok(
    fs.existsSync(path.join(dir, 'snapshots', '127.0.0.1_2008', `${oldest.id}.txt`)),
    '正文删除必须等 persist 成功之后'
  )
})

// ———————————————————— N22：其余 store 留档 + 告警 ————————————————————

test('N22 变更记录：索引损坏 → 留档 + 空兜底，后续写入正常', (t) => {
  const dir = tmpDir(t)
  const s1 = new ChangeStore(dir)
  s1.add({ deviceId: DEVICE, kind: 'apply', actor: 'agent', description: 'x', commands: ['a'], result: 'ok' })
  fs.writeFileSync(path.join(dir, 'changes.json'), '{not json', 'utf8')

  const s2 = new ChangeStore(dir)
  assert.equal(s2.recent().length, 0)
  assert.ok(s2.warnings.length > 0)
  assert.equal(badCount(dir), 1)
  // 后续写入不丢（损坏的原文件已留档，可人工抢救）
  s2.add({ deviceId: DEVICE, kind: 'apply', actor: 'agent', description: 'y', commands: ['b'], result: 'ok' })
  assert.equal(new ChangeStore(dir).recent().length, 1)
})

test('N22 会话索引：全新目录（无索引文件）不该被误判为损坏', (t) => {
  const dir = tmpDir(t)
  const store = new SessionTreeStore({ dir })
  assert.equal(store.list().length, 0)
  assert.equal(badCount(dir), 0, '「文件不存在」不是损坏，不该留档、也不该告警')
})

test('N22 会话索引：损坏 → 留档 + 清空（不静默覆盖）', (t) => {
  const dir = tmpDir(t)
  const s1 = new SessionTreeStore({ dir })
  s1.createRoot('会话一')
  fs.writeFileSync(path.join(dir, 'sessions-index.json'), '{not json', 'utf8')

  const s2 = new SessionTreeStore({ dir })
  assert.equal(s2.list().length, 0)
  assert.equal(badCount(dir), 1)
})

test('N22 清单：损坏 → 留档 + 空表兜底', (t) => {
  const dir = tmpDir(t)
  const file = path.join(dir, 'todos.json')
  fs.writeFileSync(file, '{not json', 'utf8')
  const store = new TodoStore(file)
  assert.deepEqual(store.get('owner-x'), [])
  assert.equal(badCount(dir), 1)
})

test('N22 目标存档：损坏 → 留档 + 预设兜底', (t) => {
  const dir = tmpDir(t)
  const file = path.join(dir, 'goals.json')
  fs.writeFileSync(file, '{not json', 'utf8')
  const store = new GoalArchiveStore(file)
  assert.ok(store.list().goals.length > 0, '读坏应回退预设而不是空')
  assert.equal(badCount(dir), 1)
})

test('N22 设置档案：损坏 → 留档 + 默认值兜底', (t) => {
  const dir = tmpDir(t)
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, '{not json', 'utf8')
  const store = new JsonStore(file)
  assert.deepEqual(store.getRecentPorts(), [])
  assert.ok(store.getSettings().agent !== undefined)
  assert.equal(badCount(dir), 1)
})

// ———————————————————— N41：TodoStore 写失败回滚内存 ————————————————————

test('N41 清单：写盘失败时 set / remove 都回滚内存（界面与磁盘不脱节）', (t) => {
  const dir = tmpDir(t)
  const file = path.join(dir, 'todos.json')
  const store = new TodoStore(file)
  store.set('owner-x', [{ content: '第一条', status: 'pending' }])
  assert.deepEqual(store.get('owner-x').map((x) => x.content), ['第一条'])

  // 让 persist 必然失败：把文件位置换成同名目录
  fs.rmSync(file)
  fs.mkdirSync(file)

  assert.throws(() => store.set('owner-x', [{ content: '第二条', status: 'completed' }]))
  assert.deepEqual(
    store.get('owner-x').map((x) => x.content),
    ['第一条'],
    'set 写失败必须回滚，磁盘上的仍是旧清单'
  )

  assert.throws(() => store.remove('owner-x'))
  assert.deepEqual(
    store.get('owner-x').map((x) => x.content),
    ['第一条'],
    'remove 写失败同样要回滚（否则界面删了、磁盘还在）'
  )
})

// ———————————————————— N44：会话索引复用 sanitizeIndexItems + 归一化 ————————————————————

test('N44 会话索引：sessions 形状错误 → 留档 + 清空（不再静默吞掉）', (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(
    path.join(dir, 'sessions-index.json'),
    JSON.stringify({ version: 1, sessions: 'x' }),
    'utf8'
  )
  const store = new SessionTreeStore({ dir })
  assert.equal(store.list().length, 0)
  assert.equal(badCount(dir), 1)
})

test('N44 会话索引：老索引缺 updatedAt/nodeCount → 归一化而不是丢弃（避免排序 NaN）', (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(
    path.join(dir, 'sessions-index.json'),
    JSON.stringify({
      version: 1,
      sessions: { 's-aaa': { id: 's-aaa', title: '老会话', createdAt: 1000 } }
    }),
    'utf8'
  )
  const store = new SessionTreeStore({ dir })
  const list = store.list()
  assert.equal(list.length, 1, '缺字段的老条目仍可用，不该被丢')
  assert.equal(list[0].updatedAt, 1000, 'updatedAt 缺失应回落到 createdAt，避免排序 NaN')
  assert.equal(list[0].nodeCount, 0)
  assert.equal(list[0].titleSource, 'auto')
  assert.equal(badCount(dir), 0, '形状可用的索引不该被留档')
})

// ———————————————————— N43：迁移回传软链 ————————————————————

test('N43 迁移：符号链接不被静默跳过，而是出现在 failed 里且不被复制', async (t) => {
  const src = tmpDir(t)
  const dest = tmpDir(t)
  fs.mkdirSync(path.join(src, 'sub'))
  fs.writeFileSync(path.join(src, 'a.txt'), 'hello', 'utf8')

  let linked = false
  try {
    // junction：Windows 上创建目录软链无需提权，且 readdir 会把它报告为 symlink
    fs.symlinkSync(path.join(src, 'sub'), path.join(src, 'linkdir'), 'junction')
    linked = true
  } catch {
    /* 环境不支持（缺权限/非 NTFS）→ 跳过 */
  }
  if (!linked) {
    t.skip('当前环境无法创建符号链接（junction）')
    return
  }

  const res = await migrateDirectory(src, dest)
  assert.equal(res.files, 1, '只复制常规文件')
  assert.ok(
    res.failed.includes('linkdir'),
    `软链必须回传（跳过项必须回传的纪律）：${JSON.stringify(res.failed)}`
  )
  assert.equal(fs.existsSync(path.join(dest, 'linkdir')), false, '软链不该被复制')
  assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'hello')
})