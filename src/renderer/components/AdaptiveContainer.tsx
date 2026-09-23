import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode
} from 'react'

import { getAdaptiveTier, type AdaptiveTier } from '../features/layout/panelSizing'

/** 档位类型与判定统一在 features/layout/panelSizing（T5.5，测试直接验证生产实现） */
export type { AdaptiveTier }
export { getAdaptiveTier }

export interface AdaptiveContextValue {
  width: number
  tier: AdaptiveTier
  /** <= 420px (xs 或 sm) */
  isCompact: boolean
  /** < 280px (极窄) */
  isNarrow: boolean
  /** >= 640px (空间充裕) */
  isWide: boolean
}

const defaultAdaptiveContext: AdaptiveContextValue = {
  width: 800,
  tier: 'lg',
  isCompact: false,
  isNarrow: false,
  isWide: true
}

const AdaptiveContext = createContext<AdaptiveContextValue>(defaultAdaptiveContext)

export function useAdaptive(): AdaptiveContextValue {
  return useContext(AdaptiveContext)
}


export interface AdaptiveContainerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children: ReactNode | ((ctx: AdaptiveContextValue) => ReactNode)
}

/**
 * 宽度自适应容器组件
 * 
 * 借助 ResizeObserver 实时监听自身渲染宽度，并向下广播响应式断点状态（xs/sm/md/lg/xl）。
 * 适用于多栏桌面应用中：分栏被拖拽拉伸、收缩时，内部组件能精准响应当前面板实际像素宽，
 * 避免组件被截断、遮盖或换行错乱。
 */
export function AdaptiveContainer({
  children,
  className = '',
  style,
  ...rest
}: AdaptiveContainerProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number>(() => (typeof window !== 'undefined' ? window.innerWidth : 800))
  const [tier, setTier] = useState<AdaptiveTier>(() => getAdaptiveTier(width))

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // 初始测量
    const initW = Math.round(el.getBoundingClientRect().width)
    if (initW > 0) {
      setWidth(initW)
      setTier(getAdaptiveTier(initW))
    }

    let rafId: number | null = null
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const cr = entry.contentRect
      const w = Math.round(cr.width)
      if (w <= 0) return

      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        setWidth(w)
        setTier(getAdaptiveTier(w))
      })
    })

    ro.observe(el)
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      ro.disconnect()
    }
  }, [])

  const isCompact = tier === 'xs' || tier === 'sm'
  const isNarrow = tier === 'xs'
  const isWide = tier === 'lg' || tier === 'xl'

  const ctxValue: AdaptiveContextValue = {
    width,
    tier,
    isCompact,
    isNarrow,
    isWide
  }

  const mergedStyle: CSSProperties = {
    ...style,
    ['--adaptive-width' as string]: `${width}px`
  }

  const mergedClassName = `adaptive-container adaptive-tier-${tier} adaptive-${tier}${isCompact ? ' adaptive-compact' : ''}${isNarrow ? ' adaptive-narrow' : ''}${className ? ` ${className}` : ''}`

  return (
    <AdaptiveContext.Provider value={ctxValue}>
      <div
        ref={containerRef}
        className={mergedClassName}
        style={mergedStyle}
        {...rest}
      >
        {typeof children === 'function' ? children(ctxValue) : children}
      </div>
    </AdaptiveContext.Provider>
  )
}
