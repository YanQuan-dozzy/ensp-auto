/**
 * 任务级封装集成测试（v1.8）：真 TelnetClient + 真 MockVrp。
 * 验证 execute_task 的编排：生成计划 → 走 apply_config 管道（系统视图/期望校验/变更记录），
 * 以及 batch_configure 的多设备独立下发、单台失败不阻断其余。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DeviceSession,
  SnapshotStore,
  ChangeStore,
  executeTask,
  batchConfigure,
  planAclNat
} from '../.build/harness.mjs'
import { MockVrp } from '../mock-device/MockVrp.mjs'

/** 每个设备都需要的底座处理器：进入/退出系统视图、快照与 diff 命令 */
function baseHandlers(extra = []) {
  return [
    { match: /^system-view$/i, respond: () => ({ text: '', prompt: '[Huawei]' }) },
    { match: /^quit$/i, respond: () => ({ text: '', prompt: '<Huawei>' }) },
    { match: /^return$/i, respond: () => ({ text: '', prompt: '<Huawei>' }) },
    ...extra
  ]
}

async function openMock(handlers, mockOpts = {}) {
  const mock = new MockVrp({ ...mockOpts, handlers: baseHandlers(handlers) })
  const port = await mock.listen()
  const opened = await DeviceSession.open(port, 'IT', {}, {
    onRaw() {},
    onClosed() {},
    onStateChanged() {}
  })
  return { mock, session: opened.session, deviceId: opened.session.id }
}

async function setup(handlers, mockOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-task-it-'))
  const snapshots = new SnapshotStore(path.join(dir, 'snaps'))
  const changes = new ChangeStore(path.join(dir, 'changes'))
  const { mock, session, deviceId } = await openMock(handlers, mockOpts)
  const ctx = {
    sessions: {
      get: (id) => (id === deviceId ? session : undefined),
      require: () => undefined
    },
    settings: {},
    snapshots,
    changes,
    requestGate: async () => true,
    signal: undefined
  }
  const teardown = async () => {
    session.close()
    await mock.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { mock, session, deviceId, ctx, teardown }
}

test('execute_task(ospf)：生成配置 → 下发 → display ospf peer=Full 校验通过', async (t) => {
  const { deviceId, session, ctx, teardown } = await setup([
    { match: /^ospf 1 router-id 1\.1\.1\.1$/i, respond: () => ({ text: '', prompt: '[Huawei-ospf-1]' }) },
    { match: /^area 0\.0\.0\.0$/i, respond: () => ({ text: '', prompt: '[Huawei-ospf-1-area-0.0.0.0]' }) },
    { match: /^network 10\.0\.12\.0 0\.0\.0\.255$/i, respond: () => ({ text: '' }) }
  ])
  t.after(teardown)
  // MockVrp 默认自带 display ospf peer → 回显 Full
  assert.ok(session)

  const r = await executeTask.handler(
    {
      task: 'ospf',
      routers: [{ deviceId, routerId: '1.1.1.1', networks: [{ network: '10.0.12.0', wildcard: '0.0.0.255' }] }]
    },
    ctx
  )
  assert.equal(r.ok, true)
  const data = r.data
  assert.equal(data.devices.length, 1)
  assert.equal(data.devices[0].deviceId, deviceId)
  // ospf 1 router-id + area + network + quit = 4 条
  assert.equal(data.devices[0].applied, 4)
  assert.equal(data.devices[0].verified, true)
})

test('execute_task(vlan)：vlan batch + access 划分 + display vlan 校验', async (t) => {
  const { deviceId, ctx, teardown } = await setup([
    { match: /^vlan batch 10 20$/i, respond: () => ({ text: '', prompt: '[Huawei]' }) },
    { match: /^interface GigabitEthernet 0\/0\/1$/i, respond: () => ({ text: '', prompt: '[Huawei-GigabitEthernet0/0/1]' }) },
    { match: /^port link-type access$/i, respond: () => ({ text: '' }) },
    { match: /^port default vlan 10$/i, respond: () => ({ text: '' }) },
    { match: /^display vlan$/i, respond: () => ({ text: 'VID Type Status\n10 common UP\n20 common UP', prompt: '<Huawei>' }) }
  ])
  t.after(teardown)

  const r = await executeTask.handler(
    {
      task: 'vlan',
      switches: [{ deviceId, vlans: [10, 20], ports: [{ port: 'GigabitEthernet 0/0/1', vlan: 10, mode: 'access' }] }]
    },
    ctx
  )
  assert.equal(r.ok, true)
  // vlan batch + interface + link-type + default vlan + quit = 5 条，期望校验单独走 display vlan
  assert.equal(r.data.devices[0].applied, 5)
  assert.equal(r.data.devices[0].verified, true)
})

test('execute_task(dhcp)：池 + vlanif 绑定，收尾 ping 网关', async (t) => {
  const { deviceId, ctx, teardown } = await setup([
    { match: /^dhcp enable$/i, respond: () => ({ text: '', prompt: '[Huawei]' }) },
    { match: /^ip pool vlan10$/i, respond: () => ({ text: '', prompt: '[Huawei-ip-pool-vlan10]' }) },
    { match: /^network 192\.168\.10\.0 mask 255\.255\.255\.0$/i, respond: () => ({ text: '' }) },
    { match: /^gateway-list 192\.168\.10\.1$/i, respond: () => ({ text: '' }) },
    { match: /^interface Vlanif 10$/i, respond: () => ({ text: '', prompt: '[Huawei-Vlanif10]' }) },
    { match: /^dhcp select global$/i, respond: () => ({ text: '' }) },
    { match: /^display ip pool$/i, respond: () => ({ text: 'Pool name : vlan10\nNetwork : 192.168.10.0', prompt: '<Huawei>' }) },
    {
      match: /^ping -c 3 192\.168\.10\.1$/i,
      respond: () => ({ text: '5 packet(s) transmitted, 5 packet(s) received, 0.0% packet loss', prompt: '<Huawei>' })
    }
  ])
  t.after(teardown)

  const r = await executeTask.handler(
    {
      task: 'dhcp',
      server: deviceId,
      pools: [{ name: 'vlan10', network: '192.168.10.0', prefix: 24, gateway: '192.168.10.1' }],
      bindings: [{ vlanif: 10 }]
    },
    ctx
  )
  assert.equal(r.ok, true)
  assert.equal(r.data.devices[0].verified, true)
  assert.equal(r.data.verifies.length, 1)
  assert.equal(r.data.verifies[0].verdict, 'reachable')
  assert.equal(r.data.allConnected, true)
})

test('execute_task(pc_connectivity)：纯验证，不可达时整体失败', async (t) => {
  const { deviceId, ctx, teardown } = await setup([
    {
      match: /^ping -c 3 192\.168\.99\.1$/i,
      respond: () => ({ text: '5 packet(s) transmitted, 0 packet(s) received, 100.0% packet loss', prompt: '<Huawei>' })
    }
  ])
  t.after(teardown)

  const bad = await executeTask.handler(
    { task: 'pc_connectivity', checks: [{ from: deviceId, target: '192.168.99.1' }] },
    ctx
  )
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'VERIFY_FAILED')
  assert.equal(bad.data.allConnected, false)
})

