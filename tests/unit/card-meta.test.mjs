import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CARD_META_MAX_CHARS,
  CHECK_CARD_LIMIT,
  DIFF_CARD_LIMIT,
  DIFF_PREVIEW_LINES,
  DEFAULT_SETTINGS,
  ReactRuntime,
  Type,
  buildStructuredView,
  cardMetaOf,
  checkExperiment,
  describeDiff,
  diffWithSnapshot,
  lineTotalOf,
  nodesToMessages
} from '../.build/harness.mjs'

/**
 * H（v2.14）：可回放卡片数据。
 *
 * 这一层最容易出的错是「看起来生效了，但回放时卡片凭空消失」—— 因为超上限是
 * **整块丢弃**。所以下面把两道边界都钉死：`cardMetaOf` 的三条兜底纪律
 * （不抛 / 有上限 / 缺省不落盘），以及两个工具投影器**自己先截断**。
 */

const ok = (data) => ({ ok: true, data, meta: { ms: 1, deviceId: 'd1' } })

// ————————————————————— cardMetaOf 的兜底 —————————————————————

test('v2.14 cardMetaOf：没声明投影的工具一律不落盘任何卡片数据', () => {
  assert.equal(cardMetaOf(undefined, {}, ok({ a: 1 })), undefined)
  assert.equal(cardMetaOf({ name: 'x' }, {}, ok({ a: 1 })), undefined)
})

test('v2.14 cardMetaOf：投影返回空值不落盘（undefined / null）', () => {
  assert.equal(cardMetaOf({ presentationMeta: () => undefined }, {}, ok({})), undefined)
  assert.equal(cardMetaOf({ presentationMeta: () => null }, {}, ok({})), undefined)
})

test('★ v2.14 cardMetaOf：投影器抛错只丢卡片数据，绝不把工具调用带下去', () => {
  const spec = {
    presentationMeta: () => {
      throw new Error('投影器写错了')
    }
  }
  assert.equal(cardMetaOf(spec, {}, ok({})), undefined)
})

test('★ v2.14 cardMetaOf：不可序列化 / 超上限一律**整块丢弃**（不是截半个对象）', () => {
  // 循环引用 → JSON.stringify 抛
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(cardMetaOf({ presentationMeta: () => cyclic }, {}, ok({})), undefined)

  // 正好在上限内 → 保留；超一点 → 丢弃
  const fit = { blob: 'x'.repeat(CARD_META_MAX_CHARS - 40) }
  assert.ok(JSON.stringify(fit).length <= CARD_META_MAX_CHARS)
  assert.deepEqual(cardMetaOf({ presentationMeta: () => fit }, {}, ok({})), fit)
  const over = { blob: 'x'.repeat(CARD_META_MAX_CHARS + 1) }
  assert.equal(cardMetaOf({ presentationMeta: () => over }, {}, ok({})), undefined)
})

test('v2.14 cardMetaOf：把 args 与 result 原样交给投影器', () => {
  const spec = {
    presentationMeta: (args, result) => ({ got: args, okFlag: result.ok })
  }
  assert.deepEqual(cardMetaOf(spec, { deviceId: 'd1' }, ok({})), {
    got: { deviceId: 'd1' },
    okFlag: true
  })
})

// ————————————————————— 两个工具的投影器 —————————————————————

/** 造一份 diff_with_snapshot 的结果 */
const diffResult = (added, removed, okFlag = true) => ({
  ok: okFlag,
  data: { snapshotId: 'snap-1', changed: added.length + removed.length > 0, added, removed },
  meta: { ms: 1, deviceId: 'd1' }
})

test('★ v2.14 diff_with_snapshot：大 diff **在投影里先截断**（超上限会整块丢卡片）', () => {
  const added = Array.from({ length: 500 }, (_, i) => `interface Vlanif${i}`)
  const removed = Array.from({ length: 300 }, (_, i) => `undo acl ${i}`)
  const meta = diffWithSnapshot.presentationMeta({ deviceId: 'd1' }, diffResult(added, removed))

  assert.equal(meta.deviceId, 'd1')
  assert.equal(meta.snapshotId, 'snap-1')
  assert.equal(meta.changed, true)
  assert.equal(meta.added.length, DIFF_CARD_LIMIT, '单侧只留前 N 行')
  assert.equal(meta.removed.length, DIFF_CARD_LIMIT)
  assert.equal(meta.addedTotal, 500, '必须带总数，否则用户以为就改了 40 行')
  assert.equal(meta.removedTotal, 300)
  assert.ok(
    JSON.stringify(meta).length <= CARD_META_MAX_CHARS,
    '投影后的体积必须在落盘上限内（否则 cardMetaOf 会整块丢掉）'
  )
})

