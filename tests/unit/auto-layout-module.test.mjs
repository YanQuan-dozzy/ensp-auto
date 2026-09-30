import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  layoutTopologyBySource,
  layoutTopology,
  layoutTopologyTree,
  inferLayoutMode,
  computeBlockBoxes,
  estimateNodeSizeAligned,
  pitchCells,
  sourcePosOf,
  LAYOUT_GRID,
  LAYER_GAP
} from '../.build/harness.mjs'

/**
 * 源图保真布局内核（`layoutTopologyBySource`）的黄金用例。
 *
 * 与 `auto-layout-golden.test.mjs` 的分工：那份冻结**树形内核**（无源坐标的手工拓扑），
 * 这份冻结**源图保真内核**（带 eNSP 源坐标的工程）。
 *
 * ## 冻结口径（2026-10-01 **第七版：源坐标骨架**）
 *
 * 用户口径：「**保留源坐标骨架，只做防重叠 + 父居中**」。前六版的共同病根是
 * **模块内部重排 + 模块按方位摆开**：实测「企业网实例」26 台的输出 x 与源坐标线性拟合
 * 斜率是 −0.40（左右被翻乱）、「最终」40 台平均坐标偏差 553px。
 *
 * 第七版只有四步：**整体等比放大 → 落 160 格点 → 行内防重叠 → 独苗终端对齐父设备**。
 *
 * 本文件的断言按「用户看图能分辨的东西」组织，另加一层逐节点坐标冻结（T1）。
 * **有意重排必须重新冻结 T1**（先对着源图逐台核对，不要盲抄输出）。
 */

// ============================================================================
// 真实工程骨架：用户那份 `网络设计拓扑.topo` 的 31 台设备（逐台照抄，见 v2.30 的教训）
// ============================================================================
const REAL_NODES = [
  { id: 'Teaching4-1', name: 'Teaching4-1', role: 'switch', srcX: 273, srcY: 373 },
  { id: 'Library-2', name: 'Library-2', role: 'switch', srcX: 673, srcY: 373 },
  { id: 'Library-1', name: 'Library-1', role: 'switch', srcX: 573, srcY: 373 },
  { id: 'Teaching3-2', name: 'Teaching3-2', role: 'switch', srcX: 173, srcY: 373 },
  { id: 'PC6', name: 'PC6', role: 'pc', srcX: 609, srcY: 487 },
  { id: 'Building3', name: 'Building3', role: 'switch', srcX: 173, srcY: 273 },
  { id: 'Library', name: 'Library', role: 'switch', srcX: 601, srcY: 271 },
  { id: 'Building4', name: 'Building4', role: 'switch', srcX: 373, srcY: 273 },
  { id: 'LSW18', name: 'LSW18', role: 'switch', srcX: 209.330017, srcY: 31.460001 },
  { id: 'PC7', name: 'PC7', role: 'pc', srcX: 686, srcY: 486 },
  { id: '外部网汇聚', name: '外部网汇聚', role: 'switch', srcX: 473.26004, srcY: 73.820007 },
  { id: 'Teaching4-2', name: 'Teaching4-2', role: 'switch', srcX: 473, srcY: 373 },
  { id: 'FTP服务器', name: 'FTP服务器', role: 'server', srcX: 68, srcY: 84 },
  { id: 'DNS服务器', name: 'DNS服务器', role: 'server', srcX: 74.600006, srcY: 13.110001 },
  { id: 'PC12', name: 'PC12', role: 'pc', srcX: 775.610046, srcY: 116.160004 },
  { id: 'PC11', name: 'PC11', role: 'pc', srcX: 781.660034, srcY: 11.89 },
  { id: 'PC1', name: 'PC1', role: 'pc', srcX: 69, srcY: 483 },
  { id: 'Teaching3-1', name: 'Teaching3-1', role: 'switch', srcX: 73, srcY: 373 },
  { id: 'PC2', name: 'PC2', role: 'pc', srcX: 179, srcY: 482 },
  { id: 'PC3', name: 'PC3', role: 'pc', srcX: 273, srcY: 473 },
  { id: 'AR3', name: 'AR3', role: 'router', srcX: 373, srcY: 73 },
  { id: 'HTTP服务器', name: 'HTTP服务器', role: 'server', srcX: 4.890015, srcY: 36.900009 },
  { id: 'PC9', name: 'PC9', role: 'pc', srcX: 774, srcY: 486 },
  { id: 'AR2', name: 'AR2', role: 'router', srcX: 224, srcY: 923 },
  { id: 'LSW16', name: 'LSW16', role: 'switch', srcX: 324, srcY: 922 },
  { id: 'Core1', name: 'Core1', role: 'switch', srcX: 273, srcY: 173 },
  { id: 'Core2', name: 'Core2', role: 'switch', srcX: 473, srcY: 173 },
  { id: 'PC4', name: 'PC4', role: 'pc', srcX: 373, srcY: 473 },
  { id: 'PC5', name: 'PC5', role: 'pc', srcX: 490, srcY: 480 },
  { id: '外部网接入2', name: '外部网接入2', role: 'switch', srcX: 673.140015, srcY: 173.100006 },
  { id: '外部网接入1', name: '外部网接入1', role: 'switch', srcX: 673.02002, srcY: 73.660004 }
]

