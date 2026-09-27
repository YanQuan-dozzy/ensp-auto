/**
 * v2.5：跨设备只读并发。
 *
 * 这批用例守的是三件事，每一条都对应一个「出错时不会报错、只会静默给出错误结果」的场景：
 *  1. **写操作是屏障** —— 只读调用不能被抽到写操作前面去跑（否则「改完再看」看到的是旧状态）；
 *  2. **同设备串行** —— 调度层就要保证，不能只指望通信层的队列；
 *  3. **资格默认关闭** —— `risk: 'read'` 不等于可以并发（connect_device 也是 read）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_CONCURRENCY,
  CONCURRENCY_BOUNDS,
  UNKNOWN_DEVICE_KEY,
  sanitizeConcurrency,
  maxParallelOf,
  deviceKeyOf,
  scheduleKeyOf,
  isParallelSafe,
  planToolBatches,
  runGroupedBounded,
  builtinTools,
  TOOLS,
  JsonStore
} from '../.build/harness.mjs'

// ————————————————————— 设置项 —————————————————————

test('sanitizeConcurrency：越界收敛、字符串输入可用、坏值回落基准', () => {
  assert.deepEqual(sanitizeConcurrency(undefined), DEFAULT_CONCURRENCY)
  assert.equal(sanitizeConcurrency({ maxParallel: 999 }).maxParallel, CONCURRENCY_BOUNDS.maxParallel.max)
  assert.equal(sanitizeConcurrency({ maxParallel: 0 }).maxParallel, CONCURRENCY_BOUNDS.maxParallel.min)
  // 渲染层的数字输入框给的是字符串
  assert.equal(sanitizeConcurrency({ maxParallel: '8' }).maxParallel, 8)
  // 坏值不能变成 0（0 会被当成「不并发」，静默降级）
  assert.equal(sanitizeConcurrency({ maxParallel: 'abc' }).maxParallel, DEFAULT_CONCURRENCY.maxParallel)
  assert.equal(sanitizeConcurrency({ maxParallel: null }).maxParallel, DEFAULT_CONCURRENCY.maxParallel)
  assert.equal(sanitizeConcurrency({ maxParallel: 3.6 }).maxParallel, 4)
  // 不传补丁时沿用基准（设置页逐项落盘时靠这个语义）
  assert.equal(sanitizeConcurrency({}, { maxParallel: 2 }).maxParallel, 2)
})

test('maxParallelOf：没有这个字段的老配置/测试替身回落到产品默认值，而不是串行', () => {
  // 回落成 1 会让「漏传一处」表现为「并发功能时好时坏」，比报错更难查
  assert.equal(maxParallelOf(undefined), DEFAULT_CONCURRENCY.maxParallel)
  assert.equal(maxParallelOf({}), DEFAULT_CONCURRENCY.maxParallel)
  assert.equal(maxParallelOf({ concurrency: { maxParallel: 1 } }), 1)
  assert.equal(maxParallelOf({ concurrency: { maxParallel: '6' } }), 6)
})

// ————————————————————— 设备归属 —————————————————————

test('deviceKeyOf：认 deviceId / from，本地工具另起一类，其余判为不可调度', () => {
  assert.equal(deviceKeyOf('device', { deviceId: '127.0.0.1:2008' }), 'dev:127.0.0.1:2008')
  assert.equal(deviceKeyOf('device', { from: '127.0.0.1:2001' }), 'dev:127.0.0.1:2001')
  assert.equal(deviceKeyOf('local', {}), 'local')
  // 作用域是设备但说不出是哪台 → 不能并发（例如 collect_device_diagnostics 的 deviceIds）
  assert.equal(deviceKeyOf('device', {}), UNKNOWN_DEVICE_KEY)
  assert.equal(deviceKeyOf('device', { deviceIds: ['a', 'b'] }), UNKNOWN_DEVICE_KEY)
  assert.equal(deviceKeyOf('device', { deviceId: '' }), UNKNOWN_DEVICE_KEY)
  assert.equal(deviceKeyOf('device', null), UNKNOWN_DEVICE_KEY)
})

test('scheduleKeyOf：本地调用各拿一把独立键 —— 否则两次 read_attachment 会被无谓串行', () => {
  const a = scheduleKeyOf('local', {}, 'c1')
  const b = scheduleKeyOf('local', {}, 'c2')
  assert.notEqual(a, b)
  // 设备调用则按设备归组：同设备必须同键（同键 = 串行）
  assert.equal(
    scheduleKeyOf('device', { deviceId: 'd1' }, 'c1'),
    scheduleKeyOf('device', { deviceId: 'd1' }, 'c2')
  )
})

test('isParallelSafe：没声明过就没有资格；声明了但设备归属不明也不放行', () => {
  assert.equal(isParallelSafe(undefined, 'dev:d1'), false)
  assert.equal(isParallelSafe({}, 'dev:d1'), false)
  assert.equal(isParallelSafe({ concurrencySafe: true }, UNKNOWN_DEVICE_KEY), false)
  assert.equal(isParallelSafe({ concurrencySafe: true }, 'dev:d1'), true)
  assert.equal(isParallelSafe({ concurrencySafe: true }, 'local:c1'), true)
})

// ————————————————————— 批次计划 —————————————————————

const call = (id, deviceKey, parallelSafe = true) => ({ id, deviceKey, parallelSafe })

test('planToolBatches：maxParallel=1 时退化成单个串行批次（与串行执行完全等价）', () => {
  const calls = [call('a', 'dev:1'), call('b', 'dev:2')]
  assert.deepEqual(planToolBatches(calls, { maxParallel: 1 }), [{ kind: 'serial', items: calls }])
})

test('planToolBatches：空列表不产出任何批次', () => {
  assert.deepEqual(planToolBatches([], { maxParallel: 4 }), [])
})

test('planToolBatches：连续只读合成一个并行批次', () => {
  const calls = [call('a', 'dev:1'), call('b', 'dev:2'), call('c', 'dev:3')]
  const plan = planToolBatches(calls, { maxParallel: 4 })
  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, 'parallel')
  assert.deepEqual(plan[0].items.map((x) => x.id), ['a', 'b', 'c'])
})

test('★ 写操作是屏障：只读不会被抽到写操作前面去（「改完再看」必须看到改后的状态）', () => {
  // 模型给出的顺序就是执行顺序：读 → 写 → 读
  const calls = [call('r1', 'dev:1'), call('w', 'dev:1', false), call('r2', 'dev:1')]
  const plan = planToolBatches(calls, { maxParallel: 4 })
  assert.deepEqual(
    plan.map((b) => [b.kind, b.items.map((x) => x.id)]),
    [
      ['parallel', ['r1']],
      ['serial', ['w']],
      ['parallel', ['r2']]
    ]
  )
})

test('planToolBatches：写操作自己也会合并成串行批次，但绝不与只读混在一起', () => {
  const calls = [call('w1', 'dev:1', false), call('w2', 'dev:2', false)]
  const plan = planToolBatches(calls, { maxParallel: 4 })
  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, 'serial')
  assert.deepEqual(plan[0].items.map((x) => x.id), ['w1', 'w2'])
})

test('planToolBatches：只有一个调用时不标并行（并发没有意义，事件顺序也更好读）', () => {
  const plan = planToolBatches([call('a', 'dev:1')], { maxParallel: 4 })
  assert.deepEqual(plan, [{ kind: 'serial', items: [call('a', 'dev:1')] }])
})

test('planToolBatches：所有调用的 id 都恰好出现一次（不丢、不重、不改序）', () => {
  const calls = [
    call('a', 'dev:1'),
    call('b', 'local:1'),
    call('w', 'dev:2', false),
    call('c', 'dev:2'),
    call('d', 'dev:3'),
    call('e', UNKNOWN_DEVICE_KEY, false)
  ]
  const flat = planToolBatches(calls, { maxParallel: 4 }).flatMap((b) => b.items.map((x) => x.id))
  assert.deepEqual(flat, ['a', 'b', 'w', 'c', 'd', 'e'])
})

// ————————————————————— 调度器 —————————————————————

/** 记录每个 key 的并发峰值与整体并发峰值 */
function probe() {
  const live = new Map()
  const keyPeak = new Map()
  let inFlight = 0
  let peak = 0
  return {
    // 用 getter —— 写成普通属性会把创建时的 0 快照下来，断言就永远是假的
    get peak() {
      return peak
    },
    // 注意要记的是**峰值**：任务跑完后当前并发数会归零，断言当前值等于白测
    maxPerKey: (k) => keyPeak.get(k) ?? 0,
    async run(key, ms = 5) {
      const active = (live.get(key) ?? 0) + 1
      live.set(key, active)
      if (active > (keyPeak.get(key) ?? 0)) keyPeak.set(key, active)
      inFlight += 1
      if (inFlight > peak) peak = inFlight
      await new Promise((r) => setTimeout(r, ms))
      live.set(key, live.get(key) - 1)
      inFlight -= 1
    }
  }
}

