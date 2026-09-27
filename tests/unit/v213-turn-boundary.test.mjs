/**
 * v2.13：本轮收尾锚点（回答 / 收尾卡的判定）。
 *
 * 这批用例守的是一条「错了不会抛错、只会显示在错误位置」的线：
 * 旧实现按位置取「整条消息流里最后一条 assistant」当最终回答、取「第一张 finish」
 * 当收尾卡，于是
 *  ① 轮内最后一条「日常信息」（其后还有工具调用）被当成整轮回答，并挂上
 *     「已完成 + 用量」的收尾行 —— 看着像任务在那里结束了；
 *  ② 多轮会话里收尾卡张冠李戴，本轮显示上一轮的耗时/用量/结束原因。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupMessages, resolveTurnBoundary } from '../.build/harness.mjs'

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

/** 与 AgentPanel 真实链路一致：先去空壳、再切段，然后判定收尾锚点 */
const boundary = (...messages) => resolveTurnBoundary(groupMessages(messages))

// ————————————————————— 核心：轮内的「日常信息」不是回答 —————————————————————

test('★ 最后一条 assistant 之后还有工具调用 → 它不是回答（只是过程中的日常信息）', () => {
  const b = boundary(
    user('u1', '把交换机改成三层'),
    thinking('th1', '先确认设备型号'),
    assistant('a1', 'The external-network switches are L2-only，我先看看接口。'),
    tool('t1'),
    tool('t2')
  )
  assert.equal(b.replyIdx, -1)
  assert.equal(b.tailIdx, -1)
})

test('★ 这条日常信息也不能被当成收尾锚点（收尾卡还没有）', () => {
  const b = boundary(
    user('u1', '目标'),
    assistant('a1', 'Let me recover the design plan from the previous sessions.'),
    thinking('th1', '继续'),
    tool('t1')
  )
  assert.equal(b.replyIdx, -1)
})

test('工具调用之后又说话了，且之后再无工具 → 回答是后面那条', () => {
  const b = boundary(
    user('u1', '目标'),
    assistant('a1', '过程说明'),
    tool('t1'),
    thinking('th2', '汇总'),
    assistant('a2', '结论：已完成 VLAN 配置与验证。'),
    finish('f1')
  )
  assert.equal(b.replyIdx, 4)
  assert.equal(b.tailIdx, 5)
})

// ————————————————————— 收尾卡归属 —————————————————————

test('★ 多轮：只认当前轮的收尾卡（上一轮的不能被拿来当本轮结果）', () => {
  const b = boundary(
    user('u1', '第一轮'),
    assistant('a1', '第一轮回答'),
    finish('f1'),
    user('u2', '第二轮'),
    assistant('a2', '第二轮还在跑…'),
    tool('t1')
  )
  // 第二轮尚无收尾卡 —— 不能把 f1 当成它的结果
  assert.equal(b.tailIdx, -1)
  assert.equal(b.replyIdx, -1)
})

test('多轮：当前轮收尾后，收尾卡指向当前轮那张', () => {
  const b = boundary(
    user('u1', '第一轮'),
    assistant('a1', '第一轮回答'),
    finish('f1'),
    user('u2', '第二轮'),
    assistant('a2', '第二轮回答'),
    finish('f2')
  )
  assert.equal(b.replyIdx, 4)
  assert.equal(b.tailIdx, 5)
})

test('结束在工具上（失败 / 达轮次上限）→ 无回答，收尾行独立成块', () => {
  const b = boundary(
    user('u1', '目标'),
    assistant('a1', '继续执行'),
    tool('t1'),
    finish('f1', 'failed')
  )
  assert.equal(b.replyIdx, -1)
  assert.equal(b.tailIdx, 3)
})

// ————————————————————— 流式 / 边界情况 —————————————————————

test('回答仍在流式输出（还没收尾卡）→ 它是回答，但本轮尚未收尾', () => {
  const b = boundary(user('u1', '目标'), assistant('a1', '正在输出结论'))
  assert.equal(b.replyIdx, 1)
  assert.equal(b.tailIdx, -1)
})

test('回答之后的思考 / 系统提示不算「这轮还没结束」', () => {
  const b = boundary(
    user('u1', '目标'),
    assistant('a1', '结论'),
    thinking('th1', '补一句推理'),
    { kind: 'system', id: 's1', text: '已导出报告', tone: 'info' },
    finish('f1')
  )
  assert.equal(b.replyIdx, 1)
  assert.equal(b.tailIdx, 4)
})

test('空壳 assistant（无正文）不算回答', () => {
  const b = boundary(user('u1', '目标'), assistant('a1', '   '))
  assert.equal(b.replyIdx, -1)
})

test('没有 user 段（历史回溯 / 单会话续写）时整段视为一轮', () => {
  const b = boundary(assistant('a1', '结论'), thinking('th1', '推理'))
  assert.equal(b.replyIdx, 0)
  assert.equal(b.tailIdx, -1)
})

test('只有用户消息（刚发出指令）→ 没有回答也没有收尾', () => {
  const b = boundary(user('u1', '目标'))
  assert.equal(b.replyIdx, -1)
  assert.equal(b.tailIdx, -1)
})

test('空消息流不崩', () => {
  assert.deepEqual(resolveTurnBoundary([]), { replyIdx: -1, tailIdx: -1 })
})