import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CENTER_MIN_WIDTH,
  LEFT_MIN_WIDTH,
  RIGHT_MIN_WIDTH,
  SPLITTERS_TOTAL_GAP,
  getAdaptiveTier,
  computeClampedLeft,
  computeClampedRight,
  computeWindowResizeShrink,
  shouldCollapseButton
} from '../.build/harness.mjs'

/**
 * 布局与自适应（T5.5）。
 *
 * 重要：这里的判定逻辑**全部来自生产模块** `features/layout/panelSizing`。
 * 旧版把 App.tsx / AdaptiveContainer.tsx / AdaptiveToolbar.tsx 里的算法各抄了一份，
 * 结果是「生产改了、测试还在验证抄件」—— 永远绿，等于没测。
 * 现在改坏生产实现，这里的断言就会红。
 */

test('getAdaptiveTier：宽度断点精准划分 (xs / sm / md / lg / xl)', () => {
  assert.equal(getAdaptiveTier(180), 'xs')
  assert.equal(getAdaptiveTier(279), 'xs')
  assert.equal(getAdaptiveTier(280), 'sm')
  assert.equal(getAdaptiveTier(419), 'sm')
  assert.equal(getAdaptiveTier(420), 'md')
  assert.equal(getAdaptiveTier(639), 'md')
  assert.equal(getAdaptiveTier(640), 'lg')
  assert.equal(getAdaptiveTier(959), 'lg')
  assert.equal(getAdaptiveTier(960), 'xl')
  assert.equal(getAdaptiveTier(1920), 'xl')
})

test('拖拽边界约束：拖动左栏时绝不侵占中栏最小安全保护宽度', () => {
  const winW = 1000
  const curRight = 450 // 右栏占 450px
  // 剩余中栏保底 340px + gap 28px = 368px
  // 1000 - 450 - 368 = 182px (最大允许左栏只有 182px)
  const clamped = computeClampedLeft(500, winW, curRight)
  assert.ok(clamped <= 182, `左栏不能超过 182px，实际为 ${clamped}px`)

  // 中栏实际剩余宽度保证 >= CENTER_MIN_WIDTH
  const remainingCenter = winW - clamped - curRight - SPLITTERS_TOTAL_GAP
  assert.ok(remainingCenter >= CENTER_MIN_WIDTH, `中栏剩余宽度 ${remainingCenter} 必须 >= ${CENTER_MIN_WIDTH}`)
})

test('拖拽边界约束：拖动右栏时中栏始终受到保护', () => {
  const winW = 1000
  const curLeft = 300 // 左栏占 300px
  // 1000 - 300 - 340 - 28 = 332px (右栏最大只能到 332px)
  const clamped = computeClampedRight(200, winW, curLeft) // 用户试图拉到 800px 宽
  assert.ok(clamped <= 332, `右栏不能超过 332px，实际为 ${clamped}px`)

  const remainingCenter = winW - curLeft - clamped - SPLITTERS_TOTAL_GAP
  assert.ok(remainingCenter >= CENTER_MIN_WIDTH, `中栏剩余宽度 ${remainingCenter} 必须 >= ${CENTER_MIN_WIDTH}`)
})

test('窗口缩放自适应保护：大屏切小屏时两侧面板按比例安全回缩', () => {
  const bigLeft = 380
  const bigRight = 550
  // 大屏下 1600px 正常放置
  const r1 = computeWindowResizeShrink({ winW: 1600, curLeft: bigLeft, curRight: bigRight, leftActive: true, rightActive: true })
  // 生产契约：空间足够时返回 null（调用方据此跳过 setState），而不是原样返回当前宽度
  assert.equal(r1, null, '1600px 下不需要收缩')

  // 窗口缩到 1100px：380 + 550 + 340 + 28 = 1298 > 1100，deficit = 198px
  const r2 = computeWindowResizeShrink({ winW: 1100, curLeft: bigLeft, curRight: bigRight, leftActive: true, rightActive: true })
  assert.ok(r2, '宽度不足时必须给出新的宽度')
  assert.ok(r2.left < bigLeft, '左栏应按比例收缩')
  assert.ok(r2.right < bigRight, '右栏应按比例收缩')
  assert.ok(r2.left >= LEFT_MIN_WIDTH, '左栏不低于最小限制')
  assert.ok(r2.right >= RIGHT_MIN_WIDTH, '右栏不低于最小限制')

  // 中栏实际保护空间得到显著拯救
  const protectedCenter = 1100 - r2.left - r2.right - SPLITTERS_TOTAL_GAP
  assert.ok(protectedCenter >= 300, `中栏保护后宽度为 ${protectedCenter}px`)
})

/**
 * 注意：shouldCollapseButton 现在从 harness 导入生产实现（T5.5），
 * 测试文件里不再保留抄件。tier 默认值由调用方显式传入。
 */
test('按钮自适应折叠逻辑：collapseBelow 阈值与优先级自适应', () => {
  // 一键连接按钮：collapseBelow = 210
  // 在 220px 宽度下应显示文字，不折叠为图标
  assert.equal(shouldCollapseButton({ tier: 'md', width: 220, collapseBelow: 210 }), false)
  // 在 200px 极窄宽度下应收起为纯图标
  assert.equal(shouldCollapseButton({ tier: 'md', width: 200, collapseBelow: 210 }), true)

  // 扫描设备按钮：collapseBelow = 250
  assert.equal(shouldCollapseButton({ tier: 'md', width: 260, collapseBelow: 250 }), false)
  assert.equal(shouldCollapseButton({ tier: 'md', width: 240, collapseBelow: 250 }), true)

  // 拓扑工具栏按钮：按像素优先级阶梯收起，防止 580px 时右侧遮挡
  assert.equal(shouldCollapseButton({ tier: 'md', width: 580, collapseBelow: 850 }), true) // 发现拓扑 -> 图标
  assert.equal(shouldCollapseButton({ tier: 'md', width: 580, collapseBelow: 760 }), true) // 导入工程 -> 图标
  assert.equal(shouldCollapseButton({ tier: 'md', width: 580, collapseBelow: 680 }), true) // 自适应布局 -> 图标
  assert.equal(shouldCollapseButton({ tier: 'md', width: 580, collapseBelow: 620 }), true) // 添加节点 -> 图标
  assert.equal(shouldCollapseButton({ tier: 'md', width: 580, collapseBelow: 460 }), false) // 从设备刷新 -> 保持文字
})
