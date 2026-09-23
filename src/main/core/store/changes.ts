import fs from 'node:fs'
import path from 'node:path'
import type { DeviceId, Expectation } from '@shared/types'
import {
  describeShapeWarning,
  isFiniteNumber,
  isNonEmptyString,
  sanitizeIndexItems
} from './index-shape'
import { atomicWriteJsonSync } from '../fs/atomic'

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

const CHANGE_KINDS: readonly ChangeKind[] = ['apply', 'restore', 'save']

/** 索引条目的形状判定：id/deviceId/kind/result 是后续逻辑的硬依赖 */
function isChangeRecord(v: unknown): v is ChangeRecord {
  if (!v || typeof v !== 'object') return false
  const c = v as Partial<ChangeRecord>
  return (
    isNonEmptyString(c.id) &&
    isNonEmptyString(c.deviceId) &&
    isFiniteNumber(c.at) &&
    CHANGE_KINDS.includes(c.kind as ChangeKind) &&
    (c.result === 'ok' || c.result === 'failed' || c.result === 'rejected' || c.result === 'blocked')
  )
}

export class ChangeStore {
  private index: IndexFile = { version: 1, items: [] }
  /** 加载期发现的问题，与 SnapshotStore 同口径 */
  private loadWarnings: string[] = []

  constructor(private baseDir: string) {
    this.load()
  }

  get warnings(): readonly string[] {
    return this.loadWarnings
  }

  setBaseDir(newDir: string): void {
    this.baseDir = newDir
    this.load()
  }

  private get indexFile(): string {
    return path.join(this.baseDir, 'changes.json')
  }

  private load(): void {
    this.loadWarnings = []
    try {
      if (!fs.existsSync(this.indexFile)) return
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as Partial<IndexFile>
      // R22：形状校验（同 SnapshotStore 的说明）
      const shaped = sanitizeIndexItems(parsed?.items, isChangeRecord)
      this.index = { version: 1, items: shaped.items }
      const warning = describeShapeWarning('变更记录', shaped)
      if (warning) {
        this.loadWarnings.push(warning)
        console.warn(`[changes] ${warning}（${this.indexFile}）`)
      }
    } catch {
      this.index = { version: 1, items: [] }
      this.loadWarnings.push('变更记录索引无法解析（文件损坏），已按空列表处理')
      console.warn(`[changes] 变更记录索引无法解析，已按空列表处理：${this.indexFile}`)
    }
  }

  private persist(): void {
    // T2.5：统一原子写
    atomicWriteJsonSync(this.indexFile, this.index)
  }

  /** 追加一条变更记录，返回完整记录 */
  add(record: Omit<ChangeRecord, 'id' | 'at'>): ChangeRecord {
    const full: ChangeRecord = {
      ...record,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now()
    }
    const before = this.index.items.slice()
    this.index.items.unshift(full)
    this.prune(record.deviceId)
    // R21：变更记录写失败时回滚内存 —— 否则「界面上有这条记录、磁盘上没有」，
    // 报告导出与会话回溯会给出互相矛盾的结论
    try {
      this.persist()
    } catch (e) {
      this.index.items = before
      throw e
    }
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