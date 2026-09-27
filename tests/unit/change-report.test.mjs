import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildChangeReport,
  collectChangeReport,
  deviceLabelsOf,
  parseAddressPools,
  parseInterfaceIps,
  prefixOfMask
} from '../.build/harness.mjs'

/**
 * v2.20：设备配置命令报告（`core/store/change-report.ts` 纯函数 + 写盘 helper）。
 *
 * 这里守的是三条容易静默出错的线：
 *   1. 地址池/接口 IP 的**上下文状态机** —— `ip address` 只在其接口块内有效，
 *      不跟踪 `interface`/`quit` 会把地址挂到上一个接口上，报告看起来很正常但是错的；
 *   2. **口径**：只扫「成功的 apply」，失败/回滚/保存都不能混进 IP 表；
 *   3. **Markdown 结构**：`|` 未转义会截断表格、命令含 ``` 会提前闭合代码块。
 */

const T0 = Date.parse('2026-09-27T10:02:11+08:00')

function rec(over = {}) {
  return {
    id: `r${Math.random().toString(36).slice(2, 8)}`,
    deviceId: '127.0.0.1:2004',
    at: T0,
    kind: 'apply',
    actor: 'agent',
    description: '配置',
    result: 'ok',
    ...over
  }
}

const noLabel = (id) => id

// ———————————————————————— prefixOfMask ————————————————————————

test('prefixOfMask：点分掩码 / 前缀长 / 非法值', () => {
  assert.equal(prefixOfMask('255.255.255.0'), 24)
  assert.equal(prefixOfMask('255.255.255.255'), 32)
  assert.equal(prefixOfMask('0.0.0.0'), 0)
  assert.equal(prefixOfMask('24'), 24)
  // 非连续掩码（255.0.255.0）不是合法掩码 → 宁可不写，也不写错
  assert.equal(prefixOfMask('255.0.255.0'), null)
  assert.equal(prefixOfMask('33'), null)
  assert.equal(prefixOfMask('255.255.255'), null)
  assert.equal(prefixOfMask('abc'), null)
})

// ———————————————————————— 地址池 ————————————————————————

test('parseAddressPools：解析标准 VRP 地址池块', () => {
  const r = rec({
    commands: [
      'dhcp enable',
      'ip pool pool10',
      'network 192.168.10.0 mask 255.255.255.0',
      'gateway-list 192.168.10.1',
      'range 192.168.10.10 192.168.10.200',
      'dns-list 8.8.8.8',
      'quit'
    ]
  })
  const rows = parseAddressPools([r], noLabel)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    device: '127.0.0.1:2004',
    name: 'pool10',
    network: '192.168.10.0/24',
    gateway: '192.168.10.1',
    range: '192.168.10.10 ~ 192.168.10.200',
    dns: '8.8.8.8'
  })
})

test('parseAddressPools：认 dhcp server ip-pool 旧语法，且 quit 后不再收属性', () => {
  const r = rec({
    commands: [
      'dhcp server ip-pool vlan20',
      'network 10.20.0.0 mask 255.255.0.0',
      'quit',
      // 池外的 gateway-list 不属于任何池，不能被算进去
      'gateway-list 9.9.9.9'
    ]
  })
  const rows = parseAddressPools([r], noLabel)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'vlan20')
  assert.equal(rows[0].network, '10.20.0.0/16')
  assert.equal(rows[0].gateway, '', 'quit 之后的行不能挂到已结束的池上')
})

test('parseAddressPools：同名池重复下发取最后一次（反映最终状态）', () => {
  const old = rec({ at: T0, commands: ['ip pool p1', 'network 10.1.0.0 mask 255.255.255.0', 'quit'] })
  const newer = rec({ at: T0 + 60_000, commands: ['ip pool p1', 'network 10.2.0.0 mask 255.255.255.0', 'quit'] })
  // 传入顺序刻意倒序，验证内部按时间正序处理
  const rows = parseAddressPools([newer, old], noLabel)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].network, '10.2.0.0/24')
})

test('parseAddressPools：只认「成功的 apply」—— 失败 / 回滚 / 保存都不进表', () => {
  const cmds = ['ip pool p1', 'network 10.1.0.0 mask 255.255.255.0', 'quit']
  const rows = parseAddressPools(
    [
      rec({ result: 'failed', commands: cmds }),
      rec({ kind: 'restore', commands: cmds }),
      rec({ kind: 'save', commands: ['save'] }),
      rec({ result: 'blocked', commands: cmds })
    ],
    noLabel
  )
  assert.deepEqual(rows, [], '未生效的变更不能出现在「已生效的地址规划」里')
})

