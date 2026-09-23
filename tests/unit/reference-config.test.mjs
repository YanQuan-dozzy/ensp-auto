/**
 * 参考配置能力学习（v1.2，analyze_reference_configs）测试。
 * 覆盖：段落切分、协议归类、sysname 设备关联、能力汇总。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeReferenceConfig,
  classifySegment,
  deviceFromLine,
  splitConfigSegments
} from '../.build/harness.mjs'

const REFERENCE = `sysname Core1
#
vlan batch 10 20
#
interface Vlanif10
 ip address 192.168.10.1 255.255.255.0
#
ospf 1 router-id 1.1.1.1
 area 0.0.0.0
  network 192.168.10.0 0.0.0.255
  network 20.0.0.0 0.0.0.255
#
ip pool pool1
 network 192.168.20.0 mask 255.255.255.0
 gateway-list 192.168.20.1
#
interface Vlanif20
 ip address 192.168.20.1 255.255.255.0
 dhcp select global
`

test('splitConfigSegments：按空行切段且忽略空段', () => {
  const segs = splitConfigSegments('a\nb\n\nc\n\n\n d')
  assert.deepEqual(segs, ['a\nb', 'c', 'd'])
})

test('splitConfigSegments：VRP `#` 块分隔符同样切段', () => {
  const text = 'sysname Core1\n#\nvlan batch 10\n#\ninterface Vlanif10\n ip address 1.1.1.1 255.255.255.0'
  const segs = splitConfigSegments(text)
  assert.deepEqual(segs, ['sysname Core1', 'vlan batch 10', 'interface Vlanif10\n ip address 1.1.1.1 255.255.255.0'])
})

test('classifySegment：vlan/ospf/dhcp 基本归类', () => {
  assert.equal(classifySegment('vlan batch 10 20').kind, 'vlan')
  assert.equal(classifySegment('ospf 1 router-id 1.1.1.1').kind, 'ospf')
  assert.equal(classifySegment('ip pool pool1\n network 192.168.20.0 mask 255.255.255.0').kind, 'dhcp')
  assert.equal(classifySegment('sysname Core1').kind, 'other')
  assert.equal(classifySegment('interface Vlanif10\n ip address 192.168.10.1 255.255.255.0').kind, 'interface')
})

test('classifySegment：traffic-filter 先于 acl 特化', () => {
  const kind = classifySegment('acl name deny-x\n traffic-filter inbound acl deny-x').kind
  assert.equal(kind, 'traffic-filter')
})

test('classifySegment：dhcp relay 优先于 dhcp', () => {
  assert.equal(classifySegment('interface GigabitEthernet0/0/1\n dhcp select relay').kind, 'dhcp-relay')
})

test('deviceFromLine：sysname 提取', () => {
  assert.equal(deviceFromLine('sysname Core1'), 'Core1')
  assert.equal(deviceFromLine('  sysname  交换机-3 '), '交换机-3')
  assert.equal(deviceFromLine('vlan batch 10'), null)
})

test('analyzeReferenceConfig：关联设备、汇总能力、抽取代表命令', () => {
  const r = analyzeReferenceConfig(REFERENCE)
  assert.deepEqual(r.devices, ['Core1'])
  const kinds = r.capabilities.map((c) => c.kind)
  assert.ok(kinds.includes('ospf'))
  assert.ok(kinds.includes('vlan'))
  assert.ok(kinds.includes('dhcp'))

  const vlan = r.capabilities.find((c) => c.kind === 'vlan')
  assert.deepEqual(vlan.devices, ['Core1'])
  assert.equal(vlan.commandCount, 1)
  assert.ok(vlan.highlights.some((l) => l.includes('vlan batch')))

  const segs = r.segments
  assert.ok(segs.some((s) => s.kind === 'ospf' && s.device === 'Core1'))
})

test('analyzeReferenceConfig：超长给 warning，段落行数受控', () => {
  const big = Array.from({ length: 120 }, (_, i) => `vlan ${i + 10}`).join('\n')
  const r = analyzeReferenceConfig(big, { maxTotalLines: 50 })
  assert.ok(r.warning)
})