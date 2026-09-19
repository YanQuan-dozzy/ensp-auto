import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * 模型 API 密钥的保管。
 *
 * 硬要求：密钥不落明文。走 Electron 的 safeStorage（Windows 上是 DPAPI），
 * 加密后的密文写文件，解密只在主进程内存里发生，绝不经 IPC 回传渲染层。
 */

function keyFile(): string {
  return path.join(app.getPath('userData'), 'api-key.bin')
}

export function hasApiKey(): boolean {
  try {
    return fs.existsSync(keyFile()) && fs.statSync(keyFile()).size > 0
  } catch {
    return false
  }
}

export function setApiKey(key: string): void {
  const dir = path.dirname(keyFile())
  fs.mkdirSync(dir, { recursive: true })
  const trimmed = key.trim()
  if (!trimmed) {
    try {
      fs.rmSync(keyFile(), { force: true })
    } catch {
      /* 忽略 */
    }
    return
  }
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(trimmed)
    : Buffer.from(trimmed, 'utf8')
  fs.writeFileSync(keyFile(), payload)
}

export function getApiKey(): string | null {
  try {
    if (!fs.existsSync(keyFile())) return null
    const buf = fs.readFileSync(keyFile())
    if (!buf.length) return null
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(buf)
      } catch {
        // 换机器 / 换用户后旧密文解不开，视为未配置而不是崩溃
        return null
      }
    }
    return buf.toString('utf8')
  } catch {
    return null
  }
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}
