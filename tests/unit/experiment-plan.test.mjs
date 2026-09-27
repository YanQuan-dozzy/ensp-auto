/**
 * 实验规划器（F4，v2.12）测试。
 * 覆盖：kind 推断与显式指定、设备编号（末尾数字/顺延/冲突）、互联网段 10.0.AB.x、
 * 回环 X.X.X.X/32、主机网段 192.168.V.0/24、静态路由 BFS 首跳、越界编号 fail-fast 转警告、
 * 空拓扑不炸只给警告。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferKind, deviceNumber, buildExperimentPlan } from '../.build/harness.mjs'

let linkSeq = 0
/** 三路由器链状拓扑 R1–R2–R3 + 一台交换机 + 一台 PC（可覆写设备名） */
function chainTopo(over = {}) {
  const name = (i, dflt) => (over[`n${i}`] ?? dflt)
  const now = Date.now()
  return {
    nodes: [
      { id: 'd1', name: name(1, 'R1'), role: 'router', deviceId: '127.0.0.1:2000' },
      { id: 'd2', name: name(2, 'R2'), role: 'router', deviceId: '127.0.0.1:2001' },
      { id: 'd3', name: name(3, 'R3'), role: 'router', deviceId: '127.0.0.1:2002' },
      { id: 'sw1', name: name(4, 'SW1'), role: 'switch', deviceId: '127.0.0.1:3000' },
      { id: 'pc1', name: name(5, 'PC1'), role: 'pc' }
    ],
    links: [
      { id: `l${++linkSeq}`, from: 'd1', to: 'd2', label: 'GE0/0/0 ↔ GE0/0/0', source: 'lldp' },
      { id: `l${++linkSeq}`, from: 'd2', to: 'd3', label: 'GE0/0/1 ↔ GE0/0/0', source: 'lldp' },
      { id: `l${++linkSeq}`, from: 'sw1', to: 'pc1', label: 'GE0/0/2 ↔ Ethernet0/0/1', source: 'manual' }
    ],
    updatedAt: now
  }
}

test('inferKind：关键词表按优先级命中，无命中回退 pc_connectivity', () => {
  assert.equal(inferKind('用OSPF让三台路由器互通'), 'ospf')
  assert.equal(inferKind('给PC自动分配地址，DHCP 地址池'), 'dhcp')
  assert.equal(inferKind('配置静态路由 route-static'), 'static_route')
  assert.equal(inferKind('链路聚合 Eth-Trunk'), 'eth_trunk')
  assert.equal(inferKind('划分VLAN 并做端口划分'), 'vlan')
  assert.equal(inferKind('做NAT上网'), 'acl_nat')
  assert.equal(inferKind('验证PC连通性'), 'pc_connectivity')
  assert.equal(inferKind('随便看看'), 'pc_connectivity', '未命中不下发配置，回退最保守的连通性')
})

test('deviceNumber：取名称末尾数字，无数字/非正数返回 null', () => {
  assert.equal(deviceNumber('R1'), 1)
  assert.equal(deviceNumber('AR2'), 2)
  assert.equal(deviceNumber('Core-SW3'), 3)
  assert.equal(deviceNumber('Router12'), 12)
  assert.equal(deviceNumber('R1-b'), null, '末尾非数字不取中间数字')
  assert.equal(deviceNumber('SW'), null)
})

test('互联网段与回环：10.0.AB.x/24（低侧 .1）+ 路由器回环 X.X.X.X/32', () => {
  const plan = buildExperimentPlan(chainTopo(), '跑OSPF动态路由实验')
  assert.equal(plan.kind, 'ospf')
  assert.equal(plan.kindInferred, true)

  // 编号：R1→1 R2→2 R3→3 SW1→4（PC 不编号）
  assert.deepEqual(
    plan.numbering.map((n) => [n.name, n.num]),
    [['R1', 1], ['R2', 2], ['R3', 3], ['SW1', 4]]
  )

  // 设备间两条链路进规划；交换机↔PC 不进（PC 无 deviceId）
  assert.equal(plan.interlinks.length, 2)
  const l12 = plan.interlinks[0]
  assert.equal(l12.network, '10.0.12.0')
  assert.equal(l12.a.name, 'R1')
  assert.equal(l12.a.ip, '10.0.12.1', '低编号侧取 .1')
  assert.equal(l12.b.ip, '10.0.12.2', '高编号侧取 .2')
  assert.equal(l12.a.port, 'GE0/0/0', '端口取自链路标签')
  assert.equal(l12.b.port, 'GE0/0/0')

  // 回环只给 router/firewall（交换机不给）
  assert.deepEqual(
    plan.loopbacks.map((l) => [l.name, l.ip]),
    [['R1', '1.1.1.1'], ['R2', '2.2.2.2'], ['R3', '3.3.3.3']]
  )
})

test('OSPF 参数包：router-id 取回环，宣告覆盖互联网段与回环 /32，交换机不参与', () => {
  const plan = buildExperimentPlan(chainTopo(), 'OSPF 实验', { kind: 'ospf' })
  assert.equal(plan.kindInferred, false, '显式指定 kind 时不算推断')
  const routers = plan.taskArgs.routers
  assert.equal(routers.length, 3, '只有三台路由器，交换机不跑 OSPF')
  const r1 = routers.find((r) => r.deviceId === 'd1')
  assert.equal(r1.routerId, '1.1.1.1')
  assert.deepEqual(
    r1.networks.map((n) => n.network),
    ['10.0.12.0', '1.1.1.1'],
    'R1 宣告自己的互联网段 + 回环'
  )
  assert.equal(r1.networks[0].wildcard, '0.0.0.255', '互联网段用反掩码')
  assert.equal(r1.networks[1].wildcard, '0.0.0.0', '回环用 /32 反掩码')
  const r2 = routers.find((r) => r.deviceId === 'd2')
  assert.deepEqual(
    r2.networks.map((n) => n.network),
    ['10.0.12.0', '10.0.23.0', '2.2.2.2'],
    '中间路由器宣告两条互联网段'
  )
})

