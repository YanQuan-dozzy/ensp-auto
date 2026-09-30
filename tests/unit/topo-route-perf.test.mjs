/**
 * v2.29 导入性能治理的**等价性守卫**。
 *
 * 背景：导入大拓扑时 `planRoutes` 是全流程瓶颈（实测 300 台 64ms、40 台 2.8ms），
 * 根因是三处「一条线段 × 全部障碍」的全量扫描。优化手段是**障碍空间索引粗筛 +
 * segHitsRect 精判**，并复用调用方已算好的槽位/端口表。
 *
 * 本文件的职责不是测性能数字（那是探针的事，机器差异大），而是钉死一条口径：
 * **索引只做排除、绝不改判据**。做法是拿一个「恒等返回全部障碍」的对照组与
 * 生产实现对比，逐位比较产生的路径几何。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ObstacleIndex,
  segHitsRect,
  planRoutes,
  computeAutoLayout,
  layoutTopology,
  computeBlockBoxes,
  sourcePosOf,
  assignPortSlots,
  assignLinkPorts,
  buildRowModel,
  alignNodeSizes
} from '../.build/harness.mjs'

/** 造一张带确定性抖动 + 跨层跳级的拓扑，逼出全部分支（直线/相邻行/同层/跨层） */
function makeTopology(rows, perRow, fanout, seed) {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const nodes = []
  const links = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < perRow; c += 1) {
      const i = r * perRow + c
      const kind = r === 0 ? 'router' : r === 1 ? 'switch' : c % 5 === 0 ? 'server' : 'pc'
      nodes.push({
        id: `n${i}`,
        name: kind === 'pc' ? `PC-${r}-${c}` : `Srv-${r}-${c}`,
        role: kind,
        ...(kind === 'router' ? { model: 'AR2220' } : {}),
        srcX: 100 + c * 200 + Math.round((rnd() - 0.5) * 90),
        srcY: 100 + r * 160 + Math.round((rnd() - 0.5) * 70)
      })
    }
  }
  const idx = (r, c) => r * perRow + c
  for (let r = 1; r < rows; r += 1) {
    for (let c = 0; c < perRow; c += 1) {
      for (let k = 0; k < fanout; k += 1) {
        const p = Math.min(perRow - 1, c + k - 1)
        links.push({ id: `l-${r}-${c}-${p}`, from: `n${idx(r, c)}`, to: `n${idx(r - 1, p)}`, source: 'file', label: `GE0/0/${k} ↔ GE0/0/1` })
      }
      if (c > 0 && c % 4 === 0) links.push({ id: `h-${r}-${c}`, from: `n${idx(r, c - 1)}`, to: `n${idx(r, c)}`, source: 'file', label: 'GE0/0/2 ↔ GE0/0/3' })
      // 跨层跳级（间隔 ≥2 行）→ 走 nearestFreeChannel 分支
      if (c % 7 === 0 && r >= 2) links.push({ id: `x-${r}-${c}`, from: `n${idx(r, c)}`, to: `n${idx(r - 2, c)}`, source: 'file', label: 'GE0/0/3 ↔ GE0/0/3' })
    }
  }
  return { nodes, links }
}

/** 把 planRoutes 结果规范化成可逐位比较的结构 */
function serialize(model) {
  const r2 = (v) => Math.round(v * 100) / 100
  return {
    routes: [...model.routes.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, r]) => ({
        k,
        points: r.points.map((p) => [r2(p.x), r2(p.y)]),
        startAxis: r.startAxis,
        endAxis: r.endAxis,
        fallback: r.fallback,
        straight: r.straight,
        from: [r2(r.fromPoint.x), r2(r.fromPoint.y)],
        to: [r2(r.toPoint.x), r2(r.toPoint.y)],
        fromW: r.fromW,
        toW: r.toW,
        bundle: r.bundle
      })),
    blocks: model.framedBlocks.map((b) => ({ headId: b.headId, title: b.title ?? null, box: b.box })),
    blockOf: [...model.blockOf.entries()].sort(),
    rows: model.rows.map((row) => ({ y: r2(row.y), ids: [...row.nodeIds].sort() }))
  }
}

const CASES = [
  ['5×8 fanout3', makeTopology(5, 8, 3, 7)],
  ['8×10 fanout3', makeTopology(8, 10, 3, 42)],
  ['6×6 fanout1（稀疏）', makeTopology(6, 6, 1, 5)],
  ['4×12 fanout5（密集）', makeTopology(4, 12, 5, 13)]
]

