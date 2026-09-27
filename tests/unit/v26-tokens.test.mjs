/**
 * v2.6：真实 token 计量 + 摘要式压缩（L3）。
 *
 * 这批用例守的是三类「出错时不会报错」的场景：
 *  1. **只读 `usage.input` 会低估上下文** —— pi 的 `input` 已经扣掉缓存命中部分，
 *     长会话里 cacheRead 往往占大头，漏掉它压缩就永远不触发，直到某次请求直接溢出；
 *  2. **摘要切点必须落在 user 消息边界** —— 切在轮中间会留下「有 toolCall 没有
 *     toolResult」的残骸，provider 直接 400；
 *  3. **摘要失败不能把任务带下去** —— 压缩是保护性动作，它自己失败要静默降级到本地修剪。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ReactRuntime,
  DEFAULT_SETTINGS,
  activeProfile,
  promptTokensOf,
  charsPerToken,
  estimatePromptTokens,
  measurePressure,
  perMessageBudget,
  renderSummaryBody,
  planSummaryCompaction,
  applySummary,
  describeSummaryCompaction,
  DEFAULT_CHARS_PER_TOKEN,
  CHARS_PER_TOKEN_BOUNDS,
  SUMMARY_BOUNDS,
  SUMMARY_MESSAGE_PREFIX,
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryUserMessage,
  sanitizeCompaction,
  COMPACTION_BOUNDS,
  planToolResultReprune,
  repruneBudgetOf,
  REPRUNE_MIN_CHARS,
  REPRUNE_MIN_SAVING,
  truncateToolResult,
  extractSpillPath,
  spillLocatorNotice,
  Type
} from '../.build/harness.mjs'

// ————————————————————— 真实 token 计量 —————————————————————

test('★ promptTokensOf：必须补上 cacheRead / cacheWrite（pi 的 input 已扣掉缓存命中部分）', () => {
  // 命中缓存时 input 会很小而 cacheRead 很大 —— 只读 input 会严重低估
  assert.equal(
    promptTokensOf({ input: 120, cacheRead: 8_000, cacheWrite: 400, output: 90 }),
    8_520
  )
  assert.equal(promptTokensOf({ input: 500 }), 500)
  assert.equal(promptTokensOf({ input: 500, output: 50 }), 500, 'output 不属于 prompt')
  // 只有 totalTokens 时反推
  assert.equal(promptTokensOf({ totalTokens: 1_000, output: 200 }), 800)
  assert.equal(promptTokensOf({ totalTokens: 0 }), null)
  // 拿不到就返回 null，让调用方退回字符估算 —— 不能用 0 冒充「零占用」
  assert.equal(promptTokensOf(undefined), null)
  assert.equal(promptTokensOf(null), null)
  assert.equal(promptTokensOf({}), null)
  // 脏值不能变成 NaN 传染给后面的压力计算
  assert.equal(promptTokensOf({ input: -5, cacheRead: Number.NaN, cacheWrite: 10 }), 10)
})

test('charsPerToken：有校准用校准，越界收敛回合理区间', () => {
  assert.equal(charsPerToken(null), DEFAULT_CHARS_PER_TOKEN)
  assert.equal(charsPerToken({ chars: 0, tokens: 100 }), DEFAULT_CHARS_PER_TOKEN)
  assert.equal(charsPerToken({ chars: 1000, tokens: 0 }), DEFAULT_CHARS_PER_TOKEN)
  // 实测 1000 字符 = 250 token → 4 字符/token
  assert.equal(charsPerToken({ chars: 1_000, tokens: 250 }), 4)
  // 脏测量（比例离谱）不能把估算带飞
  assert.equal(charsPerToken({ chars: 1_000, tokens: 1 }), CHARS_PER_TOKEN_BOUNDS.max)
  assert.equal(charsPerToken({ chars: 1_000, tokens: 900 }), CHARS_PER_TOKEN_BOUNDS.min)
})

test('estimatePromptTokens：无校准时用默认比，有校准则跟着校准走', () => {
  const raw = estimatePromptTokens({ chars: 3_200 })
  assert.equal(raw.tokens, Math.ceil(3_200 / DEFAULT_CHARS_PER_TOKEN))
  assert.equal(raw.calibrated, false)

  const cal = estimatePromptTokens({ chars: 3_200, calibration: { chars: 4_000, tokens: 1_000 } })
  assert.equal(cal.tokens, 800, '4 字符/token 时 3200 字符 = 800 token')
  assert.equal(cal.calibrated, true)
})

test('measurePressure：token 与字符双判据，任一越线即压缩', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(1_000), timestamp: 0 }]
  const base = {
    messages,
    systemPromptChars: 0,
    contextWindow: 10_000,
    pressureRatio: 0.5,
    maxChars: 1_000_000,
    calibration: null
  }
  const under = measurePressure(base)
  assert.equal(under.over, false)

  // token 越线（1000 字符 ≈ 313 token ≥ 5000 的一半）
  const byTokens = measurePressure({ ...base, pressureRatio: 0.02 })
  assert.equal(byTokens.overTokens, true)
  assert.equal(byTokens.over, true)
  assert.equal(byTokens.budgetTokens, 200)

  // 字符越线（token 判据还很宽松）
  const byChars = measurePressure({ ...base, maxChars: 100 })
  assert.equal(byChars.overTokens, false)
  assert.equal(byChars.overChars, true)
  assert.equal(byChars.over, true, '字符判据必须独立生效 —— 用户填错窗口时它是唯一防线')
})

test('sanitizeCompaction：新增的 pressureRatio / summarize 有边界且坏值回落', () => {
  assert.equal(sanitizeCompaction({}).pressureRatio, 0.75)
  assert.equal(sanitizeCompaction({}).summarize, true)
  assert.equal(sanitizeCompaction({ pressureRatio: 0.6 }).pressureRatio, 0.6)
  assert.equal(sanitizeCompaction({ pressureRatio: '0.8' }).pressureRatio, 0.8)
  // 越界一律收敛到上下界（不做百分数猜测 —— 「5」到底是 5 还是 5% 无从判断）
  assert.equal(sanitizeCompaction({ pressureRatio: 0.1 }).pressureRatio, COMPACTION_BOUNDS.pressureRatio.min)
  assert.equal(sanitizeCompaction({ pressureRatio: 5 }).pressureRatio, COMPACTION_BOUNDS.pressureRatio.max)
  assert.equal(sanitizeCompaction({ pressureRatio: 75 }).pressureRatio, COMPACTION_BOUNDS.pressureRatio.max)
  assert.equal(sanitizeCompaction({ pressureRatio: 'abc' }).pressureRatio, 0.75)
  assert.equal(sanitizeCompaction({ summarize: 'yes' }).summarize, true, '非布尔不得当成 false 静默关掉摘要')
  assert.equal(sanitizeCompaction({ summarize: false }).summarize, false)
})

// ————————————————————— 摘要切点与结构安全 —————————————————————

/** 造一段多轮消息：每轮 = user + assistant + toolResult（含配对） */
function multiRound(rounds) {
  const out = []
  for (let r = 0; r < rounds; r++) {
    const callId = `call-${r}`
    out.push({ role: 'user', content: `第 ${r} 轮指令`, timestamp: r })
    out.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `第 ${r} 轮说明` },
        { type: 'toolCall', id: callId, name: 'run_show_command', arguments: { deviceId: 'd1' } }
      ],
      timestamp: r
    })
    out.push({
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'run_show_command',
      content: [{ type: 'text', text: `第 ${r} 轮回显`.repeat(20) }],
      isError: false,
      timestamp: r
    })
  }
  return out
}

