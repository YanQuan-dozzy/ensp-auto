/**
 * 会话树 / 报告 / 消息队列（v0.4）测试。
 * 覆盖：JSONL 存储的建根/追加/重载/路径/坏行容忍，报告生成，排队注入，历史映射。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SessionTreeStore,
  buildMarkdown,
  buildJson,
  appendQueuedUserMessages,
  historyToMessages,
  nodesToMessages,
  formatMessageTime,
  matchTreeNodes,
  nearestUserAncestor,
  stripAttachmentNote
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

test('坏尾行容忍：损坏的 JSONL 尾巴不破坏整棵树，且不标 damaged', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('标题')
  store.append(root.id, node('n-a', 'assistant', 'A'))
  appendFileSync(path.join(dir, `tree-${root.id}.jsonl`), '{malformed\n', 'utf8')

  const reloaded = new SessionTreeStore({ dir })
  assert.equal(reloaded.getTree(root.id).length, 2)
  assert.equal(
    reloaded.list()[0].integrity,
    undefined,
    '尾部写了一半是可恢复的截断，不该被标成损坏'
  )
})

test('v2.14 中段坏行：标记 damaged、告警，但仍继续加载（不阻断）', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('标题')
  store.append(root.id, node('n-a', 'assistant', 'A'))
  // 在中间挖一行坏的，后面再补一行合法的 —— 这不是截断，是损坏
  const file = path.join(dir, `tree-${root.id}.jsonl`)
  appendFileSync(file, '{malformed\n', 'utf8')
  appendFileSync(file, `${JSON.stringify(node('n-b', 'assistant', 'B'))}\n`, 'utf8')

  const warnings = []
  const original = console.warn
  console.warn = (msg) => warnings.push(String(msg))
  try {
    const reloaded = new SessionTreeStore({ dir })
    // 不阻断：合法的两行照样读回来
    assert.deepEqual(
      reloaded.getTree(root.id).map((n) => n.id),
      [root.id, 'n-a', 'n-b']
    )
    assert.equal(reloaded.list()[0].integrity, 'damaged', '中段损坏必须被标记')
    assert.equal(warnings.length, 1, '必须告警一次')
    assert.equal(warnings[0].includes('损坏行'), true, '告警要说清是什么问题')
  } finally {
    console.warn = original
  }

  // 标记要落盘：新实例（不再解析这棵树）也能从索引里读到
  const third = new SessionTreeStore({ dir })
  assert.equal(third.list()[0].integrity, 'damaged', '标记应随索引持久化')
})

test('v2.14 整体损坏：一行都解析不出来时同样标 damaged', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('标题')
  // 把整个文件替换成垃圾（模拟被别的进程覆盖 / 磁盘错误）
  writeFileSync(path.join(dir, `tree-${root.id}.jsonl`), 'not json\nstill not json\n', 'utf8')

  const original = console.warn
  console.warn = () => {}
  try {
    const reloaded = new SessionTreeStore({ dir })
    assert.equal(reloaded.getTree(root.id).length, 0, '读不出节点就是空树')
    assert.equal(reloaded.list()[0].integrity, 'damaged', '整体损坏不能静默当成空会话')
  } finally {
    console.warn = original
  }
})

test('v2.14 合法 JSON 但缺 id 的行也算损坏，且不污染 owner 索引', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('标题')
  const file = path.join(dir, `tree-${root.id}.jsonl`)
  appendFileSync(file, '{"role":"assistant","content":"没有 id"}\n', 'utf8')
  appendFileSync(file, `${JSON.stringify(node('n-a', 'assistant', 'A'))}\n`, 'utf8')

  const original = console.warn
  console.warn = () => {}
  try {
    const reloaded = new SessionTreeStore({ dir })
    assert.deepEqual(reloaded.getTree(root.id).map((n) => n.id), [root.id, 'n-a'])
    assert.equal(reloaded.list()[0].integrity, 'damaged')
    // 缺 id 的行不该被登记为某个 root 的节点
    assert.equal(reloaded.getById('undefined'), undefined)
  } finally {
    console.warn = original
  }
})

test('v2.14 索引里的非法 integrity 值被归一化清除', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('标题')
  // 手改索引塞一个无法解释的状态
  writeFileSync(
    path.join(dir, 'sessions-index.json'),
    JSON.stringify({ version: 1, sessions: { [root.id]: { ...store.list()[0], integrity: 'weird' } } }),
    'utf8'
  )
  const reloaded = new SessionTreeStore({ dir })
  assert.equal(reloaded.list()[0].integrity, undefined, '只认 damaged 一个取值')
})

test('未知父节点追加抛错', (t) => {
  const store = new SessionTreeStore({ dir: tempDir(t) })
  assert.throws(() => store.append('nope', node('n-x', 'assistant', 'x')), /未知父节点/)
})

test('v2.2 置顶：置顶会话排在列表最前，重载后仍生效', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const a = store.createRoot('先建的会话')
  const b = store.createRoot('后建的会话')
  // 默认按 updatedAt 降序：b 在前
  assert.equal(store.list()[0].id, b.id)
  store.setSessionPinned(a.id, true)
  assert.equal(store.list()[0].id, a.id, '置顶的会话应排到最前')
  assert.equal(store.list()[0].pinned, true)
  store.setSessionPinned(a.id, false)
  assert.equal(store.list()[0].id, b.id, '取消置顶后按原序')

  const reloaded = new SessionTreeStore({ dir })
  reloaded.setSessionPinned(a.id, true)
  assert.equal(reloaded.list()[0].id, a.id, 'pinned 落盘后重载仍生效')
})

test('v2.2 重命名：索引与 root 节点标题一起更新，重载后一致', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('旧标题')
  store.append(root.id, node('n-a', 'assistant', 'A'))
  assert.equal(store.renameSession(root.id, ' 新标题 '), true)
  assert.equal(store.list()[0].title, '新标题')
  assert.equal(store.getTree(root.id)[0].title, '新标题', 'jsonl 首行 root 节点的 title 也要更新')

  const reloaded = new SessionTreeStore({ dir })
  assert.equal(reloaded.list()[0].title, '新标题')
  assert.equal(reloaded.getTree(root.id)[0].title, '新标题')
  // 空标题 / 未变 / 不存在都是 false
  assert.equal(store.renameSession(root.id, ''), false)
  assert.equal(store.renameSession(root.id, '新标题'), false)
  assert.equal(store.renameSession('s-nonexistent', 'x'), false)
})

test('v2.2 删除单个会话：索引/文件/缓存一致，owner 无孤儿', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const keep = store.createRoot('保留的会话')
  const gone = store.createRoot('要删除的会话')
  const a = store.append(gone.id, node('n-a', 'assistant', 'A'))
  store.append(a.id, node('n-b', 'tool', 'scan_devices', { toolCall: { callId: 'c', name: 'scan_devices', args: {}, ok: true } }))

  assert.equal(store.deleteSession(gone.id), true)
  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0].id, keep.id)
  assert.equal(store.getTree(gone.id).length, 0, '缓存与索引都应清除')
  assert.equal(store.deleteSession(gone.id), false, '重复删除返回 false')

  const reloaded = new SessionTreeStore({ dir })
  assert.equal(reloaded.list().length, 1)
  assert.equal(reloaded.list()[0].id, keep.id, '磁盘上的 jsonl 也应被删掉')
})

test('v2.2 思考段：落树 → 历史载入还原为 thinking 消息，且不进模型上下文', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('目标')
  // 模拟运行期落节点顺序：思考 → 正文 → 思考 → 正文
  const t1 = store.append(root.id, node('n-t1', 'thinking', '先看看设备在线情况'))
  const a1 = store.append(t1.id, node('n-a1', 'assistant', '我先摸清现状'))
  const t2 = store.append(a1.id, node('n-t2', 'thinking', 'PDF 读不了，换端口扫描'))
  store.append(t2.id, node('n-a2', 'assistant', '设备在线情况已拿到'))

  const reloaded = new SessionTreeStore({ dir })
  const tree = reloaded.getTree(root.id)
  assert.equal(tree.length, 5)

  // 历史载入：thinking 节点必须还原成界面的「思考」行（否则历史里整段消失）
  const msgs = nodesToMessages(tree)
  assert.deepEqual(
    msgs.map((m) => m.kind),
    ['user', 'thinking', 'assistant', 'thinking', 'assistant']
  )
  assert.equal(msgs[1].text, '先看看设备在线情况')

  // 但思考不回放给模型：只留 user / assistant
  const forModel = historyToMessages(tree)
  assert.deepEqual(
    forModel.map((m) => m.role),
    ['user', 'assistant', 'assistant']
  )
  assert.ok(
    !JSON.stringify(forModel).includes('先看看设备在线情况'),
    '思考内容不应注入模型上下文'
  )
})

test('v2.2 思考段：Markdown 导出含「思考」引用块', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('做实验')
  const t1 = store.append(root.id, node('n-t1', 'thinking', '第一行推理\n第二行推理'))
  store.append(t1.id, node('n-a1', 'assistant', '结论'))

  const md = buildMarkdown(store.list()[0], store.getTree(root.id))
  assert.ok(md.includes('## 思考'))
  assert.ok(md.includes('> 第一行推理'))
  assert.ok(md.includes('> 第二行推理'))
  assert.ok(md.includes('## 代理'))
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

// ————— v2.12：节点截断（删除 / 重新生成的底层） —————

/** 建一棵典型树：root(指令) → t1(思考) → a1(正文) → tl1(工具) → a2(正文)，再加一条分支 b1 */
function treeWithBranch(t) {
  const store = new SessionTreeStore({ dir: tempDir(t) })
  const root = store.createRoot('目标')
  const t1 = store.append(root.id, node('n-t1', 'thinking', '想想'))
  const a1 = store.append(t1.id, node('n-a1', 'assistant', '先摸底'))
  const tl1 = store.append(a1.id, node('n-tl1', 'tool', 'scan_devices', { toolCall: { callId: 'c1', name: 'scan_devices', args: {}, ok: true, ms: 5 } }))
  const a2 = store.append(tl1.id, node('n-a2', 'assistant', '结论'))
  // 一条兄弟分支（b1），删除 a1 子树后它必须毫发无损
  const b1 = store.append(root.id, node('n-b1', 'assistant', '兄弟分支'))
  return { store, root, t1, a1, tl1, a2, b1 }
}

