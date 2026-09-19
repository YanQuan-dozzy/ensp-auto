import type { AgentEvent, GateDecision, RunInput, Settings } from '@shared/types'
import type { ToolContext, ToolSpec } from '../tools/registry'

/**
 * AgentRuntime 抽象。
 *
 * 按「抽象接口 + real/mock 双实现」的交付习惯拆开：
 * - react.runtime.ts   生产实现（自研 ReAct 循环 + openai SDK）
 * - mock.runtime.ts    离线/测试实现（脚本回放，不依赖网络与设备）
 *
 * 之所以自研而不引 pi-agent-core：见 docs/ARCHITECTURE.md §2.2 的取证表。
 * 核心理由是工具循环与领域强耦合（闸门、快照、中断、轨迹都要长在循环里），
 * 套通用库反而要一路与它的抽象对抗。
 */

export interface AgentDeps {
  tools: readonly ToolSpec[]
  /** 每轮构建工具执行上下文（含闸门回调与中断信号） */
  buildContext: (signal: AbortSignal) => ToolContext
  getSettings: () => Settings
}

export interface AgentRuntime {
  run(input: RunInput): AsyncIterable<AgentEvent>
  resolveGate(gateId: string, decision: GateDecision): void
  /** v0.4：执行中插话。返回是否接受（仅 running 时入队） */
  enqueue?(text: string): boolean
  /** v0.4：取走尚未消费的排队输入（任务结束收尾时由宿主调用，避免丢消息） */
  takePendingInput?(): string[]
}

/**
 * 把「推」模型的事件源转成「拉」模型的 AsyncIterable。
 *
 * 为什么需要它：Agent 循环是推式的（模型流式吐 token、工具回调触发事件），
 * 而 IPC 与调用方是拉式的（逐个消费事件）。中间的缓冲必须有，否则
 * 事件会在消费者准备好之前到达而丢失。
 */
export class EventStream<T> implements AsyncIterable<T> {
  private buffer: T[] = []
  private waiters: Array<(r: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
      return
    }
    this.buffer.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0, this.waiters.length)) {
      waiter({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift()
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close()
        return Promise.resolve({ value: undefined as never, done: true })
      }
    }
  }
}

/** 工具名 → 摘要文本，供执行轨迹展示 */
export function summarizeToolCall(
  spec: ToolSpec | undefined,
  args: unknown,
  result: { ok: boolean; data?: unknown },
  fallbackName: string
): string {
  if (!spec) return fallbackName
  try {
    return spec.summarize
      ? spec.summarize(args as never, result as never)
      : `${spec.name}${result.ok ? '' : '（失败）'}`
  } catch {
    return spec.name
  }
}
