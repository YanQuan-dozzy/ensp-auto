/**
 * 拓扑自适应布局测试：
 * 验证上下层级与左右骨干融合、多连通分量排布与孤立设备矩阵化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeAutoLayout, naturalCompare } from '../.build/harness.mjs'

test('经典企业分层拓扑：路由器居顶、交换机居中、终端在底，终端左右展开', () => {
  const nodes = [
    { id: 'r1', name: 'AR1', role: 'router' },
    { id: 'sw1', name: 'LSW1', role: 'switch' },
    { id: 'pc1', name: 'PC-1', role: 'pc' },
    { id: 'pc2', name: 'PC-2', role: 'pc' }
  ]
  const links = [
    { id: 'l1', from: 'r1', to: 'sw1' },
    { id: 'l2', from: 'sw1', to: 'pc1' },
    { id: 'l3', from: 'sw1', to: 'pc2' }
  ]

  const pos = computeAutoLayout(nodes, links)

  const r1 = pos.get('r1')
  const sw1 = pos.get('sw1')
  const pc1 = pos.get('pc1')
  const pc2 = pos.get('pc2')

  assert.ok(r1 && sw1 && pc1 && pc2)

  // 垂直（上下）层级：AR1 (顶) < LSW1 (中) < PCs (底)
  assert.ok(r1.y < sw1.y, 'Router y 应该小于 Switch y')
  assert.ok(sw1.y < pc1.y, 'Switch y 应该小于 PC1 y')
  assert.equal(pc1.y, pc2.y, '同级 PC1 与 PC2 的 y 坐标应该相同')

  // 水平（左右）展开：PC1 与 PC2 左右并排，保持间距
  assert.notEqual(pc1.x, pc2.x, 'PC1 与 PC2 应该在 x 轴上左右拉开')
  assert.ok(Math.abs(pc1.x - pc2.x) >= 150, 'PC1 与 PC2 之间水平间距充足')
})

test('同角色骨干网络：纯路由器链 AR1 -- AR2 -- AR3 水平左右展开，不垂直堆叠', () => {
  const nodes = [
    { id: 'r1', name: 'AR1', role: 'router' },
    { id: 'r2', name: 'AR2', role: 'router' },
    { id: 'r3', name: 'AR3', role: 'router' }
  ]
  const links = [
    { id: 'l1', from: 'r1', to: 'r2' },
    { id: 'l2', from: 'r2', to: 'r3' }
  ]

  const pos = computeAutoLayout(nodes, links)

  const r1 = pos.get('r1')
  const r2 = pos.get('r2')
  const r3 = pos.get('r3')

  assert.ok(r1 && r2 && r3)

  // 左右展开：同一水平高度，x 递增或左右相连
  assert.equal(r1.y, r2.y, 'AR1 与 AR2 应该在同一水平行')
  assert.equal(r2.y, r3.y, 'AR2 与 AR3 应该在同一水平行')
  assert.ok(r1.x !== r2.x && r2.x !== r3.x, '骨干路由器在 x 轴上左右铺开')
})

test('左右双核心 + 下挂双接入网络：左右对称兼具上下层级', () => {
  const nodes = [
    { id: 'c1', name: 'Core1', role: 'router' },
    { id: 'c2', name: 'Core2', role: 'router' },
    { id: 'a1', name: 'Acc1', role: 'switch' },
    { id: 'a2', name: 'Acc2', role: 'switch' }
  ]
  const links = [
    { id: 'l0', from: 'c1', to: 'c2' },
    { id: 'l1', from: 'c1', to: 'a1' },
    { id: 'l2', from: 'c1', to: 'a2' },
    { id: 'l3', from: 'c2', to: 'a1' },
    { id: 'l4', from: 'c2', to: 'a2' }
  ]

  const pos = computeAutoLayout(nodes, links)
  const c1 = pos.get('c1')
  const c2 = pos.get('c2')
  const a1 = pos.get('a1')
  const a2 = pos.get('a2')

  assert.ok(c1 && c2 && a1 && a2)
  assert.equal(c1.y, c2.y, '双核心在同一顶层高度')
  assert.equal(a1.y, a2.y, '双接入在同一下层高度')
  assert.ok(c1.y < a1.y, '核心层在接入层上方')
  assert.notEqual(c1.x, c2.x, '双核心左右并排')
  assert.notEqual(a1.x, a2.x, '双接入左右并排')
})

test('多孤立节点矩阵化网格排布，不形成无限单行长带', () => {
  const nodes = [
    { id: 'r1', name: 'AR1', role: 'router' },
    { id: 'iso1', name: 'Dev1', role: 'pc' },
    { id: 'iso2', name: 'Dev2', role: 'pc' },
    { id: 'iso3', name: 'Dev3', role: 'pc' },
    { id: 'iso4', name: 'Dev4', role: 'pc' },
    { id: 'iso5', name: 'Dev5', role: 'pc' },
    { id: 'iso6', name: 'Dev6', role: 'pc' }
  ]
  const links = []

  const pos = computeAutoLayout(nodes, links, { isolatedCols: 3 })
  const coords = Array.from(pos.values())

  // 坐标均在正象限内
  for (const c of coords) {
    assert.ok(c.x >= 0 && c.y >= 0)
  }

  // 7 个孤立节点在 3 列配置下应至少折行成 3 行
  const uniqueY = new Set(coords.map((c) => c.y))
  assert.ok(uniqueY.size >= 2, '孤立节点应换行成矩阵网格')
})

test('分区块多层级校园网：核心置顶，每个汇聚分支为一个区块左右并排，二层交换机往下，终端在最下', () => {
  const nodes = [
    { id: 'ar1', name: 'AR1', role: 'router' },
    { id: 'core1', name: 'Core1', role: 'switch' },
    { id: 'core2', name: 'Core2', role: 'switch' },
    // 区块 1: 教学楼 4
    { id: 'b1', name: 'Building1', role: 'switch' },
    { id: 't4_1', name: 'Teaching4-1', role: 'switch' },
    { id: 't4_2', name: 'Teaching4-2', role: 'switch' },
    { id: 'pc3', name: 'PC3', role: 'pc' },
    { id: 'pc4', name: 'PC4', role: 'pc' },
    // 区块 2: 图书馆
    { id: 'lib', name: 'Library', role: 'switch' },
    { id: 'lib1', name: 'Library-1', role: 'switch' },
    { id: 'pc7', name: 'PC7', role: 'pc' }
  ]
  const links = [
    { id: 'l1', from: 'ar1', to: 'core1' },
    { id: 'l2', from: 'ar1', to: 'core2' },
    { id: 'l3', from: 'core1', to: 'core2' },
    // Core 连接各区块头
    { id: 'l4', from: 'core1', to: 'b1' },
    { id: 'l5', from: 'core2', to: 'b1' },
    { id: 'l6', from: 'core1', to: 'lib' },
    { id: 'l7', from: 'core2', to: 'lib' },
    // 区块 1 内部向下延伸
    { id: 'l8', from: 'b1', to: 't4_1' },
    { id: 'l9', from: 'b1', to: 't4_2' },
    { id: 'l10', from: 't4_1', to: 'pc3' },
    { id: 'l11', from: 't4_2', to: 'pc4' },
    // 区块 2 内部向下延伸
    { id: 'l12', from: 'lib', to: 'lib1' },
    { id: 'l13', from: 'lib1', to: 'pc7' }
  ]

  const pos = computeAutoLayout(nodes, links)

  const ar1 = pos.get('ar1')
  const core1 = pos.get('core1')
  const core2 = pos.get('core2')
  const b1 = pos.get('b1')
  const lib = pos.get('lib')
  const t4_1 = pos.get('t4_1')
  const t4_2 = pos.get('t4_2')
  const pc3 = pos.get('pc3')
  const pc4 = pos.get('pc4')

  assert.ok(ar1 && core1 && core2 && b1 && lib && t4_1 && t4_2 && pc3 && pc4)

  // 1. 核心层垂直在最顶
  assert.ok(ar1.y < core1.y, 'AR1 在 Core 上方')
  assert.equal(core1.y, core2.y, '双核心在同一高度')
  assert.ok(core1.y < b1.y, 'Core 在汇聚交换机上方')

  // 2. 区块内部向下延伸：汇聚 < 二层交换机 < 终端
  assert.ok(b1.y < t4_1.y, 'Building1 在二层交换机 Teaching4-1 上方')
  assert.ok(t4_1.y < pc3.y, '二层交换机 Teaching4-1 在 PC3 上方')
  assert.equal(t4_1.y, t4_2.y, '同区块二层交换机在同一高度')
  assert.equal(pc3.y, pc4.y, '终端在同一高度')

  // 3. 两个区块左右并排排开
  assert.notEqual(b1.x, lib.x, 'Building1 与 Library 区块应左右拉开')
  // 4. 二层交换机左右拉开
  assert.notEqual(t4_1.x, t4_2.x, 'Teaching4-1 与 Teaching4-2 左右并排')
})

test('区块内多级交换机按层级纵向分离，第三层不再与第二层混合在同一行', () => {
  const nodes = [
    { id: 'ar1', name: 'AR1', role: 'router' },
    { id: 'core', name: 'Core', role: 'switch' },
    // 第二层：汇聚交换机
    { id: 'dist', name: 'Dist', role: 'switch' },
    // 第三层：接入交换机
    { id: 'acc1', name: 'Acc-1', role: 'switch' },
    { id: 'acc2', name: 'Acc-2', role: 'switch' },
    { id: 'pc1', name: 'PC-1', role: 'pc' },
    { id: 'pc2', name: 'PC-2', role: 'pc' }
  ]
  const links = [
    { id: 'l1', from: 'ar1', to: 'core' },
    { id: 'l2', from: 'core', to: 'dist' },
    { id: 'l3', from: 'dist', to: 'acc1' },
    { id: 'l4', from: 'dist', to: 'acc2' },
    { id: 'l5', from: 'acc1', to: 'pc1' },
    { id: 'l6', from: 'acc2', to: 'pc2' }
  ]

  const pos = computeAutoLayout(nodes, links)
  const dist = pos.get('dist')
  const acc1 = pos.get('acc1')
  const acc2 = pos.get('acc2')
  const pc1 = pos.get('pc1')
  const pc2 = pos.get('pc2')

  assert.ok(dist && acc1 && acc2 && pc1 && pc2)
  assert.ok(dist.y < acc1.y, '第二层汇聚交换机应在第三层接入交换机上方')
  assert.equal(acc1.y, acc2.y, '同层级接入交换机在同一高度')
  assert.ok(acc1.y < pc1.y, '接入交换机应在终端上方')
  assert.equal(pc1.y, pc2.y, '终端行平齐')
})

test('区块内链路式多级交换机链（第二层 -> 第三层 -> 第四层）逐层下延', () => {
  const nodes = [
    { id: 'ar1', name: 'AR1', role: 'router' },
    { id: 'core', name: 'Core', role: 'switch' },
    { id: 'dist', name: 'Dist', role: 'switch' },
    { id: 'mid', name: 'Mid', role: 'switch' },
    { id: 'acc', name: 'Acc', role: 'switch' },
    { id: 'pc1', name: 'PC-1', role: 'pc' }
  ]
  const links = [
    { id: 'l1', from: 'ar1', to: 'core' },
    { id: 'l2', from: 'core', to: 'dist' },
    { id: 'l3', from: 'dist', to: 'mid' },
    { id: 'l4', from: 'mid', to: 'acc' },
    { id: 'l5', from: 'acc', to: 'pc1' }
  ]

  const pos = computeAutoLayout(nodes, links)
  const dist = pos.get('dist')
  const mid = pos.get('mid')
  const acc = pos.get('acc')
  const pc1 = pos.get('pc1')

  assert.ok(dist && mid && acc && pc1)
  assert.ok(dist.y < mid.y, '第二层在第三层上方')
  assert.ok(mid.y < acc.y, '第三层在第四层上方')
  assert.ok(acc.y < pc1.y, '交换机在最下终端行的上方')
  // 层级链保持垂直对齐（同一列），便于上下连线
  assert.ok(Math.abs((dist?.x ?? 0) - (acc?.x ?? 0)) < 40, '链路链应在同一垂直列附近')
})

test('混合深度区块：各子树终端紧贴父交换机，浅分支不强行沉底最深行（贴近手工图按簇划分）', () => {
  const nodes = [
    { id: 'ar1', name: 'AR1', role: 'router' },
    { id: 'core', name: 'Core', role: 'switch' },
    { id: 'dist', name: 'Dist', role: 'switch' },
    { id: 'accA', name: 'AccA', role: 'switch' }, // 浅分支：终端紧贴其下
    { id: 'accB', name: 'AccB', role: 'switch' }, // 深分支
    { id: 'accC', name: 'AccC', role: 'switch' },
    { id: 'pcA', name: 'PC-A', role: 'pc' },
    { id: 'pcC', name: 'PC-C', role: 'pc' },
    { id: 'srv1', name: 'SRV-1', role: 'server' } // 直挂汇聚的服务器（DMZ 式）
  ]
  const links = [
    { id: 'l1', from: 'ar1', to: 'core' },
    { id: 'l2', from: 'core', to: 'dist' },
    { id: 'l3', from: 'dist', to: 'accA' },
    { id: 'l4', from: 'accA', to: 'pcA' },
    { id: 'l5', from: 'dist', to: 'accB' },
    { id: 'l6', from: 'accB', to: 'accC' },
    { id: 'l7', from: 'accC', to: 'pcC' },
    { id: 'l8', from: 'dist', to: 'srv1' }
  ]

  const pos = computeAutoLayout(nodes, links)
  const dist = pos.get('dist')
  const accA = pos.get('accA')
  const pcA = pos.get('pcA')
  const accC = pos.get('accC')
  const pcC = pos.get('pcC')
  const srv1 = pos.get('srv1')

  assert.ok(dist && accA && pcA && accC && pcC && srv1)
  // 各子树「父交换机 -> 其终端」间距一致（无断层空白）
  assert.equal(
    pcA.y - (accA?.y ?? 0),
    pcC.y - (accC?.y ?? 0),
    '每簇终端到各自父交换机的纵向间距相同'
  )
  // 浅分支终端位于其父交换机下一行，不被沉到最深终端行
  assert.ok((pcA?.y ?? 0) < (pcC?.y ?? 0), '浅分支终端不在最深终端行')
  // 直挂汇聚的服务器与一层接入交换机同排（DMZ 式布局），不再被沉底
  assert.equal(srv1?.y, accA?.y, '直挂汇聚的终端与一层交换机同排')
})

// —— B4 第三批：同层左右顺序按名称自然序 ——
//
// 用户报告的原始现象：「教学区3 在教学区4 的右边」。根因是区块顺序与同级成员顺序过去
// 直接用 `compNodeIds`（BFS 访问顺序），而 BFS 顺序取决于连线在文件里的先后 ——
// 于是「文件里先出现的那台排左边」，与名字完全无关。

test('naturalCompare：数字按数值、字母按字母，大小写不敏感', () => {
  assert.ok(naturalCompare('PC2', 'PC10') < 0, '数字段按数值：2 < 10')
  assert.ok(naturalCompare('Teaching3-1', 'Teaching4-1') < 0)
  assert.ok(naturalCompare('Building3', 'Building4') < 0)
  assert.ok(naturalCompare('Library', 'Teaching3-1') < 0, '字母序：L 在 T 前')
  assert.ok(naturalCompare('a1', 'A2') < 0, '大小写不敏感')
  assert.equal(naturalCompare('Core1', 'core1'), 0, '仅大小写不同视为同名')
})

test('同层左右顺序按名称自然序：教学区3 在教学区4 左边（与数组/文件顺序无关）', () => {
  // 数组顺序**故意**把「4」放在「3」前面 —— eNSP 文件里设备的排列顺序就是这样
  const nodes = [
    { id: 'core', name: 'Core1', role: 'switch' },
    { id: 'b4', name: 'Building4', role: 'switch' },
    { id: 'b3', name: 'Building3', role: 'switch' },
    { id: 't4a', name: 'Teaching4-1', role: 'switch' },
    { id: 't4b', name: 'Teaching4-2', role: 'switch' },
    { id: 't3a', name: 'Teaching3-1', role: 'switch' },
    { id: 't3b', name: 'Teaching3-2', role: 'switch' }
  ]
  const links = [
    { id: 'l1', from: 'core', to: 'b4' },
    { id: 'l2', from: 'core', to: 'b3' },
    { id: 'l3', from: 'b3', to: 't3a' },
    { id: 'l4', from: 'b3', to: 't3b' },
    { id: 'l5', from: 'b4', to: 't4a' },
    { id: 'l6', from: 'b4', to: 't4b' }
  ]
  const pos = computeAutoLayout(nodes, links)
  const b3 = pos.get('b3')
  const b4 = pos.get('b4')
  const t3a = pos.get('t3a')
  const t3b = pos.get('t3b')
  const t4a = pos.get('t4a')
  const t4b = pos.get('t4b')
  assert.ok(b3 && b4 && t3a && t3b && t4a && t4b)
  assert.ok(b3.x < b4.x, 'Building3 区块应在 Building4 左边')
  assert.ok(t3a.x < t4a.x, '教学区3 应在教学区4 左边')
  assert.ok(t3a.x < t3b.x, '同一父交换机下 -1 应在 -2 左边')
  assert.ok(t4a.x < t4b.x, '同一父交换机下 -1 应在 -2 左边')
})

test('名称里的数字按数值排：PC2 在 PC10 左边（不是逐字符顺序）', () => {
  const nodes = [
    { id: 'sw', name: 'LSW1', role: 'switch' },
    { id: 'p10', name: 'PC10', role: 'pc' },
    { id: 'p2', name: 'PC2', role: 'pc' }
  ]
  const links = [
    { id: 'l1', from: 'sw', to: 'p10' },
    { id: 'l2', from: 'sw', to: 'p2' }
  ]
  const pos = computeAutoLayout(nodes, links)
  const p2 = pos.get('p2')
  const p10 = pos.get('p10')
  assert.ok(p2 && p10)
  assert.ok(p2.x < p10.x, 'PC2 应在 PC10 左边')
})

test('间距按子树宽度自适应（480px 只是下限）：宽子树的父节点被自己的子树推远', () => {
  // Dist 下挂两台接入：AccA（带 2 台终端）与 AccB（带 1 台终端）。
  // AccA 的子树比 AccB 宽，所以两台接入的**中心距会大于下限**（480px）——
  // 而不是过去「每台设备一律占 3 格」的固定节拍。
  const nodes = [
    { id: 'ar', name: 'AR1', role: 'router' },
    { id: 'x', name: 'Dist', role: 'switch' },
    { id: 'a', name: 'AccA', role: 'switch' },
    { id: 'a1', name: 'PC-A1', role: 'pc' },
    { id: 'a2', name: 'PC-A2', role: 'pc' },
    { id: 'b', name: 'AccB', role: 'switch' },
    { id: 'b1', name: 'PC-B1', role: 'pc' }
  ]
  const links = [
    { id: 'l1', from: 'ar', to: 'x' },
    { id: 'l2', from: 'x', to: 'a' },
    { id: 'l3', from: 'x', to: 'b' },
    { id: 'l4', from: 'a', to: 'a1' },
    { id: 'l5', from: 'a', to: 'a2' },
    { id: 'l6', from: 'b', to: 'b1' }
  ]

  const pos = computeAutoLayout(nodes, links)
  const a = pos.get('a')
  const b = pos.get('b')
  const a1 = pos.get('a1')
  const a2 = pos.get('a2')
  assert.ok(a && b && a1 && a2)

  // 宽子树的父节点离邻居更远（自适应，> 下限而不等于下限）
  assert.ok(b.x - a.x > 480, `AccB 被自己的子树推远：实际中心距 ${b.x - a.x}px`)
  // 同层相邻仍不小于角色对应的最小中心距（终端 = 1 格 = 160px；这里精确居中要求偶数格，故实际 2 格）
  assert.ok(a2.x - a1.x >= 160, `同层相邻终端中心距 ${a2.x - a1.x}px 不得小于 160px`)
  // 父节点**精确**居中于它的子树（首末子节点中点，误差 0）
  assert.equal(a.x - (a1.x + a2.x) / 2, 0, 'AccA 必须精确居中于两台终端的中点')
  // 全部坐标仍落在 160px 格点上
  for (const p of pos.values()) {
    assert.equal(p.x % 160, 0, 'x 必须落在 160px 格点')
    assert.equal(p.y % 160, 0, 'y 必须落在 160px 格点')
  }
})

test('双核心按「窗口」取中点：左边取左边两台的中点、右边取右边两台的中点（中间那台共用）', () => {
  // 用户拍板的规则（括号里是他举的例子）：
  //   · 窗口大小 = ⌈子设备数 ÷ 成员数⌉（3 台 → 每边 2 台；5 台 → 每边 3 台），首尾靠边依次滑窗；
  //   · 窗口里只算**与本成员有连线**的子设备（没连线的分开算）；
  //   · 每台成员**精确**居中于自己窗口的中点，坐标仍落在 160px 格点。
  const nodes = [
    { id: 'ar', name: 'AR3', role: 'router', model: 'AR2240' },
    { id: 'c1', name: 'Core1', role: 'switch', model: 'S5700' },
    { id: 'c2', name: 'Core2', role: 'switch', model: 'S5700' },
    { id: 'b1', name: 'Building3', role: 'switch', model: 'S5700' },
    { id: 'b2', name: 'Building4', role: 'switch', model: 'S5700' },
    { id: 'lib', name: 'Library', role: 'switch', model: 'S5700' },
    { id: 't1', name: 'Teaching3-1', role: 'switch', model: 'S3700' },
    { id: 'pc1', name: 'PC1', role: 'pc', model: 'PC' },
    { id: 'pc2', name: 'PC2', role: 'pc', model: 'PC' }
  ]
  const links = [
    { id: 'l1', from: 'ar', to: 'c1' },
    { id: 'l2', from: 'ar', to: 'c2' },
    { id: 'l3', from: 'c1', to: 'c2' },
    { id: 'l4', from: 'c1', to: 'b1' },
    { id: 'l5', from: 'c1', to: 'b2' },
    { id: 'l6', from: 'c1', to: 'lib' },
    { id: 'l7', from: 'c2', to: 'b1' },
    { id: 'l8', from: 'c2', to: 'b2' },
    { id: 'l9', from: 'c2', to: 'lib' },
    { id: 'l10', from: 'b2', to: 't1' },
    { id: 'l11', from: 't1', to: 'pc1' },
    { id: 'l12', from: 't1', to: 'pc2' }
  ]

  const pos = computeAutoLayout(nodes, links)
  const at = (id) => {
    const p = pos.get(id)
    assert.ok(p, `${id} 必须有坐标`)
    return p
  }
  const mid = (a, b) => (at(a).x + at(b).x) / 2

  // 三台子设备 / 两台成员 → 每边 2 台（左 1-2、右 2-3），Core1 与 Core2 分别取各自窗口中点
  assert.equal(at('c1').x, mid('b1', 'b2'), 'Core1 应居中于左边两台（Building3↔Building4）中点')
  assert.equal(at('c2').x, mid('b2', 'lib'), 'Core2 应居中于右边两台（Building4↔Library）中点')
  assert.notEqual(at('c1').x, at('c2').x, '两台核心各自居中，不是挤在同一个中点')
  // 上一层：AR3 居中于它名下这一簇（双核）的中点
  assert.equal(at('ar').x, mid('c1', 'c2'), 'AR3 应居中于双核中点')
  // 单成员层同样按窗口：Building4 居中于它名下的 Teaching3-1
  assert.equal(at('b2').x, at('t1').x, 'Building4 应居中于它名下的 Teaching3-1')
  assert.equal(at('t1').x, mid('pc1', 'pc2'), 'Teaching3-1 应居中于 PC1↔PC2 中点')
  // 终端下限 1 格；两台时为落在格点中点取 2 格（320px）
  assert.equal(at('pc2').x - at('pc1').x, 320, '两台终端的中心距应为 2 格（下限 160px + 居中取偶）')
  for (const p of pos.values()) {
    assert.equal(p.x % 160, 0, `x=${p.x} 必须落在 160px 格点`)
    assert.equal(p.y % 160, 0, `y=${p.y} 必须落在 160px 格点`)
  }
})

// —— 2026-09-29：同层最小间距（按角色）+ 父子层距守卫 ——
//
// 用户拍板（拓扑画布）：**同层相邻设备的最小中心距按角色给** —— 终端最紧
// （PC 1 格 = 160px、服务器 2 格 = 320px），交换机 / 路由器 / 云 3 格（480px）
// （用户原话「最后一层的终端不用三格隔开」）；**父子两代 = 2 格（320px）**。
// 实际间距由子树宽度与「父设备居中」推导，只会 ≥ 这里的下限。

test('同层相邻设备中心距 ≥ 角色对应的下限（PC 1 格 / 服务器 2 格 / 其余 3 格），父子两代 = 2 格', () => {
  const nodes = [
    { id: 'ar', name: 'AR3', role: 'router', model: 'AR2240' },
    { id: 'c1', name: 'Core1', role: 'switch', model: 'S5700' },
    { id: 'c2', name: 'Core2', role: 'switch', model: 'S5700' },
    { id: 'b1', name: 'Building3', role: 'switch', model: 'S5700' },
    { id: 't1', name: 'Teaching3-1', role: 'switch', model: 'S3700' },
    { id: 't2', name: 'Teaching3-2', role: 'switch', model: 'S3700' },
    { id: 'pc1', name: 'PC1', role: 'pc', model: 'PC' },
    { id: 'pc2', name: 'PC2', role: 'pc', model: 'PC' }
  ]
  const links = [
    { id: 'l1', from: 'ar', to: 'c1' },
    { id: 'l2', from: 'ar', to: 'c2' },
    { id: 'l3', from: 'c1', to: 'c2' }, // 同层互联 → 同一个簇（曾经的 160px 重叠点）
    { id: 'l4', from: 'c1', to: 'b1' },
    { id: 'l5', from: 'c2', to: 'b1' },
    { id: 'l6', from: 'b1', to: 't1' },
    { id: 'l7', from: 'b1', to: 't2' },
    { id: 'l8', from: 't1', to: 'pc1' },
    { id: 'l9', from: 't2', to: 'pc2' }
  ]

  const minPitch = (role) => (role === 'pc' ? 160 : role === 'server' ? 320 : 480)
  const roleOf = new Map(nodes.map((n) => [n.id, n.role]))
  const pos = computeAutoLayout(nodes, links)
  const rows = new Map()
  for (const [id, p] of pos) {
    const row = rows.get(p.y) ?? []
    row.push({ id, x: p.x, role: roleOf.get(id) })
    rows.set(p.y, row)
  }
  for (const [y, row] of rows) {
    row.sort((a, b) => a.x - b.x)
    for (let i = 1; i < row.length; i++) {
      const gap = row[i].x - row[i - 1].x
      const need = Math.max(minPitch(row[i - 1].role), minPitch(row[i].role))
      assert.ok(gap >= need, `y=${y} 行内 ${row[i - 1].id}→${row[i].id} 中心距 ${gap}px < 下限 ${need}px`)
    }
  }
  // 父子两代 = 2 格（320px）
  assert.equal(pos.get('c1').y - pos.get('ar').y, 320, 'AR3 → Core 层距应为 2 格')
  assert.equal(pos.get('b1').y - pos.get('c1').y, 320, 'Core → Building 层距应为 2 格')
  assert.equal(pos.get('t1').y - pos.get('b1').y, 320, 'Building → Teaching 层距应为 2 格')
  assert.equal(pos.get('pc1').y - pos.get('t1').y, 320, 'Teaching → PC 层距应为 2 格')
  // 同层互联的双核仍在同一层（分层结果不受间距调整影响）
  assert.equal(pos.get('c1').y, pos.get('c2').y)
})

test('「外部网」旁挂分支横排：深度横向铺开（父子 2 格）、同层纵向 3 格，不占纵向层数', () => {
  const nodes = [
    { id: 'ar', name: 'AR3', role: 'router', model: 'AR2240' },
    { id: 'c1', name: 'Core1', role: 'switch', model: 'S5700' },
    { id: 'c2', name: 'Core2', role: 'switch', model: 'S5700' },
    { id: 'b1', name: 'Building3', role: 'switch', model: 'S5700' },
    { id: 't1', name: 'Teaching3-1', role: 'switch', model: 'S3700' },
    { id: 'pc1', name: 'PC1', role: 'pc', model: 'PC' },
    { id: 'wan', name: '外部网汇聚', role: 'switch', model: 'S5700' },
    { id: 'acc1', name: '外部网接入1', role: 'switch', model: 'S3700' },
    { id: 'acc2', name: '外部网接入2', role: 'switch', model: 'S3700' },
    { id: 'pc11', name: 'PC11', role: 'pc', model: 'PC' },
    { id: 'pc12', name: 'PC12', role: 'pc', model: 'PC' }
  ]
  const links = [
    { id: 'l1', from: 'ar', to: 'c1' },
    { id: 'l2', from: 'ar', to: 'c2' },
    { id: 'l3', from: 'c1', to: 'c2' },
    { id: 'l4', from: 'c1', to: 'b1' },
    { id: 'l5', from: 'c2', to: 'b1' },
    { id: 'l6', from: 'b1', to: 't1' },
    { id: 'l7', from: 't1', to: 'pc1' },
    { id: 'l8', from: 'ar', to: 'wan' },
    { id: 'l9', from: 'wan', to: 'acc1' },
    { id: 'l10', from: 'wan', to: 'acc2' },
    { id: 'l11', from: 'acc1', to: 'pc11' },
    { id: 'l12', from: 'acc2', to: 'pc12' }
  ]

  const pos = computeAutoLayout(nodes, links)
  const wan = pos.get('wan')
  const acc1 = pos.get('acc1')
  const acc2 = pos.get('acc2')
  const pc11 = pos.get('pc11')
  const pc12 = pos.get('pc12')
  const ar = pos.get('ar')
  const c1 = pos.get('c1')
  const c2 = pos.get('c2')
  assert.ok(wan && acc1 && acc2 && pc11 && pc12 && ar && c1 && c2)

  // 深度 → 向左：儿子在父亲左边 2 格（320px），一层层排成横向阶梯
  assert.equal(wan.x - acc1.x, 320, '外部网汇聚 → 接入 应为 2 格（横向）')
  assert.equal(acc1.x - pc11.x, 320, '接入 → PC 应为 2 格（横向）')
  // 同层 → 纵向排开，间距 ≥ 3 格（480px，为精确居中会取到 4 格）
  assert.ok(acc2.y - acc1.y >= 480, `同层两台接入纵向间距 ${acc2.y - acc1.y}px 不得小于 480px`)
  assert.equal(pc11.y, acc1.y, 'PC 与它的接入交换机同行')
  assert.equal(pc12.y, acc2.y)
  // 横排分支里父设备同样精确居中（在两条行之间）
  assert.equal(wan.y, (acc1.y + acc2.y) / 2, '外部网汇聚必须精确居中于两台接入之间')
  // 整支只占顶部两条带，不再往下叠三层
  assert.ok(wan.y < c1.y + 320, '外部网分支不占用主树三层的纵向高度')
  assert.ok(ar.x > wan.x, '外部网分支整体摆在外侧，不与主树挤在一起')
  // 主树节拍不受影响
  assert.equal(c1.y - ar.y, 320)
  assert.equal(ar.x, (c1.x + c2.x) / 2, 'AR3 必须精确居中于双核中点')
})