test('v2.12 deleteFromNode：截断自身+全部后代，兄弟与祖先保留', (t) => {
  const { store, root, a1 } = treeWithBranch(t)

  // a1 的祖先链是 root → t1 → a1：删 a1 只带走它自己和后代（tl1/a2），父节点 t1 保留
  const r = store.deleteFromNode(root.id, a1.id)
  assert.equal(r.removed, 3, 'a1 + tl1 + a2 一共 3 个节点')
  assert.equal(r.newTailId, 'n-t1', '新尾部是被删节点的父节点 t1')

  const tree = store.getTree(root.id)
  assert.deepEqual(tree.map((n) => n.id), [root.id, 'n-t1', 'n-b1'], '祖先与兄弟分支都保留')
  assert.equal(store.list()[0].nodeCount, 3, '索引 nodeCount 同步')
})

test('v2.12 deleteFromNode：落盘重写（新实例读回）+ nodeCount 一致', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('目标')
  const t1 = store.append(root.id, node('n-t1', 'thinking', '想想'))
  store.append(t1.id, node('n-a1', 'assistant', '先摸底'))

  store.deleteFromNode(root.id, 'n-t1')
  const reloaded = new SessionTreeStore({ dir })
  assert.deepEqual(reloaded.getTree(root.id).map((n) => n.id), [root.id], 'jsonl 已整份重写')
  assert.equal(reloaded.list()[0].nodeCount, 1)
})

