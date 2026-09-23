// ssh2 是 CJS 包：命名导入会被 Node 的 ESM-CJS interop 拒绝（cjs-module-lexer 识别不了
// 它的导出形态），运行时必须走 default import 再解构；类型层面 @types/ssh2 可用命名导入。
import ssh2 from 'ssh2'
import type { ClientChannel } from 'ssh2'
import type { ByteChannel } from './ByteChannel'

// Client 是 CJS 解构出来的运行期值（typeof Client 才是它的构造器类型），
// 实例类型用 InstanceType 推导，避免「值被当类型用」的 TS2749 报错
const { Client } = ssh2
type SshClient = InstanceType<typeof Client>

/**
 * SSH 传输通道 —— 用 ssh2 的 shell 通道适配 ByteChannel。
 *
 * 硬约束：复用 TelnetClient 全部状态机（队列/提示符/分页/编码/清洗），
 * 这里只负责「把 ssh2 的 Client + Channel 生命周期桥接成字节管道」。
 *
 * 生命周期要点：
 * - 握手期（ready / shell 就绪前）的任何 error / 超时都 reject，不落到 channel；
 * - shell 就绪后，stream 的 data/close/error 与 client 的 error/close 全部桥到
 *   接口回调 —— 否则远端断开后 TelnetClient 挂着的握手/命令定时器永不结算；
 * - destroy() 幂等：先关 shell 流再 client.end()，把 SSH 会话连同收掉。
 */

export interface SshConnectConfig {
  host: string
  port: number
  username: string
  auth:
    | { type: 'password'; password: string }
    | { type: 'privateKey'; key: string; passphrase?: string }
  /** ssh2 readyTimeout，默认 20000ms */
  readyTimeoutMs?: number
}

class SshChannel implements ByteChannel {
  private stream: ClientChannel | null = null
  closed = false

  constructor(private readonly client: SshClient) {}

  attach(stream: ClientChannel): void {
    this.stream = stream
  }

  write(data: Uint8Array): boolean {
    if (!this.stream || this.stream.destroyed || this.closed) return false
    return this.stream.write(data)
  }

  get writable(): boolean {
    return !!this.stream && !this.stream.destroyed && !this.closed
  }

  destroy(): void {
    if (this.closed) return
    this.closed = true
    this.teardown()
  }

  /**
   * 幂等收尾：先关 shell 流再 client.end()，把 SSH 会话连同 keepalive 定时器一并收掉。
   *
   * 必须与 destroy() 的「已关闭」判断解耦 —— 远端先断开时 onClose 会把 closed 置真，
   * 若这时再调 destroy() 只会命中早退分支，client.end() 永不执行，
   * ssh2 的 TCP 连接与 keepaliveInterval 定时器就会一直挂着（进程无法退出）。
   */
  private teardown(): void {
    try {
      this.stream?.end()
    } catch {
      /* 忽略 */
    }
    try {
      this.client.end()
    } catch {
      /* 忽略 */
    }
  }

  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.stream?.on('data', cb as (chunk: Buffer) => void)
    return () => this.stream?.off('data', cb as never)
  }

  onClose(cb: () => void): () => void {
    const wrapped = (): void => {
      if (this.closed) return
      this.closed = true
      // 远端先断开时也要收掉本地这半条连接，否则 socket 与 keepalive 定时器会泄漏
      this.teardown()
      cb()
    }
    this.stream?.on('close', wrapped)
    this.client.on('close', wrapped)
    return () => {
      this.stream?.off('close', wrapped)
      this.client.off('close', wrapped)
    }
  }

  onError(cb: (err: Error) => void): () => void {
    this.stream?.on('error', cb)
    this.client.on('error', cb)
    return () => {
      this.stream?.off('error', cb)
      this.client.off('error', cb)
    }
  }
}

export function connectSsh(cfg: SshConnectConfig): Promise<ByteChannel> {
  const client = new Client()
  const ch = new SshChannel(client)
  const readyTimeoutMs = cfg.readyTimeoutMs ?? 20000

  return new Promise<ByteChannel>((resolve, reject) => {
    let handshakeDone = false
    // 握手期错误：reject 而不是桥接（此时还没有任何上层消费者）
    const onHandshakeError = (err: Error): void => {
      if (handshakeDone) return
      handshakeDone = true
      try {
        client.end()
      } catch {
        /* 忽略 */
      }
      reject(err)
    }

    client.on('error', onHandshakeError)
    client.on('ready', () => {
      // 不带 pty：VRP 的 SSH 交互 shell 是纯 line mode，与 telnet 行为一致。
      // 注意 ssh2 的 shell() 签名是 shell(wndopts, opts, cb) —— 只要 wndopts !== false
      // 就会默认请求 pty，所以必须显式传 false 跳过。
      client.shell(false, (err, stream) => {
        if (err) {
          onHandshakeError(err)
          return
        }
        if (!stream) {
          onHandshakeError(new Error('SSH shell 通道未建立'))
          return
        }
        if (handshakeDone) {
          // 竞态：握手期已被 reject/销毁，立即收掉刚打开的流
          try {
            stream.end()
          } catch {
            /* 忽略 */
          }
          return
        }
        handshakeDone = true
        ch.attach(stream)
        resolve(ch)
      })
    })

    const base: Record<string, unknown> = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      readyTimeout: readyTimeoutMs,
      keepaliveInterval: 10000
    }
    if (cfg.auth.type === 'password') {
      base.password = cfg.auth.password
    } else {
      base.privateKey = cfg.auth.key
      if (cfg.auth.passphrase) base.passphrase = cfg.auth.passphrase
    }
    try {
      client.connect(base)
    } catch (e) {
      onHandshakeError(e instanceof Error ? e : new Error(String(e)))
    }
  })
}