/** 结构校验：每个 toolCall 都必须有配对 toolResult，反之亦然 */
function assertPairingIntact(messages) {
  const calls = new Set()
  const results = new Set()
  for (const m of messages) {
    const content = m.content
    if (m.role === 'assistant' && Array.isArray(content)) {
      for (const p of content) if (p?.type === 'toolCall' && p.id) calls.add(p.id)
    }
    if (m.role === 'toolResult' && m.toolCallId) results.add(m.toolCallId)
  }
  for (const id of calls) assert.ok(results.has(id), `toolCall ${id} 没有配对的结果`)
  for (const id of results) assert.ok(calls.has(id), `toolResult ${id} 没有配对的调用`)
}

test('planSummaryCompaction：轮数不足保留窗口时不动手（防 undefined 下标那个反向 bug）', () => {
  const plan = planSummaryCompaction(multiRound(1), { keepRounds: 4 })
  assert.equal(plan.applied, false)
})

test('★ planSummaryCompaction：切点严格落在 user 消息边界，且首轮永不参与摘要', () => {
  const messages = multiRound(5)
  const plan = planSummaryCompaction(messages, { keepRounds: 2 })
  assert.equal(plan.applied, true)
  // 首轮（第 0 轮）是整个第一条 user 消息 —— 必须原样保留
  assert.ok(plan.segmentStart > 0, '摘要区间不能从首轮开始')
  assert.equal(messages[plan.segmentStart].role, 'user', '切点必须在 user 消息上')
  assert.equal(messages[plan.segmentEnd].role, 'user', '结束切点也必须在 user 消息上')
  // 5 轮、保留 2 轮 → 摘要掉中间的 2 轮
  assert.equal(plan.rounds, 2)
})

