import { randomUUID } from 'node:crypto'
import type { AssistantMessage, ImageContent, Message, TextContent } from '@earendil-works/pi-ai'
import type {
  AgentEvent,
  GateDecision,
  ModelProfile,
  RunInput,
  SessionNode,
  Settings
} from '@shared/types'
import type { QuestionAnswers, QuestionItem, TodoItem } from '@shared/interaction'
import { buildTodoPromptBlock, describeTodos, PLAN_APPROVE, PLAN_STOP } from '@shared/interaction'
import {
  buildPlanReviewOptions,
  PLAN_MODE_BLOCK_CODE,
  PLAN_REVIEW_QUESTION_ID,
  planModeToolDecision
} from '@shared/plan-mode'
import { classifyDanger } from '@shared/risk'
import {
  COMMAND_GATE_SKIPPED_NOTE,
  GATE_DENIED_REASON,
  GATE_DENIED_SUMMARY,
  planDangerGate
} from '@shared/gate-policy'
import { activeProfile, effectiveContextWindow } from '@shared/profiles'
import { availableEfforts, capabilityOf } from '@shared/model-thinking'
import { composeUserContent, composeUserMessage, type Attachment, type ResolvedImage } from '@shared/attachments'
import { planUserImages } from '@shared/image-attach'
import {
  buildTitleUserMessage,
  fallbackTitle,
  isUsefulTitle,
  normalizeTitle,
  titleSystemPrompt,
  TITLE_MAX_TOKENS
} from '@shared/session-title'
import {
  applySummary,
  describeCompaction,
  describeSummaryCompaction,
  estimateChars,
  measurePressure,
  planCompaction,
  planRetry,
  planSummaryCompaction,
  planToolResultReprune,
  promptTokensOf,
  repruneBudgetOf,
  roundsLeftNotice,
  truncateToolResult,
  type PressureReport,
  type TokenCalibration
} from '@shared/runtime-policy'
import {
  isParallelSafe,
  maxParallelOf,
  planToolBatches,
  runGroupedBounded,
  scheduleKeyOf
} from '@shared/concurrency'
import {
  EMPTY_REPEAT_CHAIN,
  observeToolCall,
  repeatGuardEnabledOf,
  type RepeatChain
} from '@shared/repeat-guard'
import { renderSpillDump, spillLocatorNotice } from '@shared/spill'
import { toLLMTools, type ToolContext, type ToolSpec } from '../tools/registry'
import { buildLLM, type LLMHandle, type LLMSettings } from './llm/models'
import { consumeEvent, newTurn, type CollectedToolCall } from './llm/translate'
import { buildAgentSystemPrompt, buildSummaryUserMessage, PLAN_MODE_PROMPT_BLOCK, SUMMARY_SYSTEM_PROMPT } from './llm/prompt'
import {
  explainFailure,
  isOverflowFailure,
  isRetryableFailure,
  synthError,
  type ClassifiableMessage as Classifiable
} from './llm/failure'
import {
  EventStream,
  cardMetaOf,
  smallToolData,
  summarizeToolCall,
  toolImageRef,
  type AgentDeps,
  type AgentRuntime,
  type ImagePartResult,
  type ImageRequestRef,
  type ToolImageRef
} from './runtime.iface'

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

/**
 * F（v2.14）：`preExecute` 的判定结果。
 *
 * `reject` 携带的是「已准备好播报的失败」——`summary` / `ms` / `errorCode` 与拆分前的
 * 实现逐字段对齐（`errorCode` 可选：只有「未知工具」那一支刻意不发码）。
 */
type PreExecuteDecision =
  | { kind: 'run'; spec: ToolSpec; args: unknown; skipConfirm: boolean }
  | { kind: 'reject'; result: ToolRunResult; summary: string; ms: number; errorCode?: string }

/** 摘要请求的输出上限：够写 600 字结论，又不至于让它变成一个昂贵的请求 */
const SUMMARY_MAX_TOKENS = 2_000

/** `handle.models.getModel()` 解析出的模型对象（摘要请求要复用它） */
type ResolvedModel = NonNullable<ReturnType<LLMHandle['models']['getModel']>>

const failResult = (code: string, message: string, ms: number): ToolRunResult => ({
  ok: false,
  error: { code, message },
  meta: { ms }
})

/**
 * v2.28：判断本次工具结果里是否有「命令级危险清单被策略放行」。
 *
 * 只认 `data.skippedCommand` 这一个字段（由 `tools/config.ts` 的下发管道回传），
 * 不猜别的形状 —— 猜错就会在摘要里对一次正常变更说「绕过了危险清单」。
 */
function commandGateSkipped(result: ToolRunResult): boolean {
  const data = result.data
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { skippedCommand?: unknown }).skippedCommand === 'string'
  )
}

export class ReactRuntime implements AgentRuntime {
  private readonly gates = new Map<string, (d: GateDecision) => void>()
  /**
   * v2.7：待裁决的结构化提问（`questionId → 回调`）。
   *
   * 与 gates 分开两个 Map 而不是塞进一个 `Map<string, (d:any)=>void>`：
   * 两者的裁决类型不同（布尔 vs 答案映射），混在一起就得靠调用方保证
   * 「拿对的那个 Map」—— 一次拿错就是把答案当成批准。
   */
  private readonly questions = new Map<string, (a: QuestionAnswers | null) => void>()
  /** v0.4：执行中插话队列，每个 round 取模型前被 drain 成 user 消息 */
  private pendingInput: string[] = []
  /** v2.2：本轮任务开始时间（done 事件带耗时，界面渲染「完成 + 耗时」收尾卡） */
  private taskStartedAt = 0
  /**
   * v2.6：上下文压不动且已过水位时只提醒一次。
   * 不终止任务 —— 估算是保守的（默认 0.75 触发），因为「估算偏高」就白杀一个正常任务，
   * 比让它跑下去更糟；真溢出时下面的溢出分支会接手。
   */
  private warnedUncompressible = false
  /**
   * v2.8：本轮的会话根 ID（`finish` 里标记「已收尾」用）。
   *
   * 存在实例字段而不是层层传参：`finish` 被十几个分支调用（中止、溢出失败、
   * 最大轮次、正常完成…），每个都加一个 rootId 参数既丑又容易漏 ——
   * 漏掉的那个分支就会让会话永远显示「可续跑」。
   */
  private runRootId: string | null = null

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

  resolveQuestion(questionId: string, answers: QuestionAnswers | null): void {
    const resolve = this.questions.get(questionId)
    if (resolve) {
      this.questions.delete(questionId)
      resolve(answers)
    }
  }

