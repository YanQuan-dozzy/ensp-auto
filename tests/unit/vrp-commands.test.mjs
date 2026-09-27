/**
 * VRP 命令知识库（F1，v2.12）测试。
 * 覆盖：词典完整性（每主题必有 commands + pitfalls）、两级查询（精确/子串）、
 * 归一化命中（大小写/连字符/下划线）、未命中返回可用清单而非空手而归。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VRP_TOPICS, listTopics, lookupVrpTopic } from '../.build/harness.mjs'

test('词典完整性：每个主题都有 id/别名/命令/易错点', () => {
  assert.ok(VRP_TOPICS.length >= 10, `主题覆盖面不足（当前 ${VRP_TOPICS.length} 个）`)
  const ids = new Set()
  for (const t of VRP_TOPICS) {
    assert.ok(t.id, '主题缺 id')
    assert.equal(ids.has(t.id), false, `主题 id 重复：${t.id}`)
    ids.add(t.id)
    assert.ok(t.aliases.length > 0, `${t.id} 缺别名（无别名则只能精确按 id 查）`)
    assert.ok(t.commands.length > 0, `${t.id} 缺命令事实`)
    for (const c of t.commands) {
      assert.ok(c.syntax, `${t.id} 里有命令缺 syntax`)
      assert.ok(c.description, `${t.id} 里有命令缺 description`)
    }
    assert.ok(t.pitfalls.length > 0, `${t.id} 缺易错点 —— 防幻觉全靠它，不能为空`)
  }
  // 关键防翻车点必须钉在词典里（真实事故回归守卫）
  const ospf = VRP_TOPICS.find((t) => t.id === 'ospf')
  assert.ok(
    ospf.pitfalls.some((p) => p.includes('反掩码')),
    'ospf 主题必须提示 network 反掩码陷阱（10.0.1213.0 同级真实翻车源）'
  )
})

test('精确查询：id、中英文别名、大小写与分隔符归一化', () => {
  assert.equal(lookupVrpTopic('ospf').matched, true)
  assert.equal(lookupVrpTopic('ospf').entry?.id, 'ospf')
  assert.equal(lookupVrpTopic('OSPF').entry?.id, 'ospf', '大小写应归一化')
  assert.equal(lookupVrpTopic('静态路由').entry?.id, 'static_route', '中文别名可命中')
  assert.equal(lookupVrpTopic('Static-Route').entry?.id, 'static_route', '大小写+连字符归一化')
  assert.equal(lookupVrpTopic('eth_trunk').entry?.id, 'eth_trunk')
  assert.equal(lookupVrpTopic('Eth Trunk').entry?.id, 'eth_trunk', '空格归一化')
})

test('ipv6 主题：id 与协议别名（ospfv3 / ripng / dhcpv6）都能命中', () => {
  assert.equal(lookupVrpTopic('ipv6').entry?.id, 'ipv6')
  assert.equal(lookupVrpTopic('IPv6').entry?.id, 'ipv6', '大小写归一化')
  assert.equal(lookupVrpTopic('ipv6静态路由').entry?.id, 'ipv6')
  assert.equal(lookupVrpTopic('ospfv3').entry?.id, 'ipv6')
  assert.equal(lookupVrpTopic('ripng').entry?.id, 'ipv6')
  assert.equal(lookupVrpTopic('dhcpv6').entry?.id, 'ipv6', 'dhcpv6 不能被 dhcp 主题抢走')
  // IPv4 主题不能被新主题影响
  assert.equal(lookupVrpTopic('dhcp').entry?.id, 'dhcp')
  assert.equal(lookupVrpTopic('ospf').entry?.id, 'ospf')
  assert.equal(lookupVrpTopic('rip').entry?.id, 'rip')
})

test('子串查询：查询词与别名互为子串都算命中', () => {
  // 别名是查询词的子串：「ospf邻居排查」包含「ospf」
  const long = lookupVrpTopic('ospf邻居怎么配')
  assert.equal(long.matched, true)
  assert.equal(long.entry?.id, 'ospf')
  // 查询词是别名的子串：'vlan' 命中含 'vlan' 别名的主题
  assert.equal(lookupVrpTopic('vl').matched, true)
})

test('未命中：返回可用主题清单（matched=false），不算空手而归', () => {
  const miss = lookupVrpTopic('量子路由协议')
  assert.equal(miss.matched, false)
  assert.ok(Array.isArray(miss.available) && miss.available.length > 0)
  assert.deepEqual(miss.available, listTopics())
  // 空查询同样给清单
  assert.equal(lookupVrpTopic('   ').matched, false)
  assert.ok(lookupVrpTopic('').available?.length > 0)
})
