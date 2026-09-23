import type { Message } from '@earendil-works/pi-ai'

/**
 * 运行时韧性策略（v1.7）：请求失败重试 + 上下文压缩。
 *
 * 为什么单独立一层：这两件事的**判定逻辑**（什么时候重试、什么时候压缩、压缩成什么样）
 * 必须是纯函数 —— 它们决定一次实验跑不跑得完，不能埋在循环里靠肉眼验证。
 * 循环里只留「调用 + 应用结果」，策略全在这里，可单测。
 *
 * 设计口径（对齐 pi 的 retry/overflow 分类器 + dsh 的「失败必须可解释」）：
 * - **重试**：只重试「临时性」失败（限流、超时、5xx、连接中断）。认证错、模型名错、
 *   额度耗尽这类确定性错误必须立刻失败 —— 重试三次只是让用户多等 3 秒才看到同一个错。
 * - **压缩**：只压缩**内容**，绝不删除消息。理由是可验证的：删消息会破坏
 *   「assistant 工具调用 ↔ toolResult 配对」，也会撞上 Anthropic 的 user/assistant
 *   交替约束；而实际上占体积的从来不是消息条数，是工具输出（`display current-configuration`
 *   一条就能几十万字符）。所以压缩 = 把老轮次的工具输出换成一行摘要，
 *   消息结构（角色、callId、时间戳）原样保留 —— 任何 provider 都不会因此报错。
 */

// ————————————————————— 重试 —————————————————————

export interface RetrySettings {
  enabled: boolean
  /** 最大重试次数（不含首次调用）；0 表示不重试 */
  maxRetries: number
  /** 退避基数：第 n 次重试等待 baseDelayMs * 2^(n-1) */
  baseDelayMs: number
}

/** 单个退避上限：再久就不如让用户重来一次 */
export const MAX_BACKOFF_MS = 30_000

export const DEFAULT_RETRY: RetrySettings = { enabled: true, maxRetries: 2, baseDelayMs: 800 }

export const RETRY_BOUNDS = {
  maxRetries: { min: 0, max: 5 },
  baseDelayMs: { min: 0, max: 10_000 }
} as const

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

export function sanitizeRetry(patch: unknown, base: RetrySettings = DEFAULT_RETRY): RetrySettings {
  const p = (patch ?? {}) as Partial<RetrySettings>
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    maxRetries: clampInt(
      p.maxRetries,
      RETRY_BOUNDS.maxRetries.min,
      RETRY_BOUNDS.maxRetries.max,
      base.maxRetries
    ),
    baseDelayMs: clampInt(
      p.baseDelayMs,
      RETRY_BOUNDS.baseDelayMs.min,
      RETRY_BOUNDS.baseDelayMs.max,
      base.baseDelayMs
    )
  }
}

/**
 * 第 attempt 次重试前的等待时长（attempt 从 1 开始）：指数退避 + 0~25% 正抖动。
 * 抖动是必要的：多个任务同时被同一个 429 打回来时，不该在同一毫秒再次撞上去。
 * `rand` 可注入，测试里给 0 就能断言精确值。
 */
export function backoffDelay(
  attempt: number,
  policy: RetrySettings,
  rand: () => number = Math.random
): number {
  const base = Math.max(0, policy.baseDelayMs)
  const exp = base * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(exp, MAX_BACKOFF_MS)
  return Math.round(capped * (1 + rand() * 0.25))
}

export interface RetryPlan {
  /** 还要不要再试一次 */
  retry: boolean
  /** 第几次重试（1 开始） */
  attempt: number
  delayMs: number
}

/**
 * 决定一次失败是否值得重试。
 * 调用方负责判定「这个失败是不是临时性的」（用 pi 的分类器），这里只管预算与退避。
 */
export function planRetry(
  policy: RetrySettings,
  attemptSoFar: number,
  reason: string,
  rand: () => number = Math.random
): RetryPlan {
  const attempt = attemptSoFar + 1
  if (!policy.enabled || attempt > policy.maxRetries) {
    return { retry: false, attempt, delayMs: 0 }
  }
  void reason
  return { retry: true, attempt, delayMs: backoffDelay(attempt, policy, rand) }
}

// ————————————————————— 上下文压缩 —————————————————————

export interface CompactionSettings {
  enabled: boolean
  /** 单条工具结果的字符上限，超出保头保尾（这是最常见的溢出源） */
  toolResultMaxChars: number
  /** 整个 transcript 的字符预算，超出即压缩老轮次 */
  transcriptMaxChars: number
  /** 压缩时保留最近几轮的原文 */
  keepRounds: number
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  toolResultMaxChars: 12_000,
  transcriptMaxChars: 200_000,
  keepRounds: 4
}