test('★ applySummary：替换后工具调用与结果的配对关系完好（provider 会因此 400）', () => {
  const messages = multiRound(5)
  const plan = planSummaryCompaction(messages, { keepRounds: 2 })
  const next = applySummary(messages, plan, '摘要正文', 999)
  assertPairingIntact(next)

  // 首轮原样保留
  assert.equal(next[0].content, messages[0].content)
  // 摘要消息是 user 角色（它是「给模型的上下文」，不是代理自己说的话），位置在切点上
  const digestIndex = next.findIndex((m) => String(m.content).startsWith(SUMMARY_MESSAGE_PREFIX))
  assert.equal(digestIndex, plan.segmentStart, '摘要应插在切点处')
  const digest = next[digestIndex]
  assert.equal(digest.role, 'user')
  assert.ok(digest.content.includes('摘要正文'))
  // 保留窗口的最后一条也在
  assert.equal(next[next.length - 1].content[0].text, messages[messages.length - 1].content[0].text)
  // 被摘要覆盖的原消息确实不在了
  assert.ok(!next.some((m) => m.content === messages[plan.segmentStart].content))
  // 确实变小了
  assert.ok(next.length < messages.length)
})

test('applySummary：空摘要 / 未应用的计划都原样返回，不产生半截替换', () => {
  const messages = multiRound(5)
  const plan = planSummaryCompaction(messages, { keepRounds: 2 })
  assert.deepEqual(applySummary(messages, plan, '   ', 1), [...messages])
  assert.deepEqual(applySummary(messages, { ...plan, applied: false }, '有内容', 1), [...messages])
})

test('renderSummaryBody：每条消息都露出一点（不丢最旧的轮次），长内容保头保尾', () => {
  const long = { role: 'toolResult', toolCallId: 'c1', toolName: 'run_show_command',
    content: [{ type: 'text', text: 'A'.repeat(5_000) + 'B'.repeat(5_000) }], timestamp: 0 }
  const body = renderSummaryBody([long], 1_000)
  assert.ok(body.includes('【工具结果 run_show_command】'))
  assert.ok(body.includes('省略'), '超长内容应有省略标记')
  assert.ok(body.startsWith('【工具结果 run_show_command】A'), '保头')
  assert.ok(body.trimEnd().endsWith('B'.repeat(10)), '保尾（结论通常在后半段）')

  const many = multiRound(4)
  const bounded = renderSummaryBody(many, 600)
  // 4 轮 × 3 条 = 12 条，每条都要有标签（预算按条数分配，不是砍掉最旧的）
  assert.equal((bounded.match(/【/g) || []).length, 12)
  assert.ok(bounded.length <= 600 + 12 * 40, `渲染结果应有界，实际 ${bounded.length}`)
})

test('perMessageBudget：按条数分配且落在合理区间内（条数再多也不能压成 0 字符）', () => {
  assert.equal(perMessageBudget(1, 60_000), SUMMARY_BOUNDS.perMessageChars.max)
  assert.equal(perMessageBudget(1_000_000, 60_000), SUMMARY_BOUNDS.perMessageChars.min)
  const mid = perMessageBudget(30, 60_000)
  assert.ok(mid >= SUMMARY_BOUNDS.perMessageChars.min && mid <= SUMMARY_BOUNDS.perMessageChars.max)
})

test('摘要提示词：必须明确要求保留具体值，且禁止编造', () => {
  // 摘要把 10.0.0.0/30 改写成「配置了相应网段」是这类功能最贵的失败
  for (const kw of ['掩码', 'VLAN', '接口名', '编造', '不要']) {
    assert.ok(SUMMARY_SYSTEM_PROMPT.includes(kw), `摘要指令缺少关键要求：${kw}`)
  }
  assert.ok(buildSummaryUserMessage('BODY').includes('BODY'))
})

test('describeSummaryCompaction：说清省了多少，不留「已压缩」这种没有信息量的话', () => {
  const text = describeSummaryCompaction({ rounds: 3, messageCount: 9, beforeChars: 1_000, afterChars: 250 })
  assert.ok(text.includes('3 轮'))
  assert.ok(text.includes('75%'))
})

// ————————————————————— 运行时：事件与整条流水线 —————————————————————

