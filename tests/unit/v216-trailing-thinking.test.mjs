/**
 * v2.16：尾随思考前移（hoistTrailingThinking）。
 *
 * 实测 deepseek 聚合通道会在正文输出完之后才吐 reasoning_content —— thinking
 * 事件在 text 全部下发完才到，最终回答（连着已完结收尾行）后面会吊一段
 * 「思考」，看着像任务结束后又冒出一句没头没尾的话。
 *
 * 这批用例守的是渲染管线里的一环：去空壳 → **尾随思考前移** → 切段。
 * 只归一顺序，不丢内容；只跨角色挪动，不改 thinking 之间的相对顺序
 * （matchTreeNodes 按角色计数映射因此不受影响）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupMessages, hoistTrailingThinking, resolveTurnBoundary } from '../.build/harness.mjs'

// ————————————————————— 消息桩 —————————————————————

const user = (id, text) => ({ kind: 'user', id, text })
const assistant = (id, text) => ({ kind: 'assistant', id, text })
const thinking = (id, text) => ({ kind: 'thinking', id, text })
const finish = (id, reason = 'completed') => ({ kind: 'finish', id, reason, ms: 1 })
const tool = (id, name = 'run_show_command') => ({
  kind: 'tool',
  id,
  callId: `c-${id}`,
  name,
  args: {},
  risk: 'read',
  status: 'ok',
  ms: 1
})
const system = (id, text) => ({ kind: 'system', id, text, tone: 'info' })

const kinds = (list) => list.map((m) => m.kind).join(',')

// ————————————————————— 核心：吊在回答后面的思考 → 搬回回答前面 —————————————————————

test('★ 回答后吊一段思考（流式形态，收尾卡未到）→ 搬到回答前面', () => {
  const out = hoistTrailingThinking([
    user('u1', '目标'),
    assistant('a1', '结论：全部达成。'),
    thinking('th1', 'Now write final conclusion.')
  ])
  assert.equal(kinds(out), 'user,thinking,assistant')
  assert.equal(out[1].id, 'th1') // 内容不丢、id 不变
})

test('★ 回答 + 收尾卡 + 思考（历史回放形态）→ 思考越过收尾卡搬到回答前面', () => {
  const out = hoistTrailingThinking([
    user('u1', '目标'),
    assistant('a1', '结论。'),
    finish('f1'),
    thinking('th1', 'a'),
    thinking('th2', 'b')
  ])
  assert.equal(kinds(out), 'user,thinking,thinking,assistant,finish')
  // thinking 之间的相对顺序保持不变
  assert.deepEqual(out.slice(1, 3).map((m) => m.id), ['th1', 'th2'])
  // 收尾卡仍在本轮末尾
  assert.equal(out[out.length - 1].kind, 'finish')
})

test('★ 回答 + 思考 + 收尾卡（实时流形态：done 的收尾卡最后追加）→ 思考前移，收尾卡留在末尾', () => {
  const out = hoistTrailingThinking([
    user('u1', '目标'),
    assistant('a1', '结论。'),
    thinking('th1', 'a'),
    thinking('th2', 'b'),
    finish('f1')
  ])
  assert.equal(kinds(out), 'user,thinking,thinking,assistant,finish')
  assert.deepEqual(out.slice(1, 3).map((m) => m.id), ['th1', 'th2'])
  assert.equal(out[out.length - 1].id, 'f1')
})

test('★ 端到端（实时流形态）：归一之后回答挂收尾行、思考在回答上方', () => {
  const segs = groupMessages(
    hoistTrailingThinking([user('u1', '目标'), assistant('a1', '结论。'), thinking('th1', 'x'), finish('f1')])
  )
  const b = resolveTurnBoundary(segs)
  assert.equal(b.replyIdx, 2)
  assert.equal(b.tailIdx, 3)
})

test('★ 端到端：归一之后收尾锚点判定依旧正确（回答挂收尾行，思考在回答上方）', () => {
  const segs = groupMessages(
    hoistTrailingThinking([
      user('u1', '目标'),
      assistant('a1', '结论。'),
      finish('f1'),
      thinking('th1', '收尾前的推理')
    ])
  )
  const b = resolveTurnBoundary(segs)
  assert.equal(b.replyIdx, 2) // thinking 前移后回答在第 2 段
  assert.equal(b.tailIdx, 3)
})

// ————————————————————— 不该动的形态 —————————————————————

test('末尾不是思考（正常流）→ 原样返回（同一引用，不触发多余重渲染）', () => {
  const list = [user('u1', '目标'), thinking('th1', '先想'), assistant('a1', '结论。'), finish('f1')]
  assert.equal(hoistTrailingThinking(list), list)
})

test('思考吊在工具组后面（失败收尾场景）→ 不动，那里没有可挂靠的回答', () => {
  const list = [user('u1', '目标'), assistant('a1', '过程'), tool('t1'), finish('f1', 'failed'), thinking('th1', 'x')]
  assert.equal(hoistTrailingThinking(list), list)
})

test('思考吊在 user 消息后面 → 不动', () => {
  const list = [assistant('a1', '上轮回答'), user('u1', '新指令'), thinking('th1', '新思路')]
  assert.equal(hoistTrailingThinking(list), list)
})

test('思考吊在系统提示后面（中间隔的不是回答/收尾卡）→ 不动', () => {
  const list = [assistant('a1', '结论'), system('s1', '已导出报告'), thinking('th1', 'x')]
  assert.equal(hoistTrailingThinking(list), list)
})

test('隔收尾卡之后仍不是有正文的回答（空壳 assistant）→ 不动', () => {
  const list = [user('u1', '目标'), assistant('a1', '   '), finish('f1'), thinking('th1', 'x')]
  assert.equal(hoistTrailingThinking(list), list)
})

test('隔收尾卡之后是工具消息 → 不动', () => {
  const list = [user('u1', '目标'), tool('t1'), finish('f1'), thinking('th1', 'x')]
  assert.equal(hoistTrailingThinking(list), list)
})

// ————————————————————— 边界 —————————————————————

test('空列表 / 只有思考 → 安全', () => {
  assert.deepEqual(hoistTrailingThinking([]), [])
  const only = [thinking('th1', 'x')]
  assert.equal(hoistTrailingThinking(only), only)
})

test('整条流只有思考 + 回答 → 思考前移', () => {
  const out = hoistTrailingThinking([assistant('a1', '答'), thinking('th1', '想')])
  assert.equal(kinds(out), 'thinking,assistant')
})

test('前移只跨角色，thinking 相对顺序不变（matchTreeNodes 按角色计数不受影响）', () => {
  const out = hoistTrailingThinking([
    user('u1', '目标'),
    thinking('th0', '开局推理'),
    assistant('a1', '结论。'),
    finish('f1'),
    thinking('th1', 'a'),
    thinking('th2', 'b')
  ])
  // UI 顺序里 th0 仍是第 1 条思考、th1/th2 依次跟随 —— 与树里 thinking 节点顺序一致
  const thinkIds = out.filter((m) => m.kind === 'thinking').map((m) => m.id)
  assert.deepEqual(thinkIds, ['th0', 'th1', 'th2'])
})