test('runGroupedBounded：同 key 严格串行（同设备不可能同时在跑两条命令）', async () => {
  const p = probe()
  // 4 个条目同属一台设备：无论上限给多大，它们都只能一个接一个
  await runGroupedBounded(['a', 'a', 'a', 'a'], () => 'dev:1', 8, async () => p.run('dev:1'))
  assert.equal(p.maxPerKey('dev:1'), 1)
  assert.equal(p.peak, 1)
})

test('runGroupedBounded：跨 key 真并发，且在 uint 上限内', async () => {
  const p = probe()
  const items = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']
  const out = await runGroupedBounded(items, (k) => k, 3, (k) => p.run(k, 8).then(() => k))
  assert.equal(out.length, 6)
  assert.ok(p.peak > 1, `期望真的并发起来，实际峰值 ${p.peak}`)
  assert.ok(p.peak <= 3, `并发峰值 ${p.peak} 超过上限 3`)
})

test('runGroupedBounded：结果下标与入参一一对应（并发完成顺序不影响结果位置）', async () => {
  const items = [
    { k: 'slow', ms: 30 },
    { k: 'fast', ms: 1 },
    { k: 'mid', ms: 10 }
  ]
  const out = await runGroupedBounded(items, (x) => x.k, 4, (x) => new Promise((r) => setTimeout(() => r(x.k), x.ms)))
  assert.deepEqual(out, ['slow', 'fast', 'mid'])
})

