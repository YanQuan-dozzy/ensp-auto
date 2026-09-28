/**
 * 并发执行策略（v2.5）：跨设备只读并行。
 *
 * 为什么单独立一层：与 runtime-policy 同样的理由 —— 「哪些调用能并发、并发怎么分组」
 * 是决定一次实验跑不跑得完的判定逻辑，必须做成**可单测的纯函数**，
 * 循环里只留「按计划调度 + 应用结果」。
 *
 * ## 三条不变量（都是踩得到的坑，不是理论洁癖）
 *
 * 1. **同设备严格串行**。设备侧是 VRP 命令行，一次只能有一个命令在跑；
 *    通信层（TelnetClient）虽然也有串行队列，但那是「同一条连接上的命令」级保证 ——
 *    调度层若把同设备的两个调用同时丢下去，它们只会在队列里排队，
 *    既得不到任何提速，还会平白占满队列预算。这里把「同 key 串行」提升为**调度层的不变量**。
 *
 * 2. **写操作是屏障**。模型可能在一轮里给出
 *    `[apply_config(vlan 10), run_show_command(display vlan 10)]` ——
 *    后者要观察的是**前者执行之后**的状态。若把只读调用单独抽出来先并行跑，
 *    读到的就是执行前的旧状态，而且结果**看起来完全正常**（这是最危险的一类 bug）。
 *    所以只允许「连续的一段只读调用」并发，任何写操作把批次切开。
 *
 * 3. **默认串行**。并发资格由工具自己显式声明（`ToolSpec.concurrencySafe`），
 *    缺省不开 —— 反过来的默认值会让将来新增的工具在无人察觉时拿到并发资格。
 *    `risk: 'read'` 也**不足以**当作并发资格：`connect_device`、`save_config_snapshot`
 *    的 risk 同样是 read，但它们改的是连接状态与磁盘内容。
 */

export interface ConcurrencySettings {
  /**
   * 单个模型回合内可同时进行的调用上限。
   *
   * 1 = 完全串行（等价于 v2.4 的行为）；同设备仍然严格串行，所以这个数字
   * 实际决定的是「能同时压几台设备」。批量巡检 5 台设备时，4 比 1 快接近 4 倍。
   */
  maxParallel: number
}

export const DEFAULT_CONCURRENCY: ConcurrencySettings = { maxParallel: 4 }

export const CONCURRENCY_BOUNDS = {
  maxParallel: { min: 1, max: 16 }
} as const

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

export function sanitizeConcurrency(
  patch: unknown,
  base: ConcurrencySettings = DEFAULT_CONCURRENCY
): ConcurrencySettings {
  const p = (patch ?? {}) as Partial<ConcurrencySettings>
  return {
    maxParallel: clampInt(
      p.maxParallel,
      CONCURRENCY_BOUNDS.maxParallel.min,
      CONCURRENCY_BOUNDS.maxParallel.max,
      base.maxParallel
    )
  }
}

/**
 * 读设置里的并发上限，容忍「老配置 / 测试替身还没有这个字段」。
 * 缺失时用产品默认值（4），而不是 1 —— 否则一处漏传就会静默退回串行。
 */
export function maxParallelOf(settings: unknown): number {
  const s = (settings ?? {}) as { concurrency?: unknown }
  return sanitizeConcurrency(s.concurrency).maxParallel
}

// ————————————————————— 设备归属 —————————————————————

/** 无法确定设备归属时的键：这类调用一律串行 */
export const UNKNOWN_DEVICE_KEY = ''
/** 本地工具（不占设备）的键：彼此之间可以并发 */
export const LOCAL_DEVICE_KEY = 'local'

/**
 * 从工具的作用域与参数里解析「这次调用归属哪台设备」。
 *
 * 认得的字段只有三个，都是实测出来的：`deviceId`（大多数设备工具）、
 * `from`（verify_ping / 部分 tasks 步骤的源设备）、以及 `scope: 'local'`。
 * `deviceIds`（数组）跨多台设备，**刻意判为不可并发** —— 它无法与其它调用
 * 安全地排出先后，而它自己的 handler 内部已经做了跨设备并发（见 diagnose/verify）。
 */
export function deviceKeyOf(scope: 'device' | 'local', args: unknown): string {
  if (scope === 'local') return LOCAL_DEVICE_KEY
  const a = (args ?? {}) as Record<string, unknown>
  for (const field of ['deviceId', 'from'] as const) {
    const v = a[field]
    if (typeof v === 'string' && v) return `dev:${v}`
  }
  return UNKNOWN_DEVICE_KEY
}

/**
 * 调度键：同键串行、异键并行。
 *
 * 本地工具**没有共享状态**，每个调用给一把独立的键（`local:<callId>`）——
 * 若让它们共用 `'local'` 一个键，两次 read_attachment 会被无谓地串行化
 * （这是分组调度最容易被忽略的一个反效果）。
 */
