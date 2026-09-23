/**
 * v1.7 单测：运行时韧性 —— 请求重试 + 上下文压缩。
 *
 * 覆盖口径：
 * - 纯策略：退避与预算（含上限与抖动）、字符估算、单条截断、轮级压缩的三条边界；
 * - 失败分类：直接打 pi-ai 的 retry/overflow 判定器，确认「哪些错值得重试」的接线没接反
 *   （尤其是「额度耗尽」不能被当成限流 —— 那会导致三次无意义重试）；
 * - 结构安全：压缩只改内容不改条数，工具调用与结果的配对关系必须完好
 *   （破坏配对会让所有 provider 直接报错，而且错误现象与压缩毫无关联，极难定位）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_COMPACTION,
  DEFAULT_RETRY,
  DEFAULT_SETTINGS,
  MAX_BACKOFF_MS,
  backoffDelay,
  describeCompaction,
  estimateChars,
  messageChars,
  planCompaction,
  planRetry,
  sanitizeCompaction,
  sanitizeRetry,
  truncateToolResult,
  synthError,
  isRetryableFailure,
  isOverflowFailure,
  explainFailure
} from '../.build/harness.mjs'

// ————————————————————— 造消息的小工具 —————————————————————

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 })
const assistantText = (text) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 })
const assistantCall = (id, name, args = {}) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: args }],
  timestamp: 3
})
const toolResult = (id, name, text, ok = true) => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: name,
  content: [{ type: 'text', text }],
  isError: !ok,
  timestamp: 4
})

/** 一轮 = 一条 user + 若干 assistant/工具往返 */
function round(n, payloadChars = 0) {
  const id = `c${n}`
  return [
    user(`第 ${n} 轮：检查设备 ${n}`),
    assistantCall(id, 'run_command', { deviceId: `d${n}` }),
    toolResult(id, 'run_command', payloadChars > 0 ? 'x'.repeat(payloadChars) : `设备 ${n} 正常`)
  ]
}

// ————————————————————— 策略收敛 —————————————————————

test('sanitizeRetry：越界收敛、字符串输入可用、坏值回落基准', () => {
  assert.deepEqual(sanitizeRetry({ enabled: false, maxRetries: 99, baseDelayMs: -5 }), {
    enabled: false,
    maxRetries: 5,
    baseDelayMs: 0
  })
  assert.deepEqual(sanitizeRetry({ maxRetries: '3.6', baseDelayMs: '500' }), {
    enabled: true,
    maxRetries: 4,
    baseDelayMs: 500
  })
  // 渲染层的数字输入框清空时给的是 ''，必须回落到基准而不是变成 NaN
  assert.equal(sanitizeRetry({ maxRetries: '', baseDelayMs: '' }).maxRetries, DEFAULT_RETRY.maxRetries)
  assert.equal(sanitizeRetry(undefined).enabled, true)
  assert.equal(sanitizeRetry({ enabled: 'yes' }).enabled, true) // 非布尔不接受
})

test('sanitizeCompaction：四个字段各自有上下界', () => {
  const c = sanitizeCompaction({
    toolResultMaxChars: 1,
    transcriptMaxChars: 10 ** 9,
    keepRounds: 0
  })
  assert.equal(c.toolResultMaxChars, 1000)
  assert.equal(c.transcriptMaxChars, 2_000_000)
  assert.equal(c.keepRounds, 1)
  assert.deepEqual(sanitizeCompaction({}), DEFAULT_COMPACTION)
})

test('backoffDelay：指数退避 + 抖动 + 30 秒上限', () => {
  const p = { enabled: true, maxRetries: 5, baseDelayMs: 1000 }
  assert.equal(backoffDelay(1, p, () => 0), 1000) // 无抖动时就是基数
  assert.equal(backoffDelay(2, p, () => 0), 2000)
  assert.equal(backoffDelay(3, p, () => 0), 4000)
  // 抖动上限 25%
  assert.equal(backoffDelay(1, p, () => 1), 1250)
  // 上限：第 6 次本该 32000，被截到 30000
  assert.equal(backoffDelay(6, p, () => 0), MAX_BACKOFF_MS)
  assert.equal(backoffDelay(1, { ...p, baseDelayMs: 0 }, () => 0), 0)
})