test('v2.12 deleteFromNode keepSelf：root 只删后代（重新生成首条指令场景）', (t) => {
  const { store, root, t1 } = treeWithBranch(t)
  const r = store.deleteFromNode(root.id, root.id, { keepSelf: true })
  assert.equal(r.removed, 5, '后代全删（t1/a1/tl1/a2/b1），root 自己保留')
  assert.equal(r.newTailId, root.id, 'keepSelf 时新尾部就是自身')
  const tree = store.getTree(root.id)
  assert.deepEqual(tree.map((n) => n.id), [root.id])
  assert.equal(tree[0].content, '目标', 'root 内容原样保留')
  void t1
})

test('v2.12 deleteFromNode 守卫：删 root 抛错、未知会话/节点抛错', (t) => {
  const { store, root } = treeWithBranch(t)
  assert.throws(() => store.deleteFromNode(root.id, root.id), /不能删除会话根节点/)
  assert.throws(() => store.deleteFromNode('s-unknown', root.id), /未知会话/)
  assert.throws(() => store.deleteFromNode(root.id, 'n-nope'), /未知节点/)
})

test('v2.12 deleteFromNode：lastDoneNodeId 悬挂修正 + resumable 不翻回 true', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('目标')
  const a1 = store.append(root.id, node('n-a1', 'assistant', 'A'))
  const a2 = store.append(a1.id, node('n-a2', 'assistant', 'B'))
  store.markSettled(root.id, a2.id) // 落定：lastDoneNodeId=a2，resumable=false

  store.deleteFromNode(root.id, 'n-a2') // 删掉的正是 lastDoneNodeId 指向的节点
  const tree = store.getTree(root.id)
  assert.equal(tree[0].lastDoneNodeId, 'n-a1', '悬挂指针改指新尾部')
  assert.equal(store.list()[0].resumable, false, '手动删改不触发「继续上次任务」提示')

  store.deleteFromNode(root.id, 'n-a1')
  assert.equal(
    store.getTree(root.id)[0].lastDoneNodeId,
    undefined,
    '新尾部是 root 时悬挂指针直接删除'
  )
})

