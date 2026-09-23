/**
 * TopologyStore 测试（v0.6.1 修复「断开后无法重连/手动连线连不上」）。
 * 覆盖：applyManual 按 id/端点合并（连续保存不互覆盖）、非删除条目复活同 id 墓碑
 * （断连后重连、更新文件后仍可重连）、节点墓碑不被无关保存复活、remove 墓碑跨层生效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TopologyStore, linkKey } from '../.build/harness.mjs'

function tmpStore(t) {
  const file = path.join(os.tmpdir(), `ensp-topo-store-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  t.after(() => fs.rmSync(file, { force: true }))
  return new TopologyStore({ file })
}

const FILE_TOPO = {
  nodes: [
    { id: 'SW1', name: 'SW1', role: 'switch', model: 'S5700' },
    { id: 'PC3', name: 'PC3', role: 'pc', model: 'PC' }
  ],
  links: [{ id: 'f1', from: 'SW1', to: 'PC3', source: 'file' }],
  updatedAt: 1
}

function manualNodes(ids, extra = {}) {
  return ids.map((id) => ({ id, name: id, role: 'switch', source: 'manual', ...extra }))
}

test('applyManual：连续保存互不覆盖（第二次只带新链路，节点/先前链路仍保留）', (t) => {
  const store = tmpStore(t)
  store.applyManual({ nodes: manualNodes(['SW1', 'PC3']), links: [] })
  store.applyManual({
    nodes: manualNodes(['SW1', 'PC3']),
    links: [{ id: 'm1', from: 'SW1', to: 'PC3', label: '手动连线', source: 'manual' }]
  })
  const s = store.snapshot()
  assert.equal(s.nodes.length, 2)
  assert.equal(s.links.length, 1)
  assert.equal(s.links[0].from, 'SW1')
  assert.equal(s.links[0].to, 'PC3')
})

test('applyManual：同 id 手动节点替换（重命名/拖动落位不产生重复节点）', (t) => {
  const store = tmpStore(t)
  store.applyManual({ nodes: manualNodes(['SW1']), links: [] })
  store.applyManual({ nodes: [{ id: 'SW1', name: 'SW1-改', role: 'switch', source: 'manual', x: 9, y: 9 }], links: [] })
  const s = store.snapshot()
  assert.equal(s.nodes.length, 1)
  assert.equal(s.nodes[0].name, 'SW1-改')
  assert.equal(s.nodes[0].x, 9)
})

test('断开后重连：断开的链路打墓碑，重连（手动活链路）顶掉墓碑复活', (t) => {
  const store = tmpStore(t)
  store.setFile(FILE_TOPO)
  assert.equal(store.snapshot().links.length, 1)
  const key = linkKey('SW1', 'PC3')

  // 画布「断开全部链路」
  store.remove({ linkKeys: [key] })
  assert.equal(store.snapshot().links.length, 0)

  // 重新导入/更新工程文件：物理链路回来了，但用户显式删除不自动复活（跨层删除语义）
  store.setFile(FILE_TOPO)
  assert.equal(store.snapshot().links.length, 0)

  // 用户手动重连（拖线）→ 非删除手动链路复活墓碑
  const s = store.applyManual({
    nodes: [],
    links: [{ id: 'm1', from: 'SW1', to: 'PC3', label: '手动连线', source: 'manual' }]
  })
  assert.equal(s.links.length, 1)
  assert.ok(!s.links[0].deleted) // 复活后不再是墓碑
  assert.equal(s.links[0].label, '手动连线')
})

test('节点删除墓碑不被无关手动保存复活；同名手动节点可复活', (t) => {
  const store = tmpStore(t)
  store.setFile(FILE_TOPO)
  store.remove({ nodeIds: ['PC3'] })
  assert.equal(store.snapshot().nodes.length, 1)

  // 无关保存（如拖动其它节点）不复活 PC3
  store.applyManual({ nodes: manualNodes(['SW1']), links: [] })
  assert.equal(store.snapshot().nodes.length, 1)

  // 同名手动节点（重新添加）复活
  const s = store.applyManual({
    nodes: [{ id: 'PC3', name: 'PC3', role: 'pc', source: 'manual', x: 5, y: 6 }],
    links: []
  })
  assert.equal(s.nodes.length, 2)
  assert.ok(s.nodes.some((n) => n.id === 'PC3' && !n.deleted))
})

test('remove 墓碑跨层持久生效：文件层再次出现也不复活', (t) => {
  const store = tmpStore(t)
  store.setFile(FILE_TOPO)
  store.remove({ nodeIds: ['PC3'] })
  store.setFile(FILE_TOPO) // 聚合节点删除：PC3 与其链路一起墓碑
  const s = store.snapshot()
  assert.equal(s.nodes.length, 1)
  assert.equal(s.links.length, 0)
})

test('重复删除幂等：墓碑不叠加、不出错', (t) => {
  const store = tmpStore(t)
  store.setFile(FILE_TOPO)
  store.remove({ linkKeys: [linkKey('SW1', 'PC3')] })
  store.remove({ linkKeys: [linkKey('SW1', 'PC3')] })
  store.remove({ linkKeys: [linkKey('SW1', 'PC3')] })
  assert.equal(store.snapshot().links.length, 0)
})