/**
 * 返回大回显的桩工具（模拟 `display current-configuration`：一条就能几十万字符）。
 * 用真工具而不是假的 toolResult 对象，是为了让「压缩只作用于给模型那一份」
 * 这条口径也走一遍真实路径。
 */
function bigEchoTool(size = 6_000) {
  // 每次调用的回显带序号，才能断言「到底哪一段被摘要掉了」
  let n = 0
  return {
    name: 'run_show_command',
    description: 'stub',
    risk: 'read',
    scope: 'device',
    concurrencySafe: true,
    schema: Type.Object({ deviceId: Type.String() }, { additionalProperties: false }),
    summarize: () => '读取大回显',
    handler: async () => {
      n += 1
      return {
        ok: true,
        data: { echo: `ECHO-${n}-` + 'E'.repeat(size) },
        meta: { ms: 1, deviceId: 'd1' }
      }
    }
  }
}

/**
 * 可编程桩 LLM：
 * - 摘要请求（systemPrompt === SUMMARY_SYSTEM_PROMPT）按 opts 回文本或抛错；
 * - 主请求前 `toolRounds` 次回一个工具调用，之后回纯 done。
 *
 * ⚠️ 摘要请求**可能是第一个请求**（压力检查在 round 0 取模型之前），
 * 所以判别依据必须是 systemPrompt，不能用「第几次调用」。
 */
function scriptedLlm(requests, opts = {}) {
  const toolRounds = opts.toolRounds ?? 3
  const summaryText = opts.summaryText ?? '设备 dev1 已配 VLAN 10，地址 10.0.0.1/24。'
  let mainCall = 0
  const sink = (via) => (model, ctx, callOpts) => {
    const isSummary = ctx.systemPrompt === SUMMARY_SYSTEM_PROMPT
    if (!isSummary) mainCall += 1
    const idx = mainCall
    // ⚠️ 必须快照 messages：ctx.messages 是**活数组**，压缩与后续 push 都会改它，
    // 事后读到的会是最新状态而不是「当时真的发出去的那一份」。
    requests.push({
      via,
      isSummary,
      opts: callOpts,
      systemPrompt: ctx.systemPrompt,
      tools: ctx.tools,
      messages: [...ctx.messages]
    })
    // 主请求的事件队列：工具轮必须先 toolcall_end 再 done ——
    // 少了 done 这一条，运行时认为「一个事件都没收到」直接判失败。
    const queue = isSummary
      ? [{ type: 'text_delta', delta: summaryText }]
      : idx <= toolRounds
        ? [
            {
              type: 'toolcall_end',
              toolCall: { id: `c${idx}`, name: 'run_show_command', arguments: { deviceId: 'd1' } }
            },
            { type: 'done' }
          ]
        : [{ type: 'done' }]
    const calls = idx <= toolRounds && !isSummary
      ? [{ type: 'toolCall', id: `c${idx}`, name: 'run_show_command', arguments: { deviceId: 'd1' } }]
      : []
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            // 摘要请求抛错要在**迭代时**抛（构造时抛会被上层 try/catch 当成同步异常，
            // 与真实的「请求进行到一半断掉」不是一回事）
            if (isSummary && opts.summaryThrows) throw new Error('摘要服务不可用')
            const ev = queue.shift()
            if (!ev) return { done: true, value: undefined }
            return { done: false, value: ev }
          }
        }
      },
      async result() {
        return {
          role: 'assistant',
          // 真实 provider 会把 toolCall 放进最终消息里（转录里必须成对）
          content: [{ type: 'text', text: '' }, ...calls],
          api: 'openai-completions',
          provider: 'compat',
          model: 'stub-model',
          usage: {
            input: 100,
            output: 40,
            cacheRead: opts.cacheRead ?? 0,
            cacheWrite: 0,
            totalTokens: 140 + (opts.cacheRead ?? 0),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
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
      stream: sink('stream'),
      streamSimple: sink('streamSimple')
    }
  })
}

function settingsWith(patch) {
  const base = structuredClone(DEFAULT_SETTINGS)
  const merged = { ...base, ...patch, agent: { ...base.agent, ...(patch.agent ?? {}) } }
  if (patch.compaction) merged.compaction = { ...base.compaction, ...patch.compaction }
  return merged
}

