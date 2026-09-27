/**
 * v2.10（P6）：尾部操作栏 + 本轮用量归集。
 *
 * 这批用例守的是三条「错了不会抛异常、只会显示错数字/发错内容」的线：
 *  1. **用量必须累加**：`usage` 事件是每次模型往返下发一次，只留最后一次会让
 *     长任务少报一大截（用户以为「这轮才用了 2k」，其实用了 30k）。
 *  2. **「本轮指令」的还原**：重试要发回**原始指令**，气泡里那句 `📎 …` 是
 *     给人看的附件摘要，原样重发等于骗模型说有两个附件。
 *  3. **发散思考的提示词**：只说「发散」会得到一堆泛泛之谈 —— 提示词里写死的
 *     约束（基于已落地结论、只给没做过的、要可执行）就是这段功能的质量本身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_TURN_USAGE,
  accumulateUsage,
  formatTokens,
  describeTurnUsage,
  shouldShowUsage,
  TURN_FOOTER_ITEMS,
  buildDivergePrompt,
  lastUserInstruction
} from '../.build/harness.mjs'

// ————————————————————— 用量归集 —————————————————————

test('用量：初始为空，未测量', () => {
  assert.equal(EMPTY_TURN_USAGE.rounds, 0)
  assert.equal(EMPTY_TURN_USAGE.promptTokens, 0)
  assert.equal(EMPTY_TURN_USAGE.outputTokens, 0)
  assert.equal(EMPTY_TURN_USAGE.measured, false)
})

test('用量：多次往返累加，不覆盖', () => {
  let u = EMPTY_TURN_USAGE
  u = accumulateUsage(u, { promptTokens: 1000, outputTokens: 200 })
  u = accumulateUsage(u, { promptTokens: 3000, outputTokens: 400 })
  u = accumulateUsage(u, { promptTokens: 5000, outputTokens: 600 })
  assert.equal(u.rounds, 3)
  assert.equal(u.promptTokens, 9000)
  assert.equal(u.outputTokens, 1200)
})

test('用量：不修改入参（返回新对象）', () => {
  const before = { ...EMPTY_TURN_USAGE }
  const after = accumulateUsage(before, { promptTokens: 10, outputTokens: 5 })
  assert.equal(before.rounds, 0)
  assert.equal(after.rounds, 1)
  assert.notEqual(before, after)
})

test('用量：只要有一次实测就记 measured=true', () => {
  let u = accumulateUsage(EMPTY_TURN_USAGE, { promptTokens: 1, outputTokens: 1 }, { measured: false })
  assert.equal(u.measured, false)
  u = accumulateUsage(u, { promptTokens: 1, outputTokens: 1 }, { measured: true })
  assert.equal(u.measured, true)
  // 之后的估算不会把它降回 false
  u = accumulateUsage(u, { promptTokens: 1, outputTokens: 1 }, { measured: false })
  assert.equal(u.measured, true)
})

test('用量：负数/NaN 归零而不是污染累计', () => {
  let u = accumulateUsage(EMPTY_TURN_USAGE, { promptTokens: -5, outputTokens: NaN })
  assert.equal(u.promptTokens, 0)
  assert.equal(u.outputTokens, 0)
  assert.equal(u.rounds, 1)
})

test('用量：contextWindow / ratio 取最后一次', () => {
  let u = EMPTY_TURN_USAGE
  u = accumulateUsage(u, { promptTokens: 1, outputTokens: 1 }, { contextWindow: 100, ratio: 0.1 })
  u = accumulateUsage(u, { promptTokens: 1, outputTokens: 1 }, { contextWindow: 200, ratio: 0.9 })
  assert.equal(u.contextWindow, 200)
  assert.equal(u.lastRatio, 0.9)
})

// ————————————————————— token 格式化 —————————————————————

test('formatTokens：千以下给原值', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
})

test('formatTokens：千级一位小数', () => {
  assert.equal(formatTokens(1000), '1.0k')
  assert.equal(formatTokens(8123), '8.1k')
  assert.equal(formatTokens(9949), '9.9k')
})

test('formatTokens：万级取整（减少噪声）', () => {
  assert.equal(formatTokens(10000), '10k')
  assert.equal(formatTokens(12345), '12k')
  assert.equal(formatTokens(987654), '988k')
})

// ————————————————————— 用量行文案 —————————————————————

test('describeTurnUsage：0 轮给空串（不显示）', () => {
  assert.equal(describeTurnUsage(EMPTY_TURN_USAGE), '')
})

test('describeTurnUsage：tokens + 轮次', () => {
  const u = accumulateUsage(
    accumulateUsage(EMPTY_TURN_USAGE, { promptTokens: 4000, outputTokens: 1000 }),
    { promptTokens: 2000, outputTokens: 1000 }
  )
  // 总 8000 → 8.0k，2 轮
  const s = describeTurnUsage(u)
  assert.match(s, /8\.0k tokens/)
  assert.match(s, /2 轮/)
})

test('describeTurnUsage：估算时标注', () => {
  const u = accumulateUsage(EMPTY_TURN_USAGE, { promptTokens: 100, outputTokens: 50 })
  assert.match(describeTurnUsage(u), /估算/)
})

test('shouldShowUsage：单轮小任务不显示', () => {
  const u = accumulateUsage(EMPTY_TURN_USAGE, { promptTokens: 100, outputTokens: 50 })
  assert.equal(shouldShowUsage(u), false)
})

test('shouldShowUsage：多轮或大 token 显示', () => {
  const one = accumulateUsage(EMPTY_TURN_USAGE, { promptTokens: 100, outputTokens: 50 })
  const two = accumulateUsage(one, { promptTokens: 100, outputTokens: 50 })
  assert.equal(shouldShowUsage(two), true)

  const big = accumulateUsage(EMPTY_TURN_USAGE, { promptTokens: 5000, outputTokens: 500 })
  assert.equal(shouldShowUsage(big), true)
})

test('shouldShowUsage：0 轮一律不显示', () => {
  assert.equal(shouldShowUsage(EMPTY_TURN_USAGE), false)
})

// ————————————————————— 操作栏清单 —————————————————————

test('操作栏：四项且顺序固定（重试在最前）', () => {
  assert.equal(TURN_FOOTER_ITEMS.length, 4)
  assert.deepEqual(
    TURN_FOOTER_ITEMS.map((i) => i.action),
    ['retry', 'copy', 'export', 'diverge']
  )
})

test('操作栏：每项都有非空文案与提示', () => {
  for (const it of TURN_FOOTER_ITEMS) {
    assert.ok(it.label.trim(), `${it.action} 缺 label`)
    assert.ok(it.title.trim(), `${it.action} 缺 title`)
  }
})

// ————————————————————— 发散思考提示词 —————————————————————

test('发散思考：带主题时把主题嵌进去', () => {
  const p = buildDivergePrompt('已完成 OSPF 区域配置')
  assert.match(p, /已完成 OSPF 区域配置/)
})

test('发散思考：空主题也能给一段可用提示（不出现空括号）', () => {
  const p = buildDivergePrompt('   ')
  assert.ok(!p.includes('（）'))
  assert.match(p, /结合刚才这轮任务/)
})

test('发散思考：提示词含三条硬约束', () => {
  const p = buildDivergePrompt('x')
  assert.match(p, /至少给出 3 个方向/)
  assert.match(p, /还没做过/)
  assert.match(p, /可执行/)
})

test('发散思考：明确「不要现在执行」', () => {
  const p = buildDivergePrompt('x')
  assert.match(p, /不要现在执行/)
})

// ————————————————————— 本轮指令还原（重试） —————————————————————

const user = (text) => ({ kind: 'user', id: 'u', text })
const assistant = (text) => ({ kind: 'assistant', id: 'a', text })

test('重试：取最后一条 user 消息', () => {
  const msgs = [user('第一条'), assistant('a1'), user('第二条'), assistant('a2')]
  assert.equal(lastUserInstruction(msgs), '第二条')
})

test('重试：单轮时取唯一那条 user', () => {
  assert.equal(lastUserInstruction([user('配置 VLAN'), assistant('done')]), '配置 VLAN')
})

test('重试：剥掉附件摘要后缀（📎 那句不是指令）', () => {
  const msgs = [user('给 SW1 配 VLAN\n\n📎 topo.topo、note.txt'), assistant('ok')]
  assert.equal(lastUserInstruction(msgs), '给 SW1 配 VLAN')
})

test('重试：全是空 user 消息时返回 null', () => {
  assert.equal(lastUserInstruction([user('   '), assistant('x')]), null)
})

test('重试：没有 user 消息时返回 null（历史回溯场景）', () => {
  assert.equal(lastUserInstruction([assistant('只有回答')]), null)
  assert.equal(lastUserInstruction([]), null)
})

test('重试：只有 📎 后缀、正文为空时返回 null', () => {
  assert.equal(lastUserInstruction([user('\n\n📎 a.txt')]), null)
})
