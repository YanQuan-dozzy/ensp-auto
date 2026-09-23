/**
 * 拓扑核心测试（v0.3）：
 * - parseLldpNeighbors：VRP 邻居表格解析（4 列 / 3 列两种版面）
 * - deriveTopology：Mock 探针上推导出结构化拓扑（去重、占位节点、跳过失败设备）
 * - mergeTopology / guessRole / emptyTopology：降级合并与角色推断
 * - toMcpTools：TypeBox schema 输出含 required/properties，danger 工具不外露
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLldpNeighbors,
  deriveTopology,
  mergeTopology,
  guessRole,
  emptyTopology,
  toMcpTools,
  TOOLS
} from '../.build/harness.mjs'

function probe(id, name, model, neighbors) {
  return {
    id,
    name,
    ...(model ? { model } : {}),
    exec: async (cmd) => {
      assert.equal(cmd, 'display lldp neighbor')
      if (neighbors === null) return { ok: false, clean: '', error: 'LLDP is not enabled' }
      return { ok: true, clean: neighbors }
    }
  }
}

const LLDP_4COL = [
  'Local Intf   Neighbor Dev    Neighbor Intf   Exptime(s)',
  'GE0/0/1      SW1             GE0/0/1         120',
  'GE0/0/2      PC-1            GE0/0/24        121',
  ''
].join('\n')

const LLDP_AR1 = ['GE0/0/1  SW1  GE0/0/1  120', ''].join('\n')
const LLDP_SW1 = [
  'GE0/0/1  AR1  GE0/0/1  120',
  'GE0/0/2  PC-1  GE0/0/24  121',
  ''
].join('\n')

test('parseLldpNeighbors 解析 4 列版面', () => {
  const rows = parseLldpNeighbors(LLDP_4COL)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    localIntf: 'GE0/0/1',
    neighborName: 'SW1',
    neighborIntf: 'GE0/0/1'
  })
  assert.deepEqual(rows[1], {
    localIntf: 'GE0/0/2',
    neighborName: 'PC-1',
    neighborIntf: 'GE0/0/24'
  })
})

test('parseLldpNeighbors 跳过表头与噪声行', () => {
  const rows = parseLldpNeighbors('System name  Local Intf\n------------\nGE0/0/1  AR1  GE0/0/1  120\n')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].neighborName, 'AR1')
})

test('deriveTopology：两端相互上报只留一条链路，未知邻居生成占位节点', async () => {
  const probes = [
    probe('127.0.0.1:2001', 'AR1', 'AR2220', LLDP_AR1),
    probe('127.0.0.1:2002', 'SW1', 'S5700', LLDP_SW1)
  ]
  const t = await deriveTopology(probes)
  // AR1 → SW1、SW1 → AR1 两条上报去重为一条；SW1 → PC-1 一条
  assert.equal(t.links.length, 2)
  const ar1sw1 = t.links.filter(
    (l) =>
      (l.from === '127.0.0.1:2001' && l.to === '127.0.0.1:2002') ||
      (l.from === '127.0.0.1:2002' && l.to === '127.0.0.1:2001')
  )
  assert.equal(ar1sw1.length, 1)
  // PC-1 未匹配到已知设备 → 占位节点
  assert.ok(t.nodes.some((n) => n.id === 'neighbor:PC-1'))
  assert.ok(
    t.nodes.some(
      (n) => n.name === 'AR1' && n.role === 'router' && n.deviceId === '127.0.0.1:2001'
    )
  )
})

test('deriveTopology：LLDP 未开启的设备被跳过，不产出节点错误', async () => {
  const probes = [
    probe('127.0.0.1:2001', 'AR1', 'AR2220', LLDP_AR1),
    probe('127.0.0.1:2002', 'SW1', 'S5700', null)
  ]
  const t = await deriveTopology(probes)
  // SW1 的 LLDP 失败只影响它自己那一端；AR1 仍能报出 AR1↔SW1 链路
  assert.equal(t.links.length, 1)
  assert.equal(t.nodes.length, 2)
})

test('guessRole 按型号/名字推断角色', () => {
  assert.equal(guessRole('AR1', 'AR2220'), 'router')
  assert.equal(guessRole('Core-SW1', 'S5735'), 'switch')
  assert.equal(guessRole('FW1', 'USG6000V'), 'firewall')
  assert.equal(guessRole('USG5500'), 'firewall')
  assert.equal(guessRole('AC1', 'AC6005'), 'wlan')
  assert.equal(guessRole('AP-1', 'AP4050DN'), 'wlan')
  assert.equal(guessRole('Server-1', 'Server'), 'server')
  assert.equal(guessRole('Cloud-1', 'Cloud'), 'cloud')
  assert.equal(guessRole('Hub-1', 'Hub'), 'cloud')
  assert.equal(guessRole('PC-1'), 'pc')
  assert.equal(guessRole('某设备'), 'unknown')
})

test('mergeTopology：手动节点覆盖、链路去重、source 标记', () => {
  const discovered = {
    nodes: [
      { id: 'n1', name: 'AR1', role: 'router', deviceId: '127.0.0.1:2001' },
      { id: 'n2', name: 'SW1', role: 'switch', deviceId: '127.0.0.1:2002' }
    ],
    links: [
      { id: 'l1', from: 'n1', to: 'n2', source: 'discovered' },
      { id: 'l2', from: 'n2', to: 'n3', source: 'discovered' }
    ],
    updatedAt: 0
  }
  const manual = {
    nodes: [{ id: 'n1', name: 'AR1-改', role: 'router', x: 10, y: 20 }],
    links: [{ id: 'l2', from: 'n2', to: 'n3', source: 'manual', label: '手动' }]
  }
  const merged = mergeTopology(discovered, manual)
  const n1 = merged.nodes.find((n) => n.id === 'n1')
  assert.equal(n1.name, 'AR1-改')
  assert.equal(n1.source, 'manual')
  assert.equal(n1.deviceId, '127.0.0.1:2001') // 手动节点缺 deviceId 时从发现结果补齐
  const l2 = merged.links.find((l) => l.id === 'l2')
  assert.equal(l2.label, '手动') // 手动链路优先
  assert.equal(merged.links.length, 2) // l1 保留、l2 去重后剩一条
})

test('emptyTopology 返回空结构', () => {
  const t = emptyTopology()
  assert.deepEqual(t.nodes, [])
  assert.deepEqual(t.links, [])
  assert.equal(typeof t.updatedAt, 'number')
})

test('TypeBox 迁移回归：toMcpTools 输出 required/properties，danger 工具不外露', () => {
  const mcp = toMcpTools(TOOLS)
  const names = mcp.map((t) => t.name)
  assert.ok(names.includes('run_show_command'))
  assert.ok(!names.includes('save_configuration'), 'danger 工具不应出现在 MCP 出口')
  const show = mcp.find((t) => t.name === 'run_show_command')
  assert.equal(show.inputSchema.type, 'object')
  assert.deepEqual(show.inputSchema.required, ['deviceId', 'command'])
  assert.equal(typeof show.inputSchema.properties.deviceId, 'object')
  // apply_config 的嵌套 expectation 含枚举约束
  const apply = mcp.find((t) => t.name === 'apply_config')
  assert.deepEqual(apply.inputSchema.required, ['deviceId', 'commands', 'description'])
  assert.equal(
    apply.inputSchema.properties.expectation.properties.mode.anyOf[0].const,
    'contains'
  )
})