import type { Message } from '@earendil-works/pi-ai'
import { extractSpillPath, repruneLocatorNotice } from './spill'

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
 * - **压缩**：L2 修剪只压缩**内容**，绝不删除消息。理由是可验证的：删消息会破坏
 *   「assistant 工具调用 ↔ toolResult 配对」，也会撞上 Anthropic 的 user/assistant
 *   交替约束；而实际上占体积的从来不是消息条数，是工具输出（`display current-configuration`
 *   一条就能几十万字符）。所以 L2 = 把老轮次的工具输出换成一行摘要，
 *   消息结构（角色、callId、时间戳）原样保留 —— 任何 provider 都不会因此报错。
 * - **L3 摘要（v2.6）**：把老轮次**整段**换成模型写的结论摘要。它确实会删消息，
 *   但切点严格落在 user 消息边界上，所以配对关系仍然自洽（详见 planSummaryCompaction）。
 *   流水线顺序是「先用原文摘要 → 仍在预算外才本地修剪」—— 反过来会先毁掉原文，
 *   摘要就只能压到一堆「请重新调用」的占位文本。
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
  /**
   * 单条工具结果的字符上限，超出保头保尾（这是最常见的溢出源）。
   *
   * v2.28：默认值从 1.2 万降到 8 千。每条结果都会在**后续每一轮**里重发一次，
   * 所以它的成本是「条数 × 剩余轮数」——长任务里单条少 1/3 会累积成很大的差额。
   * 超预算的部分不会丢：先整份归档到磁盘，再把定位符留给模型（v2.14 的溢出落盘）。
   */
  toolResultMaxChars: number
  /**
   * 整个 transcript 的字符预算，超出即压缩老轮次。**这是与窗口无关的绝对上限**。
   *
   * v2.28：默认值从 80 万降到 20 万。
   *
   * 为什么必须降：token 判据是 `contextWindow × pressureRatio`，而 `contextWindow`
   * 是**用户手填的**。本仓实测到一个真实案例：窗口填 512k，token 判据就要等到
   * 512k × 0.75 = 384k tokens，可字符判据要 80 万字符（≈25 万 tokens，实测更**先**
   * 触发）—— 一次 33 轮的任务最终只涨到 10.8 万 tokens / 约 34.6 万字符，
   * **两条判据一条都没摸到**。结果是上百条工具回显全部原样留在 transcript 里，
   * 每一轮都要重发一遍，该任务累计输入 174 万 tokens。
   *
   * 结论：把预算挂在窗口上等于「窗口填得越大、压缩越不触发、账单越失控」。
   * 20 万字符 ≈ 6.3 万 tokens，是「够模型记住当前在干什么」与「每轮别重发太多」
   * 之间的折中；老的原始回显不会被删 —— 溢出归档仍在磁盘上，可用 read_attachment 取回。
   */
  transcriptMaxChars: number
  /**
   * 压缩时保留最近几轮的原文。
   *
   * v2.9：4 → 8。轮数预算从 12 提到 200 之后，一次实验横跨的轮次多了，
   * 压缩后只剩 4 轮原文太薄（方案评审、验证步骤常常刚过几轮就被摘要掉）。
   */
  keepRounds: number
  /**
   * v2.6：上下文占模型窗口的比例，达到即触发压缩。
   *
   * 与 `transcriptMaxChars` 是**双判据**（任一越线即压缩）：
   * token 判据更准（有真实 usage 校准），字符判据不依赖用户填对窗口。
   * 留出的余量要给「本轮输出 + 本轮工具结果」—— 0.9 以上基本等于等着溢出。
   */
  pressureRatio: number
  /**
   * v2.6：是否用模型生成摘要（L3）。
   *
   * 关掉 = 退回本地修剪（L2）：老工具输出直接被替换成「请重新调用」，
   * 信息不再可恢复但也不多花一次请求。
   */
  summarize: boolean
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  toolResultMaxChars: 8_000,
  transcriptMaxChars: 200_000,
  keepRounds: 8,
  pressureRatio: 0.75,
  summarize: true
}

