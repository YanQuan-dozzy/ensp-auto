/**
 * 凭据加解密里**不依赖 electron** 的那部分（N23）。
 *
 * 为什么单独抽出来：加解密是安全关键路径（明文降级、换机器解不开、坏条目丢弃），
 * 但 `secrets.ts` 顶层就 import 了 electron 的 `safeStorage`，导致整条链路进不了测试包、
 * 零回归覆盖。这里把「拿一个加密适配器做打包/解包」的纯逻辑与形状归一化抽出来：
 * 生产由 `secrets.ts` 注入真实 safeStorage 适配器，测试注入假适配器。
 */

/** 一条密文记录 */
export interface KeyEntry {
  /** safe = safeStorage 加密；plain = 系统不支持加密时的降级（如实标注，避免误以为已加密） */
  enc: 'safe' | 'plain'
  /** base64 */
  data: string
}

/** 加密适配器：把 electron 的 safeStorage 细节挡在外面 */
export interface SecretCrypto {
  available(): boolean
  /** 加密为 base64 密文 */
  encrypt(plain: string): string
  /** 解密 base64 密文；解不开应抛错（由 unpackSecret 转成 null） */
  decrypt(cipherB64: string): string
}

/**
 * 加密单条字符串。
 *
 * 系统不支持加密时降级为 base64 且标 `enc:'plain'` —— **绝不伪装成已加密**，
 * 否则用户会以为密钥受 DPAPI 保护，而实际是明文可读的。
 */
export function packSecret(plain: string, crypto: SecretCrypto): KeyEntry {
  if (crypto.available()) return { enc: 'safe', data: crypto.encrypt(plain) }
  return { enc: 'plain', data: Buffer.from(plain, 'utf8').toString('base64') }
}

/**
 * 解密密文。换机器 / 换用户后旧密文解不开返回 null（视为未配置，不崩溃）。
 * `plain` 条目按 base64 还原（它本来就是降级存储）。
 */
export function unpackSecret(entry: KeyEntry, crypto: SecretCrypto): string | null {
  try {
    if (entry.enc === 'plain') return Buffer.from(entry.data, 'base64').toString('utf8')
    return crypto.decrypt(entry.data)
  } catch {
    return null
  }
}

/** 密钥文件的形状归一化：缺 data 的条目等于垃圾，丢弃而不是让后续逻辑拿到 undefined */
export function normalizeKeyEntries(raw: unknown): Record<string, KeyEntry> {
  const keys: Record<string, KeyEntry> = {}
  if (!raw || typeof raw !== 'object') return keys
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Partial<KeyEntry>
    if (typeof e.data !== 'string' || !e.data) continue
    keys[id] = { enc: e.enc === 'plain' ? 'plain' : 'safe', data: e.data }
  }
  return keys
}

export interface SshMetaShape {
  id: string
  name: string
  host: string
  port: number
  username: string
}

/** SSH 凭据 meta 的归一化：host/username 是硬依赖，缺任一即丢弃；port 缺省 22 */
export function normalizeSshMeta(raw: unknown): Record<string, SshMetaShape> {
  const meta: Record<string, SshMetaShape> = {}
  if (!raw || typeof raw !== 'object') return meta
  for (const [id, m] of Object.entries(raw as Record<string, unknown>)) {
    if (!m || typeof m !== 'object') continue
    const mm = m as Partial<SshMetaShape>
    if (typeof mm.host !== 'string' || typeof mm.username !== 'string') continue
    meta[id] = {
      id,
      name: mm.name ?? '',
      host: mm.host,
      port: typeof mm.port === 'number' ? mm.port : 22,
      username: mm.username
    }
  }
  return meta
}