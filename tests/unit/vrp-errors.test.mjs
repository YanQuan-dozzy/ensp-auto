/**
 * VRP 报错诊断表 + 下发前静态预检（v2.27）测试。
 *
 * 覆盖：
 * - 诊断表与通信层 ERROR_PATTERNS **双向对账**（有一条设备错误码没引导即失败）
 * - explainVrpError 的命中/未命中与提示内容
 * - preflightCommands 每条规则的「该报」与「不该报」（误报守卫）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ERROR_PATTERNS,
  VRP_ERROR_GUIDE,
  listVrpErrorCodes,
  explainVrpError,
  preflightCommands
} from '../.build/harness.mjs'

const rulesOf = (cmds) => preflightCommands(cmds).map((f) => f.rule)

test('诊断表覆盖通信层出现过的每一个设备错误码（双向对账）', () => {
  const patternCodes = new Set(ERROR_PATTERNS.map((p) => p.code))
  for (const code of patternCodes) {
    assert.ok(VRP_ERROR_GUIDE[code], `错误码 ${code} 在 ERROR_PATTERNS 里但诊断表没有条目`)
  }
  // 反向：诊断表里的码必须是 ErrorCode 合法成员（由类型钉住，这里守住运行时可枚举性）
  assert.ok(listVrpErrorCodes().length >= patternCodes.size)
  for (const code of listVrpErrorCodes()) {
    const g = VRP_ERROR_GUIDE[code]
    assert.ok(g.meaning, `${code} 缺中文释义`)
    assert.ok(g.causes.length > 0, `${code} 缺常见根因`)
    assert.ok(g.fixes.length > 0, `${code} 缺纠正动作`)
    assert.ok(g.topics.length > 0, `${code} 缺相关主题（模型无处深查）`)
  }
})

test('高价值错误码的根因必须钉住真实翻车点', () => {
  assert.ok(
    VRP_ERROR_GUIDE.BAD_PARAM.causes.some((c) => c.includes('反掩码')),
    'BAD_PARAM 必须点出反掩码/掩码写反（最高频 Wrong parameter）'
  )
  assert.ok(
    VRP_ERROR_GUIDE.UNRECOGNIZED.causes.some((c) => c.includes('视图')),
    'UNRECOGNIZED 必须点出「视图不对」这一主因'
  )
  assert.ok(
    VRP_ERROR_GUIDE.FAILED.causes.some((c) => c.includes('shutdown') || c.includes('未满足')),
    'FAILED 必须指向依赖未满足（而非让模型乱猜）'
  )
  assert.ok(
    VRP_ERROR_GUIDE.BUSY.meaning.includes('执行'),
    'BUSY 是设备在跑上一条命令，不是配置错'
  )
})

test('explainVrpError：命中带出命令原文与纠正；未登记错误码返回 null', () => {
  const hit = explainVrpError('BAD_PARAM', 'network 10.0.0.0 255.255.255.0')
  assert.ok(hit)
  assert.ok(hit.hint.includes('network 10.0.0.0 255.255.255.0'), '提示里要能看到是哪条命令错了')
  assert.ok(hit.hint.includes('反掩码'), '提示要给出真正的纠正方向')
  assert.ok(hit.hint.includes('lookup_vrp_command'), '提示要指到可深查的工具')

  assert.equal(explainVrpError(undefined), null)
  assert.equal(explainVrpError('NOT_A_REAL_CODE'), null)
})

test('preflight：全角字符（含全角空格）必须报，半角中文描述不报', () => {
  assert.ok(rulesOf(['interface GigabitEthernet0/0/1', 'description 核心口']).includes('fullwidth-char') === false)
  const fw = preflightCommands(['ip\u3000address 10.0.0.1 24'])
  assert.equal(fw.length, 1)
  assert.equal(fw[0].rule, 'fullwidth-char')
  assert.equal(fw[0].level, 'warn')
})

test('preflight：OSPF network 用子网掩码要报，用反掩码不报', () => {
  const bad = preflightCommands(['ospf 1', 'area 0.0.0.0', 'network 10.0.12.0 255.255.255.0'])
  const hit = bad.find((f) => f.rule === 'wildcard-vs-mask')
  assert.ok(hit, 'network + 子网掩码必须报（真实翻车点）')
  assert.ok(hit.fix.includes('0.0.0.255'), `纠正建议要给出反掩码，实际：${hit.fix}`)

  assert.deepEqual(
    rulesOf(['ospf 1', 'area 0.0.0.0', 'network 10.0.12.0 0.0.0.255']),
    [],
    '正确写法不能被误报'
  )
  // 0.0.0.0 既是 /0 掩码也是「匹配全部」反掩码 —— 两可值必须放过（否则误报失去可信度）
  assert.deepEqual(rulesOf(['network 0.0.0.0 0.0.0.0']), [])
})

test('preflight：ACL rule 的 source/destination 反掩码写反要报', () => {
  const f = preflightCommands(['rule 5 permit source 192.168.1.0 255.255.255.0'])
  assert.ok(f.some((x) => x.rule === 'wildcard-vs-mask'))
  assert.deepEqual(rulesOf(['rule 5 permit source 192.168.1.0 0.0.0.255']), [])
  // 单主机写法（source <ip> 0）合法，不报
  assert.deepEqual(rulesOf(['rule 5 deny ip source 10.0.0.1 0 destination 10.0.0.2 0']), [])
})

test('preflight：ip address / ip route-static 用反掩码要报，用掩码或前缀长度不报', () => {
  assert.ok(rulesOf(['ip address 10.0.0.1 0.0.0.255']).includes('mask-vs-wildcard'))
  assert.ok(rulesOf(['ip route-static 10.0.30.0 0.0.0.255 10.0.12.2']).includes('mask-vs-wildcard'))
  assert.deepEqual(rulesOf(['ip address 10.0.0.1 255.255.255.0']), [])
  assert.deepEqual(rulesOf(['ip address 10.0.0.1 24']), [])
  assert.deepEqual(rulesOf(['ip route-static 0.0.0.0 0 10.0.12.2']), [])
  assert.deepEqual(rulesOf(['ip route-static 10.0.30.0 255.255.255.0 10.0.12.2']), [])
})

test('preflight：DHCP 地址池 network ... mask 要掩码，写反掩码要报', () => {
  const f = preflightCommands(['ip pool vlan10', 'network 192.168.10.0 mask 0.0.0.255'])
  const hit = f.find((x) => x.rule === 'mask-vs-wildcard')
  assert.ok(hit, '地址池 mask 位写反掩码必须报')
  assert.ok(hit.fix.includes('255.255.255.0'))
  assert.equal(
    rulesOf(['ip pool vlan10', 'network 192.168.10.0 mask 255.255.255.0']).includes('mask-vs-wildcard'),
    false,
    '正确写法不能被误报'
  )
})

test('preflight：RIP 的 network 只吃主类网号', () => {
  const f = preflightCommands(['rip 1', 'version 2', 'network 10.0.12.0'])
  const hit = f.find((x) => x.rule === 'rip-classful-network')
  assert.ok(hit, 'RIP 里 network 写含主机位的子网必须报')
  assert.ok(hit.fix.includes('10.0.0.0'))

  const withMask = preflightCommands(['rip 1', 'network 10.0.0.0 0.0.0.255'])
  assert.ok(withMask.some((x) => x.rule === 'rip-classful-network'), 'RIP 不接受掩码参数')

  assert.deepEqual(rulesOf(['rip 1', 'version 2', 'network 10.0.0.0']), [])
})

test('preflight：trunk / access 口漏放行或漏 PVID', () => {
  const f = preflightCommands(['interface GigabitEthernet0/0/1', 'port link-type trunk'])
  const trunk = f.find((x) => x.rule === 'trunk-without-allow-pass')
  assert.ok(trunk && trunk.level === 'warn', 'trunk 未放行是 VLAN 实验第一大错')
  assert.deepEqual(
    rulesOf([
      'interface GigabitEthernet0/0/1',
      'port link-type trunk',
      'port trunk allow-pass vlan 10 20'
    ]),
    []
  )

  const acc = preflightCommands(['interface GigabitEthernet0/0/2', 'port link-type access'])
  const accHit = acc.find((x) => x.rule === 'access-without-default-vlan')
  assert.ok(accHit && accHit.level === 'info', 'access 漏 PVID 是提示级')
})

test('preflight：单臂路由子接口漏 arp broadcast enable', () => {
  const f = preflightCommands([
    'interface GigabitEthernet0/0/1.10',
    'dot1q termination vid 10',
    'ip address 192.168.10.1 24'
  ])
  assert.ok(f.some((x) => x.rule === 'dot1q-without-arp-broadcast'), '漏 arp broadcast enable 必须报')
  assert.deepEqual(
    rulesOf([
      'interface GigabitEthernet0/0/1.10',
      'dot1q termination vid 10',
      'ip address 192.168.10.1 24',
      'arp broadcast enable'
    ]),
    []
  )
})

test('preflight：DHCP 依赖与 Vlanif 引用（提示级，允许设备上已存在）', () => {
  const dhcp = preflightCommands(['ip pool vlan10', 'network 192.168.10.0 mask 255.255.255.0'])
  const dhcpHit = dhcp.find((x) => x.rule === 'dhcp-without-enable')
  assert.ok(dhcpHit && dhcpHit.level === 'info')
  assert.ok(
    rulesOf(['dhcp enable', 'ip pool vlan10', 'network 192.168.10.0 mask 255.255.255.0']).includes(
      'dhcp-without-enable'
    ) === false
  )

  const vlanif = preflightCommands(['interface Vlanif 10', 'ip address 192.168.10.1 24'])
  const vlanifHit = vlanif.find((x) => x.rule === 'vlanif-without-vlan')
  assert.ok(vlanifHit && vlanifHit.message.includes('10'))
  assert.deepEqual(
    rulesOf(['vlan batch 10', 'interface Vlanif 10', 'ip address 192.168.10.1 24']),
    []
  )
})

test('preflight：VLAN ID 越界 与 save 卡 [Y/N]', () => {
  assert.ok(rulesOf(['vlan batch 10 5000']).includes('vlan-id-range'))
  assert.ok(rulesOf(['vlan batch 4095']).includes('vlan-id-range'))
  assert.deepEqual(rulesOf(['vlan batch 10 to 20']), [])

  assert.ok(rulesOf(['save']).includes('save-in-apply'))
  assert.ok(rulesOf(['sysname R1', 'save force']).includes('save-in-apply'))
})

// ————————————————— v2.30：用户视图命令 × 目标视图 —————————————————

const USER_VIEW_RULE = 'user-view-command-in-system-view'

test('preflight：用户视图命令落在系统视图批次里必须报（实测翻车点）', () => {
  const f = preflightCommands(['reset saved-configuration'])
  const hit = f.find((x) => x.rule === USER_VIEW_RULE)
  assert.ok(hit, 'reset saved-configuration 在默认（系统视图）批次里必须报')
  assert.equal(hit.level, 'warn')
  assert.ok(hit.fix.includes("view:'user'"), '纠正建议必须给出可照做的参数写法')
  assert.ok(preflightCommands(['reboot']).some((x) => x.rule === USER_VIEW_RULE))
  assert.ok(preflightCommands(['reset current-configuration']).some((x) => x.rule === USER_VIEW_RULE))
})

test('preflight：显式 view:user 或批次里已有 return 时不报用户视图冲突', () => {
  assert.deepEqual(
    preflightCommands(['reset saved-configuration'], { view: 'user' }).filter((x) => x.rule === USER_VIEW_RULE),
    [],
    'view:user 时就不该再报（这条冲突已经由工具处理掉了）'
  )
  assert.deepEqual(
    preflightCommands(['return', 'reset saved-configuration']).filter((x) => x.rule === USER_VIEW_RULE),
    [],
    '批次里先 return 回用户视图的写法能成功，不该误报'
  )
  // quit 只退一层（接口视图 → 系统视图），因此不能免除告警
  assert.ok(
    preflightCommands(['quit', 'reset saved-configuration']).some((x) => x.rule === USER_VIEW_RULE),
    'quit 不足以回到用户视图，仍应报'
  )
})

test('preflight：普通配置命令与 save 不受用户视图规则干扰（save 走自己的规则）', () => {
  assert.deepEqual(rulesOf(['sysname R1', 'vlan batch 10', 'interface GigabitEthernet0/0/1']), [])
  const save = preflightCommands(['save'])
  assert.ok(save.some((x) => x.rule === 'save-in-apply'))
  assert.ok(!save.some((x) => x.rule === USER_VIEW_RULE), 'save 已有专属规则，不重复报')
})

test('诊断表：UNSETTLED（回显结束但没回到提示符）有条目与可照做的纠正', () => {
  assert.ok(VRP_ERROR_GUIDE.UNSETTLED, 'UNSETTLED 必须登记，否则假成功只能给出一句生硬报错')
  const hint = explainVrpError('UNSETTLED', 'reset saved-configuration')
  assert.ok(hint)
  assert.ok(hint.hint.includes('reset saved-configuration'), '提示里要能看到是哪条命令')
  assert.ok(hint.hint.includes('提示符'), '提示要点出「没有回到提示符」这一根因')
})

test('preflight：干净的命令集与空输入都不产生噪声', () => {
  assert.deepEqual(
    rulesOf([
      'sysname Core-SW1',
      'vlan batch 10 20',
      'interface GigabitEthernet0/0/1',
      'port link-type trunk',
      'port trunk allow-pass vlan 10 20',
      'quit',
      'ospf 1 router-id 1.1.1.1',
      'area 0.0.0.0',
      'network 10.0.0.0 0.0.0.255'
    ]),
    [],
    '一套规范配置不该被预检打扰'
  )
  assert.deepEqual(preflightCommands([]), [])
  assert.deepEqual(preflightCommands(['   ']), [])
})
