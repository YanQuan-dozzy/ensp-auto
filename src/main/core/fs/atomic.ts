import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 统一原子写（JSON / 文本）。
 *
 * 背景（R19）：同一种「唯一临时名 + 原子 rename」在本仓被各写各的写了 13 遍 ——
 * 有的用 `${file}.tmp`（并发写会互相顶掉对方半成品 → 偶发丢配置），
 * 有的干脆直接 `writeFileSync` 覆盖（断电/异常时留下半截 JSON，下次启动解析失败）。
 *
 * 纪律：
 * - 临时名必须唯一（pid + uuid），否则两个进程同时写同一目标必然互相破坏；
 * - 只 rename，不「先删再写」——rename 是同目录内的原子替换，读侧要么旧要么新；
 * - rename 失败（Windows 上杀软/索引服务持有目标文件 → EPERM/EBUSY）指数退避重试；
 * - 任何失败路径都要清掉临时文件，别在数据目录里留垃圾。
 */

/** 唯一临时名（与 JsonStore/secrets 历史口径一致） */
export function tempNameFor(file: string): string {
  return `${file}.${process.pid}-${randomUUID()}.tmp`
}

/** 值得重试的 rename 错误码：都是「目标暂时被占用」这一类，等几十毫秒通常就好了 */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST'])

export interface AtomicWriteOptions {
  /** 退避重试次数，默认 3（合计最多 4 次尝试） */
  retries?: number
  /** 首次退避毫秒数，按 2 倍递增，默认 10 */
  baseDelayMs?: number
  /** 失败时是否抛出（默认 true）；false 时返回 false 并把失败原因交给调用方 */
  throwOnError?: boolean
  /**
   * D4（PERF-MEM-REVIEW-2026-09-29 §4.2）：写完临时文件后是否 fsync，默认 **true**。
   *
   * 为什么默认要开：断电时可能「rename 已持久化、数据还在页缓存里」，
   * 目标文件变成 0 字节 / 半截 —— 而 rename 原子只保证「要么旧要么新」，
   * 不保证新内容已经落盘（见下面 `atomicWriteFileSync` 里的注释）。
   *
   * 什么时候可以关：**这份文件能从别处重建**的派生数据。
   * 典型是会话树索引（`sessions-index.json`，真相在 `tree-*.jsonl`）——
   * 它一天被写上百次，而 Windows 上 `fsyncSync` 是 `FlushFileBuffers`，
   * 单次 0.1~数 ms，杀软扫描时可达数十 ms，且**整个主进程同步阻塞**
   * （主进程同时在跑 telnet/SSH、工具执行、渲染层 IPC）。
   * 丢了就重建，最坏是「会话列表顺序/条数滞后一次」。
   *
   * 纪律：**不得**因此新增第二套写盘实现 —— 仍走这一个函数，只切这个开关。
   */
  fsync?: boolean
}

/** 同步退避等待：写盘是同步路径，没法 await；单次最多几十毫秒 */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* 兜底忙等 */
    }
  }
}

/**
 * 原子写文本 / 字节。返回是否成功（`throwOnError: true` 时失败直接抛）。
 *
 * data 接受 string（按 UTF-8 写）或 Uint8Array / Buffer（原样写，
 * 供 .topo 这类需要 utf16le 等非 UTF-8 编码的落盘点使用）。
 */
export function atomicWriteFileSync(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {}
): boolean {
  const retries = Math.max(0, options.retries ?? 3)
  // D4：首次退避从 10ms 降到 2ms。
  // sleepSync 用 Atomics.wait —— 那是**整个进程硬阻塞**（不只是这个调用栈），
  // 而 Windows 上 rename 撞 EPERM/EBUSY 是常态（杀软 / 索引服务 / 资源管理器
  // 预览），不是理论风险。原来最坏退避 10+20+40 = 70ms 主进程完全冻结，
  // 改后 2+4+8 = 14ms。3 次重试的总等待只从 70ms 降到 14ms，
  // 而「等 10ms 就能解锁」这种假设本来就不成立 —— 持有者释放通常要几十 ms，
  // 真正起效的是重试**次数**而不是单次时长。
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 2)

  const tmp = tempNameFor(file)
  let lastError: unknown = null
  try {
    // mkdir 也放在 try 里：父路径不可用时它同样会抛，
    // 而 throwOnError:false 的调用方要的是「返回 false」而不是被异常打断
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // N40：写临时文件后必须 fsync 再 rename。否则断电时可能「rename 已持久化、数据未落盘」，
    // 目标文件变成 0 字节 / 半截 JSON —— 而 rename 是原子的这件事只保证「要么旧要么新」，
    // 不保证新内容已经落盘。父目录 fsync 在 Windows 上不受支持（可忽略），属已知限制。
    // D4：`fsync: false` 时跳过 —— 只给「能从别处重建的派生数据」用（见选项注释）。
    const wantFsync = options.fsync !== false
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, data)
      if (wantFsync) fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file)
        break
      } catch (e) {
        lastError = e
        const code = (e as NodeJS.ErrnoException).code
        if (attempt >= retries || !code || !RETRYABLE_CODES.has(code)) break
        sleepSync(baseDelayMs * 2 ** attempt)
      }
    }
  } catch (e) {
    lastError = e
  } finally {
    // 成功时 tmp 已被 rename 掉，这里只是失败路径的清理（force 忽略不存在）
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
  }

  if (lastError === null) return true
  if (options.throwOnError === false) return false
  throw lastError instanceof Error ? lastError : new Error(`原子写失败：${file}`)
}

/** 原子写 JSON（缩进 2，与历史落盘格式一致） */
export function atomicWriteJsonSync(
  file: string,
  value: unknown,
  options: AtomicWriteOptions = {}
): boolean {
  return atomicWriteFileSync(file, JSON.stringify(value, null, 2), options)
}
