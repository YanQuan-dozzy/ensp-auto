import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_REPEAT_GUARD,
  DEFAULT_SETTINGS,
  REPEAT_ARGS_PREVIEW_CHARS,
  REPEAT_GUARD_THRESHOLDS,
  EMPTY_REPEAT_CHAIN,
  ReactRuntime,
  Type,
  canonicalizeArgs,
  observeToolCall,
  repeatGuardEnabledOf,
  sanitizeRepeatGuard
} from '../.build/harness.mjs'

/**
 * v2.14：重复工具调用防护。
 *
 * 这一层唯一的风险是「误报把正常探测打断」与「漏报让循环继续烧预算」，
 * 两者都由纯函数判定，所以这里直接把边界钉死：
 *  ① 未达阈值不产生任何提醒；
 *  ② 参数按**值**比较（键序不同视为同一次调用）；
 *  ③ 换参数 / 换工具即重新计数；
 *  ④ 阈值递进（首次温和、后续点名）；
 *  ⑤ 提醒文本有上限，但检测始终用完整规范化串。
 */

/** 按顺序喂一串调用，收集每次返回的提醒（null 表示未命中） */
function feed(calls, thresholds) {
  let chain = EMPTY_REPEAT_CHAIN
  const notices = []
  for (const [name, args] of calls) {
    const observed = observeToolCall(chain, name, args, thresholds)
    chain = observed.chain
    notices.push(observed.notice)
  }
  return { chain, notices }
}

test('v2.14：未达首个阈值不产生提醒', () => {
  const { chain, notices } = feed([
    ['run_show_command', { deviceId: 'd1', command: 'display ospf peer' }],
    ['run_show_command', { deviceId: 'd1', command: 'display ospf peer' }]
  ])
  assert.deepEqual(notices, [null, null], '前两次都不该提醒')
  assert.equal(chain.count, 2, '链应累加到 2')
})

test('v2.14：第三次相同调用命中温和提醒，第五 / 第八次为详细提醒', () => {
  const call = ['run_show_command', { deviceId: 'd1', command: 'display ospf peer' }]
  const { notices } = feed([call, call, call, call, call, call, call, call])
  assert.equal(notices[0], null)
  assert.equal(notices[1], null)
  assert.equal(notices[2] !== null, true, '第 3 次应命中首个阈值')
  assert.equal(notices[3], null, '第 4 次不是阈值')
  assert.equal(notices[4] !== null, true, '第 5 次应命中')
  assert.equal(notices[5], null)
  assert.equal(notices[6], null, '第 7 次不是阈值')
  assert.equal(notices[7] !== null, true, '第 8 次应命中')
  // 首次是温和提醒（不含参数预览），后续详细提醒点名工具与次数
  assert.equal(notices[2].includes('display ospf peer'), false, '温和提醒不复述参数')
  assert.equal(notices[4].includes('run_show_command'), true, '详细提醒应点名工具')
  assert.equal(notices[4].includes('5'), true, '详细提醒应写明次数')
  assert.equal(notices[4].includes('display ospf peer'), true, '详细提醒应带参数')
  assert.equal(notices[7].includes('run_show_command'), true)
})

test('v2.14：参数按值比较 —— 键序不同视为同一次调用', () => {
  const { chain, notices } = feed([
    ['apply_config', { deviceId: 'd1', commands: ['a', 'b'] }],
    ['apply_config', { commands: ['a', 'b'], deviceId: 'd1' }],
    ['apply_config', { commands: ['a', 'b'], deviceId: 'd1' }]
  ])
  assert.equal(chain.count, 3, '键序不同的同一份参数应连续累加')
  assert.equal(notices[2] !== null, true, '第 3 次应命中')
  // 嵌套对象同样按值比较
  assert.equal(
    canonicalizeArgs({ a: { y: 1, x: 2 }, b: 3 }),
    canonicalizeArgs({ b: 3, a: { x: 2, y: 1 } }),
    '嵌套对象的键序也应被归一'
  )
})

