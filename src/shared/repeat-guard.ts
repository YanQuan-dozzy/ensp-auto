/**
 * 重复工具调用防护（v2.14）。
 *
 * 为什么需要：模型卡在死循环里是本项目最典型的一类「烧完预算才收场」——
 * 用完全相同的参数反复调同一条命令（`display ospf peer` 不达预期就再调一次、
 * 设备返回 `[Y/N]` 时反复拿同一条命令去撞）。现在的唯一兜底是跑满 `maxRounds`
 * 撞墙，而那已经是几百轮之后的事：前面那些轮次全是白跑的。
 *
 * 设计口径（机制取自 dsh 的 `repeat-tool-reminder`，按本仓的治理方式落地）：
 * - **只提醒、不否决**。命中阈值只往 transcript 末尾追加一条 user 消息，
 *   不改工具结果、不改 system prompt —— 后者会让服务端 prompt cache 整段失效
 *   （这个项目已经为它调过一次错，见 react.runtime 里轮次提醒的注释）。
 * - **参数按值比较**。`{a:1,b:2}` 与 `{b:2,a:1}` 是**同一次**调用（深键排序后
 *   stringify），否则模型只要换个键序就能绕过整条防护。
 * - **阈值递进**。第一次只温和提醒，后续阈值才点名工具、次数与参数。
 * - **用户插话即重置**。跨过用户一句话的重复不算循环 —— 判定在调用方
 *   （运行时在 drain 排队插话与计划评审回话处重置链）。
 *
 * 本文件是纯函数：循环里只留「推进链 + 命中就注入」，判定逻辑全部在这里，
 * 因此可以被直接单测（与 runtime-policy / concurrency / plan-mode 同一口径）。
 */

export interface RepeatGuardSettings {
  /** 关闭后完全不检测（默认开启 —— 它只产生一条提醒，不会改动任何工具结果） */
  enabled: boolean
}

export const DEFAULT_REPEAT_GUARD: RepeatGuardSettings = { enabled: true }

export function sanitizeRepeatGuard(
  patch: unknown,
  base: RepeatGuardSettings = DEFAULT_REPEAT_GUARD
): RepeatGuardSettings {
  const p = (patch ?? {}) as Partial<RepeatGuardSettings>
  return { enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled }
}

/** 读设置里的开关，容忍老配置 / 测试替身还没有这一块（缺省 = 开启） */
export function repeatGuardEnabledOf(settings: unknown): boolean {
  const s = (settings ?? {}) as { repeatGuard?: unknown }
  return sanitizeRepeatGuard(s.repeatGuard).enabled
}

/**
 * 连续重复次数达到这些阈值时各提醒一次。
 *
 * 是**代码常量而不是设置项**：这三个数字是产品判断（3 次开始提醒、5/8 次加重），
 * 不是用户的偏好 —— 把它摊到设置页只会多三个能填坏的数字输入框。
 */
export const REPEAT_GUARD_THRESHOLDS: readonly number[] = [3, 5, 8]

/** 详细提醒里引用参数的字符上限（检测本身始终用完整规范化串，这个上限只约束提醒文本） */
export const REPEAT_ARGS_PREVIEW_CHARS = 500

/** 一个会话的「连续重复链」：上一次调用的稳定键与它连续出现的次数 */
export interface RepeatChain {
  /** 工具名 + 规范化参数；空串表示链还没有起点 */
  key: string
  count: number
}

export const EMPTY_REPEAT_CHAIN: RepeatChain = { key: '', count: 0 }

/**
 * 深键排序。参数到达这里时是模型给的 JSON 解析结果（或其原始字符串兜底），
 * 所以输入域就是 JSON 的值域 —— 不会出现 bigint / 循环引用 / undefined 属性。
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}

/**
 * 规范化参数：深键排序后 stringify。
 * 非 JSON 值（`JSON.stringify(undefined)`）与异常退化为 `String()`，**绝不抛** ——
 * 一次参数序列化失败不该把整轮任务带下去。
 */
export function canonicalizeArgs(args: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(args)) ?? String(args)
  } catch {
    return String(args)
  }
}

/** 头截断参数预览，并标注省略量（只影响提醒文本，不影响比较用的键） */
function previewArgs(canonical: string): string {
  if (canonical.length <= REPEAT_ARGS_PREVIEW_CHARS) return canonical
  return `${canonical.slice(0, REPEAT_ARGS_PREVIEW_CHARS)}…（另省略 ${
    canonical.length - REPEAT_ARGS_PREVIEW_CHARS
  } 字符）`
}

function repeatNotice(
  toolName: string,
  count: number,
  thresholds: readonly number[],
  canonical: string
): string {
  // 首个阈值 = 温和提醒（这时还给不出「已经浪费了几轮」的证据，语气不该过硬）
  if (count === thresholds[0]) {
    return (
      `【系统】检测到连续第 ${count} 次完全相同的工具调用（${toolName}）。` +
      '先仔细读上一次的结果再决定下一步：若任务还没完成，换一个参数、换一条命令或换一种做法，' +
      '不要原样重发同一次调用；若已经拿到足够证据，就直接给结论。'
    )
  }
  return (
    `【系统】重复工具调用告警：${toolName} 已用完全相同的参数连续调用 ${count} 次，` +
    '中间没有插入任何新信息，也不会有新结果。参数：' +
    `${previewArgs(canonical)}。` +
    '请立刻停止重发这一次调用，改为：换参数 / 换命令 / 换设备，或直接说明卡在哪里并给出结论。'
  )
}

export interface RepeatObservation {
  /** 推进后的链（调用方必须存回，否则计数永远停在 1） */
  chain: RepeatChain
  /** 命中阈值时返回要注入的提醒文案，否则 null */
  notice: string | null
}

/**
 * 用一次工具调用推进重复链，并在命中阈值时给出提醒。
 *
 * 调用方按**模型给出的调用顺序**逐个调用（与写 transcript 的循环同序），
 * 这样「同一轮里的多次重复」也能被计入。
 */
export function observeToolCall(
  chain: RepeatChain,
  toolName: string,
  args: unknown,
  thresholds: readonly number[] = REPEAT_GUARD_THRESHOLDS
): RepeatObservation {
  const canonical = canonicalizeArgs(args)
  const key = `${toolName} ${canonical}`
  const count = chain.key === key ? chain.count + 1 : 1
  const next: RepeatChain = { key, count }
  if (!thresholds.includes(count)) return { chain: next, notice: null }
  return { chain: next, notice: repeatNotice(toolName, count, thresholds, canonical) }
}
