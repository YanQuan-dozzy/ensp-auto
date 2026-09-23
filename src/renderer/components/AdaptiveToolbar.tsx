import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode
} from 'react'
import { AdaptiveContainer, useAdaptive } from './AdaptiveContainer'
import { shouldCollapseButton } from '../features/layout/panelSizing'

export interface AdaptiveButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode
  label: ReactNode
  /** 提示文案，默认使用 label 字符串 */
  tooltip?: string
  /**
   * 优先级：
   * - 'critical': 绝不自动折叠为图标，除非显式传入 iconOnly
   * - 'high': 仅在极窄空间 (<480px) 时收起文本
   * - 'medium': 在中窄空间 (<680px) 时收起文本为纯图标（默认）
   * - 'low': 在空间略显受限 (<850px) 时即收起文本
   */
  priority?: 'critical' | 'high' | 'medium' | 'low'
  /** 显式指定折叠宽度阈值（像素），若传入则优先以容器实际像素判断 */
  collapseBelow?: number
  /** 无论断点如何，是否强制只显示图标 */
  iconOnly?: boolean
  /** 变体样式 */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  badge?: ReactNode
}

/**
 * 宽度自适应按钮组件
 * 空间充足时显示「图标 + 完整文字」；空间缩小时根据 priority / collapseBelow 自动平滑过渡为「纯图标 + Tooltip」，
 * 避免文本折行压扁或把邻近按钮顶出屏幕/掩盖。
 */
export const AdaptiveButton = forwardRef<HTMLButtonElement, AdaptiveButtonProps>(
  function AdaptiveButton(
    {
      icon,
      label,
      tooltip,
      priority = 'medium',
      collapseBelow,
      iconOnly = false,
      variant = 'secondary',
      size = 'sm',
      badge,
      className = '',
      title,
      children,
      ...rest
    },
    ref
  ) {
    const { width, tier } = useAdaptive()

    // 判断当前是否应该收缩文字（纯函数在 features/layout/panelSizing，可被测试直接验证）
    const shouldCollapse = shouldCollapseButton({
      width,
      tier,
      ...(priority ? { priority } : {}),
      ...(collapseBelow !== undefined ? { collapseBelow } : {}),
      iconOnly: Boolean(iconOnly),
      hasIcon: Boolean(icon)
    })

    const tip = tooltip ?? (typeof label === 'string' ? label : (title ?? ''))
    const btnCls = [
      'btn',
      'adaptive-btn',
      size === 'sm' ? 'sm' : '',
      variant === 'primary' ? 'primary' : '',
      variant === 'ghost' ? 'ghost' : '',
      variant === 'danger' ? 'danger' : '',
      shouldCollapse ? 'icon-only' : '',
      className
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <button
        ref={ref}
        type="button"
        className={btnCls}
        title={tip}
        aria-label={typeof label === 'string' ? label : tip}
        {...rest}
      >
        {icon ? <span className="adaptive-btn-icon">{icon}</span> : null}
        {!shouldCollapse && <span className="adaptive-btn-label">{label}</span>}
        {badge ? <span className="adaptive-btn-badge">{badge}</span> : null}
        {children}
      </button>
    )
  }
)

export interface AdaptiveToolbarProps extends HTMLAttributes<HTMLDivElement> {
  left?: ReactNode
  right?: ReactNode
  children?: ReactNode
  /** 是否允许在极窄屏时整行换行（杜绝横向滚动截断），默认 true */
  wrapOnNarrow?: boolean
  /** 最小高度，默认 40px */
  minHeight?: number | string
}

/**
 * 宽度自适应工具栏
 * 
 * 整合了左右行动区弹性排布、智能断点计算、极窄防遮挡保底换行。
 */
export function AdaptiveToolbar({
  left,
  right,
  children,
  wrapOnNarrow = true,
  minHeight = 40,
  className = '',
  style,
  ...rest
}: AdaptiveToolbarProps): ReactNode {
  return (
    <AdaptiveContainer
      className={`adaptive-toolbar${wrapOnNarrow ? ' allow-wrap' : ''}${className ? ` ${className}` : ''}`}
      style={{ minHeight, ...style }}
      {...rest}
    >
      {() => (
        <div className="adaptive-toolbar-inner">
          {left ? <div className="adaptive-toolbar-left">{left}</div> : null}
          {children ? <div className="adaptive-toolbar-center">{children}</div> : null}
          {right ? <div className="adaptive-toolbar-right">{right}</div> : null}
        </div>
      )}
    </AdaptiveContainer>
  )
}

export interface AdaptiveInputProps extends InputHTMLAttributes<HTMLInputElement> {
  compactWidth?: number | string
  fullWidth?: number | string
}

/**
 * 宽度自适应输入框
 */
export const AdaptiveInput = forwardRef<HTMLInputElement, AdaptiveInputProps>(
  function AdaptiveInput(
    { compactWidth = 100, fullWidth = 150, className = '', style, ...rest },
    ref
  ) {
    const { isCompact } = useAdaptive()
    return (
      <input
        ref={ref}
        className={`topology-input adaptive-input${className ? ` ${className}` : ''}`}
        style={{
          width: isCompact ? compactWidth : fullWidth,
          transition: 'width var(--dur-fast) var(--ease)',
          ...style
        }}
        {...rest}
      />
    )
  }
)
