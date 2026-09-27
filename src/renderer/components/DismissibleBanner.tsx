import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'

/**
 * 操作反馈条：点击页面其他位置即自动关闭（v2.21）。
 *
 * 「导出报告」「清空记录」「恢复默认」「保存连接」这类按钮的反馈，只在点完的那几秒有用；
 * 一直挂在面板顶部既挤压内容区，又让人以为它需要被手动处理。用户视线一离开、
 * 去点别的地方，就该自动收场。
 *
 * 判据是「按下点落在提示条之外」：监听 document 的 **捕获阶段** pointerdown ——
 * 捕获阶段先于任何业务 onClick 执行，因此行内那些 `stopPropagation()`（例如变更记录行
 * 上的删除按钮）不会把这次点击吞掉，导致条子关不掉。
 *
 * 只对「有状态可清空」的提示用本组件；常驻语义的横幅（权限开关的状态说明、
 * 代理运行中的 pending 条）不要接 —— 它们消失会让人以为功能变了。
 */
export function useDismissOnOutside(
  active: boolean,
  onDismiss: () => void
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null)
  // 回调经 ref 转发：调用方多是内联箭头函数，直接进依赖会让监听每次渲染都重绑
  const cb = useRef(onDismiss)
  useEffect(() => {
    cb.current = onDismiss
  })
  useEffect(() => {
    if (!active) return
    const onPointerDown = (e: PointerEvent): void => {
      const el = ref.current
      const target = e.target
      if (!el || !(target instanceof Node) || el.contains(target)) return
      cb.current()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [active])
  return ref
}

/** `banner` 的语义色，与 `.banner.*` 样式一一对应 */
export type BannerTone = 'info' | 'success' | 'danger' | 'pending'

export function DismissibleBanner({
  tone = 'info',
  onDismiss,
  className,
  style,
  children
}: {
  tone?: BannerTone
  onDismiss: () => void
  className?: string
  style?: CSSProperties
  children: ReactNode
}): ReactNode {
  const ref = useDismissOnOutside(true, onDismiss)
  return (
    <div
      ref={ref}
      className={`banner ${tone}${className ? ` ${className}` : ''}`}
      style={style}
    >
      {children}
    </div>
  )
}