/** 跑一轮，返回事件与每次请求的记录 */
async function drive(settings, { tools = [], history = [], requests, stub, spill } = {}) {
  const runtime = new ReactRuntime(
    {
      tools,
      getSettings: () => settings,
      getSkills: () => [],
      getCustomInstructions: () => '',
      buildContext: () => ({}),
      // v2.14：溢出归档出口（缺省 = 不归档，行为与 v2.13 一致）
      ...(spill ? { spill } : {})
    },
    { apiKey: 'stub-key', buildLlm: scriptedLlm(requests, stub ?? {}) }
  )
  const events = []
  for await (const ev of runtime.run({
    sessionId: 's-1',
    // v2.14：归档要按会话分目录，运行时只在有 rootId 时才会去归档
    rootId: 's-1',
    text: '开始配置',
    signal: new AbortController().signal,
    history
  })) {
    events.push(ev)
  }
  return events
}

/** 单个任务的真实形态：**只有一条 user 消息**，其余全是工具往返 */
const SINGLE_TASK_COMPACTION = {
  transcriptMaxChars: 300,
  keepRounds: 1,
  summarize: true
}

test('★ usage 事件带真实计量（含缓存命中部分），而不是字符估算', async () => {
  const requests = []
  const settings = settingsWith({})
  const events = await drive(settings, { requests, stub: { cacheRead: 900, toolRounds: 0 } })
  const usage = events.find((e) => e.type === 'usage')
  assert.ok(usage, '每轮成功请求后都应下发 usage 事件')
  // input 100 + cacheRead 900 = 1000，且明确标为 measured
  assert.equal(usage.promptTokens, 1_000)
  assert.equal(usage.outputTokens, 40)
  assert.equal(usage.measured, true)
  assert.equal(usage.contextWindow, activeProfile(settingsWith({})).contextWindow)
  assert.ok(usage.ratio > 0 && usage.ratio < 1)
})

test('usage 事件：provider 不给 usage 时退回估算并标 measured=false（不能假装是真实值）', async () => {
  const settings = settingsWith({})
  const runtime = new ReactRuntime(
    {
      tools: [],
      getSettings: () => settings,
      getSkills: () => [],
      getCustomInstructions: () => '',
      buildContext: () => ({})
    },
    {
      apiKey: 'k',
      buildLlm: async (cfg) => ({
        provider: 'compat',
        modelId: cfg.model,
        models: {
          getModel: () => ({ id: cfg.model, contextWindow: 1_000, maxTokens: 100 }),
          stream: () => {
            let done = false
            return {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    if (done) return { done: true, value: undefined }
                    done = true
                    return { done: false, value: { type: 'done' } }
                  }
                }
              },
              async result() {
                // 没有 usage 字段
                return { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'stop' }
              }
            }
          }
        }
      })
    }
  )
  const events = []
  for await (const ev of runtime.run({
    sessionId: 's-1',
    text: 'x',
    signal: new AbortController().signal
  })) {
    events.push(ev)
  }
  const usage = events.find((e) => e.type === 'usage')
  assert.ok(usage)
  assert.equal(usage.measured, false)
  assert.ok(usage.promptTokens > 0, '估算值也必须给出，不能是 0')
})

test('★ 单任务长实验也能压缩：只有一条 user 消息时，工具往返同样构成可压缩的「轮」', async () => {
  // 这是 v2.6 修掉的既有 bug：原来按 user 消息切轮，单个任务里永远只有 1 轮，
  // planCompaction 因 starts.length < 2 每次直接返回 —— 长实验一次跑爆上下文时压缩完全失效。
  const requests = []
  const settings = settingsWith({ compaction: SINGLE_TASK_COMPACTION })
  const events = await drive(settings, { tools: [bigEchoTool()], requests, stub: { toolRounds: 3 } })

  const mainReqs = requests.filter((r) => !r.isSummary)
  // 压缩发生**之前**的每一次主请求，transcript 里都只有一条 user 消息 ——
  // 这正是旧实现（按 user 切轮）永远算不出 2 轮、压缩彻底失效的形态。
  const beforeCompaction = mainReqs.filter(
    (r) => !r.messages.some((m) => String(m.content).startsWith(SUMMARY_MESSAGE_PREFIX))
  )
  assert.ok(beforeCompaction.length >= 3, '压缩前应当已经跑了好几轮工具往返')
  for (const r of beforeCompaction) {
    assert.equal(
      r.messages.filter((m) => m.role === 'user').length,
      1,
      '单任务形态：从头到尾只有一条 user 消息'
    )
  }
  const compacts = events.filter((e) => e.type === 'compact')
  assert.ok(compacts.length > 0, '工具往返必须能被当成轮来压缩（否则长实验必爆上下文）')
})

