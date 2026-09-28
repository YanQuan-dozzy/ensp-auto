import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Esc 让行守卫（N3 引入）。
 *
 * 为什么需要：`App.tsx` 在 window **捕获阶段**监听 Esc，命中 `agent:stop` 后会
 * `preventDefault + stopPropagation + abort()`。冒泡阶段的弹窗（闸门 R23、提问卡 N3）
 * 此前收不到这个事件，于是「按 Esc 想取消这一问」会连同整个任务一起被中止。
 *
 * 这类回归不会有编译期信号（状态字段是可选布尔），且只在真机上点一次才暴露，
 * 故从**源码**做静态对账（与 ipc-coverage / v221-dismissible-banner 同路子）。
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const APP = path.join(ROOT, 'src/renderer/App.tsx')
const QUESTION = path.join(ROOT, 'src/renderer/features/agent/QuestionDialog.tsx')

test('N3 Esc 让行：agent:stop 分支在 gate / question 打开时必须提前 return', () => {
  const src = fs.readFileSync(APP, 'utf8')
  const start = src.indexOf("eff['agent:stop']")
  assert.ok(start >= 0, "未找到 agent:stop 分支（App.tsx 结构变了？）")
  const rest = src.slice(start)
  const end = rest.indexOf("eff['app:settings']")
  const block = end >= 0 ? rest.slice(0, end) : rest

  assert.match(block, /if \(st\.gate\) return/, '闸门打开时 Esc 必须让行（R23）')
  assert.match(
    block,
    /if \(st\.question\) return/,
    '提问卡打开时 Esc 必须让行（N3）——否则会中止整个任务，与卡片「取消这一问」语义相反'
  )
})

test('N3 提问卡自身把 Esc 解释为「取消这一问」（answerQuestion(null)）', () => {
  const src = fs.readFileSync(QUESTION, 'utf8')
  assert.match(src, /e\.key === 'Escape'/, 'QuestionDialog 应监听 Escape')
  assert.match(
    src,
    /answerQuestion\(null\)/,
    'Esc 必须传 null（取消语义），不得折成空答案 {}（硬约束：取消只认 null）'
  )
})