test('runGroupedBounded：空列表不发车也不报错', async () => {
  assert.deepEqual(await runGroupedBounded([], () => 'x', 4, async () => 1), [])
})

test('runGroupedBounded：已中止时不再启动任何任务', async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  let started = 0
  const out = await runGroupedBounded(
    ['a', 'b'],
    (k) => k,
    2,
    async () => {
      started += 1
      return 1
    },
    ctrl.signal
  )
  assert.equal(started, 0)
  assert.deepEqual(out, [undefined, undefined])
})

test('runGroupedBounded：limit 为 0 / 负数 / NaN 时按 1 处理（不能变成「没有上限」）', async () => {
  const p = probe()
  await runGroupedBounded(['a', 'b'], (k) => k, 0, (k) => p.run(k, 4))
  assert.equal(p.peak, 1)
})

// ————————————————————— 工具资格守卫 —————————————————————

/**
 * 这些工具的 `risk` 同样是 `read`，但会改**连接状态**或**磁盘内容**：
 * 并发执行就是静默竞态（例如两个 connect_device 同时改 SessionManager 的连接表）。
 * 这份名单是「并发资格」的第二道闸 —— 只靠 risk 分类挡不住它们。
 */
const STATE_CHANGING = new Set([
  'connect_device',
  'disconnect_device',
  'register_device',
  'unregister_device',
  'ssh_connect',
  'rename_device',
  'save_config_snapshot',
  'refresh_topology',
  'save_topo_file',
  'import_topology_file',
  'apply_config',
  'restore_snapshot',
  'batch_configure',
  'execute_task',
  'run_lab_template',
  'answer_device_prompt',
  'save_configuration'
])

