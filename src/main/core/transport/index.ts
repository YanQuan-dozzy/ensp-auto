import type { DeviceTarget } from '@shared/transport'
import { connectTcp, type ByteChannel } from './ByteChannel'
import { connectSsh, type SshConnectConfig } from './SshChannel'

/**
 * SSH 目标的完整连接配置（含认证）。SessionManager 按它建立 SSH 管道。
 */
export interface SshTarget {
  host: string
  port: number
  username: string
  auth: SshConnectConfig['auth']
}

/**
 * 按目标打开字节管道。
 * - telnet：TCP 直连（连接超时由调用方给定）
 * - ssh：ssh2 握手 + shell 通道
 */
export function openChannel(
  target: DeviceTarget,
  opts: { timeoutMs: number; ssh: SshTarget }
): Promise<ByteChannel> {
  if (target.transport === 'ssh') {
    return connectSsh({
      host: opts.ssh.host,
      port: opts.ssh.port,
      username: opts.ssh.username,
      auth: opts.ssh.auth,
      readyTimeoutMs: opts.timeoutMs
    })
  }
  return connectTcp(target.host, target.port, opts.timeoutMs)
}

export type { ByteChannel }
export { connectTcp } from './ByteChannel'
export { connectSsh } from './SshChannel'
export type { SshConnectConfig } from './SshChannel'