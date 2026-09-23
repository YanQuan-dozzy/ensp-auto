import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { decrypt, encrypt, type KeyEntry } from './secrets'
import { atomicWriteJsonSync } from '../core/fs/atomic'

/**
 * SSH 连接凭据的保管。
 *
 * 与 api-keys 同构的加密口径（safeStorage / DPAPI）：meta（名称/主机/端口/用户名）
 * 明文存储（非敏感），auth 载荷（密码 或 私钥 + passphrase）JSON 序列化后整体加密。
 * 密码/私钥绝不经 IPC 回传渲染层 —— 渲染层只能拿到 meta，连接时主进程解密。
 *
 * 写入同步 + 原子（唯一临时名 → rename），读坏留档 .bad-<ts> 不覆盖。
 * 解密失败（换机器 / 换用户）返回 null，界面标「密钥不可用」，不崩溃。
 *
 * 目录注入而非直接读 electron app.getPath()：本模块会被测试 harness 整体打包，
 * 顶层依赖 electron 会把整个运行时拉进测试包。Services 启动时 init 一次即可。
 */

export type SshAuthPayload =
  | { type: 'password'; password: string }
  | { type: 'privateKey'; key: string; passphrase?: string }

export interface SshCredentialMeta {
  id: string
  name: string
  host: string
  port: number
  username: string
}

export interface SshCredential extends SshCredentialMeta {
  auth: SshAuthPayload
}

interface SshFile {
  version: 1
  meta: Record<string, SshCredentialMeta>
  secrets: Record<string, KeyEntry>
}

const EMPTY: SshFile = { version: 1, meta: {}, secrets: {} }

let cache: SshFile | null = null
let baseDir: string | null = null

/** 由 Services 启动时注入 userData 目录；未初始化时任何读写抛错（不该发生） */
export function initSshSecrets(dir: string): void {
  baseDir = dir
  cache = null
}

function file(): string {
  if (!baseDir) throw new Error('sshSecrets 未初始化')
  return path.join(baseDir, 'ssh-credentials.json')
}

function read(): SshFile {
  if (cache) return cache
  try {
    if (!fs.existsSync(file())) {
      cache = structuredClone(EMPTY)
      return cache
    }
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<SshFile>
    const meta: Record<string, SshCredentialMeta> = {}
    const secrets: Record<string, KeyEntry> = {}
    for (const [id, m] of Object.entries(parsed.meta ?? {})) {
      if (!m || typeof m !== 'object') continue
      const mm = m as Partial<SshCredentialMeta>
      if (typeof mm.host !== 'string' || typeof mm.username !== 'string') continue
      meta[id] = { id, name: mm.name ?? '', host: mm.host, port: mm.port ?? 22, username: mm.username }
    }
    for (const [id, e] of Object.entries(parsed.secrets ?? {})) {
      if (!e || typeof e !== 'object') continue
      const ee = e as Partial<KeyEntry>
      if (typeof ee.data !== 'string' || !ee.data) continue
      secrets[id] = { enc: ee.enc === 'plain' ? 'plain' : 'safe', data: ee.data }
    }
    cache = { version: 1, meta, secrets }
  } catch {
    // 读坏不覆盖：留档供排查，然后从空开始（凭据可重填）
    try {
      fs.renameSync(file(), `${file()}.bad-${Date.now()}`)
    } catch {
      /* 忽略 */
    }
    cache = structuredClone(EMPTY)
  }
  return cache
}

/** 原子写（与 secrets.ts 同口径，统一走 core/fs/atomic） */
function persist(next: SshFile): void {
  atomicWriteJsonSync(file(), next)
  cache = next
}

export function newSshCredentialId(): string {
  return `s-${randomUUID().slice(0, 8)}`
}

/** 只回 meta（不含密码/私钥），供 UI 列表与代理工具使用 */
export function listSshCredentials(): SshCredentialMeta[] {
  return Object.values(read().meta).sort((a, b) => a.name.localeCompare(b.name))
}

export function getSshCredential(id: string): SshCredential | null {
  const f = read()
  const meta = f.meta[id]
  const entry = f.secrets[id]
  if (!meta || !entry) return null
  const plain = decrypt(entry)
  if (!plain) return null // 密文解不开：视为不可用，不崩
  try {
    const auth = JSON.parse(plain) as SshAuthPayload
    if (auth.type !== 'password' && auth.type !== 'privateKey') return null
    return { ...meta, auth }
  } catch {
    return null
  }
}

export function saveSshCredential(cred: SshCredential): SshCredentialMeta {
  const f = read()
  const meta = { ...f.meta }
  const secrets = { ...f.secrets }
  meta[cred.id] = { id: cred.id, name: cred.name, host: cred.host, port: cred.port, username: cred.username }
  secrets[cred.id] = encrypt(JSON.stringify(cred.auth))
  persist({ version: 1, meta, secrets })
  return meta[cred.id]!
}

export function removeSshCredential(id: string): void {
  const f = read()
  if (!f.meta[id] && !f.secrets[id]) return
  const meta = { ...f.meta }
  const secrets = { ...f.secrets }
  delete meta[id]
  delete secrets[id]
  persist({ version: 1, meta, secrets })
}