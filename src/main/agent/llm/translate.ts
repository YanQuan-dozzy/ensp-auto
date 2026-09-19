import type { AgentEvent } from '@shared/types'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'

/**
 * pi-ai 事件 → 自研 Agent 的翻译层。
 *
 * 设计意图：把「消费一条 pi-ai 流式事件」做成无副作用纯逻辑，
 * 便于用记录式事件样例离线单测（不依赖网络与 Key）。
 *
 * 只读事件（text）在流中即时下发；工具调用（toolcall_end）只收集不执行，
 * 由运行时在整轮结束后逐条执行并发出 tool_start / tool_end。
 */

export interface CollectedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** 一轮对话的累计状态 */
export interface TurnAccumulator {
  text: string
  toolCalls: CollectedToolCall[]
}

export function newTurn(): TurnAccumulator {
  return { text: '', toolCalls: [] }
}

/**
 * 消费一条事件，返回需要立即下发给 UI 的 AgentEvent（目前只有 text delta）。
 * toolcall_end 收集进 acc.toolCalls（arguments 已是解析后的对象）。
 */
export function consumeEvent(acc: TurnAccumulator, ev: AssistantMessageEvent): AgentEvent[] {
  switch (ev.type) {
    case 'text_delta':
      acc.text += ev.delta
      return [{ type: 'text', delta: ev.delta }]
    case 'thinking_delta':
    case 'thinking_start':
    case 'thinking_end':
      // 推理中间过程不进入对话流，避免把大段思考文本灌给用户
      return []
    case 'toolcall_end':
      acc.toolCalls.push({
        id: ev.toolCall.id,
        name: ev.toolCall.name,
        args: (ev.toolCall.arguments ?? {}) as Record<string, unknown>
      })
      return []
    default:
      return []
  }
}