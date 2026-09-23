/**
 * 结构化验证解析器 v2 测试（路由 / ARP / NAT / Eth-Trunk）。
 * 覆盖：回显行解析、表头/分隔线跳过、routeMatches 前缀匹配、两种 ARP 表格兼容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ipToInt,
  parseArpTable,
  parseEthTrunk,
  parseNatOutbound,
  parseNatServer,
  parseNetwork,
  parseRoutingTable,
  routeMatches
} from '../.build/harness.mjs'

test('parseRoutingTable：IPv4 路由行解析，表头/汇总/分隔线跳过', () => {
  const text = [
    'Route Flags: R - relay, D - download to fib',
    '------------------------------------------------------------------------------',
    'Routing Table : Public',
    '         Destinations : 5        Routes : 6',
    '',
    'Destination/Mask    Proto   Pre  Cost      Flags NextHop         Interface',
    '       10.0.1.0/24  OSPF    10   2           D   192.168.12.2    GigabitEthernet0/0/1',
    '       10.0.12.0/24  Direct   0   0           D   192.168.12.1    GigabitEthernet0/0/0',
    '      127.0.0.0/8   Direct  0    0           D   127.0.0.1       InLoopBack0'
  ].join('\n')
  const rows = parseRoutingTable(text)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].network, '10.0.1.0/24')
  assert.equal(rows[0].protocol, 'OSPF')
  assert.equal(rows[0].preference, 10)
  assert.equal(rows[0].cost, 2)
  assert.equal(rows[0].nextHop, '192.168.12.2')
  assert.equal(rows[0].interface, 'GigabitEthernet0/0/1')
  assert.equal(rows[1].protocol, 'Direct')
  assert.equal(rows[2].interface, 'InLoopBack0')
})

test('parseRoutingTable：无路由行返回空数组', () => {
  assert.deepEqual(parseRoutingTable('Destinations : 0        Routes : 0'), [])
  assert.deepEqual(parseRoutingTable(''), [])
})

test('parseArpTable：带 VLAN 列的交换机回显', () => {
  const text = [
    'IP Address       MAC Address     VLAN     Interface              Aging Type',
    '192.168.10.1   5489-98b7-2c11   -        GE0/0/1                14    I',
    '192.168.10.2   000c.29e8.3f4a   10       GE0/0/10               5     I'
  ].join('\n')
  const rows = parseArpTable(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].ip, '192.168.10.1')
  assert.equal(rows[0].mac, '5489-98b7-2c11')
  assert.equal(rows[0].interface, 'GE0/0/1')
  assert.equal(rows[0].type, 'I')
  assert.equal(rows[1].mac, '000c.29e8.3f4a')
})

test('parseArpTable：路由器 EXPIRE 列格式也兼容', () => {
  const text = [
    ' IP ADDRESS      MAC ADDRESS     EXPIRE(M) TYPE        INTERFACE      VPN-INSTANCE',
    '------------------------------------------------------------------------------',
    ' 192.168.12.1    5489-988a-9b1e   18        I          GE0/0/1'
  ].join('\n')
  const rows = parseArpTable(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ip, '192.168.12.1')
  assert.equal(rows[0].interface, 'GE0/0/1')
})

test('parseNatOutbound：Easy IP 表格行', () => {
  const text = [
    ' NAT Outbound Information:',
    ' ----------------------------------------------------------',
    ' Interface                     Acl    Address-group/IP/Interface      Type',
    ' GigabitEthernet0/0/1          2000      current-interface           easyip'
  ].join('\n')
  const rows = parseNatOutbound(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].interface, 'GigabitEthernet0/0/1')
  assert.equal(rows[0].acl, 2000)
  assert.equal(rows[0].type, 'easyip')
})

test('parseNatServer：按 Interface 分块解析端口映射', () => {
  const text = [
    ' NAT Server Information:',
    ' ----------------------------------------------------------',
    ' Interface : GigabitEthernet0/0/1',
    '   Global IP/Port    : current-interface/8080',
    '   Inside IP/Port    : 192.168.1.100/80',
    '   Protocol : tcp',
    '',
    ' Total : 1'
  ].join('\n')
  const rows = parseNatServer(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].iface, 'GigabitEthernet0/0/1')
  assert.equal(rows[0].global, 'current-interface/8080')
  assert.equal(rows[0].inside, '192.168.1.100/80')
  assert.equal(rows[0].protocol, 'tcp')
})

test('parseNatServer：空/无匹配回显返回空数组', () => {
  assert.deepEqual(parseNatServer(''), [])
  assert.deepEqual(parseNatServer('No nat server configured.'), [])
})

test('parseEthTrunk：聚合组状态 + 成员表', () => {
  const text = [
    "Eth-Trunk1's state information is:",
    'WorkingMode: NORMAL         Hash arithmetic: According to SIP-XOR-DIP',
    'Least Active-linknumber: 1  Max Bandwidth-affected-linknumber: 8',
    'Operate status: up          Number Of Up Port In Trunk: 2',
    '---------------------------------------------------------------------------------',
    'PortName                      Status      Weight',
    'GigabitEthernet0/0/9          Up          1',
    'GigabitEthernet0/0/10         Up          1'
  ].join('\n')
  const info = parseEthTrunk(text)
  assert.ok(info)
  assert.equal(info.trunk, 'Eth-Trunk1')
  assert.equal(info.workingMode, 'NORMAL')
  assert.equal(info.operateStatus, 'up')
  assert.equal(info.upPorts, 2)
  assert.equal(info.members.length, 2)
  assert.equal(info.members[0].port, 'GigabitEthernet0/0/9')
  assert.equal(info.members[1].status, 'up')
})

test('parseEthTrunk：未配置返回 null', () => {
  assert.equal(parseEthTrunk(''), null)
  assert.equal(parseEthTrunk('Error: % Unrecognized command'), null)
})

test('ipToInt / parseNetwork / routeMatches：前缀匹配语义', () => {
  assert.equal(ipToInt('192.168.1.1'), 0xc0a80101)
  assert.equal(ipToInt('1.2.3.999'), null)

  const net = parseNetwork('10.0.12.0/24')
  assert.equal(net.base, ipToInt('10.0.12.0'))
  assert.equal(net.prefix, 24)
  assert.equal(parseNetwork('10.0.12.0/33'), null)
  assert.equal(parseNetwork('bad'), null)

  const entry = { network: '10.0.12.0/24', protocol: 'Static', preference: 60, cost: 0, nextHop: '10.0.12.2' }
  assert.equal(routeMatches(entry, '10.0.12.0/24'), true)
  assert.equal(routeMatches(entry, '10.0.12.2'), true)
  assert.equal(routeMatches(entry, '10.0.13.2'), false)
  assert.equal(routeMatches(entry, '10.0.13.0/24'), false)
})