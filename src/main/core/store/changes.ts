import fs from 'node:fs'
import path from 'node:path'
import type { DeviceId, Expectation } from '@shared/types'

/**
 * 变更记录（F-4.5：谁在何时改了什么、依据哪次快照）。
 *
 * 与 SnapshotStore 同构：一个 JSON 索引文件 + 原子写。记录的追加频率不高
 * （一次配置变更一条），无需 SQLite。要按设备建索引时用 list(deviceId)，
 * 每设备只保留最近 MAX_PER_DEVICE 条，避免无限增长。
 *
 * v0.2 的写入者只有 Agent 路径，actor 固定为 'agent'，字段为将来扩展预留。
 */

export type ChangeKind = 'apply' | 'restore' | 'save'
export type ChangeResult = 'ok' | 'failed' | 'rejected' | 'blocked'

export interface ChangeRecord {
  id: string
  deviceId: DeviceId
  at: number
  kind: ChangeKind
  /** v0.2 只有代理通道；用户手动操作通道预留 */
  actor: 'agent' | 'user'
  /** 本次变更依据的快照（apply 前自动采集 / restore 的目标快照） */
  snapshotId?: string
  description: string
  commands?: string[]
  expectation?: Expectation
  result: ChangeResult
  /** apply 流程里的期望校验结果 */
  verified?: boolean
  error?: { code: string; message: string }
}

interface IndexFile {
  version: 1
  items: ChangeRecord[]
}

const MAX_PER_DEVICE = 200

export class ChangeStore {
  private index: IndexFile = { version: 1, items: [] }

  constructor(private readonly baseDir: string) {
    this.load()
  }

  private get indexFile(): string {
    return path.join(this.baseDir, 'changes.json')
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

  /** 追加一条变更记录，返回完整记录 */
  add(record: Omit<ChangeRecord, 'id' | 'at'>): ChangeRecord {
    const full: ChangeRecord = {
      ...record,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now()
    }
    this.index.items.unshift(full)
    this.prune(record.deviceId)
    this.persist()
    return full
  }

  list(deviceId: DeviceId): ChangeRecord[] {
    return this.index.items.filter((i) => i.deviceId === deviceId)
  }

  latest(deviceId: DeviceId): ChangeRecord | undefined {
    return this.list(deviceId)[0]
  }

  private prune(deviceId: DeviceId): void {
    const mine = this.index.items.filter((i) => i.deviceId === deviceId)
    if (mine.length <= MAX_PER_DEVICE) return
    const drop = new Set(mine.slice(MAX_PER_DEVICE).map((i) => i.id))
    this.index.items = this.index.items.filter((i) => !drop.has(i.id))
  }
}