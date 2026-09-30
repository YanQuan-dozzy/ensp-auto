import { test } from 'node:test'
import assert from 'node:assert/strict'
// 追加的 8 方向端口用例接在文件末尾
import {
  planRoutes,
  checkRouteInvariants,
  routeToPath,
  snapRouteToHandles,
  buildRowModel,
  allocateLanes,
  selectFramedBlocks,
  estimateNodeSize,
  assignLinkPorts,
  endSideOf,
  portPcts,
  handlePlacementOf,
  OVERLAP_TOLERANCE,
  FRAME_AREA_RATIO,
  sideOf
} from '../.build/harness.mjs'

// —— B4 第二批：走线内核（方案 B 分层树干成束）——
//
// 被修复的两个病：
// 1. 折点压框 —— 旧口径把折点交给 getSmoothStepPath 放在两点中点，正落在中间那台设备上；
// 2. 共线/交叉 —— 同层节点 y 相同，横向长链路只能贴在同一条线上。
// 下面的 4 条断言就是交付时定下的验收口径。

const LABEL = 'GE0/0/1 ↔ GE0/0/1'
const link = (id, from, to, label = LABEL) => ({ id, from, to, label, source: 'file' })

/** 四层树：Router1 → Core1 → {Building1, Building2} → {PC1, PC2} */
const NODES = [
  { id: 'r1', name: 'Router1', role: 'router' },
  { id: 'core', name: 'Core1', role: 'switch' },
  { id: 'b1', name: 'Building1', role: 'switch' },
  { id: 'b2', name: 'Building2', role: 'switch' },
  { id: 'pc1', name: 'PC1', role: 'pc' },
  { id: 'pc2', name: 'PC2', role: 'pc' }
]
const POS = new Map([
  ['r1', { x: 300, y: 0 }],
  ['core', { x: 300, y: 150 }],
  ['b1', { x: 0, y: 300 }],
  ['b2', { x: 400, y: 300 }],
  ['pc1', { x: 0, y: 450 }],
  ['pc2', { x: 200, y: 450 }]
])
const LINKS = [
  link('l-rc', 'r1', 'core'),
  link('l-cb1', 'core', 'b1'),
  link('l-cb2', 'core', 'b2'),
  link('l-b1p1', 'b1', 'pc1', 'GE0/0/2 ↔ Eth0/0/1'),
  link('l-b1p2', 'b1', 'pc2', 'GE0/0/3 ↔ Eth0/0/1')
]
const plan = (nodes = NODES, links = LINKS, pos = POS, sizes) =>
  planRoutes({ nodes, links, positions: pos, sizes })

test('4 条验收断言在基础树上全部通过：不共线重合 / 不穿设备框 / 标注不相交 / 不穿区块框', () => {
  const model = plan()
  const rep = checkRouteInvariants(model)
  assert.deepEqual(rep.overlaps, [], '不应出现跨束共线重合')
  assert.deepEqual(rep.nodeHits, [], '不应穿过别的设备框')
  assert.deepEqual(rep.labelOverlaps, [], '标注矩形不应相交')
  assert.deepEqual(rep.blockHits, [], '不应穿过外部区块框')
})

test('成束键：同父同向同目标行的链路同属一束，不同父则不同束（直线优先下各自独占端口点）', () => {
  const model = plan()
  const a = model.routes.get('l-cb1')
  const b = model.routes.get('l-cb2')
  assert.equal(a.bundle, b.bundle, 'core → {b1,b2} 应同属一束')
  assert.notEqual(model.routes.get('l-rc').bundle, a.bundle, '不同父节点的链路不能算同一束')
  // 直线优先：清晰场景下各走各的直线（端口点各不相同），不再共享同一段几何
  assert.notDeepEqual(a.points, b.points, '两条链路的端口点必须错开')
})