const REAL_LINKS = [
  { id: 'file-Core1->Core2', from: 'Core1', to: 'Core2' },
  { id: 'file-Core1->Building3', from: 'Core1', to: 'Building3' },
  { id: 'file-Core1->Building4', from: 'Core1', to: 'Building4' },
  { id: 'file-Core1->Library', from: 'Core1', to: 'Library' },
  { id: 'file-Core2->Building4', from: 'Core2', to: 'Building4' },
  { id: 'file-Core2->Library', from: 'Core2', to: 'Library' },
  { id: 'file-Building3->Teaching3-1', from: 'Building3', to: 'Teaching3-1' },
  { id: 'file-Building3->Teaching3-2', from: 'Building3', to: 'Teaching3-2' },
  { id: 'file-Building4->Teaching4-1', from: 'Building4', to: 'Teaching4-1' },
  { id: 'file-Building4->Teaching4-2', from: 'Building4', to: 'Teaching4-2' },
  { id: 'file-Library->Library-1', from: 'Library', to: 'Library-1' },
  { id: 'file-Library->Library-2', from: 'Library', to: 'Library-2' },
  { id: 'file-Teaching3-1->PC1', from: 'Teaching3-1', to: 'PC1' },
  { id: 'file-Teaching3-2->PC2', from: 'Teaching3-2', to: 'PC2' },
  { id: 'file-Teaching4-1->PC3', from: 'Teaching4-1', to: 'PC3' },
  { id: 'file-Teaching4-2->PC4', from: 'Teaching4-2', to: 'PC4' },
  { id: 'file-Library-1->PC5', from: 'Library-1', to: 'PC5' },
  { id: 'file-Library-2->PC7', from: 'Library-2', to: 'PC7' },
  { id: 'file-Library-1->PC6', from: 'Library-1', to: 'PC6' },
  { id: 'file-Library-2->PC9', from: 'Library-2', to: 'PC9' },
  { id: 'file-Core2->Building3', from: 'Core2', to: 'Building3' },
  { id: 'file-外部网接入1->PC11', from: '外部网接入1', to: 'PC11' },
  { id: 'file-外部网接入2->PC12', from: '外部网接入2', to: 'PC12' },
  { id: 'file-外部网汇聚->外部网接入1', from: '外部网汇聚', to: '外部网接入1' },
  { id: 'file-外部网汇聚->外部网接入2', from: '外部网汇聚', to: '外部网接入2' },
  { id: 'file-DNS服务器->LSW18', from: 'DNS服务器', to: 'LSW18' },
  { id: 'file-FTP服务器->LSW18', from: 'FTP服务器', to: 'LSW18' },
  { id: 'file-HTTP服务器->LSW18', from: 'HTTP服务器', to: 'LSW18' },
  { id: 'file-AR3->Core2', from: 'AR3', to: 'Core2' },
  { id: 'file-AR3->Core1', from: 'AR3', to: 'Core1' },
  { id: 'file-AR3->外部网汇聚', from: 'AR3', to: '外部网汇聚' }
]