test('execute_task(pc_connectivity)：可达时返回 allConnected=true', async (t) => {
  const { deviceId, ctx, teardown } = await setup([
    {
      match: /^ping -c 3 192\.168\.10\.1$/i,
      respond: () => ({ text: '5 packet(s) transmitted, 5 packet(s) received, 0.0% packet loss', prompt: '<Huawei>' })
    }
  ])
  t.after(teardown)

  const good = await executeTask.handler(
    { task: 'pc_connectivity', checks: [{ from: deviceId, target: '192.168.10.1' }] },
    ctx
  )
  assert.equal(good.ok, true)
  assert.equal(good.data.allConnected, true)
})

test('execute_task：未知任务类型 → BAD_PARAM（不触碰上下文）', async () => {
  const ctxNoSession = {} // 不该被访问；handler 在 switch 前不读 ctx
  const r = await executeTask.handler({ task: 'bgp' }, ctxNoSession)
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'BAD_PARAM')
})

test('batch_configure：多设备逐台下发，单台失败其余成功', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-batch-it-'))
  const snapshots = new SnapshotStore(path.join(dir, 'snaps'))
  const changes = new ChangeStore(path.join(dir, 'changes'))

  // 设备 1：正常
  const m1 = new MockVrp({
    handlers: baseHandlers([{ match: /^sysname R1$/i, respond: () => ({ text: '' }) }])
  })
  const p1 = await m1.listen()
  const { session: s1 } = await DeviceSession.open(p1, 'R1', {}, { onRaw() {}, onClosed() {}, onStateChanged() {} })
  const id1 = s1.id

  // 设备 2：命令回显错误 → apply 失败
  const m2 = new MockVrp({
    handlers: baseHandlers([
      {
        match: /^sysname R2$/i,
        respond: () => ({ text: "                    ^\r\nError: Unrecognized command found at '^' position." })
      }
    ])
  })
  const p2 = await m2.listen()
  const { session: s2 } = await DeviceSession.open(p2, 'R2', {}, { onRaw() {}, onClosed() {}, onStateChanged() {} })
  const id2 = s2.id

  t.after(async () => {
    s1.close()
    s2.close()
    await m1.close()
    await m2.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const ctx = {
    sessions: {
      get: (id) => {
        if (id === id1) return s1
        if (id === id2) return s2
        return undefined
      },
      require: () => undefined
    },
    settings: {},
    snapshots,
    changes,
    requestGate: async () => true,
    signal: undefined
  }

  const r = await batchConfigure.handler(
    {
      devices: [
        { deviceId: id1, commands: ['sysname R1'], description: '改名 R1' },
        { deviceId: id2, commands: ['sysname R2'], description: '改名 R2' }
      ]
    },
    ctx
  )
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'PARTIAL_FAILED')
  assert.equal(r.data.succeeded, 1)
  assert.equal(r.data.failed.length, 1)
  assert.equal(r.data.failed[0].deviceId, id2)
})