test('v2.29 障碍索引：粗筛候选集必须覆盖所有真正相撞的矩形', () => {
  // 这是「索引只做排除」的核心证明 —— 若候选集漏掉一个真会相撞的框，
  // 走线就会穿框，而全局断言未必每次都恰好覆盖到那个组合。
  const rects = []
  for (let i = 0; i < 120; i += 1) {
    rects.push({ x: (i % 12) * 137, y: Math.floor(i / 12) * 91, w: 130, h: 52 })
  }
  const index = new ObstacleIndex(rects, 320)
  for (let i = 0; i < 400; i += 1) {
    // 伪随机线段（含水平/竖直/斜线），确保三种 segHitsRect 分支都被覆盖
    const seed = i * 2654435761
    const x1 = (seed % 1600) - 50
    const y1 = ((seed >> 8) % 900) - 50
    const vertical = i % 3 === 0
    const horizontal = i % 3 === 1
    const x2 = vertical ? x1 : x1 + ((seed >> 16) % 700) - 350
    const y2 = horizontal ? y1 : y1 + ((seed >> 20) % 500) - 250
    const box = { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) }
    const candidates = index.candidates(box.x1, box.y1, box.x2, box.y2)
    const hitFull = rects.filter((r) => segHitsRect(x1, y1, x2, y2, r))
    for (const r of hitFull) {
      assert.ok(
        candidates.includes(r),
        `候选集漏掉了真正相撞的矩形 @(${r.x},${r.y}) 线段(${x1},${y1})→(${x2},${y2})`
      )
    }
  }
})

test('v2.29 障碍索引：候选集不含重复项', () => {
  const rects = [
    { x: 0, y: 0, w: 900, h: 600 }, // 跨很多格的大框 → 会被塞进多个桶，必须去重
    { x: 100, y: 100, w: 130, h: 52 },
    { x: 400, y: 300, w: 130, h: 52 }
  ]
  const got = new ObstacleIndex(rects, 320).candidates(0, 0, 1000, 700)
  assert.equal(got.length, new Set(got).size, '候选集出现重复')
  assert.equal(got.length, rects.length)
})

test('v2.29 索引重构后 planRoutes 结果确定（同样输入两次逐位一致）', () => {
  for (const [name, t] of CASES) {
    const pos = computeAutoLayout(t.nodes, t.links, { sourcePos: sourcePosOf(t.nodes) })
    const layoutNodes = t.nodes.map((n) => {
      const p = pos.get(n.id)
      return { ...n, ...(p ? { x: Math.round(p.x), y: Math.round(p.y) } : {}) }
    })
    const positions = new Map(layoutNodes.map((n) => [n.id, { x: n.x, y: n.y }]))
    const membership = layoutTopology(layoutNodes, t.links).blocks
    const blocks = computeBlockBoxes(membership, new Map(layoutNodes.map((n) => [n.id, n])), positions)
    const a = serialize(planRoutes({ nodes: layoutNodes, links: t.links, positions, blocks }))
    const b = serialize(planRoutes({ nodes: layoutNodes, links: t.links, positions, blocks }))
    assert.deepEqual(a, b, `${name} 两次调用结果不一致`)
  }
})

test('v2.29 复用外部槽位/端口表：结果与内核自算逐位一致', () => {
  // 这是把「画布已算好的 slots/linkPorts 传进内核」这一优化钉死的守卫 ——
  // 复用一份与自算一份必须产出完全相同的几何，否则标注位置会悄悄漂移。
  // v2.32：连接点方位现在还要一份 rowOf（画布侧同样要先算行模型，见 TopologyCanvas），
  // 守卫按画布的调用口径传参 —— 少传这份就会退回纯几何口径、方位与内核不一致。
  for (const [name, t] of CASES) {
    const pos = computeAutoLayout(t.nodes, t.links, { sourcePos: sourcePosOf(t.nodes) })
    const layoutNodes = t.nodes.map((n) => {
      const p = pos.get(n.id)
      return { ...n, ...(p ? { x: Math.round(p.x), y: Math.round(p.y) } : {}) }
    })
    const positions = new Map(layoutNodes.map((n) => [n.id, { x: n.x, y: n.y }]))
    const membership = layoutTopology(layoutNodes, t.links).blocks
    const blocks = computeBlockBoxes(membership, new Map(layoutNodes.map((n) => [n.id, n])), positions)
    const rowOf = buildRowModel(layoutNodes, positions, alignNodeSizes(layoutNodes)).rowOf

    const selfComputed = serialize(planRoutes({ nodes: layoutNodes, links: t.links, positions, blocks }))
    const reused = serialize(
      planRoutes({
        nodes: layoutNodes,
        links: t.links,
        positions,
        blocks,
        slots: assignPortSlots(t.links, positions, { rowOf }),
        linkPorts: assignLinkPorts(t.links, positions, { rowOf })
      })
    )
    assert.deepEqual(reused, selfComputed, `${name} 复用外部槽位后结果漂移`)
  }
})