/** 应当拿到并发资格的幂等只读工具（漏标记 = 静默退回串行，所以反向也要守） */
const EXPECTED_PARALLEL = new Set([
  'run_show_command',
  'get_device_context',
  'verify_ping',
  'verify_route',
  'verify_arp',
  'verify_dhcp',
  'verify_nat',
  'verify_eth_trunk',
  'verify_expectation',
  'diff_with_snapshot',
  'read_attachment',
  'find_topology_files',
  'list_devices',
  'list_sessions',
  'list_snapshots',
  'list_lab_templates',
  'analyze_reference_configs',
  'scan_devices',
  'ssh_list'
])

test('★ 并发资格守卫：声明了并发的工具必须真的是「不改状态」的只读工具', () => {
  const marked = builtinTools().filter((s) => s.concurrencySafe === true)
  assert.ok(marked.length > 0, '一个都没声明，说明标记丢了')
  for (const spec of marked) {
    assert.equal(spec.risk, 'read', `${spec.name} 声明了 concurrencySafe 却不是 read`)
    assert.ok(!STATE_CHANGING.has(spec.name), `${spec.name} 会改状态，不能并发`)
  }
})

test('并发资格守卫：幂等只读工具必须在册（防止漏标记导致静默退回串行）', () => {
  const marked = new Set(builtinTools().filter((s) => s.concurrencySafe === true).map((s) => s.name))
  for (const name of EXPECTED_PARALLEL) {
    assert.ok(marked.has(name), `${name} 丢了并发资格`)
  }
})

test('并发资格守卫：设备类工具声明的参数名必须能被 deviceKeyOf 认出来', () => {
  // 认不出的参数名 → deviceKey 为空 → 即使声明了并发也不放行（功能静默失效）。
  // 这里分别只喂一个字段，才能真正验证它用的是哪个参数名。
  const deviceTools = builtinTools().filter((s) => s.concurrencySafe === true && s.scope === 'device')
  assert.ok(deviceTools.length > 0)
  for (const spec of deviceTools) {
    const known =
      deviceKeyOf(spec.scope, { deviceId: 'X' }) !== UNKNOWN_DEVICE_KEY ||
      deviceKeyOf(spec.scope, { from: 'X' }) !== UNKNOWN_DEVICE_KEY
    assert.ok(known, `${spec.name} 的设备参数名不在 deviceKeyOf 的识别范围内`)
  }
})

// ————————————————————— 批量工具的内部并发（Level A） —————————————————————

/**
 * 造一台假设备：`exec` 睡一会儿，并记录「同时在跑的命令条数」的峰值。
 *
 * 断言并发**峰值**而不是墙钟时间 —— 时间断言在负载高的时候会偶发失败，
 * 而「同一时刻有几条命令在跑」是确定性事实。
 */
function fakeFleet(count) {
  const state = { inFlight: 0, peak: 0 }
  const devices = Array.from({ length: count }, (_, i) => ({
    id: `127.0.0.1:${2001 + i}`,
    name: `dev${i + 1}`,
    async exec() {
      state.inFlight += 1
      if (state.inFlight > state.peak) state.peak = state.inFlight
      await new Promise((r) => setTimeout(r, 8))
      state.inFlight -= 1
      return { ok: true, clean: '', settled: 'prompt' }
    }
  }))
  const ctx = {
    sessions: {
      get: (id) => devices.find((d) => d.id === id),
      list: () => devices.map((d) => ({ id: d.id, connected: true }))
    },
    settings: { concurrency: { maxParallel: 4 } }
  }
  return { devices, ctx, state }
}

function toolByName(name) {
  const spec = TOOLS.find((t) => t.name === name)
  assert.ok(spec, `工具不存在：${name}`)
  return spec
}

