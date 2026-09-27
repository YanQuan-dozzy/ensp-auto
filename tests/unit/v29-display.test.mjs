/**
 * v2.9（P5）：展示组件 —— 消息切段 / 长回显折叠 / 结构化结果卡 / 结构化载荷闸门。
 *
 * 这批用例守的是四条「坏了不会报错、只会悄悄变丑或变慢」的线：
 *  1. **切段的引用稳定性**：`React.memo` 是逐元素比较的 —— 若每次返回新对象，
 *     流式期间整条消息流全量重渲染（掉帧），且症状只是「卡」，不会抛错。
 *  2. **工具组不能按 key 复用**：组 key 在整组生命周期内不变，但组内工具会从
 *     `running` 变 `ok`；只比 key 会把旧快照一直复用，界面永远转圈。
 *  3. **结构化载荷的尺寸闸门**：必须挡住整份配置 / 整张拓扑进事件流。
 *  4. **结构化结果的降级**：data 形状变了要「认不出就不画」，绝不能抛错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  groupMessages,
  segmentKey,
  hasRenderableContent,
  dropEmptyMessages,
  planRawCollapse,
  RAW_COLLAPSE_LINES,
  buildStructuredView,
  describeDiff,
  DIFF_PREVIEW_LINES,
  smallToolData
} from '../.build/harness.mjs'

// ————————————————————— 工具桩 —————————————————————

const user = (id, text) => ({ kind: 'user', id, text })
const assistant = (id, text) => ({ kind: 'assistant', id, text })
const thinking = (id, text) => ({ kind: 'thinking', id, text })
const tool = (id, name, over = {}) => ({
  kind: 'tool',
  id,
  callId: `c-${id}`,
  name,
  args: {},
  risk: 'read',
  status: 'ok',
  ms: 1,
  ...over
})

// ————————————————————— 切段 —————————————————————

test('groupMessages：连续工具调用并成一组，其它消息打断', () => {
  const segs = groupMessages([
    user('u1', '目标'),
    tool('t1', 'scan_devices'),
    tool('t2', 'connect_device'),
    assistant('a1', '开始了'),
    tool('t3', 'run_show_command')
  ])
  assert.equal(segs.length, 4)
  assert.equal(segs[0].kind, 'user')
  assert.equal(segs[1].kind, 'toolGroup')
  assert.equal(segs[1].items.length, 2, '两个连续工具并成一组')
  assert.equal(segs[2].kind, 'assistant')
  assert.equal(segs[3].kind, 'toolGroup')
  assert.equal(segs[3].items.length, 1, '被助手消息打断后的工具自成一组')
})

test('groupMessages：只有工具调用时合成一组，没有孤立空组', () => {
  const segs = groupMessages([tool('t1', 'a'), tool('t2', 'b')])
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, 'toolGroup')
  assert.equal(segs[0].items.length, 2)
  // 没有工具的空输入 → 空结果（不能产出 items 为空的组）
  assert.deepEqual(groupMessages([]), [])
  assert.equal(groupMessages([assistant('a1', 'x')]).length, 1)
})

test('groupMessages：组 key 取首个工具的 id（同前缀稳定）', () => {
  const segs = groupMessages([tool('t1', 'a'), tool('t2', 'b')])
  assert.equal(segs[0].key, 'tg-t1')
  assert.equal(segmentKey(segs[0]), 'tg-t1')
  assert.equal(segmentKey(user('u1', 'x')), 'u1')
})

test('★ groupMessages：未变化的前缀复用同一个对象（memo 才能生效）', () => {
  const head = [user('u1', '目标'), assistant('a1', '开始'), tool('t1', 'scan_devices')]
  const first = groupMessages(head)
  // 追加一条新消息（模拟流式）—— 前面的段必须原样复用
  const second = groupMessages([...head, assistant('a2', '继续')], first)

  assert.equal(second.length, first.length + 1)
  assert.equal(second[0], first[0], '第 0 段必须是同一个对象引用')
  assert.equal(second[1], first[1], '第 1 段必须是同一个对象引用')
  assert.equal(second[2], first[2], '未变化的工具组也要复用（整段前缀稳定才是目标）')
  // 只有新加的那一段是新建的
  assert.notEqual(second[3], first[3])
})

test('★ groupMessages：前缀里某一项变了，只有它自己重建（后续未变的仍复用）', () => {
  const head = [user('u1', '目标'), assistant('a1', '开始'), tool('t1', 'scan_devices')]
  const first = groupMessages(head)
  // 改掉中间那条 assistant（模拟流式追加到已有 assistant 文本上）
  const changed = [head[0], assistant('a1', '开始，先扫描设备'), head[2]]
  const second = groupMessages(changed, first)

  assert.equal(second[0], first[0], '前面的没变 → 复用')
  assert.notEqual(second[1], first[1], '变了的这条要重建')
  assert.equal(second[2], first[2], '它后面的工具组没变 → 仍复用')
})

test('★ groupMessages：组内工具状态变化时必须重建（不能按 key 复用旧快照）', () => {
  const running = [tool('t1', 'scan_devices', { status: 'running' }), tool('t2', 'x', { status: 'running' })]
  const first = groupMessages(running)
  // 模拟第一个工具完成：items 数组换了新对象
  const done = [tool('t1', 'scan_devices', { status: 'ok' }), running[1]]
  const second = groupMessages(done, first)

  assert.equal(second[0].kind, 'toolGroup')
  assert.notEqual(second[0], first[0], '组内状态变了就不能复用旧组，否则界面永远显示「执行中」')
  assert.equal(second[0].items[0].status, 'ok')
})

test('★ groupMessages：组变短（条目减少）时不能复用', () => {
  const three = [tool('t1', 'a'), tool('t2', 'b'), tool('t3', 'c')]
  const first = groupMessages(three)
  const two = groupMessages([three[0], three[1]], first)
  assert.notEqual(two[0], first[0])
  assert.equal(two[0].items.length, 2)
})

test('groupMessages：prev 为空/未传都不影响正确性', () => {
  const list = [user('u1', 'x'), tool('t1', 'a')]
  assert.deepEqual(
    groupMessages(list).map((s) => segmentKey(s)),
    groupMessages(list, []).map((s) => segmentKey(s))
  )
})

// ————————————————————— 空壳过滤 —————————————————————

test('★ hasRenderableContent：空的 assistant / thinking / system 是空壳', () => {
  assert.equal(hasRenderableContent(assistant('a1', '')), false)
  assert.equal(hasRenderableContent(assistant('a1', '   \n  ')), false)
  assert.equal(hasRenderableContent(thinking('k1', '')), false)
  assert.equal(hasRenderableContent({ kind: 'system', id: 's1', text: '  ', tone: 'info' }), false)
  assert.equal(hasRenderableContent({ kind: 'plan', id: 'p1', steps: [] }), false)
  // 有内容的照常通过
  assert.equal(hasRenderableContent(assistant('a1', 'x')), true)
  assert.equal(hasRenderableContent(user('u1', 'x')), true)
  // 工具与收尾卡「无文本但有信息」，不能当空壳丢掉
  assert.equal(hasRenderableContent(tool('t1', 'a')), true)
  assert.equal(hasRenderableContent({ kind: 'finish', id: 'f1', reason: 'completed', ms: 1 }), true)
})

test('dropEmptyMessages：只丢空壳，顺序与其余项不变', () => {
  const list = [
    user('u1', '目标'),
    assistant('a1', ''), // 空壳
    assistant('a2', '有内容'),
    thinking('k1', '  '), // 空壳
    tool('t1', 'a')
  ]
  const out = dropEmptyMessages(list)
  assert.deepEqual(out.map((m) => m.id), ['u1', 'a2', 't1'])
})

// ————————————————————— 长回显折叠 —————————————————————

test('planRawCollapse：短回显不折叠，原样展示全部行', () => {
  const r = planRawCollapse('a\nb\nc')
  assert.equal(r.collapses, false)
  assert.equal(r.hiddenCount, 0)
  assert.deepEqual(r.visible, ['a', 'b', 'c'])
})

test('★ planRawCollapse：超长回显按行折叠，保留头 N 行', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`)
  const r = planRawCollapse(lines.join('\n'))
  assert.equal(r.collapses, true)
  assert.equal(r.visible.length, RAW_COLLAPSE_LINES)
  assert.equal(r.hiddenCount, 100 - RAW_COLLAPSE_LINES)
  assert.equal(r.visible[0], 'line-0')
  // 边界：正好等于阈值不折叠
  const exact = Array.from({ length: RAW_COLLAPSE_LINES }, (_, i) => `l${i}`).join('\n')
  assert.equal(planRawCollapse(exact).collapses, false)
})

test('planRawCollapse：按行而不是按字符切（不切出半截命令）', () => {
  const raw = ['interface GigabitEthernet0/0/1', ' ip address 10.0.0.1 255.255.255.0'].join('\n')
  // 即使总字符数很小，行数少就不折叠
  assert.equal(planRawCollapse(raw).collapses, false)
  // 自定义阈值（单测要能在不造 100 行的情况下验边界）
  const multi = Array.from({ length: 5 }, (_, i) => `cmd-${i}`).join('\n')
  const r = planRawCollapse(multi, 2)
  assert.equal(r.collapses, true)
  assert.deepEqual(r.visible, ['cmd-0', 'cmd-1'])
  assert.equal(r.hiddenCount, 3)
})

test('planRawCollapse：空串与非法阈值不崩', () => {
  assert.equal(planRawCollapse('').collapses, false)
  assert.deepEqual(planRawCollapse('').visible, [''])
  // keepLines=0 / 负数一律夹到至少 1 行
  assert.equal(planRawCollapse('a\nb\nc', 0).visible.length, 1)
  assert.equal(planRawCollapse('a\nb\nc', -5).visible.length, 1)
})

// ————————————————————— 结构化结果卡 —————————————————————

test('buildStructuredView：diff_with_snapshot 的载荷 → diff 视图', () => {
  const v = buildStructuredView('diff_with_snapshot', {
    snapshotId: 's-1',
    deviceId: 'SW1',
    changed: true,
    added: ['vlan 10', 'interface Vlanif10'],
    removed: ['vlan 20']
  })
  assert.equal(v.kind, 'diff')
  assert.equal(v.changed, true)
  assert.deepEqual(v.added, ['vlan 10', 'interface Vlanif10'])
  assert.deepEqual(v.removed, ['vlan 20'])
  assert.equal(v.deviceId, 'SW1')
  assert.equal(v.snapshotId, 's-1')
})

test('★ buildStructuredView：认不出的工具 / 形状一律返回 null（不抛错）', () => {
  assert.equal(buildStructuredView('run_show_command', { foo: 1 }), null)
  assert.equal(buildStructuredView('diff_with_snapshot', null), null)
  assert.equal(buildStructuredView('diff_with_snapshot', 'text'), null)
  // added 不是数组 → 整项作废
  assert.equal(buildStructuredView('diff_with_snapshot', { added: 'x', removed: [] }), null)
  assert.equal(buildStructuredView('diff_with_snapshot', { removed: [] }), null)
  // 数组里混了非字符串 → 整项作废（宁可不出卡，也不显示半个）
  assert.equal(buildStructuredView('diff_with_snapshot', { added: ['ok', 42], removed: [] }), null)
})

test('buildStructuredView：缺 changed 时由 added/removed 推断', () => {
  const v = buildStructuredView('diff_with_snapshot', { added: ['a'], removed: [] })
  assert.equal(v.changed, true)
  const v2 = buildStructuredView('diff_with_snapshot', { added: [], removed: [] })
  assert.equal(v2.changed, false)
  // 显式 changed 优先于推断
  const v3 = buildStructuredView('diff_with_snapshot', { changed: false, added: ['a'], removed: [] })
  assert.equal(v3.changed, false)
})

test('describeDiff：结论文案带上两类行数', () => {
  assert.equal(describeDiff({ kind: 'diff', changed: false, added: [], removed: [] }), '配置无变化')
  assert.match(
    describeDiff({ kind: 'diff', changed: true, added: ['a', 'b'], removed: ['c'] }),
    /新增 2 行/
  )
  assert.match(
    describeDiff({ kind: 'diff', changed: true, added: ['a', 'b'], removed: ['c'] }),
    /删除 1 行/
  )
  // 只有一侧有变化时不该出现「删除 0 行」这种噪声
  const onlyAdded = describeDiff({ kind: 'diff', changed: true, added: ['a'], removed: [] })
  assert.equal(onlyAdded.includes('删除'), false)
})

test('DIFF_PREVIEW_LINES：预览上限是个正数（卡片不做无限长列表）', () => {
  assert.ok(DIFF_PREVIEW_LINES > 0)
})

// ————————————————————— 结构化载荷闸门 —————————————————————

test('★ smallToolData：放行小对象，挡住整份配置/巨物', () => {
  const small = { snapshotId: 's1', added: ['a'], removed: [] }
  assert.deepEqual(smallToolData({ ok: true, data: small }), small)

  // 超过预算的对象不放行（默认 8000 字符）
  const huge = { lines: Array.from({ length: 5000 }, () => 'interface GigabitEthernet0/0/1') }
  assert.equal(smallToolData({ ok: true, data: huge }), undefined)
  // 自定义更小的预算
  assert.equal(smallToolData({ ok: true, data: small }, 5), undefined)
})

test('★ smallToolData：失败 / 空 / 标量 / 循环引用都不放行', () => {
  assert.equal(smallToolData({ ok: false, data: { a: 1 } }), undefined, '失败结果没有卡片')
  assert.equal(smallToolData({ ok: true, data: undefined }), undefined)
  assert.equal(smallToolData({ ok: true, data: null }), undefined)
  assert.equal(smallToolData({ ok: true, data: 'a string' }), undefined, '字符串 summary 已覆盖')
  assert.equal(smallToolData({ ok: true, data: 42 }), undefined)
  assert.equal(smallToolData({ ok: true, data: [] }), undefined, '空数组没信息')

  const cyclic = { a: 1 }
  cyclic.self = cyclic
  assert.equal(smallToolData({ ok: true, data: cyclic }), undefined, '序列化失败必须静默挡下')
})
