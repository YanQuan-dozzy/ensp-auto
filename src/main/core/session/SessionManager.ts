import net from 'node:net'
import type { Device, DeviceId, Settings } from '@shared/types'
import {
  DEFAULT_TELNET_HOST,
  deviceIdForSsh,
  deviceIdForTelnet,
  parseDeviceId,
  type DeviceTarget
} from '@shared/transport'
import { DEFAULT_HOST } from '../telnet/patterns'
import { openChannel, type SshTarget } from '../transport'
import type { JsonStore } from '../store/store'
import { DeviceSession, deviceIdOf, type SessionDeps } from './DeviceSession'

export interface ScanProgress {
  scanned: number
  total: number
  found: number
  done: boolean
}

export interface ScanOptions {
  onProgress?: (p: ScanProgress) => void
  signal?: AbortSignal
  concurrency?: number
  timeoutMs?: number
}

/** 单端口探测。只连 127.0.0.1，主机地址不接受外部传入 */
export function probePort(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ host: DEFAULT_HOST, port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      sock.removeAllListeners()
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/**
 * 扫描端口区间。并发受限，避免 51 个端口同时发起连接把本机端口表打爆；
 * 每完成一个就回报进度，让 UI 能实时显示「已扫 12/51」。
 */
export async function scanPorts(
  start: number,
  end: number,
  opts: ScanOptions = {}
): Promise<number[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 24, 64))
  const timeoutMs = opts.timeoutMs ?? 400
  const ports: number[] = []
  for (let p = start; p <= end; p++) ports.push(p)

  const total = ports.length
  const found: number[] = []
  let scanned = 0
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) return
      const index = cursor++
      if (index >= total) return
      const port = ports[index]!
      const ok = await probePort(port, timeoutMs)
      scanned++
      if (ok) found.push(port)
      opts.onProgress?.({ scanned, total, found: found.length, done: false })
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))
  found.sort((a, b) => a - b)
  opts.onProgress?.({ scanned, total, found: found.length, done: true })
  return found
}

export interface SessionManagerHooks extends SessionDeps {
  getSettings: () => Settings
}

/** 设备任务锁的持有信息（用于 DEVICE_BUSY 报错文案与测试断言） */
export interface DeviceLockInfo {
  owner: string
  acquiredAt: number
  /** 已持有毫秒数 */
  heldMs: number
}

/**
 * 设备任务锁的持有上限（决策 P4 = 10 分钟，覆盖最长任务）。
 *
 * 超过即视为「异常路径把锁漏在这了」（进程内抛错、abort 都会走 finally，
 * 只有真正的 bug 才会漏），于是下一次争抢时强制释放并告警 ——
 * 宁可冒一次极小的并发风险，也不要把设备永久锁死到重启为止。
 */
export const DEVICE_LOCK_TTL_MS = 10 * 60 * 1000

/**
 * 会话注册表。
 *
 * 维护「已知设备」与「已连接会话」两张表：
 * - 已知设备来自扫描结果 + 持久化的别名，断开后依然保留（设备还在那儿）
 * - 已连接会话持有真实 socket，断开即销毁
 */
export class SessionManager {
  private sessions = new Map<DeviceId, DeviceSession>()
  private known = new Map<DeviceId, Device>()
  private connecting = new Set<DeviceId>()
  /** 用户主动断开的设备，扫描时不应自动重连 */
  private ignored = new Set<DeviceId>()
  /**
   * 设备级任务锁（D6，2026-09-23）。
   *
   * 为什么「命令队列已串行」还不够：`apply_config` 这类工具是**多步事务**
   * （进系统视图 → 逐条下发 → 期望校验），而 TelnetClient 的队列粒度是**单条命令**。
   * 同一台物理设备上两个会话各跑一个事务时，命令会交错（A 的 system-view + B 的 dhcp enable
   * 相互插队），视图栈错乱，而且**两边都报成功**。
   *
   * 注意：owner 只是工具名（如 `apply_config`），**不做重入** ——
   * 两个并发 apply_config 的 owner 完全相同，重入语义会把互斥锁整个架空
   * （施工时实测踩过：加 depth 后第二个并发事务照样进来）。真正的嵌套调用
   * （execute_task → apply_config）是顺序复用而非并发嵌套，无需重入。
   */
  private deviceLocks = new Map<DeviceId, { owner: string; acquiredAt: number }>()

  constructor(
    private readonly store: JsonStore,
    private readonly hooks: SessionManagerHooks
  ) {}

