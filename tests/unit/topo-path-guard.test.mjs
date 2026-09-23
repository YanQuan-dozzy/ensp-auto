import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveTopoFile } from '../.build/harness.mjs'

/**
 * D5（2026-09-23）：save_topo_file 的 path 校验。
 *
 * 反例来源：v1.8 删掉「限制在 exportsDir 内」的检查，理由是 path.resolve 已归一化
 * `..` —— 但 path.resolve 不是边界校验，path 参数实际可指向磁盘任意位置；工具
 * risk=write、不请求闸门，落盘 renameSync 且目标存在时静默覆盖。
 */

function ctxWith(exportsDir) {
  return {
    topology: {
      snapshot: () => ({
        nodes: [{ id: 'R1', name: 'AR1', role: 'router', model: 'AR2220', deviceId: '127.0.0.1:2000' }],
        links: [],
        updatedAt: 0
      })
    },
    exportsDir,
    settings: { scanStart: 2000 }
  }
}

function tmpExports() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-topo-exp-'))
}

test('D5：路径在导出目录内 → 正常保存', async () => {
  const dir = tmpExports()
  try {
    const target = path.join(dir, 'lab.topo')
    const res = await saveTopoFile.handler({ path: target }, ctxWith(dir))
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.equal(res.data.path, path.resolve(target))
    assert.ok(fs.existsSync(target), '文件应真实落盘')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('D5：缺省 path → 自动生成到导出目录', async () => {
  const dir = tmpExports()
  try {
    const res = await saveTopoFile.handler({}, ctxWith(dir))
    assert.ok(res.ok, JSON.stringify(res.error))
    assert.ok(res.data.path.startsWith(path.resolve(dir)), `应落在导出目录内：${res.data.path}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('D5：越界路径（`..` 逃逸 / 任意绝对路径）→ BAD_PARAM 且不落盘', async () => {
  const dir = tmpExports()
  const outsideDir = tmpExports()
  try {
    for (const p of [
      path.join(dir, '..', '..', 'evil.topo'),
      path.join(outsideDir, 'elsewhere.topo')
    ]) {
      const res = await saveTopoFile.handler({ path: p }, ctxWith(dir))
      assert.equal(res.ok, false, `${p} 应被拒绝`)
      assert.equal(res.error.code, 'BAD_PARAM')
      assert.match(res.error.message, /导出目录内/)
      assert.ok(!fs.existsSync(path.resolve(p)), '越界路径不得写盘')
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('D5：目标文件已存在 → BAD_PARAM，原文件内容不变（不静默覆盖）', async () => {
  const dir = tmpExports()
  try {
    const target = path.join(dir, 'exists.topo')
    fs.writeFileSync(target, 'KEEP-ME', 'utf8')
    const before = fs.statSync(target)
    const res = await saveTopoFile.handler({ path: target }, ctxWith(dir))
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'BAD_PARAM')
    assert.match(res.error.message, /已存在/)
    const after = fs.statSync(target)
    assert.equal(fs.readFileSync(target, 'utf8'), 'KEEP-ME', '内容不得被覆盖')
    assert.equal(after.mtimeMs, before.mtimeMs, 'mtime 不得变化')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('D5：非 .topo 扩展名 → BAD_PARAM（原有规则不回归）', async () => {
  const dir = tmpExports()
  try {
    const res = await saveTopoFile.handler({ path: path.join(dir, 'lab.txt') }, ctxWith(dir))
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'BAD_PARAM')
    assert.match(res.error.message, /\.topo 结尾/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