test('v2.14：换参数或换工具都会重新计数', () => {
  // 参数变了
  const first = feed([
    ['run_show_command', { deviceId: 'd1', command: 'display ospf peer' }],
    ['run_show_command', { deviceId: 'd1', command: 'display ospf peer' }],
    ['run_show_command', { deviceId: 'd1', command: 'display ip routing-table' }]
  ])
  assert.equal(first.chain.count, 1, '参数不同应重新计数')
  assert.equal(first.notices[2], null)
  // 工具变了（参数相同）
  const second = feed([
    ['run_show_command', { deviceId: 'd1', command: 'x' }],
    ['run_show_command', { deviceId: 'd1', command: 'x' }],
    ['verify_ping', { deviceId: 'd1', command: 'x' }]
  ])
  assert.equal(second.chain.count, 1, '工具不同应重新计数')
})

test('v2.14：列表与标量参数同样参与比较', () => {
  const { chain } = feed([
    ['run_show_command', ['display', 'ospf', 'peer']],
    ['run_show_command', ['display', 'ospf', 'peer']]
  ])
  assert.equal(chain.count, 2, '数组参数应能稳定比较')
  assert.equal(observeToolCall(EMPTY_REPEAT_CHAIN, 't', 7).chain.count, 1, '标量参数不应抛')
  assert.equal(observeToolCall(EMPTY_REPEAT_CHAIN, 't', null).chain.count, 1, 'null 参数不应抛')
})

test('v2.14：详细提醒里的参数预览有上限，但检测用完整串', () => {
  const big = { payload: 'x'.repeat(REPEAT_ARGS_PREVIEW_CHARS * 3) }
  // 首个阈值（第 3 次）是温和提醒、不复述参数；详细提醒要到第 5 次才出现
  const { notices } = feed([
    ['tool_a', big],
    ['tool_a', big],
    ['tool_a', big],
    ['tool_a', big],
    ['tool_a', big]
  ])
  const notice = notices[4]
  assert.equal(notice !== null, true, '第 5 次应命中详细提醒')
  assert.equal(notice.includes('另省略'), true, '超长参数应标注省略量')
  assert.equal(notice.length < REPEAT_ARGS_PREVIEW_CHARS * 2, true, '提醒本身不应把整份参数带进上下文')
})

test('v2.14：canonicalizeArgs 对非 JSON 输入退化而不抛', () => {
  assert.equal(canonicalizeArgs(undefined), 'undefined')
  assert.equal(canonicalizeArgs({ a: 1 }), '{"a":1}')
  // 循环引用无法 stringify —— 必须退化为 String()，而不是把整轮任务带下去
  const cyclic = { name: 'loop' }
  cyclic.self = cyclic
  assert.equal(typeof canonicalizeArgs(cyclic), 'string')
})

test('v2.14：用户插话重置链（调用方把链换回空链）', () => {
  const call = ['run_show_command', { deviceId: 'd1', command: 'display ospf peer' }]
  const first = feed([call, call])
  assert.equal(first.chain.count, 2)
  // 运行时在 drain 排队插话 / 计划评审回话处重置
  const afterInterjection = observeToolCall(EMPTY_REPEAT_CHAIN, call[0], call[1])
  assert.equal(afterInterjection.chain.count, 1, '插话后应重新从 1 计数')
  assert.equal(afterInterjection.notice, null)
})

test('v2.14：阈值只认命中值，且可注入自定义阈值', () => {
  const call = ['tool_a', { x: 1 }]
  const { notices } = feed([call, call, call, call], [2, 4])
  assert.equal(notices[0], null, '第 1 次不提醒')
  assert.equal(notices[1] !== null, true, '自定义首阈值 2 应生效')
  assert.equal(notices[2], null)
  assert.equal(notices[3] !== null, true, '自定义次阈值 4 应生效')
  assert.deepEqual(REPEAT_GUARD_THRESHOLDS, [3, 5, 8], '产品默认阈值')
})

test('v2.14：sanitize 收敛坏值、缺省沿用现值', () => {
  assert.deepEqual(DEFAULT_REPEAT_GUARD, { enabled: true }, '默认开启')
  assert.deepEqual(sanitizeRepeatGuard({ enabled: false }), { enabled: false })
  assert.deepEqual(sanitizeRepeatGuard({ enabled: 'yes' }), { enabled: true }, '非布尔值回落到默认')
  assert.deepEqual(sanitizeRepeatGuard(undefined), { enabled: true })
  // 显式传 base：坏值沿用现值而不是落回默认（否则「关掉后被坏补丁打开」）
  assert.deepEqual(sanitizeRepeatGuard({ enabled: 1 }, { enabled: false }), { enabled: false })
})

