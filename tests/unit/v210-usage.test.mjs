/**
 * v2.10（P6）：本轮用量归集。
 *
 * 这条线错了不会抛异常，只会**显示错数字**：`usage` 事件是每次模型往返下发一次，
 * 只留最后一次会让长任务少报一大截（用户以为「这轮才用了 2k」，其实用了 30k）。
 *
 * 注：本文件原为 `v210-turn-footer.test.mjs`，其中「尾部操作栏 / 发散思考提示词 /
 * 本轮指令还原」三组用例随孤儿模块 `shared/turn-footer.ts` 一并删除（renderer 侧 0 引用，
 * 经确认后连测试一起删）；用量归集来自 `shared/turn-usage.ts`，与本文件同族保留。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_TURN_USAGE,
  accumulateUsage,
  formatTokens,
  describeTurnUsage,
  shouldShowUsage
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