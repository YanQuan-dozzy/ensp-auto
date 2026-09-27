/**
 * v2.19：按轮切分（splitTurns）—— 任务收尾后「整轮过程收成一行」的地基。
 *
 * 渲染层要做的三件事全靠它：
 * ① 判断「哪些段属于同一轮」—— 边界是 user 段；
 * ② 每轮**各判各的**回答与收尾卡（历史轮的收尾卡不能再被丢掉）；
 * ③ 每轮的「过程段」= body 里除回答与收尾卡之外的段（收起时整段不渲染）。
 *
 * 这批用例守的线：错不抛错、只会让「收起的行数不对」或「点开的是别人那一轮」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupMessages, resolveTurnBoundary, splitTurns } from '../.build/harness.mjs'

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

/** 与 AgentPanel 真实链路一致：先去空壳、再切段，然后按轮切分 */
const turnsOf = (...messages) =>
  splitTurns(groupMessages(messages.filter((m) => m.kind !== 'assistant' || m.text.trim() !== '')))

/** 本轮过程段（渲染层「收起时整段不渲染」的那批）的下标 */
const processKindsOf = (body) => {
  const { replyIdx, tailIdx } = resolveTurnBoundary(body)
  return body
    .filter((_, i) => i !== replyIdx && i !== tailIdx)
    .map((s) => s.kind)
}

// ————————————————————— 轮边界 —————————————————————

test('★ 两轮各成一片：key 取各自 user 段 id，body 不串档', () => {
  const turns = turnsOf(
    user('u1', '第一轮'),
    thinking('th1', '想'),
    tool('t1'),
    assistant('a1', '第一轮回答'),
    finish('f1'),
    user('u2', '第二轮'),
    assistant('a2', '第二轮回答'),
    finish('f2')
  )
  assert.equal(turns.length, 2)
  assert.equal(turns[0].key, 'u1')
  assert.equal(turns[0].user.id, 'u1')
  assert.deepEqual(
    turns[0].body.map((s) => s.kind),
    ['thinking', 'toolGroup', 'assistant', 'finish']
  )
  assert.equal(turns[1].key, 'u2')
  assert.deepEqual(
    turns[1].body.map((s) => s.kind),
    ['assistant', 'finish']
  )
  // 第一轮的 finish 没有跑到第二轮里（这正是旧渲染丢掉历史轮收尾卡的地方）
  assert.equal(turns[1].body.some((s) => s.kind === 'finish' && s.id === 'f1'), false)
})

test('★ 每轮各判各的收尾锚点 —— 历史轮的收尾卡不再被丢掉', () => {
  const turns = turnsOf(
    user('u1', '第一轮'),
    assistant('a1', '第一轮回答'),
    finish('f1'),
    user('u2', '第二轮'),
    assistant('a2', '第二轮回答'),
    finish('f2')
  )
  const b0 = resolveTurnBoundary(turns[0].body)
  assert.equal(turns[0].body[b0.replyIdx].text, '第一轮回答')
  assert.equal(turns[0].body[b0.tailIdx].id, 'f1')
  const b1 = resolveTurnBoundary(turns[1].body)
  assert.equal(turns[1].body[b1.replyIdx].text, '第二轮回答')
  assert.equal(turns[1].body[b1.tailIdx].id, 'f2')
})

// ————————————————————— 过程段 —————————————————————

test('★ 过程段 = 除回答与收尾卡之外的段（收起时它们整段消失）', () => {
  const turns = turnsOf(
    user('u1', '目标'),
    thinking('th1', '想'),
    tool('t1'),
    assistant('a1', '结论'),
    finish('f1')
  )
  assert.deepEqual(processKindsOf(turns[0].body), ['thinking', 'toolGroup'])
})

test('轮内「日常信息」（回答之前又说过话）也算过程，不被当成结果', () => {
  const turns = turnsOf(
    user('u1', '目标'),
    assistant('a1', '我先看看设备'),
    tool('t1'),
    assistant('a2', '结论：已完成'),
    finish('f1')
  )
  assert.deepEqual(processKindsOf(turns[0].body), ['assistant', 'toolGroup'])
  const { replyIdx } = resolveTurnBoundary(turns[0].body)
  assert.equal(turns[0].body[replyIdx].text, '结论：已完成')
})

test('未收尾的轮：body 有过程与回答但没有收尾卡 → 渲染层据此让它保持可见', () => {
  const turns = turnsOf(user('u1', '目标'), thinking('th1', '想'), assistant('a1', '正在输出'))
  const { tailIdx } = resolveTurnBoundary(turns[0].body)
  assert.equal(tailIdx, -1) // 没有收尾卡 = 这一轮还没结束，过程不许收起
})

test('结束在工具上（失败 / 达轮次上限）→ 过程之外没有回答，收尾卡仍在本轮内', () => {
  const turns = turnsOf(user('u1', '目标'), tool('t1'), finish('f1', 'failed'))
  const { replyIdx, tailIdx } = resolveTurnBoundary(turns[0].body)
  assert.equal(replyIdx, -1)
  assert.equal(turns[0].body[tailIdx].reason, 'failed')
  assert.deepEqual(processKindsOf(turns[0].body), ['toolGroup'])
})

// ————————————————————— 兜底与稳定性 —————————————————————

test('开头没有 user 段（历史回溯 / 续写）→ 自成一兜底轮，key 与位置无关', () => {
  const turns = turnsOf(assistant('a1', '结论'), thinking('th1', '推理'))
  assert.equal(turns.length, 1)
  assert.equal(turns[0].user, undefined)
  assert.equal(turns[0].key, 'turn-head-a1')
})

test('★ 前缀稳定：同一前缀两次切分，先出现的轮 key 不变', () => {
  const base = [user('u1', '一'), assistant('a1', '答'), finish('f1')]
  const t1 = turnsOf(...base)
  const t2 = turnsOf(...base, user('u2', '二'), assistant('a2', '答2'), finish('f2'))
  assert.equal(t1[0].key, t2[0].key)
  assert.equal(t2.length, 2)
})

test('只有 user（刚发出指令）→ 一轮，body 为空', () => {
  const turns = turnsOf(user('u1', '目标'))
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0].body, [])
})

test('空消息流 → 没有轮，不崩', () => {
  assert.deepEqual(splitTurns([]), [])
})