  private baseDeviceForTarget(target: DeviceTarget): Device {
    const id =
      target.transport === 'ssh'
        ? deviceIdForSsh(target.host, target.port)
        : deviceIdForTelnet(target.port)
    const alias = this.store.getAlias(id)
    const existing = this.known.get(id)
    if (existing) {
      return { ...existing, name: alias ?? existing.name }
    }
    return {
      id,
      port: target.port,
      name: alias ?? String(target.port),
      transport: target.transport,
      connected: false,
      encoding: 'utf8',
      lastSeenAt: Date.now()
    }
  }

  private telnetTarget(port: number): DeviceTarget {
    return { transport: 'telnet', host: DEFAULT_TELNET_HOST, port }
  }

  async scan(start: number, end: number, opts: ScanOptions = {}): Promise<Device[]> {
    const ports = await scanPorts(start, end, opts)
    for (const port of ports) {
      this.known.set(deviceIdOf(port), this.baseDeviceForTarget(this.telnetTarget(port)))
    }
    return ports.map((p) => this.known.get(deviceIdOf(p))!)
  }

  async connect(port: number, name?: string): Promise<Device> {
    const id = deviceIdOf(port)
    const existing = this.sessions.get(id)
    if (existing && !existing.isClosed) return existing.toDevice()
    if (this.connecting.has(id)) throw new Error('该设备正在连接中')

    this.connecting.add(id)
    try {
      const settings = this.hooks.getSettings()
      const alias =
        name ?? this.store.getAlias(id) ?? this.baseDeviceForTarget(this.telnetTarget(port)).name
      const { session, info } = await DeviceSession.open(
        port,
        alias,
        {
          encoding: settings.deviceEncoding === 'auto' ? 'auto' : settings.deviceEncoding
        },
        this.hooks
      )
      this.sessions.set(id, session)
      this.known.set(id, session.toDevice())
      this.ignored.delete(id)
      this.store.rememberPort(port)
      if (!this.store.getAlias(id) && info.prompt.host && info.prompt.host !== id) {
        // 用设备宿主名作为初始别名，比端口号可读得多
        this.store.setAlias(id, info.prompt.host)
        session.name = info.prompt.host
      }
      this.hooks.onStateChanged(session.toDevice())
      return session.toDevice()
    } finally {
      this.connecting.delete(id)
    }
  }

  /**
   * 建立 SSH 会话。host/port 由用户显式指定（可任意主机），认证载荷走 ssh2。
   * 幂等：同 host:port 已连则不重复建。
   */
  async connectSsh(
    target: SshTarget & { name?: string; credentialId?: string; timeoutMs?: number }
  ): Promise<Device> {
    const deviceTarget: DeviceTarget = { transport: 'ssh', host: target.host, port: target.port }
    const id = deviceIdForSsh(target.host, target.port)
    const existing = this.sessions.get(id)
    if (existing && !existing.isClosed) return existing.toDevice()
    if (this.connecting.has(id)) throw new Error('该设备正在连接中')

    this.connecting.add(id)
    try {
      const settings = this.hooks.getSettings()
      const alias =
        target.name ?? this.store.getAlias(id) ?? this.baseDeviceForTarget(deviceTarget).name
      const ch = await openChannel(deviceTarget, {
        timeoutMs: target.timeoutMs ?? 20000,
        ssh: { host: target.host, port: target.port, username: target.username, auth: target.auth }
      })
      const { session, info } = await DeviceSession.fromChannel(
        ch,
        deviceTarget,
        alias,
        { encoding: settings.deviceEncoding === 'auto' ? 'auto' : settings.deviceEncoding },
        this.hooks,
        target.credentialId
      )
      this.sessions.set(id, session)
      this.known.set(id, session.toDevice())
      this.ignored.delete(id)
      if (!this.store.getAlias(id) && info.prompt.host && info.prompt.host !== id) {
        this.store.setAlias(id, info.prompt.host)
        session.name = info.prompt.host
      }
      this.hooks.onStateChanged(session.toDevice())
      return session.toDevice()
    } finally {
      this.connecting.delete(id)
    }
  }

  /** 连接后异步补一次型号探测，不阻塞连接返回 */
  async probeDevice(deviceId: DeviceId): Promise<Device | undefined> {
    const session = this.sessions.get(deviceId)
    if (!session) return undefined
    const info = await session.probeVersion()
    if (info.model) {
      const current = this.store.getAlias(deviceId)
      // 别名还是端口号/宿主名时，用型号替换为更直观的默认名
      if (!current || /^\d+$/.test(current) || current === 'Huawei') {
        this.store.setAlias(deviceId, `${info.model}-${session.port}`)
        session.name = `${info.model}-${session.port}`
      }
      this.hooks.onStateChanged(session.toDevice())
    }
    return session.toDevice()
  }

