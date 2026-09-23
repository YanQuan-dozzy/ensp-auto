import type { CommandResult, Device, DeviceId, Encoding, ViewKind } from '@shared/types'
import { deviceIdForSsh, parseDeviceId, type DeviceTarget, type Transport } from '@shared/transport'
import { type ByteChannel } from '../transport/ByteChannel'
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
  return parseDeviceId(deviceId)?.port ?? Number.NaN
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
  readonly transport: Transport

  name: string
  model?: string
  vrpVersion?: string
  view: ViewKind = 'other'
  encoding: Encoding = 'utf8'
  lastSeenAt = Date.now()
  /** ssh 且「保存此连接」时指向加密条目；会话断开不删除，供下次重连 */
  sshCredentialId?: string

  private client: TelnetClient
  private closed = false
  /** >0 表示当前正在执行代理下发的命令，用于给原始流打标记 */
  private agentDepth = 0
  private unsubscribeRaw: () => void
  private unsubscribeClose: () => void

  private constructor(
    port: number,
    id: DeviceId,
    transport: Transport,
    name: string,
    client: TelnetClient,
    private readonly deps: SessionDeps
  ) {
    this.port = port
    this.id = id
    this.transport = transport
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

  /** telnet 会话：按端口直连 */
  static async open(
    port: number,
    name: string,
    opts: TelnetClientOptions,
    deps: SessionDeps
  ): Promise<{ session: DeviceSession; info: ConnectResult }> {
    const client = new TelnetClient(opts)
    const info = await client.connect(port)
    const session = new DeviceSession(port, deviceIdOf(port), 'telnet', name, client, deps)
    session.encoding = info.encoding
    session.view = info.prompt.view
    return { session, info }
  }

  /** ssh 会话：接收已就绪的字节管道完成握手 */
  static async fromChannel(
    ch: ByteChannel,
    target: DeviceTarget,
    name: string,
    opts: TelnetClientOptions,
    deps: SessionDeps,
    sshCredentialId?: string
  ): Promise<{ session: DeviceSession; info: ConnectResult }> {
    const client = new TelnetClient(opts)
    const info = await client.connectChannel(ch)
    const session = new DeviceSession(
      target.port,
      deviceIdForSsh(target.host, target.port),
      'ssh',
      name,
      client,
      deps
    )
    session.encoding = info.encoding
    session.view = info.prompt.view
    session.sshCredentialId = sshCredentialId
    return { session, info }
  }

  get isClosed(): boolean {
    return this.closed
  }

  get queueLength(): number {
    return this.client.queueLength
  }

  /**
   * 设备是否正停在 [Y/N] / 认证提示上（通信层队列已挂起）。
   *
   * 这是 `answer_device_prompt` 的前置条件：只有挂起时「下一条命令」才会被设备
   * 当作对该提示的回答，否则只是下发了一条普通命令（会把 `y` 打进系统视图）。
   */
  get isAwaitingConfirm(): boolean {
    return this.client.isAwaitingConfirm
  }

  /** 挂起中的确认提示原文（无挂起时为空串） */
  get awaitingConfirmText(): string {
    return this.client.awaitingConfirmText
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
    // v1.8：删除无意义的自赋值（`this.view = this.view`）—— 交互态下 view 由客户端
    // 内部状态机维护，exec 的 view 快照只对命令通道有意义
    return this.client.writeInteractive(data)
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
      transport: this.transport,
      ...(this.sshCredentialId ? { sshCredentialId: this.sshCredentialId } : {}),
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
