/**
 * 备课文档生成测试（v1.8）。
 * 覆盖：buildLabGuide 的骨架（目标/拓扑 mermaid/设备清单/IP 规划/步骤/验证清单）
 * 与空输入容错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLabGuide } from '../.build/harness.mjs'

const FULL = {
  title: 'VLAN 划分与 DHCP',
  objective: '在 SW1 上划分 VLAN 10/20，R1 提供 DHCP。',
  devices: [
    { deviceId: '127.0.0.1:2004', name: 'R1-AR2220', model: 'AR2220', role: 'router' },
    { deviceId: '127.0.0.1:2005', name: 'SW1-S5700', model: 'S5700', role: 'switch' }
  ],
  links: [
    { from: '127.0.0.1:2004', to: '127.0.0.1:2005' },
    { from: '不存在的节点', to: '127.0.0.1:2005' }
  ],
  ipPlan: [{ device: 'SW1', iface: 'Vlanif 10', ip: '192.168.10.1/24', purpose: 'PC 网关' }],
  steps: ['创建 VLAN', '划分接口'],
  checks: [{ from: '127.0.0.1:2004', target: '192.168.10.1' }]
}

test('buildLabGuide：完整输入生成全部章节', () => {
  const md = buildLabGuide(FULL)
  assert.ok(md.startsWith('# VLAN 划分与 DHCP'))
  assert.ok(md.includes('## 实验目标'))
  assert.ok(md.includes('在 SW1 上划分 VLAN 10/20，R1 提供 DHCP。'))
  assert.ok(md.includes('## 拓扑概览'))
  assert.ok(md.includes('```mermaid'))
  assert.ok(md.includes('## 设备清单'))
  assert.ok(md.includes('| 127.0.0.1:2004 | R1-AR2220 | AR2220 | router |'))
  assert.ok(md.includes('## IP 地址规划'))
  assert.ok(md.includes('| SW1 | Vlanif 10 | 192.168.10.1/24 | PC 网关 |'))
  assert.ok(md.includes('## 配置步骤'))
  assert.ok(md.includes('1. 创建 VLAN'))
  assert.ok(md.includes('## 验证清单'))
  assert.ok(md.includes('| 127.0.0.1:2004 | 192.168.10.1 | verify_ping 应 reachable |'))
})

test('buildLabGuide：mermaid 只画已知设备节点（未知链路被过滤）', () => {
  const md = buildLabGuide(FULL)
  const mermaid = md.split('```mermaid')[1].split('```')[0]
  assert.ok(mermaid.includes('R1-AR2220(AR2220)'))
  assert.ok(!mermaid.includes('不存在的节点'))
})

test('buildLabGuide：最小输入（只有标题）不抛错，章节按需省略', () => {
  const md = buildLabGuide({ title: '空实验' })
  assert.ok(md.startsWith('# 空实验'))
  assert.ok(!md.includes('## 设备清单'))
  assert.ok(!md.includes('```mermaid'))
  assert.ok(!md.includes('## 实验目标'))
})

test('buildLabGuide：表格内竖线被转义，避免破坏 markdown 表格', () => {
  const md = buildLabGuide({
    title: 't',
    devices: [{ deviceId: 'a|b', name: 'n' }],
    ipPlan: [{ device: 'd|1', iface: 'i', ip: 'x' }]
  })
  assert.ok(md.includes('a\\|b'))
  assert.ok(md.includes('d\\|1'))
})