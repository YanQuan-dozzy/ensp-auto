import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  genRollbackCommands,
  parseConfigStanzas,
  invertCommand,
  UNDOABLE_HEADER_RE,
  checkExpectation,
  ChangeStore
} from '../.build/harness.mjs'

// ———————————————————— 配置分段解析 ————————————————————

test('分段解析：视图头 + 缩进子行成段，# 与 return 分隔', () => {
  const p = parseConfigStanzas([
    'sysname AR1',
    '#',
    'interface GigabitEthernet0/0/0',
    ' ip address 10.0.0.1 255.255.255.0',
    ' undo shutdown',
    '#',
    'ospf 1',
    ' area 0.0.0.0',
    '  network 10.0.0.0 0.0.0.255',
    'return'
  ].join('\n'))
  assert.deepEqual(p.top, ['sysname AR1'])
  assert.equal(p.stanzas.length, 2)
  assert.equal(p.stanzas[0].header, 'interface GigabitEthernet0/0/0')
  assert.deepEqual(p.stanzas[0].lines, ['ip address 10.0.0.1 255.255.255.0', 'undo shutdown'])
  assert.equal(p.stanzas[1].header, 'ospf 1')
  assert.deepEqual(p.stanzas[1].lines, ['area 0.0.0.0', 'network 10.0.0.0 0.0.0.255'])
})

test('分段解析：acl 的三种写法都能识别为段头（具体写法优先）', () => {
  for (const header of ['acl number 2000', 'acl 2001', 'acl name deny-web']) {
    const p = parseConfigStanzas(`${header}\n rule deny`)
    assert.equal(p.stanzas.length, 1, `${header} 应为段头`)
    assert.equal(p.stanzas[0].header, header)
    assert.deepEqual(p.stanzas[0].lines, ['rule deny'])
  }
})

test('分段解析：vlan batch 是顶层命令而非视图段', () => {
  const p = parseConfigStanzas('vlan batch 2 to 10\n')
  assert.deepEqual(p.top, ['vlan batch 2 to 10'])
  assert.equal(p.stanzas.length, 0)
})

// ———————————————————— 命令反转 ————————————————————

test('反转：普通行加 undo 前缀；undo 行剥前缀', () => {
  assert.equal(invertCommand('ip address 10.0.0.1 255.255.255.0'), 'undo ip address 10.0.0.1 255.255.255.0')
  assert.equal(invertCommand('undo shutdown'), 'shutdown')
  assert.equal(invertCommand('  shutdown  '), 'undo shutdown')
})

// ———————————————————— 回滚命令生成 ————————————————————

const IFACE = 'interface GigabitEthernet0/0/0'

test('回滚：配置一致 → 不生成任何命令', () => {
  const cfg = `sysname AR1\n#\n${IFACE}\n ip address 10.0.0.1 255.255.255.0\n#\nreturn`
  const plan = genRollbackCommands(cfg, cfg)
  assert.deepEqual(plan.commands, [])
  assert.deepEqual(plan.added, [])
  assert.deepEqual(plan.removed, [])
})

test('回滚：接口段内新增行 → 进该视图并逐个 undo', () => {
  const oldCfg = `sysname AR1\n#\n${IFACE}\n ip address 10.0.0.1 255.255.255.0\n#\nreturn`
  const newCfg = `sysname AR1\n#\n${IFACE}\n ip address 10.0.0.1 255.255.255.0\n ip address 10.0.0.2 255.255.255.0 sub\n undo shutdown\n#\nreturn`
  const plan = genRollbackCommands(oldCfg, newCfg)
  assert.deepEqual(plan.commands, [
    IFACE,
    'undo ip address 10.0.0.2 255.255.255.0 sub',
    'shutdown'
  ])
  assert.deepEqual(plan.added, ['ip address 10.0.0.2 255.255.255.0 sub', 'undo shutdown'])
  assert.deepEqual(plan.removed, [])
})