/** 冻结于 2026-10-01（第七版源坐标骨架，已逐台对照源图核对）。有意重排要重新冻结。 */
const GOLDEN_REAL = {
  AR2: [160, 1760],
  AR3: [1120, 320],
  Building3: [640, 800],
  Building4: [1120, 800],
  Core1: [800, 640],
  Core2: [1280, 640],
  DNS服务器: [320, 160],
  FTP服务器: [320, 320],
  HTTP服务器: [160, 320],
  LSW16: [480, 1760],
  LSW18: [640, 160],
  Library: [1600, 800],
  'Library-1': [1600, 1120],
  'Library-2': [1920, 1120],
  PC1: [320, 1280],
  PC11: [2080, 320],
  PC12: [2080, 640],
  PC2: [640, 1280],
  PC3: [960, 1280],
  PC4: [1120, 1280],
  PC5: [1280, 1280],
  PC6: [1600, 1280],
  PC7: [1760, 1280],
  PC9: [2080, 1280],
  'Teaching3-1': [320, 1120],
  'Teaching3-2': [640, 1120],
  'Teaching4-1': [960, 1120],
  'Teaching4-2': [1280, 1120],
  '外部网接入1': [1760, 320],
  '外部网接入2': [1760, 640],
  外部网汇聚: [1440, 320]
}

const NAME = new Map(REAL_NODES.map((n) => [n.id, n.name]))
const SRC = new Map(REAL_NODES.map((n) => [n.id, { x: n.srcX, y: n.srcY }]))
/** 度为 0 的设备：骨架不管它们，统一收在底部矩阵（不参与骨架保真断言） */
const ISOLATED = new Set(['AR2', 'LSW16'])
const at = (m, id) => {
  const p = m.positions.get(id)
  assert.ok(p, `${NAME.get(id) ?? id} 必须有坐标`)
  return p
}
const layoutReal = () => layoutTopologyBySource(REAL_NODES, REAL_LINKS, {})

/** 按 y 分组（同一行） */
function rowsOf(positions) {
  const byY = new Map()
  for (const [id, p] of positions) {
    const arr = byY.get(p.y) ?? []
    arr.push({ id, x: p.x })
    byY.set(p.y, arr)
  }
  return [...byY.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, ids]) => ({ y, ids: ids.sort((a, b) => a.x - b.x) }))
}

/** 秩相关（0~1，1 = 排序完全一致）—— 衡量「输出还像不像源图」 */
function spearman(ids, ax, ao, positions) {
  const rank = (list) => new Map([...list].sort((a, b) => a[1] - b[1]).map((e, i) => [e[0], i]))
  const r1 = rank(ids.map((id) => [id, SRC.get(id)[ax]]))
  const r2 = rank(ids.map((id) => [id, positions.get(id)[ao]]))
  let d2 = 0
  for (const id of ids) {
    const d = r1.get(id) - r2.get(id)
    d2 += d * d
  }
  const n = ids.length
  return 1 - (6 * d2) / (n * (n * n - 1))
}

// ============================================================================
// T1：逐节点坐标冻结（任何挪动都是可见回归）
// ============================================================================
test('源图保真 T1：真实工程逐节点坐标冻结', () => {
  const m = layoutReal()
  const actual = {}
  for (const id of Object.keys(GOLDEN_REAL).sort()) actual[id] = [at(m, id).x, at(m, id).y]
  assert.deepEqual(actual, GOLDEN_REAL)
})

