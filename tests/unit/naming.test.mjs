import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeNameSegment,
  namespaceToolName,
  dedupeToolName,
  MCP_TOOL_SEGMENT_MAX
} from '../.build/harness.mjs'

/**
 * D8（2026-09-23，B3）：中文服务器名被压成 'x' → 多台中文名服务器工具名必碰撞；
 * 且旧碰撞兜底是「先占满 64 字符再追加后缀」，直接撑破 OpenAI 兼容端 {1,64} 约束。
 *
 * 修复口径：
 *  ① sanitizeNameSegment 全非法字符时按原始串短哈希兜底（h + 6 位 36 进制），不同名不再塌缩；
 *  ② 碰撞兜底改为「先裁工具段、再带服务器+工具名派生的哈希后缀」，恒定 ≤64；
 *  ③ namespaceToolName / 碰撞分支都过 assertToolNameLen（开发期 throw）。
 */

test('D8：全非法字符名兜底为短哈希且不塌缩（混合中英文也不碰撞成 x）', () => {
  const cnA = sanitizeNameSegment('文件系统工具', 16)
  const cnB = sanitizeNameSegment('数据库工具', 16)
  assert.notEqual(cnA, cnB, '两台中文名服务器不得塌缩成同名')
  assert.notEqual(cnA, 'x')
  assert.match(cnA, /^h[0-9a-z]{6}$/)
  // 与「真的叫 x 的服务器」也要区分开：'x' 是合法字符原样保留，哈希兜底恒以 h 开头
  assert.equal(sanitizeNameSegment('x', 16), 'x')
})

test('D8：中文名工具名与 ASCII 名落入同一命名空间也不碰撞', () => {
  const a = namespaceToolName('文件系统', 'read_file')
  const b = namespaceToolName('数据库', 'read_file')
  assert.notEqual(a, b)
  assert.ok(a.length <= 64)
  assert.ok(b.length <= 64)
  assert.match(a, /^mcp__h[0-9a-z]{6}__read_file$/, '服务器段是哈希兜底，工具名照常')
})

test('D8：两台同名(中文/ASCII)服务器 + 同名工具 → 排重后互不相同且 ≤64', () => {
  const seen = new Set()
  const cfg = { name: '工具集', tool: 'query' }
  const first = dedupeToolName(cfg.name, cfg.tool, seen)
  seen.add(first)
  const second = dedupeToolName(cfg.name, cfg.tool, seen)
  seen.add(second)
  const third = dedupeToolName(cfg.name, cfg.tool, seen)
  assert.notEqual(first, second)
  assert.notEqual(second, third)
  for (const n of [first, second, third]) {
    assert.ok(n.length <= 64, `长度不得超 64（实收 ${n.length}）：${n}`)
    assert.match(n, /^[A-Za-z0-9_-]+$/)
  }
})

test('D8：同一服务器内两个截断后同名的长工具名 → 后缀互不相同且 ≤64', () => {
  const seen = new Set()
  // 两把工具名都超过 41 字符预算，sanitize 后会截成同一段 → 必须靠后缀区分
  const t1 = 'very_long_tool_name_that_exceeds_the_segment_budget_by_a_lot_one'
  const t2 = 'very_long_tool_name_that_exceeds_the_segment_budget_by_a_lot_two'
  const n1 = dedupeToolName('文件系统', t1, seen)
  seen.add(n1)
  const n2 = dedupeToolName('文件系统', t2, seen)
  assert.notEqual(n1, n2, '截断同名也须靠后缀区分')
  assert.ok(n1.length <= 64)
  assert.ok(n2.length <= 64)
  assert.ok(n1.length > 'mcp__hxxxxxx__'.length, '后缀确实存在（名字长了）')
})

test('D8：未碰撞时 dedupeToolName 与 namespaceToolName 行为一致，不再追加后缀', () => {
  const seen = new Set()
  const n = dedupeToolName('filesystem', 'read_file', seen)
  assert.equal(n, 'mcp__filesystem__read_file')
})

test('D8：长度防线 —— 极端输入下 namespaceToolName 仍 ≤64（不触发开发期 throw）', () => {
  // 旧实现在这里会变成 64 + 1 + 8 = 73 字符，直接炸掉整张工具表的 {1,64} 校验
  const a = namespaceToolName('文件系统工具', 'x'.repeat(MCP_TOOL_SEGMENT_MAX + 20))
  const b = namespaceToolName(`x`.repeat(80), `长`.repeat(60))
  for (const n of [a, b]) {
    assert.ok(n.length <= 64)
    assert.match(n, /^[A-Za-z0-9_-]+$/)
  }
})