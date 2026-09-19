/**
 * pi-ai 事件翻译层测试（v0.3）。
 * 用记录式事件样例验证 consumeEvent 的映射：text_delta → text、
 * toolcall_end 收集、thinking 跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consumeEvent, newTurn } from '../.build/harness.mjs'

test('text_delta 累积文本并返回 text 事件', () => {
  const acc = newTurn()
  const a = consumeEvent(acc, { type: 'text_delta', contentIndex: 0, delta: '你好', partial: {} })
  const b = consumeEvent(acc, { type: 'text_delta', contentIndex: 0, delta: '世界', partial: {} })
  assert.deepEqual(a, [{ type: 'text', delta: '你好' }])
  assert.deepEqual(b, [{ type: 'text', delta: '世界' }])
  assert.equal(acc.text, '你好世界')
  assert.equal(acc.toolCalls.length, 0)
})

test('toolcall_end 收集工具调用（arguments 已是对象）', () => {
  const acc = newTurn()
  const events = consumeEvent(acc, {
    type: 'toolcall_end',
    contentIndex: 1,
    toolCall: { type: 'toolCall', id: 'call_1', name: 'list_devices', arguments: { a: 1 } },
    partial: {}
  })
  // 工具调用不直接产生 UI 事件，由运行时后续执行
  assert.deepEqual(events, [])
  assert.equal(acc.toolCalls.length, 1)
  assert.equal(acc.toolCalls[0].id, 'call_1')
  assert.equal(acc.toolCalls[0].name, 'list_devices')
  assert.deepEqual(acc.toolCalls[0].args, { a: 1 })
})

test('thinking 事件不进入对话流', () => {
  const acc = newTurn()
  const a = consumeEvent(acc, { type: 'thinking_start', contentIndex: 0, partial: {} })
  const b = consumeEvent(acc, { type: 'thinking_delta', contentIndex: 0, delta: '内部推理', partial: {} })
  const c = consumeEvent(acc, { type: 'thinking_end', contentIndex: 0, content: '内部推理', partial: {} })
  assert.deepEqual(a, [])
  assert.deepEqual(b, [])
  assert.deepEqual(c, [])
  assert.equal(acc.text, '')
  assert.equal(acc.toolCalls.length, 0)
})

test('start / text_start / done 事件忽略', () => {
  const acc = newTurn()
  const a = consumeEvent(acc, { type: 'start', partial: {} })
  const b = consumeEvent(acc, { type: 'text_start', contentIndex: 0, partial: {} })
  const c = consumeEvent(acc, { type: 'done', reason: 'stop', message: {} })
  assert.deepEqual([a, b, c].flat(), [])
})