// ————— v2.12：UI 消息 ↔ 树节点 对齐（删除/重新生成的定位层） —————

const treeNode = (id, parentId, role, content, over = {}) => ({
  id,
  parentId,
  role,
  content,
  createdAt: Date.now(),
  ...over
})

test('v2.12 matchTreeNodes：角色计数配对，容忍 assistant/工具的合理顺序差', () => {
  const nodes = [
    treeNode('r', null, 'user', '目标'),
    treeNode('n-t1', 'r', 'thinking', '想想'),
    treeNode('n-a1', 'n-t1', 'assistant', '先摸底'),
    treeNode('n-tl1', 'n-a1', 'tool', '扫描完成', { toolCall: { callId: 'c1', name: 'scan_devices', args: {}, ok: true } }),
    treeNode('n-a2', 'n-tl1', 'assistant', '设备在线情况已拿到')
  ]
  // 渲染层顺序：工具消息先于后一段 assistant（与树的落盘顺序存在合理差异）
  const messages = [
    { kind: 'user', id: 'm1', text: '目标' },
    { kind: 'thinking', id: 'm2', text: '想想' },
    { kind: 'assistant', id: 'm3', text: '先摸底' },
    { kind: 'tool', id: 'm4', callId: 'c1', name: 'scan_devices', args: {}, risk: 'read', status: 'ok' },
    { kind: 'assistant', id: 'm5', text: '设备在线情况已拿到' }
  ]
  const map = matchTreeNodes(messages, nodes)
  assert.deepEqual(
    [...map.entries()],
    [['m1', 'r'], ['m2', 'n-t1'], ['m3', 'n-a1'], ['m4', 'n-tl1'], ['m5', 'n-a2']]
  )
})

test('v2.12 matchTreeNodes：附件注记剥离 + 内容不符不映射（宁可删不了不删错）', () => {
  const nodes = [treeNode('r', null, 'user', '帮我配 OSPF')]
  const map = matchTreeNodes(
    [{ kind: 'user', id: 'm1', text: '帮我配 OSPF\n\n📎 topo.txt（12 B）' }],
    nodes
  )
  assert.equal(map.get('m1'), 'r', '📎 注记行剥掉后应命中')

  const miss = matchTreeNodes([{ kind: 'user', id: 'm2', text: '完全不同的一条' }], nodes)
  assert.equal(miss.has('m2'), false, '内容对不上必须停，不许按下标硬配')

  const missTool = matchTreeNodes(
    [{ kind: 'tool', id: 'm3', callId: 'c-unknown', name: 'x', args: {}, risk: 'read', status: 'ok' }],
    nodes
  )
  assert.equal(missTool.has('m3'), false, 'callId 对不上的工具消息不映射')

  // system / finish / plan 是纯 UI 消息，不参与映射
  const uiOnly = matchTreeNodes(
    [{ kind: 'system', id: 'm4', text: '提示', tone: 'info' }],
    nodes
  )
  assert.equal(uiOnly.size, 0)
})

