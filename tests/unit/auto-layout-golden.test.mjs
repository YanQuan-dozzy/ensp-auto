import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeAutoLayout } from '../.build/harness.mjs'

/**
 * 自适应布局的「坐标不变式」（T4.6）。
 *
 * 布局算法的性能优化（把 O(n²) 的 includes/filter 换成 Set）**不允许改变结果**：
 * 用户看到的图纸必须一模一样，否则「优化」就是把已有图纸全打乱。
 * 因此这里冻结一份逐节点坐标：任何改动只要挪动了一个节点，就会在这里失败。
 */

const NODES = [
  { id: 'r1', name: 'r1', role: 'router' },
  { id: 'r2', name: 'r2', role: 'router' },
  { id: 'sw1', name: 'sw1', role: 'switch' },
  { id: 'sw2', name: 'sw2', role: 'switch' },
  { id: 'pc1', name: 'pc1', role: 'pc' },
  { id: 'pc2', name: 'pc2', role: 'pc' },
  { id: 'pc3', name: 'pc3', role: 'pc' },
  { id: 'pc4', name: 'pc4', role: 'pc' },
  { id: 'pc5', name: 'pc5', role: 'pc' },
  { id: 'x1', name: 'x1', role: 'unknown' }
]

const LINKS = [
  { id: 'l1', from: 'r1', to: 'r2' },
  { id: 'l2', from: 'r1', to: 'sw1' },
  { id: 'l3', from: 'r2', to: 'sw2' },
  { id: 'l4', from: 'sw1', to: 'pc1' },
  { id: 'l5', from: 'sw1', to: 'pc2' },
  { id: 'l6', from: 'sw1', to: 'sw2' },
  { id: 'l7', from: 'sw2', to: 'pc3' },
  { id: 'l8', from: 'sw2', to: 'pc4' },
  { id: 'l9', from: 'pc4', to: 'pc5' }
]

/** 冻结于 2026-09-29（「窗口取中点 + 终端 1 格 + 外部网横排」重排后实测）。
 * 有意的重排要重新冻结；之后任何改动只要挪动一个节点就会在这里失败。 */
const GOLDEN = {
  pc1: [160, 800],
  pc2: [480, 800],
  pc3: [640, 800],
  pc4: [1280, 800],
  pc5: [1280, 1120],
  r1: [640, 160],
  r2: [1280, 160],
  sw1: [320, 480],
  sw2: [960, 480],
  x1: [160, 1600]
}

test('T4.6 布局结果逐节点坐标与优化前一致', () => {
  const pos = computeAutoLayout(NODES, LINKS)
  const actual = {}
  for (const id of Object.keys(GOLDEN).sort()) {
    const p = pos.get(id)
    assert.ok(p, `${id} 必须有坐标`)
    actual[id] = [p.x, p.y]
  }
  assert.deepEqual(actual, GOLDEN, '布局结果不允许被性能优化改变')
})

test('T4.6 大图仍满足分层与不重叠的基本约束（性能改动没有破坏结构）', () => {
  const nodes = []
  const links = []
  nodes.push({ id: 'core', name: 'core', role: 'router' })
  for (let i = 0; i < 30; i++) {
    nodes.push({ id: `sw${i}`, name: `sw${i}`, role: 'switch' })
    links.push({ id: `c${i}`, from: 'core', to: `sw${i}` })
    for (let j = 0; j < 5; j++) {
      const pc = `sw${i}-pc${j}`
      nodes.push({ id: pc, name: pc, role: 'pc' })
      links.push({ id: `e${i}-${j}`, from: `sw${i}`, to: pc })
    }
  }

  const pos = computeAutoLayout(nodes, links)
  assert.equal(pos.size, nodes.length)

  const core = pos.get('core')
  const sw0 = pos.get('sw0')
  const pc = pos.get('sw0-pc0')
  assert.ok(core.y < sw0.y, '路由器应在上层')
  assert.ok(sw0.y < pc.y, '终端应在下层')

  // 不重叠：任何两个节点不能落在一个点上
  const seen = new Set()
  for (const [, p] of pos) {
    const key = `${p.x},${p.y}`
    assert.equal(seen.has(key), false, `坐标重叠：${key}`)
    seen.add(key)
  }
})
