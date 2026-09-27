import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SessionTreeStore,
  stableArgsKey,
  toolStepsOf,
  compareBranches,
  renderComparisonMarkdown,
  branchLabelOf,
  writeCompareReport
} from '../.build/harness.mjs'

/**
 * F8（2026-09-26）：会话树书签 + 分支对比（工具调用序列逐项 diff）。
 *
 * 分支对比对齐的是**工具调用签名**而不是文本：模型的措辞每次都不同，
 * 文本 diff 全是噪声；真正稳定可比的是 name + 参数。
 */

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-f8-'))
  return { store: new SessionTreeStore({ dir }), dir }
}

// ———————————————————————— 书签 ————————————————————————

test('setBookmark：标记 / 取消，且落盘后重开仍在（不是内存假象）', () => {
  const { store, dir } = tmpStore()
  try {
    const root = store.createRoot('写书签')
    const node = store.append(root.id, { id: 'n-1', role: 'assistant', content: '阶段一完成' })

    assert.equal(store.setBookmark(root.id, node.id, true), true)
    assert.equal(store.bookmarks(root.id).length, 1)
    assert.equal(store.bookmarks(root.id)[0].id, 'n-1')
    assert.equal(store.getById('n-1').bookmarked, true)

    // 重开一个 store：书签是从 jsonl 读回来的，不是内存里那一下
    const reopened = new SessionTreeStore({ dir })
    assert.equal(reopened.bookmarks(root.id).length, 1)
    assert.equal(reopened.getById('n-1').bookmarked, true, '重开后书签应仍在')

    assert.equal(store.setBookmark(root.id, 'n-1', false), true)
    assert.equal(store.bookmarks(root.id).length, 0)
    assert.equal(store.getById('n-1').bookmarked, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('setBookmark：未知节点返回 false，不抛错', () => {
  const { store, dir } = tmpStore()
  try {
    const root = store.createRoot('x')
    assert.equal(store.setBookmark(root.id, 'n-nope', true), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('subtree：只取分叉点往下的这条路线（不含另一条分支）', () => {
  const { store, dir } = tmpStore()
  try {
    const root = store.createRoot('分叉')
    store.append(root.id, { id: 'n-a', role: 'assistant', content: 'A1' })
    store.append(root.id, { id: 'n-b', role: 'assistant', content: 'B1' })
    store.append('n-a', { id: 'n-a2', role: 'tool', content: '' })
    store.append('n-b', { id: 'n-b2', role: 'tool', content: '' })

    const ids = store.subtree(root.id, 'n-a').map((n) => n.id)
    assert.deepEqual(ids, ['n-a', 'n-a2'])
    assert.ok(!ids.includes('n-b'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ———————————————————————— 对比 ————————————————————————

const toolNode = (id, at, name, args, extra = {}) => ({
  id,
  parentId: 'p',
  role: 'tool',
  content: '',
  toolCall: { callId: id, name, args, ...extra },
  createdAt: at
})

test('stableArgsKey：与键顺序无关（同一参数得到同一签名）', () => {
  assert.equal(stableArgsKey({ a: 1, b: 2 }), stableArgsKey({ b: 2, a: 1 }))
  assert.notEqual(stableArgsKey({ a: 1 }), stableArgsKey({ a: 2 }))
})

test('toolStepsOf：只取工具节点并按时间排序', () => {
  const nodes = [
    { id: 'n-2', parentId: null, role: 'assistant', content: 'hi', createdAt: 20 },
    toolNode('n-3', 30, 'apply_config', { deviceId: 'd' }),
    toolNode('n-1', 10, 'get_topology', {})
  ]
  const steps = toolStepsOf(nodes)
  assert.deepEqual(steps.map((s) => s.name), ['get_topology', 'apply_config'])
})

test('compareBranches：逐项对齐（= 共有 / - 仅 A / + 仅 B）+ 结论', () => {
  const aHead = { id: 'n-a', parentId: 'r', role: 'assistant', content: '方案 A', createdAt: 1 }
  const bHead = { id: 'n-b', parentId: 'r', role: 'assistant', content: '方案 B', createdAt: 2 }
  const a = [
    aHead,
    toolNode('n-a1', 10, 'get_topology', {}),
    toolNode('n-a2', 20, 'apply_config', { deviceId: 'd', commands: ['a'] }),
    toolNode('n-a3', 30, 'verify_ping', { from: 'd', target: '1.1.1.1' }, { ok: false })
  ]
  const b = [
    bHead,
    toolNode('n-b1', 11, 'get_topology', {}),
    toolNode('n-b2', 21, 'apply_config', { deviceId: 'd', commands: ['b'] })
  ]
  const c = compareBranches(aHead, a, bHead, b, { a: 'A', b: 'B' })

  assert.equal(c.a.tools, 3)
  assert.equal(c.b.tools, 2)
  assert.equal(c.a.failed, 1)
  assert.equal(c.b.failed, 0)
  // 首个调用（get_topology，参数相同）应判为「共有」
  assert.equal(c.rows[0].kind, 'same')
  // A 独有的 apply_config 与 verify_ping 应标为 onlyA
  assert.ok(c.rows.some((r) => r.kind === 'onlyA' && r.a.name === 'apply_config'))
  assert.ok(c.rows.some((r) => r.kind === 'onlyA' && r.a.name === 'verify_ping'))
  // B 的 apply_config 参数不同 → 也应成为 onlyB（不是与 A 的 apply 误配成 same）
  assert.ok(c.rows.some((r) => r.kind === 'onlyB' && r.b.name === 'apply_config'))
  assert.equal(c.rows.length, c.a.tools + c.b.tools - c.rows.filter((r) => r.kind === 'same').length)

  // 失败数优先于工具数：A 有失败，B 胜
  assert.match(c.verdict, /^B 更优：失败调用更少/)
})

test('compareBranches：完全一致时如实说「无显著优劣」，不硬凑赢家', () => {
  const head = { id: 'n-h', parentId: 'r', role: 'assistant', content: '同', createdAt: 1 }
  const nodes = [head, toolNode('n-1', 10, 'a', {}, { ok: true, ms: 100 })]
  const c = compareBranches(head, nodes, head, nodes, { a: 'A', b: 'B' })
  assert.equal(c.verdict, '两条分支的工具调用数量、失败数与耗时一致，无显著优劣')
  assert.ok(c.rows.every((r) => r.kind === 'same'))
})

test('renderComparisonMarkdown：含结论、指标表与逐项对比行', () => {
  const head = { id: 'n-h', parentId: 'r', role: 'assistant', content: '同', createdAt: 1 }
  const a = [head, toolNode('n-1', 10, 'a', {}, { ok: true, ms: 5 })]
  const b = [head]
  const c = compareBranches(head, a, head, b, { a: 'A', b: 'B' })
  const md = renderComparisonMarkdown(c, '演示会话')
  assert.match(md, /^# 分支对比：演示会话/)
  assert.match(md, /\*\*结论\*\*/)
  assert.match(md, /\| 工具调用 \| 1 \| 0 \|/)
  assert.match(md, /\| - \|/)
})

test('branchLabelOf：取内容首行并截断，空则回退', () => {
  assert.equal(branchLabelOf({ content: '第一行\n第二行' }, 'X'), '第一行')
  assert.equal(branchLabelOf({ content: 'y'.repeat(50) }, 'X'), `${'y'.repeat(24)}…`)
  assert.equal(branchLabelOf({ content: '   ' }, 'X'), 'X')
})

test('writeCompareReport：写入导出目录并返回文件路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-f8x-'))
  try {
    const r = writeCompareReport(dir, '演示会话', '# 报告\n内容')
    assert.ok(fs.existsSync(r.path), '报告文件应真的落盘')
    assert.match(path.basename(r.path), /compare-.*\.md$/)
    assert.equal(fs.readFileSync(r.path, 'utf8'), '# 报告\n内容')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})