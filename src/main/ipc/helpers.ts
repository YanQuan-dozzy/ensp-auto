import fs from 'node:fs'
import path from 'node:path'
import { MAX_ATTACHMENTS } from '@shared/attachments'
import { app } from 'electron'
import { newMcpServerId } from '@shared/profiles'
import { parseDeviceId } from '@shared/transport'
import { readTopoFile } from '../core/topology/fromProjectFile'
import type { Attachment } from '@shared/attachments'
import type { DeviceId, McpServerConfig } from '@shared/types'
import type { Services } from '../services'
import type { SettingsPayload, TopoImportPayload } from '@shared/api'
import type { SshAuthPayload } from '../settings/sshSecrets'

/**
 * IPC 路由层的共享校验与载荷工具（T5.1 从 index.ts 抽出）。
 *
 * 全部原则只有一条：**不信任渲染层传来的任何东西**（ARCHITECTURE.md §3.2）。
 * 这里的函数只做「校验 + 收敛 + 组载荷」，不含业务逻辑。
 */

/** 主进程 → 渲染层的事件推送签名 */
export type EmitFn = (channel: string, payload: unknown) => void

export function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

export function toStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function requireDeviceId(v: unknown): DeviceId {
  const s = toStr(v)
  // telnet 形如 127.0.0.1:2008；ssh 形如 ssh:host:port。统一由 shared 解析器校验
  if (!parseDeviceId(s)) throw new Error(`非法设备 ID：${s}`)
  return s
}

/** SSH 凭据条目 id：由主进程发号，格式可控（s- 前缀 + 短随机） */
export const SSH_CREDENTIAL_ID_RE = /^s-[a-z0-9]{1,32}$/

/**
 * SSH 认证载荷清洗：type 白名单 + password/key 非空 + 私钥长度上限。
 * 渲染层传来的认证必须过这一关才能进凭据库或会话。
 */
export function sanitizeSshAuth(raw: unknown): { ok: true; auth: SshAuthPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '认证信息缺失' }
  const a = raw as { type?: unknown; password?: unknown; key?: unknown; passphrase?: unknown }
  if (a.type === 'password') {
    const password = toStr(a.password)
    if (!password) return { ok: false, error: '密码不能为空' }
    return { ok: true, auth: { type: 'password', password } }
  }
  if (a.type === 'privateKey') {
    const key = toStr(a.key)
    if (!key) return { ok: false, error: '私钥不能为空' }
    if (key.length > 64 * 1024) return { ok: false, error: '私钥文本过长（>64KB）' }
    const passphrase = toStr(a.passphrase) || undefined
    return { ok: true, auth: passphrase ? { type: 'privateKey', key, passphrase } : { type: 'privateKey', key } }
  }
  return { ok: false, error: '不支持的认证方式' }
}

/**
 * 按路径导入 .topo（dialog 与 find-files 两条 UI 入口共用）：
 * 校验规则与 import_topology_file 工具一致（.topo 扩展 / 不越界 / 存在为文件），
 * 导入成功后记录来源路径供 find_topology_files 标 is_active。
 */
export function importTopoPath(services: Services, filePath: string): TopoImportPayload | null {
  const resolved = path.resolve(filePath)
  if (path.extname(resolved).toLowerCase() !== '.topo') return null
  if (resolved.includes('..')) return null
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null
  const { topology, report } = readTopoFile(resolved)
  services.topology.setFile(topology)
  services.topology.setFileSource(resolved)
  return { topology, report }
}

/** 设置回传口径：密钥状态只回布尔与「哪些档案已配置」，密钥本身永不出主进程 */
export function settingsPayload(services: Services): SettingsPayload {
  return {
    settings: services.getSettings(),
    hasApiKey: services.hasApiKey(),
    configuredProfileIds: services.configuredProfileIds()
  }
}

/** v1.9：设置里显式指定的 Wireshark 目录（空串表示让 probe 自动探测） */
export function wiresharkDirFromSettings(services: Services): string {
  return services.getSettings().wireshark.dir
}

export const MCP_SERVER_ID_RE = /^m-[a-z0-9][a-z0-9-]{0,63}$/

/**
 * 外部 MCP 服务器列表清洗（v1.5）：字段白名单 + 必填校验 + id 兜底发号。
 * raw 为 undefined 时保持原样（部分补丁只改开关时不至于把服务器列表清空）。
 */
export function sanitizeMcpServers(raw: unknown, current: McpServerConfig[]): McpServerConfig[] {
  if (raw === undefined) return current
  if (!Array.isArray(raw)) return current
  const out: McpServerConfig[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = toStr(o.name).trim().slice(0, 64)
    const transport = o.transport === 'stdio' ? 'stdio' : 'http'
    const url = toStr(o.url).trim().slice(0, 512)
    const command = toStr(o.command).trim().slice(0, 512)
    if (!name) continue
    // 传输方式决定必填项：http 要地址，stdio 要命令
    if (transport === 'http' ? !url : !command) continue
    let id = toStr(o.id)
    if (!MCP_SERVER_ID_RE.test(id) || seen.has(id)) id = newMcpServerId()
    seen.add(id)
    out.push({
      id,
      name,
      transport,
      url,
      command,
      args: Array.isArray(o.args)
        ? o.args.filter((x): x is string => typeof x === 'string').slice(0, 32)
        : [],
      enabled: !!o.enabled,
      trusted: !!o.trusted
    })
  }
  return out
}

/** 用户自定义指令长度上限（常驻系统提示词，过长会挤掉工具说明） */
export const MAX_SYSTEM_PROMPT = 20000

/**
 * v1.5：把渲染层传来的附件重建成可信元数据。
 *
 * 只按 path 认人 —— 路径必须落在附件归档目录内（AttachmentStore.resolve 做 realpath 校验），
 * 其余字段（体积/类型/预览）全部从磁盘重新推导。渲染层说这个附件是什么，不算数。
 */
export function describeAttachments(services: Services, raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return []
  const out: Attachment[] = []
  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    const p =
      typeof item === 'string' ? item : toStr((item as { path?: unknown } | null)?.path)
    if (!p) continue
    const desc = services.attachments.describe(p)
    if (desc) out.push(desc)
  }
  return out
}

/**
 * Wireshark 分析组件的安装根目录（userData/py/wireshark-mcp）。
 *
 * 从 index.ts 的 registerIpc 闭包里提出来：安装与挂载两个 handler 都要用它，
 * 拆成两个模块后闭包共享不再可用，索性变成 helpers 的纯函数。
 */
export function wsVenvRoot(): string {
  return path.join(app.getPath('userData'), 'py', 'wireshark-mcp')
}
