/**
 * 三栏布局的尺寸约束（纯函数，主进程/渲染层/测试共用）。
 *
 * 为什么单独成模块（T5.5）：这些算法原先内联在 App.tsx 与 AdaptiveContainer.tsx 里，
 * 测试只能**抄一份**过去 —— 生产代码改了、测试还在验证那份抄件，永远绿。
 * 抽出来之后测试直接 import 生产实现，改错就会红。
 */

/** 中栏最小安全宽度：低于它输入框与消息流就没法用了 */
export const CENTER_MIN_WIDTH = 340
export const LEFT_MIN_WIDTH = 180
export const LEFT_MAX_WIDTH = 420
export const RIGHT_MIN_WIDTH = 300
export const RIGHT_MAX_WIDTH = 640
/** 2 个 8px 分隔条 + body 左右内边距 */
export const SPLITTERS_TOTAL_GAP = 28

/** 自适应档位：容器宽度决定内部排版密度 */
export type AdaptiveTier = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export function getAdaptiveTier(w: number): AdaptiveTier {
  if (w < 280) return 'xs'
  if (w < 420) return 'sm'
  if (w < 640) return 'md'
  if (w < 960) return 'lg'
  return 'xl'
}

/**
 * 拖动左分隔条时的左栏宽度。
 * 约束顺序：先守住中栏最小宽度，再套左栏自身上下限。
 */
export function computeClampedLeft(clientX: number, winW: number, curRight: number): number {
  const maxAllowed = Math.max(LEFT_MIN_WIDTH, winW - curRight - CENTER_MIN_WIDTH - SPLITTERS_TOTAL_GAP)
  const upperLimit = Math.min(LEFT_MAX_WIDTH, maxAllowed)
  return Math.max(LEFT_MIN_WIDTH, Math.min(upperLimit, clientX - 8))
}

/** 拖动右分隔条时的右栏宽度（对称约束：从右边界反算） */
export function computeClampedRight(clientX: number, winW: number, curLeft: number): number {
  const maxAllowed = Math.max(RIGHT_MIN_WIDTH, winW - curLeft - CENTER_MIN_WIDTH - SPLITTERS_TOTAL_GAP)
  const upperLimit = Math.min(RIGHT_MAX_WIDTH, maxAllowed)
  return Math.max(RIGHT_MIN_WIDTH, Math.min(upperLimit, winW - clientX - 8))
}

export interface PanelSizingInput {
  winW: number
  curLeft: number
  curRight: number
  leftActive: boolean
  rightActive: boolean
}

/**
 * 窗口缩放后左右栏应有的宽度；不需要收缩时返回 null（调用方据此跳过 setState）。
 *
 * 规则与 App.tsx 的 resize 处理一致：
 * - 两栏都在：按各自「可收缩余量」等比例分摊缺口；
 * - 只有一栏：直接扣掉缺口，但不低于该栏最小宽度。
 */
export function computeWindowResizeShrink(
  input: PanelSizingInput
): { left: number; right: number } | null {
  const { winW, curLeft, curRight, leftActive, rightActive } = input
  const needed = curLeft + curRight + CENTER_MIN_WIDTH + SPLITTERS_TOTAL_GAP
  if (winW >= needed) return null

  const deficit = needed - winW
  if (leftActive && rightActive) {
    const leftCanShrink = Math.max(0, curLeft - LEFT_MIN_WIDTH)
    const rightCanShrink = Math.max(0, curRight - RIGHT_MIN_WIDTH)
    const totalCanShrink = leftCanShrink + rightCanShrink
    if (totalCanShrink <= 0) return null
    const shrinkRatio = Math.min(1, deficit / totalCanShrink)
    return {
      left: Math.round(curLeft - leftCanShrink * shrinkRatio),
      right: Math.round(curRight - rightCanShrink * shrinkRatio)
    }
  }
  if (leftActive) return { left: Math.max(LEFT_MIN_WIDTH, curLeft - deficit), right: curRight }
  if (rightActive) return { left: curLeft, right: Math.max(RIGHT_MIN_WIDTH, curRight - deficit) }
  return null
}

/** 工具条按钮优先级：空间不足时按此顺序先收起 */
export type CollapsePriority = 'low' | 'medium' | 'high' | 'critical'

export interface CollapseInput {
  width: number
  tier: AdaptiveTier
  priority?: CollapsePriority
  /** 显式像素阈值：给了它就不再看 priority */
  collapseBelow?: number
  /** 本来就是纯图标模式 */
  iconOnly?: boolean
  /** 有图标才谈得上「收起文字」（没图标收起来就没意义了），默认 true */
  hasIcon?: boolean
}

