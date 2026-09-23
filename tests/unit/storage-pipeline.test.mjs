import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertInside,
  isDriveRoot,
  validateUserDataTarget,
  migrateDirectory,
  measureStorage,
  sanitizeStorageSettings,
  emptyDir
} from '../.build/harness.mjs'

/**
 * 第 2 轮「静默失败」里存储相关的回归用例（T2.3 / T2.4）。
 *
 * 共同主题：这些路径都来自设置项，可以指向任何地方 —— 一旦被指到 userData 之外，
 * 「清空」与「迁移」就等于对用户的数据动手。校验必须在**动任何文件之前**完成。
 */

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ensp-storage-${tag}-`))
}

// ———————————————————— T2.3 清理路径越界守护（R17） ————————————————————

test('T2.3 assertInside：目录自身与越界路径都不许当清理目标', () => {
  const userData = tmpDir('ud')
  assert.doesNotThrow(() => assertInside(userData, path.join(userData, 'attachments')))
  // 清空 userData 自身 = 连设置、会话、技能一起删，必须拒绝
  assert.throws(() => assertInside(userData, userData), /拒绝/)
  assert.throws(() => assertInside(userData, path.dirname(userData)), /拒绝/)
  assert.throws(() => assertInside(userData, path.join(userData, '..', 'evil')), /拒绝/)
})

test('T2.3 自定义附件目录指到 userData 之外 → 拒绝，且不删任何文件', () => {
  const userData = tmpDir('ud')
  const outside = tmpDir('outside')
  fs.writeFileSync(path.join(outside, 'keep.txt'), '别删我', 'utf8')
  fs.mkdirSync(path.join(userData, 'attachments'), { recursive: true })
  fs.writeFileSync(path.join(userData, 'attachments', 'a.txt'), 'x', 'utf8')

  // 模拟 services.clearData 的守卫顺序：校验在前，emptyDir 在后
  const target = outside
  assert.throws(() => {
    assertInside(userData, target)
    emptyDir(target)
  }, /拒绝/)

  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true, '越界目标一个文件都不能删')
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

test('T2.3 isDriveRoot：盘根被识别，普通目录不会被误判', () => {
  const probe = path.resolve(os.tmpdir())
  assert.equal(isDriveRoot(probe), false)
  assert.equal(isDriveRoot(path.parse(probe).root), true)
  const root = path.parse(probe).root
  assert.throws(() => assertInside(path.join(root, 'x'), root), /拒绝/)
})

// ———————————————————— T2.4 数据目录切换校验（R18） ————————————————————

test('T2.4 validateUserDataTarget：空串 / 非字符串 / 盘根 / 与当前相同 都被拒绝', () => {
  const current = tmpDir('cur')
  assert.throws(() => validateUserDataTarget('', current), /目标路径无效/)
  assert.throws(() => validateUserDataTarget('   ', current), /目标路径无效/)
  assert.throws(() => validateUserDataTarget(undefined, current), /目标路径无效/)
  assert.throws(() => validateUserDataTarget(42, current), /目标路径无效/)
  assert.throws(() => validateUserDataTarget(path.parse(current).root, current), /磁盘根目录/)
  assert.throws(() => validateUserDataTarget(current, current), /相同/)
  assert.throws(() => validateUserDataTarget(path.join(current, '.'), current), /相同/)
  fs.rmSync(current, { recursive: true, force: true })
})

test('T2.4 validateUserDataTarget：合法目标返回解析后的绝对路径（相对路径也不再是"当前目录"）', () => {
  const current = tmpDir('cur')
  const target = tmpDir('target')
  assert.equal(validateUserDataTarget(target, current), path.resolve(target))
  assert.equal(validateUserDataTarget('  ' + target + '  ', current), path.resolve(target))
  fs.rmSync(current, { recursive: true, force: true })
  fs.rmSync(target, { recursive: true, force: true })
})

// ———————————————————— T2.4 迁移不覆盖既有文件（决策 D4=B） ————————————————————

test('T2.4 migrateDirectory：目标已有同名文件 → 跳过并回传冲突清单，绝不覆盖', async () => {
  const src = tmpDir('src')
  const dest = tmpDir('dest')
  fs.mkdirSync(path.join(src, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(src, 'ensp-auto.json'), 'SELF', 'utf8')
  fs.writeFileSync(path.join(src, 'sessions', 's1.jsonl'), 'S1', 'utf8')

  // 目标里已有一份同名文件（内容不能被改）
  fs.writeFileSync(path.join(dest, 'ensp-auto.json'), 'EXISTING', 'utf8')

  const r = await migrateDirectory(src, dest)

  assert.equal(fs.readFileSync(path.join(dest, 'ensp-auto.json'), 'utf8'), 'EXISTING', '不覆盖既有文件')
  assert.deepEqual(r.conflicts, ['ensp-auto.json'], '冲突项必须回传，否则「少拷了」是无声的')
  assert.equal(fs.readFileSync(path.join(dest, 'sessions', 's1.jsonl'), 'utf8'), 'S1', '无冲突的正常拷贝')
  assert.equal(r.files, 1)
  assert.ok(r.bytes > 0)

  fs.rmSync(src, { recursive: true, force: true })
  fs.rmSync(dest, { recursive: true, force: true })
})

test('T2.4 migrateDirectory：跳过 Chromium 缓存目录与 bootstrap 文件', async () => {
  const src = tmpDir('src')
  const dest = tmpDir('dest')
  fs.mkdirSync(path.join(src, 'Cache'), { recursive: true })
  fs.writeFileSync(path.join(src, 'Cache', 'big.bin'), 'x'.repeat(1024), 'utf8')
  fs.writeFileSync(path.join(src, 'storage-bootstrap.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(src, 'keep.txt'), 'keep', 'utf8')

  const r = await migrateDirectory(src, dest)
  assert.equal(fs.existsSync(path.join(dest, 'Cache')), false)
  assert.equal(fs.existsSync(path.join(dest, 'storage-bootstrap.json')), false)
  assert.equal(fs.existsSync(path.join(dest, 'keep.txt')), true)
  assert.equal(r.files, 1)

  fs.rmSync(src, { recursive: true, force: true })
  fs.rmSync(dest, { recursive: true, force: true })
})

test('T2.4 migrateDirectory：源与目标相同 → 空操作，不假报拷贝数', async () => {
  const dir = tmpDir('same')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a', 'utf8')
  const r = await migrateDirectory(dir, dir)
  assert.deepEqual({ files: r.files, bytes: r.bytes }, { files: 0, bytes: 0 })
  fs.rmSync(dir, { recursive: true, force: true })
})

// ———————————————————— T2.2 storage 设置项真的落盘（R16） ————————————————————

test('T2.2 sanitizeStorageSettings：三个子目录能改、空串恢复默认、未提供保持原值', () => {
  const cur = { userDataDir: 'D:\\data', exportsDir: '', attachmentsDir: '', snapshotsDir: '' }

  const set = sanitizeStorageSettings(
    { exportsDir: 'E:\\exp', attachmentsDir: ' E:\\att ', snapshotsDir: 'E:\\snap' },
    cur
  )
  assert.deepEqual(set, {
    userDataDir: 'D:\\data',
    exportsDir: 'E:\\exp',
    // 去空白：界面回显与实际生效的值必须一致，否则用户看到的路径是假的
    attachmentsDir: 'E:\\att',
    snapshotsDir: 'E:\\snap'
  })

  const reset = sanitizeStorageSettings({ exportsDir: '' }, set)
  assert.equal(reset.exportsDir, '', '空串 = 恢复默认')
  assert.equal(reset.attachmentsDir, 'E:\\att', '只动传进来的那个键')

  const untouched = sanitizeStorageSettings({}, set)
  assert.deepEqual(untouched, set)
})

test('T2.2 sanitizeStorageSettings：userDataDir 不接受渲染层改写（唯一真相源是 bootstrap）', () => {
  const cur = { userDataDir: 'D:\\data', exportsDir: '', attachmentsDir: '', snapshotsDir: '' }
  const out = sanitizeStorageSettings({ userDataDir: 'E:\\hijack' }, cur)
  assert.equal(out.userDataDir, 'D:\\data', '改数据目录必须走 app:change-user-data-dir（要重启+迁移）')
})

test('T2.2 sanitizeStorageSettings：超长 / 非字符串 / 盘根 一律报错，不静默丢弃', () => {
  const cur = { userDataDir: 'D:\\data', exportsDir: '', attachmentsDir: '', snapshotsDir: '' }
  const root = path.parse(path.resolve(os.tmpdir())).root

  assert.throws(() => sanitizeStorageSettings({ exportsDir: 'x'.repeat(600) }, cur), /路径过长/)
  assert.throws(() => sanitizeStorageSettings({ exportsDir: 42 }, cur), /必须是字符串/)
  assert.throws(() => sanitizeStorageSettings({ exportsDir: null }, cur), /必须是字符串/)
  assert.throws(() => sanitizeStorageSettings({ exportsDir: {} }, cur), /必须是字符串/)
  assert.throws(() => sanitizeStorageSettings({ attachmentsDir: root }, cur), /磁盘根目录/)
})

// ———————————————————— 顺带锁住 measureStorage 的口径 ————————————————————

test('measureStorage：只统计自管目录，条目齐全且总量等于各项之和', () => {
  const userData = tmpDir('ud')
  const exportsDir = path.join(userData, 'exports')
  const attachmentsDir = path.join(userData, 'attachments')
  fs.mkdirSync(exportsDir, { recursive: true })
  fs.mkdirSync(attachmentsDir, { recursive: true })
  fs.writeFileSync(path.join(exportsDir, 'r.md'), 'x'.repeat(100), 'utf8')
  fs.writeFileSync(path.join(attachmentsDir, 'a.txt'), 'y'.repeat(50), 'utf8')

  const report = measureStorage({
    userDataDir: userData,
    exportsDir,
    attachmentsDir,
    snapshotsDir: path.join(userData, 'snapshots-data')
  })
  const keys = report.entries.map((e) => e.key).sort()
  assert.deepEqual(keys, ['attachments', 'config', 'exports', 'sessions', 'snapshots'])
  const sum = report.entries.reduce((n, e) => n + e.bytes, 0)
  assert.equal(report.totalBytes, sum)
  assert.ok(report.entries.find((e) => e.key === 'exports').bytes >= 100)

  fs.rmSync(userData, { recursive: true, force: true })
})

// ———————————————————— T4.4 迁移改为异步分片 + 进度回报 ————————————————————

test('T4.4 migrateDirectory：分批回报进度，done 单调递增到 total', async () => {
  const src = tmpDir('prog-src')
  const dest = tmpDir('prog-dest')
  fs.mkdirSync(path.join(src, 'sessions'), { recursive: true })
  for (let i = 0; i < 60; i++) {
    fs.writeFileSync(path.join(src, 'sessions', `s${i}.jsonl`), `line ${i}`, 'utf8')
  }

  const seen = []
  const r = await migrateDirectory(src, dest, {
    yieldEvery: 7,
    onProgress: (p) => seen.push(p)
  })

  assert.equal(r.files, 60)
  assert.equal(seen.length, 60, '每个文件都要有一帧进度')
  assert.equal(seen[0].done, 1)
  assert.equal(seen.at(-1).done, 60)
  assert.equal(seen.at(-1).total, 60)
  assert.ok(seen.at(-1).bytes >= 60)
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].done > seen[i - 1].done, 'done 必须单调递增')
  }
  assert.ok(seen.every((p) => typeof p.current === 'string' && p.current.length > 0))

  fs.rmSync(src, { recursive: true, force: true })
  fs.rmSync(dest, { recursive: true, force: true })
})

test('T4.4 migrateDirectory：返回 Promise（不再是同步阻塞调用）', () => {
  const p = migrateDirectory('x', 'y')
  assert.ok(p instanceof Promise, '必须是异步的，否则大目录会冻住主进程')
  return p.catch(() => undefined)
})
