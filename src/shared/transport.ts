/**
 * 设备连接的传输层描述 —— DeviceId 双格式解析的单一事实源。
 *
 * 两种 DeviceId 形态：
 * - telnet：`127.0.0.1:2008`（eNSP 虚拟设备，主机固定本机）
 * - ssh：`ssh:<host>:<port>`，如 `ssh:192.168.1.10:22`
 *
 * 全部既有 `split(':')` / `slice(-1)` 式的 DeviceId 解析都应收敛到这里，
 * 否则 ssh 格式会被错误地切成「host:port」取到 host。
 *
 * 约束：SSH host 首版只接受 IPv4 / 域名（不含冒号），不做 IPv6 ——
 * 冒号会让「分隔」歧义，IPv6 留待需要时单独设计。
 */

import type { DeviceId } from './types'

export type Transport = 'telnet' | 'ssh'

export interface DeviceTarget {
  transport: Transport
  host: string
  port: number
}

export const DEFAULT_TELNET_HOST = '127.0.0.1'

const TELNET_RE = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/
const SSH_RE = /^ssh:([a-zA-Z0-9.-]+):(\d{1,5})$/

export function deviceIdForTelnet(port: number): DeviceId {
  return `${DEFAULT_TELNET_HOST}:${port}`
}

export function deviceIdForSsh(host: string, port: number): DeviceId {
  return `ssh:${host}:${port}`
}

/** 宽松解析：结构不合法返回 null（调用方自行决定兜底，不抛错） */
export function parseDeviceId(id: string): DeviceTarget | null {
  if (!id) return null
  const ssh = SSH_RE.exec(id)
  if (ssh) {
    const port = Number(ssh[2])
    if (port < 1 || port > 65535) return null
    return { transport: 'ssh', host: ssh[1]!, port }
  }
  const tel = TELNET_RE.exec(id)
  if (tel) {
    const port = Number(tel[2])
    if (port < 1 || port > 65535) return null
    return { transport: 'telnet', host: tel[1]!, port }
  }
  return null
}

/** SSH host 是否合法（与 parseDeviceId 的 SSH_RE 同规：不含冒号） */
export function isValidSshHost(host: string): boolean {
  return typeof host === 'string' && host.length > 0 && host.length <= 253 && /^[a-zA-Z0-9.-]+$/.test(host)
}