/**
 * 实验模板库测试（v2.0）。
 * 覆盖：模板结构完整性（角色/命令/校验）、角色映射缺失报告、findLabTemplate。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTemplateTaskSteps, findLabTemplate, LAB_TEMPLATES } from '../.build/harness.mjs'

test('LAB_TEMPLATES：内置 4 个模板且结构自洽（角色齐、命令块均有归属角色）', () => {
  assert.equal(LAB_TEMPLATES.length, 4)
  const ids = new Set(LAB_TEMPLATES.map((t) => t.id))
  assert.equal(ids.size, 4) // id 唯一
  for (const t of LAB_TEMPLATES) {
    const roleSet = new Set(t.roles.map((r) => r.role))
    for (const d of t.devices) {
      assert.ok(roleSet.has(d.role), `${t.id} 的 devices 引用了未声明的角色 ${d.role}`)
      assert.ok(d.commands.length > 0, `${t.id} 存在空命令块`)
    }
    for (const c of t.checks ?? []) {
      assert.ok(roleSet.has(c.from), `${t.id} 的 checks 引用了未声明的角色 ${c.from}`)
    }
  }
})

test('findLabTemplate：按 id 命中已知模板，未知返回 null', () => {
  assert.equal(findLabTemplate('static-route-basic')?.name, '静态路由互通')
  assert.equal(findLabTemplate('nope'), null)
})

test('buildTemplateTaskSteps：完整映射时展开 steps + checks，命令原样保留', () => {
  const t = findLabTemplate('static-route-basic')
  const { steps, checks, missingRoles } = buildTemplateTaskSteps(t, {
    r1: '127.0.0.1:2001',
    r2: '127.0.0.1:2002'
  })
  assert.deepEqual(missingRoles, [])
  assert.equal(steps.length, 2)
  assert.deepEqual(steps.map((s) => s.deviceId), ['127.0.0.1:2001', '127.0.0.1:2002'])
  assert.ok(steps[0].commands.includes('ip route-static 2.2.2.2 255.255.255.255 10.0.12.2'))
  assert.equal(steps[0].expectation.expect, '2.2.2.2/32')
  assert.equal(checks.length, 2)
  assert.deepEqual(checks[0], { from: '127.0.0.1:2001', target: '2.2.2.2' })
})

test('buildTemplateTaskSteps：缺失角色进入 missingRoles 且对应步骤被跳过', () => {
  const t = findLabTemplate('rip-three-routers')
  const { steps, checks, missingRoles } = buildTemplateTaskSteps(t, {
    r1: '127.0.0.1:2001',
    r3: '127.0.0.1:2003' // 缺 r2
  })
  assert.deepEqual(missingRoles, ['r2'])
  assert.equal(steps.length, 2)
  assert.ok(!steps.some((s) => s.deviceId === 'undefined'))
  // 两个 check 的源角色都有设备，故保留两条；r2 的缺失只影响其配置块
  assert.equal(checks.length, 2)
  assert.equal(checks[0].from, '127.0.0.1:2001')
  assert.equal(checks[1].from, '127.0.0.1:2003')
})

test('buildTemplateTaskSteps：无 checks 模板返回空 checks（eth-trunk-double-link）', () => {
  const t = findLabTemplate('eth-trunk-double-link')
  const { steps, checks, missingRoles } = buildTemplateTaskSteps(t, {
    sw1: '127.0.0.1:2010',
    sw2: '127.0.0.1:2011'
  })
  assert.deepEqual(missingRoles, [])
  assert.equal(steps.length, 2)
  assert.deepEqual(checks, [])
})