test('planRetry：预算是「不含首次调用」的重试次数', () => {
  const p = { enabled: true, maxRetries: 2, baseDelayMs: 100 }
  assert.equal(planRetry(p, 0, '429', () => 0).retry, true)
  assert.equal(planRetry(p, 0, '429', () => 0).attempt, 1)
  assert.equal(planRetry(p, 1, '429', () => 0).retry, true)
  assert.equal(planRetry(p, 2, '429', () => 0).retry, false) // 用尽
  assert.equal(planRetry({ ...p, enabled: false }, 0, '429').retry, false)
  assert.equal(planRetry({ ...p, maxRetries: 0 }, 0, '429').retry, false)
})

// ————————————————————— 字符估算与单条截断 —————————————————————

test('messageChars / estimateChars：文本按字符数，非文本按 JSON 兜底', () => {
  // 消息的固定开销 32；每个内容块再算 16
  assert.equal(messageChars(user('abcd')), 4 + 32 + 16)
  assert.equal(messageChars({ role: 'user', content: 'abcd' }), 4 + 32) // 纯字符串 content
  const withTool = assistantCall('c1', 'run_command', { a: 1 })
  assert.ok(messageChars(withTool) > 32)
  assert.equal(estimateChars([user('abcd'), user('abcd')]), 2 * (4 + 32 + 16))
  assert.equal(estimateChars([]), 0)
})

test('truncateToolResult：保头保尾，中间给出省略量与拿全方式', () => {
  const text = 'H'.repeat(600) + 'M'.repeat(800) + 'T'.repeat(600)
  const r = truncateToolResult(text, 1000)
  assert.equal(r.truncated, true)
  assert.equal(r.originalChars, 2000)
  assert.equal(r.omittedChars, 1000)
  assert.ok(r.text.startsWith('H'.repeat(100))) // 头部保留
  assert.ok(r.text.endsWith('T'.repeat(100))) // 尾部保留（结论在末尾）
  assert.match(r.text, /已省略中间 1000 字符/)
  assert.match(r.text, /重新获取/)
  assert.ok(r.text.length < text.length)
})

test('truncateToolResult：未超限、上限为 0 时原样返回', () => {
  assert.deepEqual(truncateToolResult('short', 100), {
    text: 'short',
    truncated: false,
    originalChars: 5,
    omittedChars: 0
  })
  assert.equal(truncateToolResult('x'.repeat(50), 0).truncated, false)
  assert.equal(truncateToolResult('x'.repeat(50), 50).truncated, false)
})

// ————————————————————— 轮级压缩 —————————————————————

test('planCompaction：未超预算时原样返回', () => {
  const messages = [...round(1, 10), ...round(2, 10)]
  const r = planCompaction(messages, { maxChars: 100_000, keepRounds: 1 })
  assert.equal(r.applied, false)
  assert.equal(r.messages.length, messages.length)
  assert.equal(r.savedChars, 0)
})

test('planCompaction：轮数不足保留窗口时不动手（防 undefined 下标那个回归）', () => {
  // 只有 2 轮，却要求保留 4 轮 —— 曾经的写法会取 starts[-2]，
  // 拿到 undefined 后所有比较为 false，反而把整段 transcript 都压掉
  const messages = [...round(1, 500), ...round(2, 500)]
  const r = planCompaction(messages, { maxChars: 10, keepRounds: 4 })
  assert.equal(r.applied, false)
  assert.deepEqual(r.messages, messages)

  // 只有 1 轮时同理
  const single = round(1, 500)
  assert.equal(planCompaction(single, { maxChars: 1, keepRounds: 3 }).applied, false)
})