/**
 * 工具条按钮是否收起文字（只留图标 + Tooltip）。
 *
 * 从 AdaptiveToolbar 的渲染内联逻辑抽出来（T5.5）：内联时测试只能抄一份，
 * 抄件漂移了也不会有人知道。这里的阈值与顺序都是产品口径，改动要有测试盯着。
 */
export function shouldCollapseButton(input: CollapseInput): boolean {
  const { width, tier, priority, collapseBelow, iconOnly = false, hasIcon = true } = input
  if (iconOnly) return true
  if (!hasIcon) return false
  if (typeof collapseBelow === 'number') return width < collapseBelow
  if (priority === 'low') return width < 850 || tier === 'xs' || tier === 'sm' || tier === 'md'
  if (priority === 'medium') return width < 680 || tier === 'xs' || tier === 'sm'
  if (priority === 'high') return width < 480 || tier === 'xs'
  return false
}

/**
 * 工具栏「实测预算」→ 各优先级按钮各自的折叠阈值（N73，2026-09-29）。
 *
 * 背景：`collapseBelow` 原先一律是手写绝对像素（620/680/760/840/850/880/950…）。
 * 它只对「写这串数字时的那几个按钮」成立；拓扑工具栏从 6 个按钮加到 9 个之后，
 * 明明装不下了阈值还判「不用收」→ 文字继续显示 → Flex 把按钮压扁（图标宽被压到 0），
 * 用户看到的就是「宽度自适应失效」。
 *
 * 修法不是再调一遍数字（下次加按钮照旧坏），而是**实测**后反推：
 * - `available`  = 容器能给右区的宽度（容器宽 - 左区固有宽 - 间距）
 * - `iconWidth`  = 全部按钮收成纯图标后的固有宽度
 * - `fullWidth`  = 全部按钮显示文字时的固有宽度
 *
 * 三条不变式（由测试冻结）：
 * ① `available >= fullWidth`  → 全部显示文字（含 critical）
 * ② `available <= iconWidth`  → 全部收成图标
 * ③ 两者之间 → **按优先级逐级收起**：low 最先收，其次 medium、high，
 *    critical 最后才收。若九宫格一刀切（所有按钮同一阈值），
 *    按钮会在某个像素点集体变图标 —— 那是「跳变」不是「自适应」。
 *
 * 分配法：把 [iconWidth, fullWidth] 按优先级切成若干档（每档对应一个优先级），
 * 各档的阈值 = 该档「开始收起」的可用宽度。低优先级档的阈值最高（先收）。
 */
export interface ToolbarOverflowBudget {
  /** 预算口径的可用宽度（容器实测宽 - 左区固有宽 - 间距） */
  available: number
  /** 收成纯图标后的固有宽度 */
  iconWidth: number
  /** 全部展开文字时的固有宽度 */
  fullWidth: number
}

/**
 * 优先级顺序（先收 → 后收）。critical 永不自动收起（只在极窄兜底）。
 * 这张表是产品口径：改顺序要有测试盯着。
 */
const COLLAPSE_ORDER: readonly CollapsePriority[] = ['low', 'medium', 'high', 'critical']

/**
 * 各优先级按钮的 `collapseBelow` 阈值（用**同一把尺子**量：`available`）。
 *
 * 判定时统一传 `width: budget.available`，故阈值之间的大小关系就是「谁先收」。
 * 阈值从高到低：low > medium > high > critical。
 */
export function autoCollapseThresholds(
  budget: ToolbarOverflowBudget
): Record<CollapsePriority, number> {
  const { iconWidth, fullWidth } = budget
  const span = Math.max(0, fullWidth - iconWidth)
  const n = COLLAPSE_ORDER.length
  // 第 i 档（0 = low，最左）在 [iconWidth, fullWidth] 上对应的分界点。
  // low 的阈值最高（available 一变小就先触发），critical 最低。
  const out = {} as Record<CollapsePriority, number>
  COLLAPSE_ORDER.forEach((p, i) => {
    // 从满宽往图标宽方向倒退：low 的阈值 = 满宽（装不下就收），
    // 后面每档再往回收 span/n，于是 critical 要等到最紧才收。
    out[p] = Math.round(fullWidth - (span * i) / n)
  })
  return out
}

/**
 * 单个优先级的阈值 —— 供只需要一档的调用点使用（等价于上表的对应项）。
 * 保留单值形态是为了让 `shouldCollapseButton({ collapseBelow })` 的老口径不变。
 */
export function autoCollapseThreshold(
  budget: ToolbarOverflowBudget,
  priority: CollapsePriority = 'low'
): number {
  return autoCollapseThresholds(budget)[priority]
}
