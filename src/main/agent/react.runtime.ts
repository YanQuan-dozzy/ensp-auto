import { randomUUID } from 'node:crypto'
import type { Message, TextContent } from '@earendil-works/pi-ai'
import type { AgentEvent, GateDecision, RunInput, SessionNode, Settings } from '@shared/types'
import { classifyDanger } from '@shared/risk'
import { toLLMTools, type ToolContext, type ToolSpec } from '../tools/registry'
import { buildLLM } from './llm/models'
import { consumeEvent, newTurn, type CollectedToolCall } from './llm/translate'
import { EventStream, summarizeToolCall, type AgentDeps, type AgentRuntime } from './runtime.iface'

const SYSTEM_PROMPT = `你是 eNSP 网络实验代理。用户用自然语言下达实验目标，你负责自主完成。

可用设备：本机 eNSP 虚拟设备（Huawei VRP），通过 127.0.0.1 的端口访问。

工作方式：
1. 先用 list_devices 或 scan_devices 了解有哪些设备可用，不要假设设备已经连接。
2. 需要了解设备现状时，优先用 get_device_context 一次拿全（型号、版本、视图、接口），
   不要逐条发 display 命令 —— 每次往返都有成本。
3. 只读命令（display / show）用 run_show_command，可以自由执行。
4. 修改配置前必须先 save_config_snapshot 建立快照。这是硬性前提，不可跳过。
5. 破坏性命令会被闸门拦截并要求人工确认，这是设计如此，不要试图绕过。
6. 需要了解设备间拓扑关系时，用 get_topology 查看当前拓扑；必要时用 refresh_topology
   让代理去已连接的设备上采集 LLDP 邻居重新推导。

判定纪律：
- 工具返回 ok=false 时，说明操作失败了。读 error.code 与 error.raw 判断原因，
  改道或修正后重试，不要假设失败的操作其实成功了。
- 工具返回里 settled 为 "quiet" 时说明回显是静默兜底判定的，内容可能不完整。
  如果结论依赖这段内容的完整性，重新执行一次。
- awaitingConfirm 为 true 说明命令停在了设备的 [Y/N] 确认提示上，需要用户决策。

回答要求：
- 用中文，简洁、结构化。涉及配置变更时列出改了什么、依据哪次快照。
- 不要复述工具原始回显，用你的话总结结论。
- 任务开始时先用一到三句话说明你的计划。`

export interface ReactRuntimeOptions {
  apiKey: string
  /** 是否允许危险操作走到闸门（false 时直接拒绝，用于更严格的策略） */
  allowDangerousWithGate?: boolean
}

interface ToolRunResult {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string; raw?: string }
  meta: { ms: number }
}

const failResult = (code: string, message: string, ms: number): ToolRunResult => ({
  ok: false,
  error: { code, message },
  meta: { ms }
})

export class ReactRuntime implements AgentRuntime {
  private readonly gates = new Map<string, (d: GateDecision) => void>()
  /** v0.4：执行中插话队列，每个 round 取模型前被 drain 成 user 消息 */
  private pendingInput: string[] = []

  constructor(
    private readonly deps: AgentDeps,
    private readonly options: ReactRuntimeOptions
  ) {}

  enqueue(text: string): boolean {
    const t = text.trim()
    if (t) this.pendingInput.push(t)
    return true
  }

  takePendingInput(): string[] {
    const out = this.pendingInput
    this.pendingInput = []
    return out
  }

  resolveGate(gateId: string, decision: GateDecision): void {
    const resolve = this.gates.get(gateId)
    if (resolve) {
      this.gates.delete(gateId)
      resolve(decision)
    }
  }

  run(input: RunInput): AsyncIterable<AgentEvent> {
    const stream = new EventStream<AgentEvent>()
    void this.drive(input, stream).catch((e: unknown) => {
      stream.push({
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
        recoverable: false
      })
      stream.push({ type: 'done', reason: 'failed' })
      stream.close()
    })
    return stream
  }

