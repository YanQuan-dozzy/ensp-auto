import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSkillPrompt,
  buildAgentSystemPrompt,
  fitExternalTools,
  SKILL_PROMPT_MAX_CHARS
} from '../.build/harness.mjs'

/**
 * D14（2026-09-23，B3）：技能注入与外部工具注入无总量预算。
 *
 * 旧实现不是没算过账，而是「压缩」只作用于 messages，system prompt 侧的
 * 技能正文与外部工具 schema 注永无上限 —— 压缩永远追不上注入增长。
 * 修复三处：
 *  ① buildSkillPrompt 带预算（默认 60k），超限整段 drop + 尾部说明；
 *  ② react.runtime 把 system prompt 计入 transcript 预算（本文件测不到进程内，靠 ①③ 守门）；
 *  ③ fitExternalTools：外部工具条数（64）与单工具 schema（12k）上限，超限整把跳过。
 */

test('D14：buildSkillPrompt 超预算时按顺序保留、整体跳过并在尾部说明', () => {
  // 2 个各 30k 的技能 + 1 个 30k → 第 2 个开始超预算（60k 上限）
  const bigSkill = (name) => ({ name, description: 'd', content: 'x'.repeat(30_000) })
  const p = buildSkillPrompt([bigSkill('手册A'), bigSkill('手册B'), bigSkill('手册C')], {
    maxChars: 90_000
  })
  assert.ok(p.includes('## 技能：手册A'), '第一个技能应保留')
  assert.ok(p.includes('## 技能：手册B'), '第二个技能应保留')
  assert.ok(!p.includes('## 技能：手册C'), '超限的技能应整体丢弃（不做半截截断）')
  assert.ok(p.includes('已按上下文预算跳过 1 个技能'), '尾部应有可解释的跳过说明')
  assert.ok(p.includes('手册C'), '说明里应点名跳过了谁')
})

test('D14：预算收紧到连一个技能都塞不下时返回空串（不注入残缺内容）', () => {
  const p = buildSkillPrompt([{ name: 'A', description: '', content: 'x'.repeat(100) }], {
    maxChars: 10
  })
  assert.equal(p, '')
})

test('D14：未超预算时输出与旧版一致（无跳过说明，不回归）', () => {
  const p = buildSkillPrompt([
    { name: 'A', description: '描述', content: '正文' },
    { name: 'B', description: '', content: '正文B' }
  ])
  assert.ok(p.includes('# 已启用技能'))
  assert.ok(p.includes('## 技能：A'))
  assert.ok(!p.includes('已按上下文预算跳过'), '无跳过时不应出现说明')
  // 默认预算远大于示例，恒等路径
  assert.strictEqual(p.length, buildSkillPrompt([
    { name: 'A', description: '描述', content: '正文' },
    { name: 'B', description: '', content: '正文B' }
  ], { maxChars: SKILL_PROMPT_MAX_CHARS }).length)
})

test('D14：buildAgentSystemPrompt 保持三层拼装复不回归（含预算参数透传）', () => {
  const base = buildAgentSystemPrompt()
  assert.ok(base.includes('你是 eNSP 网络实验代理'))
  const withSkill = buildAgentSystemPrompt([{ name: 'S', description: 'D', content: 'C' }])
  assert.ok(withSkill.includes('# 已启用技能'))
  assert.ok(withSkill.startsWith(base))
})

// ———————————————————————— 外部工具预算 ————————————————————————

test('D14：fitExternalTools 条数超预算时整把跳过并点名', () => {
  const defs = Array.from({ length: 70 }, (_, i) => ({
    serverId: `s${i}`,
    serverName: 'fs',
    toolName: `t${i}`,
    namespaced: `mcp__fs__t${i}`,
    description: 'd',
    inputSchema: { type: 'object', properties: { a: i } },
    trusted: false
  }))
  const { kept, skipped } = fitExternalTools(defs, { maxTools: 64, maxSchemaChars: 12_000 })
  assert.equal(kept.length, 64)
  assert.equal(skipped.length, 6)
  assert.equal(skipped[0], 'mcp__fs__t64', '跳过的从超限处开始')
})

test('D14：fitExternalTools 单工具 schema 超长整把跳过', () => {
  const fatSchema = { type: 'object', properties: { big: { type: 'string', enum: ['a'.repeat(20_000)] } } }
  const defs = [
    { serverId: 's', serverName: 'fs', toolName: 'ok', namespaced: 'mcp__fs__ok', description: 'd', inputSchema: { type: 'object', properties: {} }, trusted: false },
    { serverId: 's', serverName: 'fs', toolName: 'fat', namespaced: 'mcp__fs__fat', description: 'd', inputSchema: fatSchema, trusted: false }
  ]
  const { kept, skipped } = fitExternalTools(defs, { maxTools: 64, maxSchemaChars: 1_000 })
  assert.deepEqual(kept.map((d) => d.namespaced), ['mcp__fs__ok'])
  assert.deepEqual(skipped, ['mcp__fs__fat'], 'schema 超长的工具不应半截注入')
})