test('planCompaction：第一轮与最近若干轮保持原文，用户消息一字不改', () => {
  const messages = [...round(1, 3000), ...round(2, 3000), ...round(3, 3000), ...round(4, 3000)]
  const r = planCompaction(messages, { maxChars: 1000, keepRounds: 2 })
  assert.equal(r.applied, true)
  // 条数完全不变（只改内容）
  assert.equal(r.messages.length, messages.length)
  // 第一轮：工具结果原文保留
  assert.equal(r.messages[2].content[0].text.length, 3000)
  // 最后一轮：同样原文保留
  assert.equal(r.messages[r.messages.length - 1].content[0].text.length, 3000)
  // 被压的那一轮：变成摘要，且带上了工具名与原始长度
  const shrunk = r.messages[5]
  assert.equal(shrunk.role, 'toolResult')
  assert.match(shrunk.content[0].text, /\[已压缩\]/)
  assert.match(shrunk.content[0].text, /run_command/)
  assert.ok(r.savedChars > 0)
  assert.ok(r.afterChars < r.beforeChars)
  // 所有 user 消息逐字保留
  const usersBefore = messages.filter((m) => m.role === 'user')
  const usersAfter = r.messages.filter((m) => m.role === 'user')
  assert.deepEqual(usersAfter, usersBefore)
})

test('planCompaction：结构安全 —— 工具调用与结果的配对、callId、错误标记都不动', () => {
  const messages = [...round(1, 5000), ...round(2, 5000), ...round(3, 5000)]
  // 把第 1 轮的结果标成失败，压缩后必须仍带着 isError
  messages[2] = { ...messages[2], isError: true }
  const r = planCompaction(messages, { maxChars: 100, keepRounds: 1 })
  assert.equal(r.applied, true)

  const ids = (list) =>
    list
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content.filter((p) => p.type === 'toolCall').map((p) => p.id))
  assert.deepEqual(ids(r.messages), ids(messages)) // 工具调用 id 一个不少

  const results = r.messages.filter((m) => m.role === 'toolResult')
  assert.equal(results.length, 3)
  assert.equal(results[0].toolCallId, 'c1')
  assert.equal(results[0].isError, true) // 错误标记保留
  assert.equal(results[1].toolCallId, 'c2')
})

test('planCompaction：助手正文压缩、思考内容丢弃、参数与工具名保留', () => {
  // 三轮：R0 首轮（保留）、R1 被压、R2（保留最近 1 轮）
  const messages = [
    user('开始'),
    assistantCall('c0', 'list_devices', {}),
    toolResult('c0', 'list_devices', '设备列表'),
    user('继续'),
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'thinking-'.repeat(200) },
        { type: 'text', text: 'A'.repeat(1000) },
        { type: 'toolCall', id: 'c1', name: 'run_command', arguments: { cmd: 'display version' } }
      ],
      timestamp: 9
    },
    toolResult('c1', 'run_command', 'y'.repeat(2000)),
    user('再继续'),
    assistantText('好的')
  ]
  const r = planCompaction(messages, { maxChars: 100, keepRounds: 1 })
  assert.equal(r.applied, true)

  const a = r.messages[4]
  assert.equal(a.role, 'assistant')
  // 思考内容整段消失
  assert.equal(a.content.some((p) => p.type === 'thinking'), false)
  // 工具调用原样在（含 arguments）
  const call = a.content.find((p) => p.type === 'toolCall')
  assert.deepEqual(call.arguments, { cmd: 'display version' })
  // 正文被压成头 + 尾
  const text = a.content.find((p) => p.type === 'text').text
  assert.ok(text.length < 1000)
  assert.match(text, /已压缩/)
  // 对应工具结果被摘要化
  assert.match(r.messages[5].content[0].text, /\[已压缩\]/)
  // 首轮与最后一轮不动
  assert.equal(r.messages[2].content[0].text, '设备列表')
  assert.equal(r.messages[7].content[0].text, '好的')
  assert.deepEqual(
    r.tools.map((t) => t.name),
    ['run_command']
  )
  assert.equal(r.tools[0].count, 1)
})

test('planCompaction：反复压缩不会把小摘要再压坏（幂等）', () => {
  const messages = [...round(1, 4000), ...round(2, 4000), ...round(3, 4000)]
  const once = planCompaction(messages, { maxChars: 100, keepRounds: 1 })
  const twice = planCompaction(once.messages, { maxChars: 100, keepRounds: 1 })
  // 第二次应无可压缩（已是摘要），仍保持结构性不变
  assert.equal(twice.messages.length, once.messages.length)
  for (const m of twice.messages) assert.ok(m.role)
  assert.ok(once.afterChars <= once.beforeChars)
})