test('★ 超预算时走摘要压缩：额外一次无工具请求，之后发给模型的上下文已变短且保护首轮', async () => {
  const requests = []
  const settings = settingsWith({ compaction: SINGLE_TASK_COMPACTION })
  const events = await drive(settings, { tools: [bigEchoTool()], requests, stub: { toolRounds: 3 } })

  const compacts = events.filter((e) => e.type === 'compact')
  const summaryStart = compacts.find((e) => e.mode === 'summary' && !e.summary)
  const summaryDone = compacts.find((e) => e.mode === 'summary' && e.summary)
  assert.ok(summaryStart, '摘要前应先告知「正在摘要」（这一步要等几秒）')
  assert.ok(summaryDone, '摘要完成后必须有结果事件')
  assert.ok(summaryDone.afterChars < summaryDone.beforeChars, '摘要必须真的把上下文压小')

  // 摘要请求本身：独立请求、不带工具、输出上限有界、走 system 指令
  const summaryReqs = requests.filter((r) => r.isSummary)
  assert.equal(summaryReqs.length, 1, '摘要只应发一次')
  assert.equal(summaryReqs[0].tools.length, 0, '摘要请求不能带工具，否则它可能又去调工具')
  assert.ok(summaryReqs[0].opts.maxTokens <= 4_000, '摘要输出上限必须有界')
  assert.equal(summaryReqs[0].via, 'stream', '摘要不走 streamSimple（不需要思考档位）')

  // 摘要之后的主请求：第一条仍是任务目标，紧随其后是摘要，且被压掉的原文不再出现
  const after = requests.filter((r) => !r.isSummary)
  const last = after[after.length - 1]
  assert.equal(last.messages[0].content, '开始配置', '首轮（任务目标）必须原样保留')
  const digestIndex = last.messages.findIndex((m) =>
    String(m.content).startsWith(SUMMARY_MESSAGE_PREFIX)
  )
  assert.ok(digestIndex > 0, '摘要必须真的写入上下文')
  assert.ok(digestIndex < last.messages.length - 1, '摘要之后必须还有原样保留的最近轮次')

  // 精确到「哪一段」：首轮（ECHO-1）与最近一轮（ECHO-3）保留原文，中间那段（ECHO-2）被摘要掉
  const flat = JSON.stringify(last.messages)
  assert.ok(flat.includes('ECHO-1-'), '首轮的工具回显必须保留')
  assert.ok(flat.includes('ECHO-3-'), '最近一轮的工具回显必须保留')
  assert.ok(!flat.includes('ECHO-2-'), '被摘要掉的工具回显不能留在上下文里')
  assert.ok(
    last.messages.length < 7,
    `压缩后条数应少于未压缩时的 7 条，实际 ${last.messages.length}`
  )
  // 会话/界面侧的完整原始记录不受影响（摘要只作用于给模型那一份）
  assert.ok(
    events.some((e) => e.type === 'tool_end'),
    '工具事件照常下发'
  )
})

test('★ 关掉「用模型生成摘要」后退回本地修剪（不再发摘要请求）', async () => {
  const requests = []
  const settings = settingsWith({
    compaction: { ...SINGLE_TASK_COMPACTION, summarize: false }
  })
  const events = await drive(settings, { tools: [bigEchoTool()], requests, stub: { toolRounds: 3 } })
  assert.equal(requests.filter((r) => r.isSummary).length, 0)
  const compacts = events.filter((e) => e.type === 'compact')
  assert.ok(compacts.length > 0, '仍然要压缩，只是换成修剪模式')
  assert.ok(compacts.every((e) => e.mode === 'trim'))
  assert.ok(compacts.some((e) => e.detail.includes('[已压缩]') || e.shrunkMessages > 0))
})

test('★ 摘要失败必须静默降级到本地修剪，不能把任务带下去', async () => {
  const requests = []
  const settings = settingsWith({ compaction: SINGLE_TASK_COMPACTION })
  const events = await drive(settings, {
    tools: [bigEchoTool()],
    requests,
    stub: { toolRounds: 3, summaryThrows: true }
  })
  // 任务照常收尾
  const done = events.find((e) => e.type === 'done')
  assert.ok(done, '摘要挂了也必须正常收尾')
  assert.equal(done.reason, 'completed')

  const compacts = events.filter((e) => e.type === 'compact')
  assert.ok(compacts.some((e) => e.mode === 'summary' && !e.summary), '应能看到「开始摘要」')
  assert.ok(
    compacts.some((e) => e.mode === 'trim'),
    '摘要失败后必须由本地修剪接手'
  )
  assert.ok(
    !compacts.some((e) => e.mode === 'summary' && e.summary),
    '失败的摘要不能产出摘要结果事件'
  )
})