  disconnect(deviceId: DeviceId): void {
    const session = this.sessions.get(deviceId)
    if (session) {
      this.ignored.add(deviceId)
      session.close()
      this.sessions.delete(deviceId)
    }
    // 断开即放弃该设备的任务锁：否则锁会挂在一台已不存在的会话上直到 TTL
    this.deviceLocks.delete(deviceId)
    const known = this.known.get(deviceId)
    if (known) this.known.set(deviceId, { ...known, connected: false })
    const device = this.known.get(deviceId)
    if (device) this.hooks.onStateChanged(device)
  }

  rename(deviceId: DeviceId, name: string): Device | undefined {
    const trimmed = name.trim()
    if (!trimmed) return undefined
    this.store.setAlias(deviceId, trimmed)
    const session = this.sessions.get(deviceId)
    if (session) session.name = trimmed
    const target = parseDeviceId(deviceId)
    const known =
      this.known.get(deviceId) ?? (target ? this.baseDeviceForTarget(target) : undefined)
    if (!known) return undefined
    const next: Device = { ...known, name: trimmed, connected: !!session && !session.isClosed }
    this.known.set(deviceId, next)
    this.hooks.onStateChanged(next)
    return next
  }

  /**
   * 从设备列表中移除（右键删除）：断开会话 + 丢弃已知条目 + 清除持久化别名。
   * 不做任何广播 —— 设备从 list() 消失即视为删除，由渲染层自行刷新；
   * 若在这里发 state-changed，渲染层的合并逻辑会把设备加回去。
   * 下次扫描仍可能重新发现该端口（删除 ≠ 永久屏蔽）。
   */
  forget(deviceId: DeviceId): void {
    const session = this.sessions.get(deviceId)
    if (session) {
      this.ignored.add(deviceId)
      session.close()
      this.sessions.delete(deviceId)
    }
    this.deviceLocks.delete(deviceId)
    this.known.delete(deviceId)
    this.store.removeAlias(deviceId)
  }

  list(): Device[] {
    return [...this.known.values()]
      .map((d) => {
        const s = this.sessions.get(d.id)
        return s && !s.isClosed ? s.toDevice() : { ...d, connected: false }
      })
      .sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1
        const pa = parseDeviceId(a.id)?.port ?? a.port
        const pb = parseDeviceId(b.id)?.port ?? b.port
        return pa - pb
      })
  }

  get(deviceId: DeviceId): DeviceSession | undefined {
    const s = this.sessions.get(deviceId)
    return s && !s.isClosed ? s : undefined
  }

  require(deviceId: DeviceId): DeviceSession {
    const s = this.get(deviceId)
    if (!s) throw new Error(`设备未连接：${deviceId}`)
    return s
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close()
    this.sessions.clear()
    this.deviceLocks.clear()
  }

  // ———————————————————————— 设备任务锁（D6） ————————————————————————

  /**
   * 抢占设备任务锁。已被持有（含被同一 owner 名）返回 false；持有超过
   * DEVICE_LOCK_TTL_MS 视为异常泄漏，强制释放并告警。
   */
  tryAcquireDevice(deviceId: DeviceId, owner: string): boolean {
    const cur = this.deviceLocks.get(deviceId)
    if (cur) {
      const heldMs = Date.now() - cur.acquiredAt
      if (heldMs <= DEVICE_LOCK_TTL_MS) return false
      console.warn(
        `[session] 设备 ${deviceId} 的任务锁已被 ${cur.owner} 持有 ${Math.round(heldMs / 1000)}s，超过上限（${DEVICE_LOCK_TTL_MS / 1000}s），强制释放`
      )
      this.deviceLocks.delete(deviceId)
    }
    this.deviceLocks.set(deviceId, { owner, acquiredAt: Date.now() })
    return true
  }

  /** 释放自己持有的锁；不是持有者则忽略（避免误放别人的锁） */
  releaseDevice(deviceId: DeviceId, owner: string): void {
    const cur = this.deviceLocks.get(deviceId)
    if (cur && cur.owner === owner) this.deviceLocks.delete(deviceId)
  }

  /** 当前持有者信息（无锁返回 undefined），供 DEVICE_BUSY 文案与测试使用 */
  deviceLockHolder(deviceId: DeviceId): DeviceLockInfo | undefined {
    const cur = this.deviceLocks.get(deviceId)
    if (!cur) return undefined
    return { owner: cur.owner, acquiredAt: cur.acquiredAt, heldMs: Date.now() - cur.acquiredAt }
  }
}