test('verify_connectivity：跨设备并发下发，结果顺序仍是请求顺序', async () => {
  const { devices, ctx, state } = fakeFleet(4)
  const res = await toolByName('verify_connectivity').handler(
    { deviceIds: devices.map((d) => d.id) },
    ctx
  )
  assert.equal(res.ok, true)
  assert.deepEqual(
    res.data.devices.map((d) => d.deviceId),
    devices.map((d) => d.id)
  )
  assert.equal(state.peak, 4, `期望 4 台设备同时在跑，实际峰值 ${state.peak}`)
})

test('verify_connectivity：上限设为 1 时退回逐台串行', async () => {
  const { devices, ctx, state } = fakeFleet(4)
  ctx.settings.concurrency.maxParallel = 1
  const res = await toolByName('verify_connectivity').handler(
    { deviceIds: devices.map((d) => d.id) },
    ctx
  )
  assert.equal(res.ok, true)
  assert.equal(res.data.devices.length, 4)
  assert.equal(state.peak, 1)
})

test('collect_device_diagnostics：跨设备并发，但每台设备的 7 条 display 仍严格串行', async () => {
  const { devices, ctx, state } = fakeFleet(3)
  const res = await toolByName('collect_device_diagnostics').handler(
    { deviceIds: devices.map((d) => d.id) },
    ctx
  )
  assert.equal(res.ok, true)
  assert.equal(res.data.devices.length, 3)
  // 峰值恰好等于「设备数」而不是「设备数 × 7」—— 说明设备内是串行的
  assert.equal(state.peak, 3, `期望 3 台设备并发、每台内部串行，实际峰值 ${state.peak}`)
  for (const d of res.data.devices) assert.equal(d.checks.length, 7)
})

test('批量工具：settings 里没有 concurrency（老配置 / 测试替身）时按默认值走，不炸', async () => {
  const { devices, ctx } = fakeFleet(2)
  ctx.settings = {}
  const res = await toolByName('verify_connectivity').handler(
    { deviceIds: devices.map((d) => d.id) },
    ctx
  )
  assert.equal(res.ok, true)
  assert.equal(res.data.devices.length, 2)
})

// ————————————————————— 设置项落盘往返 —————————————————————

test('★ 设置项往返：concurrency 必须能落盘、能读回，且与默认值合并（漏一处 = 改完重启回到 4）', () => {
  // 「加设置项 → 5 处」这条清单里，最容易漏的是 deepMergeSettings 那一行 ——
  // 漏了不会报错，只表现为「设置页改完、重启回到默认」，本项目已经踩过一次（R16 storage）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrency-settings-'))
  const file = path.join(dir, 'store.json')
  try {
    const store = new JsonStore(file)
    // 默认值存在
    assert.equal(store.getSettings().concurrency.maxParallel, DEFAULT_CONCURRENCY.maxParallel)

    store.updateSettings({ concurrency: { maxParallel: 9 } })
    assert.equal(store.getSettings().concurrency.maxParallel, 9)

    // 重新打开（模拟重启）后仍然是 9，而不是被默认值顶回去
    const reopened = new JsonStore(file)
    assert.equal(reopened.getSettings().concurrency.maxParallel, 9)

    // 其它子对象不能被这次合并清掉（deepMergeSettings 手写分区的典型回归）
    assert.ok(reopened.getSettings().retry)
    assert.ok(reopened.getSettings().compaction)
    assert.ok(reopened.getSettings().permission)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('设置项往返：老配置里没有 concurrency 时补默认值，不抛也不留 undefined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrency-legacy-'))
  const file = path.join(dir, 'store.json')
  try {
    fs.writeFileSync(file, JSON.stringify({ settings: { theme: 'dark', scanStart: 2000, scanEnd: 2010 } }), 'utf8')
    const store = new JsonStore(file)
    assert.equal(store.getSettings().concurrency.maxParallel, DEFAULT_CONCURRENCY.maxParallel)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