// ============================================================================
// A1：骨架保真 —— 每个行内的左右次序必须与源图一致，整体秩相关 ≥ 0.95
// ============================================================================
test('A1 骨架保真：同一行内 x 次序与源图逐台一致；x/y 秩相关 ≥ 0.95', () => {
  const m = layoutReal()
  for (const row of rowsOf(m.positions)) {
    const ids = row.ids.map((e) => e.id).filter((id) => !ISOLATED.has(id))
    for (let i = 1; i < ids.length; i++) {
      assert.ok(
        SRC.get(ids[i - 1]).x < SRC.get(ids[i]).x,
        `y=${row.y} 行内 ${NAME.get(ids[i - 1])}→${NAME.get(ids[i])} 的左右次序与源图不一致`
      )
    }
  }
  const ids = REAL_NODES.map((n) => n.id).filter((id) => !ISOLATED.has(id))
  const rx = spearman(ids, 'x', 'x', m.positions)
  const ry = spearman(ids, 'y', 'y', m.positions)
  assert.ok(rx >= 0.95, `x 与源图的秩相关必须 ≥ 0.95（实得 ${rx.toFixed(3)}）`)
  // y 的秩相关略低于 x：**独苗终端对齐**会有意把终端挪到父设备那一行（源图里 `PC11` 与
  // `外部网接入1` 差 60 单位，落格点后各占一行，对齐时终端上移一行 —— 属于设计要求）。
  assert.ok(ry >= 0.94, `y 与源图的秩相关必须 ≥ 0.94（实得 ${ry.toFixed(3)}）`)
})

// ============================================================================
// A2：防重叠 —— 不怕挤，怕压框
// ============================================================================
test('A2 防重叠：同层相邻满足角色档位、无压框、无同坐标、全落格点', () => {
  const m = layoutReal()
  assert.equal(m.positions.size, REAL_NODES.length)
  const role = new Map(REAL_NODES.map((n) => [n.id, n.role]))
  const seen = new Map()
  for (const [id, p] of m.positions) {
    assert.equal(p.x % LAYOUT_GRID, 0, `${NAME.get(id)} 的 x=${p.x} 必须落 160 格点`)
    assert.equal(p.y % LAYOUT_GRID, 0, `${NAME.get(id)} 的 y=${p.y} 必须落 160 格点`)
    const key = `${p.x},${p.y}`
    assert.equal(seen.has(key), false, `坐标重叠：${NAME.get(id)} 与 ${NAME.get(seen.get(key))} @${key}`)
    seen.set(key, id)
  }
  // 设备框两两不重叠（这是「防重叠」的字面含义，也是硬不变式）
  const size = new Map(REAL_NODES.map((n) => [n.id, estimateNodeSizeAligned(n.name, n.role, n.model)]))
  const ids = [...m.positions.keys()]
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = m.positions.get(ids[i])
      const b = m.positions.get(ids[j])
      const sa = size.get(ids[i])
      const sb = size.get(ids[j])
      const ox = (sa.w + sb.w) / 2 - Math.abs(a.x - b.x)
      const oy = (sa.h + sb.h) / 2 - Math.abs(a.y - b.y)
      assert.ok(
        ox <= 0 || oy <= 0,
        `${NAME.get(ids[i])} 与 ${NAME.get(ids[j])} 的设备框压在一起（重叠 ${ox.toFixed(0)}×${oy.toFixed(0)}px）`
      )
    }
  }
  // 同一行内相邻两台的中心距 ≥ 角色档位（终端↔终端 1 格、含网络设备 2 格）——档位按**这一对**算
  for (const row of rowsOf(m.positions)) {
    for (let i = 1; i < row.ids.length; i++) {
      const a = row.ids[i - 1].id
      const b = row.ids[i].id
      const need = pitchCells(role.get(a), role.get(b)) * LAYOUT_GRID
      const gap = row.ids[i].x - row.ids[i - 1].x
      assert.ok(
        gap >= need,
        `y=${row.y} 行 ${NAME.get(a)}→${NAME.get(b)} 中心距 ${gap}px < 下限 ${need}px`
      )
    }
  }
})

