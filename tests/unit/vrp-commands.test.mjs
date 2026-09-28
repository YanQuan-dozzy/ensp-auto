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

// —— v2.27：新增主题 + 三级检索 ——

test('v2.27 新增主题：三层交换 / 单臂路由 / STP / VRRP / DHCP 中继 / 路由引入 / 设备管理 / 报错速查', () => {
  for (const id of [
    'l3_switch',
    'single_arm',
    'stp',
    'vrrp',
    'dhcp_relay',
    'route_adv',
    'device_mgmt',
    'error_ref'
  ]) {
    assert.equal(lookupVrpTopic(id).entry?.id, id, `${id} 主题缺失或不可按 id 命中`)
  }
  assert.ok(VRP_TOPICS.length >= 20, `主题覆盖面不足（当前 ${VRP_TOPICS.length} 个）`)
})

test('子串检索取「匹配键最长」者：「三层交换」不能落到 vlan 主题上', () => {
  // vlan 的别名含「交换」，l3_switch 的别名含「三层交换」—— 按数组顺序会错命中 vlan
  const r = lookupVrpTopic('三层交换怎么配')
  assert.equal(r.entry?.id, 'l3_switch', `实际命中 ${r.entry?.id}，最长匹配优先失效`)
  // 反方向：只写「交换」时仍应落到 vlan（既有主题优先级不被新主题抢走）
  assert.equal(lookupVrpTopic('交换').entry?.id, 'vlan')
})

test('v2.27 正文全文检索：按命令关键字或报错现象也能查到主题', () => {
  // 只记得半条命令
  const allowPass = lookupVrpTopic('allow-pass')
  assert.equal(allowPass.matched, true)
  assert.equal(allowPass.entry?.id, 'vlan')
  assert.equal(allowPass.matchedBy, 'content', '正文命中要标出来，提示模型核对后再照抄')

  // 只记得报错现象
  assert.equal(lookupVrpTopic('wrong parameter').entry?.id, 'error_ref')
  // 命令名（别名与正文都能覆盖）
  assert.equal(lookupVrpTopic('arp broadcast enable').entry?.id, 'single_arm')
  assert.equal(lookupVrpTopic('import-route').entry?.id, 'route_adv')
})

test('v2.27 命中方式回传：精确 / 子串 / 正文三态可区分', () => {
  assert.equal(lookupVrpTopic('ospf').matchedBy, 'exact')
  assert.equal(lookupVrpTopic('ospf邻居起不来').matchedBy, 'alias')
  assert.equal(lookupVrpTopic('region-configuration').entry?.id, 'stp')
  // 精确命中优先于正文命中（dhcpv6 仍归 ipv6，不被 dhcp/dhcp_relay 抢走）
  assert.equal(lookupVrpTopic('dhcpv6').entry?.id, 'ipv6')
  assert.equal(lookupVrpTopic('dhcp中继').entry?.id, 'dhcp_relay')
  assert.equal(lookupVrpTopic('dhcp').entry?.id, 'dhcp')
})

/**
 * 构建守卫（2026-09-28，真事故）：electron-vite 的 `esmShimPlugin` 用一条**未锚定行首**的
 * 正则（见 node_modules/electron-vite `ESMStaticImportRe`）在产物里找「最后一个 import 语句」，
 * 再把 CJS shim `appendRight(indexToAppend, ...)` 追加到匹配结束处。若词典里出现
 * **以 `import` 结尾的字符串**，匹配会跨过 `",` 与下一个 `"…`，落到字符串中间 ——
 * 产物直接变成 `Unterminated string literal`，`electron-vite build` 报错、`out/main` 被清空。
 *
 * 已真实踩过一次：`'filter-policy <acl号|ip-prefix 名> export | import'`。
 * 词典是纯文本重灾区，这条用例把「文本措辞」和「构建能不能过」绑在一起。
 */
test('构建守卫：词典文本不得让 electron-vite 的 CJS shim 注入错位', () => {
  // 模拟 Rollup 的产物形态：字符串用双引号（单引号串会被输出成双引号串）
  const emitted = JSON.stringify(VRP_TOPICS).replace(/\\"/g, '"').replace(/\\'/g, "'")
  const bad = /import\s*["']/.exec(emitted)
  assert.equal(
    bad,
    null,
    `词典文本里有「import 紧跟引号」的片段，会让 electron-vite 的 shim 注入落在字符串中间：${bad && bad[0]}`
  )
})