  private async drive(input: RunInput, out: EventStream<AgentEvent>): Promise<void> {
    const settings = this.deps.getSettings()

    // 每个任务新建 LLM 装配（Key 或 provider 变更即时生效；provider 工厂是同步注册）
    const handle = await buildLLM({
      provider: settings.agent.provider,
      baseUrl: settings.agent.baseUrl,
      model: settings.agent.model,
      apiKey: this.options.apiKey
    })
    const model = handle.models.getModel(handle.provider, handle.modelId)
    if (!model) throw new Error(`模型不存在：${handle.modelId}`)

    const toolMap = new Map<string, ToolSpec>(this.deps.tools.map((t) => [t.name, t]))
    const tools = toLLMTools(this.deps.tools)

    const ctx = this.buildContext(input.signal, out)

    // pi-ai Context：systemPrompt 与 messages、tools 分离的 transcript 结构
    // v0.4：先注入会话树祖先链（历史），再追加本次指令
    const messages: Message[] = [...historyToMessages(input.history ?? []), {
      role: 'user',
      content: input.text,
      timestamp: Date.now()
    }]

    let planEmitted = false
    const maxRounds = Math.max(1, settings.agent.maxRounds)

    for (let round = 0; round < maxRounds; round++) {
      if (input.signal.aborted) {
        out.push({ type: 'done', reason: 'aborted' })
        return
      }

      // v0.4 排队插话：每个 round 取模型前把队列里的纠偏消息注入为 user 消息
      appendQueuedUserMessages(messages, this.pendingInput.splice(0, this.pendingInput.length))

      const acc = newTurn()
      let roundDone = false
      let roundFailedExternally: string | null = null

      const evStream = handle.models.stream(model, {
        systemPrompt: SYSTEM_PROMPT,
        messages,
        tools
      }, {
        apiKey: this.options.apiKey,
        temperature: settings.agent.temperature,
        signal: input.signal
      })

      try {
        for await (const ev of evStream) {
          for (const e of consumeEvent(acc, ev)) out.push(e)
          if (ev.type === 'done') {
            roundDone = true
          } else if (ev.type === 'error') {
            roundFailedExternally =
              ev.error?.errorMessage ??
              (ev.reason === 'aborted' ? '请求已中止' : '模型请求失败')
          }
        }
      } catch (e) {
        // 请求层异常（认证缺失/网络失败等）
        out.push({
          type: 'error',
          message: e instanceof Error ? e.message : String(e),
          recoverable: true
        })
        out.push({ type: 'done', reason: 'failed' })
        return
      }

      if (roundFailedExternally !== null) {
        if (input.signal.aborted) {
          out.push({ type: 'done', reason: 'aborted' })
          return
        }
        out.push({ type: 'error', message: roundFailedExternally, recoverable: false })
        out.push({ type: 'done', reason: 'failed' })
        return
      }

      const final = await evStream.result()

      // 首轮助手文本若是列表形态，作为「计划」呈现
      if (!planEmitted && acc.text.trim()) {
        const steps = extractPlan(acc.text)
        if (steps.length >= 2) out.push({ type: 'plan', steps })
        planEmitted = true
      }

      messages.push(final)

      if (acc.toolCalls.length === 0 || !roundDone) {
        out.push({ type: 'done', reason: 'completed' })
        return
      }

      for (const call of acc.toolCalls) {
        if (input.signal.aborted) {
          out.push({ type: 'done', reason: 'aborted' })
          return
        }
        const result = await this.runToolCall(call, toolMap, ctx, out)
        messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: !result.ok,
          timestamp: Date.now()
        })
      }
    }

    out.push({
      type: 'error',
      message: `已达到最大轮次（${maxRounds}）仍未完成任务，任务终止。已完成的操作保留在现场。`,
      recoverable: true
    })
    out.push({ type: 'done', reason: 'failed' })
  }

  private buildContext(signal: AbortSignal, out: EventStream<AgentEvent>): ToolContext {
    const base = this.deps.buildContext(signal)
    return {
      ...base,
      signal,
      requestGate: async (req) => {
        if (this.options.allowDangerousWithGate === false) return false
        const gateId = randomUUID()
        const approved = new Promise<boolean>((resolve) => {
          this.gates.set(gateId, (d) => resolve(d === 'approve'))
        })
        out.push({
          type: 'gate_request',
          gateId,
          name: req.toolName,
          args: req.args,
          reason: req.consequence ? `${req.reason}\n${req.consequence}` : req.reason
        })
        const decision = await approved
        out.push({
          type: 'gate_resolved',
          gateId,
          decision: decision ? 'approve' : 'reject'
        })
        return decision
      }
    }
  }

  private async runToolCall(
    call: CollectedToolCall,
    toolMap: Map<string, ToolSpec>,
    ctx: ToolContext,
    out: EventStream<AgentEvent>
  ): Promise<ToolRunResult> {
    const spec = toolMap.get(call.name)

    // pi-ai 已把工具参数流式解析成对象；若非对象也直接透传，交给 handler 自检
    const parsedArgs: unknown = call.args

    if (!spec) {
      const message = `未知工具：${call.name}`
      out.push({
        type: 'tool_start',
        callId: call.id,
        name: call.name,
        args: parsedArgs,
        risk: 'read'
      })
      out.push({ type: 'tool_end', callId: call.id, ok: false, ms: 0, summary: message })
      return failResult('UNKNOWN', message, 0)
    }

    out.push({
      type: 'tool_start',
      callId: call.id,
      name: spec.name,
      args: parsedArgs,
      risk: spec.risk
    })

    const t0 = Date.now()

    // 危险命令闸门：拦在 handler 执行之前，不依赖提示词
    if (spec.risk === 'danger') {
      const approved = await ctx.requestGate({
        toolName: spec.name,
        args: parsedArgs,
        reason: `工具 ${spec.name} 标记为危险操作`,
        consequence: '该操作不可撤销，可能造成设备配置或数据丢失。'
      })
      if (!approved) {
        const result = failResult('GATE_REJECTED', '用户拒绝了该危险操作', Date.now() - t0)
        out.push({
          type: 'tool_end',
          callId: call.id,
          ok: false,
          ms: result.meta.ms,
          summary: '用户拒绝执行',
          errorCode: 'GATE_REJECTED'
        })
        return result
      }
    }

    try {
      const result = await spec.handler(parsedArgs as never, ctx)
      out.push({
        type: 'tool_end',
        callId: call.id,
        ok: result.ok,
        ms: Date.now() - t0,
        summary: summarizeToolCall(spec, parsedArgs, result, spec.name),
        ...(result.error?.raw ? { raw: result.error.raw } : {}),
        ...(result.error?.code ? { errorCode: String(result.error.code) } : {})
      })
      return result
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      out.push({
        type: 'tool_end',
        callId: call.id,
        ok: false,
        ms: Date.now() - t0,
        summary: `工具抛出异常：${message}`,
        errorCode: 'UNKNOWN'
      })
      return failResult('UNKNOWN', message, Date.now() - t0)
    }
  }
}