// ———————————————————— T1.7 计划生成器失败要转成可读原因（R9） ————————————————————

test('T1.7 planAclNat：非法输入抛出可读原因，绝不抛裸 TypeError', () => {
  const cases = [
    {
      what: '三者全空',
      input: [{ deviceId: 'R1' }],
      expect: /未提供任何 ACL、Easy IP 或 nat server/
    },
    {
      what: 'ACL 没有规则',
      input: [{ deviceId: 'R1', acls: [{ number: 3000, rules: [] }] }],
      expect: /ACL 3000 没有规则/
    },
    {
      what: 'Easy IP 引用了未定义的 ACL',
      input: [
        {
          deviceId: 'R1',
          acls: [{ number: 3000, rules: ['rule 5 permit ip'] }],
          easyIp: { acl: 3001, interface: 'GigabitEthernet0/0/1' }
        }
      ],
      expect: /ACL 3001 未在 acls 中定义/
    },
    {
      what: 'nat server 协议非法',
      input: [
        {
          deviceId: 'R1',
          natServers: [
            { protocol: 'icmp', interface: 'GigabitEthernet0/0/1', globalPort: 80, insideAddr: '10.0.0.2', insidePort: 8080 }
          ]
        }
      ],
      expect: /协议非法/
    },
    {
      what: 'nat server 端口越界',
      input: [
        {
          deviceId: 'R1',
          natServers: [
            { protocol: 'tcp', interface: 'GigabitEthernet0/0/1', globalPort: 0, insideAddr: '10.0.0.2', insidePort: 8080 }
          ]
        }
      ],
      expect: /端口非法/
    }
  ]
  for (const c of cases) {
    assert.throws(
      () => planAclNat(c.input),
      (e) => {
        assert.ok(
          !/Cannot read properties/.test(e.message),
          `${c.what}：不能把裸 TypeError 抛给代理 —— ${e.message}`
        )
        assert.match(e.message, c.expect, `${c.what}：原因必须可读`)
        return true
      },
      `${c.what} 应抛出异常`
    )
  }
})

test('T1.7 planAclNat：合法输入正常产出期望校验', () => {
  const plan = planAclNat([
    { deviceId: 'R1', acls: [{ number: 3000, rules: ['rule 5 permit ip source 10.0.0.0 0.0.0.255'] }] }
  ])
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0].deviceId, 'R1')
  assert.equal(plan.steps[0].expectation.command, 'display acl all')
  assert.equal(plan.steps[0].expectation.expect, 'ACL 3000')
})

test('T1.7 execute_task(acl_nat)：设备未给任何配置 → BAD_PARAM + 可读原因', async () => {
  // 缺配置时必须在「生成计划」这一步就失败，不该走到会话访问；用空 ctx 断言这一点
  const ctxUntouched = {}
  const r = await executeTask.handler(
    { task: 'acl_nat', devices: [{ deviceId: 'R1' }] },
    ctxUntouched
  )
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'BAD_PARAM')
  assert.ok(
    !/Cannot read properties/.test(r.error.message),
    `不能把裸 TypeError 透给代理 —— ${r.error.message}`
  )
  assert.match(r.error.message, /未提供任何 ACL、Easy IP 或 nat server/)
})

test('T1.7 execute_task(eth_trunk)：空成员列表 → BAD_PARAM 且原因是可读的', async () => {
  const r = await executeTask.handler(
    { task: 'eth_trunk', devices: [{ deviceId: 'SW1', members: [] }] },
    {}
  )
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'BAD_PARAM')
  assert.ok(!/Cannot read properties/.test(r.error.message))
})