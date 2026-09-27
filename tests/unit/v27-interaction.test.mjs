/**
 * v2.7：轮内交互 —— 结构化提问 / 任务清单 / 计划模式。
 *
 * 这批用例守的是三条「出错就出事」的线：
 *  1. **计划模式的只读性**：批准之前绝不能有写操作落到设备上（判定在纯函数里，不靠提示词）；
 *  2. **提问挂起不会挂死**：取消 / 中止都必须让 await 立刻返回，否则整轮任务永远卡住；
 *  3. **清单按会话分桶**：串桶会让模型把另一段对话的任务当成自己的，界面上看不出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ReactRuntime,
  DEFAULT_SETTINGS,
  Type,
  sanitizeQuestions,
  sanitizeAnswers,
  unansweredQuestions,
  sanitizeTodos,
  todoProgress,
  formatTodos,
  buildTodoPromptBlock,
  planModeToolDecision,
  PLAN_MODE_BLOCK_CODE,
  PLAN_REVIEW_QUESTION_ID,
  PLAN_APPROVE,
  PLAN_STOP,
  buildPlanReviewOptions,
  PLAN_MODE_PROMPT_BLOCK,
  TodoStore,
  MAX_QUESTIONS_PER_REQUEST,
  MAX_QUESTION_OPTIONS,
  MAX_TODOS,
  SUMMARY_SYSTEM_PROMPT,
  TOOLS
} from '../.build/harness.mjs'

/**
 * 取**真实**工具定义。这三个功能的关键行为（提问挂起、清单落盘、计划模式拦截）
 * 都长在真实 handler 与运行时的交界处 —— 用桩工具会把要测的那一段直接绕过去，
 * 用例会「通过」但什么都没验证。
 */
const realTool = (name) => {
  const t = TOOLS.find((x) => x.name === name)
  assert.ok(t, `工具不存在：${name}`)
  return t
}

// ————————————————————— 提问结构 —————————————————————

test('sanitizeQuestions：合法提问原样通过，id 缺省时补一个', () => {
  const r = sanitizeQuestions([
    { question: '用哪个网段？', header: '网段', options: [{ label: '10.0.0.0/30' }, { label: '192.168.1.0/24' }] }
  ])
  assert.equal(r.ok, true)
  assert.equal(r.questions[0].id, 'q1')
  assert.equal(r.questions[0].options.length, 2)
  assert.equal(r.questions[0].header, '网段')
})

test('★ sanitizeQuestions：结构不对必须报错，不能悄悄修补（模型会以为用户看到了别的问题）', () => {
  assert.equal(sanitizeQuestions(undefined).ok, false)
  assert.equal(sanitizeQuestions([]).ok, false)
  assert.equal(sanitizeQuestions([{ question: '' }]).ok, false, '没有问题文本')
  assert.equal(
    sanitizeQuestions([{ question: 'x', id: 'a' }, { question: 'y', id: 'a' }]).ok,
    false,
    'id 重复会让答案对不上问题'
  )
  assert.equal(
    sanitizeQuestions([{ question: 'x', options: [{ label: '只有一个' }] }]).ok,
    false,
    '只有一个选项等于没得选 —— 那是个伪问题'
  )
  const tooMany = Array.from({ length: MAX_QUESTIONS_PER_REQUEST + 1 }, (_, i) => ({
    question: `q${i}`
  }))
  assert.equal(sanitizeQuestions(tooMany).ok, false)
  const tooManyOpts = {
    question: 'x',
    options: Array.from({ length: MAX_QUESTION_OPTIONS + 1 }, (_, i) => ({ label: `o${i}` }))
  }
  assert.equal(sanitizeQuestions([tooManyOpts]).ok, false)
})

test('sanitizeQuestions：options 为空数组 = 纯自由文本问题（合法）', () => {
  const r = sanitizeQuestions([{ question: '请描述现场', options: [] }])
  assert.equal(r.ok, true)
  assert.deepEqual(r.questions[0].options, [])
})

test('multiSelect 只有严格 true 才算多选', () => {
  const r = sanitizeQuestions([
    { question: 'x', multiSelect: 'yes', options: [{ label: 'a' }, { label: 'b' }] }
  ])
  assert.equal(r.ok, true)
  assert.equal(r.questions[0].multiSelect, undefined)
})

