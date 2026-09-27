/**
 * 工具 schema 的形状守卫（v2.1）。
 *
 * 背景：`execute_task` 的入参 schema 曾经是 `Type.Union([...])`，TypeBox 把它
 * 编译成 `{ anyOf: [...] }` —— **没有根 `type`**。OpenAI 兼容端点（DeepSeek 等）
 * 的函数入参校验只认根 `type: 'object'`，于是每次请求都 400：
 *
 *   400: Invalid schema for function 'execute_task': schema must be a JSON Schema
 *   of 'type': "object", got 'type': null'
 *
 * 关键危害不在「这个工具不能用」，而在**整个会话不能用** —— 报错与「本轮是否
 * 调用它」无关，只要它在工具表里，任何一条消息都发不出去。这里的用例就是钉死
 * 这条不变量：任何工具的 schema 根都必须是 object。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS, toLLMTools, toMcpTools, normalizeToolSchema, Type } from '../.build/harness.mjs'

test('每个内置工具的 LLM 入参 schema 根都是 object（根为 union 会 400 掉整个会话）', () => {
  const bad = toLLMTools(TOOLS)
    .filter((t) => t.parameters?.type !== 'object')
    .map((t) => `${t.name}(type=${JSON.stringify(t.parameters?.type ?? null)})`)
  assert.deepEqual(bad, [], `以下工具的 schema 根不是 object：${bad.join(', ')}`)
})

test('对外 MCP 出口的 inputSchema 同样是 object 根', () => {
  const bad = toMcpTools(TOOLS)
    .filter((t) => t.inputSchema?.type !== 'object')
    .map((t) => t.name)
  assert.deepEqual(bad, [])
})

test('execute_task 回归：根是 object 且 task 必填，分支字段都还在', () => {
  const exec = toLLMTools(TOOLS).find((t) => t.name === 'execute_task')
  assert.ok(exec, 'execute_task 应当在工具表里')
  assert.equal(exec.parameters.type, 'object')
  assert.deepEqual(exec.parameters.required, ['task'])
  // 八个任务类型的字段一个都不能丢：漏了就等于模型没法填参数
  for (const key of ['checks', 'routers', 'switches', 'server', 'pools', 'bindings', 'devices']) {
    assert.ok(exec.parameters.properties[key], `execute_task 缺少分支字段 ${key}`)
  }
  // 判别式的枚举值也必须完整
  const kinds = exec.parameters.properties.task.anyOf.map((b) => b.const).sort()
  assert.deepEqual(kinds, [
    'acl_nat',
    'dhcp',
    'eth_trunk',
    'ospf',
    'pc_connectivity',
    'rip',
    'static_route',
    'vlan'
  ])
})

test('normalizeToolSchema：union 根被补成 object 且分支不丢（故障形状的兜底）', () => {
  const union = Type.Union([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })])
  // 先确认这确实是当初故障的形状：TypeBox 的 union 没有根 type
  assert.equal(union.type, undefined)
  const fixed = normalizeToolSchema(union)
  assert.equal(fixed.type, 'object')
  assert.equal(fixed.anyOf.length, 2)
})

test('normalizeToolSchema：已是 object 根时原样返回（引用不变，不做无谓拷贝）', () => {
  const obj = Type.Object({ a: Type.String() })
  assert.equal(normalizeToolSchema(obj), obj)
})

test('normalizeToolSchema：数组等非对象根会被包成对象根', () => {
  const arr = Type.Array(Type.String())
  const fixed = normalizeToolSchema(arr)
  assert.equal(fixed.type, 'object')
  assert.deepEqual(fixed.anyOf, [arr])
})
