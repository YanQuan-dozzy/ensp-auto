import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  assignPortSlots,
  sideOf,
  sideToPosition,
  slotAxisOf,
  chipWidthOf,
  SLOT_GAP_X,
  SLOT_GAP_Y,
  withPortOffset,
  sanitizePortOffsets,
  MAX_PORT_OFFSET,
  MAX_PORT_OFFSET_ITEMS,
  mergeLayers,
  emptyTopology,
  assignLinkPorts,
  planRoutes,
  toFlowEdges
} from '../.build/harness.mjs'

// —— B4 标注分槽：同一连接点上的端口跨链路统一编号 ——
//
// 被修复的真实故障：旧实现用「链路内部」的端口序号算错开量，而同一个 handle 只有
// 一个坐标，于是每条链路的第 0 个端口算出来的锚点**逐字相同** —— 截图里 Core1 左侧
// 两个 GE 标注压在一起就是这个原因。

/** C 在上，三个子设备在下；三者都落在 C 的「底部」连接点（|dx| < |dy|） */
const POS = new Map([
  ['C', { x: 300, y: 0 }],
  ['L', { x: 0, y: 400 }],
  ['M', { x: 300, y: 400 }],
  ['R', { x: 600, y: 400 }]
])

const link = (id, from, to, label = 'GE0/0/1 ↔ GE0/0/1', source = 'file') => ({ id, from, to, label, source })

test('前置几何：三个子设备确实都从 C 的底部进出（否则下面的槽位分组不成立）', () => {
  assert.equal(sideOf(POS.get('C'), POS.get('L')), 'bottom')
  assert.equal(sideOf(POS.get('C'), POS.get('M')), 'bottom')
  assert.equal(sideOf(POS.get('C'), POS.get('R')), 'bottom')
  // 子设备一侧则各自从顶部进出 → 每组只有它自己
  assert.equal(sideOf(POS.get('M'), POS.get('C')), 'top')
})

test('assignPortSlots：同侧多链路跨链路统一编号，序号按对端位置排序', () => {
  const links = [link('x1', 'C', 'R'), link('x2', 'C', 'L'), link('x3', 'C', 'M')]
  const slots = assignPortSlots(links, POS)

  // 三条链路同属 C 的底部连接点 → count 一致为 3，index 按对端 x 递增（L < M < R）
  assert.deepEqual(slots.get('x2').from, [{ index: 0, count: 3, gap: SLOT_GAP_X }])
  assert.deepEqual(slots.get('x3').from, [{ index: 1, count: 3, gap: SLOT_GAP_X }])
  assert.deepEqual(slots.get('x1').from, [{ index: 2, count: 3, gap: SLOT_GAP_X }])
  // 对端各自成组：只接了这一条链路（顶边也是横排）
  assert.deepEqual(slots.get('x1').to, [{ index: 0, count: 1, gap: SLOT_GAP_X }])
})

test('assignPortSlots：一条链路的并联多对端口占多个槽位，后面的链路顺延而不是抢位', () => {
  const links = [
    { id: 'p', from: 'C', to: 'M', label: 'GE0/0/1 ↔ GE0/0/1 / GE0/0/2 ↔ GE0/0/2', source: 'file' },
    link('q', 'C', 'R')
  ]
  const slots = assignPortSlots(links, POS)
  assert.deepEqual(slots.get('p').from, [
    { index: 0, count: 3, gap: SLOT_GAP_X },
    { index: 1, count: 3, gap: SLOT_GAP_X }
  ])
  // q 从 2 号位开始：回到 0 就会压住 p 的第二个标注
  assert.deepEqual(slots.get('q').from, [{ index: 2, count: 3, gap: SLOT_GAP_X }])
})

test('assignPortSlots：没有端口标注的链路（手动连线）同样占一个槽位', () => {
  const links = [
    { id: 'm', from: 'C', to: 'L', label: '手动连线', source: 'manual' },
    link('n', 'C', 'M')
  ]
  const slots = assignPortSlots(links, POS)
  // m 的线确实占着那个连接点 → 它的位留着，n 从 1 号位开始
  assert.deepEqual(slots.get('m').from, [{ index: 0, count: 2, gap: SLOT_GAP_X }])
  assert.deepEqual(slots.get('n').from, [{ index: 1, count: 2, gap: SLOT_GAP_X }])
})