test('sanitizeAnswers：只留问过的问题，空答案丢弃', () => {
  const qs = sanitizeQuestions([{ question: 'a', id: 'a' }, { question: 'b', id: 'b' }]).questions
  const a = sanitizeAnswers({ a: '  答案  ', b: '', 未问过的: 'x' }, qs)
  assert.deepEqual(a, { a: '答案' })
  assert.deepEqual(unansweredQuestions(a, qs), ['b'])
})

// ————————————————————— 任务清单 —————————————————————

test('sanitizeTodos：整表清洗 —— 空内容丢弃、状态非法回落 pending、超量截断', () => {
  const out = sanitizeTodos([
    { content: '  在 SW1 上建 VLAN 10  ', status: 'completed', deviceId: 'sw1' },
    { content: '', status: 'completed' },
    { content: '跑验证', status: '乱写' },
    { content: '没有状态' }
  ])
  assert.equal(out.length, 3)
  assert.equal(out[0].content, '在 SW1 上建 VLAN 10')
  assert.equal(out[0].status, 'completed')
  assert.equal(out[0].deviceId, 'sw1')
  assert.equal(out[2].status, 'pending')
  assert.equal(out[2].deviceId, undefined)

  const many = Array.from({ length: MAX_TODOS + 10 }, (_, i) => ({ content: `t${i}` }))
  assert.equal(sanitizeTodos(many).length, MAX_TODOS)
  assert.deepEqual(sanitizeTodos(null), [])
})

test('todoProgress / formatTodos：进度统计与给模型看的清单文本', () => {
  const todos = sanitizeTodos([
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'in_progress', deviceId: 'r1' },
    { content: 'C', status: 'pending' }
  ])
  const p = todoProgress(todos)
  assert.deepEqual([p.total, p.completed, p.inProgress, p.pending], [3, 1, 1, 1])
  assert.equal(p.ratio, 1 / 3)
  assert.equal(todoProgress([]).ratio, 0, '空清单不能除零')

  const text = formatTodos(todos)
  assert.match(text, /\[x\] A/)
  assert.match(text, /\[~\] B（r1）/)
  assert.match(text, /\[ \] C/)
  assert.equal(formatTodos([]), '')
})

test('buildTodoPromptBlock：空清单不加块（不往 system prompt 里塞空标题）', () => {
  assert.equal(buildTodoPromptBlock([]), '')
  const block = buildTodoPromptBlock(sanitizeTodos([{ content: 'A', status: 'pending' }]))
  assert.match(block, /当前任务清单/)
  assert.match(block, /todo_write/)
})

// ————————————————————— 计划模式（硬约束） —————————————————————

test('★ planModeToolDecision：计划模式下写操作一律拒绝（不依赖提示词）', () => {
  assert.equal(planModeToolDecision({ planMode: true, risk: 'write', toolName: 'apply_config' }).kind, 'block')
  assert.equal(planModeToolDecision({ planMode: true, risk: 'danger', toolName: 'save_configuration' }).kind, 'block')
  const blocked = planModeToolDecision({ planMode: true, risk: 'write', toolName: 'apply_config' })
  assert.equal(blocked.code, PLAN_MODE_BLOCK_CODE)
  assert.match(blocked.reason, /apply_config/)
  // 关掉计划模式就全放行
  assert.equal(planModeToolDecision({ planMode: false, risk: 'write', toolName: 'apply_config' }).kind, 'allow')
  assert.equal(planModeToolDecision({ planMode: false, risk: 'danger', toolName: 'x' }).kind, 'allow')
})

test('planModeToolDecision：只读工具放行 —— 探索本来就要连设备、看配置、存快照', () => {
  for (const name of ['run_show_command', 'get_device_context', 'connect_device', 'save_config_snapshot']) {
    assert.equal(planModeToolDecision({ planMode: true, risk: 'read', toolName: name }).kind, 'allow')
  }
})

test('方案评审选项：三个选项与常量一一对应，且顺序固定（界面按钮即协议）', () => {
  const labels = buildPlanReviewOptions().map((o) => o.label)
  assert.equal(labels.length, 3)
  assert.equal(labels[0], PLAN_APPROVE)
  assert.ok(labels.includes(PLAN_STOP))
  for (const o of buildPlanReviewOptions()) assert.ok(o.description.length > 0)
})