/**
 * 曾作为**出厂值**发布过、现已废弃的取值。
 *
 * 判据是「恰好等于某个旧出厂值」，不是「比新值大/小」——「只要小于新值就抬」
 * 会把用户主动调小的预算静默改回去（想早点压缩省 token 是完全合理的需求）。
 */
const LEGACY_COMPACTION_VALUES: {
  transcriptMaxChars: readonly number[]
  toolResultMaxChars: readonly number[]
  keepRounds: readonly number[]
} = {
  /** v2.9 的 transcriptMaxChars（在 512k 窗口下永远不会触发，见字段说明） */
  transcriptMaxChars: [800_000],
  /** v1.7~v2.28 的 toolResultMaxChars */
  toolResultMaxChars: [12_000],
  /** v2.9 之前的 keepRounds */
  keepRounds: [4]
}

/**
 * 把仍停在**旧出厂值**上的压缩设置抬到当前默认值。
 *
 * v2.9：20 万 → 80 万字符、保留 4 → 8 轮。
 * v2.28：80 万 → 20 万字符、单条 1.2 万 → 8 千字符（见两个字段各自的说明：
 *   跟着窗口走的预算让「窗口填得越大、账单越失控」，实测长任务里压缩从不触发）。
 *
 * 为什么需要：设置是本地持久化的，只改 DEFAULT_COMPACTION 对老用户不生效
 * （deepMergeSettings 里存量的值优先）。为什么只认旧出厂值、而不是「小于/大于新值就抬」：
 * 用户可能是特意调过的（想早点压缩省 token、或想让单条回显更完整），
 * 那种值必须原样保留（tests/unit 里有守着这条的用例）。
 *
 * **只在落盘版本落后时调用一次**（见 store.ts 的 migrateDefaultValues）：
 * 每次保存都跑的话，用户之后主动填回旧值会被静默改回去 —— 正是这个项目
 * 最讨厌的那类「改了没反应、还没有任何报错」。
 *
 * 没变化时返回**原对象**（调用方依赖引用稳定，见 store 的 merge 语义）。
 */
export function upgradeCompactionDefaults(c: CompactionSettings): CompactionSettings {
  let next = c
  if (LEGACY_COMPACTION_VALUES.transcriptMaxChars.includes(c.transcriptMaxChars)) {
    next = { ...next, transcriptMaxChars: DEFAULT_COMPACTION.transcriptMaxChars }
  }
  if (LEGACY_COMPACTION_VALUES.toolResultMaxChars.includes(c.toolResultMaxChars)) {
    next = { ...next, toolResultMaxChars: DEFAULT_COMPACTION.toolResultMaxChars }
  }
  if (LEGACY_COMPACTION_VALUES.keepRounds.includes(c.keepRounds)) {
    next = { ...next, keepRounds: DEFAULT_COMPACTION.keepRounds }
  }
  return next
}

export const COMPACTION_BOUNDS = {
  toolResultMaxChars: { min: 1_000, max: 200_000 },
  transcriptMaxChars: { min: 20_000, max: 2_000_000 },
  keepRounds: { min: 1, max: 20 },
  /** 下限 0.4：太早压缩会白花钱把还有用的上下文摘要掉 */
  pressureRatio: { min: 0.4, max: 0.95 }
} as const

/** 比例类设置的收敛：越界一律收敛到上下界（不做「百分数」猜测，避免 5 → 5% 这种静默歧义） */
function clampRatio(v: unknown, min: number, max: number, fallback: number): number {
  const raw = typeof v === 'number' ? v : Number.parseFloat(String(v))
  if (!Number.isFinite(raw)) return fallback
  return Math.max(min, Math.min(max, Math.round(raw * 100) / 100))
}

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
    ),
    pressureRatio: clampRatio(
      p.pressureRatio,
      COMPACTION_BOUNDS.pressureRatio.min,
      COMPACTION_BOUNDS.pressureRatio.max,
      base.pressureRatio
    ),
    summarize: typeof p.summarize === 'boolean' ? p.summarize : base.summarize
  }
}

// ————————————————————— 轮次预算 —————————————————————

/**
 * 轮次预算剩余多少时提醒模型收尾。
 *
 * 为什么不能写死 10：小预算（比如 8 轮）的任务在第 0 轮就收到「还剩 10 轮」纯属噪音。
 * 15% 的比例 + 3~10 的夹取，让 12 轮的任务在剩 3 轮、200 轮的任务在剩 10 轮时提醒。
 */
