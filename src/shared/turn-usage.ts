/**
 * 本轮用量归集（v2.10，P6）—— 纯函数，供 store 与单测共用。
 *
 * 为什么需要单独一层：
 * ① `usage` 事件是**每次模型往返**下发一次（一轮任务里 ReAct 会来回好几次），
 *    所以「本轮总共花了多少」必须**累加**，不能拿最后一次的值当总数；
 * ② 累加口径必须明确：`promptTokens` 每次往返都是**整段上下文**，
 *    直接相加得到的数字会随轮次平方增长（第 2 轮又把第 1 轮的内容算了一遍）。
 *    这里仍然选择相加，但把它称作「累计用量」而不是「上下文占用」——
 *    界面上要同时给出轮次，让用户理解这个数字的含义（见 `describeTurnUsage`）。
 */

/** 一次模型往返的用量（对应 AgentEvent.usage 的子集） */
export interface UsageSample {
  promptTokens: number
  outputTokens: number
  /** v2.28：缓存分项（provider 没给时缺省，按 0 计） */
  cacheReadTokens?: number
  cacheWriteTokens?: number
  freshInputTokens?: number
}

/** 本轮累计用量 */
export interface TurnUsage {
  /** 模型往返次数（ReAct 的步数） */
  rounds: number
  /** 各次 promptTokens 之和（= 未命中 + 缓存命中 + 缓存写入） */
  promptTokens: number
  /** 各次 outputTokens 之和 */
  outputTokens: number
  /**
   * v2.28：缓存命中 / 缓存写入 / 未命中输入的分项累计。
   *
   * 为什么必须分开：`promptTokens` 把三者加在一起，而命中部分通常按 0.1 倍计价。
   * 只看总数会把「300 万输入」当成「300 万全价输入」——据此优化会优化错方向
   * （真正贵的大头可能是输出，而不是输入）。
   */
  cacheReadTokens: number
  cacheWriteTokens: number
  freshInputTokens: number
  /** 是否至少有一次是真实测量（false = 全是字符估算） */
  measured: boolean
  /** 最后一次的上下文窗口（用于显示占比时的分母） */
  contextWindow: number
  /** 最后一次的占用比例（最贴近「现在上下文多满」） */
  lastRatio: number
}

export const EMPTY_TURN_USAGE: TurnUsage = {
  rounds: 0,
  promptTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  freshInputTokens: 0,
  measured: false,
  contextWindow: 0,
  lastRatio: 0
}

/** 把一次 model 往返并入累计值（不修改入参，返回新对象） */
export function accumulateUsage(
  prev: TurnUsage,
  sample: UsageSample,
  opts: { measured?: boolean; contextWindow?: number; ratio?: number } = {}
): TurnUsage {
  return {
    rounds: prev.rounds + 1,
    promptTokens: prev.promptTokens + Math.max(0, Math.floor(sample.promptTokens || 0)),
    outputTokens: prev.outputTokens + Math.max(0, Math.floor(sample.outputTokens || 0)),
    cacheReadTokens: prev.cacheReadTokens + Math.max(0, Math.floor(sample.cacheReadTokens || 0)),
    cacheWriteTokens: prev.cacheWriteTokens + Math.max(0, Math.floor(sample.cacheWriteTokens || 0)),
    freshInputTokens: prev.freshInputTokens + Math.max(0, Math.floor(sample.freshInputTokens || 0)),
    // 只要有一次实测就记 true —— 与「估算」区分开，界面上要标注
    measured: prev.measured || opts.measured === true,
    contextWindow: opts.contextWindow ?? prev.contextWindow,
    lastRatio: opts.ratio ?? prev.lastRatio
  }
}

/**
 * v2.28：缓存命中率（0~1）。分母是「计入 prompt 的全部输入」——
 * 与 `promptTokens` 同一口径，所以这个比例可以直接解释那一列数字。
 *
 * 没有任何分项数据（老 provider 不给 usage）时返回 null，
 * 界面据此**不显示**命中率，而不是显示一个看着像 0% 的假数字。
 */
export function cacheHitRatio(u: TurnUsage): number | null {
  const denom = u.cacheReadTokens + u.cacheWriteTokens + u.freshInputTokens
  if (denom <= 0) return null
  return u.cacheReadTokens / denom
}

/**
 * 人类可读的 token 数：小于 1000 给原值，否则给一位小数的 k。
 * 8.1k 比 8123 好读，也比 `8.1K` 这种大小写混用的写法统一。
 */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.floor(n || 0))
  if (v < 1000) return String(v)
  const k = v / 1000
  // 10k 以上不再保留小数（12345 → 12k，比 12.3k 更少噪声）
  return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`
}

/**
 * 底部用量行的文案：`8.1k tokens · 3 轮`。
 *
 * 为什么带轮次：累计 tokens 与轮次强相关（每轮都会把前文再算一遍），
 * 只给总量会让用户误以为「这轮上下文有 8.1k」。给出轮次，数字才可解释。
 * 估算（未实测）时补一句标注 —— 与真实用量必须能区分。
 */
export function describeTurnUsage(u: TurnUsage): string {
  if (u.rounds === 0) return ''
  const total = u.promptTokens + u.outputTokens
  const parts = [`${formatTokens(total)} tokens`, `${u.rounds} 轮`]
  if (!u.measured) parts.push('估算')
  // v2.28：有缓存分项时补一句命中率。它是「这一列数字到底多贵」的唯一线索 ——
  // 命中部分通常按 0.1 倍计价，只给总数会让用户高估成本并优化错方向。
  const hit = u.measured ? cacheHitRatio(u) : null
  if (hit !== null) parts.push(`缓存命中 ${Math.round(hit * 100)}%`)
  return parts.join(' · ')
}

/**
 * 判断本轮是否值得展示用量行。
 * 一次纯聊天的单轮往返也显示「300 tokens · 1 轮」只会增加噪声 ——
 * 只有真正干了活（多轮，或 token 量可观）才显示。
 */
export function shouldShowUsage(u: TurnUsage, minRounds = 2, minTokens = 1000): boolean {
  if (u.rounds === 0) return false
  return u.rounds >= minRounds || u.promptTokens + u.outputTokens >= minTokens
}
