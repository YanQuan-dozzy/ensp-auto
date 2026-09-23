import { randomUUID } from 'node:crypto'
import type { AssistantMessage, Message, TextContent } from '@earendil-works/pi-ai'
import type { AgentEvent, GateDecision, RunInput, SessionNode, Settings } from '@shared/types'
import { classifyDanger } from '@shared/risk'
import {
  GATE_DENIED_REASON,
  GATE_DENIED_SUMMARY,
  planDangerGate
} from '@shared/gate-policy'
import { activeProfile } from '@shared/profiles'
import { composeUserMessage } from '@shared/attachments'
import {
  describeCompaction,
  estimateChars,
  planCompaction,
  planRetry,
  truncateToolResult
} from '@shared/runtime-policy'
import { toLLMTools, type ToolContext, type ToolSpec } from '../tools/registry'
import { buildLLM, type LLMHandle, type LLMSettings } from './llm/models'
import { consumeEvent, newTurn, type CollectedToolCall } from './llm/translate'
import { buildAgentSystemPrompt } from './llm/prompt'
import {
  explainFailure,
  isOverflowFailure,
  isRetryableFailure,
  synthError,
  type ClassifiableMessage as Classifiable
} from './llm/failure'
import { EventStream, summarizeToolCall, type AgentDeps, type AgentRuntime } from './runtime.iface'

/**
 * 可中止的退避等待（v1.7）。
 *
 * 为什么不用 `setTimeout` + `await`：用户在重试等待期间点「停止」必须立刻生效，
 * 否则「停止」按钮看起来是坏的（要等满 1.6s 才有反应）。这里额外监听 abort，
 * 并且清掉监听与 timer，避免每次重试都留一个悬挂的 timeout。
 */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * 自研 ReAct 运行时。
 *
 * v1.5：模型配置从「全局三件套」改为「活跃档案」，并把用户指令与附件一起注入；
 * 系统提示词的拼装搬到了 ./llm/prompt.ts（可单测、也被一键增强复用同一口径）。
 */

