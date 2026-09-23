import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ReactRuntime,
  DEFAULT_SETTINGS,
  CUSTOM_PROMPT_HEADING,
  activeProfile
} from '../.build/harness.mjs'

/**
 * 「设置项到底有没有进请求」的回归用例（第 2 轮 · 静默失败）。
 *
 * 为什么必须有这一层：这类缺陷的表现是「设置能编辑、能保存、重启后还在，但对代理完全无效」——
 * 没有任何报错，只会在长会话里以「代理怎么老是不听话」的形式出现（R53）。
 * 所以用桩 LLM 装配把真实下发的请求抓下来断言，而不是只测拼串函数的返回。
 */

const MARKER = 'UNIQUE-MARKER-42'

/** 桩 LLM 装配：把每次 stream 的 (model, ctx, opts) 与装配参数记下来，只回一个空 done */
function stubLlm(requests) {
  return async (cfg) => ({
    provider: 'compat',
    modelId: cfg.model,
    models: {
      getModel: () => ({ id: cfg.model, contextWindow: 100000, maxTokens: 4096 }),
      stream: (model, ctx, opts) => {
        requests.push({ model, ctx, opts, cfg })
        let finished = false
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (finished) return { done: true, value: undefined }
                finished = true
                return { done: false, value: { type: 'done' } }
              }
            }
          },
          async result() {
            return {
              role: 'assistant',
              content: [{ type: 'text', text: '' }],
              api: 'openai-completions',
              provider: 'compat',
              model: 'stub-model',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
              },
              stopReason: 'stop',
              timestamp: Date.now()
            }
          }
        }
      }
    }
  })
}

function settingsWith(patch) {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    agent: { ...structuredClone(DEFAULT_SETTINGS.agent), ...patch }
  }
}

function depsFor(settings) {
  return {
    tools: [],
    getSettings: () => settings,
    getSkills: () => [],
    getCustomInstructions: () => settings.agent.systemPrompt,
    buildContext: () => ({})
  }
}

/** 跑一轮并把事件收干净 */
async function runOnce(settings) {
  const requests = []
  const runtime = new ReactRuntime(depsFor(settings), {
    apiKey: 'stub-key',
    buildLlm: stubLlm(requests)
  })
  const events = []
  for await (const ev of runtime.run({
    sessionId: 's-1',
    text: '看看设备',
    signal: new AbortController().signal
  })) {
    events.push(ev)
  }
  return { requests, events }
}

// ———————————————————— T2.1 自定义指令必须真的进 system prompt（R53） ————————————————————

test('T2.1 自定义指令随请求下发：设置里的标记文本出现在 systemPrompt 里', async () => {
  const { requests, events } = await runOnce(settingsWith({ systemPrompt: MARKER }))
  assert.equal(requests.length, 1, '应恰好发起一次模型请求')
  const prompt = requests[0].ctx.systemPrompt
  assert.ok(prompt.includes(MARKER), 'R53：用户写的自定义指令必须真的进请求')
  assert.ok(prompt.includes(CUSTOM_PROMPT_HEADING), '要带标题，模型才知道这是高优先级指令')
  assert.ok(events.some((e) => e.type === 'done'), '这一轮应正常收尾')
})

test('T2.1 清空自定义指令后标记消失（不是被兜底默认值塞回去）', async () => {
  const { requests } = await runOnce(settingsWith({ systemPrompt: '' }))
  const prompt = requests[0].ctx.systemPrompt
  assert.ok(!prompt.includes(MARKER))
  assert.ok(!prompt.includes(CUSTOM_PROMPT_HEADING), '空指令不应留下一个空标题块')
})

test('T2.1 提示词首尾仍完整（拼装没有截断基础规则）', async () => {
  const { requests } = await runOnce(settingsWith({ systemPrompt: MARKER }))
  const prompt = requests[0].ctx.systemPrompt
  assert.ok(prompt.length > 1500, `基础提示词应完整保留，实际仅 ${prompt.length} 字符`)
  assert.ok(prompt.startsWith('你是 eNSP 网络实验代理'), '基础提示词开头应在')
  assert.ok(prompt.includes('回答要求：'), '基础提示词结尾段应在')
  assert.ok(prompt.indexOf(MARKER) > prompt.indexOf('你是 eNSP 网络实验代理'), '自定义指令排在基础规则之后')
})

// ———————————————————— 同族：活跃档案的模型参数也必须进请求 ————————————————————

test('活跃档案的 model / temperature 真的进请求（不是写死的默认值）', async () => {
  const settings = settingsWith({})
  const profile = activeProfile(settings.agent)
  const patched = settingsWith({
    profiles: [{ ...profile, model: 'my-model-x', temperature: 0.31 }],
    activeProfileId: profile.id
  })
  const { requests } = await runOnce(patched)
  assert.equal(requests[0].model.id, 'my-model-x')
  assert.equal(requests[0].opts.temperature, 0.31)
})

test('切换活跃档案后，下一轮请求用的是新档案', async () => {
  const base = structuredClone(DEFAULT_SETTINGS.agent)
  const a = { ...structuredClone(base.profiles[0]), id: 'p-aaa', model: 'model-a' }
  const b = { ...structuredClone(base.profiles[0]), id: 'p-bbb', model: 'model-b' }

  const first = await runOnce(settingsWith({ profiles: [a, b], activeProfileId: 'p-aaa' }))
  assert.equal(first.requests[0].model.id, 'model-a')

  const second = await runOnce(settingsWith({ profiles: [a, b], activeProfileId: 'p-bbb' }))
  assert.equal(second.requests[0].model.id, 'model-b')
})

// ———————————————————— 事件流必须自然关闭（否则宿主 finally 永不执行） ————————————————————

test('run() 正常结束会关流：for await 能自然退出，不是靠消费方 break', async () => {
  // 宿主（services.startAgent）就是「for await 到自然结束」的写法，
  // 而 flushAssistant / 任务结束通知 / active.delete 全在它的 finally 里 ——
  // 流不关 = 会话永远显示「运行中」，下一次发送会被「该会话已有任务在运行」顶回来。
  const requests = []
  const runtime = new ReactRuntime(depsFor(settingsWith({ systemPrompt: '' })), {
    apiKey: 'k',
    buildLlm: stubLlm(requests)
  })

  let count = 0
  const drained = (async () => {
    for await (const _ev of runtime.run({
      sessionId: 's-close',
      text: '收尾',
      signal: new AbortController().signal
    })) {
      count += 1
    }
    return count
  })()

  const verdict = await Promise.race([
    drained.then((n) => `closed:${n}`),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve('hung'), 2000)
      t.unref?.()
    })
  ])

  assert.notEqual(verdict, 'hung', '正常结束必须 close() 事件流')
  assert.ok(count >= 1, '至少应收到 done 事件')
})
