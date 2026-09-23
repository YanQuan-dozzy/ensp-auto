/**
 * 结构化验证解析器（v1.2，verify_ping / verify_connectivity / verify_dhcp）测试。
 * 覆盖：ping 统计、interface brief 状态行、DHCP 池、dhcp 配置存在性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasDhcpConfig,
  parseDhcpPools,
  parseInterfaceBrief,
  parseNetwork,
  parsePingOutput,
  routeMatches,
  networkPrefix
} from '../.build/harness.mjs'

test('parsePingOutput：英文统计 + RTT 解析', () => {
  const text = [
    'PING 10.0.0.2: 56 data bytes, press CTRL_C to break',
    '--- 10.0.0.2 ping statistics ---',
    '3 packet(s) transmitted, 3 packet(s) received, 0.0% packet loss',
    'round-trip min/avg/max = 1/2/5 ms'
  ].join('\n')
  const s = parsePingOutput(text)
  assert.equal(s.transmitted, 3)
  assert.equal(s.received, 3)
  assert.equal(s.lossPercent, 0)
  assert.equal(s.minMs, 1)
  assert.equal(s.avgMs, 2)
  assert.equal(s.maxMs, 5)
  assert.equal(s.unreachable, false)
})

test('parsePingOutput：全丢包判定 unreachable', () => {
  const s = parsePingOutput([
    '--- 10.0.0.2 ping statistics ---',
    '3 packet(s) transmitted, 0 packet(s) received, 100.0% packet loss'
  ].join('\n'))
  assert.equal(s.received, 0)
  assert.equal(s.lossPercent, 100)
  assert.equal(s.unreachable, true)
})

test('parsePingOutput：未命中（命令失败/乱码）返回 null', () => {
  assert.equal(parsePingOutput(''), null)
  assert.equal(parsePingOutput('Error: % Unrecognized command'), null)
})

test('parseInterfaceBrief：状态行解析 + 表头/分隔线跳过', () => {
  const text = [
    'Interface                         PHY   Protocol InUti OutUti  inErrors  outErrors',
    'GE0/0/1                           up    up      0%    0%      0         0',
    'GE0/0/2                           down  down    0%    0%      0         0',
    'Ethernet0/0/1                     up    down    0%    0%      0         0',
    '--------------------------------------------------------------------------------',
    'Vlanif10                          up    up      0%    0%      0         0'
  ].join('\n')
  const rows = parseInterfaceBrief(text)
  assert.equal(rows.length, 4)
  assert.equal(rows[0].name, 'GE0/0/1')
  assert.equal(rows[0].phy, 'up')
  assert.equal(rows[0].protocol, 'up')
  assert.equal(rows[1].phy, 'down')
  assert.equal(rows[2].phy, 'up')
  assert.equal(rows[2].protocol, 'down')
  assert.equal(rows[3].name, 'Vlanif10')
})

test('hasDhcpConfig：识别 select/pool/server 且不含混淆词', () => {
  assert.equal(hasDhcpConfig('dhcp select global'), true)
  assert.equal(hasDhcpConfig('dhcp select relay'), true)
  assert.equal(hasDhcpConfig('ip pool pool1'), true)
  assert.equal(hasDhcpConfig('dhcp server forbidden-ip 192.168.1.1'), true)
  assert.equal(hasDhcpConfig('vlan batch 10'), false)
  assert.equal(hasDhcpConfig(''), false)
})

test('parseDhcpPools：多池解析（网段折算前缀 + 地址统计）', () => {
  const text = [
    '  Pool name: pool1',
    '   Network section      : 192.168.1.0      netmask : 255.255.255.0',
    '    Start-address       192.168.1.2',
    '    End-address         192.168.1.254',
    '    Total addresses     : 253',
    '    Used addresses      : 2',
    '',
    '  Pool name: pool2',
    '   Network section      : 10.0.0.0      netmask : 255.0.0.0',
    '    Total addresses     : 16777216'
  ].join('\n')
  const pools = parseDhcpPools(text)
  assert.equal(pools.length, 2)
  assert.equal(pools[0].name, 'pool1')
  assert.equal(pools[0].networkSection, '192.168.1.0/24')
  assert.equal(pools[0].startAddress, '192.168.1.2')
  assert.equal(pools[0].endAddress, '192.168.1.254')
  assert.equal(pools[0].totalAddresses, 253)
  assert.equal(pools[0].usedAddresses, 2)
  assert.equal(pools[1].name, 'pool2')
  assert.equal(pools[1].networkSection, '10.0.0.0/8')
})

test('parseDhcpPools：无 Pool name 头的自由格式兜底为未命名池', () => {
  const text = [
    '   Network section      : 192.168.2.0      netmask : 255.255.255.0',
    '    Total addresses     : 254'
  ].join('\n')
  const pools = parseDhcpPools(text)
  assert.equal(pools.length, 1)
  assert.ok(pools[0].name.startsWith('pool'))
  assert.equal(pools[0].networkSection, '192.168.2.0/24')
})

test('parseDhcpPools：空回显返回空数组', () => {
  assert.deepEqual(parseDhcpPools(''), [])
})

// ———————————————————————— D10（2026-09-23）：默认路由判定 ————————————————————————

test('D10：parseNetwork 接受默认路由 0.0.0.0/0 并归一化 base 为 0', () => {
  // 旧实现 `prefix < 1` 把 /0 当非法 → 默认路由条目永远匹配不上任何目标
  const net = parseNetwork('0.0.0.0/0')
  assert.deepEqual(net, { base: 0, prefix: 0 })
  // 非零 IP 写成 /0 也按 0.0.0.0/0 归一化（覆盖全部地址）
  assert.deepEqual(parseNetwork('1.2.3.4/0'), { base: 0, prefix: 0 })
  assert.equal(parseNetwork('10.0.12.0/24')?.prefix, 24)
  assert.equal(parseNetwork('10.0.12.0/33'), null, '前缀越界仍拒')
})

test('D10：routeMatches 默认路由命中任意裸 IP 目标', () => {
  const def = { network: '0.0.0.0/0', protocol: 'Static', nextHop: '192.168.1.1' }
  assert.equal(routeMatches(def, '8.8.8.8'), true)
  assert.equal(routeMatches(def, '10.0.12.5'), true)
})

test('D10：networkPrefix 提取前缀长度（供最长前缀排序）', () => {
  assert.equal(networkPrefix('0.0.0.0/0'), 0)
  assert.equal(networkPrefix('10.0.12.0/24'), 24)
  assert.equal(networkPrefix('garbage'), 0, '解析失败按 0')
})

test('D10：既有路由匹配不回归 —— /24 路由命中网内目标、不命中网外', () => {
  const r = { network: '10.0.12.0/24', protocol: 'Static', nextHop: '10.0.0.1' }
  assert.equal(routeMatches(r, '10.0.12.5'), true)
  assert.equal(routeMatches(r, '10.0.13.1'), false)
})