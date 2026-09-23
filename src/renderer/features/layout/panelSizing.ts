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
