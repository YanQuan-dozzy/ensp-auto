/**
 * N73：工具栏「宽度自适应失效」回归（2026-09-29）。
 *
 * 现象：拓扑画布加了 3 个按钮（恢复原始布局 / 显示网格 / 对齐网格）之后，
 * 工具栏在窄容器里不再收起文字，按钮被 Flex 压扁 —— 图标宽度被压到 0，
 * 看上去像按钮消失。用户报的就是「宽度自适应失效」。
 *
 * 根因有两条，缺一不可（只修一条还会复发）：
 *
 * ① **阈值是手写绝对像素**（620/680/760/840/850/880/950…）。它只对「当时那几个
 *    按钮」成立；按钮一多，空间不够了阈值还判「不用收」→ 溢出。故本用例钉住
 *    「阈值必须由实测预算推算」这条口径，而不是钉住某组具体数字。
 *
 * ② **Flex 会压扁按钮**。`.adaptive-btn` 的 `flex-shrink: 0` 必须保住 ——
 *    `.btn` 上的 `white-space: nowrap` 只防换行，不防宽度收缩。
 *
 * 这里同时验证纯函数（可变部分）与 CSS/源码结构（不变式），
 * 因为「生产实现改了、测试还在验证抄件」是这个仓库踩过的坑（见 adaptive.test.mjs 头注释）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { autoCollapseThresholds, shouldCollapseButton } from '../.build/harness.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** 判定口径与生产一致：统一用 `available` 当尺子，各优先级用各自的阈值 */
const collapseAt = (budget, priority) =>
  shouldCollapseButton({
    tier: 'lg',
    width: budget.available,
    collapseBelow: autoCollapseThresholds(budget)[priority],
    priority
  })

// ————————————————— ① 预算换算：口径本身 —————————————————

test('autoCollapseThresholds：装得下全展开时谁都不收', () => {
  const budget = { available: 900, iconWidth: 260, fullWidth: 820 }
  for (const p of ['low', 'medium', 'high']) {
    assert.equal(collapseAt(budget, p), false, `可用 900 > 全展开 820，${p} 不应收起`)
  }
})

test('autoCollapseThresholds：装不下时 low 先收（按钮变多不再溢出）', () => {
  // 9 个按钮全展开要 1180px，容器只给 900px —— 旧手写阈值正是这种情况判「不用收」
  const budget = { available: 900, iconWidth: 260, fullWidth: 1180 }
  assert.equal(collapseAt(budget, 'low'), true, '空间不足时最低优先级必须先让位')
})

test('autoCollapseThresholds：空间越紧，收起的优先级档越多（阶梯而非一刀切）', () => {
  const big = { available: 1180, iconWidth: 260, fullWidth: 1180 } // 刚好装下
  const mid = { available: 1000, iconWidth: 260, fullWidth: 1180 }
  const small = { available: 700, iconWidth: 260, fullWidth: 1180 }
  const tiny = { available: 260, iconWidth: 260, fullWidth: 1180 } // 只剩图标宽

  const count = (b) => ['low', 'medium', 'high'].filter((p) => collapseAt(b, p)).length
  assert.equal(count(big), 0, '装得下 → 0 档收起')
  assert.ok(count(mid) >= 1, '稍紧 → 至少 low 收起')
  assert.ok(count(small) >= count(mid), '更紧 → 收起档数不回退（单调）')
  assert.equal(count(tiny), 3, '只剩图标宽 → 全部档次都收起')
})

test('autoCollapseThresholds：同一预算下阈值 low > medium > high > critical（先收顺序）', () => {
  const t = autoCollapseThresholds({ available: 900, iconWidth: 260, fullWidth: 1180 })
  assert.ok(t.low >= t.medium, 'low 应比 medium 先收（阈值更高）')
  assert.ok(t.medium >= t.high, 'medium 应比 high 先收')
  assert.ok(t.high >= t.critical, 'high 应比 critical 先收')
})

test('autoCollapseThresholds：阈值随按钮增减自动移动（不得是常量）', () => {
  const few = autoCollapseThresholds({ available: 900, iconWidth: 180, fullWidth: 620 })
  const many = autoCollapseThresholds({ available: 900, iconWidth: 260, fullWidth: 1180 })
  assert.notEqual(few.low, many.low, '按钮数量不同必须给出不同阈值 —— 常量阈值正是本次 bug 的根源')
  assert.ok(many.low > few.low, '按钮越多，low 档的折叠阈值越高')
})

// ————————————————— ② CSS 不变式：按钮不可被压扁 —————————————————

test('CSS：.adaptive-btn 必须 flex-shrink: 0（否则被压扁 = 图标宽度归零）', () => {
  const css = read('src/renderer/styles/app.css')
  const block = css.match(/\.adaptive-btn\s*\{[^}]*\}/)
  assert.ok(block, '找不到 .adaptive-btn 规则块')
  assert.match(
    block[0],
    /flex-shrink:\s*0/,
    '空间不足应由折叠逻辑换成纯图标，不能靠 Flex 把按钮压扁（压扁后图标宽度为 0，看着像按钮消失）'
  )
})