export function scheduleKeyOf(scope: 'device' | 'local', args: unknown, callId: string): string {
  const key = deviceKeyOf(scope, args)
  return key === LOCAL_DEVICE_KEY ? `local:${callId}` : key
}

/** 一个调用是否拿到并发资格：工具自己声明过，且设备归属是确定的 */
export function isParallelSafe(spec: { concurrencySafe?: boolean } | undefined, key: string): boolean {
  return spec?.concurrencySafe === true && key !== UNKNOWN_DEVICE_KEY
}

// ————————————————————— 批次计划 —————————————————————

/** 调度所需的最小信息（不依赖 ToolSpec，便于用普通对象单测） */
export interface SchedulableCall {
  id: string
  /** 可否与相邻调用并发。false = 串行屏障（写操作、未知工具、设备归属不明） */
  parallelSafe: boolean
  /** 设备归属键；同键的调用在同一个并行批次里也保持串行 */
  deviceKey: string
}

export type ToolBatch<T extends SchedulableCall> =
  | { kind: 'parallel'; items: T[] }
  | { kind: 'serial'; items: T[] }

/**
 * 把一轮工具调用切成执行批次。
 *
 * 规则：连续的 parallelSafe 调用合成一个并行批次；其余（以及 maxParallel=1 时的一切）
 * 合成串行批次。**批次之间的顺序 === 模型给出的调用顺序**，
 * 这样写操作对读操作的可见性语义与串行执行完全一致。
 *
 * 注意：并行批次内的**结果顺序**由调用方按原始顺序回填，不依赖完成先后
 * —— provider 会按 assistant 消息里 toolCalls 的顺序校验工具结果配对。
 */
export function planToolBatches<T extends SchedulableCall>(
  calls: readonly T[],
  opts: { maxParallel: number }
): Array<ToolBatch<T>> {
  if (calls.length === 0) return []
  if (opts.maxParallel <= 1) {
    return [{ kind: 'serial', items: [...calls] }]
  }

  const out: Array<ToolBatch<T>> = []
  let buf: T[] = []
  let kind: 'parallel' | 'serial' | null = null

  const flush = (): void => {
    if (buf.length > 0 && kind) out.push({ kind, items: buf } as ToolBatch<T>)
    buf = []
  }

  for (const call of calls) {
    // 只有一个调用时并发没有意义，直接并进串行批次（也让事件顺序更好读）
    const want: 'parallel' | 'serial' =
      call.parallelSafe && calls.length > 1 ? 'parallel' : 'serial'
    if (kind === null) {
      kind = want
      buf = [call]
      continue
    }
    if (kind === want) {
      buf.push(call)
      continue
    }
    flush()
    kind = want
    buf = [call]
  }
  flush()
  return out
}

// ————————————————————— 调度器 —————————————————————

/**
 * 分组有界并发：**同 key 串行、跨 key 并行**，整体在途数不超过 limit。
 *
 * 为什么按 key 分组而不是「先抢全局名额、再等设备空闲」：后者在
 * 「名额被一堆等锁的任务占满」时会退化（甚至需要额外的死锁论证）。
 * 分组实现只有一个循环，正确性一眼可见，且天然满足不变量 1。
 *
 * 返回数组与入参**下标一一对应**（并发完成顺序不影响结果位置）。
 * `fn` 抛错会让整个 Promise.all 拒绝 —— 调用方需自行把错误收成返回值
 * （运行时里工具执行本来就有 try/catch 兜底，不允许异常逃逸到调度层）。
 */
export async function runGroupedBounded<T, R>(
  items: readonly T[],
  keyOf: (item: T, index: number) => string,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined)
  if (items.length === 0) return results

  const cap = Math.max(1, Math.floor(limit) || 1)
  const groups = new Map<string, Array<{ item: T; index: number }>>()
  items.forEach((item, index) => {
    const key = keyOf(item, index)
    const bucket = groups.get(key)
    if (bucket) bucket.push({ item, index })
    else groups.set(key, [{ item, index }])
  })

  const queue = [...groups.values()]
  let cursor = 0
  const workerCount = Math.min(cap, queue.length)
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const group = queue[cursor++]
      if (!group) return
      for (const { item, index } of group) {
        // 取消粒度是**调用级**（N34-27 的约定）：这里只在每项开始前检查一次 abort，
        // 已经在跑的那一项不会被抢占 —— 真正的中断由 handler 自己响应传入的 signal 完成
        // （如 Telnet 命令会向设备发 Ctrl+C）。因此 fn 必须接住 signal，不要依赖这里同步掐断。
        if (signal?.aborted) return
        results[index] = await fn(item, index)
      }
    }
  })
  await Promise.all(workers)
  return results
}