// ============================================================================
// A3：父居中 —— 独苗终端必须正对父设备
// ============================================================================
test('A3 父居中：独苗终端垂直/水平正对父设备（误差 ≤ 半格）', () => {
  const m = layoutReal()
  // 只列**独苗终端**（一台父设备名下只有这一台终端）—— 多子由源图自己的居中决定。
  // `Teaching4-2 ↔ PC4` 不在此列：它那一行两台都挤满了（PC4 左边是 PC3、右边是 PC5，
  // Teaching4-2 左边是 Teaching4-1），挪谁都压框 → 按「不压框优先」保持源图位置。
  const pairs = [
    ['Teaching3-1', 'PC1'],
    ['Teaching3-2', 'PC2'],
    ['Teaching4-1', 'PC3'],
    ['外部网接入1', 'PC11'],
    ['外部网接入2', 'PC12']
  ]
  for (const [parent, child] of pairs) {
    const pp = at(m, parent)
    const cp = at(m, child)
    const sameRow = pp.y === cp.y
    const sameCol = pp.x === cp.x
    assert.ok(
      sameRow || sameCol,
      `${NAME.get(parent)} 与它的独苗终端 ${NAME.get(child)} 必须在同一行或同一列`
    )
  }
})

// ============================================================================
// A4：分组框（模块划分只决定框，不决定摆位）
// ============================================================================
test('A4 分组框：语义标题、成员归属、框两两不重叠', () => {
  const m = layoutReal()
  const byTitle = new Map(m.blocks.map((b) => [b.title, b]))
  assert.deepEqual([...byTitle.keys()].sort(), ['Core1 区', '图书馆', '外网', '教学区', '服务器区'].sort())
  const names = (t) => byTitle.get(t).nodeIds.map((id) => NAME.get(id)).sort()
  assert.deepEqual(names('服务器区'), ['DNS服务器', 'FTP服务器', 'HTTP服务器', 'LSW18'])
  assert.deepEqual(
    names('图书馆'),
    ['Building4', 'Library', 'Library-1', 'Library-2', 'PC3', 'PC4', 'PC5', 'PC6', 'PC7', 'PC9', 'Teaching4-1', 'Teaching4-2'].sort(),
    '4 号楼 + 图书馆子树必须整块'
  )
  assert.deepEqual(names('Core1 区'), ['AR3', 'Core1', 'Core2'], 'AR3（桥接设备）必须与双核同块')
  assert.deepEqual(names('外网'), ['PC11', 'PC12', '外部网接入1', '外部网接入2', '外部网汇聚'].sort())

  const blockOf = new Map()
  for (const b of m.blocks) for (const id of b.nodeIds) blockOf.set(id, b.title)
  assert.equal(blockOf.get('AR3'), blockOf.get('Core1'), 'AR3 必须与双核同区块')
  assert.notEqual(blockOf.get('LSW18'), blockOf.get('Core1'), '服务器簇不得与核心同区块')
  assert.equal(blockOf.get('Library'), blockOf.get('PC9'), '图书馆设备不得被甩到别的区块')

  for (let i = 0; i < m.blocks.length; i++) {
    for (let j = i + 1; j < m.blocks.length; j++) {
      const a = m.blocks[i].box
      const b = m.blocks[j].box
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
      assert.ok(apart, `${m.blocks[i].title} 与 ${m.blocks[j].title} 的框不得重叠`)
    }
  }
})

// ============================================================================
// A5：宏观方位与源图一致（不再被折行重排）
// ============================================================================
test('A5 宏观方位：三台服务器在 LSW18 左侧、外网在右、双核在楼宇上方、孤立设备在底部', () => {
  const m = layoutReal()
  for (const id of ['HTTP服务器', 'DNS服务器', 'FTP服务器']) {
    assert.ok(at(m, id).x < at(m, 'LSW18').x, `${NAME.get(id)} 必须在 LSW18 左侧（跟源图方位）`)
  }
  assert.ok(at(m, '外部网接入1').x > at(m, '外部网汇聚').x, '外网接入必须在汇聚右侧')
  assert.ok(at(m, 'PC11').x > at(m, '外部网接入1').x, 'PC 继续向右')
  assert.ok(at(m, '外部网汇聚').y <= at(m, 'AR3').y, '外网在顶部带（源图右上）')
  for (const id of ['Building3', 'Building4', 'Library']) {
    assert.ok(at(m, id).y > at(m, 'Core1').y, `${NAME.get(id)} 必须在双核下方`)
  }
  for (const id of ['AR2', 'LSW16']) {
    assert.ok(at(m, id).y > at(m, 'Core1').y, `${NAME.get(id)}（度为 0）收在底部`)
  }
})

