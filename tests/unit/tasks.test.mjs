/**
 * 任务级封装测试（v1.8）。
 * 覆盖：IP 规划纯函数（互联段/回环口/掩码）、任务计划生成器
 * （ospf / vlan / dhcp / pc_connectivity 的命令生成与期望校验）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dottedMask,
  interlinkPair,
  loopbackIp,
  hostInNetwork,
  planOspf,
  planVlan,
  planDhcp,
  planPcConnectivity
} from '../.build/harness.mjs'

// ———————————————— IP 规划 ————————————————

test('dottedMask：前缀长度转点分掩码', () => {
  assert.equal(dottedMask(24), '255.255.255.0')
  assert.equal(dottedMask(16), '255.255.0.0')
  assert.equal(dottedMask(32), '255.255.255.255')
  assert.equal(dottedMask(0), '0.0.0.0')
  assert.equal(dottedMask(25), '255.255.255.128')
  // 越界钳制
  assert.equal(dottedMask(-1), dottedMask(0))
  assert.equal(dottedMask(40), dottedMask(32))
})

test('interlinkPair：10.0.AB.x/24，低编号取 .1、高编号取 .2', () => {
  const p = interlinkPair(1, 2)
  assert.equal(p.network, '10.0.12.0')
  assert.equal(p.mask, '255.255.255.0')
  assert.deepEqual(p.a, { ip: '10.0.12.1', mask: '255.255.255.0', prefix: 24 })
  assert.deepEqual(p.b, { ip: '10.0.12.2', mask: '255.255.255.0', prefix: 24 })
  // 传入顺序无关
  const rev = interlinkPair(2, 1)
  assert.equal(rev.a.ip, '10.0.12.1')
  assert.equal(rev.b.ip, '10.0.12.2')
})

test('loopbackIp：X.X.X.X/32', () => {
  assert.deepEqual(loopbackIp(1), { ip: '1.1.1.1', mask: '255.255.255.255', prefix: 32 })
  assert.deepEqual(loopbackIp(12), { ip: '12.12.12.12', mask: '255.255.255.255', prefix: 32 })
})

test('hostInNetwork：子网内主机地址', () => {
  assert.deepEqual(hostInNetwork('192.168.10.0', 24, 5), {
    ip: '192.168.10.5',
    mask: '255.255.255.0',
    prefix: 24
  })
})

// ———————————————— OSPF ————————————————

test('planOspf：生成 loopback + router-id + 区域宣告，期望邻居 Full', () => {
  const plan = planOspf([
    {
      deviceId: '127.0.0.1:2004',
      routerId: '1.1.1.1',
      loopback: '1.1.1.1',
      networks: [
        { network: '10.0.12.0', wildcard: '0.0.0.255', area: '0.0.0.0' }
      ]
    },
    {
      deviceId: '127.0.0.1:2007',
      networks: [{ network: '10.0.12.0', wildcard: '0.0.0.255' }]
    }
  ])
  assert.equal(plan.steps.length, 2)

  const r1 = plan.steps[0]
  assert.ok(r1.commands[0].startsWith('interface LoopBack 0'))
  assert.ok(r1.commands.includes('ip address 1.1.1.1 255.255.255.255'))
  assert.ok(r1.commands.includes('ospf 1 router-id 1.1.1.1'))
  assert.ok(r1.commands.includes('area 0.0.0.0'))
  assert.ok(r1.commands.includes('network 10.0.12.0 0.0.0.255'))
  assert.deepEqual(r1.expectation, { command: 'display ospf peer', expect: 'Full', mode: 'contains', times: 3 })

  // 未给 router-id：按顺序兜底 X.X.X.X
  const r2 = plan.steps[1]
  assert.ok(r2.commands.includes('ospf 1 router-id 2.2.2.2'))
  // 未给 loopback：不该配回环口
  assert.ok(!r2.commands.some((c) => c.startsWith('interface LoopBack')))
})

// ———————————————— VLAN ————————————————

test('planVlan：vlan batch + access/trunk 划分 + vlanif', () => {
  const plan = planVlan([
    {
      deviceId: '127.0.0.1:2005',
      vlans: [10, 20],
      ports: [
        { port: 'GigabitEthernet 0/0/1', vlan: 10, mode: 'access' },
        { port: 'GigabitEthernet 0/0/2', vlan: 20, mode: 'access' },
        { port: 'GigabitEthernet 0/0/24', vlan: [10, 20], mode: 'trunk' }
      ],
      vlanifs: [{ vlan: 10, ip: '192.168.10.1', prefix: 24 }]
    }
  ])
  const step = plan.steps[0]
  assert.ok(step.commands.includes('vlan batch 10 20'))
  assert.ok(step.commands.includes('interface GigabitEthernet 0/0/1'))
  assert.ok(step.commands.includes('port default vlan 10'))
  assert.ok(step.commands.includes('port trunk allow-pass vlan 10 20'))
  assert.ok(step.commands.includes('interface Vlanif 10'))
  assert.ok(step.commands.includes('ip address 192.168.10.1 255.255.255.0'))
  assert.deepEqual(step.expectation, { command: 'display vlan', expect: '20', mode: 'contains' })
})

// ———————————————— DHCP ————————————————

test('planDhcp：dhcp enable + 池定义 + vlanif 绑定 global，收尾 ping 网关', () => {
  const plan = planDhcp({
    deviceId: '127.0.0.1:2005',
    pools: [{ name: 'vlan10', network: '192.168.10.0', prefix: 24, gateway: '192.168.10.1' }],
    bindings: [{ vlanif: 10 }]
  })
  const step = plan.steps[0]
  assert.equal(plan.steps.length, 1)
  assert.ok(step.commands[0] === 'dhcp enable')
  const joined = step.commands.join('\n')
  assert.ok(joined.includes('ip pool vlan10'))
  assert.ok(joined.includes('network 192.168.10.0 mask 255.255.255.0'))
  assert.ok(joined.includes('gateway-list 192.168.10.1'))
  assert.ok(joined.includes('interface Vlanif 10'))
  assert.ok(joined.includes('dhcp select global'))
  assert.deepEqual(plan.verifyPairs, [{ from: '127.0.0.1:2005', target: '192.168.10.1' }])
  assert.deepEqual(step.expectation, { command: 'display ip pool', expect: 'vlan10', mode: 'contains' })
})

test('planDhcp：range 与 dns 可选项', () => {
  const plan = planDhcp({
    deviceId: 'srv',
    pools: [
      {
        name: 'p1',
        network: '192.168.20.0',
        prefix: 24,
        gateway: '192.168.20.1',
        dns: '223.5.5.5',
        rangeStart: '192.168.20.10',
        rangeEnd: '192.168.20.200'
      }
    ]
  })
  const joined = plan.steps[0].commands.join('\n')
  assert.ok(joined.includes('range 192.168.20.10 192.168.20.200'))
  assert.ok(joined.includes('dns-list 223.5.5.5'))
})

// ———————————————— pc_connectivity ————————————————

test('planPcConnectivity：无配置步骤，仅连通性验证清单', () => {
  const plan = planPcConnectivity([{ from: 'pc1', target: '192.168.10.1' }])
  assert.deepEqual(plan.steps, [])
  assert.deepEqual(plan.verifyPairs, [{ from: 'pc1', target: '192.168.10.1' }])
})

// ———————————————— v1.8 边界护栏回归 ————————————————

test('interlinkPair：编号拼接出非法网段时 fail-fast（12/13 → 10.0.1213.0）', () => {
  assert.throws(() => interlinkPair(12, 13), /不是合法 IPv4/)
  assert.throws(() => interlinkPair(9, 90), /不是合法 IPv4/)
  assert.throws(() => interlinkPair(0, 5), /整数/)
})

test('loopbackIp：编号越界时 fail-fast（256 → 非合法 IPv4）', () => {
  assert.throws(() => loopbackIp(256), /1\.\.255/)
  assert.throws(() => loopbackIp(0), /1\.\.255/)
  assert.throws(() => loopbackIp(1.5), /整数/)
})

test('planVlan：空 vlans fail-fast，重复 vlan 去重且不原地改调用方数组', () => {
  assert.throws(() => planVlan([{ deviceId: 'sw1', vlans: [] }]), /未指定任何 VLAN/)
  const sw = { deviceId: 'sw1', vlans: [20, 10, 20] }
  const plan = planVlan([sw])
  // 去重 + 升序
  assert.ok(plan.steps[0].commands.includes('vlan batch 10 20'))
  // 复用同一数组两次（幂等）：排序不与上次交替
  assert.deepEqual(sw.vlans, [20, 10, 20])
})

test('planVlan：expectation 取最大 vlan 而非 Math.max（空数组 -Infinity 问题回归）', () => {
  const plan = planVlan([{ deviceId: 'sw1', vlans: [7, 2] }])
  assert.deepEqual(plan.steps[0].expectation, { command: 'display vlan', expect: '7', mode: 'contains' })
})