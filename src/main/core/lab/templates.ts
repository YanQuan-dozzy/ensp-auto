/**
 * 内置实验模板（v2.0）。
 *
 * 把常见 eNSP 实验从「模型自由发挥」变成「结构化模板一键跑」：
 * run_lab_template 按模板的角色映射到真实设备，套用 batch_configure 安全管道下发，
 * 收尾按 checks 做连通性验证。与 execute_task 的区别：模板是「整场实验场景」，
 * 含 IP 规划、设备角色与上架说明，适合一句话起实验。
 *
 * 纯函数 buildTemplateTaskSteps 可单测；命令生成与 skills/builtin.ts 的规范一致。
 */

import type { Expectation } from '@shared/types'
import type { PcPair, TaskStep } from '../tasks/plans'

export interface LabTemplateRole {
  /** 角色名，如 r1 / sw1 */
  role: string
  /** 建议设备模型/位置提示 */
  hint: string
}

export interface LabTemplateCommands {
  /** 目标角色（须在 roles 中声明） */
  role: string
  /** 按顺序下发的配置命令（不含 system-view，由向下管道统一进入） */
  commands: string[]
  /** 变更意图说明 */
  description: string
  /** 下发成功后的期望校验（可选） */
  expectation?: Expectation
}

export interface LabTemplateIpRow {
  device: string
  iface: string
  ip: string
  purpose?: string
}

export interface LabTemplate {
  id: string
  name: string
  description: string
  /** 一句话实验目标描述（写入文档与返回结果） */
  note: string
  /** 需要哪些角色；runtime 由 deviceMap 或顺序映射补齐 */
  roles: LabTemplateRole[]
  /** IP 规划表（导出备课文档用） */
  ipPlan?: LabTemplateIpRow[]
  /** 每角色要下发的配置块 */
  devices: LabTemplateCommands[]
  /** 收尾连通性验证：源角色 ping 目标 IP */
  checks?: PcPair[]
}

/** 把模板 + 角色映射展开成可执行的步骤（纯函数，供单测与 run_lab_template 复用） */
export function buildTemplateTaskSteps(
  template: LabTemplate,
  deviceIdByRole: Record<string, string>
): { steps: TaskStep[]; checks: PcPair[]; missingRoles: string[] } {
  const steps: TaskStep[] = []
  const checks: PcPair[] = []
  const missingRoles: string[] = []

  const resolve = (role: string): string => {
    const id = deviceIdByRole[role]
    if (!id) missingRoles.push(role)
    return id
  }

  for (const d of template.devices) {
    const id = resolve(d.role)
    if (!id) continue
    steps.push({
      deviceId: id,
      commands: d.commands,
      description: d.description,
      ...(d.expectation ? { expectation: d.expectation } : {})
    })
  }
  for (const c of template.checks ?? []) {
    const from = resolve(c.from)
    if (!from) continue
    checks.push({ from, target: c.target })
  }
  return { steps, checks, missingRoles }
}