// ============================================================================
// A6：常量与放大档位
// ============================================================================
test('A6 常量：终端档 1 格 / 含网络设备 2 格；画布被等比放大且长宽比不变形', () => {
  assert.equal(pitchCells('pc', 'pc'), 1)
  assert.equal(pitchCells('pc', 'server'), 1)
  assert.equal(pitchCells('pc', 'switch'), 2)
  assert.equal(pitchCells('router', 'router'), 2)
  assert.equal(LAYER_GAP, LAYOUT_GRID * 2)

  const m = layoutReal()
  let x1 = Infinity
  let x2 = -Infinity
  let y1 = Infinity
  let y2 = -Infinity
  for (const p of m.positions.values()) {
    x1 = Math.min(x1, p.x)
    x2 = Math.max(x2, p.x)
    y1 = Math.min(y1, p.y)
    y2 = Math.max(y2, p.y)
  }
  // 源图 776.8 × 911.1 → 放大到 1920 × 1600（约 2.2 倍，且长宽比没被拉变形）
  assert.ok(x2 - x1 <= 3200 && y2 - y1 <= 3200, '画布不应被放大到离谱的尺寸')
  assert.ok((x2 - x1) / (y2 - y1) > 0.6, '长宽比不能被拉变形')
})

// ============================================================================
// A8：多台终端兄弟必须对齐到同一排（吸附误差不许把它们拆到两行）
// ============================================================================
test('A8 终端兄弟对齐：源图里本来是一排的三台服务器，输出必须同一行且父居中', () => {
  // 源图里三台服务器 y = 200 / 205 / 210（同一排），等比放大后相邻两台会跨在 160 格点两侧，
  // 各自吸附就会一台落到上一行、两台落到下一行 —— 正是用户报的「三个子节点要对齐」
  const nodes = [
    { id: 'sw', name: 'SW3', role: 'switch', srcX: 100, srcY: 100 },
    { id: 's1', name: 'ftp服务器', role: 'server', srcX: 0, srcY: 200 },
    { id: 's2', name: 'web服务器', role: 'server', srcX: 100, srcY: 205 },
    { id: 's3', name: 'DNS服务器', role: 'server', srcX: 200, srcY: 210 }
  ]
  const links = [
    { id: '1', from: 'sw', to: 's1' },
    { id: '2', from: 'sw', to: 's2' },
    { id: '3', from: 'sw', to: 's3' }
  ]
  const m = layoutTopologyBySource(nodes, links, {})
  const ys = ['s1', 's2', 's3'].map((id) => at(m, id).y)
  assert.equal(ys[0], ys[1], 'ftp服务器 与 web服务器 必须同一行')
  assert.equal(ys[1], ys[2], 'web服务器 与 DNS服务器 必须同一行')
  const xs = ['s1', 's2', 's3'].map((id) => at(m, id).x)
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] > xs[i - 1], '同一排内左右次序不能乱')
    assert.ok(xs[i] - xs[i - 1] >= LAYOUT_GRID, '同排相邻中心距 ≥ 1 格')
  }
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2
  assert.ok(
    Math.abs(at(m, 'sw').x - mid) <= LAYOUT_GRID / 2,
    `父设备必须居中于这一排终端（偏差 ${Math.abs(at(m, 'sw').x - mid)}px > 半格）`
  )
})