test('计划模式提示词块存在且说明了只读边界（提示词不是保险，但要给对预期）', () => {
  assert.match(PLAN_MODE_PROMPT_BLOCK, /计划模式/)
  assert.match(PLAN_MODE_PROMPT_BLOCK, /PLAN_MODE_READONLY/)
})

// ————————————————————— 清单存储 —————————————————————

test('★ TodoStore：按会话根 ID 分桶 —— 串桶会让模型把别人的任务当成自己的', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-store-'))
  const file = path.join(dir, 'todos.json')
  try {
    const store = new TodoStore(file)
    store.set('s-aaaaaaaa', [{ content: '会话 A 的任务', status: 'pending' }])
    store.set('s-bbbbbbbb', [{ content: '会话 B 的任务', status: 'completed' }])
    assert.equal(store.get('s-aaaaaaaa')[0].content, '会话 A 的任务')
    assert.equal(store.get('s-bbbbbbbb')[0].content, '会话 B 的任务')
    assert.deepEqual(store.get('s-cccccccc'), [])

    // 整表替换（不是增量）
    store.set('s-aaaaaaaa', [{ content: '只剩这一条', status: 'in_progress' }])
    assert.equal(store.get('s-aaaaaaaa').length, 1)

    // 空数组 = 清空
    store.set('s-aaaaaaaa', [])
    assert.deepEqual(store.get('s-aaaaaaaa'), [])

    // 重开后仍在（持久化）
    const reopened = new TodoStore(file)
    assert.equal(reopened.get('s-bbbbbbbb')[0].content, '会话 B 的任务')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('TodoStore：返回的是副本，调用方改不动内部状态', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-copy-'))
  const file = path.join(dir, 'todos.json')
  try {
    const store = new TodoStore(file)
    store.set('s-1', [{ content: 'A', status: 'pending' }])
    store.get('s-1')[0].content = '被改掉了'
    assert.equal(store.get('s-1')[0].content, 'A')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('TodoStore：文件被写坏时退回空表，不抛（启动不能被清单拖死）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-broken-'))
  const file = path.join(dir, 'todos.json')
  try {
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf8')
    const store = new TodoStore(file)
    assert.deepEqual(store.get('anything'), [])
    // 坏文件之后仍能正常写入
    store.set('s-1', [{ content: 'A', status: 'pending' }])
    assert.equal(store.get('s-1').length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ————————————————————— 运行时：提问挂起与计划模式 —————————————————————

/** 可编程桩：主请求按脚本回事件；摘要请求回文本 */
function scriptedLlm(requests, opts = {}) {
  let plan = opts.script ?? [[{ type: 'done' }]]
  let mainCall = 0
  const sink = (via) => (model, ctx, callOpts) => {
    const isSummary = ctx.systemPrompt === SUMMARY_SYSTEM_PROMPT
    const isPlanReview = false
    if (!isSummary) mainCall += 1
    requests.push({
      via,
      isSummary,
      isPlanReview,
      opts: callOpts,
      systemPrompt: ctx.systemPrompt,
      tools: ctx.tools,
      messages: [...ctx.messages]
    })
    const events = isSummary
      ? [{ type: 'text_delta', delta: '摘要' }]
      : plan[Math.min(mainCall - 1, plan.length - 1)] ?? [{ type: 'done' }]
    const queue = [...events]
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const ev = queue.shift()
            if (!ev) return { done: true, value: undefined }
            return { done: false, value: ev }
          }
        }
      },
      async result() {
        const calls = events
          .filter((e) => e.type === 'toolcall_end')
          .map((e) => ({ type: 'toolCall', id: e.toolCall.id, name: e.toolCall.name, arguments: e.toolCall.arguments }))
        const text = events
          .filter((e) => e.type === 'text_delta')
          .map((e) => e.delta)
          .join('')
        return {
          role: 'assistant',
          content: [{ type: 'text', text }, ...calls],
          usage: {
            input: 10,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 11,
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

function settingsWith(patch = {}) {
  const base = structuredClone(DEFAULT_SETTINGS)
  const merged = { ...base, ...patch, agent: { ...base.agent, ...(patch.agent ?? {}) } }
  if (patch.compaction) merged.compaction = { ...base.compaction, ...patch.compaction }
  return merged
}

function mkTool(name, risk, result = { ok: true, data: {}, meta: { ms: 1 } }) {
  return {
    name,
    description: 'stub',
    risk,
    scope: 'local',
    schema: Type.Object({}, { additionalProperties: false }),
    summarize: () => name,
    handler: async () => result
  }
}

/**
 * 跑一轮并在需要时替用户作答。
 * `answer` 收到 question_request 事件后调用，返回答案（null = 取消）。
 */
async function drive(settings, { requests, tools = [], script, rootId, planMode, onQuestion, todos } = {}) {
  const runtime = new ReactRuntime(
    {
      tools,
      getSettings: () => settings,
      getSkills: () => [],
      getCustomInstructions: () => '',
      buildContext: () => ({}),
      ...(todos ? { todos } : {})
    },
    { apiKey: 'k', buildLlm: scriptedLlm(requests, { script }) }
  )
  const events = []
  const iter = runtime.run({
    sessionId: 'main',
    text: '开始',
    signal: new AbortController().signal,
    ...(rootId ? { rootId } : {}),
    ...(planMode ? { planMode: true } : {})
  })
  for await (const ev of iter) {
    events.push(ev)
    if (ev.type === 'question_request' && onQuestion) {
      const answers = await onQuestion(ev)
      // 模拟界面回传（真实路径是 IPC → services.resolveQuestion）
      runtime.resolveQuestion(ev.questionId, answers)
    }
  }
  return events
}

test('★ ask_user_question：发出 question_request 后暂停，收到答案才继续', async () => {
  const requests = []
  const settings = settingsWith()
  const askTool = realTool('ask_user_question')
  // 第一次调用工具，第二次结束
  const script = [
    [
      {
        type: 'toolcall_end',
        toolCall: { id: 'c1', name: 'ask_user_question', arguments: { questions: [{ id: 'mask', question: '?' }] } }
      },
      { type: 'done' }
    ],
    [{ type: 'done' }]
  ]
  const events = await drive(settings, {
    requests,
    tools: [askTool],
    script,
    onQuestion: (ev) => {
      assert.equal(ev.source, 'tool')
      assert.equal(ev.questions[0].id, 'mask')
      return { mask: '10.0.0.0/30' }
    }
  })
  const asked = events.filter((e) => e.type === 'question_request')
  const resolved = events.filter((e) => e.type === 'question_resolved')
  assert.equal(asked.length, 1)
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].cancelled, undefined)
  assert.deepEqual(resolved[0].answers, { mask: '10.0.0.0/30' })
  assert.equal(resolved[0].source, 'tool')
  assert.equal(events.find((e) => e.type === 'done').reason, 'completed')

  // 工具结果里必须带着答案回到模型（否则模型问了等于白问）
  const after = requests.filter((r) => !r.isSummary)
  const lastMsgs = after[after.length - 1].messages.map((m) => JSON.stringify(m)).join('\n')
  assert.match(lastMsgs, /10\.0\.0\.0\/30/)
})

test('★ ask_user_question：坏参数直接失败，不会弹出卡片（结构不对就不该打扰用户）', async () => {
  const requests = []
  const script = [
    [
      {
        type: 'toolcall_end',
        toolCall: {
          id: 'c1',
          name: 'ask_user_question',
          // 只有一个选项 = 伪问题
          arguments: { questions: [{ id: 'a', question: '?' , options: [{ label: '唯一' }] }] }
        }
      },
      { type: 'done' }
    ],
    [{ type: 'done' }]
  ]
  const events = await drive(settingsWith(), {
    requests,
    tools: [realTool('ask_user_question')],
    script,
    onQuestion: () => {
      throw new Error('不该弹卡片')
    }
  })
  assert.equal(events.filter((e) => e.type === 'question_request').length, 0)
  const end = events.find((e) => e.type === 'tool_end')
  assert.equal(end.ok, false)
  assert.equal(end.errorCode, 'BAD_PARAM')
})

test('★ 提问取消（null）必须立刻解除挂起，任务照常收尾而不是卡死', async () => {
  const requests = []
  const settings = settingsWith()
  const script = [
    [
      {
        type: 'toolcall_end',
        toolCall: { id: 'c1', name: 'ask_user_question', arguments: { questions: [{ id: 'a', question: '?' }] } }
      },
      { type: 'done' }
    ],
    [{ type: 'done' }]
  ]
  const events = await drive(settings, {
    requests,
    tools: [realTool('ask_user_question')],
    script,
    onQuestion: () => null
  })
  const resolved = events.find((e) => e.type === 'question_resolved')
  assert.equal(resolved.cancelled, true)
  assert.deepEqual(resolved.answers, {})
  assert.equal(events.find((e) => e.type === 'done').reason, 'completed')
  // 取消要让模型知道「这条路走不通」，而不是收到一个空答案对象
  const end = events.find((e) => e.type === 'tool_end')
  assert.equal(end.ok, false)
  assert.equal(end.errorCode, 'QUESTION_CANCELLED')
})

test('★ 计划模式：写操作被拦在 handler 之前，工具根本没被执行', async () => {
  const requests = []
  const settings = settingsWith()
  let writeRan = false
  const writeTool = {
    ...mkTool('apply_config', 'write'),
    handler: async () => {
      writeRan = true
      return { ok: true, data: {}, meta: { ms: 1 } }
    }
  }
  const script = [
    [
      { type: 'toolcall_end', toolCall: { id: 'c1', name: 'apply_config', arguments: { deviceId: 'd1' } } },
      { type: 'done' }
    ],
    [{ type: 'done' }]
  ]
  const events = await drive(settings, { requests, tools: [writeTool], script, planMode: true, onQuestion: () => ({ [PLAN_REVIEW_QUESTION_ID]: PLAN_STOP }) })

  assert.equal(writeRan, false, '★ 计划模式下写操作绝不能落到设备上')
  const end = events.find((e) => e.type === 'tool_end')
  assert.equal(end.ok, false)
  assert.equal(end.errorCode, PLAN_MODE_BLOCK_CODE)
  // 提示词里也必须带上「本轮只读」的说明
  const mainReq = requests.find((r) => !r.isSummary)
  assert.match(mainReq.systemPrompt, /计划模式/)
})

test('★ 计划模式：方案产出后弹出评审，批准则转入执行并把探索轮次还回去', async () => {
  const requests = []
  const settings = settingsWith()
  const script = [
    // 第一轮：只读探索
    [
      { type: 'text_delta', delta: '## 方案\n1. 在 R1 上配 10.0.0.0/30' },
      { type: 'done' }
    ],
    // 批准后：执行
    [{ type: 'text_delta', delta: '已按方案执行' }, { type: 'done' }]
  ]
  const events = await drive(settings, {
    requests,
    tools: [],
    script,
    planMode: true,
    onQuestion: (ev) => {
      assert.equal(ev.source, 'plan')
      assert.equal(ev.questions[0].id, PLAN_REVIEW_QUESTION_ID)
      return { [PLAN_REVIEW_QUESTION_ID]: PLAN_APPROVE }
    }
  })
  const reviewed = events.filter((e) => e.type === 'plan_reviewed')
  assert.equal(reviewed.length, 1)
  assert.equal(reviewed[0].action, 'approved')

  // 批准后的请求：system prompt 里不能再有「只读」那段（否则模型批准了也不动手）
  const after = requests.filter((r) => !r.isSummary)
  assert.ok(after.length >= 2, '批准后应再发一次请求')
  assert.doesNotMatch(after[after.length - 1].systemPrompt, /# 计划模式（本轮生效）/)
  // 方案原文被作为「已批准」上下文注入
  const injected = after[after.length - 1].messages.some((m) =>
    String(m.content).includes('用户已批准下列方案')
  )
  assert.ok(injected, '批准后必须把方案原文交给模型，否则它会重新规划')
})

test('★ 计划模式：不执行则收尾且不碰设备；写意见则留在计划模式继续修订', async () => {
  const requests = []
  const settings = settingsWith()
  const script = [[{ type: 'text_delta', delta: '## 方案 A' }, { type: 'done' }]]
  const events = await drive(settings, {
    requests,
    script,
    planMode: true,
    onQuestion: () => ({ [PLAN_REVIEW_QUESTION_ID]: PLAN_STOP })
  })
  assert.equal(events.filter((e) => e.type === 'plan_reviewed')[0].action, 'stopped')
  assert.equal(events.find((e) => e.type === 'done').reason, 'completed')

  // 写意见 → 留在计划模式，下一轮请求仍带只读指令
  const requests2 = []
  const events2 = await drive(settings, {
    requests: requests2,
    script: [
      [{ type: 'text_delta', delta: '## 方案 v1' }, { type: 'done' }],
      [{ type: 'text_delta', delta: '## 方案 v2' }, { type: 'done' }]
    ],
    planMode: true,
    onQuestion: (ev) =>
      ev.type === 'question_request' ? { [PLAN_REVIEW_QUESTION_ID]: '把 VLAN 换成 20' } : null
  })
  const after2 = requests2.filter((r) => !r.isSummary)
  assert.match(after2[after2.length - 1].systemPrompt, /# 计划模式（本轮生效）/, '修订阶段仍是计划模式')
  assert.ok(
    after2[after2.length - 1].messages.some((m) => String(m.content).includes('把 VLAN 换成 20')),
    '用户的修改意见必须回灌给模型'
  )
  assert.equal(events2.filter((e) => e.type === 'plan_reviewed')[0].action, 'revising')
})

test('★ 任务清单：todo_write 后下发 todo_update（并把清单写进后续 system prompt）', async () => {
  const settings = settingsWith()
  const todoTool = realTool('todo_write')
  const todoScript = [
    [
      {
        type: 'toolcall_end',
        toolCall: {
          id: 'c1',
          name: 'todo_write',
          arguments: { todos: [{ content: '建 VLAN 10', status: 'in_progress' }] }
        }
      },
      { type: 'done' }
    ],
    [{ type: 'done' }]
  ]

  // 没有清单存储 + 没有会话归属（等价于对外 MCP 出口）→ 一个清单事件都不发
  const events0 = await drive(settings, {
    requests: [],
    tools: [todoTool],
    script: todoScript
  })
  assert.equal(
    events0.filter((e) => e.type === 'todo_update').length,
    0,
    '★ 无存储/无会话归属时不能发「空清单」事件 —— 那会把界面上的进度抹成零'
  )

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-run-'))
  const store = new TodoStore(path.join(dir, 'todos.json'))
  try {
    const requests2 = []
    const events2 = await drive(settings, {
      requests: requests2,
      tools: [todoTool],
      script: todoScript,
      rootId: 's-aaaaaaaa',
      todos: store
    })
    const updates = events2.filter((e) => e.type === 'todo_update')
    assert.equal(updates.length, 1)
    assert.equal(updates[0].ownerId, 's-aaaaaaaa')
    assert.equal(updates[0].todos[0].content, '建 VLAN 10')
    assert.equal(store.get('s-aaaaaaaa')[0].status, 'in_progress')

    // 清单必须进后续请求的 system prompt（模型才知道做到哪了）
    const after = requests2.filter((r) => !r.isSummary)
    assert.match(after[after.length - 1].systemPrompt, /当前任务清单/)
    assert.match(after[after.length - 1].systemPrompt, /建 VLAN 10/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('★ todo_write：没有清单存储时返回 UNSUPPORTED（对外 MCP 出口就是这条路）', async () => {
  const requests = []
  const script = [
    [
      {
        type: 'toolcall_end',
        toolCall: { id: 'c1', name: 'todo_write', arguments: { todos: [{ content: 'A' }] } }
      },
      { type: 'done' }
    ],
    [{ type: 'done' }]
  ]
  const events = await drive(settingsWith(), {
    requests,
    tools: [realTool('todo_write')],
    script
  })
  const end = events.find((e) => e.type === 'tool_end')
  assert.equal(end.ok, false)
  assert.equal(end.errorCode, 'UNSUPPORTED')
})

test('★ 清单跨任务持久：重开会话时把已有清单推给界面并注入提示词', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-resume-'))
  const store = new TodoStore(path.join(dir, 'todos.json'))
  try {
    store.set('s-bbbbbbbb', [
      { content: '第一步已完成', status: 'completed' },
      { content: '第二步待做', status: 'pending' }
    ])
    const requests = []
    const events = await drive(settingsWith(), {
      requests,
      tools: [],
      script: [[{ type: 'done' }]],
      rootId: 's-bbbbbbbb',
      todos: store
    })
    const restore = events.filter((e) => e.type === 'todo_update')
    assert.equal(restore.length, 1, '本轮开始时应下发一次清单恢复事件')
    assert.equal(restore[0].todos.length, 2)
    const req = requests.find((r) => !r.isSummary)
    assert.match(req.systemPrompt, /第一步已完成/)
    assert.match(req.systemPrompt, /第二步待做/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