test('回滚：接口段内被删行 → 撤销段内新增后补回', () => {
  const oldCfg = `sysname AR1\n#\n${IFACE}\n ip address 10.0.0.1 255.255.255.0\n description Link-A\n#\nreturn`
  const newCfg = `sysname AR1\n#\n${IFACE}\n undo shutdown\n#\nreturn`
  const plan = genRollbackCommands(oldCfg, newCfg)
  assert.deepEqual(plan.commands, [
    IFACE,
    'shutdown',
    IFACE,
    'ip address 10.0.0.1 255.255.255.0',
    'description Link-A'
  ])
  assert.deepEqual(plan.added, ['undo shutdown'])
  assert.deepEqual(plan.removed, ['ip address 10.0.0.1 255.255.255.0', 'description Link-A'])
})

test('回滚：先撤销段内新增、再补回段内被删（同参覆盖场景顺序正确）', () => {
  const oldCfg = `sysname AR1\n#\n${IFACE}\n ip address 10.0.0.1 255.255.255.0\n#\nreturn`
  const newCfg = `sysname AR1\n#\n${IFACE}\n ip address 10.0.0.2 255.255.255.0\n undo shutdown\n#\nreturn`
  const plan = genRollbackCommands(oldCfg, newCfg)
  assert.deepEqual(plan.commands, [
    IFACE,
    'undo ip address 10.0.0.2 255.255.255.0',
    'shutdown',
    IFACE,
    'ip address 10.0.0.1 255.255.255.0'
  ])
})

test('回滚：整段新增 → 只发 undo 段头（子行随段消失）', () => {
  const oldCfg = `sysname AR1\n#\n${IFACE}\n ip address 10.0.0.1 255.255.255.0\n#\nreturn`
  const newCfg = `${oldCfg}\nospf 2\n area 0.0.0.0\n  network 10.0.0.0 0.0.0.255\n#\nreturn`
  const plan = genRollbackCommands(oldCfg, newCfg)
  assert.deepEqual(plan.commands, ['undo ospf 2'])
  assert.deepEqual(plan.added, ['ospf 2', 'area 0.0.0.0', 'network 10.0.0.0 0.0.0.255'])
})

// —— D1（2026-09-23）：段头可 undo 与否必须分叉 ——
//
// 反例来源：`undo interface GigabitEthernet0/0/0` 在 VRP 里不存在，
// 下发即 `Error: Unrecognized command`；而 executeCommands 遇错即停，
// 于是回滚在第一条就中断、设备停在半回滚状态。

test('D1：新增的 interface 段 → 进段 + 逐行 undo，绝不含 undo interface', () => {
  const plan = genRollbackCommands(
    '',
    'interface GigabitEthernet0/0/0\n ip address 10.0.1.1 255.255.255.0\n'
  )
  assert.deepEqual(plan.commands, [
    'interface GigabitEthernet0/0/0',
    'undo ip address 10.0.1.1 255.255.255.0'
  ])
  assert.ok(
    !plan.commands.some((c) => /^undo\s+interface\b/i.test(c)),
    '不得生成设备不存在的 undo interface'
  )
})

test('D1：新增的 vlan 段仍走整体 undo（不回归简化路径）', () => {
  const plan = genRollbackCommands('', 'vlan 10\n')
  assert.deepEqual(plan.commands, ['undo vlan 10'])
})

test('D1：可 undo 段头白名单覆盖视图入口，且排除 interface/aaa/keychain 一类', () => {
  for (const h of ['vlan 10', 'ospf 1', 'acl number 3000', 'acl name deny-web', 'bgp 100']) {
    assert.ok(UNDOABLE_HEADER_RE.test(h), `${h} 应可整体 undo`)
  }
  for (const h of [
    `${IFACE}`,
    'firewall zone name trust',
    'nat address-group 1',
    'dhcp server ip-pool vlan10',
    'keychain kc',
    'user-interface vty 0 4',
    'aaa',
    'mpls'
  ]) {
    assert.ok(!UNDOABLE_HEADER_RE.test(h), `${h} 不可整体 undo，必须走逐行路径`)
  }
})