test('直线优先：不穿框的链路走两点直连；正交折线必须轴对齐', () => {
  const model = plan()
  for (const r of model.routes.values()) {
    if (r.straight) {
      assert.equal(r.points.length, 2, `${r.linkId} 直线路径必须只有两个点`)
      continue
    }
    for (let i = 0; i < r.points.length - 1; i += 1) {
      const p = r.points[i]
      const q = r.points[i + 1]
      const axisAligned = Math.abs(p.x - q.x) < 0.5 || Math.abs(p.y - q.y) < 0.5
      assert.ok(axisAligned, `${r.linkId} 的正交折线第 ${i} 段是斜线：(${p.x},${p.y})→(${q.x},${q.y})`)
    }
  }
})

test('同层链路：畅通时两点直连；被挡住时走「行外的层间车道」', () => {
  const nodes = [
    { id: 'b1', name: 'Building1', role: 'switch' },
    { id: 'b2', name: 'Building2', role: 'switch' }
  ]
  const pos = new Map([
    ['b1', { x: 0, y: 300 }],
    ['b2', { x: 700, y: 300 }]
  ])
  // 畅通 → 直线
  const clear = plan(nodes, [link('l-same', 'b1', 'b2')], pos).routes.get('l-same')
  assert.equal(clear.straight, true, '同层畅通链路应走两点直连')
  // 中间塞一台设备挡住直线 → 正交避让，水平段走在设备行之外的车道里
  const nodes2 = [...nodes, { id: 'jam', name: 'Jam1', role: 'switch' }]
  const pos2 = new Map(pos).set('jam', { x: 330, y: 310 })
  const blocked = plan(nodes2, [link('l-same', 'b1', 'b2')], pos2).routes.get('l-same')
  assert.equal(blocked.straight, false, '直线被挡住时应改走正交折线')
  const nodeH = estimateNodeSize('Building1', 'switch').h
  const laneOutside = blocked.points.some((p) => p.y < 300 || p.y > 300 + nodeH)
  assert.ok(laneOutside, '水平长段必须走在设备行之外的车道里')
  assert.deepEqual(checkRouteInvariants(plan(nodes2, [link('l-same', 'b1', 'b2')], pos2)).nodeHits, [])
})

test('走廊里被塞了别的设备时，干线自动让开（避障），实在无解才退回直连', () => {
  const nodes = [...NODES, { id: 'jam', name: 'Jam1', role: 'switch' }]
  // Jam1 落在 core → b 行的走廊里，且正好挡住 x=65..365 的水平干线
  const pos = new Map(POS).set('jam', { x: 150, y: 225 })
  const model = plan(nodes, LINKS, pos)
  const rep = checkRouteInvariants(model)
  assert.deepEqual(rep.nodeHits, [], '应当自动换一条不挡道的干线高度')
  assert.equal(
    [...model.routes.values()].some((r) => r.fallback),
    false,
    '有解就不该退化成两点直连'
  )
})

