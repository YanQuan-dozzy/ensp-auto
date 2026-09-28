/**
 * F7（2026-09-26）：实验验收检查 —— 纯函数（命令选择 / 判定 / 描述）+ 工具汇总口径。
 *
 * 重点锁两条不变量：
 * 1. 判定三态不能混 —— 「没达成(fail)」与「根本没测出来(error)」必须区分，
 *    否则未连接的设备会被谎报成实验失败；
 * 2. 结果**不打分** —— 只给逐项 ✔/✘ 与计数，不产出 score/grade 之类字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TOOLS,
  parseOspfPeers,
  commandsForCheck,
  checkInputError,
  isTolerablePingFailure,
  evaluateCheck,
  describeCheck,
  checkExperiment
} from '../.build/harness.mjs'

// ———————————————————————— parseOspfPeers ————————————————————————

test('parseOspfPeers：解析 brief 邻居表，跳过表头/分隔线，规范化状态', () => {
  const text = [
    'OSPF Process 1 with Router ID 1.1.1.1',
    '                  Peer Statistic Information',
    '---------------------------------------------------------------------------',
    ' Area Id          Interface                        Neighbor id      State',
    ' 0.0.0.0          GigabitEthernet0/0/0             2.2.2.2          Full',
    ' 0.0.0.0          GigabitEthernet0/0/1             3.3.3.3          2Way',
    ' 0.0.0.0          GigabitEthernet0/0/2             4.4.4.4          Down',
    '---------------------------------------------------------------------------'
  ].join('\n')
  const peers = parseOspfPeers(text)
  assert.equal(peers.length, 3)
  assert.deepEqual(peers[0], {
    areaId: '0.0.0.0',
    interface: 'GigabitEthernet0/0/0',
    neighborId: '2.2.2.2',
    state: 'Full'
  })
  assert.equal(peers[1].state, '2-Way', '2Way 应规范化成 2-Way')
  assert.equal(peers[2].state, 'Down')
})

test('parseOspfPeers：空回显 / 无关文本返回空数组', () => {
  assert.deepEqual(parseOspfPeers(''), [])
  assert.deepEqual(parseOspfPeers('Error: Unrecognized command'), [])
})

// ———————————————————————— commandsForCheck ————————————————————————

test('commandsForCheck：必填参数缺失时返回空数组（拒绝无法判定的项）', () => {
  assert.deepEqual(commandsForCheck({ kind: 'ping', deviceId: 'd' }), [])
  assert.deepEqual(commandsForCheck({ kind: 'route', deviceId: 'd' }), [])
  assert.deepEqual(commandsForCheck({ kind: 'arp', deviceId: 'd' }), [])
  assert.deepEqual(commandsForCheck({ kind: 'config', deviceId: 'd' }), [])
})

test('commandsForCheck：各类型的只读命令映射', () => {
  assert.deepEqual(commandsForCheck({ kind: 'ping', deviceId: 'd', target: '10.0.0.2' }), [
    'ping -c 3 10.0.0.2'
  ])
  assert.deepEqual(commandsForCheck({ kind: 'interface', deviceId: 'd', iface: 'GE0/0/1' }), [
    'display interface brief'
  ])
  assert.deepEqual(commandsForCheck({ kind: 'nat', deviceId: 'd' }), [
    'display nat outbound',
    'display nat server'
  ])
  assert.deepEqual(commandsForCheck({ kind: 'eth_trunk', deviceId: 'd', trunkId: 1 }), [
    'display eth-trunk 1'
  ])
  assert.deepEqual(commandsForCheck({ kind: 'eth_trunk', deviceId: 'd' }), ['display eth-trunk'])
  assert.deepEqual(commandsForCheck({ kind: 'config', deviceId: 'd', contains: 'ospf 1' }), [
    'display current-configuration | include ospf 1'
  ])
})

// ———————————————————————— evaluateCheck · ping ————————————————————————

test('evaluateCheck · ping：可达 pass / 全丢包 fail / 无法解析 error', () => {
  const reachable = [
    '--- 10.0.0.2 ping statistics ---',
    '3 packet(s) transmitted, 3 packet(s) received, 0.0% packet loss',
    'round-trip min/avg/max = 1/2/5 ms'
  ].join('\n')
  const pass = evaluateCheck({ kind: 'ping', deviceId: 'd', target: '10.0.0.2' }, [reachable])
  assert.equal(pass.status, 'pass')
  assert.equal(pass.ok, true)
  assert.match(pass.evidence, /3 收包/)
  assert.equal(pass.reason, undefined)

  const lossy = ['3 packet(s) transmitted, 0 packet(s) received, 100.0% packet loss'].join('\n')
  const fail = evaluateCheck({ kind: 'ping', deviceId: 'd', target: '10.0.0.9' }, [lossy])
  assert.equal(fail.status, 'fail')
  assert.ok(fail.reason)

  const err = evaluateCheck({ kind: 'ping', deviceId: 'd', target: '10.0.0.9' }, [
    'Error: Unrecognized command'
  ])
  assert.equal(err.status, 'error', '解析不出来是 error，不是 fail')
})

// ———————————————————————— evaluateCheck · interface ————————————————————————

test('evaluateCheck · interface：up/up pass、down fail、缺 iface error', () => {
  const brief = [
    'Interface                         PHY   Protocol InUti OutUti',
    'GE0/0/1                           up    up      0%    0%',
    'GE0/0/2                           down  down    0%    0%'
  ].join('\n')
  assert.equal(evaluateCheck({ kind: 'interface', deviceId: 'd', iface: 'GE0/0/1' }, [brief]).status, 'pass')
  const fail = evaluateCheck({ kind: 'interface', deviceId: 'd', iface: 'GE0/0/2' }, [brief])
  assert.equal(fail.status, 'fail')
  assert.match(fail.evidence, /GE0\/0\/2/)
  assert.equal(evaluateCheck({ kind: 'interface', deviceId: 'd' }, [brief]).status, 'error')
})

// ———————————————————————— evaluateCheck · ospf ————————————————————————

test('evaluateCheck · ospf：任一 Full → pass；指定邻居未 Full → fail；无邻居 → fail', () => {
  const brief = [
    ' 0.0.0.0  GE0/0/0  2.2.2.2  Full',
    ' 0.0.0.0  GE0/0/1  3.3.3.3  2-Way'
  ].join('\n')
  assert.equal(evaluateCheck({ kind: 'ospf', deviceId: 'd' }, [brief]).status, 'pass')

  const fail = evaluateCheck({ kind: 'ospf', deviceId: 'd', target: '3.3.3.3' }, [brief])
  assert.equal(fail.status, 'fail')
  assert.match(fail.reason, /Full/)

  const missing = evaluateCheck({ kind: 'ospf', deviceId: 'd', target: '9.9.9.9' }, [brief])
  assert.equal(missing.status, 'fail')
  assert.equal(evaluateCheck({ kind: 'ospf', deviceId: 'd' }, ['']).status, 'fail')
})

// ———————————————————————— evaluateCheck · dhcp ————————————————————————

test('evaluateCheck · dhcp：池有已用地址 → pass；无分配 → fail；池名不匹配 → fail', () => {
  const text = [
    '  Pool name: pool1',
    '   Network section      : 192.168.1.0      netmask : 255.255.255.0',
    '    Total addresses     : 253',
    '    Used addresses      : 2'
  ].join('\n')
  assert.equal(evaluateCheck({ kind: 'dhcp', deviceId: 'd' }, [text]).status, 'pass')

  const zero = text.replace('Used addresses      : 2', 'Used addresses      : 0')
  const fail = evaluateCheck({ kind: 'dhcp', deviceId: 'd' }, [zero])
  assert.equal(fail.status, 'fail')
  assert.match(fail.reason, /未成功获取/)

  assert.equal(evaluateCheck({ kind: 'dhcp', deviceId: 'd', pool: 'nope' }, [text]).status, 'fail')
  assert.equal(evaluateCheck({ kind: 'dhcp', deviceId: 'd' }, ['']).status, 'fail')
})

// ———————————————————————— evaluateCheck · route ————————————————————————

test('evaluateCheck · route：命中非 UNR → pass；仅 UNR → fail；缺 target error', () => {
  const table = [
    'Destination/Mask    Proto   Pre  Cost   Flags  NextHop      Interface',
    '    10.0.12.0/24    OSPF    10   2      D      10.0.0.2     GigabitEthernet0/0/0'
  ].join('\n')
  const pass = evaluateCheck({ kind: 'route', deviceId: 'd', target: '10.0.12.0/24' }, [table])
  assert.equal(pass.status, 'pass')
  assert.match(pass.evidence, /10\.0\.0\.2/)

  const unrRow = '    10.0.99.0/24    UNR     60   0      D      0.0.0.0      NULL0'
  const unr = evaluateCheck({ kind: 'route', deviceId: 'd', target: '10.0.99.0/24' }, [unrRow])
  assert.equal(unr.status, 'fail')

  assert.equal(evaluateCheck({ kind: 'route', deviceId: 'd' }, [table]).status, 'error')
})

// ———————————————————————— evaluateCheck · arp / nat / eth_trunk / config ————————————————————————

test('evaluateCheck · arp：学到 MAC → pass；未学到 → fail', () => {
  const arp = ['IP Address   MAC Address     Type  Interface', '10.0.0.2     0011-2233-4455  D     GE0/0/0'].join('\n')
  assert.equal(evaluateCheck({ kind: 'arp', deviceId: 'd', ip: '10.0.0.2' }, [arp]).status, 'pass')
  assert.equal(evaluateCheck({ kind: 'arp', deviceId: 'd', ip: '10.0.0.9' }, [arp]).status, 'fail')
})

test('evaluateCheck · nat：任一 NAT 条目 → pass；空 → fail', () => {
  const ob = ['Interface  ACL    Address            Type', 'GE0/0/0    2000   current-interface  easyip'].join('\n')
  assert.equal(evaluateCheck({ kind: 'nat', deviceId: 'd' }, [ob, '']).status, 'pass')
  assert.equal(evaluateCheck({ kind: 'nat', deviceId: 'd' }, ['', '']).status, 'fail')
})

test('evaluateCheck · eth_trunk：up → pass；无聚合 → fail', () => {
  const trunk = [
    "Eth-Trunk1's state information is:",
    'WorkingMode: NORMAL',
    'Operate status: up',
    'Number Of Up Port In Trunk: 2',
    'GigabitEthernet0/0/1  up    1'
  ].join('\n')
  assert.equal(evaluateCheck({ kind: 'eth_trunk', deviceId: 'd' }, [trunk]).status, 'pass')
  assert.equal(evaluateCheck({ kind: 'eth_trunk', deviceId: 'd' }, ['']).status, 'fail')
})

test('evaluateCheck · config：命中子串 → pass；空 → fail；缺 contains error', () => {
  assert.equal(evaluateCheck({ kind: 'config', deviceId: 'd', contains: 'ospf 1' }, ['ospf 1\n area 0.0.0.0']).status, 'pass')
  assert.equal(evaluateCheck({ kind: 'config', deviceId: 'd', contains: 'ospf 1' }, ['']).status, 'fail')
  assert.equal(evaluateCheck({ kind: 'config', deviceId: 'd' }, ['x']).status, 'error')
})

// ———————————————————————— describeCheck ————————————————————————

test('describeCheck：为每类生成可读目标描述', () => {
  assert.equal(describeCheck({ kind: 'ping', deviceId: 'd', target: '10.0.0.2' }), 'd ping 10.0.0.2 可达')
  assert.match(describeCheck({ kind: 'ospf', deviceId: 'd' }), /Full/)
  assert.match(describeCheck({ kind: 'config', deviceId: 'd', contains: 'vlan 10' }), /vlan 10/)
})

// ———————————————————————— 工具出口：注册 / 汇总口径 / 三态计数 ————————————————————————

test('check_experiment 已注册进内置工具表，risk=read', () => {
  const spec = TOOLS.find((t) => t.name === 'check_experiment')
  assert.ok(spec, 'check_experiment 应当在 TOOLS 里')
  assert.equal(spec.risk, 'read')
  assert.equal(spec.scope, 'device')
})

function fakeCtx(table) {
  const session = {
    exec: async (cmd) => ({ ok: true, clean: table[cmd] ?? '', raw: '', settled: 'prompt' })
  }
  return { sessions: { get: () => session }, settings: {}, signal: undefined }
}

test('check_experiment：逐项汇总计数，结果不含任何「分数」字段', async () => {
  const ctx = fakeCtx({
    'ping -c 3 10.0.0.2': '3 packet(s) transmitted, 3 packet(s) received, 0.0% packet loss',
    'display interface brief': 'GE0/0/1  up  up'
  })
  const res = await checkExperiment.handler(
    {
      checks: [
        { kind: 'ping', deviceId: 'd', target: '10.0.0.2' },
        { kind: 'interface', deviceId: 'd', iface: 'GE0/0/1' },
        { kind: 'ospf', deviceId: 'd' }
      ]
    },
    ctx
  )
  assert.equal(res.ok, true)
  const d = res.data
  assert.equal(d.total, 3)
  assert.equal(d.passed, 2)
  assert.equal(d.failed, 1, 'ospf 无邻居应记 fail')
  assert.equal(d.errors, 0)
  assert.equal(d.allPassed, false)
  assert.equal(d.items.length, 3)
  assert.equal('score' in d, false)
  assert.equal('grade' in d, false)
  assert.match(d.summary, /2 项达成/)
})

test('check_experiment：设备未连接记为 error（不谎报 fail）；空清单直接拒绝', async () => {
  const ctx = { sessions: { get: () => undefined }, settings: {}, signal: undefined }
  const res = await checkExperiment.handler(
    { checks: [{ kind: 'ping', deviceId: 'd', target: '10.0.0.2' }] },
    ctx
  )
  assert.equal(res.data.errors, 1)
  assert.equal(res.data.failed, 0)
  assert.equal(res.data.allPassed, false)

  const bad = await checkExperiment.handler({ checks: [] }, ctx)
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'BAD_PARAM')
})

// ———————————————————————— N12：命令由参数拼成，必须先校验 ————————————————————————

test('N12 checkInputError：ping 的 target 必须是严格 IPv4（换行 / 非法地址一律拒绝）', () => {
  assert.equal(checkInputError({ kind: 'ping', deviceId: 'd', target: '10.0.0.2' }), null)
  assert.ok(checkInputError({ kind: 'ping', deviceId: 'd', target: '8.8.8.8\nreset saved-configuration' }))
  assert.ok(checkInputError({ kind: 'ping', deviceId: 'd', target: '999.1.1.1' }), '越界段也应拒绝')
  assert.ok(checkInputError({ kind: 'ping', deviceId: 'd', target: 'example.com' }))
  // 缺参数不算「非法」：交给 commandsForCheck 走「参数不完整」那条
  assert.equal(checkInputError({ kind: 'ping', deviceId: 'd' }), null)
})

test('N12 checkInputError：config 的 contains 不得含换行或命令分隔符', () => {
  assert.equal(checkInputError({ kind: 'config', deviceId: 'd', contains: 'ospf 1' }), null)
  assert.ok(checkInputError({ kind: 'config', deviceId: 'd', contains: 'ospf | include x' }))
  assert.ok(checkInputError({ kind: 'config', deviceId: 'd', contains: 'a;reset' }))
  assert.ok(checkInputError({ kind: 'config', deviceId: 'd', contains: 'a\r\nb' }))
})

test('N12 commandsForCheck：非法 ping target / contains 不生成任何命令', () => {
  assert.deepEqual(commandsForCheck({ kind: 'ping', deviceId: 'd', target: '8.8.8.8\nreset' }), [])
  assert.deepEqual(commandsForCheck({ kind: 'config', deviceId: 'd', contains: 'x|y' }), [])
})

test('N12 check_experiment：注入型 target 整体 BAD_PARAM，且设备未收到任何命令', async () => {
  const seen = []
  const session = {
    exec: async (cmd) => {
      seen.push(cmd)
      return { ok: true, clean: '', raw: '', settled: 'prompt' }
    }
  }
  const ctx = { sessions: { get: () => session }, settings: {}, signal: undefined }
  const res = await checkExperiment.handler(
    { checks: [{ kind: 'ping', deviceId: 'd', target: '8.8.8.8\nreset saved-configuration' }] },
    ctx
  )
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'BAD_PARAM')
  assert.deepEqual(seen, [], '非法参数拼出的命令绝不能下发到设备')
})

test('N12 check_experiment：checks 里的非对象条目也按 BAD_PARAM 拒绝（外部 MCP 可传任意 JSON）', async () => {
  const ctx = { sessions: { get: () => undefined }, settings: {}, signal: undefined }
  const res = await checkExperiment.handler({ checks: [null] }, ctx)
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'BAD_PARAM')
})

// ———————————————————————— N26：ping 容忍规则单一事实源 ————————————————————————

test('N26 isTolerablePingFailure：失败但回显含统计行 → 可用；否则不可用', () => {
  assert.equal(isTolerablePingFailure({ clean: '3 packet(s) transmitted, 0 packet(s) received' }), true)
  assert.equal(isTolerablePingFailure({ clean: 'Error: Unrecognized command' }), false)
})

test('N26 check_experiment：ping 命令 ok=false 但有统计行 → 仍按回显判定（不再记 error）', async () => {
  const session = {
    exec: async () => ({
      ok: false,
      clean: '3 packet(s) transmitted, 3 packet(s) received, 0.0% packet loss',
      raw: '',
      settled: 'prompt',
      error: 'busy'
    })
  }
  const ctx = { sessions: { get: () => session }, settings: {}, signal: undefined }
  const res = await checkExperiment.handler(
    { checks: [{ kind: 'ping', deviceId: 'd', target: '10.0.0.2' }] },
    ctx
  )
  assert.equal(res.data.errors, 0, '有统计行就不该记「无法判定」')
  assert.equal(res.data.passed, 1)
})