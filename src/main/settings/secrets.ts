import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { atomicWriteJsonSync } from '../core/fs/atomic'

/**
 * 模型 API 密钥的保管（v1.5：按档案分档）。
 *
 * 硬要求：密钥不落明文。走 Electron 的 safeStorage（Windows 上是 DPAPI），
 * 加密后的密文写文件，解密只在主进程内存里发生，绝不经 IPC 回传渲染层。
 *
 * v1.5 的变化：从「一把密钥」变成「每档一份」。
 * 存在的理由很实际——用户同时用 DeepSeek 和公司内部端点，以前换模型必须把密钥
 * 覆盖掉，换回来还得重新粘贴。现在密钥按 profileId 分桶，切换模型只切 id。
 *
 * 并发口径（主进程可能同时被多个 IPC 命中）：
 * - 读取走内存缓存，避免每次请求都做一次 DPAPI 解密；
 * - 写入全部是同步 + 原子（唯一临时名 → rename），并在 finally 里清理临时文件，
 *   即使上一次写入被中断也不会留下半个 JSON。
 * - 旧格式（api-key.bin，单把密钥）保留一次迁移，迁移后不再读取该文件，
 *   这样「降级回旧版本」也不会丢密钥。
 */

export interface KeyEntry {
  /** safe = safeStorage 加密；plain = 系统不支持加密时的降级（仍标出来，避免误以为已加密） */
  enc: 'safe' | 'plain'
  /** base64 */
  data: string
}

interface KeyFile {
  version: 1
  keys: Record<string, KeyEntry>
}

const EMPTY: KeyFile = { version: 1, keys: {} }

let cache: KeyFile | null = null

function userDataDir(): string {
  return app.getPath('userData')
}

function keysFile(): string {
  return path.join(userDataDir(), 'api-keys.json')
}

function legacyFile(): string {
  return path.join(userDataDir(), 'api-key.bin')
}

function readKeys(): KeyFile {
  if (cache) return cache
  try {
    if (!fs.existsSync(keysFile())) {
      cache = structuredClone(EMPTY)
      return cache
    }
    const parsed = JSON.parse(fs.readFileSync(keysFile(), 'utf8')) as Partial<KeyFile>
    const keys: Record<string, KeyEntry> = {}
    for (const [id, entry] of Object.entries(parsed.keys ?? {})) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Partial<KeyEntry>
      if (typeof e.data !== 'string' || !e.data) continue
      keys[id] = { enc: e.enc === 'plain' ? 'plain' : 'safe', data: e.data }
    }
    cache = { version: 1, keys }
  } catch {
    // 读坏了不能直接覆盖：留一份坏文件供排查，然后从空开始（密钥可重填，历史不可再生）
    try {
      fs.renameSync(keysFile(), `${keysFile()}.bad-${Date.now()}`)
    } catch {
      /* 忽略 */
    }
    cache = structuredClone(EMPTY)
  }
  return cache
}

/** 原子写（统一走 core/fs/atomic：唯一临时名 + rename + 失败清理 + 退避重试） */
function persist(next: KeyFile): void {
  atomicWriteJsonSync(keysFile(), next)
  cache = next
}

/** 加密单条字符串为 KeyEntry（safeStorage 可用则加密，否则降级 base64 并标注 plain）。供 sshSecrets 复用 */
export function encrypt(plain: string): KeyEntry {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: 'safe', data: safeStorage.encryptString(plain).toString('base64') }
  }
  return { enc: 'plain', data: Buffer.from(plain, 'utf8').toString('base64') }
}

/** 解密密文。换机器/换用户后解不开返回 null（与 readKeys 的口径一致：视为未配置，不崩溃）。供 sshSecrets 复用 */
export function decrypt(entry: KeyEntry): string | null {
  try {
    const buf = Buffer.from(entry.data, 'base64')
    if (entry.enc === 'plain') return buf.toString('utf8')
    return safeStorage.decryptString(buf)
  } catch {
    // 换机器 / 换用户后旧密文解不开：视为未配置，而不是崩溃
    return null
  }
}

export function hasApiKey(profileId?: string): boolean {
  const keys = readKeys().keys
  if (!profileId) return Object.keys(keys).length > 0
  return Boolean(keys[profileId])
}

/** 已配置密钥的档案 id 列表（不回传密钥本身，供 UI 逐档打标） */
export function listKeyedProfileIds(): string[] {
  return Object.keys(readKeys().keys)
}

export function getApiKey(profileId?: string): string | null {
  const keys = readKeys().keys
  if (!profileId) {
    const first = Object.keys(keys)[0]
    if (!first) return null
    return decrypt(keys[first]!)
  }
  const entry = keys[profileId]
  if (!entry) return null
  return decrypt(entry)
}

/** key 为空串 = 删除该档密钥（UI 的「清除」） */
export function setApiKey(profileId: string, key: string): void {
  const current = readKeys()
  const keys = { ...current.keys }
  const trimmed = key.trim()
  if (trimmed) {
    keys[profileId] = encrypt(trimmed)
  } else {
    delete keys[profileId]
  }
  persist({ version: 1, keys })
}

/** 删除某档密钥（档案被删除时调用） */
export function removeApiKey(profileId: string): void {
  setApiKey(profileId, '')
}

/**
 * 旧格式一次性迁移：api-key.bin（单把密钥）→ 指定的档案。
 *
 * 幂等：只在 api-keys.json 不存在且旧文件存在时执行。
 * 迁移后刻意**不删除** api-key.bin —— 万一用户回退到旧版本，密钥还在。
 */
export function migrateLegacyApiKey(targetProfileId: string): boolean {
  try {
    if (fs.existsSync(keysFile())) return false
    if (!fs.existsSync(legacyFile())) return false
    const buf = fs.readFileSync(legacyFile())
    if (!buf.length) return false
    let plain: string | null = null
    if (safeStorage.isEncryptionAvailable()) {
      try {
        plain = safeStorage.decryptString(buf)
      } catch {
        // v1.8：DPAPI 密文解不开（换机器 / 换用户最常见）→ 不做 fallback。
        // 否则把二进制乱码当密钥存进新格式，等于用坏值覆盖不可恢复。返回 false 让用户重填。
        return false
      }
    } else {
      plain = buf.toString('utf8')
    }
    if (!plain || !plain.trim()) return false
    setApiKey(targetProfileId, plain)
    return true
  } catch {
    return false
  }
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}
