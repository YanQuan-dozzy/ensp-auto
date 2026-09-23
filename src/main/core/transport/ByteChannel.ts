import net from 'node:net'

/**
 * 字节管道 —— 通信层对「传输层」的抽象。
 *
 * Telnet 与 SSH 的 CLI 交互本质相同：写一串字节、读回一段文本。
 * 上层（TelnetClient 的状态机/队列/清洗/编码）只依赖这个接口，
 * 因此 SSH 接入不需要复制任何状态机代码，只需适配接口。
 *
 * 两个落点：
 * - connectTcp()：node:net 直连（eNSP 的 telnet 服务，原 TelnetClient 行为）
 * - connectSsh()（SshChannel.ts）：ssh2 shell 通道
 */

export interface ByteChannel {
  /** 写字节。返回背压布尔（true = 缓冲有余量），与 socket.write 语义一致 */
  write(data: Uint8Array): boolean
  /** 是否仍可写（握手唤醒等场景需要判断，对应 socket.writable） */
  writable: boolean
  /** 关闭通道（幂等）。SSH 场景下会连带 client.end() 收掉会话 */
  destroy(): void
  /** 订阅数据；返回退订函数 */
  onData(cb: (chunk: Uint8Array) => void): () => void
  onClose(cb: () => void): () => void
  onError(cb: (err: Error) => void): () => void
}

class SocketChannel implements ByteChannel {
  constructor(private readonly sock: net.Socket) {}

  write(data: Uint8Array): boolean {
    if (this.sock.destroyed) return false
    return this.sock.write(data)
  }

  get writable(): boolean {
    return this.sock.writable
  }

  destroy(): void {
    this.sock.destroy()
  }

  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.sock.on('data', cb as (chunk: Buffer) => void)
    return () => this.sock.off('data', cb as never)
  }

  onClose(cb: () => void): () => void {
    this.sock.on('close', cb)
    return () => this.sock.off('close', cb)
  }

  onError(cb: (err: Error) => void): () => void {
    this.sock.on('error', cb)
    return () => this.sock.off('error', cb)
  }
}

/**
 * 建立 TCP 字节管道（telnet 传输）。
 * connect / timeout / error 收敛为一个 Promise：失败 reject，成功返回可用通道。
 */
export function connectTcp(host: string, port: number, timeoutMs: number): Promise<ByteChannel> {
  return new Promise<ByteChannel>((resolve, reject) => {
    const sock = net.createConnection({ host, port })
    sock.setNoDelay(true)
    let settled = false
    const fail = (e: Error): void => {
      if (settled) return
      settled = true
      sock.removeAllListeners()
      sock.destroy()
      reject(e)
    }
    const done = (): void => {
      if (settled) return
      settled = true
      sock.off('error', onErr)
      resolve(new SocketChannel(sock))
    }
    const onErr = (e: Error): void => fail(new Error(`连接错误：${e.message}`))
    sock.setTimeout(timeoutMs)
    sock.once('timeout', () => fail(new Error(`连接超时（${timeoutMs}ms）`)))
    sock.once('error', onErr)
    sock.once('connect', done)
  })
}