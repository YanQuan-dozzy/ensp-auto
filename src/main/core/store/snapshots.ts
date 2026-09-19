import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { DeviceId } from '@shared/types'

/**
 * 配置快照存储。
 *
 * v0.1 不做配置下发的自动回滚（那是 v0.2），但快照的**接口与存储先立起来**：
 * - 采集是只读操作，本身没有风险
 * - 先把「写操作前必须存在快照」的硬约束链路打通
 * - 落盘形态从 JSON 换成 SQLite 时不影响上层
 *
 * 存储形态：快照正文按设备分目录存 .txt（体量大且是纯文本），
 * 元数据存在一个小 JSON 索引里（体量小且需要高频读取列表）。
 */

export interface SnapshotMeta {
  id: string
  deviceId: DeviceId
  label: string
  sizeBytes: number
  hashShort: string
  createdAt: number
}

interface IndexFile {
  version: 1
  items: SnapshotMeta[]
}

const MAX_PER_DEVICE = 50

export class SnapshotStore {
  private index: IndexFile = { version: 1, items: [] }

  constructor(private readonly baseDir: string) {
    this.load()
  }

  private get indexFile(): string {
    return path.join(this.baseDir, 'snapshots.json')
  }

  private dirOf(deviceId: DeviceId): string {
    // Windows 目录名不允许冒号：deviceId 形如 127.0.0.1:2008，必须转义
    return path.join(this.baseDir, 'snapshots', deviceId.replace(/[^0-9a-zA-Z.-]/g, '_'))
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.indexFile)) return
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as IndexFile
      this.index = { version: 1, items: parsed.items ?? [] }
    } catch {
      this.index = { version: 1, items: [] }
    }
  }

  private persist(): void {
    fs.mkdirSync(this.baseDir, { recursive: true })
    const tmp = `${this.indexFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.index, null, 2), 'utf8')
    fs.renameSync(tmp, this.indexFile)
  }

  save(deviceId: DeviceId, config: string, label: string): SnapshotMeta {
    const createdAt = Date.now()
    const id = `${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const hashShort = createHash('sha256').update(config, 'utf8').digest('hex').slice(0, 12)

    const dir = this.dirOf(deviceId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${id}.txt`), config, 'utf8')

    const meta: SnapshotMeta = {
      id,
      deviceId,
      label,
      sizeBytes: Buffer.byteLength(config, 'utf8'),
      hashShort,
      createdAt
    }
    this.index.items.unshift(meta)
    this.prune(deviceId)
    this.persist()
    return meta
  }

  /** 每设备只保留最近 MAX_PER_DEVICE 份，避免无限增长 */
  private prune(deviceId: DeviceId): void {
    const mine = this.index.items.filter((i) => i.deviceId === deviceId)
    if (mine.length <= MAX_PER_DEVICE) return
    const drop = new Set(mine.slice(MAX_PER_DEVICE).map((i) => i.id))
    for (const id of drop) {
      try {
        fs.rmSync(path.join(this.dirOf(deviceId), `${id}.txt`), { force: true })
      } catch {
        /* 忽略清理失败 */
      }
    }
    this.index.items = this.index.items.filter((i) => !drop.has(i.id))
  }

  list(deviceId: DeviceId): SnapshotMeta[] {
    return this.index.items.filter((i) => i.deviceId === deviceId)
  }

  latest(deviceId: DeviceId): SnapshotMeta | undefined {
    return this.list(deviceId)[0]
  }

  read(deviceId: DeviceId, id: string): string | null {
    try {
      const file = path.join(this.dirOf(deviceId), `${id}.txt`)
      if (!fs.existsSync(file)) return null
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }

  get(deviceId: DeviceId, id: string): SnapshotMeta | undefined {
    return this.index.items.find((i) => i.deviceId === deviceId && i.id === id)
  }
}
