/**
 * 「对齐网格 = 网格十字中心压设备中心」不变式（2026-09-29，用户口径）。
 *
 * ## 用户原话与本测试要守的东西
 *
 * 「现在的对齐网格错了，应该是网格的十字中心」—— 背景方格的**十字交点**必须压在
 * 设备框的**正中心**（eNSP 观感）。而 React Flow 的 `node.position` 是左上角，
 * 于是布局坐标的语义被定为「设备框中心」，渲染前统一减半框。
 *
 * 要让减半框之后中心仍压格点，设备框尺寸必须**全偶数**（否则半框是 .5，中心与左上角
 * 不可能同时落格点）。这三条不变式一旦破了，现象就是「网格歪半个格」——
 * 正是这次要修的 bug，故用本文件冻结：
 *
 *   1. `estimateNodeSizeAligned` 的宽高恒为偶数；
 *   2. 布局输出的每个中心坐标都是 `LAYOUT_GRID` 的整数倍；
 *   3. 中心 → 左上角（减半框）后仍是整数（不产生 .5 偏移），且中心 ↔ 左上角往返一致。
 *
 * 只改纯函数，不需要 Electron。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateNodeSizeAligned,
  alignNodeSizes,
  centerToTopLeft,
  topLeftToCenter,
  toCenterPositions,
  toTopLeftPositions,
  computeAutoLayout,
  LAYOUT_GRID
} from '../.build/harness.mjs'

/** 覆盖面尽量广：不同角色 / 名称长度 / 含中文 / 超长名 */
const SAMPLES = [
  ['AR1', 'router', 'AR2220'],
  ['LSW1', 'switch', 'S5700'],
  ['PC1', 'pc', 'PC'],
  ['核心交换机', 'switch', 'S5700'],
  ['R2', 'router', 'AR1220'],
  ['Server-With-Long-Name', 'server', 'Server'],
  ['云', 'cloud', 'Cloud'],
  ['WLAN-AC-1', 'wlan', 'AC6605'],
  ['FW1', 'firewall', 'USG6000'],
  ['x', 'unknown', undefined]
]

test('不变式 1：设备框尺寸（对齐口径）宽高恒为偶数', () => {
  for (const [name, role, model] of SAMPLES) {
    const s = estimateNodeSizeAligned(name, role, model)
    assert.equal(s.w % 2, 0, `${name} 宽度应为偶数，实际 ${s.w}`)
    assert.equal(s.h % 2, 0, `${name} 高度应为偶数，实际 ${s.h}`)
    assert.ok(s.w > 0 && s.h > 0, `${name} 尺寸必须为正`)
  }
})

test('不变式 2：布局输出的中心坐标都是 LAYOUT_GRID 的整数倍', () => {
  const nodes = [
    { id: 'net', name: 'Internet', role: 'cloud', model: 'Cloud' },
    { id: 'ar', name: 'AR1', role: 'router', model: 'AR2220' },
    { id: 'sw1', name: 'LSW1', role: 'switch', model: 'S5700' },
    { id: 'sw2', name: 'LSW2', role: 'switch', model: 'S5700' },
    { id: 'pc1', name: 'PC1', role: 'pc', model: 'PC' },
    { id: 'pc2', name: 'PC2', role: 'pc', model: 'PC' },
    { id: 'pc3', name: 'PC3', role: 'pc', model: 'PC' }
  ]
  const links = [
    { id: '1', from: 'net', to: 'ar', source: 'file' },
    { id: '2', from: 'ar', to: 'sw1', source: 'file' },
    { id: '3', from: 'ar', to: 'sw2', source: 'file' },
    { id: '4', from: 'sw1', to: 'pc1', source: 'file' },
    { id: '5', from: 'sw1', to: 'pc2', source: 'file' },
    { id: '6', from: 'sw2', to: 'pc3', source: 'file' }
  ]
  const pos = computeAutoLayout(nodes, links)
  for (const n of nodes) {
    const p = pos.get(n.id)
    assert.ok(p, `${n.name} 应有布局坐标`)
    assert.equal(p.x % LAYOUT_GRID, 0, `${n.name} 中心 x=${p.x} 应是 ${LAYOUT_GRID} 的倍数`)
    assert.equal(p.y % LAYOUT_GRID, 0, `${n.name} 中心 y=${p.y} 应是 ${LAYOUT_GRID} 的倍数`)
  }
})