test('assignPortSlots：端点缺坐标的链路既不参与也不占槽位（与 toFlowEdges 同口径）', () => {
  const links = [link('ghost', 'C', 'Z'), link('real', 'C', 'M')]
  const slots = assignPortSlots(links, POS)
  assert.equal(slots.has('ghost'), false)
  assert.deepEqual(slots.get('real').from, [{ index: 0, count: 1, gap: SLOT_GAP_X }])
})

test('assignPortSlots：编号与链路数组顺序无关（拖动/刷新时标注不会互相换位）', () => {
  const a = [link('x1', 'C', 'R'), link('x2', 'C', 'L'), link('x3', 'C', 'M')]
  const b = [link('x3', 'C', 'M'), link('x1', 'C', 'R'), link('x2', 'C', 'L')]
  const sa = assignPortSlots(a, POS)
  const sb = assignPortSlots(b, POS)
  for (const id of ['x1', 'x2', 'x3']) {
    assert.deepEqual(sa.get(id).from, sb.get(id).from, `${id} 的槽位应与数组顺序无关`)
  }
})

test('槽位间距必须大于标注自身尺寸，否则等于没错开', () => {
  // 竖排按标注高度（10px 字号 × 1.5 行高 + 边框 ≈ 17px）
  assert.ok(SLOT_GAP_Y >= 20, `竖排间距 ${SLOT_GAP_Y} 太小，标注仍会竖向重叠`)
  // 横排按宽度：下限要能装下常见的短接口名（GE0/0/1 这类）
  assert.ok(SLOT_GAP_X >= 64, `横排间距 ${SLOT_GAP_X} 太小，标注仍会横向重叠`)
  assert.ok(chipWidthOf('GE0/0/1') <= SLOT_GAP_X, `下限必须容下 ${chipWidthOf('GE0/0/1')}px 的常见标注`)
})

test('assignPortSlots：横排间距按组内最长接口名放大（Serial0/0/1 这类长名字不会重新压在一起）', () => {
  const long = [
    link('s1', 'C', 'L', 'Serial0/0/1 ↔ Serial0/0/1'),
    link('s2', 'C', 'M', 'Serial0/0/2 ↔ Serial0/0/2')
  ]
  const gap = assignPortSlots(long, POS).get('s1').from[0].gap
  assert.ok(gap > SLOT_GAP_X, `11 字符的接口名应撑大横排间距，实际 ${gap}（下限 ${SLOT_GAP_X}）`)
  assert.ok(gap >= chipWidthOf('Serial0/0/1'), '间距必须不小于该组最宽标注的宽度')
  // 短名字仍用下限，避免无谓地把标注带拉宽
  const short = assignPortSlots([link('g1', 'C', 'L'), link('g2', 'C', 'M')], POS)
  assert.equal(short.get('g1').from[0].gap, SLOT_GAP_X)
})

test('assignPortSlots：竖排（左右连接点）间距是常量，与接口名长度无关', () => {
  // C 在右、两个子设备在左 → 走左右连接点（axis = y）
  const pos = new Map([
    ['C', { x: 600, y: 0 }],
    ['L', { x: 0, y: 0 }],
    ['M', { x: 0, y: 90 }]
  ])
  const links = [
    link('y1', 'C', 'L', 'Serial0/0/1 ↔ Serial0/0/1'),
    link('y2', 'C', 'M', 'GE0/0/2 ↔ GE0/0/2')
  ]
  const slots = assignPortSlots(links, pos)
  assert.deepEqual(slots.get('y1').from, [{ index: 0, count: 2, gap: SLOT_GAP_Y }])
  assert.deepEqual(slots.get('y2').from, [{ index: 1, count: 2, gap: SLOT_GAP_Y }])
})

test('slotAxisOf / sideToPosition：上下连接点沿节点横边排（x），左右连接点沿竖边排（y）', () => {
  assert.equal(slotAxisOf('top'), 'x')
  assert.equal(slotAxisOf('bottom'), 'x')
  assert.equal(slotAxisOf('left'), 'y')
  assert.equal(slotAxisOf('right'), 'y')
  assert.equal(sideToPosition('top'), 'top')
  assert.equal(sideToPosition('left'), 'left')
  assert.equal(sideToPosition('bottom'), 'bottom')
  assert.equal(sideToPosition('right'), 'right')
})