test('v2.12 nearestUserAncestor：从回答跨工具/思考层找指令；找不到返回 null', () => {
  const nodes = [
    treeNode('r', null, 'user', '目标'),
    treeNode('n-t1', 'r', 'thinking', '想想'),
    treeNode('n-tl1', 'n-t1', 'tool', '扫描', { toolCall: { callId: 'c1', name: 's', args: {}, ok: true } }),
    treeNode('n-a1', 'n-tl1', 'assistant', '结论')
  ]
  assert.equal(nearestUserAncestor(nodes, 'n-a1')?.id, 'r', '跨 tool/thinking 层向上找')
  assert.equal(nearestUserAncestor(nodes, 'r')?.id, 'r', 'user 节点自身即锚点（含自身）')
  assert.equal(nearestUserAncestor(nodes, 'n-missing'), null, '未知节点')
  const broken = [treeNode('orphan', 'ghost', 'assistant', '父节点不存在')]
  assert.equal(nearestUserAncestor(broken, 'orphan'), null, '链断不炸')
})

test('v2.12 stripAttachmentNote：只剥 📎 行，正文原样保留', () => {
  assert.equal(stripAttachmentNote('帮我配 OSPF\n\n📎 a.txt（12 B）\n📎 b.pdf（1 KB）'), '帮我配 OSPF')
  assert.equal(stripAttachmentNote('没有附件的指令'), '没有附件的指令')
  assert.equal(stripAttachmentNote('  前后空格  '), '前后空格', 'trim 掉首尾空白便于比对')
})

test('v2.12 formatMessageTime：对齐参考图 2 的时间戳格式化', () => {
  assert.equal(formatMessageTime(undefined), '')
  assert.equal(formatMessageTime(0), '')

  const now = new Date()
  const todayMs = now.getTime()
  const pad = (n) => String(n).padStart(2, '0')
  assert.equal(formatMessageTime(todayMs), `今天 ${pad(now.getHours())}:${pad(now.getMinutes())}`)

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  assert.equal(
    formatMessageTime(yesterday.getTime()),
    `昨天 ${pad(yesterday.getHours())}:${pad(yesterday.getMinutes())}`
  )
})

// ——————————————————— v2.26：重新生成（↺）按钮的点不进/点不动 ———————————————————

/**
 * 事故背景（用户报告「重新生成按钮不能正常使用」）：
 *
 * 点回答上的 ↺ 要先把「这条 UI 消息」对上「会话树里的节点」，对不上就只回一句
 * 「无法定位该消息在会话树中的位置，暂不能重新生成」。旧实现里游标是**先取再进**的：
 * `candidates[k]` 取完立刻 `k+1`，之后才校验内容 —— 于是一条对不上的消息会把游标永久推走，
 * 同角色后面每一条都错位一格，内容校验跟着全灭，整条回答都找不到自己的节点。
 *
 * 而「界面比树多出一条 assistant」是**常规事件**，不是异常数据：
 * `react.runtime` 每次重试都换新累加器（半截输出「只留在界面里」，不进树），
 * 所以只要发生过一次请求失败重试，界面就比树多一条 assistant 消息。
 */

test('v2.26 matchTreeNodes：失败重试的半截输出不再让整类映射报废（★ 用户报的 bug）', () => {
  const nodes = [
    treeNode('r', null, 'user', '给 LSW18 配中文编码'),
    treeNode('n-a1', 'r', 'assistant', '先看设备现状'),
    treeNode('n-tl1', 'n-a1', 'tool', 'list_devices', {
      toolCall: { callId: 'c1', name: 'list_devices', args: {}, ok: true }
    }),
    treeNode('n-a2', 'n-tl1', 'assistant', '中文编码已切换完成，验证通过。')
  ]
  // 界面：第一轮请求流出了半截正文后超时失败 → 重试换新累加器（半截输出只留在界面里）
  const messages = [
    { kind: 'user', id: 'm1', text: '给 LSW18 配中文编码' },
    { kind: 'assistant', id: 'm2', text: '先看设备现状' },
    { kind: 'tool', id: 'm3', callId: 'c1', name: 'list_devices', args: {}, risk: 'read', status: 'ok' },
    { kind: 'assistant', id: 'm4', text: '中文编码已切换' }, // ← 半截输出：树里没有
    { kind: 'system', id: 'm5', text: '请求失败，1.0s 后重试（第 1/3 次）：超时', tone: 'info' },
    { kind: 'assistant', id: 'm6', text: '中文编码已切换完成，验证通过。' }
  ]
  const map = matchTreeNodes(messages, nodes)
  assert.equal(map.get('m6'), 'n-a2', '★ 最终回答必须仍落在自己的节点上（↺ 靠它定位）')
  assert.equal(map.has('m4'), false, '半截输出在树里没有对应节点，不该映射')
  assert.deepEqual(
    [...map.entries()],
    [['m1', 'r'], ['m2', 'n-a1'], ['m3', 'n-tl1'], ['m6', 'n-a2']]
  )
})

