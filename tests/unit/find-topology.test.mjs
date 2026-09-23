/**
 * 拓扑发现（v1.2，find_topology_files）测试。
 * 覆盖：目录扫描、递归深度、node_modules 跳过、目录同名标记、active 标记、截断。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findTopologyFiles } from '../.build/harness.mjs'

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-find-'))
  try {
    fs.writeFileSync(path.join(root, 'campus.topo'), '<topo/>')
    fs.mkdirSync(path.join(root, 'sub'))
    fs.writeFileSync(path.join(root, 'sub', 'other.topo'), '<topo/>')
    // node_modules/.git 等应被跳过
    fs.mkdirSync(path.join(root, 'node_modules'))
    fs.writeFileSync(path.join(root, 'node_modules', 'deep.topo'), '<topo/>')
    fs.mkdirSync(path.join(root, '.git'))
    fs.writeFileSync(path.join(root, '.git', 'hidden.topo'), '<topo/>')
    // 非 .topo 忽略
    fs.writeFileSync(path.join(root, 'notes.txt'), 'hi')
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true })
    throw e
  }
  return root
}

test('findTopologyFiles：目录扫描、跳过 node_modules/.git、忽略非 .topo', () => {
  const root = makeTree()
  try {
    const r = findTopologyFiles({ directory: root })
    assert.equal(r.truncated, false)
    const names = r.candidates.map((c) => c.name).sort()
    assert.deepEqual(names, ['campus.topo', 'other.topo'])
    assert.ok(r.candidates.every((c) => c.directory.startsWith(root)))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('findTopologyFiles：activePath 命中者排最前并标 isActive', () => {
  const root = makeTree()
  try {
    const target = path.join(root, 'sub', 'other.topo')
    const r = findTopologyFiles({ directory: root, activePath: target })
    assert.equal(r.activeTopology, target)
    assert.equal(r.candidates[0].isActive, true)
    assert.equal(r.candidates[0].path, target)
    assert.equal(r.count, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('findTopologyFiles：目录同名（<dir>.topo）优先排序', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-find-'))
  try {
    // 目录名 = 文件名（campus/campus.topo）→ 目录同名标记
    fs.mkdirSync(path.join(root, 'campus'))
    fs.writeFileSync(path.join(root, 'campus', 'campus.topo'), '<topo/>')
    fs.writeFileSync(path.join(root, 'zz.topo'), '<topo/>')
    const r = findTopologyFiles({ directory: root })
    assert.equal(r.candidates.length, 2)
    const named = r.candidates.find((c) => c.name === 'campus.topo')
    assert.equal(named.isNamedAfterDirectory, true)
    const zz = r.candidates.find((c) => c.name === 'zz.topo')
    assert.equal(zz.isNamedAfterDirectory, false)
    // 目录同名排在任意（同 mtime 相近）之前
    assert.equal(r.candidates[0].isNamedAfterDirectory, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('findTopologyFiles：maxResults 截断标记', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-find-'))
  try {
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, `${n}.topo`), '<topo/>')
    const r = findTopologyFiles({ directory: root, maxResults: 2 })
    assert.equal(r.count, 2)
    assert.equal(r.truncated, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('findTopologyFiles：maxDepth 限制递归', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-find-'))
  try {
    // root/a/b/c/far.topo 位于第 4 层：默认 maxDepth=4 能找到，maxDepth=2 找不到
    const deep = path.join(root, 'a', 'b', 'c')
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(deep, 'far.topo'), '<topo/>')
    const shallow = findTopologyFiles({ directory: root, maxDepth: 2 })
    assert.equal(shallow.count, 0)
    const deepSearch = findTopologyFiles({ directory: root })
    assert.equal(deepSearch.count, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})