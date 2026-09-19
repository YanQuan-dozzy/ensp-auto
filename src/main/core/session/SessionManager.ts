import net from 'node:net'
import type { Device, DeviceId, Settings } from '@shared/types'
import { DEFAULT_HOST } from '../telnet/patterns'
import type { JsonStore } from '../store/store'
import { DeviceSession, deviceIdOf, portOf, type SessionDeps } from './DeviceSession'

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

  constructor(
    private readonly store: JsonStore,
    private readonly hooks: SessionManagerHooks
  ) {}

  private baseDevice(port: number): Device {
    const id = deviceIdOf(port)
    const alias = this.store.getAlias(id)
    const existing = this.known.get(id)
    if (existing) {
      return { ...existing, name: alias ?? existing.name }
    }
    return {
      id,
      port,
      name: alias ?? String(port),
      connected: false,
      encoding: 'utf8',
      lastSeenAt: Date.now()
    }
  }

  async scan(start: number, end: number, opts: ScanOptions = {}): Promise<Device[]> {
    const ports = await scanPorts(start, end, opts)
    for (const port of ports) {
      this.known.set(deviceIdOf(port), this.baseDevice(port))
    }
    const settings = this.hooks.getSettings()
    const enc = settings.deviceEncoding === 'auto' ? 'auto' : settings.deviceEncoding
    void enc
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
      const alias = name ?? this.store.getAlias(id) ?? this.baseDevice(port).name
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
    const known = this.known.get(deviceId) ?? this.baseDevice(portOf(deviceId))
    const next: Device = { ...known, name: trimmed, connected: !!session && !session.isClosed }
    this.known.set(deviceId, next)
    this.hooks.onStateChanged(next)
    return next
  }

  list(): Device[] {
    return [...this.known.values()]
      .map((d) => {
        const s = this.sessions.get(d.id)
        return s && !s.isClosed ? s.toDevice() : { ...d, connected: false }
      })
      .sort((a, b) => (a.connected === b.connected ? a.port - b.port : a.connected ? -1 : 1))
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
  }
}
