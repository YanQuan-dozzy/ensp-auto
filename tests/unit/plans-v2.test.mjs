/**
 * 任务计划生成器 v2 测试（static_route / rip / acl_nat / eth_trunk）。
 * 覆盖：命令生成顺序、默认参数、非法输入 fail-fast、期望校验形态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planAclNat, planEthTrunk, planRip, planStaticRoute } from '../.build/harness.mjs'

test('planStaticRoute：ip route-static 目标网段/掩码/下一跳 + 路由表命中校验', () => {
  const plan = planStaticRoute([
    {
      deviceId: 'r1',
      routes: [
        { destination: '10.0.23.0', prefix: 24, nextHop: '10.0.12.2' },
        { destination: '3.3.3.3', prefix: 32, nextHop: '10.0.12.2' }
      ]
    }
  ])
  assert.equal(plan.steps.length, 1)
  const s = plan.steps[0]
  assert.equal(s.deviceId, 'r1')
  assert.deepEqual(s.commands, [
    'ip route-static 10.0.23.0 255.255.255.0 10.0.12.2',
    'ip route-static 3.3.3.3 255.255.255.255 10.0.12.2'
  ])
  assert.equal(s.expectation.command, 'display ip routing-table')
  assert.equal(s.expectation.expect, '10.0.23.0/24')
  assert.equal(s.expectation.mode, 'contains')
  assert.ok(s.expectation.times >= 2)
})

test('planStaticRoute：空 routes 与非法前缀 fail-fast', () => {
  assert.throws(() => planStaticRoute([{ deviceId: 'r1', routes: [] }]), /未指定任何静态路由/)
  assert.throws(
    () => planStaticRoute([{ deviceId: 'r1', routes: [{ destination: '10.0.0.0', prefix: 33, nextHop: '1.1.1.1' }] }]),
    /前缀非法/
  )
})

test('planRip：默认 version 2 进程 1，network 逐条宣告', () => {
  const plan = planRip([{ deviceId: 'r1', networks: ['10.0.12.0', '1.0.0.0'] }])
  const s = plan.steps[0]
  assert.deepEqual(s.commands, ['rip 1', 'version 2', 'network 10.0.12.0', 'network 1.0.0.0', 'quit'])
  assert.equal(s.expectation.command, 'display rip 1')
  assert.equal(s.expectation.expect, 'RIP process')
})

test('planRip：version 1 / 自定义进程号被采纳；空 networks fail-fast', () => {
  const plan = planRip([{ deviceId: 'r1', process: 2, version: 1, networks: ['192.168.1.0'] }])
  assert.deepEqual(plan.steps[0].commands.slice(0, 2), ['rip 2', 'version 1'])
  assert.throws(() => planRip([{ deviceId: 'r1', networks: [] }]), /未指定 RIP 宣告网段/)
})

test('planAclNat：ACL + Easy IP 组合（先建 ACL 再引用在接口上）', () => {
  const plan = planAclNat([
    {
      deviceId: 'gw',
      acls: [{ number: 2000, rules: ['rule 5 permit source 192.168.1.0 0.0.0.255'] }],
      easyIp: { acl: 2000, interface: 'GigabitEthernet 0/0/1' }
    }
  ])
  const s = plan.steps[0]
  assert.deepEqual(s.commands, [
    'acl number 2000',
    'rule 5 permit source 192.168.1.0 0.0.0.255',
    'quit',
    'interface GigabitEthernet 0/0/1',
    'nat outbound 2000',
    'quit'
  ])
  assert.equal(s.expectation.command, 'display nat outbound')
  assert.equal(s.expectation.expect, '2000')
})

test('planAclNat：nat server 端口映射 + 期望校验形态切换', () => {
  const plan = planAclNat([
    {
      deviceId: 'gw',
      natServers: [
        { interface: 'GigabitEthernet 0/0/1', protocol: 'tcp', globalPort: 8080, insideAddr: '192.168.1.100', insidePort: 80 }
      ]
    }
  ])
  const s = plan.steps[0]
  assert.ok(s.commands.includes('nat server protocol tcp global current-interface 8080 inside 192.168.1.100 80'))
  assert.equal(s.expectation.command, 'display nat server')
  assert.equal(s.expectation.expect, '192.168.1.100')
})

test('planAclNat：只有 ACL 时校验 display acl all；非法引用/端口/协议 fail-fast', () => {
  const onlyAcl = planAclNat([{ deviceId: 'gw', acls: [{ number: 3000, rules: ['rule 5 deny ip'] }] }])
  assert.equal(onlyAcl.steps[0].expectation.command, 'display acl all')
  assert.equal(onlyAcl.steps[0].expectation.expect, 'ACL 3000')

  assert.throws(
    () => planAclNat([{ deviceId: 'gw', easyIp: { acl: 2000, interface: 'x' } }]),
    /未在 acls 中定义/
  )
  assert.throws(
    () =>
      planAclNat([
        { deviceId: 'gw', natServers: [{ interface: 'x', protocol: 'icmp', globalPort: 80, insideAddr: '1.1.1.1', insidePort: 80 }] }
      ]),
    /协议非法/
  )
  assert.throws(
    () => planAclNat([{ deviceId: 'gw', acls: [{ number: 2000, rules: [] }] }]),
    /没有规则/
  )
})

test('planEthTrunk：manual 缺省 + 成员逐个加入聚合组', () => {
  const plan = planEthTrunk([
    { deviceId: 'sw1', members: ['GigabitEthernet 0/0/9', 'GigabitEthernet 0/0/10'] }
  ])
  const s = plan.steps[0]
  assert.deepEqual(s.commands, [
    'interface Eth-Trunk 1',
    'quit',
    'interface GigabitEthernet 0/0/9',
    'eth-trunk 1',
    'quit',
    'interface GigabitEthernet 0/0/10',
    'eth-trunk 1',
    'quit'
  ])
  assert.equal(s.expectation.command, 'display eth-trunk 1')
  assert.equal(s.expectation.expect, 'Eth-Trunk1')
})

test('planEthTrunk：lacp-static 模式加 mode 行；空成员 fail-fast', () => {
  const plan = planEthTrunk([{ deviceId: 'sw2', mode: 'lacp-static', members: ['GigabitEthernet 0/0/9'] }])
  assert.ok(plan.steps[0].commands.includes('mode lacp-static'))
  assert.throws(() => planEthTrunk([{ deviceId: 'sw1', members: [] }]), /未指定聚合成员/)
})