export const LAB_TEMPLATES: readonly LabTemplate[] = [
  {
    id: 'static-route-basic',
    name: '静态路由互通',
    description: '两台路由器直连 + 各自回环口，互下静态路由实现回环互通（每台 1 条去程 + 1 条回程）。',
    note: 'R1 与 R2 通过 GE0/0/0 直连（10.0.12.0/24），各自 LoopBack0 用 1.1.1.1/32 与 2.2.2.2/32 模拟内网段。每台只要配一条指向对端回环的静态路由，即可互通。',
    roles: [
      { role: 'r1', hint: '路由器（如 AR2220），GE0/0/0 连 r2' },
      { role: 'r2', hint: '路由器，GE0/0/0 连 r1' }
    ],
    ipPlan: [
      { device: 'r1', iface: 'GigabitEthernet 0/0/0', ip: '10.0.12.1/24', purpose: '互联链路' },
      { device: 'r1', iface: 'LoopBack 0', ip: '1.1.1.1/32', purpose: '本地回环' },
      { device: 'r2', iface: 'GigabitEthernet 0/0/0', ip: '10.0.12.2/24', purpose: '互联链路' },
      { device: 'r2', iface: 'LoopBack 0', ip: '2.2.2.2/32', purpose: '本地回环' }
    ],
    devices: [
      {
        role: 'r1',
        commands: [
          'interface GigabitEthernet 0/0/0',
          'ip address 10.0.12.1 24',
          'quit',
          'interface LoopBack 0',
          'ip address 1.1.1.1 255.255.255.255',
          'quit',
          'ip route-static 2.2.2.2 255.255.255.255 10.0.12.2'
        ],
        description: 'R1：互联口 IP + LoopBack0 + 指向 r2 回环的静态路由',
        expectation: { command: 'display ip routing-table', expect: '2.2.2.2/32', mode: 'contains', times: 2 }
      },
      {
        role: 'r2',
        commands: [
          'interface GigabitEthernet 0/0/0',
          'ip address 10.0.12.2 24',
          'quit',
          'interface LoopBack 0',
          'ip address 2.2.2.2 255.255.255.255',
          'quit',
          'ip route-static 1.1.1.1 255.255.255.255 10.0.12.1'
        ],
        description: 'R2：互联口 IP + LoopBack0 + 指向 r1 回环的静态路由',
        expectation: { command: 'display ip routing-table', expect: '1.1.1.1/32', mode: 'contains', times: 2 }
      }
    ],
    checks: [
      { from: 'r1', target: '2.2.2.2' },
      { from: 'r2', target: '1.1.1.1' }
    ]
  },
  {
    id: 'rip-three-routers',
    name: 'RIP 三路由互通',
    description: '三台路由器链式互联，各宣告直连段与回环口，跑通 RIP v2 后全网互通（R1 能 ping 通 R3 回环）。',
    note: 'R1–R2–R3 链式互联，互联段 10.0.12.0/24 与 10.0.23.0/24，回环 1.1.1.1 / 2.2.2.2 / 3.3.3.3。每台在其 RIP 进程里宣告本机全部直连网段与回环口。',
    roles: [
      { role: 'r1', hint: '路由器，GE0/0/0 连 r2' },
      { role: 'r2', hint: '路由器，GE0/0/0 连 r1、GE0/0/1 连 r3' },
      { role: 'r3', hint: '路由器，GE0/0/0 连 r2' }
    ],
    ipPlan: [
      { device: 'r1', iface: 'GigabitEthernet 0/0/0', ip: '10.0.12.1/24', purpose: 'R1–R2 互联' },
      { device: 'r1', iface: 'LoopBack 0', ip: '1.1.1.1/32', purpose: '本地回环' },
      { device: 'r2', iface: 'GigabitEthernet 0/0/0', ip: '10.0.12.2/24', purpose: 'R1–R2 互联' },
      { device: 'r2', iface: 'GigabitEthernet 0/0/1', ip: '10.0.23.2/24', purpose: 'R2–R3 互联' },
      { device: 'r2', iface: 'LoopBack 0', ip: '2.2.2.2/32', purpose: '本地回环' },
      { device: 'r3', iface: 'GigabitEthernet 0/0/0', ip: '10.0.23.3/24', purpose: 'R2–R3 互联' },
      { device: 'r3', iface: 'LoopBack 0', ip: '3.3.3.3/32', purpose: '本地回环' }
    ],
    devices: [
      {
        role: 'r1',
        commands: [
          'interface GigabitEthernet 0/0/0',
          'ip address 10.0.12.1 24',
          'quit',
          'interface LoopBack 0',
          'ip address 1.1.1.1 255.255.255.255',
          'quit',
          'rip 1',
          'version 2',
          'network 10.0.0.0',
          'network 1.0.0.0',
          'quit'
        ],
        description: 'R1：互联口/回环 + RIP v2 宣告',
        expectation: { command: 'display rip 1', expect: 'RIP process', mode: 'contains' }
      },
      {
        role: 'r2',
        commands: [
          'interface GigabitEthernet 0/0/0',
          'ip address 10.0.12.2 24',
          'quit',
          'interface GigabitEthernet 0/0/1',
          'ip address 10.0.23.2 24',
          'quit',
          'interface LoopBack 0',
          'ip address 2.2.2.2 255.255.255.255',
          'quit',
          'rip 1',
          'version 2',
          'network 10.0.0.0',
          'network 2.0.0.0',
          'quit'
        ],
        description: 'R2：两个互联口/回环 + RIP v2 宣告',
        expectation: { command: 'display rip 1', expect: 'RIP process', mode: 'contains' }
      },
      {
        role: 'r3',
        commands: [
          'interface GigabitEthernet 0/0/0',
          'ip address 10.0.23.3 24',
          'quit',
          'interface LoopBack 0',
          'ip address 3.3.3.3 255.255.255.255',
          'quit',
          'rip 1',
          'version 2',
          'network 10.0.0.0',
          'network 3.0.0.0',
          'quit'
        ],
        description: 'R3：互联口/回环 + RIP v2 宣告',
        expectation: { command: 'display rip 1', expect: 'RIP process', mode: 'contains' }
      }
    ],
    checks: [
      { from: 'r1', target: '3.3.3.3' },
      { from: 'r3', target: '1.1.1.1' }
    ]
  },
  {
    id: 'nat-easy-ip',
    name: 'NAT Easy IP 上网',
    description: '出口路由器内网口 NAT 上网：ACL 放行内网网段 + WAN 口 nat outbound，PC 经公网地址上网。',
    note: '内网口 GE0/0/0 取 192.168.1.1/24，WAN 口 GE0/0/1 取 202.100.1.1/24（模拟公网），ACL 2000 放行 192.168.1.0/24，WAN 口 nat outbound 2000。PC 网关填 192.168.1.1；公网侧需部署对端路由器（或直接 ping WAN 口）逐步验证。',
    roles: [
      { role: 'gw', hint: '出口路由器，GE0/0/0 接内网、GE0/0/1 接公网' }
    ],
    ipPlan: [
      { device: 'gw', iface: 'GigabitEthernet 0/0/0', ip: '192.168.1.1/24', purpose: '内网网关' },
      { device: 'gw', iface: 'GigabitEthernet 0/0/1', ip: '202.100.1.1/24', purpose: '公网接口' }
    ],
    devices: [
      {
        role: 'gw',
        commands: [
          'interface GigabitEthernet 0/0/0',
          'ip address 192.168.1.1 24',
          'quit',
          'acl number 2000',
          'rule 5 permit source 192.168.1.0 0.0.0.255',
          'quit',
          'interface GigabitEthernet 0/0/1',
          'ip address 202.100.1.1 24',
          'nat outbound 2000',
          'quit'
        ],
        description: '出口网关：内网口 IP + ACL 放行 + WAN 口 Easy IP',
        expectation: { command: 'display nat outbound', expect: '2000', mode: 'contains' }
      }
    ]
  },
  {
    id: 'eth-trunk-double-link',
    name: '双链路聚合',
    description: '两台交换机 GE0/0/9 与 GE0/0/10 双链路聚合成 Eth-Trunk 1（trunk 放行所有 VLAN），查看两端聚合 up。',
    note: 'SW1 与 SW2 各把 GE0/0/9、GE0/0/10 加入 Eth-Trunk 1，聚合口配 trunk 并放行全部 VLAN。对端也配置后 display eth-trunk 显示两端 up。',
    roles: [
      { role: 'sw1', hint: '交换机（如 S5700），GE0/0/9、GE0/0/10 连 sw2' },
      { role: 'sw2', hint: '交换机，GE0/0/9、GE0/0/10 连 sw1' }
    ],
    devices: [
      {
        role: 'sw1',
        commands: [
          'interface Eth-Trunk 1',
          'port link-type trunk',
          'port trunk allow-pass vlan all',
          'quit',
          'interface GigabitEthernet 0/0/9',
          'eth-trunk 1',
          'quit',
          'interface GigabitEthernet 0/0/10',
          'eth-trunk 1',
          'quit'
        ],
        description: 'SW1：创建 Eth-Trunk 1（trunk 全放行）并加入两个 GE 口',
        expectation: { command: 'display eth-trunk 1', expect: 'Eth-Trunk1', mode: 'contains', times: 2 }
      },
      {
        role: 'sw2',
        commands: [
          'interface Eth-Trunk 1',
          'port link-type trunk',
          'port trunk allow-pass vlan all',
          'quit',
          'interface GigabitEthernet 0/0/9',
          'eth-trunk 1',
          'quit',
          'interface GigabitEthernet 0/0/10',
          'eth-trunk 1',
          'quit'
        ],
        description: 'SW2：创建 Eth-Trunk 1（trunk 全放行）并加入两个 GE 口',
        expectation: { command: 'display eth-trunk 1', expect: 'Eth-Trunk1', mode: 'contains', times: 2 }
      }
    ]
  }
]

export function findLabTemplate(id: string): LabTemplate | null {
  return LAB_TEMPLATES.find((t) => t.id === id) ?? null
}