test('parseAddressPools：无 commands / 非数组不炸', () => {
  assert.deepEqual(parseAddressPools([rec(), rec({ commands: [] })], noLabel), [])
})

// ———————————————————————— 接口 IP ————————————————————————

test('parseInterfaceIps：接口块内取地址、quit 后断开上下文', () => {
  const r = rec({
    commands: [
      'interface GigabitEthernet0/0/0',
      'ip address 10.0.12.1 255.255.255.0',
      'quit',
      'interface LoopBack0',
      'ip address 1.1.1.1 255.255.255.255',
      'quit',
      // 接口块外的 ip address 无归属，必须丢弃
      'ip address 8.8.8.8 255.255.255.255'
    ]
  })
  const rows = parseInterfaceIps([r], noLabel)
  assert.deepEqual(
    rows.map((x) => `${x.iface} ${x.ip}`),
    ['GigabitEthernet0/0/0 10.0.12.1/24', 'LoopBack0 1.1.1.1/32']
  )
})

test('parseInterfaceIps：掩码不可解析时保留原文（不猜前缀）', () => {
  const r = rec({ commands: ['interface Vlanif 10', 'ip address 172.16.10.1 weird-mask', 'quit'] })
  assert.equal(parseInterfaceIps([r], noLabel)[0].ip, '172.16.10.1 weird-mask')
})

test('parseInterfaceIps：同接口二次下发覆盖，不同设备同名接口不互相覆盖', () => {
  const a = rec({ deviceId: 'A', at: T0, commands: ['interface GE0/0/0', 'ip address 1.1.1.1 255.255.255.0', 'quit'] })
  const b = rec({ deviceId: 'B', at: T0, commands: ['interface GE0/0/0', 'ip address 2.2.2.2 255.255.255.0', 'quit'] })
  const a2 = rec({ deviceId: 'A', at: T0 + 1000, commands: ['interface GE0/0/0', 'ip address 3.3.3.3 255.255.255.0', 'quit'] })
  const rows = parseInterfaceIps([a, b, a2], noLabel)
  assert.equal(rows.length, 2)
  assert.deepEqual(
    rows.map((x) => `${x.device} ${x.ip}`),
    ['A 3.3.3.3/24', 'B 2.2.2.2/24']
  )
})

// ———————————————————————— 正文 ————————————————————————

