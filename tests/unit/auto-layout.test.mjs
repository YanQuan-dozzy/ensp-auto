/**
 * 拓扑自适应布局测试：
 * 验证上下层级与左右骨干融合、多连通分量排布与孤立设备矩阵化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeAutoLayout } from '../.build/harness.mjs'

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