test('D1：新增段的子行撤销尊重 invertCommand（undo shutdown → shutdown）', () => {
  const plan = genRollbackCommands('', 'interface GigabitEthernet0/0/1\n undo shutdown\n')
  assert.deepEqual(plan.commands, ['interface GigabitEthernet0/0/1', 'shutdown'])
})

test('回滚：整段被删 → 按快照原样补回（header + 全部子行）', () => {
  const oldCfg = `sysname AR1\n#\n${IFACE}\n shutdown\n#\nospf 1\n area 0.0.0.0\n  network 10.0.0.0 0.0.0.255\n#\nreturn`
  const newCfg = `sysname AR1\n#\n${IFACE}\n shutdown\n#\nreturn`
  const plan = genRollbackCommands(oldCfg, newCfg)
  assert.deepEqual(plan.commands, ['ospf 1', 'area 0.0.0.0', 'network 10.0.0.0 0.0.0.255'])
})

test('回滚：顶层散命令变更 → 先 undo 新增、再补回被删（尽力而为）', () => {
  const oldCfg = 'sysname AR1\n'
  const newCfg = 'sysname AR2\n'
  const plan = genRollbackCommands(oldCfg, newCfg)
  assert.deepEqual(plan.commands, ['undo sysname AR2', 'sysname AR1'])
})

// ———————————————————— 期望校验 ————————————————————

const CLEAN = 'OSPF Process 1 with Router ID 1.1.1.1\n State: Full  Mode: Nbr is Master'

test('期望校验：contains / notContains / regex 三模式', () => {
  assert.equal(checkExpectation(CLEAN, { expect: 'State: Full', mode: 'contains' }), true)
  assert.equal(checkExpectation(CLEAN, { expect: 'Down', mode: 'contains' }), false)
  assert.equal(checkExpectation(CLEAN, { expect: 'Down', mode: 'notContains' }), true)
  assert.equal(checkExpectation(CLEAN, { expect: 'State: F\\w+', mode: 'regex' }), true)
  assert.equal(checkExpectation(CLEAN, { expect: 'State: D\\w+', mode: 'regex' }), false)
})

test('期望校验：非法正则抛出 SyntaxError', () => {
  assert.throws(() => checkExpectation(CLEAN, { expect: 'State: [', mode: 'regex' }), SyntaxError)
})

// ———————————————————— 变更记录 ————————————————————

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-changes-'))
}

test('变更记录：追加 + 按设备列表 + 跨实例持久化', () => {
  const dir = tmpDir()
  try {
    const store = new ChangeStore(dir)
    const r1 = store.add({
      deviceId: '127.0.0.1:2008',
      kind: 'apply',
      actor: 'agent',
      snapshotId: 'snap-a',
      description: '跑通 OSPF',
      commands: ['ospf 1'],
      result: 'ok',
      verified: true
    })
    store.add({
      deviceId: '127.0.0.1:2009',
      kind: 'restore',
      actor: 'agent',
      description: '回滚',
      result: 'rejected'
    })
    const r3 = store.add({
      deviceId: '127.0.0.1:2008',
      kind: 'apply',
      actor: 'agent',
      description: '改接口',
      result: 'failed',
      error: { code: 'UNRECOGNIZED', message: '命令不存在' }
    })

    assert.ok(r1.id && r1.at > 0 && r3.at >= r1.at)
    assert.equal(store.list('127.0.0.1:2008').length, 2)
    assert.equal(store.list('127.0.0.1:2008')[0].result, 'failed')
    assert.equal(store.list('127.0.0.1:2009').length, 1)
    assert.equal(store.latest('127.0.0.1:2008').result, 'failed')

    // 重建实例，验证已落盘
    const reloaded = new ChangeStore(dir)
    assert.equal(reloaded.list('127.0.0.1:2008').length, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})