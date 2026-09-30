import {
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode
} from 'react'
import { AdaptiveContainer, useAdaptive } from './AdaptiveContainer'
import {
  autoCollapseThresholds,
  shouldCollapseButton,
  type CollapsePriority,
  type ToolbarOverflowBudget
} from '../features/layout/panelSizing'

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
  priority?: CollapsePriority
  /**
   * 折叠宽度阈值（像素），若传入则优先以容器实际像素判断。
   *
   * 传 `'auto'`（N73 推荐）：不看容器绝对宽度，而是看**本工具栏的预算** ——
   * 全展开固有宽度 vs 可用宽度。这样按钮数量增减时无需再手调阈值，也不会出现
   * 「阈值还停在旧按钮数」导致的挤压。需要测量预算的工具栏才用得上。
   */
  collapseBelow?: number | 'auto'
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
      collapseBelow: rawCollapseBelow,
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
    const overflow = useContext(ToolbarOverflowContext)
    const measureSignal = useContext(ToolbarMeasureContext)

    /**
     * `collapseBelow === 'auto'`：用**本工具栏实测预算**反推阈值，按优先级逐级收起。
     *
     * 关键：判定宽度统一取 `overflow.available`（本工具栏能给右区的宽度），
     * 各优先级的阈值由 `autoCollapseThresholds` 在同一把尺子上分配 ——
     * low 最先达阈值、critical 最后。这样按钮增减时阈值自动跟着走，
     * 而且不会出现「9 个按钮在同一像素点集体变图标」的跳变。
     */
    const autoThresholds = rawCollapseBelow === 'auto' && overflow ? autoCollapseThresholds(overflow) : null
    const collapseBelow = autoThresholds ? autoThresholds[priority] : rawCollapseBelow
    // `'auto'` 但预算还没量出来（首帧）：critical 之外的先按保守口径收起，量到后自动收敛
    const effectivePriority = rawCollapseBelow === 'auto' && !overflow && priority === 'critical' ? 'high' : priority

    // 判断当前是否应该收缩文字（纯函数在 features/layout/panelSizing，可被测试直接验证）
    const shouldCollapse =
      // 测量期一律按测量态渲染，不看旧预算 —— 否则量到的是「上一轮的形态」，
      // 预算会一轮比一轮小（正反馈塌陷），按钮再也回不到展开态
      measureSignal !== null && rawCollapseBelow === 'auto'
        ? measureSignal === 'force-collapse'
        : shouldCollapseButton({
            // `auto` 的判定口径是「本工具栏可用宽」而非「窗口宽」
            width: rawCollapseBelow === 'auto' && overflow ? overflow.available : width,
            tier,
            ...(effectivePriority ? { priority: effectivePriority } : {}),
            ...(typeof collapseBelow === 'number' ? { collapseBelow } : {}),
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
/**
 * 「溢出兜底」预算（N73，2026-09-29）。
 *
 * 为什么需要它：`collapseBelow` 是**绝对像素阈值**，写出来就绑定了当时的按钮数量。
 * 拓扑工具栏从 6 个按钮加到 9 个之后，阈值全部失效 —— 900px 容器里仍有 6 个按钮
 * 想显示文字，Flex 只能把按钮压扁（图标宽度被压到 0），表现为「宽度自适应失效」。
 *
 * 修法不是再调一遍阈值（下次加按钮还会坏），而是**实测**：
 * - `minWidth` = 全部按钮都收起为纯图标后的固有宽度（按当前 DOM 量，天然随按钮增减变化）
 * - `fullWidth` = 全部按钮都显示文字时的固有宽度
 * 于是「可分配宽度」在两者之间，按优先级逐级收起（见 `autoCollapseThresholds`）。
 *
 * 量测法：给 inner 挂 `data-tb-measure="icon" | "full"`，CSS 据此把
 * `.adaptive-btn-label` 隐藏 / 恢复并把测量区设为不可收缩，然后读右区 `scrollWidth`。
 * 直接量真实 DOM 而不是量隐藏克隆，避免克隆体内联样式/自定义元素带来的偏差。
 */
export type { ToolbarOverflowBudget }

const ToolbarOverflowContext = createContext<ToolbarOverflowBudget | null>(null)

/**
 * 测量态的「强制展开」信号（N73）。
 *
 * 关键陷阱：测量 `fullWidth`（全展开固宽）时，如果按钮仍按**上一轮的旧预算**决定折叠，
 * 量到的就是「已收起的宽度」拿不到真值 → 预算越来越小 → 按钮越收越多（正反馈塌陷）。
 * 故测量 `'full'` 时所有 `auto` 按钮必须**无条件显示文字**。
 *
 * 反过来 `'icon'` 态由 CSS 把标签 `display:none`，天然量到纯图标宽度，
 * 不需要再额外传信号（但判定也要一并跳过，见 AdaptiveButton）。
 */
type ToolbarMeasureSignal = 'force-expand' | 'force-collapse' | null
const ToolbarMeasureContext = createContext<ToolbarMeasureSignal>(null)

/** 测量态：加在 inner 上，由 CSS 切换按钮标签显隐 */
export type ToolbarMeasureMode = 'icon' | 'full'

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
  const innerRef = useRef<HTMLDivElement | null>(null)
  const rightRef = useRef<HTMLDivElement | null>(null)
  const leftRef = useRef<HTMLDivElement | null>(null)
  /** 测量态：先量纯图标固有宽度，再量全展开固有宽度，最后回到 null（正常渲染） */
  const [measure, setMeasure] = useState<ToolbarMeasureMode | null>(null)
  const [budget, setBudget] = useState<ToolbarOverflowBudget | null>(null)
  /** 容器与右区的实测尺寸（ResizeObserver 驱动重算） */
  const [metrics, setMetrics] = useState({ container: 0, rightIcon: 0, rightFull: 0, left: 0 })
  const [nonce, setNonce] = useState(0)

  // ① 进入测量态 → 量 → 切换 → 量 → 退出（一次性状态机，每次重测 +1 nonce 触发）
  useLayoutEffect(() => {
    const inner = innerRef.current
    if (!inner) return
    // 量到内部宽度为 0（还没上屏）就跳过，交给 ResizeObserver 首帧回调再触发
    if (inner.getBoundingClientRect().width <= 0) return
    setMeasure('icon')
  }, [nonce])

  // ② 测量态下读两次宽度（切态 → rAF 后读，确保样式已应用）
  useLayoutEffect(() => {
    if (measure === null) return
    const inner = innerRef.current
    const right = rightRef.current
    if (!inner || !right) return
    const isIcon = measure === 'icon'
    // scrollWidth 会含溢出内容；测量态下 inner 未换行，故等于内容固有宽度
    const cssWidth = parseFloat(getComputedStyle(inner).paddingLeft) + parseFloat(getComputedStyle(inner).paddingRight)
    setMetrics((m) => ({
      ...m,
      container: Math.max(0, Math.round(inner.clientWidth - cssWidth)),
      rightIcon: isIcon ? Math.round(right.scrollWidth) : m.rightIcon,
      rightFull: isIcon ? m.rightFull : Math.round(right.scrollWidth),
      left: Math.round(leftRef.current?.scrollWidth ?? 0)
    }))
    if (isIcon) {
      setMeasure('full')
      return
    }
    // 全展开量完 → 退出测量态，并算出预算
    setMeasure(null)
  }, [measure])

  // ③ 预算：可用宽度（容器 - 左区 - 间距）在 iconWidth ~ fullWidth 之间的富余
  useLayoutEffect(() => {
    if (measure !== null) return
    if (metrics.rightIcon <= 0 || metrics.rightFull <= 0) return
    const GAP = 8
    setBudget({
      available: Math.max(0, metrics.container - metrics.left - GAP),
      iconWidth: metrics.rightIcon,
      fullWidth: metrics.rightFull
    })
  }, [measure, metrics])

  // ④ 容器尺寸变化 → 重新测量（按钮常量的输入是「当前容器宽」）
  useLayoutEffect(() => {
    const inner = innerRef.current
    if (!inner) return
    let prev = Math.round(inner.clientWidth)
    let raf: number | null = null
    const ro = new ResizeObserver(() => {
      const w = Math.round(inner.clientWidth)
      if (w <= 0 || Math.abs(w - prev) < 8) return
      prev = w
      if (raf !== null) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setNonce((n) => n + 1))
    })
    ro.observe(inner)
    return () => {
      if (raf !== null) cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  const ctxValue = useMemo(() => budget, [budget])

  return (
    <AdaptiveContainer
      className={`adaptive-toolbar${wrapOnNarrow ? ' allow-wrap' : ''}${className ? ` ${className}` : ''}`}
      style={{ minHeight, ...style }}
      {...rest}
    >
      {() => (
        <ToolbarMeasureContext.Provider value={measure === 'full' ? 'force-expand' : measure === 'icon' ? 'force-collapse' : null}>
          <ToolbarOverflowContext.Provider value={ctxValue}>
            <div
              ref={innerRef}
              className="adaptive-toolbar-inner"
              {...(measure ? { 'data-tb-measure': measure } : {})}
            >
              {left ? (
                <div className="adaptive-toolbar-left" ref={leftRef}>
                  {left}
                </div>
              ) : null}
              {children ? <div className="adaptive-toolbar-center">{children}</div> : null}
              {right ? (
                <div className="adaptive-toolbar-right" ref={rightRef}>
                  {right}
                </div>
              ) : null}
            </div>
          </ToolbarOverflowContext.Provider>
        </ToolbarMeasureContext.Provider>
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