test('v2.14 diff_with_snapshot：失败或无 data 时不产出卡片数据', () => {
  assert.equal(diffWithSnapshot.presentationMeta({ deviceId: 'd1' }, diffResult([], [], false)), undefined)
  assert.equal(
    diffWithSnapshot.presentationMeta({ deviceId: 'd1' }, { ok: true, meta: { ms: 1 } }),
    undefined
  )
})

test('★ v2.14 check_experiment：丢掉 evidence（最长的一块），保留判定要素', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    label: `第 ${i} 项`,
    kind: 'ping',
    deviceId: 'd1',
    ok: i % 3 === 0,
    status: i % 3 === 0 ? 'pass' : 'fail',
    evidence: 'E'.repeat(2000), // 回显明细：不该进卡片
    reason: i % 3 === 0 ? undefined : '未达成'
  }))
  const meta = checkExperiment.presentationMeta(
    {},
    ok({ total: 100, passed: 34, failed: 66, errors: 0, allPassed: false, items, summary: 'x' })
  )

  assert.equal(meta.total, 100)
  assert.equal(meta.passed, 34)
  assert.equal(meta.allPassed, false)
  assert.equal(meta.items.length, CHECK_CARD_LIMIT, '条目在投影里截断')
  assert.equal(meta.itemsTotal, 100, '带总数')
  assert.equal(
    meta.items.some((i) => 'evidence' in i),
    false,
    '★ evidence 必须被丢掉 —— 100 条 × 2000 字符会让整块卡片被上限丢弃'
  )
  assert.equal(meta.items[0].label, '第 0 项')
  assert.equal(meta.items[0].status, 'pass')
  assert.equal(meta.items[1].reason, '未达成')
  assert.ok(JSON.stringify(meta).length <= CARD_META_MAX_CHARS)
})

test('v2.14 check_experiment：失败或无 data 时不产出卡片数据', () => {
  assert.equal(checkExperiment.presentationMeta({}, { ok: false, meta: { ms: 1 } }), undefined)
})

// ————————————————————— 运行时接线 —————————————————————

/** 声明了卡片投影的工具 */
function cardTool(project) {
  return {
    name: 'diff_with_snapshot',
    description: 'stub',
    risk: 'read',
    scope: 'device',
    concurrencySafe: true,
    schema: Type.Object({ deviceId: Type.String() }, { additionalProperties: false }),
    summarize: () => '对比 d1',
    presentationMeta: project,
    handler: async () => ok({ changed: true, added: ['a'], removed: [] })
  }
}