test('A8b 拉齐会压框的组合整组跳过（不许为了对齐把两台叠到一起）', () => {
  // 源图里 s1/s2 的 x 都是 0（同列），s3 在右边 —— 判成「一排」后 s1/s2 会撞在一起，
  // 这种组合必须整组不动，保持源图位置
  const nodes = [
    { id: 'sw', name: 'SW1', role: 'switch', srcX: 100, srcY: 100 },
    { id: 's1', name: 'PC1', role: 'pc', srcX: 0, srcY: 200 },
    { id: 's2', name: 'PC2', role: 'pc', srcX: 0, srcY: 210 },
    { id: 's3', name: 'PC3', role: 'pc', srcX: 300, srcY: 205 }
  ]
  const links = [
    { id: '1', from: 'sw', to: 's1' },
    { id: '2', from: 'sw', to: 's2' },
    { id: '3', from: 'sw', to: 's3' }
  ]
  const m = layoutTopologyBySource(nodes, links, {})
  const a = at(m, 's1')
  const b = at(m, 's2')
  assert.ok(
    !(a.x === b.x && a.y === b.y),
    's1/s2 不许被叠到同一个点'
  )
})

// ============================================================================
// A7：单终端正下方 / ≥2 台并排且父居中
// ============================================================================
test('A7 单终端挂在父设备正下方（同一列）', () => {
  const nodes = [
    { id: 'a', name: 'SW-A', role: 'switch', srcX: 100, srcY: 100 },
    { id: 'p1', name: 'PC-1', role: 'pc', srcX: 100, srcY: 300 },
    { id: 'b', name: 'SW-B', role: 'switch', srcX: 400, srcY: 100 },
    { id: 'p2', name: 'PC-2', role: 'pc', srcX: 380, srcY: 300 },
    { id: 'p3', name: 'PC-3', role: 'pc', srcX: 450, srcY: 300 }
  ]
  const links = [
    { id: '1', from: 'a', to: 'p1' },
    { id: '2', from: 'b', to: 'p2' },
    { id: '3', from: 'b', to: 'p3' }
  ]
  const m = layoutTopologyBySource(nodes, links, {})
  assert.equal(at(m, 'p1').x, at(m, 'a').x, '单终端必须在父设备正下方（同 x）')
  // 层距跟源图（源里隔 200 单位 → 放大后 3 格），**不是**固定 2 格（第七版不再统一层距）
  assert.ok(at(m, 'p1').y - at(m, 'a').y >= LAYER_GAP, '父子之间至少隔 2 格')
  assert.equal(at(m, 'p2').y, at(m, 'p3').y, '两台终端必须并排（同 y）')
  assert.ok(at(m, 'p3').x - at(m, 'p2').x >= LAYOUT_GRID, '终端中心距 ≥ 1 格')
})

// ============================================================================
// 内核判定 / 标题透传 / 回退
// ============================================================================
test('T5 内核自动判定：带源坐标走保真、无源坐标回退树形（逐节点一致）', () => {
  assert.equal(inferLayoutMode(REAL_NODES, {}), 'module')
  const plain = REAL_NODES.map(({ srcX, srcY, ...rest }) => rest)
  assert.equal(inferLayoutMode(plain, {}), 'tree')
  const auto = layoutTopology(plain, REAL_LINKS)
  const tree = layoutTopologyTree(plain, REAL_LINKS, {})
  assert.equal(auto.positions.size, tree.positions.size)
  for (const [id, p] of tree.positions) {
    const q = auto.positions.get(id)
    assert.deepEqual([q.x, q.y], [p.x, p.y], `${id} 回退结果必须与树形内核一致`)
  }
  assert.doesNotThrow(() => layoutTopology(REAL_NODES, REAL_LINKS, { mode: 'tree' }))
  assert.doesNotThrow(() => layoutTopology(REAL_NODES, REAL_LINKS, { mode: 'module' }))
})

test('T9 画布重算包围盒时不得丢掉模块标题（静默失效路径）', () => {
  const m = layoutReal()
  const nodeMap = new Map(REAL_NODES.map((n) => [n.id, n]))
  const again = computeBlockBoxes(m.blocks, nodeMap, m.positions)
  assert.deepEqual(
    again.map((b) => b.title),
    m.blocks.map((b) => b.title),
    '重算包围盒必须原样带过 title'
  )
  assert.ok(again.some((b) => b.title === '外网'))
  for (let i = 0; i < again.length; i++) assert.deepEqual(again[i].box, m.blocks[i].box)
})