// —— B4 偏移的读写：纯函数 + 白名单 ——

test('withPortOffset：缺位补 0、保留一位小数、不就地修改入参', () => {
  const prev = { from: [{ x: 1, y: 2 }] }
  const next = withPortOffset(prev, 'to', 2, { x: 3.14159, y: -0.06 })
  assert.deepEqual(next.from, [{ x: 1, y: 2 }])
  assert.deepEqual(next.to, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 3.1, y: -0.1 }])
  assert.deepEqual(prev, { from: [{ x: 1, y: 2 }] }, '入参必须保持原样（它可能正是 store 里的链路对象）')
})

test('sanitizePortOffsets：合法值收下，脏值逐条丢弃而不是兜底成 0', () => {
  assert.deepEqual(sanitizePortOffsets({ from: [{ x: 12, y: -8 }] }), { from: [{ x: 12, y: -8 }] })
  assert.deepEqual(
    sanitizePortOffsets({
      to: [
        { x: Number.NaN, y: 1 },
        { x: 1, y: Number.POSITIVE_INFINITY },
        { x: MAX_PORT_OFFSET + 1, y: 0 },
        { x: 3, y: 4 }
      ]
    }),
    { to: [{ x: 3, y: 4 }] }
  )
  // 一条都不剩 / 形状不对 → undefined（调用方据此不下发该字段）
  assert.equal(sanitizePortOffsets({ from: [{ x: 'a', y: 'b' }] }), undefined)
  assert.equal(sanitizePortOffsets({}), undefined)
  assert.equal(sanitizePortOffsets(null), undefined)
  assert.equal(sanitizePortOffsets('nope'), undefined)
})

test('sanitizePortOffsets：条目数超上限的部分被截断（脏数据不能无限膨胀持久化文件）', () => {
  const many = Array.from({ length: MAX_PORT_OFFSET_ITEMS + 3 }, (_v, i) => ({ x: i, y: 0 }))
  const out = sanitizePortOffsets({ from: many })
  assert.equal(out.from.length, MAX_PORT_OFFSET_ITEMS)
})

test('mergeLayers：手动层只带 portOffsets 的条目 → 偏移生效，file 的端口标注保留', () => {
  const file = {
    nodes: [],
    links: [{ id: 'l1', from: 'A', to: 'B', label: 'GE0/0/1 ↔ GE0/0/2', source: 'file' }],
    updatedAt: 1
  }
  const merged = mergeLayers(file, emptyTopology(), {
    nodes: [],
    links: [{ id: 'l1', from: 'A', to: 'B', source: 'manual', portOffsets: { from: [{ x: 12, y: -20 }] } }]
  })
  assert.equal(merged.links.length, 1)
  assert.deepEqual(merged.links[0].portOffsets, { from: [{ x: 12, y: -20 }] })
  assert.equal(merged.links[0].label, 'GE0/0/1 ↔ GE0/0/2', '覆盖条目不带 label → 不得把 file 的标注冲掉')
  assert.equal(merged.links[0].source, 'manual')
})

test('主进程 IPC 白名单必须显式收下 portOffsets（漏掉 = 拖完标签刷新即丢）', () => {
  const src = readFileSync(new URL('../../src/main/ipc/topology.ts', import.meta.url), 'utf8')
  // sanitizeLinks 是逐字段重建对象的白名单：不显式回填的字段会被静默丢弃
  assert.match(src, /sanitizePortOffsets\(o\.portOffsets\)/, 'sanitizeLinks 应校验 portOffsets')
  assert.match(src, /\.\.\.\(portOffsets \? \{ portOffsets \} : \{\}\)/, 'sanitizeLinks 应把校验结果回填进链路对象')
  // 多线并接的 lineKey/lineType 同理：丢了 lineKey，标注偏移会落到「按设备对」的旧语义上，
  // 同设备对并接的几条线互相串味（拖第 2 条的标注，第 1 条跟着动）
  assert.match(src, /\.\.\.\(toStr\(o\.lineKey\) \? \{ lineKey: toStr\(o\.lineKey\) \} : \{\}\)/, 'sanitizeLinks 应回填 lineKey')
  assert.match(src, /\.\.\.\(toStr\(o\.lineType\) \? \{ lineType: toStr\(o\.lineType\) \} : \{\}\)/, 'sanitizeLinks 应回填 lineType')
})