/** 桩 LLM：一次工具调用后收尾；快照每次请求的 messages */
function scriptedOneTool(requests) {
  let n = 0
  const sink = () => (model, ctx) => {
    n += 1
    const idx = n
    requests.push({ messages: [...ctx.messages] })
    const call = { id: `c${idx}`, name: 'diff_with_snapshot', arguments: { deviceId: 'd1' } }
    const queue =
      idx === 1 ? [{ type: 'toolcall_end', toolCall: call }, { type: 'done' }] : [{ type: 'done' }]
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
          content: [{ type: 'text', text: '' }, ...(idx === 1 ? [{ type: 'toolCall', ...call }] : [])],
          api: 'openai-completions',
          provider: 'compat',
          model: 'stub',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: 1
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

async function drive(settings, tools) {
  const requests = []
  const runtime = new ReactRuntime(
    {
      tools,
      getSettings: () => settings,
      getSkills: () => [],
      getCustomInstructions: () => '',
      buildContext: () => ({})
    },
    { apiKey: 'k', buildLlm: scriptedOneTool(requests) }
  )
  const events = []
  for await (const ev of runtime.run({
    sessionId: 's-1',
    rootId: 's-1',
    text: '开始',
    signal: new AbortController().signal
  })) {
    events.push(ev)
  }
  return { events, requests }
}

test('★ v2.14 运行时：投影器的产物进 tool_end.cardMeta（回放据此还原卡片）', async () => {
  const { events } = await drive(structuredClone(DEFAULT_SETTINGS), [
    cardTool((args, result) => ({ deviceId: args.deviceId, changed: result.data.changed }))
  ])
  const end = events.find((e) => e.type === 'tool_end')
  assert.equal(end.ok, true)
  assert.deepEqual(end.cardMeta, { deviceId: 'd1', changed: true })
})

test('★ v2.14 运行时：投影器抛错时工具调用照常成功，只是没有卡片数据', async () => {
  const { events } = await drive(structuredClone(DEFAULT_SETTINGS), [
    cardTool(() => {
      throw new Error('投影器炸了')
    })
  ])
  const end = events.find((e) => e.type === 'tool_end')
  assert.equal(end.ok, true, '工具调用必须毫发无损')
  assert.equal('cardMeta' in end, false, '没有卡片数据就不该出现这个字段')
  assert.equal(end.summary, '对比 d1', '摘要照常')
})

test('v2.14 运行时：没声明投影的工具不会凭空多出 cardMeta 字段', async () => {
  const tool = { ...cardTool(() => ({ x: 1 })) }
  delete tool.presentationMeta
  const { events } = await drive(structuredClone(DEFAULT_SETTINGS), [tool])
  const end = events.find((e) => e.type === 'tool_end')
  assert.equal('cardMeta' in end, false)
})

// ————————————————————— 消费端：回放/历史里把卡还原出来 —————————————————————

/**
 * 造一个会话树里的 tool 节点（照 `SessionNode` 的形状）。
 * 这是**回放路径**的输入 —— 写进 jsonl、再读回来的那份。
 */
const toolNode = (cardMeta) => ({
  id: 'n-1',
  parentId: null,
  role: 'tool',
  content: 'diff_with_snapshot({"deviceId":"d1"})',
  createdAt: 1,
  toolCall: {
    callId: 'c1',
    name: 'diff_with_snapshot',
    args: { deviceId: 'd1' },
    ok: true,
    ms: 3,
    summary: '对比 d1：有变化',
    ...(cardMeta !== undefined ? { cardMeta } : {})
  }
})

test('★ v2.14 回放路径：nodesToMessages 必须把 cardMeta 带进消息（否则卡片不见）', () => {
  const cardMeta = { deviceId: 'd1', changed: true, added: ['a'], removed: [], addedTotal: 1, removedTotal: 0 }
  const [msg] = nodesToMessages([toolNode(cardMeta)])
  assert.equal(msg.kind, 'tool')
  assert.deepEqual(msg.cardMeta, cardMeta)
  // 没落过卡片数据的旧节点不能凭空多出这个字段
  const [old] = nodesToMessages([toolNode(undefined)])
  assert.equal('cardMeta' in old, false)
})

test('★ v2.14 回放路径：cardMeta 能直接喂给 buildStructuredView 还原出卡', () => {
  // 工具侧投影的真实产物（已截断 + 带总数）
  const cardMeta = diffWithSnapshot.presentationMeta(
    { deviceId: 'd1' },
    { ok: true, data: { snapshotId: 'snap-9', changed: true, added: ['x', 'y'], removed: [] }, meta: { ms: 1 } }
  )
  const view = buildStructuredView('diff_with_snapshot', cardMeta)
  assert.notEqual(view, null, '★ 回放必须能出卡 —— 这正是 cardMeta 存在的理由')
  assert.equal(view.deviceId, 'd1')
  assert.equal(view.snapshotId, 'snap-9')
  assert.deepEqual(view.added, ['x', 'y'])
})

test('★★ v2.14 计数按**总数**：不能把「改了 500 行」显示成「改了 40 行」', () => {
  const cardMeta = diffWithSnapshot.presentationMeta(
    { deviceId: 'd1' },
    { ok: true, data: { changed: true, added: Array.from({ length: 500 }, (_, i) => `l${i}`), removed: [] }, meta: { ms: 1 } }
  )
  assert.equal(cardMeta.added.length, DIFF_CARD_LIMIT, '前置：投影确实截断了')

  const view = buildStructuredView('diff_with_snapshot', cardMeta)
  assert.equal(view.addedTotal, 500, '总数必须被视图模型接住')
  assert.equal(
    describeDiff(view),
    '配置有变化：新增 500 行',
    '★ 卡头必须说 500 行（按数组长度会显示成 40，是个看起来很正常的错误数字）'
  )
  // 实时路径（未截断）没有 total 字段时，退回数组长度
  const live = buildStructuredView('diff_with_snapshot', { changed: true, added: ['a', 'b'], removed: [] })
  assert.equal(describeDiff(live), '配置有变化：新增 2 行')
})

test('v2.14 lineTotalOf：总数不可信时退回数组长度（总数小于实际行数 = 坏数据）', () => {
  assert.equal(lineTotalOf(['a', 'b'], 500), 500)
  assert.equal(lineTotalOf(['a', 'b'], 1), 2, '总数比数组还小 → 不采信')
  assert.equal(lineTotalOf(['a', 'b'], undefined), 2)
  assert.equal(lineTotalOf(['a', 'b'], Number.NaN), 2)
  assert.equal(lineTotalOf([], 0), 0)
})

test('v2.14 回放卡片：截断提示的阈值与投影上限一致（两处都改才算对齐）', () => {
  assert.equal(
    DIFF_CARD_LIMIT,
    DIFF_PREVIEW_LINES,
    '投影保留的行数应与卡片预览行数一致，否则「查看全部」展开后仍看不出差别'
  )
})