export const COMPACTION_BOUNDS = {
  toolResultMaxChars: { min: 1_000, max: 200_000 },
  transcriptMaxChars: { min: 20_000, max: 2_000_000 },
  keepRounds: { min: 1, max: 20 }
} as const

export function sanitizeCompaction(
  patch: unknown,
  base: CompactionSettings = DEFAULT_COMPACTION
): CompactionSettings {
  const p = (patch ?? {}) as Partial<CompactionSettings>
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    toolResultMaxChars: clampInt(
      p.toolResultMaxChars,
      COMPACTION_BOUNDS.toolResultMaxChars.min,
      COMPACTION_BOUNDS.toolResultMaxChars.max,
      base.toolResultMaxChars
    ),
    transcriptMaxChars: clampInt(
      p.transcriptMaxChars,
      COMPACTION_BOUNDS.transcriptMaxChars.min,
      COMPACTION_BOUNDS.transcriptMaxChars.max,
      base.transcriptMaxChars
    ),
    keepRounds: clampInt(
      p.keepRounds,
      COMPACTION_BOUNDS.keepRounds.min,
      COMPACTION_BOUNDS.keepRounds.max,
      base.keepRounds
    )
  }
}

/** 每条消息的固定开销（role / timestamp / 结构字段）——估算是为了做决策，不追求精确 */
const MESSAGE_OVERHEAD = 32
const PART_OVERHEAD = 16

/** 单条消息折算的字符数：文本按字符数，非文本部分按 JSON 长度兜底 */
export function messageChars(message: Message): number {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.length + MESSAGE_OVERHEAD
  if (Array.isArray(content)) {
    let n = MESSAGE_OVERHEAD
    for (const raw of content) {
      const part = raw as { type?: string; text?: string }
      n += typeof part?.text === 'string' ? part.text.length + PART_OVERHEAD : JSON.stringify(raw).length + PART_OVERHEAD
    }
    return n
  }
  return MESSAGE_OVERHEAD
}

export function estimateChars(messages: readonly Message[]): number {
  let n = 0
  for (const m of messages) n += messageChars(m)
  return n
}

export interface TruncatedText {
  text: string
  truncated: boolean
  originalChars: number
  omittedChars: number
}

/**
 * 单条工具结果截断：保头（60%）+ 保尾（40%），中间给出「省略了多少、怎么拿全」。
 * 保尾很重要 —— eNSP 的命令回显里，结论（接口状态、报错）通常在最后几行。
 */
export function truncateToolResult(text: string, maxChars: number): TruncatedText {
  const originalChars = text.length
  if (maxChars <= 0 || originalChars <= maxChars) {
    return { text, truncated: false, originalChars, omittedChars: 0 }
  }
  const head = Math.max(1, Math.floor(maxChars * 0.6))
  const tail = Math.max(0, maxChars - head)
  const omitted = originalChars - head - tail
  const marker =
    `\n\n…（本条结果共 ${originalChars} 字符，已省略中间 ${omitted} 字符。` +
    '需要完整内容时请用更精确的命令重新获取：加过滤条件、缩小范围，或分段查看。）\n\n'
  return {
    text: text.slice(0, head) + marker + (tail > 0 ? text.slice(originalChars - tail) : ''),
    truncated: true,
    originalChars,
    omittedChars: omitted
  }
}

export interface CompactionOptions {
  maxChars: number
  keepRounds: number
}

export interface CompactionResult {
  messages: Message[]
  applied: boolean
  /** 被改写的消息条数 */
  shrunkMessages: number
  savedChars: number
  /** 被压缩轮次里出现过的工具（名称 → 次数），用于向用户说明「省略了什么」 */
  tools: Array<{ name: string; count: number }>
  beforeChars: number
  afterChars: number
}

/** 每轮从一条 user 消息开始；用户插话也算新一轮（它本来就出现在两次工具调用之间） */
function roundStarts(messages: readonly Message[]): number[] {
  const starts: number[] = []
  messages.forEach((m, i) => {
    if (m.role === 'user') starts.push(i)
  })
  return starts
}

/** 老轮次里的一条 assistant 消息：丢掉思考内容，正文压缩成头 + 尾，工具调用原样保留 */
function shrinkAssistant<T extends Message>(m: T): { next: T; saved: number } {
  const content = (m as { content?: unknown }).content
  if (!Array.isArray(content)) return { next: m, saved: 0 }
  let saved = 0
  const nextParts: unknown[] = []
  for (const raw of content) {
    const part = raw as { type?: string; text?: string }
    if (part?.type === 'thinking') {
      // 思考内容：格式上本就不会被回放，留着纯占体积
      saved += (part.text?.length ?? 0) + PART_OVERHEAD
      continue
    }
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 420) {
      const kept = part.text.slice(0, 300) + `\n…（原文 ${part.text.length} 字符，已压缩）\n` + part.text.slice(-120)
      saved += part.text.length - kept.length
      nextParts.push({ ...part, text: kept })
      continue
    }
    nextParts.push(raw)
  }
  if (nextParts.length === content.length && saved === 0) return { next: m, saved: 0 }
  return { next: { ...m, content: nextParts } as T, saved }
}