export interface ReactRuntimeOptions {
  apiKey: string
  /**
   * 危险工具是否走人工闸门确认。
   *
   * false = 用户在设置里关掉了「危险操作需人工确认」→ **直接执行**（决策 D1：以界面文案
   * 与类型注释为准，而不是把 false 当成"一律拒绝"），跳过的事实会在 tool_end 摘要里显式标注。
   * 命令级危险清单（classifyDanger）不在此开关的作用域内，始终生效。
   */
  allowDangerousWithGate?: boolean
  /**
   * 覆盖 LLM 装配（默认走 buildLLM）。
   *
   * 存在的意义：让「设置项到底有没有进请求」可被自动化验证 ——
   * 用桩 handle 就能抓住真实下发的 systemPrompt / temperature / model，
   * 而不必启一个真实 provider 去赌（R53 那类「设置是死的」缺陷正是靠这一层才测得到）。
   */
  buildLlm?: (settings: LLMSettings) => Promise<LLMHandle>
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
    // 两条路径都必须 close()：
    // - 正常结束：drive 里最后一件事是 push({type:'done'})，但**没有任何地方关流**，
    //   而宿主（services.startAgent）是 `for await` 到迭代器自然结束、不 break 的写法，
    //   于是任务看似跑完、其实消费者永远挂住 —— flushAssistant / 任务结束通知 /
    //   active.delete 全在 finally 里，一个都不会执行（会话会一直显示「运行中」）。
    // - 异常：补一条 error + done 事件后关流（保持原有语义）。
    void this.drive(input, stream).then(
      () => stream.close(),
      (e: unknown) => {
        stream.push({
          type: 'error',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false
        })
        stream.push({ type: 'done', reason: 'failed' })
        stream.close()
      }
    )
    return stream
  }

  private async drive(input: RunInput, out: EventStream<AgentEvent>): Promise<void> {
    const settings = this.deps.getSettings()
    // v1.5：模型配置按「活跃档案」取 —— provider/端点/模型/轮次/温度都跟着档案走
    const profile = activeProfile(settings.agent)

    // 每个任务新建 LLM 装配（Key 或 provider 变更即时生效；provider 工厂是同步注册）
    const handle = await (this.options.buildLlm ?? buildLLM)({
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: this.options.apiKey
    })
    const model = handle.models.getModel(handle.provider, handle.modelId)
    if (!model) throw new Error(`模型不存在：${handle.modelId}`)

    const toolMap = new Map<string, ToolSpec>(this.deps.tools.map((t) => [t.name, t]))
    const tools = toLLMTools(this.deps.tools)

    const ctx = this.buildContext(input.signal, out)

    // pi-ai Context：systemPrompt 与 messages、tools 分离的 transcript 结构
    // v0.4：先注入会话树祖先链（历史），再追加本次指令
    // v1.5：附件清单与文本预览拼进用户消息，完整内容留给 read_attachment 按需取
    const messages: Message[] = [
      ...historyToMessages(input.history ?? []),
      {
        role: 'user',
        content: composeUserMessage(input.text, input.attachments ?? []),
        timestamp: Date.now()
      }
    ]

    let planEmitted = false
    const maxRounds = Math.max(1, profile.maxRounds)
    const retry = settings.retry
    const compaction = settings.compaction
    const contextWindow = model.contextWindow

    // system prompt 每个任务只拼一次（技能/自定义指令运行期不变）。
    // D14：字符预算必须把它一并计入 —— transcriptMaxChars 的压缩只作用在 messages 上，
    // 若 skill 注入无上限，system prompt 再大压缩也追不上，会出现「上下文看着很小却总报溢出」。
    const systemPrompt = buildAgentSystemPrompt(
      this.deps.getSkills?.(),
      // R53：用户在设置里写的自定义指令必须真的进提示词，否则这个设置项是个死开关
      this.deps.getCustomInstructions?.()
    )

    /**
     * 就地压缩 transcript（v1.7）。只改内容不改条数，所以 `messages` 的引用与顺序都不变 ——
     * 调用方（以及 pi-ai 的 provider 适配层）看到的仍是一条合法的消息序列。
     */
    const compactNow = (maxChars: number, keepRounds: number): boolean => {
      const plan = planCompaction(messages, { maxChars, keepRounds })
      if (!plan.applied) return false
      messages.splice(0, messages.length, ...plan.messages)
      out.push({
        type: 'compact',
        shrunkMessages: plan.shrunkMessages,
        beforeChars: plan.beforeChars,
        afterChars: plan.afterChars,
        detail: describeCompaction(plan)
      })
      return true
    }

    for (let round = 0; round < maxRounds; round++) {
      if (input.signal.aborted) {
        out.push({ type: 'done', reason: 'aborted' })
        return
      }

      // v0.4 排队插话：每个 round 取模型前把队列里的纠偏消息注入为 user 消息
      appendQueuedUserMessages(messages, this.pendingInput.splice(0, this.pendingInput.length))

      // v1.7 主动压缩：在取模型之前把 transcript 拉回预算内。
      // 放在这里而不是「等 provider 报错」是因为溢出报错往往一次就废掉整轮，
      // 而这个判断是纯粹的字符估算，零成本。预算 = messages + system prompt（D14）。
      if (compaction.enabled && estimateChars(messages) + systemPrompt.length > compaction.transcriptMaxChars) {
        compactNow(compaction.transcriptMaxChars, compaction.keepRounds)
      }

      // —— 一个 round 内的尝试循环：失败分类 → 压缩 / 退避重试 / 如实失败 ——
      // 每次尝试都用全新的累加器：失败尝试的半截输出不该进入 transcript（只留在界面里）。
      let acc = newTurn()
      let roundDone = false
      let failed: Classifiable | null = null
      let finalMessage: AssistantMessage | null = null
      let retried = 0
      let overflowRetried = false

      for (;;) {
        acc = newTurn()
        roundDone = false
        failed = null

        const evStream = handle.models.stream(
          model,
          {
            systemPrompt,
            messages,
            tools
          },
          {
            apiKey: this.options.apiKey,
            temperature: profile.temperature,
            signal: input.signal
          }
        )

        try {
          for await (const ev of evStream) {
            for (const e of consumeEvent(acc, ev)) out.push(e)
            if (ev.type === 'done') {
              roundDone = true
            } else if (ev.type === 'error') {
              // 错误事件里带的是完整的 AssistantMessage，pi 的两套判定器都吃这个形状
              failed = ev.error
            }
          }
        } catch (e) {
          // 请求层抛异常（网络中断/认证缺失等）：造一个最小错误对象，让分类器统一处理，
          // 不在这里另开一套「网络失败要不要重试」的判断（那就是两份会漂移的知识）
          failed = synthError(e instanceof Error ? e.message : String(e))
        }

        if (failed === null && roundDone) {
          // 只有成功的那一次才去取最终消息：失败尝试的 result() 拿到的是一条错误消息，
          // 推进 transcript 会污染后续每一轮
          finalMessage = await evStream.result()
          break
        }

        if (input.signal.aborted || failed?.stopReason === 'aborted') {
          out.push({ type: 'done', reason: 'aborted' })
          return
        }

        // 1) 上下文溢出：先压缩再重试。**不消耗重试预算** —— 这不是 provider 的临时故障，
        //    是本地把上下文撑爆了，退避等待只会白等。
        if (compaction.enabled && !overflowRetried && failed && isOverflowFailure(failed, contextWindow)) {
          overflowRetried = true
          // D14：预算口径与主动压缩一致 —— messages + system prompt
          const before = estimateChars(messages) + systemPrompt.length
          const shrunk = compactNow(Math.max(20_000, Math.floor(before * 0.5)), 2)
          if (!shrunk) {
            out.push({
              type: 'error',
              message:
                explainFailure(failed, contextWindow) +
                ' —— 已无历史内容可压缩，请新开一个会话，或让工具单次输出更少。',
              recoverable: false
            })
            out.push({ type: 'done', reason: 'failed' })
            return
          }
          continue
        }

        // 2) 临时性失败（限流/超时/5xx/连接中断）：指数退避重试
        if (failed && isRetryableFailure(failed)) {
          const plan = planRetry(retry, retried, failed.errorMessage ?? '')
          if (plan.retry) {
            retried = plan.attempt
            out.push({
              type: 'retry',
              attempt: plan.attempt,
              maxAttempts: retry.maxRetries,
              delayMs: plan.delayMs,
              reason: failed.errorMessage ?? '临时性失败'
            })
            await sleepAbortable(plan.delayMs, input.signal)
            // 退避期间用户可能点了「停止」：这里就收工，不要再发一次注定被中止的请求
            if (input.signal.aborted) {
              out.push({ type: 'done', reason: 'aborted' })
              return
            }
            continue
          }
        }

        // 3) 重试预算用尽或确定性失败：如实报告，并说清「该改什么」
        out.push({
          type: 'error',
          message: failed ? explainFailure(failed, contextWindow) : '模型请求失败（未收到任何事件）',
          recoverable: failed !== null && isRetryableFailure(failed)
        })
        out.push({ type: 'done', reason: 'failed' })
        return
      }

      if (!finalMessage) {
        out.push({ type: 'error', message: '模型请求失败（未收到任何事件）', recoverable: true })
        out.push({ type: 'done', reason: 'failed' })
        return
      }

      // 首轮助手文本若是列表形态，作为「计划」呈现
      if (!planEmitted && acc.text.trim()) {
        const steps = extractPlan(acc.text)
        if (steps.length >= 2) out.push({ type: 'plan', steps })
        planEmitted = true
      }

      messages.push(finalMessage)

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
        // v1.7：单条结果先做长度截断再进 transcript —— eNSP 的 display 类命令
        // 一条就能几十万字符，单条不截断的话「压缩」永远追不上它撑爆上下文的速度。
        // 界面上（tool_end.raw）仍是完整输出，截断只发生在给模型看的那一份。
        const payload = compaction.enabled
          ? truncateToolResult(JSON.stringify(result), compaction.toolResultMaxChars).text
          : JSON.stringify(result)
        messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: payload }],
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
        // 已停止时不再请求闸门：避免「批准 Promise 永不 resolve → drive() 挂死、流永不关闭」。
        // 同时也监听 abort，让等待批准期间点「停止」立即生效（与 sleepAbortable 同一约定）。
        if (signal.aborted) return false
        const gateId = randomUUID()
        const approved = new Promise<boolean>((resolve) => {
          const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort)
            resolve(false)
          }
          signal.addEventListener('abort', onAbort, { once: true })
          this.gates.set(gateId, (d) => {
            signal.removeEventListener('abort', onAbort)
            resolve(d === 'approve')
          })
        })
        out.push({
          type: 'gate_request',
          gateId,
          name: req.toolName,
          args: req.args,
          reason: req.consequence ? `${req.reason}\n${req.consequence}` : req.reason
        })
        const decision = await approved
        this.gates.delete(gateId)
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

    // 危险命令闸门：拦在 handler 执行之前，不依赖提示词。
    // 该问 / 该跳过 / 该拒绝的判定在 shared/gate-policy.ts（纯函数，有对应用例）：
    // 关掉确认框 = 「跳过确认直接执行」（决策 D1），不是「一律拒绝」。
    // D15：把「任务已中止」也传进去 —— 中止时连闸门都不发（上轮已由 requestGate 的
    // abort 监听与 drive 的提前 return 兜住行为，但 deny 分支因此在进程内永远不可达，
    // 语义暴露不出来；这里让纯函数的判定与运行时实际一致，分支也能被用例覆盖）。
    const gatePlan = planDangerGate({
      risk: spec.risk,
      confirmDanger: this.options.allowDangerousWithGate !== false,
      aborted: ctx.signal?.aborted ?? false
    })
    if (gatePlan.kind === 'deny') {
      const result = failResult('GATE_REJECTED', gatePlan.reason, Date.now() - t0)
      out.push({
        type: 'tool_end',
        callId: call.id,
        ok: false,
        ms: result.meta.ms,
        summary: gatePlan.summary,
        errorCode: 'GATE_REJECTED'
      })
      return result
    }
    if (gatePlan.kind === 'ask') {
      const approved = await ctx.requestGate({
        toolName: spec.name,
        args: parsedArgs,
        reason: `工具 ${spec.name} 标记为危险操作`,
        consequence: '该操作不可撤销，可能造成设备配置或数据丢失。'
      })
      if (!approved) {
        // 措辞必须同时覆盖「用户点了拒绝」与「任务已中止 / 出口无闸门」两种来源，
        // 否则轨迹里会出现与事实不符的"用户拒绝"（R3）。
        const result = failResult('GATE_REJECTED', GATE_DENIED_REASON, Date.now() - t0)
        out.push({
          type: 'tool_end',
          callId: call.id,
          ok: false,
          ms: result.meta.ms,
          summary: GATE_DENIED_SUMMARY,
          errorCode: 'GATE_REJECTED'
        })
        return result
      }
    }
    const gateSkippedByPolicy = gatePlan.kind === 'skip-confirm'

    try {
      const result = await spec.handler(parsedArgs as never, ctx)
      const summary = summarizeToolCall(spec, parsedArgs, result, spec.name)
      out.push({
        type: 'tool_end',
        callId: call.id,
        ok: result.ok,
        ms: Date.now() - t0,
        summary: gateSkippedByPolicy ? `${summary}（确认框已关闭，按策略跳过确认）` : summary,
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

/** v1.5：提示词拼装已移到 ./llm/prompt.ts，这里保留同名导出以免调用方迁移 */
export { buildAgentSystemPrompt } from './llm/prompt'

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