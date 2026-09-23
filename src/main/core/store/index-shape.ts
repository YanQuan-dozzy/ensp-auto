/**
 * JSON 索引文件的形状校验（快照索引 / 变更记录 / 会话索引共用）。
 *
 * 为什么必须有：`JSON.parse` 的结果是 `any`，`parsed.items ?? []` 这种写法
 * 只能挡住「字段缺失」，挡不住 `{"items": "x"}` 或 `[1,2,3]` 这类形状错误的文件。
 * 一旦漏进去，后续 `.filter` / `.unshift` / `.map` 就会在**远离故障点的地方**抛 TypeError，
 * 用户看到的是「快照列表打不开」，而根因是一个被手工改坏的索引文件。
 *
 * 纪律：坏条目丢弃并计数，**不抛异常** —— 一条烂记录不该让整个索引不可用。
 */

export interface IndexShapeResult<T> {
  items: T[]
  /** 因形状不合法被丢弃的条目数 */
  dropped: number
  /** 整个 items 字段都不是数组时为 true（区别于「数组里没有坏条目」） */
  notArray: boolean
}

export function sanitizeIndexItems<T>(
  raw: unknown,
  guard: (v: unknown) => v is T
): IndexShapeResult<T> {
  if (!Array.isArray(raw)) {
    return { items: [], dropped: 0, notArray: raw !== undefined && raw !== null }
  }
  const items: T[] = []
  let dropped = 0
  for (const item of raw) {
    if (guard(item)) items.push(item)
    else dropped += 1
  }
  return { items, dropped, notArray: false }
}

/** 生成一条可读的加载告警（没发现问题时返回 null） */
export function describeShapeWarning(
  what: string,
  result: { dropped: number; notArray: boolean }
): string | null {
  if (result.notArray) return `${what}索引的 items 字段不是数组，已按空列表处理`
  if (result.dropped > 0) return `${what}索引有 ${result.dropped} 条记录形状不合法，已忽略`
  return null
}

/** 常用字段判定，避免每个 guard 都手写 typeof 链 */
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