test('buildChangeReport：无记录时只出概览，不产出空章节', () => {
  const md = buildChangeReport({ records: [], now: T0 })
  assert.match(md, /^# 设备配置命令报告\n/)
  assert.match(md, /## 一、概览/)
  assert.match(md, /没有配置变更记录/)
  assert.doesNotMatch(md, /## 二、IP 地址规划/)
  assert.doesNotMatch(md, /## 三、配置实施过程/)
})

test('buildChangeReport：三章齐全、概览合计正确、IP 表按设备分组', () => {
  const md = buildChangeReport({
    records: [
      rec({
        deviceId: 'A',
        at: T0,
        description: 'VLAN 划分',
        snapshotId: 'snap-a',
        expectation: { command: 'display vlan', expect: '10', mode: 'contains' },
        verified: true,
        commands: ['interface GigabitEthernet0/0/1', 'ip address 10.0.1.1 255.255.255.0', 'quit']
      }),
      rec({ deviceId: 'A', at: T0 + 1000, kind: 'save', description: '保存配置到启动配置', commands: ['save'] }),
      rec({
        deviceId: 'B',
        at: T0 + 2000,
        description: 'DHCP 地址池',
        commands: ['ip pool p20', 'network 192.168.20.0 mask 255.255.255.0', 'gateway-list 192.168.20.1', 'quit']
      }),
      rec({ deviceId: 'B', at: T0 + 3000, result: 'failed', description: 'OSPF 配置', commands: ['ospf 1'] })
    ],
    options: { deviceLabels: { A: 'LSW1', B: 'AR1' } },
    now: T0
  })

  assert.match(md, /## 一、概览/)
  assert.match(md, /## 二、IP 地址规划/)
  assert.match(md, /### 2\.1 DHCP 地址池/)
  assert.match(md, /### 2\.2 接口 IP/)
  assert.match(md, /## 三、配置实施过程/)
  assert.match(md, /## 四、失败与拦截记录/)

  // 概览：4 条变更、2 台设备、合计行 3 成功 1 失败
  assert.match(md, /\| 变更总数 \| 4 \|/)
  assert.match(md, /\| 涉及设备 \| 2 \|/)
  assert.match(md, /\| \*\*合计\*\* \| 4 \| 3 \| 1 \| 0 \| 0 \|/)

  // 设备别名映射生效，且带 deviceId 便于回查
  assert.match(md, /### 3\.1 LSW1（A）/)
  assert.match(md, /### 3\.2 AR1（B）/)

  // 期望校验结论
  assert.match(md, /`display vlan` ✔ 通过/)

  // IP 表：地址池只出 B 的，接口只出 A 的；缺 range/DNS 的池用 — 占位而非留白
  assert.match(md, /\| AR1 \| p20 \| 192\.168\.20\.0\/24 \| 192\.168\.20\.1 \| — \| — \|/)
  assert.match(md, /\| LSW1 \| GigabitEthernet0\/0\/1 \| 10\.0\.1\.1\/24 \|/)
})

test('buildChangeReport：命令块只放成功项，失败项进第四章并在设备节被引用', () => {
  const md = buildChangeReport({
    records: [
      rec({ deviceId: 'A', at: T0, description: '好的', commands: ['sysname LSW1'] }),
      rec({ deviceId: 'A', at: T0 + 1000, result: 'failed', description: '坏的', commands: ['ospf 1'], error: { code: 'FAILED', message: '命令执行失败' } })
    ],
    now: T0
  })
  assert.match(md, /另有 1 条未生效的变更（明细中的第 2 条）/)
  // 可照抄的命令块里不能混入失败项
  const processPart = md.split('## 四、')[0]
  assert.match(processPart, /sysname LSW1/)
  assert.doesNotMatch(processPart, /ospf 1/)
  // 第四章补上原文与错误码
  assert.match(md, /`FAILED` 命令执行失败/)
  assert.match(md, /ospf 1/)
})

test('buildChangeReport：表格转义 —— 描述里的竖线不能截断列', () => {
  const md = buildChangeReport({
    records: [rec({ description: 'A | B 两种方案', commands: ['x'] })],
    now: T0
  })
  assert.match(md, /A \\\| B 两种方案/)
})

test('buildChangeReport：命令含 ``` 时围栏升级为 4 个反引号', () => {
  const md = buildChangeReport({
    records: [rec({ commands: ['remark ```\ndanger```'] })],
    now: T0
  })
  assert.match(md, /````/)
})

test('buildChangeReport：result 筛选体现在口径行与内容范围', () => {
  const md = buildChangeReport({
    records: [rec({ description: '成功项' }), rec({ result: 'blocked', description: '被拦项', commands: ['x'] })],
    options: { result: 'blocked' },
    now: T0
  })
  assert.match(md, /仅含「⊘ 被拦截」的记录/)
  assert.match(md, /被拦项/)
  assert.doesNotMatch(md, /成功项/)
})

test('buildChangeReport：deviceId 筛选只保留该设备', () => {
  const md = buildChangeReport({
    records: [rec({ deviceId: 'A', description: '甲' }), rec({ deviceId: 'B', description: '乙' })],
    options: { deviceId: 'B' },
    now: T0
  })
  assert.match(md, /乙/)
  assert.doesNotMatch(md, /甲/)
})

// ———————————————————————— 写盘 ————————————————————————

test('collectChangeReport：写盘到 exportsDir/<安全标题>/，count 为筛选后条数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-creport-'))
  try {
    const records = [rec({ deviceId: 'A' }), rec({ deviceId: 'B' }), rec({ deviceId: 'B', result: 'failed' })]
    const r = collectChangeReport(records, dir, { A: 'LSW1' }, { title: 'VLAN 实验/报告' })
    assert.ok(fs.existsSync(r.path), `报告应落盘：${r.path}`)
    assert.equal(r.count, 3)
    assert.ok(r.path.endsWith('.md'))

    const body = fs.readFileSync(r.path, 'utf8')
    assert.match(body, /# VLAN 实验\/报告/)
    // 目录名与文件名同源（`/` 已安全化），且带 -changes- 中缀便于与会话报告区分
    assert.ok(r.path.includes('changes-'), `文件名应含 -changes- 中缀：${r.path}`)
    assert.doesNotMatch(path.basename(path.dirname(r.path)), /\//)

    const onlyFailed = collectChangeReport(records, dir, {}, { result: 'failed' })
    assert.equal(onlyFailed.count, 1, 'count 必须是筛选后的条数，不是传入总数')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deviceLabelsOf：只收有名字的设备，缺名回退到 deviceId', () => {
  const labels = deviceLabelsOf([
    { id: '127.0.0.1:2004', name: 'LSW1' },
    { id: '127.0.0.1:2005', name: '' },
    { id: '127.0.0.1:2006' }
  ])
  assert.deepEqual(labels, { '127.0.0.1:2004': 'LSW1' })
  assert.equal(labels['127.0.0.1:2005'], undefined, '空名不入表，报告里回退成 deviceId')
})