test('★ 转录与界面分离：被摘要掉的原文只影响给模型那一份，界面上的 tool_end 仍是完整回显', async () => {
  const requests = []
  const settings = settingsWith({ compaction: SINGLE_TASK_COMPACTION })
  const events = await drive(settings, { tools: [bigEchoTool()], requests, stub: { toolRounds: 3 } })
  const ends = events.filter((e) => e.type === 'tool_end')
  assert.ok(ends.length >= 3)
  // 界面事件不因压缩而变小（压缩只作用于 messages）
  assert.ok(ends.every((e) => typeof e.ms === 'number'))
  const usageEvents = events.filter((e) => e.type === 'usage')
  assert.equal(usageEvents.length, requests.filter((r) => !r.isSummary).length)
})

// ————————— v2.14：L1.5 已归档结果的重剪（E） —————————

/** 造一条 toolResult 消息 */
function trMsg(id, text) {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'run_show_command',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1
  }
}
/** 造一条 assistant 消息（只需 content，估算只读它） */
function asstMsg(text) {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp: 1 }
}

/**
 * 造一段「已归档」的 payload：模拟 `modelPayloadFor` 在超预算时产出的
 * head + 定位符 + tail（定位符在**中段**，这正是重剪最容易把它切掉的位置）。
 */
function archivedPayload(path, big = 3000) {
  const raw = 'R'.repeat(big)
  return truncateToolResult(raw, big - 800, (info) =>
    spillLocatorNotice(path, raw.length, info.omittedChars)
  ).text
}

/**
 * 造一个「首轮 + N 个工具轮」的 transcript（`payloads[i]` 是第 i+1 个工具轮的结果文本）。
 *
 * 为什么需要它：`roundStarts` 的轮起点是「user 消息」或「紧跟 toolResult 之后的 assistant」，
 * 所以 **1 个工具轮根本算不出 2 个轮起点**（压缩与重剪都会直接 noop）。用 4 个工具轮时，
 * `keepRounds: 1` 的重剪窗口恰好是下标 [3,7) —— 也就是 `trMsg#2`（下标 4）与
 * `trMsg#3`（下标 6）落在窗口内，`trMsg#4`（下标 8）在窗口外。
 * 下面几条用例都按这个对齐关系来断言，改动 scaffold 必须同步改断言。
 */
function scaffold(payloads) {
  const msgs = [{ role: 'user', content: '开始配置', timestamp: 1 }]
  payloads.forEach((text, i) => {
    msgs.push(asstMsg(`a${i + 1}`), trMsg(`c${i + 1}`, text))
  })
  return msgs
}

test('v2.14 repruneBudgetOf：按插入预算取比例，且有下限', () => {
  assert.equal(repruneBudgetOf(12000), 3000, '默认 12000 的 1/4')
  assert.equal(repruneBudgetOf(1000), REPRUNE_MIN_CHARS, '小预算不得低于下限')
  assert.equal(repruneBudgetOf(0), REPRUNE_MIN_CHARS)
})

test('★ v2.14 重剪只动**已归档**的旧结果 —— 没归档过的一律不碰', () => {
  const PATH = '/data/attachments/spills/s-x/c1.txt'
  const archived = archivedPayload(PATH)
  const neverArchived = JSON.stringify({ ok: true, data: { clean: 'N'.repeat(5000) } })
  assert.equal(extractSpillPath(archived), PATH, '前置：归档过的 payload 必须能认出路径')
  assert.equal(extractSpillPath(neverArchived), null, '前置：没归档过的认不出来')

  // trMsg#2 = 已归档（窗口内）｜trMsg#3 = 没归档过（窗口内）｜trMsg#4 = 已归档（窗口外）
  const messages = scaffold(['small', archived, neverArchived, archivedPayload('/data/spills/c4.txt')])
  const plan = planToolResultReprune(messages, { maxChars: 300, keepRounds: 1 })
  assert.equal(plan.applied, true)
  assert.equal(plan.shrunkMessages, 1, '窗口内只有那一条归档过的')

  const after = plan.messages
  assert.ok(after[4].content[0].text.length < archived.length, '归档过的那条被压小了')
  assert.equal(after[6].content[0].text, neverArchived, '没归档过的**一个字符都不能动**（重剪会真丢数据）')
  assert.equal(after[8].content[0].text, messages[8].content[0].text, '保留窗口内的不动')
  assert.ok(plan.savedChars > 0)
})

