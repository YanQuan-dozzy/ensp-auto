/**
 * 全局折叠控制（v2.9，P5）—— 让「全部折叠 / 全部展开」能同时作用到
 * 消息流里所有可折叠的块（思考 / 工具组 / 工具卡 / 助手步骤 / 计划）。
 *
 * 为什么是一个独立的 context + hook 而不是把 open 提升到 store：
 * ① 折叠是**纯视图状态**，每个块的默认值还依赖自身内容（失败的工具卡默认展开、
 *    正在执行的工具组默认展开）—— 提升到 store 就得把「渲染偏好」和「会话数据」
 *    混在一起，还要改十几个组件；
 * ② 用 `epoch` 计数而不是布尔值：用户可能在两轮全局操作之间手动改了某个块，
 *    再点「全部展开」时若值没变，effect 不触发，那个块就不会被展开（看起来失灵）。
 *    递增的 epoch 保证每次点击都能重新下发一次目标状态。
 */
import { createContext, useContext, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { CollapseSignal } from './messageSegments'

export const CollapseContext = createContext<CollapseSignal | null>(null)

/**
 * 一个可折叠块用它来「响应全局信号」，同时保留自己的局部开合能力。
 *
 * @param defaultOpen 该块自身的默认状态（内容相关，例如失败默认展开）
 * @returns `[open, setOpen]` —— 与 `useState` 同形（setter 支持函数式更新），
 *   调用方无需知道全局信号的存在
 */
export function useCollapsible(
  defaultOpen: boolean
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [open, setOpen] = useState(defaultOpen)
  const signal = useContext(CollapseContext)

  useEffect(() => {
    // signal 变化（epoch 递增）时把全局意图应用到本块
    if (signal) setOpen(signal.open)
    // 只盯 signal 本身：epoch 变了就是一次新的全局指令
  }, [signal])

  return [open, setOpen]
}
