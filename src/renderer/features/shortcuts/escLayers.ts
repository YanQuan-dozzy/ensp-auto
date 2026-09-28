/**
 * Esc 归属登记表（N66）—— **纯计数器，不依赖 React**（便于在测试 harness 里直接验证）。
 *
 * **要解决的问题**：`App.tsx` 在最外层的 window **捕获**阶段监听 Esc（全局「停止生成 /
 * 关闭浮层」）。它在所有弹窗之前注册、也最先执行，于是内层弹窗即便用
 * `stopPropagation()` 也拦不住它 —— `stopPropagation` 只阻止事件传播到**别的节点**，
 * 同节点（window）上先注册的监听照样跑。结果就是：设置页里打开「编辑模型」，
 * 按一次 Esc 会把整套设置一起关掉，未保存的模型草稿静默丢失。
 *
 * **为什么不用 store**：App 的捕获监听需要的是「按键这一刻」的值，而登记表变化
 * **不需要触发任何重渲染**（弹窗自己的开合由各自的 state 管）。放 store 会白白
 * 让所有订阅者重渲一遍。这里用一个模块级计数器，语义就是「当前有几层浮层认领了 Esc」。
 *
 * **用法**：认领层自己负责在捕获阶段处理 Esc 并 `stopPropagation()`（阻断冒泡阶段的
 * 父级监听）；本模块只回答「现在有人认领吗」，供 App 早退。组件侧请用
 * `./useEscLayer`。
 */
let depth = 0

/** 认领一层 Esc；返回释放函数（幂等，重复调用只生效一次） */
export function claimEscLayer(): () => void {
  depth += 1
  let released = false
  return () => {
    if (released) return
    released = true
    depth = Math.max(0, depth - 1)
  }
}

/** 当前是否有浮层认领了 Esc（App 的全局监听据此让行） */
export function escLayerOpen(): boolean {
  return depth > 0
}

/** 仅供测试：把计数器复位，避免用例之间互相影响 */
export function resetEscLayers(): void {
  depth = 0
}