export function roundsLeftWarnAt(maxRounds: number): number {
  return Math.min(10, Math.max(3, Math.ceil(maxRounds * 0.15)))
}

/**
 * 轮次预算的软着陆提醒（v2.9）。返回 null = 这一轮不需要提醒。
 *
 * 为什么需要：maxRounds 从 12 提到 200 之后，「跑到底才知道预算没了」的代价从几轮
 * 变成上百轮 —— 模型不该在那时才第一次听说自己有时间限制。原来的行为正是如此
 * （只有撞上限时由运行时宣布任务终止），小预算时这个缺陷看不出来，大预算时就是白跑。
 *
 * 提醒文案刻意写成「用户消息」的口吻且带【系统】前缀：它会被追加到 messages 末尾
 * （不动 system prompt —— 逐字变化会让服务端 prompt cache 整段失效），
 * 模型需要能分清这不是用户新提的要求。
 */
export function roundsLeftNotice(remaining: number, maxRounds: number): string | null {
  if (remaining <= 0 || remaining > roundsLeftWarnAt(maxRounds)) return null
  return (
    `【系统】轮次预算提醒：本任务最多 ${maxRounds} 轮工具调用，现在还剩 ${remaining} 轮。` +
    '请开始收尾而不是另起炉灶：把当前动作做完并给出结论，明确列出未完成项；' +
    '若还有关键验证没做，挑最重要的那一项做完，不要再开启新的探索方向，也不要重复已经执行过的调用。'
  )
}

/** 每条消息的固定开销（role / timestamp / 结构字段）——估算是为了做决策，不追求精确 */
const MESSAGE_OVERHEAD = 32
const PART_OVERHEAD = 16

/**
 * v2.22（F17）：一个图片块折算的字符数。
 *
 * **绝不能按 base64 长度算**：一张 2 MB 的截图 base64 后是 2.7 M 字符，按字符估
 * 等于把 256k 的窗口一次填满 —— 表现是「刚导入一张图，历史就开始被压缩」，
 * 而真实成本由**像素**决定（1920×1080 约 1100 token，极大图约 3000）。
 * 这里取一个中位数的固定估算（约 1900 token），并且按「字符」口径与其它部分相加，
 * 保证 `estimateChars` 的语义不变（下游只做量级比较）。
 */
export const IMAGE_PART_CHARS = 6000

