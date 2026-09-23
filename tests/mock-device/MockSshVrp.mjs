import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
// ssh2 是 CJS：Node ESM 不识别其命名导出，必须 default import 再解构
import ssh2 from 'ssh2'
import { MockVrp, GBK_ZHONGWEN } from './MockVrp.mjs'

export { GBK_ZHONGWEN }

const { Server } = ssh2

/**
 * 可编程 Mock VRP 设备（SSH 版）。
 *
 * 与 MockVrp 同构：行为（banner / 分页 / 错误 / [Y/N] / GBK / 慢响应 / 断线）
 * 全部复用父类的 handle() —— ssh2 的 shell 通道是 Duplex stream，
 * 与 net.Socket 的 data/write/close/destroy API 兼容，因此发收逻辑零拷贝。
 *
 * 认证走 ssh2 Server 层（真实 SSH 握手）：
 * - password：校验预置 username/password
 * - publickey：无条件 accept（覆盖「客户端能解析私钥 + passphrase + 完成认证」链路；
 *   服务端不验签属刻意简化 —— 被断言的是客户端侧实现）
 *
 * 需要 host key：启动时生成一次 RSA 密钥对（内存态，不落盘）。
 */
export class MockSshVrp extends MockVrp {
  constructor(opts = {}) {
    super({ ...opts, requireAuth: false })
    this.expectedUser = opts.username ?? 'admin'
    this.expectedPassword = opts.password ?? '123456'
    this.expectedKeyPassphrase = opts.keyPassphrase ?? null
    this.server = null
    this.port = 0
    // 记录认证方式，测试断言用
    this.authMethod = null
    this.authUser = null
    this.hostKey = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({
      type: 'pkcs1',
      format: 'pem'
    })
  }

  async listen() {
    this.server = new Server({ hostKeys: [this.hostKey] }, (client) => {
      client.on('error', () => {})
      client.on('authentication', (ctx) => {
        const method = ctx.method
        if (method === 'password') {
          if (ctx.username === this.expectedUser && ctx.password === this.expectedPassword) {
            this.authMethod = 'password'
            this.authUser = ctx.username
            ctx.accept()
          } else {
            ctx.reject(['publickey', 'password'])
          }
          return
        }
        if (method === 'publickey') {
          // 两阶段（key 探测/验签）一律接受：断言的是客户端拿私钥完成认证
          this.authMethod = 'publickey'
          this.authUser = ctx.username
          ctx.accept()
          return
        }
        ctx.reject(['publickey', 'password'])
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('pty-req', (acceptPty) => acceptPty?.(true))
          session.on('shell', (acceptShell) => {
            const stream = acceptShell()
            this.handle(stream)
          })
        })
      })
    })

    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : 0
    return this.port
  }

  async close() {
    for (const s of this.sockets ?? []) s.destroy()
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }
}