test('静态路由参数包：BFS 首跳，跨两跳的目标 nextHop 指向第一个邻居', () => {
  const plan = buildExperimentPlan(chainTopo(), '静态路由实验', { kind: 'static_route' })
  const r1 = plan.taskArgs.routers.find((r) => r.deviceId === 'd1')
  // R1 的目标：10.0.23.0/24（R2–R3 链路，非直连）+ 2.2.2.2/32 + 3.3.3.3/32
  const byDest = new Map(r1.routes.map((r) => [`${r.destination}/${r.prefix}`, r.nextHop]))
  assert.equal(byDest.get('10.0.23.0/24'), '10.0.12.2', '下一跳是 R2 在 R1–R2 链路上的地址')
  assert.equal(byDest.get('2.2.2.2/32'), '10.0.12.2')
  assert.equal(byDest.get('3.3.3.3/32'), '10.0.12.2', '跨两跳仍是同一个首跳')
  assert.equal(
    r1.routes.some((r) => r.destination === '10.0.12.0'),
    false,
    '直连网段不产生静态路由'
  )
  // R2 缺省路由场景：R3 的路由应指向 R2 在本链路上的地址（R2 是低编号侧 → .1）
  const r3 = plan.taskArgs.routers.find((r) => r.deviceId === 'd3')
  const r3to12 = r3.routes.find((r) => r.destination === '10.0.12.0')
  assert.equal(r3to12.nextHop, '10.0.23.1', '高编号侧设备（R3）的下一跳是低编号侧邻居（R2=.1）')
})

test('vlan/dhcp 主机网段：192.168.V.0/24，网关 .1，主机从 .10 起', () => {
  const plan = buildExperimentPlan(chainTopo(), 'VLAN 划分实验', { kind: 'vlan', vlans: [10, 20] })
  assert.deepEqual(
    plan.hostSegments.map((h) => [h.vlan, h.network, h.gateway, h.hostStart]),
    [[10, '192.168.10.0', '192.168.10.1', '192.168.10.10'], [20, '192.168.20.0', '192.168.20.1', '192.168.20.10']]
  )
  const sw = plan.taskArgs.switches.find((s) => s.deviceId === 'sw1')
  assert.deepEqual(sw.vlans, [10, 20])
  assert.deepEqual(
    sw.vlanifs.map((v) => [v.vlan, v.ip]),
    [[10, '192.168.10.1'], [20, '192.168.20.1']]
  )
  // 交换机↔PC 链路给 access 建议（端口从标签取）
  assert.ok(
    plan.notes.some((n) => n.includes('GE0/0/2') && n.includes('PC')),
    'PC 接入口建议应含交换机侧端口名'
  )

  const dhcp = buildExperimentPlan(chainTopo(), 'DHCP', { kind: 'dhcp', vlans: [10] })
  assert.equal(dhcp.taskArgs.task, 'dhcp')
  assert.equal(dhcp.taskArgs.server, 'sw1', '唯一的交换机当 DHCP 服务器')
  assert.deepEqual(
    dhcp.taskArgs.pools.map((p) => [p.name, p.gateway]),
    [['vlan10', '192.168.10.1']]
  )
})

test('编号冲突顺延 + 越界编号 fail-fast 转警告（不产出非法网段）', () => {
  // 两台都叫 R2：第二台冲突顺延为 1，并给警告
  const conflict = buildExperimentPlan(
    chainTopo({ n1: 'R2', n2: 'R2' }),
    '连通性',
    { kind: 'static_route' }
  )
  const nums = conflict.numbering.map((n) => n.num).sort((a, b) => a - b)
  assert.deepEqual(nums, [1, 2, 3, 4], '冲突设备顺延编号，编号集不重复')
  assert.ok(
    conflict.warnings.some((w) => w.includes('顺延')),
    '编号冲突必须给警告'
  )

  // 编号 88 与 99 拼出 10.0.8899.0 —— 必须拦下，链路标记 skipped
  const big = buildExperimentPlan(
    chainTopo({ n1: 'R88', n2: 'R99' }),
    '连通性',
    { kind: 'static_route' }
  )
  const bad = big.interlinks.find((l) => l.a.name === 'R88' || l.b.name === 'R88')
  assert.equal(bad.skipped, 'invalid-segment')
  assert.equal(bad.network, '', '非法链路不得携带网段')
  assert.ok(big.warnings.some((w) => w.includes('R88')), '越界编号要有可读警告')
})

test('空拓扑：不炸，给「没有可规划设备」警告', () => {
  const plan = buildExperimentPlan(
    { nodes: [{ id: 'pc1', name: 'PC1', role: 'pc' }], links: [], updatedAt: Date.now() },
    'OSPF'
  )
  assert.equal(plan.numbering.length, 0)
  assert.ok(plan.warnings.some((w) => w.includes('没有可规划的网络设备')))
})