test('CSS：.adaptive-btn-icon 必须 flex-shrink: 0（图标是按钮的最小不可压单元）', () => {
  const css = read('src/renderer/styles/app.css')
  const block = css.match(/\.adaptive-btn-icon\s*\{[^}]*\}/)
  assert.ok(block, '找不到 .adaptive-btn-icon 规则块')
  assert.match(block[0], /flex-shrink:\s*0/)
})

test('CSS：右区必须 flex-shrink: 0（主要动作区不被中栏挤压）', () => {
  const css = read('src/renderer/styles/app.css')
  const block = css.match(/\.adaptive-toolbar-right\s*\{[^}]*\}/)
  assert.ok(block, '找不到 .adaptive-toolbar-right 规则块')
  assert.match(block[0], /flex-shrink:\s*0/)
})

test('CSS：测量态下标签隐藏 + 测量区不可收缩（否则量出的固宽偏小）', () => {
  const css = read('src/renderer/styles/app.css')
  assert.match(
    css,
    /\[data-tb-measure='icon'\][^{]*\.adaptive-btn-label[^{]*\{[^}]*display:\s*none/,
    '测量「纯图标固宽」时必须把标签真正隐藏，否则量到的是全展开宽度'
  )
  assert.match(
    css,
    /\[data-tb-measure\][^{]*\.adaptive-toolbar-right[^{]*\{[^}]*flex-shrink:\s*0/,
    '测量期间右区不可收缩 —— 收缩会把 scrollWidth 量小，预算偏高又会溢出'
  )
})

// ————————————————— ③ 接线：拓扑工具栏必须走自动口径 —————————————————

test('拓扑工具栏：所有按钮都用 collapseBelow="auto"，不得回落手写像素', () => {
  const src = read('src/renderer/features/topology/TopologyToolbar.tsx')
  // 只取 JSX 区（`return (` 之后）—— 文件头注释里也提到 collapseBelow="auto"，别把它算进来
  const jsx = src.slice(src.indexOf('<AdaptiveToolbar'))
  const allThresholds = [...jsx.matchAll(/collapseBelow=(\{[^}]*\}|"[^"]*")/g)].map((m) => m[1])
  assert.ok(allThresholds.length >= 9, `拓扑工具栏按钮数应 >= 9，实际 ${allThresholds.length}`)

  const hardcoded = allThresholds.filter((v) => /^\{\d+\}$/.test(v))
  assert.equal(
    hardcoded.length,
    0,
    `仍有 ${hardcoded.length} 个按钮写死像素阈值（${hardcoded.join(', ')}）—— 加按钮后必然再次溢出`
  )
  const auto = allThresholds.filter((v) => v === '{AUTO}')
  assert.equal(auto.length, allThresholds.length, '拓扑工具栏所有按钮都应使用 collapseBelow="auto"')
})

test('AdaptiveToolbar：auto 分支必须真的走预算，而不是忽略后回落 priority', () => {
  const src = read('src/renderer/components/AdaptiveToolbar.tsx')
  assert.match(src, /autoCollapseThresholds\(/, 'auto 分支必须调用共享的换算函数（口径唯一事实源）')
  assert.match(
    src,
    /rawCollapseBelow === 'auto'[\s\S]{0,200}overflow/,
    'auto 分支必须取实测预算 overflow 里的 available 作判定宽度，否则等于没用上'
  )
  assert.match(
    src,
    /autoThresholds\[priority\]/,
    '阈值必须按按钮自己的 priority 取 —— 九宫格一刀切会在同一像素点集体变图标（跳变而非自适应）'
  )
})

test('AdaptiveToolbar：预算必须由 ResizeObserver 驱动重算（容器变化要重测）', () => {
  const src = read('src/renderer/components/AdaptiveToolbar.tsx')
  assert.match(src, /new ResizeObserver\(/, '容器尺寸变化必须重新测量，否则初次渲染后永远用旧预算')
})

test('AdaptiveToolbar：测量期必须无视旧预算（否则预算正反馈塌陷）', () => {
  const src = read('src/renderer/components/AdaptiveToolbar.tsx')
  assert.match(
    src,
    /measureSignal !== null[\s\S]{0,200}force-collapse/,
    '测量期必须按测量态渲染，不能沿用上一轮预算 —— 量「全展开」时若按钮仍按旧预算收起，' +
      '量到的是收起后的宽度，预算会一轮比一轮小，按钮再也回不到展开态'
  )
  assert.match(
    src,
    /ToolbarMeasureContext\.Provider[\s\S]{0,200}force-expand[\s\S]{0,200}force-collapse/,
    '测量信号必须同时覆盖 force-expand（量全展开）与 force-collapse（量纯图标）两个方向'
  )
})
