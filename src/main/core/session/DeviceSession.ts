import type { CommandResult, Device, DeviceId, Encoding, ViewKind } from '@shared/types'
import { TelnetClient, type ConnectResult, type TelnetClientOptions } from '../telnet/TelnetClient'

/**
 * 单个设备的会话。
 *
 * 职责边界：
 * - 持有 TelnetClient（通信）
 * - 维护设备元数据（别名、型号、当前视图、编码）
 * - 把原始字节流广播给渲染层，并标注该段输出是否由代理触发
 *
 * 并发的唯一收敛点在 TelnetClient 的队列里 —— 本类不引入第二条写入路径。
 */

export interface SessionDeps {
  onRaw: (deviceId: DeviceId, chunk: Uint8Array, fromAgent: boolean) => void
  onClosed: (deviceId: DeviceId, reason: string) => void
  onStateChanged: (device: Device) => void
}

export function deviceIdOf(port: number): DeviceId {
  return `127.0.0.1:${port}`
}

export function portOf(deviceId: DeviceId): number {
  return Number.parseInt(deviceId.split(':')[1] ?? '', 10)
}

interface VersionInfo {
  model?: string
  vrpVersion?: string
}

/**
 * 从 `display version` 回显中解析型号与 VRP 版本。
 * 典型行长：VRP (R) software, Version 5.170 (AR2220 V300R003C00SPC200)
 */
export function parseVersion(text: string): VersionInfo {
  const m = /Version\s+([\w.]+)\s*\(([^)]+)\)/i.exec(text)
  if (m) {
    const model = m[2]!.trim().split(/\s+/)[0]
    return { model, vrpVersion: m[1] }
  }
  const only = /VRP\s*\(R\)\s*software,\s*Version\s+([\w.]+)/i.exec(text)
  return only ? { vrpVersion: only[1] } : {}
}

export class DeviceSession {
  readonly id: DeviceId
  readonly port: number

  name: string
  model?: string
  vrpVersion?: string
  view: ViewKind = 'other'
  encoding: Encoding = 'utf8'
  lastSeenAt = Date.now()

  private client: TelnetClient
  private closed = false
  /** >0 表示当前正在执行代理下发的命令，用于给原始流打标记 */
  private agentDepth = 0
  private unsubscribeRaw: () => void
  private unsubscribeClose: () => void

  private constructor(
    port: number,
    name: string,
    client: TelnetClient,
    private readonly deps: SessionDeps
  ) {
    this.port = port
    this.id = deviceIdOf(port)
    this.name = name
    this.client = client

    this.unsubscribeRaw = client.onRawData((chunk) => {
      this.lastSeenAt = Date.now()
      deps.onRaw(this.id, chunk, this.agentDepth > 0)
    })
    this.unsubscribeClose = client.onClose((reason) => {
      this.closed = true
      deps.onClosed(this.id, reason)
    })
  }

  static async open(
    port: number,
    name: string,
    opts: TelnetClientOptions,
    deps: SessionDeps
  ): Promise<{ session: DeviceSession; info: ConnectResult }> {
    const client = new TelnetClient(opts)
    const info = await client.connect(port)
    const session = new DeviceSession(port, name, client, deps)
    session.encoding = info.encoding
    session.view = info.prompt.view
    return { session, info }
  }

  get isClosed(): boolean {
    return this.closed
  }

  get queueLength(): number {
    return this.client.queueLength
  }

  /** 程序通道：代理与工具走这里 */
  async exec(
    command: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<CommandResult> {
    this.agentDepth++
    try {
      const result = await this.client.exec(command, opts)
      this.view = result.view
      this.lastSeenAt = Date.now()
      this.deps.onStateChanged(this.toDevice())
      return result
    } finally {
      this.agentDepth--
    }
  }

  /** 交互通道：xterm 终端走这里 */
  writeInteractive(data: string): { accepted: boolean; queued: boolean } {
    const r = this.client.writeInteractive(data)
    if (r.accepted && !r.queued) this.view = this.view
    return r
  }

  /** 探测并缓存型号 / VRP 版本。失败不致命，只是拿不到默认别名建议 */
  async probeVersion(): Promise<VersionInfo> {
    try {
      const r = await this.exec('display version', { timeoutMs: 8000 })
      if (!r.ok) return {}
      const info = parseVersion(r.clean)
      if (info.model) this.model = info.model
      if (info.vrpVersion) this.vrpVersion = info.vrpVersion
      this.deps.onStateChanged(this.toDevice())
      return info
    } catch {
      return {}
    }
  }

  toDevice(): Device {
    return {
      id: this.id,
      port: this.port,
      name: this.name,
      connected: !this.closed,
      ...(this.model ? { model: this.model } : {}),
      ...(this.vrpVersion ? { vrpVersion: this.vrpVersion } : {}),
      view: this.view,
      encoding: this.encoding,
      lastSeenAt: this.lastSeenAt
    }
  }

  close(): void {
    this.unsubscribeRaw()
    this.unsubscribeClose()
    this.client.close()
    this.closed = true
  }
}
