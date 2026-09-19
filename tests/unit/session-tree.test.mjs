/**
 * 会话树 / 报告 / 消息队列（v0.4）测试。
 * 覆盖：JSONL 存储的建根/追加/重载/路径/坏行容忍，报告生成，排队注入，历史映射。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SessionTreeStore,
  buildMarkdown,
  buildJson,
  appendQueuedUserMessages,
  historyToMessages
} from '../.build/harness.mjs'

let seq = 0
function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), `ensp-v04-${++seq}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const node = (id, role, content, over = {}) => ({ id, role, content, createdAt: Date.now(), ...over })

test('建根与追加：索引更新、排序、nodeCount', (t) => {
  const store = new SessionTreeStore({ dir: tempDir(t) })
  assert.equal(store.list().length, 0)
  const root = store.createRoot('第一条指令')
  assert.equal(root.role, 'user')
  assert.equal(root.parentId, null)
  assert.equal(store.list().length, 1)

  const a = store.append(root.id, node('n-a', 'assistant', '回答'))
  store.append(a.id, node('n-b', 'tool', 'scan_devices', { toolCall: { callId: 'c1', name: 'scan_devices', args: {}, ok: true, ms: 5 } }))
  const meta = store.list()[0]
  assert.equal(meta.nodeCount, 3)
  assert.equal(meta.title, '第一条指令')
  assert.ok(meta.updatedAt >= meta.createdAt)
})

test('重载重建：新实例读回全部节点，pathTo 返回祖先链', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('标题')
  const a = store.append(root.id, node('n-a', 'assistant', 'A'))
  const b = store.append(a.id, node('n-b', 'user', '纠偏'))
  store.append(b.id, node('n-c', 'assistant', 'B'))

  const reloaded = new SessionTreeStore({ dir })
  const tree = reloaded.getTree(root.id)
  assert.equal(tree.length, 4)
  const chain = reloaded.pathTo(root.id, 'n-c')
  assert.deepEqual(chain.map((n) => n.id), [root.id, 'n-a', 'n-b', 'n-c'])
  const kids = reloaded.childrenOf(root.id, 'n-b')
  assert.deepEqual(kids.map((n) => n.id), ['n-c'])
})

test('坏尾行容忍：损坏的 JSONL 尾巴不破坏整棵树', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('标题')
  store.append(root.id, node('n-a', 'assistant', 'A'))
  appendFileSync(path.join(dir, `tree-${root.id}.jsonl`), '{malformed\n', 'utf8')

  const reloaded = new SessionTreeStore({ dir })
  assert.equal(reloaded.getTree(root.id).length, 2)
})

test('未知父节点追加抛错', (t) => {
  const store = new SessionTreeStore({ dir: tempDir(t) })
  assert.throws(() => store.append('nope', node('n-x', 'assistant', 'x')), /未知父节点/)
})

test('buildMarkdown / buildJson 内容', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('做实验')
  const a = store.append(root.id, node('n-a', 'assistant', '好的，开始'))
  store.append(a.id, node('n-b', 'tool', 'scan_devices(扫描)', { toolCall: { callId: 'c1', name: 'scan_devices', args: { start: 2000 }, ok: false, ms: 8 } }))

  const meta = store.list()[0]
  const md = buildMarkdown(meta, store.getTree(root.id))
  assert.ok(md.includes('# 做实验'))
  assert.ok(md.includes('好的，开始'))
  assert.ok(md.includes('scan_devices'))
  assert.ok(md.includes('失败'))

  const json = JSON.parse(buildJson(meta, store.getTree(root.id)))
  assert.equal(json.root.id, root.id)
  assert.equal(json.nodes.length, 3)
})

test('appendQueuedUserMessages：追加 user 消息、过滤空白、返回条数', () => {
  const messages = [{ role: 'user', content: '原指令', timestamp: 1 }]
  const n = appendQueuedUserMessages(messages, [' 纠偏 ', '  ', '再加一句'], 100)
  assert.equal(n, 2)
  assert.equal(messages.length, 3)
  assert.equal(messages[1].role, 'user')
  assert.equal(messages[1].content, '纠偏')
  assert.equal(messages[2].timestamp, 100)
})

test('historyToMessages：用户/助手/工具映射', () => {
  const msgs = historyToMessages([
    node('r', 'user', '目标'),
    node('a', 'assistant', '回答'),
    node('t', 'tool', 'scan_devices', { toolCall: { callId: 'c', name: 'scan_devices', args: { a: 1 }, ok: true } })
  ])
  assert.equal(msgs.length, 3)
  assert.equal(msgs[0].role, 'user')
  assert.equal(msgs[0].content, '目标')
  assert.equal(msgs[1].role, 'assistant')
  assert.equal(msgs[1].content[0].type, 'text')
  assert.equal(msgs[2].role, 'user') // 工具折叠为文本
  assert.ok(msgs[2].content.includes('scan_devices'))
})