test('无源坐标的设备按拓扑落位（跟邻居同块、落在下一层、仍落格点）', () => {
  const nodes = [
    { id: 'sw', name: 'LSW1', role: 'switch', srcX: 100, srcY: 100 },
    { id: 'p1', name: 'PC1', role: 'pc', srcX: 100, srcY: 300 },
    { id: 'pNew', name: 'PC新', role: 'pc' } // 手动新建，没有源坐标
  ]
  const links = [
    { id: '1', from: 'sw', to: 'p1' },
    { id: '2', from: 'sw', to: 'pNew' }
  ]
  const m = layoutTopologyBySource(nodes, links, {})
  assert.equal(m.blocks.length, 1)
  assert.equal(at(m, 'pNew').y - at(m, 'sw').y, LAYER_GAP, '无源坐标设备也应落在父设备下一层')
  for (const [, p] of m.positions) {
    assert.equal(p.x % LAYOUT_GRID, 0)
    assert.equal(p.y % LAYOUT_GRID, 0)
  }
})

test('纯路由器链（认不出汇聚层 → 整个分量一个模块）保留源图横向次序', () => {
  const nodes = [
    { id: 'r1', name: 'AR1', role: 'router', srcX: 100, srcY: 100 },
    { id: 'r2', name: 'AR2', role: 'router', srcX: 300, srcY: 100 },
    { id: 'r3', name: 'AR3', role: 'router', srcX: 500, srcY: 100 }
  ]
  const links = [
    { id: '1', from: 'r1', to: 'r2' },
    { id: '2', from: 'r2', to: 'r3' }
  ]
  const m = layoutTopologyBySource(nodes, links, {})
  assert.equal(m.blocks.length, 1, '认不出汇聚子树 → 整块')
  // 源图里三台在**同一行**上横排 → 输出仍是同一行、且左右次序一致（骨架保真）
  assert.equal(at(m, 'r1').y, at(m, 'r2').y)
  assert.equal(at(m, 'r2').y, at(m, 'r3').y)
  assert.ok(at(m, 'r1').x < at(m, 'r2').x && at(m, 'r2').x < at(m, 'r3').x, '横向次序跟源图')
  assert.ok(at(m, 'r2').x - at(m, 'r1').x >= LAYOUT_GRID * 2, '两台路由器中心距 ≥ 2 格')
})

test('孤立设备（度为 0）收拢在底部矩阵，不混进任何模块', () => {
  const nodes = [
    { id: 'sw', name: 'LSW1', role: 'switch', srcX: 100, srcY: 100 },
    { id: 'p1', name: 'PC1', role: 'pc', srcX: 100, srcY: 300 },
    { id: 'iso1', name: 'AR2', role: 'router', srcX: 224, srcY: 923 },
    { id: 'iso2', name: 'LSW16', role: 'switch', srcX: 324, srcY: 922 }
  ]
  const links = [{ id: '1', from: 'sw', to: 'p1' }]
  const m = layoutTopologyBySource(nodes, links, {})
  assert.ok(at(m, 'iso1').y > at(m, 'p1').y, '孤立设备在网络下方')
  assert.ok(at(m, 'iso1').y > at(m, 'sw').y)
  assert.equal(
    m.blocks.some((b) => b.nodeIds.includes('iso1')),
    false,
    '孤立设备不得混进模块'
  )
})

test('sourcePosOf：只有带 srcX/srcY 的设备才进源坐标表', () => {
  const src = sourcePosOf([
    { id: 'a', name: 'A', role: 'pc', srcX: 1, srcY: 2 },
    { id: 'b', name: 'B', role: 'pc' }
  ])
  assert.equal(src.size, 1)
  assert.deepEqual(src.get('a'), { x: 1, y: 2 })
})