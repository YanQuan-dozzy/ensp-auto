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