/** 从助手首答里抽出计划步骤（编号列表或短横线列表） */
export function extractPlan(text: string): string[] {
  const steps: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const m = /^(?:\d+[.、)]|[-*])\s+(.{2,80})$/.exec(line)
    if (m) steps.push(m[1]!.trim())
  }
  return steps.slice(0, 8)
}

/**
 * 会话树祖先链 → pi-ai 消息。
 * 工具折叠为文本摘要（不回放 toolResult 结构，见 README R2）；
 * assistant 用最小合法 AssistantMessage 重建。
 */
export function historyToMessages(history: readonly SessionNode[]): Message[] {
  const out: Message[] = []
  for (const n of history) {
    if (n.role === 'user') {
      out.push({ role: 'user', content: n.content, timestamp: n.createdAt })
    } else if (n.role === 'assistant') {
      const text: TextContent = { type: 'text', text: n.content }
      out.push({
        role: 'assistant',
        content: [text],
        api: 'openai-completions',
        provider: 'compat',
        model: 'history',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp: n.createdAt
      })
    } else if (n.role === 'tool') {
      const tc = n.toolCall
      const probe = tc ? `${tc.name}(${safeArgTip(tc.args)}) → ${tc.ok === false ? '失败' : '完成'}` : n.content
      out.push({
        role: 'user',
        content: `[历史工具调用 ${probe}]`,
        timestamp: n.createdAt
      })
    }
  }
  return out
}

function safeArgTip(args: unknown): string {
  try {
    const s = JSON.stringify(args)
    return s && s.length > 120 ? `${s.slice(0, 120)}…` : (s ?? '')
  } catch {
    return String(args)
  }
}

/**
 * 把排队消息追加为 user 消息（纯函数，可测）。
 * 返回实际追加条数。注意：空字符串不会入队（ReactRuntime.enqueue 已过滤）。
 */
export function appendQueuedUserMessages(
  messages: Message[],
  queued: string[],
  timestamp?: number
): number {
  let n = 0
  const ts = timestamp ?? Date.now()
  for (const t of queued) {
    const trimmed = t.trim()
    if (!trimmed) continue
    messages.push({ role: 'user', content: trimmed, timestamp: ts })
    n += 1
  }
  return n
}

/** 供主进程在执行工具前预检命令是否危险（配置类工具内部也会再查一次） */
export { classifyDanger }
export type { Settings }