  run(input: RunInput): AsyncIterable<AgentEvent> {
    const stream = new EventStream<AgentEvent>()
    this.taskStartedAt = Date.now()
    // v2.7：每次 run 都要清掉上一次的残留状态。
    // 运行时实例是**每轮任务新建**的（见 services.createRuntime），所以这里清的是
    // 「同一个实例被复用」这种将来可能出现的用法 —— 一次没清，用户就会看到
    // 上一轮任务的「压不动了」提示不再出现、或一个早已关闭的提问卡还在等答案。
    this.warnedUncompressible = false
    this.questions.clear()
    this.gates.clear()
    // v2.8：收尾钩子与轮次标记同样要清 —— 同一个实例被复用时，
    // 上一轮残留的 onFinish 会让新任务结束后去给旧会话生成标题。
    this.onFinish = null
    this.runRootId = null
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
        this.finish(stream, 'failed')
        stream.close()
      }
    )
    return stream
  }

  /**
   * v2.8：本轮的「收尾钩子」——由 `drive()` 装配，`finish()` 调用。
   *
   * 为什么做成一个闭包而不是往 `finish` 里塞参数：收尾要做两件依赖 handle/model
   * 的事（生成标题、标记已收尾），而 `finish` 有十几个调用点。
   * 闭包在 drive 里一次性闭住 handle/model/input/out，finish 只管调用。
   * 缺省为 undefined（Mock 运行时不会走到这里）。
   */
  private onFinish: ((reason: 'completed' | 'aborted' | 'failed') => Promise<void>) | null = null

  /** v2.2：统一收尾 —— done 事件带上本轮任务耗时 */
  private finish(out: EventStream<AgentEvent>, reason: 'completed' | 'aborted' | 'failed'): void {
    // v2.8：标记会话已收尾（所有分支都经这里，所以不会漏）
    if (this.runRootId && this.deps.sessionTree) {
      try {
        this.deps.sessionTree.markSettled(this.runRootId, '')
      } catch {
        /* 索引写失败不影响任务收尾 */
      }
    }
    // v2.8：标题生成是**异步**的，但绝不能拖住 done 事件与流关闭 ——
    // done 必须立刻发（用户等着看「任务完成」），标题在后台补，补上后
    // 用 title_updated 事件单独告知界面。这里 fire-and-forget。
    const hook = this.onFinish
    if (hook) {
      this.onFinish = null
      void hook(reason)
    }
    out.push({ type: 'done', reason, ms: Date.now() - this.taskStartedAt })
  }

  private async drive(input: RunInput, out: EventStream<AgentEvent>): Promise<void> {
    const settings = this.deps.getSettings()
    // v1.5：模型配置按「活跃档案」取 —— provider/端点/模型/轮次/温度都跟着档案走
    const profile = activeProfile(settings.agent)
    // v2.3：这一档模型「实际支持什么」—— 能否关思考、支持哪几档强度、接不接受采样参数
    const capability = capabilityOf(profile)

    // 每个任务新建 LLM 装配（Key 或 provider 变更即时生效；provider 工厂是同步注册）
    const handle = await (this.options.buildLlm ?? buildLLM)({
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: this.options.apiKey,
      // 传「实际生效」的窗口：开了「更大上下文 Max」时元数据里也必须是 1M，
      // 否则 pi 的上下文管理仍按旧值算
      contextWindow: effectiveContextWindow(profile),
      maxOutputTokens: profile.maxOutputTokens,
      supportsImage: profile.supportsImage,
      // 思考能力逐模型不同：能不能关、支持哪几档都由能力表决定
      thinking: capability.thinking,
      thinkingEfforts: availableEfforts(capability)
    })
    const model = handle.models.getModel(handle.provider, handle.modelId)
    if (!model) throw new Error(`模型不存在：${handle.modelId}`)

    const toolMap = new Map<string, ToolSpec>(this.deps.tools.map((t) => [t.name, t]))
    const tools = toLLMTools(this.deps.tools)

    const ctx = this.buildContext(input, input.signal, out)

    // pi-ai Context：systemPrompt 与 messages、tools 分离的 transcript 结构
    // v0.4：先注入会话树祖先链（历史），再追加本次指令
    // v1.5：附件清单与文本预览拼进用户消息，完整内容留给 read_attachment 按需取
    // v2.22（F17）：图片附件读成 base64 直接附在用户消息上（模型支持图片时）——
    //   提示词块与图片块必须**同源**：谁附上了、谁没附上，都由这一次读取的结果决定
    const userContent = await this.composeUserContentFor(
      input.text,
      input.attachments ?? [],
      profile
    )
    const messages: Message[] = [
      ...historyToMessages(input.history ?? []),
      {
        role: 'user',
        content: userContent,
        timestamp: Date.now()
      }
    ]
    /** v2.22（F17）：这一轮模型能不能看图 —— 工具结果附图的唯一开关（pi 对不支持的模型会静默丢弃图片块） */
    const modelSeesImages = profile.supportsImage === true

    let planEmitted = false
    // v2.7：计划模式可在本轮内被「批准」关掉（见下文的方案评审），所以是 let
    let planMode = input.planMode === true

    // —— v2.8：会话标题（懒生成）——
    this.runRootId = input.rootId ?? null
    // 收尾钩子：只在「任务成功收尾」后尝试起标题（失败/中止不起 —— 一次失败
    // 排查不该成为会话的长期名字）。是否真的发请求由 generateTitle 里的
    // `needsAutoTitle` 决定（标题未被用户钉住、且 AI 还没成功起过名）。
    // v2.15 之前这里还卡「仅首轮」：首轮任务失败/被中止的会话就永远没有
    // AI 标题，标题一直停留在「首条消息截断」的兜底值上。
    this.onFinish = async (reason: 'completed' | 'aborted' | 'failed'): Promise<void> => {
      if (reason !== 'completed') return
      await this.generateTitle(handle, model, input, out, input.signal)
    }

    // v2.7：批准后要把探索用掉的轮次还回去，所以是 let
    let maxRounds = Math.max(1, profile.maxRounds)
    /**
     * v2.9：轮次将尽的收尾提醒是否已发过（一次任务最多发一次）。
     *
     * 为什么需要这个标记：提醒是「还剩 N 轮」这种一次性通知，每轮都发等于把
     * 上下文变成复读机，还会把模型的注意力从收尾拽走。批准方案时预算会被补回
     * （见下面的 maxRounds += roundsUsed），那时要重新武装 —— 否则补回预算后再接近
     * 用尽也不会再提醒。
     */
    let warnedRoundsLeft = false
    /**
     * v2.14：重复调用链（同一工具 + 同一参数连续出现的次数）。
     *
     * 跨轮次累积，且在「用户插话 / 计划评审回话」处重置 —— 那两处上下文已经变了，
     * 跨过用户一句话的重复不算循环。判定逻辑全在 shared/repeat-guard.ts（纯函数）。
     */
    let repeatChain: RepeatChain = EMPTY_REPEAT_CHAIN
    const repeatGuardEnabled = repeatGuardEnabledOf(settings)
    const retry = settings.retry
    const compaction = settings.compaction
    // v2.3：溢出判定用「这一档自己声明的窗口」，不再用模型元数据里的统一值 ——
    // 逐档可配（且可能开了「更大上下文 Max」）之后，2M 窗口的模型不该在 256k 就被判溢出。
    const contextWindow = effectiveContextWindow(profile)
    /** 逐档采样参数：Top P / K 留空时不下发（由服务商用自己的默认值） */
    const samplingParams: Record<string, number> = {}
    if (profile.topP !== null) samplingParams.top_p = profile.topP
    if (profile.topK !== null) samplingParams.top_k = profile.topK

    // system prompt 每个任务只拼一次（技能/自定义指令运行期不变）。
    // D14：字符预算必须把它一并计入 —— transcriptMaxChars 的压缩只作用在 messages 上，
    // 若 skill 注入无上限，system prompt 再大压缩也追不上，会出现「上下文看着很小却总报溢出」。
    const topologyDir = settings.storage?.topologyDir
    const basePrompt = buildAgentSystemPrompt(
      this.deps.getSkills?.(),
      // R53：用户在设置里写的自定义指令必须真的进提示词，否则这个设置项是个死开关
      this.deps.getCustomInstructions?.(),
      topologyDir ? { topologyDir } : undefined
    )

    // —— v2.7：任务清单 ——
    // 按会话根 ID 分桶（不是 sessionId —— 那个恒为 'main'，跨会话会串味）。
    // 没有存储或没有会话归属（外部 MCP 出口）时整块功能关闭：既不注入提示词，
    // 也**不发清单事件** —— 一个「空清单」事件会让界面把上一段对话的进度抹成零。
    const todoOwnerId = input.rootId ?? ''
    const todosReady = Boolean(this.deps.todos && todoOwnerId)
    const readTodos = (): TodoItem[] => (todosReady ? this.deps.todos!.get(todoOwnerId) : [])

    // v2.28：清单**不进 system prompt**。
    // system prompt 是服务端 prompt cache 的**第一个前缀** —— 它一变，后面整段
    // transcript 都要按全价重算；而清单在长任务里会被 todo_write 更新很多次，
    // 每次更新都整车重算的代价极大（据本仓实测：一次 33 轮的任务里 system prompt
    // 被清单改动击穿数次，命中缓存的那些轮次全部白费）。
    // 于是清单改为**追加到 transcript 末尾**：首轮挂在本轮用户消息上，之后挂在
    // 触发 todo_write 的那一轮的工具结果上。追加只是延长前缀，不破坏
    // `assistant(toolCalls) ↔ toolResult` 配对，也不改轮次划分（压缩的保留窗口
    // 依赖 role 序列，插一条 user 消息会把刚跑完的轮次挤出窗口）。
    // 结果是：system prompt 从任务开始到结束**逐字不变**，前缀缓存可以一直命中。
    const promptFor = (mode: boolean): string =>
      basePrompt + (mode ? PLAN_MODE_PROMPT_BLOCK : '')
    let systemPrompt = promptFor(planMode)

    // 本轮开始时把已有清单推给界面，并挂到首轮用户消息上 ——
    // 用户重开会话继续干活时，模型与进度条都不该是空的
    const initialTodos = readTodos()
    if (initialTodos.length > 0) {
      appendTextToMessage(messages[messages.length - 1]!, buildTodoPromptBlock(initialTodos))
      out.push({
        type: 'todo_update',
        todos: initialTodos,
        detail: `恢复任务清单：${describeTodos(initialTodos)}`,
        ownerId: todoOwnerId
      })
    }

    /**
     * L2 就地修剪（v1.7）：只改内容不改条数，所以 `messages` 的引用与顺序都不变 ——
     * 调用方（以及 pi-ai 的 provider 适配层）看到的仍是一条合法的消息序列。
     */
    const trimNow = (maxChars: number, keepRounds: number): boolean => {
      const plan = planCompaction(messages, { maxChars, keepRounds })
      if (!plan.applied) return false
      messages.splice(0, messages.length, ...plan.messages)
      out.push({
        type: 'compact',
        mode: 'trim',
        shrunkMessages: plan.shrunkMessages,
        beforeChars: plan.beforeChars,
        afterChars: plan.afterChars,
        detail: describeCompaction(plan)
      })
      return true
    }

    // —— v2.6：真实 token 计量 ——
    // 上一次请求「字符数 ↔ 真实 prompt tokens」的对照，用来校准字符估算。
    // 真实值准但滞后一整轮（这一轮刚追加的工具回显还没被它计入），
    // 字符估算能反映新增部分但绝对值不准 —— 用比值把两者接起来。
    let calibration: TokenCalibration | null = null
    /** 摘要请求最近一次失败的原因（失败不能吞掉，否则用户只看到「无内容可压缩」这种误导文案） */
    let lastSummaryError: string | null = null

    const pressureNow = (): PressureReport =>
      measurePressure({
        messages,
        systemPromptChars: systemPrompt.length,
        contextWindow,
        pressureRatio: compaction.pressureRatio,
        maxChars: compaction.transcriptMaxChars,
        calibration
      })

    /**
     * L3 摘要压缩：把老轮次**原文**交给模型压成结论摘要，再按 user 边界整段替换。
     * 返回 true = 摘要已写入 `messages`。
     *
     * 失败（网络/超时/模型拒答）一律**静默降级**：压缩是保护性动作，
     * 它自己失败绝不能把整轮任务带下去 —— 外面还有 L2 修剪兜底。
     */
    const summarizeNow = async (keepRounds: number): Promise<boolean> => {
      const plan = planSummaryCompaction(messages, { keepRounds })
      if (!plan.applied || !plan.body.trim()) return false
      if (input.signal.aborted) return false

      // 先告诉界面「正在摘要」：这一步是额外一次模型请求，要等几秒
      out.push({
        type: 'compact',
        mode: 'summary',
        shrunkMessages: 0,
        beforeChars: plan.segmentChars,
        afterChars: plan.segmentChars,
        rounds: plan.rounds,
        promptTokens: pressureNow().tokens,
        contextWindow,
        detail: `上下文接近上限，正在把较早的 ${plan.rounds} 轮原文交给模型压成结论摘要…`
      })

      let text = ''
      try {
        text = await this.runSummaryRequest(handle, model, plan.body, input.signal)
        if (!text.trim()) lastSummaryError = '模型返回了空摘要'
      } catch (e) {
        lastSummaryError = e instanceof Error ? e.message : String(e)
        text = ''
      }
      if (!text.trim()) return false

      const beforeChars = estimateChars(messages)
      messages.splice(0, messages.length, ...applySummary(messages, plan, text, Date.now()))
      const afterChars = estimateChars(messages)
      out.push({
        type: 'compact',
        mode: 'summary',
        shrunkMessages: plan.messageCount,
        beforeChars,
        afterChars,
        rounds: plan.rounds,
        summary: text.trim(),
        promptTokens: pressureNow().tokens,
        contextWindow,
        detail: describeSummaryCompaction({
          rounds: plan.rounds,
          messageCount: plan.messageCount,
          beforeChars,
          afterChars
        })
      })
      return true
    }

    /**
     * L1.5（v2.14）：把**已归档**的旧结果重剪到更小的预算。**零模型调用。**
     *
     * 只动带定位符的结果（完整原文在磁盘上，中段随时可取回），没归档过的一律不碰 ——
     * 详见 `planToolResultReprune` 的说明。
     */
    const repruneNow = (keepRounds: number): boolean => {
      const plan = planToolResultReprune(messages, {
        maxChars: repruneBudgetOf(compaction.toolResultMaxChars),
        keepRounds
      })
      if (!plan.applied) return false
      messages.splice(0, messages.length, ...plan.messages)
      out.push({
        type: 'compact',
        mode: 'trim',
        shrunkMessages: plan.shrunkMessages,
        beforeChars: plan.beforeChars,
        afterChars: plan.afterChars,
        detail:
          `已把 ${plan.shrunkMessages} 条**已归档**的旧回显按更小预算重剪` +
          `（省 ${plan.savedChars} 字符；完整原文仍在归档文件里，需要时可用 read_attachment 取回）。`
      })
      return true
    }

    /**
     * 压缩流水线：**先零成本重剪 → 再原文摘要 → 仍超预算才本地修剪**。
     *
     * 顺序不能反过来：L2 会把老工具回显换成「请重新调用该工具」的占位文本，
     * 先从它下手的话，摘要在已经没有原文的 transcript 上工作，只能压出一堆占位符。
     *
     * v2.14：最前面多了一档 L1.5（重剪已归档结果）。它**可恢复**（保头保尾 + 重新挂定位符），
     * 所以排在摘要之前不会毁素材；而它不花模型请求 —— 万一它自己就把体积压到水位以下，
     * 后面那次摘要请求就整个省掉了（长实验里这种「几十条已归档大回显」的场景很常见）。
     */
    const compactPipeline = async (keepRounds: number): Promise<boolean> => {
      let changed = false
      changed = repruneNow(keepRounds) || changed
      if (compaction.summarize && pressureNow().over) {
        changed = (await summarizeNow(keepRounds)) || changed
      }
      const p = pressureNow()
      if (p.over) {
        // 目标：砍到当前体积的 60%，但不越过用户设的绝对预算
        const target = Math.max(20_000, Math.floor(p.chars * 0.6))
        changed = trimNow(Math.min(target, compaction.transcriptMaxChars), keepRounds) || changed
      }
      return changed
    }

    for (let round = 0; round < maxRounds; round++) {
      if (input.signal.aborted) {
        this.finish(out, 'aborted')
        return
      }

      // v0.4 排队插话：每个 round 取模型前把队列里的纠偏消息注入为 user 消息
      // v2.14：真的注入了（返回条数 > 0）才重置重复链 —— 用户开口就是新上下文
      const injected = appendQueuedUserMessages(
        messages,
        this.pendingInput.splice(0, this.pendingInput.length)
      )
      if (injected > 0) repeatChain = EMPTY_REPEAT_CHAIN

      // v2.9 轮次预算的软着陆：快用完时告诉模型一次，让它收尾而不是跑到撞墙。
      // 200 轮的预算下，「跑到上限才由运行时宣布终止」意味着前面白跑了很多轮 ——
      // 12 轮时代看不出这个问题，因为撞墙快、代价小。
      //
      // 追加到 messages 末尾而不是改 systemPrompt：system prompt 逐字变化会让服务端
      // prompt cache 整段失效（这个项目已经为它调过一次错），而末尾追加只是延长前缀。
      if (!warnedRoundsLeft) {
        const notice = roundsLeftNotice(maxRounds - round, maxRounds)
        if (notice) {
          warnedRoundsLeft = true
          messages.push({ role: 'user', content: notice, timestamp: Date.now() })
          out.push({ type: 'error', message: notice, recoverable: true })
        }
      }

      // v2.7：计划模式可能在上一轮的方案评审里被批准关掉，system prompt 要跟着变。
      // 放在这里（每轮开头）而不是「批准时改一次」—— 后者一旦漏掉某个分支，
      // 模型会在批准之后仍然收到「你只能只读」的指令，表现为「批准了却不动手」。
      systemPrompt = promptFor(planMode)

      // v2.6 主动压缩：token 与字符双判据，任一越线就压。
      // 放在「取模型之前」而不是「等 provider 报错」—— 溢出报错往往一次就废掉整轮，
      // 而这里的判断在拿到过一次 usage 之后是**有真实数据支撑**的。
      if (compaction.enabled) {
        const p0 = pressureNow()
        if (p0.over) {
          const shrunk = await compactPipeline(compaction.keepRounds)
          if (!shrunk && p0.overTokens && !this.warnedUncompressible) {
            // 压不动了但还没到溢出：只提醒一次，**不终止任务** ——
            // 估算是保守的（0.75 触发），真到不了溢出就白杀掉一个正常任务更糟。
            this.warnedUncompressible = true
            out.push({
              type: 'error',
              message:
                `上下文已占用约 ${p0.tokens.toLocaleString('en-US')} / ${p0.contextWindow.toLocaleString('en-US')} tokens，` +
                '且已无更早的历史可以压缩。继续下去可能触发上下文溢出，建议尽快收尾或新开会话。' +
                (lastSummaryError ? `（摘要未生成：${lastSummaryError}）` : ''),
              recoverable: true
            })
          }
        }
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

        // 请求选项：温度 / 输出上限 / Top P·K / 取消信号。
        // 逐档可配的项一律走这里下发，避免「设置页能改但请求不带」的死开关；
        // 但**采样参数要先看这一档模型接不接受** —— Kimi K3、Claude 5 这类新模型
        // 对 temperature / top_p 传非默认值会直接 400，无条件下发等于把请求打死。
        const context = { systemPrompt, messages, tools }
        // v2.6：记下这次请求真实发出去的字符数 —— provider 回来的 usage 是**这一次**的，
        // 用它除以这个字符数就是这一档模型在这类内容上的真实换算比（校准）。
        const requestChars = estimateChars(messages) + systemPrompt.length
        const samplingFields =
          capability.sampling
            ? {
                temperature: profile.temperature,
                ...(profile.topP !== null || profile.topK !== null ? { samplingParams } : {})
              }
            : {}
        const baseOptions = {
          apiKey: this.options.apiKey,
          maxTokens: profile.maxOutputTokens,
          ...samplingFields,
          signal: input.signal
        }
        // 思考模式（逐模型能力不同）：
        // - 模型不提供思考参数（none）→ 走原始路径，一个字都不发；
        // - 'auto' → 也走原始路径，完全跟随服务商默认；
        // - 其余走 streamSimple：只有它会把中立档位翻译成各家自己的字段
        //   （reasoning_effort / enable_thinking / thinking / output_config.effort …）。
        //   强制思考的模型（always）不会拿到 off —— 归一化阶段已把 off 收敛成 on。
        const useSimple = profile.thinking !== 'auto' && capability.thinking !== 'none'
        const evStream = useSimple
          ? handle.models.streamSimple(model, context, {
              ...baseOptions,
              ...(profile.thinking === 'on' ? { reasoning: profile.reasoningEffort } : {})
            })
          : handle.models.stream(model, context, baseOptions)

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
          // v2.6：拿真实 usage 校准，并把这一轮的真实占用告诉界面。
          // promptTokensOf 必须补上 cacheRead/cacheWrite（pi 的 input 已扣掉缓存命中部分），
          // 否则长会话里命中缓存时会被严重低估，压缩永远不触发。
          const measured = promptTokensOf(finalMessage.usage)
          if (measured !== null && requestChars > 0) {
            calibration = { chars: requestChars, tokens: measured }
          }
          const pUsage = pressureNow()
          const promptTokens = measured ?? pUsage.tokens
          // v2.28：缓存分项单独下发。promptTokens 是三者的和，而命中部分通常按
          // 0.1 倍计价 —— 不拆开，用户无法判断账单大头是「全价输入」还是「输出」。
          const cacheRead = Math.max(0, Math.round(finalMessage.usage?.cacheRead ?? 0))
          const cacheWrite = Math.max(0, Math.round(finalMessage.usage?.cacheWrite ?? 0))
          const freshInput = Math.max(0, Math.round(finalMessage.usage?.input ?? 0))
          out.push({
            type: 'usage',
            promptTokens,
            outputTokens: Math.max(0, Math.round(finalMessage.usage?.output ?? 0)),
            contextWindow,
            ratio: promptTokens / Math.max(1, contextWindow),
            measured: measured !== null,
            ...(measured !== null
              ? {
                  cacheReadTokens: cacheRead,
                  cacheWriteTokens: cacheWrite,
                  freshInputTokens: freshInput
                }
              : {})
          })
          break
        }

        if (input.signal.aborted || failed?.stopReason === 'aborted') {
          this.finish(out, 'aborted')
          return
        }

        // 1) 上下文溢出：先压缩再重试。**不消耗重试预算** —— 这不是 provider 的临时故障，
        //    是本地把上下文撑爆了，退避等待只会白等。
        if (compaction.enabled && !overflowRetried && failed && isOverflowFailure(failed, contextWindow)) {
          overflowRetried = true
          // 溢出时保留窗口收到最紧（2 轮）：已经确定撑爆了，没有慢慢来的余地
          const shrunk = await compactPipeline(2)
          if (!shrunk) {
            out.push({
              type: 'error',
              message:
                explainFailure(failed, contextWindow) +
                ' —— 已无历史内容可压缩，请新开一个会话，或让工具单次输出更少。' +
                (lastSummaryError ? `（摘要未生成：${lastSummaryError}）` : ''),
              recoverable: false
            })
            this.finish(out, 'failed')
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
              this.finish(out, 'aborted')
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
        this.finish(out, 'failed')
        return
      }

      if (!finalMessage) {
        out.push({ type: 'error', message: '模型请求失败（未收到任何事件）', recoverable: true })
        this.finish(out, 'failed')
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
        // v2.7 计划模式：只读探索结束、方案已产出 → 就地评审一次。
        // 不复用「结束这一轮、让用户再发一条消息」是因为那会丢掉整轮的现场
        // （已连上的设备、已采集的回显、已建的快照），用户批准后还得从头再查一遍。
        if (planMode) {
          const plan = acc.text.trim()
          const roundsUsed = round + 1
          const decision = await this.askQuestions(
            [
              {
                id: PLAN_REVIEW_QUESTION_ID,
                header: '方案评审',
                question:
                  '以上方案是否批准执行？批准后我会按方案开始改动设备（写操作仍会逐次经过危险操作闸门）。' +
                  '若要点修改意见，直接在下方的输入框里写。',
                options: buildPlanReviewOptions()
              }
            ],
            'plan',
            input.signal,
            out
          )
          if (!input.signal.aborted && decision) {
            const answer = (decision[PLAN_REVIEW_QUESTION_ID] ?? '').trim()
            if (answer === PLAN_APPROVE) {
              planMode = false
              // 探索消耗的轮次不该挤占执行预算 —— 否则一个复杂方案的探索会把
              // maxRounds 用光，批准后一动手就撞「已达最大轮次」。
              maxRounds += roundsUsed
              // 预算补回了，收尾提醒要重新武装（否则补回后再接近用尽也不会提醒）
              warnedRoundsLeft = false
              out.push({ type: 'plan_reviewed', action: 'approved', rounds: roundsUsed })
              messages.push({
                role: 'user',
                content:
                  `用户已批准下列方案，请开始按它执行。执行过程中若发现方案与设备实际不符，先说明再调整：\n\n${plan}`,
                timestamp: Date.now()
              })
              // v2.14：用户回话 = 新上下文，重复链重置
              repeatChain = EMPTY_REPEAT_CHAIN
              continue
            }
            if (answer && answer !== PLAN_STOP) {
              // 其余情况（点「继续完善方案」或直接写了一段话）都当修改意见，继续留在计划模式
              out.push({ type: 'plan_reviewed', action: 'revising', rounds: roundsUsed })
              messages.push({
                role: 'user',
                content: `用户对方案提出修改意见，请继续做必要的只读探索并给出修订后的方案：\n\n${answer}`,
                timestamp: Date.now()
              })
              // v2.14：同上 —— 用户回话即新上下文
              repeatChain = EMPTY_REPEAT_CHAIN
              continue
            }
          }
          // 等待评审期间点了「停止」：如实报中止，不能落到下面的 completed
          if (input.signal.aborted) {
            this.finish(out, 'aborted')
            return
          }
          // 不执行 / 取消 → 如实收尾（方案文本已经落在会话里，随时可回看）
          out.push({ type: 'plan_reviewed', action: 'stopped', rounds: roundsUsed })
        }
        this.finish(out, 'completed')
        return
      }

      // v2.5：跨设备只读并行。
      // 并发资格由工具自己声明（ToolSpec.concurrencySafe），调度规则在
      // shared/concurrency.ts —— 只有**连续的一段**只读调用会并行，任何写操作都是屏障，
      // 因此「写 → 读」的可见性语义与全串行时完全一致。
      const maxParallel = maxParallelOf(settings)
      const scheduled = acc.toolCalls.map((call) => {
        const spec = toolMap.get(call.name)
        const deviceKey = scheduleKeyOf(spec?.scope ?? 'device', call.args, call.id)
        return { id: call.id, call, deviceKey, parallelSafe: isParallelSafe(spec, deviceKey) }
      })
      const executed = new Map<string, ToolRunResult>()

      for (const batch of planToolBatches(scheduled, { maxParallel })) {
        if (input.signal.aborted) {
          this.finish(out, 'aborted')
          return
        }
        if (batch.kind === 'serial') {
          for (const item of batch.items) {
            if (input.signal.aborted) {
              this.finish(out, 'aborted')
              return
            }
            executed.set(item.call.id, await this.runToolCall(item.call, toolMap, ctx, out, { planMode }))
          }
          continue
        }
        // 并行批次：先把这一批的 tool_start 一次性播出去 ——
        // 界面立刻看到「这一批同时在跑」，而不是等某台设备先回才冒出来一条。
        for (const item of batch.items) this.announceToolStart(item.call, toolMap, out)
        await runGroupedBounded(
          batch.items,
          (item) => item.deviceKey,
          maxParallel,
          async (item) => {
            executed.set(
              item.call.id,
              await this.runToolCall(item.call, toolMap, ctx, out, { startAnnounced: true, planMode })
            )
          },
          input.signal
        )
      }

      if (input.signal.aborted) {
        this.finish(out, 'aborted')
        return
      }

      // transcript 必须按**模型给出的调用顺序**写：provider 会拿 assistant 消息里的
      // toolCalls 顺序去校验工具结果配对，按完成先后写会直接 400。
      // 并发批次里 tool_end 的到达顺序是不确定的，这里靠 original order 归一。
      for (const call of acc.toolCalls) {
        const result = executed.get(call.id)
        if (!result) continue
        // v1.7：单条结果先做长度截断再进 transcript —— eNSP 的 display 类命令
        // 一条就能几十万字符，单条不截断的话「压缩」永远追不上它撑爆上下文的速度。
        // 界面上（tool_end.raw）仍是完整输出，截断只发生在给模型看的那一份。
        // v2.14：超预算时先把**完整输出归档**再截断，模型由此拿回中段（见 modelPayloadFor）。
        const payload = compaction.enabled
          ? await this.modelPayloadFor(result, call, compaction.toolResultMaxChars, input.rootId ?? null)
          : JSON.stringify(result)
        // v2.22（F17）：工具结果里带 `data.image` 就要把那张图附上去（通用约定，
        // 运行时不认识具体工具名）。图片**不进 payload**：payload 会被压缩/截断/
        // 溢出归档，base64 塞进去会把它们全部拖垮。读失败时补一条文字说明 ——
        // 否则模型只知道「工具成功了」却看不到图，会反复重试同一个调用。
        const content: Array<TextContent | ImageContent> = [
          { type: 'text', text: payload }
        ]
        const ref = toolImageRef(result)
        if (ref && modelSeesImages) {
          content.push(await this.readToolImage(ref, call.id))
        }
        messages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content,
          isError: !result.ok,
          timestamp: Date.now()
        })
      }

      // v2.7 / v2.28：清单被改过就刷新界面，并把最新清单**追加到本轮最后一个
      // 工具结果**里（而不是改 system prompt —— 见 drive() 里 v2.28 的说明）。
      // 必须排在上面的写入循环之后：注入点是「本条轮次的最后一条消息」，
      // 与重复调用防护的注入口径一致（追加到末尾 = 只延长前缀，不破结构）。
      if (
        todosReady &&
        acc.toolCalls.some((c) => c.name === 'todo_write' && executed.get(c.id)?.ok)
      ) {
        const todos = readTodos()
        const tail = messages[messages.length - 1]
        if (tail) appendTextToMessage(tail, buildTodoPromptBlock(todos))
        out.push({
          type: 'todo_update',
          todos,
          detail: describeTodos(todos),
          ownerId: todoOwnerId
        })
      }

      // —— v2.14：重复调用防护 ——
      // 两个都必须照做的约束：
      // ① 必须在上面那个循环**之后**取结果 —— 用 `acc.toolCalls` 而不是 `executed`：
      //    被计划模式拦下、被闸门拒绝的调用同样计数，死磕一个被拒的调用正是最该打断的循环；
      //    遍历顺序与写 transcript 一致（模型给出的调用顺序），同一轮里连发多次也计入。
      // ② **不另发一条 user 消息**，而是追加到本轮回显的末尾。因为
      //    `runtime-policy.ts#roundStarts` 把「任何 user 消息」当作一个轮次起点，
      //    而压缩的保留窗口按轮计算 —— 单独插一条 user 消息会把刚跑完的那一轮
      //    挤出保留窗口（v26-tokens 用例正守着这条不变量），也会让「首轮原文保留」
      //    的判定跟着漂。追加到回显末尾则不改角色序列：配对、轮次划分、压缩语义全不变。
      if (repeatGuardEnabled) {
        const notices: string[] = []
        for (const call of acc.toolCalls) {
          const observed = observeToolCall(repeatChain, call.name, call.args)
          repeatChain = observed.chain
          if (observed.notice) notices.push(observed.notice)
        }
        if (notices.length > 0) {
          const block = notices.join('\n\n')
          const tail = messages[messages.length - 1]
          if (tail && tail.role === 'toolResult' && Array.isArray(tail.content)) {
            const first = tail.content[0]
            if (first && first.type === 'text') {
              tail.content[0] = { type: 'text', text: `${first.text}\n\n${block}` }
            } else {
              tail.content.push({ type: 'text', text: block })
            }
          }
          // 与轮次预算提醒同一出口：界面需要看见「为什么模型突然换了做法」
          for (const notice of notices) {
            out.push({ type: 'error', message: notice, recoverable: true })
          }
        }
      }
    }

    out.push({
      type: 'error',
      message: `已达到最大轮次（${maxRounds}）仍未完成任务，任务终止。已完成的操作保留在现场。`,
      recoverable: true
    })
    this.finish(out, 'failed')
  }

  private buildContext(
    input: RunInput,
    signal: AbortSignal,
    out: EventStream<AgentEvent>
  ): ToolContext {
    const base = this.deps.buildContext(signal)
    return {
      ...base,
      signal,
      // v2.7：提问与清单的唯一出口 —— 工具层不直接依赖运行时，只依赖这两个回调/存储
      askUser: (req) => this.askQuestions(req.questions, req.source, signal, out),
      ...(this.deps.todos ? { todos: this.deps.todos } : {}),
      ...(input.rootId ? { todoOwnerId: input.rootId } : {}),
      /*
       * v2.28：命令级危险清单的放行资格 —— **只有本出口**（应用内代理，有确认框 UI，
       * 且用户在设置里显式关掉了它）才给。对外 MCP 出口的 requestGate 恒为 false，
       * 它走 base 的缺省值 false，命令级清单照拦（见 ToolContext.commandGateRelease）。
       */
      commandGateRelease: this.options.allowDangerousWithGate === false,
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

  /**
   * v2.14：把一次工具结果渲染成「给模型看的那一份」。
   *
   * - 未超预算 → 原样返回，与 v2.13 逐字节一致；
   * - 超预算 → 先把**完整输出**归档（宿主注入的 `spill`），再把
   *   「head + 定位符 + tail」交给模型，中段用 `read_attachment` 按行读回；
   * - 归档不可用 / 失败 → 退回旧的「换个命令重取」文案（**绝不**给出读不回来的路径）。
   *
   * 归档文本走 `renderSpillDump` 而不是 `JSON.stringify`：后者会把回显里的换行
   * 全部转义，把几十行配置压成**一整行**，而 `read_attachment` 是按行分页的 ——
   * 那种文件翻页永远翻不到中段（详见 shared/spill.ts 的头注释）。
   */
  private async modelPayloadFor(
    result: ToolRunResult,
    call: CollectedToolCall,
    maxChars: number,
    rootId: string | null
  ): Promise<string> {
    const serialized = JSON.stringify(result)
    if (maxChars <= 0 || serialized.length <= maxChars) return serialized
    const spill = this.deps.spill
    if (spill && rootId) {
      const dump = renderSpillDump(result, {
        toolName: call.name,
        callId: call.id,
        at: Date.now()
      })
      const path = await spill({ rootId, callId: call.id, toolName: call.name, text: dump })
      if (path) {
        return truncateToolResult(dump, maxChars, (info) =>
          spillLocatorNotice(path, info.totalChars, info.omittedChars)
        ).text
      }
    }
    return truncateToolResult(serialized, maxChars).text
  }

  /**
   * v2.22（F17）：把本轮的图片附件读成模型可用的图片块。
   *
   * 与 `modelPayloadFor` 的分工：那一个管「文本太长怎么办」，这一个管
   * 「图片怎么进去」。两者都在**送模型的那一份**上工作 —— 会话树里仍然只落
   * 附件清单（见 `services.withAttachmentNote`），base64 永不落盘：
   * 一张 2MB 的截图 base64 后 2.7MB，而 jsonl 在重命名/收尾/书签时会**整份重写**。
   *
   * 四类结果都要有交代（缺一类就会出现「提示词说附上了、实际没附」的静默谎言）：
   * ① 模型看不到图 → 由 `planUserImages` 判定，全部标为「没附上 + 原因」；
   * ② 出口不支持读图 → 明确写出「当前出口不支持」；
   * ③ 读了但失败 → 用宿主给的具体原因（超限/格式/损坏）；
   * ④ 读了但宿主没回报 → 标为「没有返回结果」，绝不当作成功。
   */
  private async composeUserContentFor(
    text: string,
    attachments: readonly Attachment[],
    profile: ModelProfile
  ): Promise<ReturnType<typeof composeUserContent>> {
    const plan = planUserImages(attachments, profile)
    const blocked = new Map<string, string>()
    for (const b of plan.blocked) blocked.set(b.attachment.id, b.reason)

    const attached: ResolvedImage[] = []
    if (plan.images.length > 0) {
      if (!this.deps.readImageParts) {
        for (const a of plan.images) {
          blocked.set(a.id, '当前出口不支持读取图片（外部 MCP 出口没有附件读取能力）')
        }
      } else {
        const reqs: ImageRequestRef[] = plan.images.map((a) => ({ id: a.id, path: a.path }))
        let results: ImagePartResult[] = []
        try {
          results = await this.deps.readImageParts(reqs)
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          results = reqs.map((r) => ({ id: r.id, ok: false, error: reason }))
        }
        for (const r of results) {
          if (r.ok && typeof r.data === 'string' && r.data.length > 0 && r.mimeType) {
            attached.push({ mimeType: r.mimeType, data: r.data })
          } else {
            blocked.set(r.id, r.error ?? '图片读取失败')
          }
        }
        for (const req of reqs) {
          if (!results.some((r) => r.id === req.id)) blocked.set(req.id, '图片读取没有返回结果')
        }
      }
    }

    const block = composeUserMessage(text, attachments, {
      images: { modelCanSee: plan.modelCanSee, blocked }
    })
    return composeUserContent(block, attached)
  }

  /**
   * v2.22（F17）：读一张「工具结果里自带的图」，作为 `toolResult` 的图片块。
   *
   * 失败**必须**返回一条文字块而不是省略：省略会让模型看到「工具调用成功了、
   * 内容却什么都没有」——它会把这个当成回显异常并再调一次，形成重复调用环。
   * 写明原因（超限 / 格式 / 读取失败）它才知道该换一条路。
   */
  private async readToolImage(ref: ToolImageRef, id: string): Promise<TextContent | ImageContent> {
    const reader = this.deps.readImageParts
    const label = ref.name ?? ref.path
    if (!reader) {
      return { type: 'text', text: `（图片「${label}」没有附上：当前出口不支持读取图片）` }
    }
    let results: ImagePartResult[] = []
    try {
      results = await reader([{ id, path: ref.path }])
    } catch (e) {
      return {
        type: 'text',
        text: `（图片「${label}」没有附上：${e instanceof Error ? e.message : String(e)}）`
      }
    }
    const got = results.find((r) => r.id === id)
    if (got?.ok && typeof got.data === 'string' && got.data.length > 0 && got.mimeType) {
      return { type: 'image', mimeType: got.mimeType, data: got.data }
    }
    return { type: 'text', text: `（图片「${label}」没有附上：${got?.error ?? '读取没有返回结果'}）` }
  }

  /**
   * 发一次**摘要专用**的模型请求（L3，v2.6），返回摘要正文。
   *
   * 为什么复用同一个模型句柄而不是另配一个小模型：用户只配了一档模型的密钥，
   * 悄悄换模型会出现「摘要用了一个没配 Key 的端点」这类凭据事故。
   * 输出上限压到 `SUMMARY_MAX_TOKENS`，不让压缩本身变成一个昂贵的请求。
   *
   * 刻意**不走** retry 分类器：这条路失败只需降级到本地修剪，
   * 为它引入退避重试会让「压缩」在最需要它的时候多等好几秒。
   */
  private async runSummaryRequest(
    handle: LLMHandle,
    model: ResolvedModel,
    body: string,
    signal: AbortSignal
  ): Promise<string> {
    return this.runAuxiliaryTextRequest(
      handle,
      model,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        userMessage: buildSummaryUserMessage(body),
        maxTokens: SUMMARY_MAX_TOKENS
      },
      signal
    )
  }

  /**
   * 发一次**纯文本**辅助请求（摘要 / 会话标题共用）。
   *
   * 抽这一层是因为两者是一模一样的调用形态（独立 system、无工具、单条 user、
   * 只要文本流），差别只在提示词与输出上限。写成两份就是两份会漂移的知识 ——
   * 比如以后想给它们都加超时，改一处忘一处的后果是「标题会挂住、摘要不会」。
   */
  private async runAuxiliaryTextRequest(
    handle: LLMHandle,
    model: ResolvedModel,
    req: { systemPrompt: string; userMessage: string; maxTokens: number },
    signal: AbortSignal
  ): Promise<string> {
    const stream = handle.models.stream(
      model,
      {
        systemPrompt: req.systemPrompt,
        messages: [{ role: 'user', content: req.userMessage, timestamp: Date.now() }],
        // 不带工具：辅助请求必须是一次纯文本往返，不能又触发工具调用
        tools: []
      },
      { apiKey: this.options.apiKey, maxTokens: req.maxTokens, signal }
    )
    let text = ''
    for await (const ev of stream) {
      if (ev.type === 'text_delta') text += ev.delta
    }
    return text
  }

  /**
   * v2.8：生成会话标题（一次独立的小请求）。
   *
   * 触发口径：
   * - 只在**任务成功收尾之后**发 —— 任务失败时模型给出的标题往往只是
   *   「某实验失败排查」，那是个一次性事件，不该成为会话的长期名字；
   * - 只在「还欠一个 AI 标题」时发（`needsAutoTitle`）：标题没被用户钉住、
   *   且 AI 尚未成功起过名。v2.15 起不再限定首轮 —— 首轮任务失败/被中止的
   *   会话，会在之后成功收尾的轮次补起；
   * - 只在设置了打开时发。
   *
   * 失败一律**静默降级**为兜底标题（首条指令截断）：标题只是体验，绝不能
   * 因为一次辅助请求失败而影响用户真正关心的任务结果。
   */
  private async generateTitle(
    handle: LLMHandle,
    model: ResolvedModel,
    input: RunInput,
    out: EventStream<AgentEvent>,
    signal: AbortSignal
  ): Promise<void> {
    const rootId = input.rootId
    const tree = this.deps.sessionTree
    if (!rootId || !tree) return
    if (signal.aborted) return
    if (!tree.needsAutoTitle(rootId)) return

    const settings = this.deps.getSettings()
    if (!settings.title.enabled) return

    // 兜底标题与概括素材都取**首条用户消息**（与建会话时的初始标题同源）：
    // 补起可能发生在第 N 轮，用本轮指令起名会跑题；当前指令一并附上，
    // 让模型对「这次会话整体在做什么」有最新语境。
    const firstUserText =
      tree
        .getTree(rootId)
        .find((n) => n.role === 'user')
        ?.content?.trim() || input.text
    const fallback = fallbackTitle(firstUserText, 60)
    const sourceTexts = [firstUserText, input.text]

    // v2.15：title_updated 的双通道发出。收尾钩子是 fire-and-forget，跑到这里
    // 时本轮事件流**几乎必然已 close()**（done 之后 run() 立刻关流），push 进
    // closed 流会被 EventStream 静默丢弃 —— 必须经宿主注入的 emitEvent 直发，
    // 界面才能在当轮看到新标题（旧实现只 push，标题要重启应用才可见）。
    const emit = (title: string): void => {
      const ev: AgentEvent = { type: 'title_updated', rootId, title, source: 'auto' }
      out.push(ev)
      this.deps.emitEvent?.(ev)
    }

    // 超时保护：辅助请求不能拖住整轮任务（用 abort 组合信号）
    const timeout = settings.title.timeoutMs
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ctl.abort(), timeout)

    try {
      const raw = await this.runAuxiliaryTextRequest(
        handle,
        model,
        {
          systemPrompt: titleSystemPrompt(settings.title.targetChars),
          userMessage: buildTitleUserMessage(sourceTexts),
          maxTokens: TITLE_MAX_TOKENS
        },
        ctl.signal
      )
      const candidate = normalizeTitle(raw)
      if (isUsefulTitle(candidate, fallback)) {
        // aiTitled=true：只有模型真的给出了可用标题才终结重试 ——
        // 兜底截断不算，后续成功收尾的轮次还能补起一个真正的 AI 标题。
        if (tree.setAutoTitle(rootId, candidate, true)) {
          emit(candidate)
        }
        return
      }
      // 模型没给出可用标题（空 / 纯符号 / 只是复述）→ 用兜底
      if (fallback && tree.setAutoTitle(rootId, fallback)) {
        emit(fallback)
      }
    } catch (e) {
      // 超时 / 网络 / 模型拒答：静默降级到兜底标题。
      // 不 push error 事件 —— 会话末尾冒出一句红色「标题生成失败」只会让人困惑，
      // 用户根本没要求 AI 起名，那是我们自己加的锦上添花。
      void e
      if (fallback && tree.setAutoTitle(rootId, fallback)) {
        emit(fallback)
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 发起一次结构化提问并等待答案（v2.7）。
   *
   * 与 `requestGate` 同构，包括两条必须照抄的约定：
   * 1. **已中止就不发卡片** —— 否则「批准 Promise 永不 resolve」会让 drive 挂死、流永不关闭；
   * 2. **监听 abort** —— 用户等答案期间点「停止」必须立刻生效，而不是卡到超时。
   *
   * 返回 null = 取消（用户关掉卡片 / 任务中止），调用方应退回「按最合理假设继续」。
   */
  private async askQuestions(
    questions: QuestionItem[],
    source: 'tool' | 'plan',
    signal: AbortSignal,
    out: EventStream<AgentEvent>
  ): Promise<QuestionAnswers | null> {
    if (signal.aborted) return null
    const questionId = randomUUID()
    const answered = new Promise<QuestionAnswers | null>((resolve) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(null)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.questions.set(questionId, (a) => {
        signal.removeEventListener('abort', onAbort)
        resolve(a)
      })
    })
    out.push({ type: 'question_request', questionId, questions, source })
    const answers = await answered
    this.questions.delete(questionId)
    out.push({
      type: 'question_resolved',
      questionId,
      answers: answers ?? {},
      source,
      ...(answers === null ? { cancelled: true } : {})
    })
    return answers
  }

  /**
   * 播出一条 tool_start（v2.5：从 runToolCall 里抽出来，供并行批次「先整批宣布、再执行」用）。
   * 未知工具也照播，参数原样透传 —— 让界面先出现这一条，再由 tool_end 说明它不存在。
   */
  private announceToolStart(
    call: CollectedToolCall,
    toolMap: Map<string, ToolSpec>,
    out: EventStream<AgentEvent>,
    parallel = false
  ): void {
    const spec = toolMap.get(call.name)
    out.push({
      type: 'tool_start',
      callId: call.id,
      name: spec?.name ?? call.name,
      args: call.args,
      risk: spec?.risk ?? 'read',
      ...(parallel ? { parallel: true } : {})
    })
  }

  /**
   * 一次工具调用的执行（F，v2.14 重构；阶段划分取自 dsh 的 tool-execution-pipeline）。
   *
   * 拆开的理由：原实现把「政策判定（计划模式 / 危险闸门）、执行、异常归一、事件播报」
   * 四件事塞在一个函数里，代价是 `tool_start` 在**三个分支里各播一遍** —— 改一处很容易
   * 漏掉另外两处，而「政策」与「执行」也没法分别审视。
   *
   * 阶段顺序是**语义，不是风格**：
   *   announce（唯一播 tool_start 的地方）
   *     → preExecute（政策判定；可能 **await 用户批准**，所以必须在 announce 之后 ——
   *       否则用户看到的是一张没有对应工具条目的闸门卡）
   *       → aroundExecute（真正调 handler + 异常归一；超时也在这一层）
   *         → emitToolEnd（唯一播 tool_end 的地方）
   */
  private async runToolCall(
    call: CollectedToolCall,
    toolMap: Map<string, ToolSpec>,
    ctx: ToolContext,
    out: EventStream<AgentEvent>,
    opts?: { startAnnounced?: boolean; planMode?: boolean }
  ): Promise<ToolRunResult> {
    if (!opts?.startAnnounced) this.announceToolStart(call, toolMap, out)
    const startedAt = Date.now()

    const decision = await this.preExecute(call, toolMap, ctx, {
      planMode: opts?.planMode === true,
      startedAt
    })
    if (decision.kind === 'reject') {
      this.emitToolEnd(out, call.id, decision.result, decision.summary, decision.ms, decision.errorCode)
      return decision.result
    }

    const outcome = await this.aroundExecute(decision.spec, decision.args, ctx, startedAt)
    let summary: string
    if (outcome.thrown !== undefined) {
      summary = `工具抛出异常：${outcome.thrown}`
    } else {
      summary = summarizeToolCall(decision.spec, decision.args, outcome.result, decision.spec.name)
      if (decision.skipConfirm) summary += '（确认框已关闭，按策略跳过确认）'
      // v2.28：命令级清单被策略放行时同样留痕 —— 与工具级闸门是两层，
      // 各自松开都要能从轨迹里看出来（不然「关了开关到底放行了哪一层」无从回答）。
      if (commandGateSkipped(outcome.result)) summary += COMMAND_GATE_SKIPPED_NOTE
    }
    const code = outcome.result.error?.code
    // H（v2.14）：可回放卡片数据。求值放在这里（而不是让界面自己算）——
    // 工具层才知道「这次结果里哪几个字段是卡片需要的」，且回放时也要用同一份。
    this.emitToolEnd(
      out,
      call.id,
      outcome.result,
      summary,
      Date.now() - startedAt,
      code ? String(code) : undefined,
      cardMetaOf(decision.spec, decision.args, outcome.result)
    )
    return outcome.result
  }

  /**
   * 执行前政策判定：计划模式硬拒绝、未知工具、危险闸门。
   *
   * 全部在 handler 执行**之前**发生，且**不播任何事件** —— 事件只由调用方播，
   * 这样「播报」就不会随分支数量增长。
   */
  private async preExecute(
    call: CollectedToolCall,
    toolMap: Map<string, ToolSpec>,
    ctx: ToolContext,
    opts: { planMode: boolean; startedAt: number }
  ): Promise<PreExecuteDecision> {
    const spec = toolMap.get(call.name)
    // pi-ai 已把工具参数流式解析成对象；若非对象也直接透传，交给 handler 自检
    const args: unknown = call.args

    // v2.7 计划模式：写操作在 handler 执行之前就被拒绝 —— 与危险闸门同一位置、
    // 同样不依赖提示词。判定在 shared/plan-mode.ts（纯函数，有对应用例）。
    const planDecision = planModeToolDecision({
      planMode: opts.planMode,
      risk: spec?.risk ?? 'read',
      toolName: spec?.name ?? call.name
    })
    if (planDecision.kind === 'block') {
      return {
        kind: 'reject',
        result: failResult(PLAN_MODE_BLOCK_CODE, planDecision.reason ?? '', 0),
        summary: '计划模式：已阻止写操作，请先把它写进方案等待批准',
        ms: 0,
        errorCode: PLAN_MODE_BLOCK_CODE
      }
    }

    if (!spec) {
      const message = `未知工具：${call.name}`
      // 刻意**不带** errorCode：摘要已经写明「未知工具」，再挂一个 `· UNKNOWN`
      // 只是噪音（这是本函数里唯一「事件不带 errorCode」的分支，原实现即如此）
      return {
        kind: 'reject',
        result: failResult('UNKNOWN', message, 0),
        summary: message,
        ms: 0
      }
    }

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
      return {
        kind: 'reject',
        result: failResult('GATE_REJECTED', gatePlan.reason, Date.now() - opts.startedAt),
        summary: gatePlan.summary,
        ms: Date.now() - opts.startedAt,
        errorCode: 'GATE_REJECTED'
      }
    }
    if (gatePlan.kind === 'ask') {
      const approved = await ctx.requestGate({
        toolName: spec.name,
        args,
        reason: `工具 ${spec.name} 标记为危险操作`,
        consequence: '该操作不可撤销，可能造成设备配置或数据丢失。'
      })
      if (!approved) {
        // 措辞必须同时覆盖「用户点了拒绝」与「任务已中止 / 出口无闸门」两种来源，
        // 否则轨迹里会出现与事实不符的"用户拒绝"（R3）。
        return {
          kind: 'reject',
          result: failResult('GATE_REJECTED', GATE_DENIED_REASON, Date.now() - opts.startedAt),
          summary: GATE_DENIED_SUMMARY,
          ms: Date.now() - opts.startedAt,
          errorCode: 'GATE_REJECTED'
        }
      }
    }

    return {
      kind: 'run',
      spec,
      args,
      skipConfirm: gatePlan.kind === 'skip-confirm'
    }
  }

  /**
   * 真正调用 handler，并把**抛出的异常**归一成 `ToolRunResult`。
   *
   * 归一在这里而不是在调用方：轨迹里 `工具抛出异常：…` 的文案与 `ok:false` 的
   * 结果必须一一对应，分两处写迟早会漂移。
   */
  private async aroundExecute(
    spec: ToolSpec,
    args: unknown,
    ctx: ToolContext,
    startedAt: number
  ): Promise<{ result: ToolRunResult; thrown?: string }> {
    try {
      return { result: await spec.handler(args as never, ctx) }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { result: failResult('UNKNOWN', message, Date.now() - startedAt), thrown: message }
    }
  }

  /**
   * 播出一条 `tool_end`（唯一出口）。
   *
   * `errorCode` 由调用方显式给出而不是从 result 里取：唯一例外是「未知工具」，
   * 那一支刻意不发码（见 preExecute 的说明）。
   */
  private emitToolEnd(
    out: EventStream<AgentEvent>,
    callId: string,
    result: ToolRunResult,
    summary: string,
    ms: number,
    errorCode?: string,
    cardMeta?: unknown
  ): void {
    const payload = smallToolData(result)
    out.push({
      type: 'tool_end',
      callId,
      ok: result.ok,
      ms,
      summary,
      ...(result.error?.raw ? { raw: result.error.raw } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(payload !== undefined ? { data: payload } : {}),
      ...(cardMeta !== undefined ? { cardMeta } : {})
    })
  }
}

/**
 * v2.28：把一段文本追加到消息内容的末尾。
 *
 * 内容有两种形态（`composeUserContent` 在带图时给 parts 数组、否则给字符串；
 * 工具结果的 content 恒为 parts 数组），两种都要能接 —— 只处理其中一种，
 * 另一种会静默丢掉整段文本，现象是「清单更新了但模型看不到」。
 *
 * 为什么需要这个动作：注入点是 transcript 的**末尾**而不是 system prompt。
 * system prompt 是服务端 prompt cache 的第一个前缀，逐字改变会让后面整段
 * transcript 按全价重算（见 drive() 里 v2.28 的说明）。
 */
function appendTextToMessage(message: Message, text: string): void {
  if (!text) return
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') {
    ;(message as { content?: string }).content = content ? `${content}\n\n${text}` : text
    return
  }
  if (Array.isArray(content)) {
    content.push({ type: 'text', text })
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
 * assistant 用最小合法 AssistantMessage 重建；
 * v2.2：thinking 节点是界面回溯用的展示内容，刻意**不回放**给模型 ——
 * 它是模型的中间推理，重放既占上下文又可能让它重复自己的旧思路。
 */
export function historyToMessages(history: readonly SessionNode[]): Message[] {
  const out: Message[] = []
  for (const n of history) {
    if (n.role === 'thinking') {
      continue
    } else if (n.role === 'user') {
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
      // v2.8：带上落盘的摘要与错误码 —— 断点续跑时模型需要的正是「那次调用看到了什么」。
      // 缺摘要的老会话（v2.8 之前）退化为原样，不因此报错。
      const detail = tc?.summary ? `：${tc.summary}` : ''
      const code = tc?.errorCode ? `（${tc.errorCode}）` : ''
      out.push({
        role: 'user',
        content: `[历史工具调用 ${probe}${code}${detail}]`,
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