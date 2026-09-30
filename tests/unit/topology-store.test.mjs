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
import { TopologyStore, linkKey, linkIdentity } from '../.build/harness.mjs'

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

// —— 多线并接（同一对设备多条物理连线）：删除 / 落库按「条」—— 

/** 核心层双归：C1↔C2 并接两条线 */
const TWO_LINE_TOPO = {
  nodes: [
    { id: 'C1', name: 'C1', role: 'switch' },
    { id: 'C2', name: 'C2', role: 'switch' }
  ],
  links: [
    { id: 'f#0', from: 'C1', to: 'C2', label: 'GE0/0/1 ↔ GE0/0/1', lineKey: 'GE0/0/1->GE0/0/1', source: 'file' },
    { id: 'f#1', from: 'C1', to: 'C2', label: 'GE0/0/2 ↔ GE0/0/2', lineKey: 'GE0/0/2->GE0/0/2', source: 'file' }
  ],
  updatedAt: 1
}

test('多线并接：按条删除只掉命中的那条，另一条保留；重导入不复活', (t) => {
  const store = tmpStore(t)
  store.setFile(TWO_LINE_TOPO)
  assert.equal(store.snapshot().links.length, 2)

  store.remove({ linkKeys: [linkIdentity({ from: 'C1', to: 'C2', lineKey: 'GE0/0/1->GE0/0/1' })] })
  const s = store.snapshot()
  assert.equal(s.links.length, 1)
  assert.equal(s.links[0].lineKey, 'GE0/0/2->GE0/0/2')

  // 墓碑按线匹配：重新导入同一工程，被删的那条不复活，另一条仍在
  store.setFile(TWO_LINE_TOPO)
  const again = store.snapshot()
  assert.equal(again.links.length, 1)
  assert.equal(again.links[0].lineKey, 'GE0/0/2->GE0/0/2')
})

test('多线并接：按设备对删除 / 删除节点 → 该对全部线一起断开', (t) => {
  const store = tmpStore(t)
  store.setFile(TWO_LINE_TOPO)
  store.remove({ linkKeys: [linkKey('C1', 'C2')] }) // 断开全部（设备对粒度）
  assert.equal(store.snapshot().links.length, 0)
  store.setFile(TWO_LINE_TOPO)
  assert.equal(store.snapshot().links.length, 0) // 跨层墓碑持久生效

  const store2 = tmpStore(t)
  store2.setFile(TWO_LINE_TOPO)
  store2.remove({ nodeIds: ['C2'] }) // 删节点连带该设备的全部线
  const s = store2.snapshot()
  assert.equal(s.nodes.length, 1)
  assert.equal(s.links.length, 0)
})

test('多线并接：手动层按条合并——两条线的标注偏移各自独立、不互相顶掉', (t) => {
  const store = tmpStore(t)
  store.setFile(TWO_LINE_TOPO)
  store.applyManual({
    nodes: [],
    links: [
      {
        id: 'f#0',
        from: 'C1',
        to: 'C2',
        label: 'GE0/0/1 ↔ GE0/0/1',
        lineKey: 'GE0/0/1->GE0/0/1',
        source: 'manual',
        portOffsets: { from: [{ x: 10, y: 0 }] }
      },
      {
        id: 'f#1',
        from: 'C1',
        to: 'C2',
        label: 'GE0/0/2 ↔ GE0/0/2',
        lineKey: 'GE0/0/2->GE0/0/2',
        source: 'manual',
        portOffsets: { from: [{ x: -10, y: 0 }] }
      }
    ]
  })
  const s = store.snapshot()
  assert.equal(s.links.length, 2)
  const byLine = new Map(s.links.map((l) => [l.lineKey, l]))
  assert.deepEqual(byLine.get('GE0/0/1->GE0/0/1').portOffsets, { from: [{ x: 10, y: 0 }] })
  assert.deepEqual(byLine.get('GE0/0/2->GE0/0/2').portOffsets, { from: [{ x: -10, y: 0 }] })
})

