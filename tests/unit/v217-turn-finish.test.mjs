/**
 * v2.16：逐轮收尾信息落盘（turnFinishes）+ 历史回放合成收尾卡。
 *
 * 实时流的收尾卡（耗时 / 用量 / 模型）是渲染层从 usage/done 事件现攒的，
 * 历史回放里没有这些事件 —— 不落盘历史就只剩一行光秃秃的「已完成」。
 * 这批用例守两件事：
 * ① 宿主把收尾信息按「轮的 user 节点 id」写进 root.turnFinishes，且重启后能读回；
 * ② nodesToMessages 据此在每轮末尾合成 finish 消息（带 usage / model）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionTreeStore, nodesToMessages } from '../.build/harness.mjs'

let seq = 0
const tempDir = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), `ensp-v216-finish-${++seq}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const USAGE = { rounds: 5, promptTokens: 80000, outputTokens: 7000, measured: true, contextWindow: 128000, lastRatio: 0.7 }

// ————————————————————— 落盘：recordTurnFinish —————————————————————

test('★ recordTurnFinish：按轮的 user 节点 id 写入 root，重启后能读回', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('查配置')
  const a = store.append(root.id, { id: 'n-a1', role: 'assistant', content: '回答' })

  store.recordTurnFinish(root.id, root.id, {
    reason: 'completed',
    ms: 14000,
    usage: USAGE,
    model: 'deepseek-flash'
  })

  const reloaded = new SessionTreeStore({ dir })
  const nodes = reloaded.getTree(root.id)
  const rec = nodes[0]?.turnFinishes?.[root.id]
  assert.ok(rec, '重启后 root.turnFinishes 应存在')
  assert.equal(rec.reason, 'completed')
  assert.equal(rec.ms, 14000)
  assert.equal(rec.model, 'deepseek-flash')
  assert.deepEqual(rec.usage, USAGE)
  assert.equal(a.role, 'assistant') // 尾节点不受影响
})

test('★ 多轮：各轮按各自的 user 节点分键；同节点重复收尾以最后一次为准', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('第一轮指令')
  const u2 = store.append(root.id, { id: 'n-u2', role: 'user', content: '第二轮指令' })
  store.append(u2.id, { id: 'n-a2', role: 'assistant', content: '第二轮回答' })

  store.recordTurnFinish(root.id, root.id, { reason: 'completed', ms: 1000 })
  store.recordTurnFinish(root.id, u2.id, { reason: 'completed', ms: 2000 })
  store.recordTurnFinish(root.id, u2.id, { reason: 'aborted', ms: 3000 })

  const finishes = store.getTree(root.id)[0]?.turnFinishes ?? {}
  assert.equal(finishes[root.id]?.ms, 1000)
  assert.equal(finishes[u2.id]?.ms, 3000)
  assert.equal(finishes[u2.id]?.reason, 'aborted')
})

test('recordTurnFinish：不存在的 root / 写盘失败不抛错', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  assert.doesNotThrow(() => store.recordTurnFinish('s-notexist', 'n-x', { reason: 'failed', ms: 1 }))
})

// ————————————————————— 回放：nodesToMessages 合成收尾卡 —————————————————————

test('★ nodesToMessages：在每轮末尾合成 finish 消息，带 usage / model', () => {
  const nodes = [
    { id: 's-root', parentId: null, role: 'user', content: '第一轮指令', createdAt: 1, turnFinishes: { 's-root': { reason: 'completed', ms: 14000, usage: USAGE, model: 'deepseek-flash' } } },
    { id: 'n-th', parentId: 's-root', role: 'thinking', content: '推理', createdAt: 2 },
    { id: 'n-a1', parentId: 'n-th', role: 'assistant', content: '回答', createdAt: 3 },
    { id: 'n-u2', parentId: 'n-a1', role: 'user', content: '第二轮指令', createdAt: 4 },
    { id: 'n-a2', parentId: 'n-u2', role: 'assistant', content: '还没跑完', createdAt: 5 }
  ]
  const msgs = nodesToMessages(nodes)
  assert.equal(msgs.length, 6)
  const f = msgs[3]
  assert.equal(f.kind, 'finish')
  assert.equal(f.id, 'finish-s-root')
  assert.equal(f.reason, 'completed')
  assert.equal(f.ms, 14000)
  assert.deepEqual(f.usage, USAGE)
  assert.equal(f.model, 'deepseek-flash')
  // 位置：第一轮末尾（下一条 user 之前），第二轮没有记录则不合成
  assert.equal(msgs[4].id, 'n-u2')
  assert.equal(msgs[5].id, 'n-a2')
})

test('nodesToMessages：无 turnFinishes 时输出与节点一一对应（向后兼容）', () => {
  const nodes = [
    { id: 's-root', parentId: null, role: 'user', content: '指令', createdAt: 1 },
    { id: 'n-a1', parentId: 's-root', role: 'assistant', content: '回答', createdAt: 2 }
  ]
  const msgs = nodesToMessages(nodes)
  assert.deepEqual(
    msgs.map((m) => m.kind),
    ['user', 'assistant']
  )
})

test('nodesToMessages：收尾记录缺 usage / model 时字段缺省（不渲染空值）', () => {
  const nodes = [
    {
      id: 's-root',
      parentId: null,
      role: 'user',
      content: '指令',
      createdAt: 1,
      turnFinishes: { 's-root': { reason: 'failed', ms: 500 } }
    },
    { id: 'n-a1', parentId: 's-root', role: 'assistant', content: '回答', createdAt: 2 }
  ]
  const msgs = nodesToMessages(nodes)
  const f = msgs.find((m) => m.kind === 'finish')
  assert.ok(f)
  assert.equal(f.reason, 'failed')
  assert.equal(f.usage, undefined)
  assert.equal(f.model, undefined)
})