/** 单条消息折算的字符数：文本按字符数，图片按固定估算，其余按 JSON 长度兜底 */
export function messageChars(message: Message): number {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.length + MESSAGE_OVERHEAD
  if (Array.isArray(content)) {
    let n = MESSAGE_OVERHEAD
    for (const raw of content) {
      const part = raw as { type?: string; text?: string }
      if (typeof part?.text === 'string') {
        n += part.text.length + PART_OVERHEAD
        continue
      }
      // 图片：按固定代价计（见 IMAGE_PART_CHARS 的说明），不按 data 的长度
      n += (part?.type === 'image' ? IMAGE_PART_CHARS : JSON.stringify(raw).length) + PART_OVERHEAD
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
 *
 * v2.14：`marker` 可注入。默认文案是「换个更精确的命令重取」，而溢出落盘
 * （shared/spill.ts）拿到的是**已经归档的完整文件**，这时正确的话术是
 * 「去读那个文件」，不是「重新跑一遍」—— eNSP 的 display 类命令重跑结果未必一致，
 * 配置类回显更是不能重取。做成注入而不是复制一份截断逻辑，避免两处公式漂移。
 */
export function truncateToolResult(
  text: string,
  maxChars: number,
  marker?: (info: { totalChars: number; omittedChars: number }) => string
): TruncatedText {
  const originalChars = text.length
  if (maxChars <= 0 || originalChars <= maxChars) {
    return { text, truncated: false, originalChars, omittedChars: 0 }
  }
  const head = Math.max(1, Math.floor(maxChars * 0.6))
  const tail = Math.max(0, maxChars - head)
  const omitted = originalChars - head - tail
  const markerText = marker
    ? marker({ totalChars: originalChars, omittedChars: omitted })
    : `\n\n…（本条结果共 ${originalChars} 字符，已省略中间 ${omitted} 字符。` +
      '需要完整内容时请用更精确的命令重新获取：加过滤条件、缩小范围，或分段查看。）\n\n'
  return {
    text: text.slice(0, head) + markerText + (tail > 0 ? text.slice(originalChars - tail) : ''),
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

/**
 * 轮次起点 —— 一次「模型往返」的起点。
 *
 * ⚠️ v2.6 修正了一处既有实现里的真 bug：原来只认 `role === 'user'`。
 * 但**单个任务从头到尾只有一条 user 消息**（用户下发的那个目标），
 * 后面的工具轮次全部以 `assistant(toolCalls) ↔ toolResult` 的形式在同一轮里展开 ——
 * 于是「按 user 切轮」在「一个跑很久的实验」里只会得到 1 轮，
 * `planCompaction` 因为 `starts.length < 2` 每次直接原样返回：
 * **压缩功能在最需要它的场景（长实验一次跑爆上下文）下是完全失效的**，
 * 只有在用户接着上一轮继续说话、或中途插话时才会生效。
 *
 * 正确判据是「一次模型调用」：`user` 消息，或**紧跟在工具结果之后**、
 * 开启新一次模型调用的 `assistant` 消息。
 *
 * 这两个位置都天然是**结构安全的切点**：切在它们之前，前一段里的
 * `assistant(toolCalls) ↔ toolResult(callId)` 始终成对
 * （结果是紧跟在调用后面追加的，所以「assistant 之前的消息」只可能是 user 或 toolResult）。
 */
function roundStarts(messages: readonly Message[]): number[] {
  const starts: number[] = []
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      starts.push(i)
      return
    }
    if (m.role === 'assistant' && i > 0 && messages[i - 1]?.role === 'toolResult') {
      starts.push(i)
    }
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

// ————————————————————— L1.5 已归档结果的重剪（E，v2.14） —————————————————————

/**
 * 重剪预算占「插入时预算」的比例。
 *
 * 取比例而不是绝对值，是为了跟着用户在设置里调的 `toolResultMaxChars` 一起走 ——
 * 两个预算必须同量级，否则会出现「插入时截到 12000、压缩时又截到 3000」
 * 这种用户改了设置却看不出原因的收缩。
 */
export const REPRUNE_RATIO = 0.25

/** 重剪预算的下限：再小就只剩定位符了，模型等于什么都没看到 */
export const REPRUNE_MIN_CHARS = 600

/**
 * 单条重剪的最小收益（字符）。
 *
 * 防「无效抖动」：重剪后的 payload ≈ `maxChars` + 定位符，而定位符本身有一两百字符，
 * 于是它仍然大于 `maxChars` —— 下一次压缩会再来截一遍、又只省下几十字符，
 * 却把消息内容改掉（prompt cache 失效）。给一个最小收益门槛，
 * 让已经重剪过的结果**稳定下来**（本函数在实践中幂等）。
 */
export const REPRUNE_MIN_SAVING = 200

/** 由插入时的预算推出重剪预算 */
export function repruneBudgetOf(toolResultMaxChars: number): number {
  return Math.max(REPRUNE_MIN_CHARS, Math.floor(toolResultMaxChars * REPRUNE_RATIO))
}

export interface RepruneOptions {
  /** 重剪后单条结果的字符上限（见 `repruneBudgetOf`） */
  maxChars: number
  /** 最近几轮的原文不动（与摘要 / 修剪同一口径） */
  keepRounds: number
}

export interface RepruneResult {
  messages: Message[]
  applied: boolean
  shrunkMessages: number
  savedChars: number
  beforeChars: number
  afterChars: number
}

/** 一条消息里的纯文本（toolResult 的 content 是分片数组） */
function messageText(m: Message): string {
  const content = (m as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (p as { text?: string }).text ?? '').join('\n')
}

/**
 * L1.5：把**已归档**的旧工具结果重剪到更小的预算（E，v2.14）。零模型调用。
 *
 * **存在的理由**：原流程只要触发压缩就一定先付一次摘要模型请求（`compactPipeline`
 * 的顺序是 summarize → trim）。而长实验里真正占体积的往往是几十条**已归档**的大回显
 * （`display current-configuration` 一条就是几万字符）—— 把它们按更小的预算重剪是
 * **不花模型请求**的，很可能直接把体积压到水位以下，那次摘要就白省了。
 * （dsh 的 `compaction-tool-result-pruner` 正是这个位置：在摘要选材之前、且不产生模型调用。）
 *
 * **只动带定位符的结果**（`extractSpillPath` 认得出）—— 这是本函数最重要的约束：
 * 定位符在，说明完整原文已在磁盘上、中段随时可用 `read_attachment` 取回，重剪只是
 * 「换一份更短的视图」；**没有定位符的结果一律不碰** —— 它们从没被归档过，
 * 重剪就是真丢数据，那种情况必须交给摘要那一档（摘要至少让模型读过全文）。
 *
 * 与 L2 修剪（`planCompaction`）的区别：L2 把整段换成「请重新调用」的占位符（不可恢复），
 * 所以它必须排在摘要**之后**；这里保头保尾 + **重新挂上定位符**（可恢复），
 * 因此可以安全地排在摘要**之前**。
 *
 * 切点与保留窗口复用 `planCompaction` 的同一套规则（首轮 + 最近 keepRounds 轮 + 所有
 * user 消息原样保留），避免出现「两档压缩的保留窗口不一致」这种难查的行为。
 */
export function planToolResultReprune(
  messages: readonly Message[],
  opts: RepruneOptions
): RepruneResult {
  const beforeChars = estimateChars(messages)
  const noop = (): RepruneResult => ({
    messages: [...messages],
    applied: false,
    shrunkMessages: 0,
    savedChars: 0,
    beforeChars,
    afterChars: beforeChars
  })

  if (opts.maxChars <= 0) return noop()
  const starts = roundStarts(messages)
  // 首轮（任务描述与附件清单）与保留窗口内一律不动 —— 与 planCompaction 同一条边界
  if (starts.length < 2) return noop()
  const keepCount = Math.min(Math.max(1, opts.keepRounds), starts.length - 1)
  const beginIndex = starts[1]!
  const endIndex = starts[starts.length - keepCount]!
  if (beginIndex >= endIndex) return noop()

  let shrunkMessages = 0
  let savedChars = 0
  const next = messages.map((m, i) => {
    if (i < beginIndex || i >= endIndex) return m
    if (m.role !== 'toolResult') return m
    const text = messageText(m)
    if (text.length <= opts.maxChars) return m
    const path = extractSpillPath(text)
    if (!path) return m // 从没归档过 —— 重剪会真丢数据，交给摘要那一档
    const trimmed = truncateToolResult(text, opts.maxChars, (info) =>
      repruneLocatorNotice(path, info.omittedChars)
    )
    if (!trimmed.truncated) return m
    const saved = text.length - trimmed.text.length
    if (saved < REPRUNE_MIN_SAVING) return m // 收益不值得改一次消息（见 REPRUNE_MIN_SAVING）
    shrunkMessages += 1
    savedChars += saved
    return { ...m, content: [{ type: 'text', text: trimmed.text }] } as Message
  })

  if (shrunkMessages === 0) return noop()
  return {
    messages: next,
    applied: true,
    shrunkMessages,
    savedChars,
    beforeChars,
    afterChars: estimateChars(next)
  }
}

// ————————————————————— 真实 token 计量（v2.6） —————————————————————

/**
 * pi-ai 的 `Usage` 里各字段的口径（读 `dist/api/openai-completions.js` 的映射代码确认，
 * 不是猜的）：**`input` 已经扣掉了缓存命中的部分**，`totalTokens = input + output + cacheRead + cacheWrite`。
 *
 * 所以「这次请求真实喂进去多少 prompt」= `input + cacheRead + cacheWrite`，
 * 而不是 `input` —— 直接读 `input` 会在命中缓存时**严重低估**上下文体积
 * （长会话里 cacheRead 往往占大头），于是压缩永远不触发、直到某次请求直接溢出。
 */
export interface PromptUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
}

function safeNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** 真实 prompt tokens；拿不到（provider 没给 usage）返回 null，调用方退回字符估算 */
export function promptTokensOf(usage: PromptUsage | undefined | null): number | null {
  if (!usage) return null
  const direct = safeNum(usage.input) + safeNum(usage.cacheRead) + safeNum(usage.cacheWrite)
  if (direct > 0) return direct
  // 只有 totalTokens 可用时反推：total - output
  const total = safeNum(usage.totalTokens)
  if (total > 0) return Math.max(0, total - safeNum(usage.output)) || null
  return null
}

/** 无测量时的默认换算比（中英混排的经验值，宁可高估 token） */
export const DEFAULT_CHARS_PER_TOKEN = 3.2
/** 换算比的合理区间 —— 超出说明测量数据本身有问题（例如把工具结果算漏了） */
export const CHARS_PER_TOKEN_BOUNDS = { min: 1.5, max: 6 } as const

/**
 * 上一次请求的「字符数 ↔ 真实 tokens」对照，用来**校准**本项目的字符估算。
 *
 * 为什么需要校准而不是直接用真实值：真实值是**上一轮**的，而这一轮刚追加了几十万字符的
 * 工具回显。字符估算能反映新增部分（但它绝对不准），真实值准但滞后 ——
 * 用「上次的真实 tokens / 上次的字符数」得到这一档模型 + 这类内容的真实换算比，
 * 再乘到当前字符数上，两者兼得。不同的 provider / 模型 / 中英文比例会自动收敛。
 */
export interface TokenCalibration {
  chars: number
  tokens: number
}

export function charsPerToken(cal: TokenCalibration | null | undefined): number {
  if (!cal) return DEFAULT_CHARS_PER_TOKEN
  const chars = safeNum(cal.chars)
  const tokens = safeNum(cal.tokens)
  if (chars <= 0 || tokens <= 0) return DEFAULT_CHARS_PER_TOKEN
  const ratio = chars / tokens
  return Math.max(CHARS_PER_TOKEN_BOUNDS.min, Math.min(CHARS_PER_TOKEN_BOUNDS.max, ratio))
}

export interface TokenEstimate {
  tokens: number
  chars: number
  charsPerToken: number
  /** true = 用过一次真实 usage 校准；false = 纯字符估算 */
  calibrated: boolean
}

export function estimatePromptTokens(input: {
  chars: number
  calibration?: TokenCalibration | null
}): TokenEstimate {
  const chars = Math.max(0, input.chars)
  const ratio = charsPerToken(input.calibration)
  return {
    tokens: Math.ceil(chars / ratio),
    chars,
    charsPerToken: ratio,
    calibrated: charsPerToken(input.calibration) !== DEFAULT_CHARS_PER_TOKEN
  }
}

export interface PressureReport extends TokenEstimate {
  contextWindow: number
  /** 触发压缩的 token 水位 */
  budgetTokens: number
  ratio: number
  /** 字符硬上限（次要触发条件，兼容老配置） */
  maxChars: number
  overTokens: boolean
  overChars: boolean
  over: boolean
}

/**
 * 上下文压力：**token 与字符双判据，任一越线即压缩**。
 *
 * 保留字符判据不是冗余：`transcriptMaxChars` 是用户已经调过的绝对上限，
 * 而 token 判据依赖 `contextWindow`（用户可能填错，或模型开了「更大上下文 Max」）。
 * 两条都留着，任何一条坏掉都不会让压缩彻底失效。
 */
export function measurePressure(input: {
  messages: readonly Message[]
  systemPromptChars: number
  contextWindow: number
  pressureRatio: number
  maxChars: number
  calibration?: TokenCalibration | null
}): PressureReport {
  const chars = estimateChars(input.messages) + Math.max(0, input.systemPromptChars)
  const est = estimatePromptTokens({ chars, calibration: input.calibration })
  const budgetTokens = Math.max(1, Math.floor(input.contextWindow * input.pressureRatio))
  const overTokens = est.tokens >= budgetTokens
  const overChars = input.maxChars > 0 && chars > input.maxChars
  return {
    ...est,
    contextWindow: input.contextWindow,
    budgetTokens,
    ratio: est.tokens / Math.max(1, input.contextWindow),
    maxChars: input.maxChars,
    overTokens,
    overChars,
    over: overTokens || overChars
  }
}

// ————————————————————— 摘要式压缩（L3，v2.6） —————————————————————

/**
 * 摘要式压缩的**安全切点**：按 user 消息边界整段替换。
 *
 * 为什么可以整段删（而 L2 修剪坚持「只改内容不删消息」）：
 * 每一轮都以 user 消息开头，轮内的 `assistant(toolCalls) ↔ toolResult(callId)` 自洽 ——
 * 从一个 user 消息切到另一个 user 消息，**配对关系不会被打断**。
 * 反过来，若在轮中间切，就会留下「有 toolCall 没有 toolResult」的残骸，
 * provider 会直接 400（这是删消息最容易踩的坑）。
 *
 * 三条边界沿用 L2 的既有纪律：
 * 1. **首轮永不压缩** —— 它装着任务描述与附件清单，压掉等于让代理忘了自己要干什么；
 * 2. **保留窗口不得超过实际轮数** —— 轮数不足时下标会取到 undefined，比较全为 false
 *    后会把整段 transcript 都压掉（L2 踩过这个静默反向 bug）；
 * 3. **保留窗口按轮对齐**，不按消息条数，避免切在轮中间。
 */
export interface SummaryPlan {
  applied: boolean
  /** 被摘要的区间（左闭右开），首轮之后到保留窗口之前 */
  segmentStart: number
  segmentEnd: number
  /** 参与摘要的消息条数 */
  messageCount: number
  /** 被摘要覆盖的轮数 */
  rounds: number
  segmentChars: number
  /** 渲染好的摘要输入正文（不含指令；指令由提示词层给） */
  body: string
}

export const SUMMARY_BOUNDS = {
  /** 摘要请求的输入上限（字符）：太大等于把上下文问题搬到摘要请求上 */
  maxSummaryInputChars: { min: 4_000, max: 400_000 },
  /** 单条消息在摘要输入里的上限区间 */
  perMessageChars: { min: 160, max: 4_000 }
} as const

export const DEFAULT_SUMMARY_MAX_INPUT_CHARS = 60_000

/** 在摘要输入预算内，把单条消息压到多少字符 —— 按条数分配，保证「每条都能露出一点」 */
export function perMessageBudget(messageCount: number, maxChars: number): number {
  const n = Math.max(1, messageCount)
  const raw = Math.floor(Math.max(1, maxChars) / n)
  return Math.max(
    SUMMARY_BOUNDS.perMessageChars.min,
    Math.min(SUMMARY_BOUNDS.perMessageChars.max, raw)
  )
}

/** 长文本保头保尾（结论通常在后半段：eNSP 回显的报错与统计行都在末尾） */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.max(1, Math.floor(maxChars * 0.55))
  const tail = Math.max(1, maxChars - head)
  return `${text.slice(0, head)}\n…（此处省略 ${text.length - head - tail} 字符）\n${text.slice(text.length - tail)}`
}

function textOfMessage(m: Message): string {
  const content = (m as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const raw of content) {
    const part = raw as { type?: string; text?: string; name?: string }
    if (part?.type === 'thinking') continue
    if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    // v2.22（F17）：图片只留一个占位标记 —— 摘要器（L3）读不了像素，
    // 但必须知道「这里曾经有一张图」，否则会把「用户给过截图」这件事一并丢掉
    else if (part?.type === 'image') parts.push('（图片，内容未纳入摘要）')
    else if (part?.type === 'toolCall') parts.push(`（调用工具 ${part.name ?? ''}）`)
    else if (part?.type === 'toolResult' || part?.type === 'tool_result') parts.push('（工具结果）')
  }
  return parts.join('\n')
}

function labelOfMessage(m: Message): string {
  try {
    switch (m.role) {
      case 'user':
        return '【用户】'
      case 'assistant':
        return '【助手】'
      case 'toolResult':
        return `【工具结果 ${(m as { toolName?: string }).toolName ?? ''}】`
      default:
        return `【${String((m as { role?: string }).role ?? '未知')}】`
    }
  } catch {
    return '【未知】'
  }
}

/**
 * 把待摘要的老轮次渲染成模型可读的正文。
 *
 * 每条消息都按预算截断（保头保尾），而**不是**从最旧的开始整段丢弃 ——
 * 丢最旧的等于把「最初是怎么一步步走到现在的」抹掉，恰恰是摘要最该保留的部分。
 */
export function renderSummaryBody(segment: readonly Message[], maxChars: number): string {
  const per = perMessageBudget(segment.length, maxChars)
  const lines: string[] = []
  for (const m of segment) {
    const body = clip(textOfMessage(m).trim(), per)
    if (!body) continue
    lines.push(`${labelOfMessage(m)}${body}`)
  }
  return lines.join('\n')
}

export function planSummaryCompaction(
  messages: readonly Message[],
  opts: { keepRounds: number; maxSummaryInputChars?: number }
): SummaryPlan {
  const starts = roundStarts(messages)
  const noop: SummaryPlan = {
    applied: false,
    segmentStart: -1,
    segmentEnd: -1,
    messageCount: 0,
    rounds: 0,
    segmentChars: 0,
    body: ''
  }
  if (starts.length < 2) return noop

  // 保留窗口不能超过实际轮数（见规则 2）
  const keepCount = Math.min(Math.max(1, opts.keepRounds), starts.length - 1)
  const segmentStart = starts[1]!
  const segmentEnd = starts[starts.length - keepCount]!
  if (segmentStart >= segmentEnd) return noop

  const segment = messages.slice(segmentStart, segmentEnd)
  const maxChars = Math.max(
    SUMMARY_BOUNDS.maxSummaryInputChars.min,
    Math.min(
      SUMMARY_BOUNDS.maxSummaryInputChars.max,
      opts.maxSummaryInputChars ?? DEFAULT_SUMMARY_MAX_INPUT_CHARS
    )
  )
  const rounds = starts.length - keepCount - 1
  return {
    applied: true,
    segmentStart,
    segmentEnd,
    messageCount: segment.length,
    rounds: Math.max(1, rounds),
    segmentChars: estimateChars(segment),
    body: renderSummaryBody(segment, maxChars)
  }
}

/** 摘要消息的固定前缀 —— 让后续每一轮都清楚「这段是被压缩的历史，不是新指令」 */
export const SUMMARY_MESSAGE_PREFIX = '[历史摘要 · 此前对话已被压缩]'

/**
 * 用摘要替换被压区间，返回新数组。
 * 首轮（含任务描述）与保留窗口**原样保留**，只在切点处插入一条 user 摘要消息。
 */
export function applySummary(
  messages: readonly Message[],
  plan: SummaryPlan,
  summary: string,
  timestamp: number
): Message[] {
  if (!plan.applied) return [...messages]
  const text = summary.trim()
  if (!text) return [...messages]
  const digest: Message = {
    role: 'user',
    content:
      `${SUMMARY_MESSAGE_PREFIX}\n${text}\n\n` +
      '（以上是更早对话的压缩摘要。原始工具回显已不在上下文中；若需要其中的具体数据，' +
      '请重新调用相应工具获取，不要凭记忆复述。）',
    timestamp
  }
  return [...messages.slice(0, plan.segmentStart), digest, ...messages.slice(plan.segmentEnd)]
}

/** 给用户看的一句话说明（摘要式） */
export function describeSummaryCompaction(r: {
  rounds: number
  messageCount: number
  beforeChars: number
  afterChars: number
}): string {
  const saved = Math.max(0, r.beforeChars - r.afterChars)
  const pct = r.beforeChars > 0 ? Math.round((saved / r.beforeChars) * 100) : 0
  return (
    `上下文接近上限，已把较早的 ${r.rounds} 轮（${r.messageCount} 条消息）交给模型压成结论摘要：` +
    `${r.beforeChars} → ${r.afterChars} 字符（省 ${pct}%）。任务目标与最近几轮保持原文，` +
    '摘要已写入上下文（会话里仍保留完整原始记录）。'
  )
}

/** 给用户看的 token 占用水位（真实计量 + 校准来源） */
export function describePressure(p: PressureReport): string {
  const pct = Math.round(p.ratio * 100)
  return (
    `上下文占用 ${p.tokens.toLocaleString('en-US')} / ${p.contextWindow.toLocaleString('en-US')} tokens（${pct}%）` +
    `${p.calibrated ? '' : '（字符估算，尚无真实用量可校准）'}`
  )
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