test('单文件隔离：导入新工程文件重置旧工程手动层，防止幽灵节点污染', (t) => {
  const store = tmpStore(t)
  // 导入工程 A
  store.setFile(FILE_TOPO, 'D:/projA.topo')
  store.applyManual({
    nodes: [{ id: 'SW1', name: 'SW1', role: 'switch', source: 'manual', x: 100, y: 100 }],
    links: []
  })
  assert.equal(store.snapshot().nodes.length, 2)

  // 导入工程 B（包含完全不同的设备）
  const TOPO_B = {
    nodes: [{ id: 'Router-B', name: 'Router-B', role: 'router' }],
    links: [],
    updatedAt: 2
  }
  store.setFile(TOPO_B, 'D:/projB.topo')
  const snapB = store.snapshot()
  assert.equal(snapB.nodes.length, 1)
  assert.equal(snapB.nodes[0].name, 'Router-B')
  // 工程 A 的 SW1 / PC3 绝不能泄漏到工程 B 中
  assert.ok(!snapB.nodes.some((n) => n.id === 'SW1' || n.id === 'PC3'))
  assert.equal(store.fileSourcePath, 'D:/projB.topo')
})

test('工程切换恢复：切回原工程恢复该工程的微调，且互不干扰', (t) => {
  const store = tmpStore(t)
  store.setFile(FILE_TOPO, 'D:/projA.topo')
  store.applyManual({
    nodes: [{ id: 'SW1', name: 'SW1-A定制', role: 'switch', source: 'manual', x: 200, y: 200 }],
    links: []
  })
  assert.equal(store.snapshot().nodes.find((n) => n.id === 'SW1').name, 'SW1-A定制')

  // 切到工程 B
  const TOPO_B = {
    nodes: [{ id: 'SW-B', name: 'SW-B', role: 'switch' }],
    links: [],
    updatedAt: 2
  }
  store.setFile(TOPO_B, 'D:/projB.topo')
  assert.equal(store.snapshot().nodes.length, 1)

  // 切回工程 A
  store.setFile(FILE_TOPO, 'D:/projA.topo')
  const snapA = store.snapshot()
  assert.equal(snapA.nodes.length, 2)
  assert.equal(snapA.nodes.find((n) => n.id === 'SW1').name, 'SW1-A定制')
})

test('load() 脏数据自愈：启动时剔除遗留在 manual 层且不属于 file 层的跨工程幽灵节点', (t) => {
  const file = path.join(os.tmpdir(), `ensp-topo-store-dirty-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  t.after(() => fs.rmSync(file, { force: true }))

  // 模拟之前故障场景写出的脏数据：fileLayer 是工程 B，manualLayer 却残留工程 A 的 2 个孤立节点
  const dirtyData = {
    version: 3,
    file: {
      nodes: [{ id: 'Core-New', name: 'Core-New', role: 'switch' }],
      links: [],
      updatedAt: 10
    },
    manual: {
      nodes: [
        { id: 'Old-Ghost1', name: 'Old-Ghost1', role: 'switch', source: 'manual', x: 10, y: 10 },
        { id: 'Old-Ghost2', name: 'Old-Ghost2', role: 'pc', source: 'manual', x: 20, y: 20 },
        { id: 'm-node-user-custom', name: 'UserAdded', role: 'pc', source: 'manual', x: 30, y: 30 }
      ],
      links: [
        { id: 'l1', from: 'Old-Ghost1', to: 'Old-Ghost2', source: 'manual' }
      ]
    }
  }
  fs.writeFileSync(file, JSON.stringify(dirtyData, null, 2), 'utf8')

  const store = new TopologyStore({ file })
  const snap = store.snapshot()

  // 验证自愈效果：Old-Ghost1 与 Old-Ghost2 被自动剔除，Core-New 与 m-node-user-custom 被保留
  assert.equal(snap.nodes.length, 2)
  assert.ok(snap.nodes.some((n) => n.id === 'Core-New'))
  assert.ok(snap.nodes.some((n) => n.id === 'm-node-user-custom'))
  assert.ok(!snap.nodes.some((n) => n.id === 'Old-Ghost1' || n.id === 'Old-Ghost2'))
  assert.equal(snap.links.length, 0)
})

test('clear()：彻底清空拓扑与活动路径', (t) => {
  const store = tmpStore(t)
  store.setFile(FILE_TOPO, 'D:/test.topo')
  store.applyManual({ nodes: manualNodes(['SW1']), links: [] })
  assert.equal(store.snapshot().nodes.length, 2)
  assert.equal(store.fileSourcePath, 'D:/test.topo')

  store.clear()
  const empty = store.snapshot()
  assert.equal(empty.nodes.length, 0)
  assert.equal(empty.links.length, 0)
  assert.equal(store.fileSourcePath, null)
})