test('describeCompaction：说清压了多少、省了什么', () => {
  const messages = [...round(1, 4000), ...round(2, 4000), ...round(3, 4000)]
  const r = planCompaction(messages, { maxChars: 100, keepRounds: 1 })
  const s = describeCompaction(r)
  assert.match(s, /上下文接近上限/)
  assert.match(s, /run_command×1/)
  assert.match(s, /保持原文/)
})

// ————————————————————— 失败分类（打 pi 的判定器） —————————————————————

test('分类：限流 / 超时 / 5xx 判为可重试', () => {
  assert.equal(isRetryableFailure(synthError('429 Too Many Requests')), true)
  assert.equal(isRetryableFailure(synthError('rate limit exceeded')), true)
  assert.equal(isRetryableFailure(synthError('upstream overloaded')), true)
  assert.equal(isRetryableFailure(synthError('502 Bad Gateway')), true)
  assert.equal(isRetryableFailure(synthError('socket hang up')), true)
  assert.equal(isRetryableFailure(synthError('fetch failed')), true)
})

test('分类：额度耗尽/计费问题不算临时故障（不能被当成限流重试三次）', () => {
  assert.equal(isRetryableFailure(synthError('insufficient_quota')), false)
  assert.equal(isRetryableFailure(synthError('You exceeded your current quota, please check your billing')), false)
})

test('分类：确定性错误不重试', () => {
  assert.equal(isRetryableFailure(synthError('401 Unauthorized: invalid api key')), false)
  assert.equal(isRetryableFailure(synthError('model_not_found')), false)
  assert.equal(isRetryableFailure({ stopReason: 'stop' }), false)
  assert.equal(isRetryableFailure({ stopReason: 'error' }), false) // 没有 errorMessage
})

test('分类：上下文溢出可识别，且与限流区分开', () => {
  const overflow = synthError('prompt is too long: 260000 tokens > 200000 maximum')
  assert.equal(isOverflowFailure(overflow), true)
  assert.equal(isRetryableFailure(overflow), false) // 溢出不该按「临时故障」退避重试

  const openaiOverflow = synthError('This model’s maximum context length is 128000 tokens')
  assert.equal(isOverflowFailure(openaiOverflow), true)

  const throttled = synthError('429 rate limit exceeded')
  assert.equal(isOverflowFailure(throttled), false)

  // 静默溢出（z.ai 式）：请求成功但 input 已超窗口
  assert.equal(
    isOverflowFailure({ stopReason: 'stop', usage: { input: 300000, cacheRead: 0 } }, 200000),
    true
  )
})

test('explainFailure：给出「能不能再试、该改什么」而不是原文照搬', () => {
  assert.match(explainFailure(synthError('429 Too Many Requests')), /暂时失败/)
  assert.match(explainFailure(synthError('insufficient_quota')), /额度或计费/)
  assert.match(explainFailure(synthError('401 Unauthorized')), /密钥无效/)
  assert.match(explainFailure(synthError('404 model_not_found')), /端点或模型名不可用/)
  assert.match(
    explainFailure(synthError('prompt is too long: 260000 tokens > 200000 maximum'), 200000),
    /上下文已超模型窗口/
  )
  assert.equal(explainFailure(synthError('某种没见过的错误')), '某种没见过的错误')
})

// ————————————————————— 默认值契约 —————————————————————

test('默认设置：重试默认开、压缩默认开且预算合理', () => {
  assert.equal(DEFAULT_SETTINGS.retry.enabled, true)
  assert.equal(DEFAULT_SETTINGS.retry.maxRetries, 2)
  assert.equal(DEFAULT_SETTINGS.compaction.enabled, true)
  assert.equal(DEFAULT_SETTINGS.compaction.keepRounds, 4)
  assert.ok(DEFAULT_SETTINGS.compaction.toolResultMaxChars < DEFAULT_SETTINGS.compaction.transcriptMaxChars)
})
