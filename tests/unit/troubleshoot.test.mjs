import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findTroubleshootEpisodes,
  fixedEpisodes,
  buildTroubleshootTranscript,
  troubleshootDraftTitle,
  troubleshootDraftDescription,
  cleanDistilled
} from '../.build/harness.mjs'

/**
 * F13（2026-09-26）：经验沉淀 —— 从会话轨迹抽「失败 → 修正」片段，供模型提炼成排障技能。
 *
 * 核心判据是「后面出现过成功调用」：一路失败到底的片段不是经验，
 * 拿它沉淀出来的技能会教模型继续做错事。
 */

const tool = (id, at, name, ok, extra = {}) => ({
  id,
  parentId: 'p',
  role: 'tool',
  content: '',
  toolCall: { callId: id, name, args: { deviceId: 'd' }, ok, ...extra },
  createdAt: at
})

test('findTroubleshootEpisodes：每个失败开一段，遇到下一个失败即截断', () => {
  const nodes = [
    tool('n-1', 10, 'apply_config', true, { ms: 20 }),
    tool('n-2', 20, 'apply_config', false, { errorCode: 'FAILED', summary: '反掩码写错' }),
    tool('n-3', 30, 'lookup_vrp_command', true),
    tool('n-4', 40, 'apply_config', true, { ms: 15 }),
    tool('n-5', 50, 'verify_ping', false, { errorCode: 'FAILED' }),
    tool('n-6', 60, 'verify_ping', true)
  ]
  const eps = findTroubleshootEpisodes(nodes)
  assert.equal(eps.length, 2, '两次失败 = 两段')
  assert.equal(eps[0].failure.name, 'apply_config')
  assert.deepEqual(eps[0].after.map((s) => s.name), ['lookup_vrp_command', 'apply_config'], '到下一次失败前为止')
  assert.equal(eps[1].failure.name, 'verify_ping')
})

test('findTroubleshootEpisodes：maxAfter 限制每段后续调用数', () => {
  const nodes = [tool('n-0', 0, 'x', false)]
  for (let i = 1; i <= 8; i++) nodes.push(tool(`n-${i}`, i * 10, `t${i}`, true))
  assert.equal(findTroubleshootEpisodes(nodes, 3)[0].after.length, 3)
})

test('fixedEpisodes：只保留「失败之后确实成功过」的片段', () => {
  const failedOnly = { failure: { nodeId: 'a', at: 1, name: 'x', ok: false, argKey: '{}' }, after: [
    { nodeId: 'b', at: 2, name: 'y', ok: false, argKey: '{}' }
  ] }
  const fixed = { failure: { nodeId: 'c', at: 3, name: 'z', ok: false, argKey: '{}' }, after: [
    { nodeId: 'd', at: 4, name: 'w', ok: true, argKey: '{}' }
  ] }
  assert.deepEqual(fixedEpisodes([failedOnly, fixed]).map((e) => e.failure.name), ['z'])
})

test('buildTroubleshootTranscript：含失败行与后续调用，且可截断', () => {
  const eps = [
    {
      failure: { nodeId: 'a', at: 1, name: 'apply_config', ok: false, errorCode: 'FAILED', summary: '反掩码', argKey: '{d}' },
      after: [{ nodeId: 'b', at: 2, name: 'lookup_vrp_command', ok: true, ms: 5, argKey: '{}' }]
    }
  ]
  const text = buildTroubleshootTranscript(eps)
  assert.match(text, /## 场景 1/)
  assert.match(text, /✘ apply_config/)
  assert.match(text, /失败\(FAILED\)/)
  assert.match(text, /✔ lookup_vrp_command/)
  const short = buildTroubleshootTranscript(eps, 10)
  assert.match(short, /轨迹已截断/)
})

test('troubleshootDraftTitle / Description：工具名去重、说明来源', () => {
  const mk = (name) => ({ failure: { nodeId: 'n', at: 1, name, ok: false, argKey: '{}' }, after: [] })
  assert.equal(troubleshootDraftTitle([mk('a'), mk('a'), mk('b')]), '排障：a、b')
  assert.equal(troubleshootDraftTitle([]), '排障：实验失败复盘')
  assert.match(troubleshootDraftDescription([mk('a'), mk('a')]), /2 个「失败→修正」片段/)
})

test('cleanDistilled：剥代码围栏与引导语，空输入返回空串', () => {
  assert.equal(cleanDistilled('```markdown\n## 症状\nx\n```'), '## 症状\nx')
  assert.equal(cleanDistilled('技能正文：## 症状'), '## 症状')
  assert.equal(cleanDistilled(''), '')
})