test('多线并接：连线渲染按条带身份与线型（删除按条 / 串口族虚线，源码守卫）', () => {
  const src = readFileSync(new URL('../../src/renderer/features/topology/TopoRender.tsx', import.meta.url), 'utf8')
  // 边 data 必须带链路身份：删除走「条」粒度，缺了它会退回设备对、连坐删掉同对其它线
  assert.match(src, /identity: linkIdentity\(l\)/, 'toFlowEdges 应把链路身份下发到边的 data')
  // 线型：串口族（Serial/POS/ATM/CTL/E1）虚线，其余实线
  assert.match(src, /isDashedLineType\(l\.lineType\) \? \{ strokeDasharray: '7 5' \} : \{\}/, '串口族链路应走虚线')
})

/**
 * 多线并接的**展示链路**（用户看到的「两台设备两条线只画一根」就是这个环节坏的）：
 * 每条线各自一个端口点、各自一条走线、各自一套标注槽位 —— 任一环节按设备对合并，
 * 画布上就又只剩一根线。
 */
test('多线并接：两条线各自占端口 / 各自走线 / 各自标注（画布真的画出两根）', () => {
  const pos = new Map([
    ['C1', { x: 0, y: 0 }],
    ['C2', { x: 480, y: 0 }]
  ])
  const links = [
    { id: 'l1', from: 'C1', to: 'C2', label: 'GE0/0/1 ↔ GE0/0/1', lineKey: 'GE0/0/1->GE0/0/1', lineType: 'Copper', source: 'file' },
    { id: 'l2', from: 'C1', to: 'C2', label: 'GE0/0/2 ↔ GE0/0/2', lineKey: 'GE0/0/2->GE0/0/2', lineType: 'Serial', source: 'file' }
  ]
  const nodes = [
    { id: 'C1', name: 'C1', role: 'switch' },
    { id: 'C2', name: 'C2', role: 'switch' }
  ]

  // ① 端口点：每条线在两端各占一个独立连接点（否则两条线从同一点发散、看起来还是一根）
  const ports = assignLinkPorts(links, pos)
  const c1Ports = ports.byNode.get('C1') ?? []
  assert.equal(c1Ports.length, 2)
  assert.equal(new Set(c1Ports.map((h) => h.pct)).size, 2, '同侧两个端口点的位置必须不同')
  assert.deepEqual(ports.byLink.get('l1').src.side, 'right')

  // ② 走线：两条线各有自己的折线，且不共线（端点错开 → 两条平行直线）
  const routes = planRoutes({ nodes, links, positions: pos })
  assert.equal(routes.routes.size, 2)
  const p1 = routes.routes.get('l1').points
  const p2 = routes.routes.get('l2').points
  assert.notDeepEqual(p1[0], p2[0])
  assert.notDeepEqual(p1[1], p2[1])

  // ③ 标注槽位：两条线的标注序号不同（同一连接点的标注不会逐字压在一起）
  const slots = assignPortSlots(links, pos)
  assert.notEqual(slots.get('l1').from[0].index, slots.get('l2').from[0].index)
  assert.equal(slots.get('l1').from[0].count, 2)

  // ④ 边：两条独立边，各带自己的身份（删除时精确到条）
  const edges = toFlowEdges(links, new Map([['C1', 'switch'], ['C2', 'switch']]), pos)
  assert.equal(edges.length, 2)
  assert.deepEqual(edges.map((e) => e.data.identity), ['C1|C2|GE0/0/1->GE0/0/1', 'C1|C2|GE0/0/2->GE0/0/2'])
  // 串口那条走虚线，铜缆实线
  assert.equal(edges.find((e) => e.id === 'l2').style.strokeDasharray, '7 5')
  assert.equal(edges.find((e) => e.id === 'l1').style.strokeDasharray, undefined)
})