test('v2.14：repeatGuardEnabledOf 容忍老配置缺少这一块', () => {
  assert.equal(repeatGuardEnabledOf({}), true, '老配置没有这一块 → 视为开启')
  assert.equal(repeatGuardEnabledOf(undefined), true)
  assert.equal(repeatGuardEnabledOf({ repeatGuard: { enabled: false } }), false)
})

// ————————————————————— 运行时接线（端到端） —————————————————————

/** 每次调用都返回同样结果、且参数完全相同的工具 —— 这正是「死循环」的形态 */
function repeatTool() {
  return {
    name: 'run_show_command',
    description: 'stub',
    risk: 'read',
    scope: 'device',
    concurrencySafe: true,
    schema: Type.Object({ deviceId: Type.String() }, { additionalProperties: false }),
    summarize: () => '读取',
    handler: async () => ({ ok: true, data: { echo: 'same' }, meta: { ms: 1, deviceId: 'd1' } })
  }
}

/**
 * 桩 LLM：连续 `rounds` 次回**完全相同**的工具调用，之后回纯 done。
 * 必须快照 messages —— `ctx.messages` 是活数组，事后读到的是最新状态。
 */
function scriptedSameCall(requests, rounds) {
  let n = 0
  const sink = () => (model, ctx) => {
    n += 1
    const idx = n
    requests.push({ messages: [...ctx.messages] })
    const call = { id: `c${idx}`, name: 'run_show_command', arguments: { deviceId: 'd1' } }
    const queue =
      idx <= rounds
        ? [{ type: 'toolcall_end', toolCall: call }, { type: 'done' }]
        : [{ type: 'done' }]
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const ev = queue.shift()
            return ev ? { done: false, value: ev } : { done: true, value: undefined }
          }
        }
      },
      async result() {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: '' }, ...(idx <= rounds ? [{ type: 'toolCall', ...call }] : [])],
          api: 'openai-completions',
          provider: 'compat',
          model: 'stub',
          usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: Date.now()
        }
      }
    }
  }
  return async (cfg) => ({
    provider: 'compat',
    modelId: cfg.model,
    models: {
      getModel: () => ({ id: cfg.model, contextWindow: 100000, maxTokens: 4096 }),
      stream: sink(),
      streamSimple: sink()
    }
  })
}

async function driveWith(settings, tools, buildLlm) {
  const runtime = new ReactRuntime(
    {
      tools,
      getSettings: () => settings,
      getSkills: () => [],
      getCustomInstructions: () => '',
      buildContext: () => ({})
    },
    { apiKey: 'stub-key', buildLlm }
  )
  const events = []
  for await (const ev of runtime.run({
    sessionId: 's-1',
    text: '开始配置',
    signal: new AbortController().signal
  })) {
    events.push(ev)
  }
  return events
}

test('v2.14：连续重复调用会把提醒追加进工具回显，且不改变轮次划分', async () => {
  const requests = []
  const settings = structuredClone(DEFAULT_SETTINGS)
  const events = await driveWith(settings, [repeatTool()], scriptedSameCall(requests, 4))

  const withNotice = requests.filter((r) => JSON.stringify(r.messages).includes('【系统】'))
  assert.equal(withNotice.length > 0, true, '提醒必须真的进入后续请求的上下文')

  const first = withNotice[0]
  const noticeMsg = first.messages.find((m) =>
    JSON.stringify(m.content ?? '').includes('【系统】')
  )
  assert.equal(noticeMsg.role, 'toolResult', '提醒必须挂在工具回显里，而不是另起一条 user 消息')
  assert.equal(
    first.messages.filter((m) => m.role === 'user').length,
    1,
    '轮次划分不能因为提醒而改变（user 消息仍只有任务目标那一条）'
  )
  assert.equal(
    events.some((e) => e.type === 'error' && String(e.message).includes('【系统】')),
    true,
    '界面也要看得见这条提醒'
  )
})

test('v2.14：关掉开关后不再注入任何提醒', async () => {
  const requests = []
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.repeatGuard = { enabled: false }
  await driveWith(settings, [repeatTool()], scriptedSameCall(requests, 4))
  assert.equal(
    requests.some((r) => JSON.stringify(r.messages).includes('【系统】')),
    false,
    '关掉后连一条提醒都不该出现'
  )
})