/** 老轮次里的一条工具结果：换成一行摘要（保留 callId / isError，配对关系不动） */
function shrinkToolResult<T extends Message>(m: T): { next: T; saved: number } {
  const content = (m as { content?: unknown }).content
  const before = messageChars(m)
  const text = Array.isArray(content)
    ? content
        .map((p) => (p as { text?: string }).text ?? '')
        .join('\n')
    : typeof content === 'string'
      ? content
      : ''
  const toolName = (m as { toolName?: string }).toolName ?? '工具'
  const digest =
    `[已压缩] ${toolName} 的结果（原 ${text.length} 字符）已省略。` +
    '如需其中数据，请重新调用该工具并缩小范围。'
  if (digest.length >= before) return { next: m, saved: 0 }
  return {
    next: { ...m, content: [{ type: 'text', text: digest }] } as T,
    saved: before - (digest.length + MESSAGE_OVERHEAD)
  }
}

/**
 * 上下文压缩：把「最近 keepRounds 轮之外」的**内容**压成摘要，消息一条不删。
 *
 * 三条边界，都是踩过才写下的：
 * 1. **首轮永不压缩** —— 它装着任务描述与附件清单，压掉等于让代理忘了自己要干什么，
 *    而且这种 bug 的现象是「代理突然开始瞎干」，极难反推原因；
 * 2. **用户说的每一句话都保留原文** —— 用户指令是最短也最关键的内容，
 *    压缩它省不下多少字符，却可能把「必须用 /30 掩码」压成「必须用掩码」；
 * 3. **保留窗口不能超过实际轮数** —— 轮数少于 keepRounds 时若直接取
 *    `starts[starts.length - keep]` 会取到 undefined，比较全为 false 后会把整段 transcript
 *    都压掉（一个静默的、方向相反的 bug）。
 */
export function planCompaction(
  messages: readonly Message[],
  opts: CompactionOptions
): CompactionResult {
  const beforeChars = estimateChars(messages)
  const starts = roundStarts(messages)
  const noop = (): CompactionResult => ({
    messages: [...messages],
    applied: false,
    shrunkMessages: 0,
    savedChars: 0,
    tools: [],
    beforeChars,
    afterChars: beforeChars
  })

  if (beforeChars <= opts.maxChars || starts.length < 2) return noop()

  // 首轮永远排除在保留窗口计数之外（它单独保留）
  const keepCount = Math.min(Math.max(1, opts.keepRounds), starts.length - 1)
  const beginIndex = starts[1]!
  const endIndex = starts[starts.length - keepCount]!
  if (beginIndex >= endIndex) return noop()

  const toolCounts = new Map<string, number>()
  let shrunkMessages = 0
  let savedChars = 0

  const next = messages.map((m, i) => {
    // 首轮原文保留；保留窗口内原文保留；用户消息一律原文保留（见上文规则 2）
    if (i < beginIndex || i >= endIndex || m.role === 'user') return m
    let r: { next: Message; saved: number }
    if (m.role === 'toolResult') {
      const name = (m as { toolName?: string }).toolName ?? '工具'
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
      r = shrinkToolResult(m)
    } else if (m.role === 'assistant') {
      r = shrinkAssistant(m)
    } else {
      return m
    }
    if (r.saved > 0) {
      shrunkMessages += 1
      savedChars += r.saved
    }
    return r.next
  })

  if (shrunkMessages === 0) return noop()

  return {
    messages: next,
    applied: true,
    shrunkMessages,
    savedChars,
    tools: [...toolCounts.entries()].map(([name, count]) => ({ name, count })),
    beforeChars,
    afterChars: estimateChars(next)
  }
}

/** 给用户看的一句话说明（事件里直接用，两处文案不重复写） */
export function describeCompaction(r: {
  shrunkMessages: number
  beforeChars: number
  afterChars: number
  tools: Array<{ name: string; count: number }>
}): string {
  const tools = r.tools.length
    ? `省略的工具输出：${r.tools.map((t) => `${t.name}×${t.count}`).join('、')}`
    : '省略的历史内容'
  return `上下文接近上限，已压缩较早的 ${r.shrunkMessages} 条消息（${r.beforeChars} → ${r.afterChars} 字符）：${tools}。任务目标与最近几轮保持原文。`
}
