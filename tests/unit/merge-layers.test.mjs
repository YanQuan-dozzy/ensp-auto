/**
 * 三层降级合并（mergeLayers）测试：file 最权威 / discovered 补缺 / manual 覆盖 / 链路去重 /
 * deviceId 对齐（文件节点 id=name、实采节点 id=127.0.0.1:port 按 deviceId 认亲）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeLayers } from '../.build/harness.mjs'

const file = {
  nodes: [
    { id: 'AR1', name: 'AR1', role: 'router', model: 'AR2220', deviceId: '127.0.0.1:2008', x: 100, y: 50 },
    { id: 'SW1', name: 'SW1', role: 'switch', deviceId: '127.0.0.1:2009', x: 300, y: 50 }
  ],
  links: [{ id: 'f1', from: 'AR1', to: 'SW1', source: 'file', label: 'GE0/0/1↔GE0/0/1' }],
  updatedAt: 1
}

test('mergeLayers：file 优先，discovered 补缺，manual 覆盖坐标', () => {
  const discovered = {
    nodes: [
      // 与文件 AR1 同一设备：id 用 TCP 地址，按 deviceId 认亲合并进 AR1
      { id: '127.0.0.1:2008', name: 'AR1', role: 'router', deviceId: '127.0.0.1:2008', model: 'AR2220' },
      // 文件没有的设备 → 补缺
      { id: '127.0.0.1:2010', name: 'R2', role: 'router', deviceId: '127.0.0.1:2010' }
    ],
    links: [{ id: 'd1', from: '127.0.0.1:2008', to: '127.0.0.1:2010', source: 'discovered' }],
    updatedAt: 2
  }
  const manual = {
    nodes: [{ id: 'AR1', name: 'AR1', role: 'router', x: 999, y: 999, source: 'manual' }],
    links: []
  }

  const t = mergeLayers(file, discovered, manual)

  // AR1：坐标被 manual 覆盖，model/deviceId 保留，source=manual
  const ar1 = t.nodes.find((n) => n.name === 'AR1')
  assert.equal(ar1.id, 'AR1') // deviceId 对齐后仍用文件 id
  assert.equal(ar1.x, 999)
  assert.equal(ar1.deviceId, '127.0.0.1:2008')
  assert.equal(ar1.model, 'AR2220')
  assert.equal(ar1.source, 'manual')
  // discovered 补缺
  assert.ok(t.nodes.some((n) => n.name === 'R2' && n.id === '127.0.0.1:2010'))
  // 链路：file 保留 + discovered 补缺；总 2 条
  assert.equal(t.links.length, 2)
  assert.ok(t.links.some((l) => l.source === 'file' && l.from === 'AR1' && l.to === 'SW1'))
  assert.ok(t.links.some((l) => l.source === 'discovered'))
})

test('mergeLayers：manual 链路 label 覆盖 file/discovered 同端点', () => {
  const manual = {
    nodes: [],
    links: [
      { id: 'm1', from: 'AR1', to: 'SW1', label: '手动重连', source: 'manual' },
      { id: 'm2', from: 'R9', to: 'SW1', label: '纯手动', source: 'manual' }
    ]
  }
  const t = mergeLayers(file, { nodes: [], links: [{ from: 'AR1', to: 'SW1', label: 'LLDP 标签', source: 'discovered' }] }, manual)
  const pair = t.links.find((l) => l.from === 'AR1' && l.to === 'SW1')
  assert.equal(pair.label, '手动重连') // manual 覆盖
  assert.equal(pair.source, 'manual')
  assert.ok(t.links.some((l) => l.from === 'R9')) // 纯手动链路保留
})

test('mergeLayers：file 链路不被 discovered 覆盖，discovered 仅补缺', () => {
  const t = mergeLayers(
    file,
    { nodes: [], links: [{ from: 'AR1', to: 'SW1', label: 'LLDP', source: 'discovered' }] },
    { nodes: [], links: [] }
  )
  const pair = t.links.find((l) => l.from === 'AR1' && l.to === 'SW1')
  assert.equal(pair.label, 'GE0/0/1↔GE0/0/1') // file 权威
  assert.equal(pair.source, 'file')
})

test('mergeLayers：无 file 层时行为等同旧两层合并', () => {
  const t = mergeLayers(
    null,
    { nodes: [{ id: 'n1', name: 'A', role: 'router' }], links: [], updatedAt: 1 },
    { nodes: [{ id: 'n1', name: 'A-改', role: 'router', source: 'manual' }], links: [] }
  )
  assert.equal(t.nodes[0].name, 'A-改')
  assert.equal(t.nodes[0].source, 'manual')
})

test('mergeLayers：手动覆盖坐标/角色不丢 file 层解析的 interfaces（拓扑展示增强）', () => {
  const file = {
    nodes: [
      { id: 'SW1', name: 'SW1', role: 'switch', interfaces: ['GE0/0/0', 'GE0/0/1', 'GE0/0/2', 'GE0/0/3'], x: 1, y: 2 }
    ],
    links: [],
    updatedAt: 1
  }
  // 手动层拖动落位：仅坐标，无 interfaces → 应保留 file 层接口表
  const t = mergeLayers(
    file,
    { nodes: [], links: [], updatedAt: 1 },
    { nodes: [{ id: 'SW1', name: 'SW1', role: 'switch', x: 99, y: 99, source: 'manual' }], links: [] }
  )
  const sw1 = t.nodes.find((n) => n.id === 'SW1')
  assert.equal(sw1.x, 99)
  assert.deepEqual(sw1.interfaces, ['GE0/0/0', 'GE0/0/1', 'GE0/0/2', 'GE0/0/3'])
})

test('mergeLayers：deleted 墓碑过滤节点（v0.6 F-5.6）', () => {
  // file 层有 AR1，manual 层打删除墓碑 → 合并结果不含 AR1
  const t = mergeLayers(
    { nodes: [{ id: 'AR1', name: 'AR1', role: 'router', x: 1, y: 2 }], links: [], updatedAt: 1 },
    { nodes: [], links: [], updatedAt: 1 },
    { nodes: [{ id: 'AR1', name: 'AR1', role: 'router', deleted: true, source: 'manual' }], links: [] }
  )
  assert.equal(t.nodes.length, 0)
  assert.equal(t.links.length, 0)
})

test('mergeLayers：deleted 墓碑过滤节点；链路由调用方（TopologyStore.remove）连带墓碑', () => {
  const file = {
    nodes: [
      { id: 'AR1', name: 'AR1', role: 'router' },
      { id: 'SW1', name: 'SW1', role: 'switch' },
      { id: 'PC1', name: 'PC1', role: 'pc' }
    ],
    links: [
      { id: 'l1', from: 'AR1', to: 'SW1', source: 'file' },
      { id: 'l2', from: 'SW1', to: 'PC1', source: 'file' }
    ],
    updatedAt: 1
  }
  // 只墓碑节点 SW1：节点消失，链路保留在结构里（渲染层按端点存在性过滤）
  const t = mergeLayers(
    file,
    { nodes: [], links: [], updatedAt: 1 },
    { nodes: [{ id: 'SW1', name: 'SW1', role: 'switch', deleted: true, source: 'manual' }], links: [] }
  )
  assert.deepEqual(t.nodes.map((n) => n.id).sort(), ['AR1', 'PC1'])
  // 链路墓碑显式给出时同样被过滤
  const t2 = mergeLayers(
    file,
    { nodes: [], links: [], updatedAt: 1 },
    {
      nodes: [{ id: 'SW1', name: 'SW1', role: 'switch', deleted: true, source: 'manual' }],
      links: [
        { from: 'AR1', to: 'SW1', deleted: true, source: 'manual' },
        { from: 'SW1', to: 'PC1', deleted: true, source: 'manual' }
      ]
    }
  )
  assert.equal(t2.nodes.length, 2)
  assert.equal(t2.links.length, 0)
})

test('mergeLayers：链路墓碑只删该链路，节点保留', () => {
  const file = {
    nodes: [
      { id: 'AR1', name: 'AR1', role: 'router' },
      { id: 'SW1', name: 'SW1', role: 'switch' }
    ],
    links: [{ id: 'l1', from: 'AR1', to: 'SW1', source: 'file' }],
    updatedAt: 1
  }
  const t = mergeLayers(
    file,
    { nodes: [], links: [], updatedAt: 1 },
    {
      nodes: [],
      links: [{ from: 'AR1', to: 'SW1', deleted: true, source: 'manual' }]
    }
  )
  assert.equal(t.nodes.length, 2)
  assert.equal(t.links.length, 0)
})

test('mergeLayers：手动复活被删链路（manual 非 deleted 覆盖墓碑）', () => {
  const file = {
    nodes: [
      { id: 'AR1', name: 'AR1', role: 'router' },
      { id: 'SW1', name: 'SW1', role: 'switch' }
    ],
    links: [{ id: 'l1', from: 'AR1', to: 'SW1', source: 'file' }],
    updatedAt: 1
  }
  const t = mergeLayers(
    file,
    { nodes: [], links: [], updatedAt: 1 },
    {
      nodes: [],
      links: [
        { from: 'AR1', to: 'SW1', deleted: true, source: 'manual' },
        { from: 'AR1', to: 'SW1', label: '重连', source: 'manual' }
      ]
    }
  )
  assert.equal(t.links.length, 1)
  assert.equal(t.links[0].deleted, false) // 手动非 deleted 覆盖墓碑
  assert.equal(t.links[0].label, '重连')
})

test('mergeLayers：旧持久化数据自愈——墓碑在前、复活条目在后（活条目优先）', () => {
  const file = {
    nodes: [
      { id: 'SW1', name: 'SW1', role: 'switch' },
      { id: 'PC3', name: 'PC3', role: 'pc' }
    ],
    links: [{ id: 'f1', from: 'SW1', to: 'PC3', source: 'file' }],
    updatedAt: 1
  }
  // 模拟修复前 applyManual 追加顺序：活条目在前、墓碑在后面（后写覆盖前写 → 链路被删）
  const t = mergeLayers(
    file,
    { nodes: [], links: [], updatedAt: 1 },
    {
      nodes: [],
      links: [
        { from: 'SW1', to: 'PC3', label: '重连', source: 'manual' },
        { from: 'SW1', to: 'PC3', deleted: true, source: 'manual' }
      ]
    }
  )
  assert.equal(t.links.length, 1)
  assert.ok(!t.links[0].deleted) // 活条目不被同端点墓碑压掉
  assert.equal(t.links[0].label, '重连')
})

test('mergeLayers：旧持久化节点自愈——墓碑与同名手动节点并存时节点复活', () => {
  const file = {
    nodes: [{ id: 'PC3', name: 'PC3', role: 'pc' }],
    links: [],
    updatedAt: 1
  }
  const t = mergeLayers(
    file,
    { nodes: [], links: [], updatedAt: 1 },
    {
      nodes: [
        { id: 'PC3', name: 'PC3', role: 'pc', source: 'manual', x: 1, y: 2 },
        { id: 'PC3', name: 'PC3', role: 'pc', deleted: true, source: 'manual' }
      ],
      links: []
    }
  )
  assert.equal(t.nodes.length, 1)
  assert.ok(!t.nodes[0].deleted)
})

test('mergeLayers：墓碑压制 file/discovered 同端点链路——文件重导入不自动复活已删除链路', () => {
  const file = {
    nodes: [
      { id: 'AR1', name: 'AR1', role: 'router' },
      { id: 'SW1', name: 'SW1', role: 'switch' }
    ],
    links: [{ id: 'l1', from: 'AR1', to: 'SW1', source: 'file' }],
    updatedAt: 1
  }
  // 墓碑在手动层，file 层也有同端点链路（重新导入后的文件）→ 墓碑生效，链路仍被删
  const t = mergeLayers(
    file,
    { nodes: [], links: [], updatedAt: 1 },
    {
      nodes: [],
      links: [{ from: 'AR1', to: 'SW1', deleted: true, source: 'manual' }]
    }
  )
  assert.equal(t.links.length, 0)
})