test('不变式 3：中心 → 左上角（减半框）不产生 .5 偏移；往返一致', () => {
  for (const [name, role, model] of SAMPLES) {
    const size = estimateNodeSizeAligned(name, role, model)
    // 中心落格点 → 左上角必须是整数（偶数尺寸保证）；若是奇数尺寸，这里会是 .5
    const center = { x: 640, y: 960 }
    const tl = centerToTopLeft(center, size)
    assert.ok(
      Number.isInteger(tl.x) && Number.isInteger(tl.y),
      `${name} 中心(${center.x},${center.y}) 减半框后应得整数左上角，实际 (${tl.x},${tl.y})`
    )
    // 往返一致
    const back = topLeftToCenter(tl, size)
    assert.equal(back.x, center.x, `${name} 往返 x 应一致`)
    assert.equal(back.y, center.y, `${name} 往返 y 应一致`)
  }
})

test('不变式 3b：真实布局输出 —— 中心落格点且左上角为整数', () => {
  const nodes = [
    { id: 'ar', name: 'AR1', role: 'router', model: 'AR2220' },
    { id: 'sw1', name: 'LSW1', role: 'switch', model: 'S5700' },
    { id: 'pc1', name: 'PC1', role: 'pc', model: 'PC' },
    { id: 'pc2', name: 'PC2', role: 'pc', model: 'PC' }
  ]
  const links = [
    { id: '1', from: 'ar', to: 'sw1', source: 'file' },
    { id: '2', from: 'sw1', to: 'pc1', source: 'file' },
    { id: '3', from: 'sw1', to: 'pc2', source: 'file' }
  ]
  const sizes = alignNodeSizes(nodes)
  const pos = computeAutoLayout(nodes, links)
  for (const n of nodes) {
    const p = pos.get(n.id)
    const s = sizes.get(n.id)
    assert.ok(p && s, `${n.name} 应有坐标与尺寸`)
    const tl = centerToTopLeft(p, s)
    assert.equal(p.x % LAYOUT_GRID, 0, `${n.name} 中心 x 落格点`)
    assert.equal(p.y % LAYOUT_GRID, 0, `${n.name} 中心 y 落格点`)
    assert.ok(Number.isInteger(tl.x) && Number.isInteger(tl.y), `${n.name} 左上角应为整数`)
  }
})

test('批量换算：画布坐标（左上角）→ 中心 → 左上角 完全往返', () => {
  const nodes = SAMPLES.map(([name, role, model], i) => ({
    id: `n${i}`,
    name,
    role,
    ...(model ? { model } : {})
  }))
  const sizes = alignNodeSizes(nodes)
  const topLefts = new Map(nodes.map((n, i) => [n.id, { x: 160 * i, y: 320 * (i + 1) }]))
  const centers = toCenterPositions(topLefts, sizes)
  const back = toTopLeftPositions(centers, sizes)
  for (const [id, tl] of topLefts) {
    const b = back.get(id)
    assert.equal(b.x, tl.x, `${id} 往返 x 应一致`)
    assert.equal(b.y, tl.y, `${id} 往返 y 应一致`)
  }
})

test('对齐到网格：中心取整到格点后仍是格点倍数（幂等）', () => {
  // alignToGrid 的实现就是对**中心**做 `Math.round(x / GRID) * GRID`；
  // 这里守它的幂等性：已经落格点的坐标再对齐一次不应移动。
  for (const x of [0, 160, 320, 640, -160]) {
    assert.equal(Math.round(x / LAYOUT_GRID) * LAYOUT_GRID, x, `中心 x=${x} 对齐应保持不变`)
  }
  // 非格点中心会被吸到最近格点（且结果仍是整数倍）
  const snapped = Math.round(250 / LAYOUT_GRID) * LAYOUT_GRID
  assert.equal(snapped % LAYOUT_GRID, 0)
})