test('★ v2.14 重剪必须重新挂上定位符（否则「中段可回取」在首次压缩后静默失效）', () => {
  const PATH = '/data/attachments/spills/s-root/c9.txt'
  const messages = scaffold(['small', archivedPayload(PATH), 'small', 'small'])
  const plan = planToolResultReprune(messages, { maxChars: 300, keepRounds: 1 })
  assert.equal(plan.applied, true)
  const text = plan.messages[4].content[0].text
  assert.equal(extractSpillPath(text), PATH, '重剪后仍要认得出归档路径')
  assert.ok(text.includes('压缩时又省略'), '文案要说清这是**又**省了一次')
  assert.equal(text.includes('重新获取'), false, '既然归档在，就不能让模型重跑命令')
})

test('v2.14 重剪在实践中幂等：收敛后不再改动（避免每次都改消息导致缓存失效）', () => {
  const messages = scaffold(['small', archivedPayload('/data/spills/c1.txt'), 'small', 'small'])
  const first = planToolResultReprune(messages, { maxChars: 300, keepRounds: 1 })
  assert.equal(first.applied, true, '前置：第一次必须真的剪了')
  const second = planToolResultReprune(first.messages, { maxChars: 300, keepRounds: 1 })
  assert.equal(second.applied, false, `第二次应无可观收益（门槛 ${REPRUNE_MIN_SAVING}）`)
})

test('v2.14 重剪：轮数不足 / 无归档 / 预算为 0 时都不动', () => {
  const archived = archivedPayload('/data/spills/c1.txt')
  // 只有 1 个工具轮 → 算不出 2 个轮起点
  assert.equal(planToolResultReprune(scaffold(['x']), { maxChars: 300, keepRounds: 1 }).applied, false)
  // 窗口内那条从没归档过
  assert.equal(
    planToolResultReprune(scaffold(['x', 'Z'.repeat(5000), 'x', 'x']), {
      maxChars: 300,
      keepRounds: 1
    }).applied,
    false
  )
  // 预算为 0 = 关闭
  assert.equal(
    planToolResultReprune(scaffold(['x', archived, 'x', 'x']), { maxChars: 0, keepRounds: 1 }).applied,
    false
  )
})

test('★★ v2.14 端到端：有归档时**少花**摘要请求（零成本重剪先降压）', async () => {
  /**
   * 参数不是随手挑的 —— 是拿探针把整个参数空间跑了一遍后的结论（见本节末的说明）：
   * 收益只在**「transcript 预算相对已归档体积偏紧」**时明显。取
   * `toolResultMaxChars: 12000`（默认）+ `keepRounds: 8`（默认）+ `transcriptMaxChars: 200000`
   * + 60 个工具轮，实测「无归档 6 次摘要 vs 有归档 1 次」。
   *
   * ⚠️ 不要在**默认** `transcriptMaxChars: 800000` 下断言这条 —— 那时实测差值是 0~1，
   * 断言会偶发失败。默认档下 E 的收益接近于零，这是探针量出来的事实，不是用例的问题。
   */
  const compaction = {
    enabled: true,
    toolResultMaxChars: 12000,
    transcriptMaxChars: 200000,
    keepRounds: 8,
    pressureRatio: 0.75,
    summarize: true
  }
  /** 跑同一条实验；`withSpill` 决定结果里有没有归档定位符（= 能不能被重剪） */
  const run = async (withSpill) => {
    const requests = []
    const events = await drive(settingsWith({ compaction }), {
      tools: [bigEchoTool(20000)],
      requests,
      stub: { toolRounds: 60 },
      ...(withSpill
        ? { spill: async () => '/fake/attachments/spills/s-1/c1.txt' }
        : {})
    })
    return { requests, events }
  }

  const withSpill = await run(true)
  const without = await run(false)
  const summariesOf = (r) => r.requests.filter((x) => x.isSummary).length

  assert.ok(summariesOf(without) > 0, '前置：不归档时只能靠摘要降压')
  assert.ok(
    summariesOf(withSpill) < summariesOf(without),
    `★ 归档 + 重剪应少花摘要请求（有归档 ${summariesOf(withSpill)} < 无归档 ${summariesOf(without)}）`
  )
  const trims = withSpill.events.filter((e) => e.type === 'compact' && e.mode === 'trim')
  assert.ok(
    trims.some((e) => e.detail.includes('已归档')),
    '界面要看得见「动的是已归档的结果」'
  )
  const last = withSpill.requests.filter((r) => !r.isSummary).pop()
  assert.ok(
    JSON.stringify(last.messages).includes('/fake/attachments/spills/'),
    '定位符必须留在上下文里（中段仍可回取）'
  )
})