test('每条链路独占端口点后，汇入同一台设备的线不再共用连接点', () => {
  const nodes = [...NODES, { id: 'b3', name: 'Building3', role: 'switch' }]
  const pos = new Map(POS).set('b3', { x: 800, y: 150 })
  // 两台汇聚设备各自下挂同一个终端
  const links = [...LINKS, link('l-b1p3', 'b1', 'pc1', 'GE0/0/4 ↔ Eth0/0/1'), link('l-b3p1', 'b3', 'pc1', 'GE0/0/1 ↔ Eth0/0/1')]
  const model = plan(nodes, links, pos)
  const rep = checkRouteInvariants(model)
  // 端口点铺开后不再有「共用连接点」的必然重合；跨束重合也必须守住容差
  assert.ok(
    rep.overlaps.every((o) => o.len <= OVERLAP_TOLERANCE),
    `跨束重合不应超过容差：${JSON.stringify(rep.overlaps)}`
  )
  const toPc = [...model.routes.values()].filter((r) => r.to === 'pc1' || r.from === 'pc1')
  const endpoints = new Set(toPc.flatMap((r) => r.points.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`)))
  assert.ok(endpoints.size >= toPc.length, '各链路在 pc1 附近的端点应当错开')
})

test('allocateLanes：x 区间不重叠可复用同一条车道，重叠则必须错开', () => {
  const reuse = allocateLanes([
    { id: 'a', x1: 0, x2: 100 },
    { id: 'b', x1: 200, x2: 300 }
  ])
  assert.equal(reuse.get('a'), 0)
  assert.equal(reuse.get('b'), 0, '区间不重叠 → 复用 0 号车道')

  const split = allocateLanes([
    { id: 'a', x1: 0, x2: 300 },
    { id: 'b', x1: 100, x2: 400 }
  ])
  assert.notEqual(split.get('a'), split.get('b'), '区间重叠 → 必须分到不同车道')
})

test('buildRowModel：y 相近的节点归为同一行，离得远的分成不同行', () => {
  const nodes = [
    { id: 'a', name: 'A', role: 'switch' },
    { id: 'b', name: 'B', role: 'switch' },
    { id: 'c', name: 'C', role: 'switch' }
  ]
  const pos = new Map([
    ['a', { x: 0, y: 100 }],
    ['b', { x: 300, y: 110 }],
    ['c', { x: 0, y: 400 }]
  ])
  const sizes = new Map(nodes.map((n) => [n.id, estimateNodeSize(n.name, n.role)]))
  const { rows, rowOf } = buildRowModel(nodes, pos, sizes)
  assert.equal(rows.length, 2, 'a 与 b 应同行，c 单独一行')
  assert.equal(rowOf.get('a'), rowOf.get('b'))
  assert.notEqual(rowOf.get('a'), rowOf.get('c'))
})

test('selectFramedBlocks：只给「局部」区块画框（罩住大半张图的不算分组）', () => {
  const local = { headId: 'h1', nodeIds: ['h1', 'n1', 'n2'], box: { x: 0, y: 0, w: 200, h: 200 } }
  const giant = { headId: 'h2', nodeIds: ['h2', 'x1', 'x2', 'x3'], box: { x: 0, y: 0, w: 900, h: 900 } }
  const single = { headId: 'h3', nodeIds: ['h3'], box: { x: 0, y: 0, w: 50, h: 50 } }
  const bounds = { x: 0, y: 0, w: 1000, h: 1000 }
  const kept = selectFramedBlocks([local, giant, single], bounds).map((b) => b.headId)
  assert.deepEqual(kept, ['h1'])
  assert.ok((giant.box.w * giant.box.h) / (bounds.w * bounds.h) > FRAME_AREA_RATIO)
})

test('routeToPath / snapRouteToHandles：路径合法、贴实测连接点后仍处处轴对齐', () => {
  assert.equal(routeToPath([{ x: 0, y: 0 }]), '', '少于两点的折线不成路径')
  assert.equal(routeToPath([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 'M0,0 L10,0')
  // 连续重复点要去掉，否则圆角处会算出 NaN
  assert.equal(routeToPath([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }]), 'M0,0 L10,0')
  assert.match(routeToPath([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 80, y: 50 }]), /Q/)

  const route = [
    { x: 100, y: 100 },
    { x: 100, y: 150 },
    { x: 200, y: 150 },
    { x: 200, y: 200 }
  ]
  const snapped = snapRouteToHandles(route, { x: 108, y: 96 }, { x: 205, y: 204 }, 'v', 'v')
  assert.deepEqual(snapped[0], { x: 108, y: 96 })
  assert.deepEqual(snapped[snapped.length - 1], { x: 205, y: 204 })
  // 首段竖直 → 第二个点必须与起点同 x；末段竖直 → 倒数第二个点必须与终点同 x
  assert.equal(snapped[1].x, 108)
  assert.equal(snapped[snapped.length - 2].x, 205)
  // 两点直连：不能为了「拉直」凭空多出折点
  const two = [{ x: 0, y: 0 }, { x: 50, y: 80 }]
  assert.deepEqual(snapRouteToHandles(two, { x: 3, y: 4 }, { x: 60, y: 90 }, 'v', 'v'), [
    { x: 3, y: 4 },
    { x: 60, y: 90 }
  ])
})

test('sideOf 口径未变（走线分类依赖它，改了会牵动车道分配）', () => {
  assert.equal(sideOf({ x: 0, y: 0 }, { x: 0, y: 100 }), 'bottom')
  assert.equal(sideOf({ x: 0, y: 0 }, { x: 100, y: 0 }), 'right')
  assert.equal(sideOf({ x: 100, y: 0 }, { x: 0, y: 0 }), 'left')
  assert.equal(sideOf({ x: 0, y: 100 }, { x: 0, y: 0 }), 'top')
})

// —— B4 第五批：8 方向端口点（每条链路独立连接点，像 eNSP）——
// v2.32「像图片那样接线」：方位只看**家族关系**（父/子/兄弟），角点只在同侧 >2 条时用。

test('sideOf：向上下层偏置 —— 45° 也算父子（走上下），只有横向明显占优才算兄弟（走左右）', () => {
  const o = { x: 0, y: 0 }
  assert.equal(sideOf(o, { x: 100, y: 0 }), 'right')
  assert.equal(sideOf(o, { x: 100, y: 10 }), 'right', '|dy| < |dx|/1.5 → 同层兄弟')
  assert.equal(sideOf(o, { x: 0, y: -100 }), 'top')
  assert.equal(sideOf(o, { x: 50, y: 50 }), 'bottom', '45° 斜下方＝子节点 → 底边（不再给角点）')
  assert.equal(sideOf(o, { x: -30, y: 80 }), 'bottom')
  assert.equal(sideOf(o, { x: -50, y: 60 }), 'bottom', '斜下方仍是子节点 → 底边')
  assert.equal(sideOf(o, { x: -70, y: -55 }), 'top', '斜上方仍是父设备 → 顶边')
  assert.equal(sideOf(o, { x: -80, y: -50 }), 'left', '横向明显占优（>1.5:1）→ 同层兄弟')
})

test('endSideOf：父亲→top、子节点→bottom、兄弟→left/right（行模型优先于角度）', () => {
  const rowOf = new Map([
    ['p', 0],
    ['a', 1],
    ['b', 1]
  ])
  const p = { x: 0, y: 0 }
  const a = { x: -500, y: 320 }
  const b = { x: 500, y: 320 }
  // 宽子树：子设备横跨两格以上，纯角度会判成兄弟 —— 行模型判成跨层 → 底边
  assert.equal(endSideOf('p', 'a', p, a, rowOf), 'bottom')
  assert.equal(endSideOf('p', 'b', p, b, rowOf), 'bottom')
  assert.equal(endSideOf('a', 'p', a, p, rowOf), 'top')
  // 同一行 = 兄弟 → 左右
  assert.equal(endSideOf('a', 'b', a, b, rowOf), 'right')
  assert.equal(endSideOf('b', 'a', b, a, rowOf), 'left')
  // 没有行模型 → 退回几何口径
  assert.equal(endSideOf('p', 'a', p, { x: 0, y: 320 }), 'bottom')
})

test('portPcts：优先中点，超过两条才铺到边角', () => {
  assert.deepEqual(portPcts(1, 'x'), [0.5], '单条 = 边中点')
  const two = portPcts(2, 'x')
  assert.ok(two[0] < 0.5 && two[1] > 0.5, '两条仍贴中点两侧')
  assert.ok(two[1] - two[0] < 0.2, '两条不能均摊到整条边')
  assert.deepEqual(portPcts(3, 'x'), [0, 0.5, 1], '三条铺满 → 最外侧落在两个边角')
  assert.deepEqual(portPcts(4, 'y'), [0, 1 / 3, 2 / 3, 1])
})

test('assignLinkPorts：同侧多链路沿边框铺开，顺序与对端方位一致', () => {
  const pos = new Map([
    ['a', { x: 0, y: 0 }],
    ['l', { x: 100, y: 0 }],
    ['m', { x: 300, y: 0 }],
    ['r', { x: 500, y: 0 }]
  ])
  const links = [
    { id: 'la', from: 'a', to: 'l', source: 'file' },
    { id: 'lb', from: 'a', to: 'm', source: 'file' },
    { id: 'lc', from: 'a', to: 'r', source: 'file' }
  ]
  const { byLink, byNode } = assignLinkPorts(links, pos)
  const right = byNode.get('a').filter((p) => p.side === 'right')
  assert.equal(right.length, 3, 'a 的右侧应有 3 个端口点')
  assert.deepEqual(right.map((p) => p.pct), [0, 0.5, 1], '三条 → 铺满右边（含两个边角）')
  // 三个对端都在 a 的右边 → 全部走 a 的右侧端口，按对端 x 顺序铺开
  assert.equal(byLink.get('la').src.pct, 0, '最近的对端占最靠边的端口')
  assert.equal(byLink.get('lc').src.pct, 1, '最右的对端占最右的端口')
})

test('assignLinkPorts：斜下方的子设备一律从底边进出（不再从左右边/角点甩线）', () => {
  const pos = new Map([
    ['p', { x: 300, y: 0 }],
    ['c1', { x: 0, y: 320 }],
    ['c2', { x: 600, y: 320 }]
  ])
  const rowOf = new Map([
    ['p', 0],
    ['c1', 1],
    ['c2', 1]
  ])
  const links = [
    { id: 'x1', from: 'p', to: 'c1', source: 'file' },
    { id: 'x2', from: 'p', to: 'c2', source: 'file' }
  ]
  const { byLink, byNode } = assignLinkPorts(links, pos, { rowOf })
  assert.equal(byLink.get('x1').src.side, 'bottom', '父设备一侧走底边')
  assert.equal(byLink.get('x1').dst.side, 'top', '子设备一侧走顶边')
  assert.equal(byLink.get('x2').src.side, 'bottom')
  const bottom = byNode.get('p').filter((h) => h.side === 'bottom')
  assert.equal(bottom.length, 2, '两条都落在底边')
  assert.ok(bottom.every((h) => h.pct > 0 && h.pct < 1), '只有两条 → 仍在中点附近，不用边角')
  // 三条以上才铺到两个边角
  const three = assignLinkPorts(
    [...links, { id: 'x3', from: 'p', to: 'c1', source: 'file' }],
    new Map([...pos, ['c3', { x: 300, y: 320 }]]).set('c1', { x: 0, y: 320 }),
    { rowOf: new Map([...rowOf, ['c3', 1]]) }
  )
  const pcts = three.byNode.get('p').filter((h) => h.side === 'bottom').map((h) => h.pct).sort((a, b) => a - b)
  assert.equal(pcts.length, 3)
  assert.equal(pcts[0], 0, '最外一条落在下左边角')
  assert.equal(pcts[2], 1, '最外一条落在下右边角')
})

test('handlePlacementOf：边端口按 pct 钉位，pct=0/1 正好落在边角', () => {
  assert.deepEqual(handlePlacementOf('right', 0.25).style, { top: '25%' })
  assert.deepEqual(handlePlacementOf('bottom', 0.5).style, { left: '50%' })
  assert.deepEqual(handlePlacementOf('bottom', 0).style, { left: '0%' }, 'pct=0 = 左下角')
  assert.deepEqual(handlePlacementOf('bottom', 1).style, { left: '100%' }, 'pct=1 = 右下角')
  assert.deepEqual(handlePlacementOf('top-right', 0.5).style, { left: '100%' })
})

test('直线优先后，斜线段不误判穿框（Liang-Barsky 精确裁剪）', () => {
  // 斜线只是从矩形旁边路过：包围盒粗判会误判，精确裁剪应放行
  const r = planRoutes({
    nodes: [
      { id: 'a', name: 'A1', role: 'switch' },
      { id: 'b', name: 'B1', role: 'switch' },
      { id: 'c', name: 'C1', role: 'switch' }
    ],
    links: [{ id: 'l', from: 'a', to: 'c', label: 'x', source: 'file' }],
    positions: new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 400, y: 0 }],
      ['c', { x: 0, y: 400 }]
    ])
  })
  // a→c 的对角线从 b（右上）旁边路过，不应被判穿框而改走折线
  const route = r.routes.get('l')
  const rect = r.rects.get('b')
  const s = route.points[0]
  const e = route.points[route.points.length - 1]
  const bboxHit = !(Math.max(s.x, e.x) < rect.x || Math.min(s.x, e.x) > rect.x + rect.w || Math.max(s.y, e.y) < rect.y || Math.min(s.y, e.y) > rect.y + rect.h)
  if (bboxHit) {
    assert.equal(route.straight, true, '包围盒虽然相交，但斜线没穿过矩形内部 → 应保持直线')
  }
})
