import { useEffect, useRef } from 'react'
import { claimEscLayer } from './escLayers'

/**
 * 组件级 Esc 浮层（N66）：挂上即认领一层，卸载即释放。
 *
 * 监听在 **window 捕获阶段**执行 —— 它比 App 的同阶段监听**晚**注册（App 是根组件），
 * 所以顺序是：App 先跑但通过 `escLayerOpen()` 让行 → 本监听拿到事件，处理完
 * `stopPropagation()` → 冒泡阶段的父级监听（如 SettingsDialog）不会再收到。
 *
 * 用法的三条纪律：
 * ① 只有「自己开着时才该独占 Esc」的浮层才挂它（如手动配置弹窗开着时，MCP 弹窗让行
 *    靠 `enabled=false` 表达）；
 * ② 不要让本层再额外注册 Esc 监听，否则一次按键会关两层；
 * ③ 卸载时必须在 effect 里释放（内部已处理）。
 */
export function useEscLayer(onEsc: () => void, enabled = true): void {
  const cbRef = useRef(onEsc)
  // 最新回调在 effect 里同步（不在渲染期写 ref）：回调通常是内联箭头，每次渲染都换引用
  useEffect(() => {
    cbRef.current = onEsc
  })

  useEffect(() => {
    if (!enabled) return
    const release = claimEscLayer()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      cbRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      release()
    }
  }, [enabled])
}