test('v2.26 matchTreeNodes：空白壳不占游标；半截输出与完整输出同前缀也不误配', () => {
  const full = '这是一段足够长的最终回答，用来验证前缀兜底不会把半截输出错配到完整输出的节点上。'
  const nodes = [treeNode('r', null, 'user', '目标'), treeNode('n-a1', 'r', 'assistant', full)]
  const map = matchTreeNodes(
    [
      { kind: 'user', id: 'm1', text: '目标' },
      { kind: 'assistant', id: 'm2', text: '  \n' }, // 空白壳：主进程 flushAssistant 会跳过空白内容
      { kind: 'assistant', id: 'm3', text: full.slice(0, 30) }, // 半截输出（与完整输出同前缀）
      { kind: 'assistant', id: 'm4', text: full }
    ],
    nodes
  )
  assert.deepEqual([...map.entries()], [['m1', 'r'], ['m4', 'n-a1']], '只有逐字相同的那条配得上')
})

test('v2.26 matchTreeNodes：树多出同类节点时窗口内重新对齐，窗口外宁可不映射', () => {
  const nodes = [
    treeNode('r', null, 'user', '目标'),
    treeNode('n-a0', 'r', 'assistant', '历史遗留的一条回答（界面里没有）'),
    treeNode('n-a1', 'n-a0', 'assistant', '第二条')
  ]
  const map = matchTreeNodes(
    [
      { kind: 'user', id: 'm1', text: '目标' },
      { kind: 'assistant', id: 'm2', text: '第二条' }
    ],
    nodes
  )
  assert.equal(map.get('m2'), 'n-a1', '跳过树里多出的同类节点，重新对上下一条')

  // 窗口外（≥5 条同类节点都没对上）→ 判定「树里没有这条」，绝不硬配
  const far = [
    ...Array.from({ length: 6 }, (_, i) => treeNode(`n-x${i}`, 'r', 'assistant', `无关 ${i}`)),
    treeNode('n-target', 'r', 'assistant', '目标句')
  ]
  const miss = matchTreeNodes([{ kind: 'assistant', id: 'm9', text: '目标句' }], far)
  assert.equal(miss.has('m9'), false, '超出窗口就是「树里没有」—— 宁可删不了，也不删错')
})

test('v2.26 deleteFromNode：清掉已删轮的收尾记录（否则重新生成后凭空多出旧收尾卡）', (t) => {
  const dir = tempDir(t)
  const store = new SessionTreeStore({ dir })
  const root = store.createRoot('第一条指令')
  const a1 = store.append(root.id, node('n-a1', 'assistant', '回答一'))
  const u2 = store.append(a1.id, node('n-u2', 'user', '第二条指令'))
  store.append(u2.id, node('n-a2', 'assistant', '回答二'))
  store.recordTurnFinish(root.id, root.id, { reason: 'completed', ms: 1000 })
  store.recordTurnFinish(root.id, u2.id, { reason: 'completed', ms: 2000 })

  // 删掉第二条指令所在分支 → 它的收尾记录一并消失
  store.deleteFromNode(root.id, u2.id)
  const reloaded = new SessionTreeStore({ dir })
  assert.deepEqual(
    Object.keys(reloaded.getTree(root.id)[0].turnFinishes ?? {}),
    [root.id],
    '只剩第一轮的记录'
  )

  // keepSelf（＝重新生成第一条指令的回答）：root 自己的记录也清掉，且不留空对象
  store.deleteFromNode(root.id, root.id, { keepSelf: true })
  const after = new SessionTreeStore({ dir })
  const tree = after.getTree(root.id)
  assert.equal(tree[0].turnFinishes, undefined, '记录清空后字段一并删掉')
  assert.equal(
    nodesToMessages(tree).some((m) => m.kind === 'finish'),
    false,
    '★ 历史回放不再在第一条指令下面合成一张凭空的收尾卡'
  )
})