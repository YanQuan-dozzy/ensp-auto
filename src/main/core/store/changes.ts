import fs from 'node:fs'
import path from 'node:path'
import type { ChangeKind, ChangeRecord, DeviceId } from '@shared/types'
import {
  describeShapeWarning,
  isFiniteNumber,
  isNonEmptyString,
  sanitizeIndexItems
} from './index-shape'
import { atomicWriteJsonSync } from '../fs/atomic'
import { quarantineFile } from '../fs/quarantine'

/**
 * 变更记录（F-4.5：谁在何时改了什么、依据哪次快照）。
 *
 * 与 SnapshotStore 同构：一个 JSON 索引文件 + 原子写。记录的追加频率不高
 * （一次配置变更一条），无需 SQLite。要按设备建索引时用 list(deviceId)，
 * 每设备只保留最近 MAX_PER_DEVICE 条，避免无限增长。
 *
 * v0.2 的写入者只有 Agent 路径，actor 固定为 'agent'，字段为将来扩展预留。
 * F6（2026-09-26）：记录形状上提到 `@shared/types`，渲染层的变更时间线直接消费同一份类型；
 * `recent()` 提供跨设备的时间线视图（原 `list()` 只能按设备查）。
 */

export type { ChangeKind, ChangeRecord } from '@shared/types'

interface IndexFile {
  version: 1
  items: ChangeRecord[]
}

const MAX_PER_DEVICE = 200

/** 变更时间线一次最多回传的条数（防止把整个索引灌进渲染层） */
export const MAX_TIMELINE_ITEMS = 500

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
    if (!fs.existsSync(this.indexFile)) return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as Partial<IndexFile>
      // R22：形状校验（同 SnapshotStore 的说明）
      const shaped = sanitizeIndexItems(parsed?.items, isChangeRecord)
      if (shaped.notArray) {
        // N22：整个 items 字段不可用 → 与解析失败同等处置（留档），否则下一次写入即覆盖
        this.recoverFromUnusableIndex('的 items 字段不是数组')
        return
      }
      this.index = { version: 1, items: shaped.items }
      const warning = describeShapeWarning('变更记录', shaped)
      if (warning) {
        this.loadWarnings.push(warning)
        console.warn(`[changes] ${warning}（${this.indexFile}）`)
      }
    } catch {
      this.recoverFromUnusableIndex('无法解析（文件损坏）')
    }
  }

  /**
   * N22：索引不可用（解析失败 / items 整体不是数组）时的统一处置：留档 + 空兜底。
   * 变更记录**没有独立实体文件**（changes.json 本身就是唯一存储），无法从磁盘重建，
   * 但留档后原文件仍可人工抢救 —— 绝不静默覆盖。
   */
  private recoverFromUnusableIndex(reason: string): void {
    const archived = quarantineFile(this.indexFile)
    this.index = { version: 1, items: [] }
    const msg = `变更记录索引${reason}${archived ? `，原文件已留档为 ${archived}` : ''}，已按空列表处理`
    this.loadWarnings.push(msg)
    console.warn(`[changes] ${msg}`)
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

  /**
   * 跨设备的变更时间线（F6）：全部设备按时间倒序，取最近 limit 条。
   *
   * `items` 在 `add()` 里是 unshift 进数组的，天然按时间倒序，这里只需截断。
   */
  recent(limit = MAX_TIMELINE_ITEMS): ChangeRecord[] {
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_TIMELINE_ITEMS, Math.floor(limit))) : MAX_TIMELINE_ITEMS
    return this.index.items.slice(0, n)
  }

  latest(deviceId: DeviceId): ChangeRecord | undefined {
    return this.list(deviceId)[0]
  }

  /**
   * 删除单条变更记录（列表里的「删除」）。
   *
   * 为什么变更记录可以删而会话树不行：它是**审计流水**，删掉只影响「回看历史」，
   * 不影响任何设备状态或对话上下文；而时间线越长越难读，用户需要能清理噪声条目。
   * 写盘失败回滚内存（与 `add()` 同款理由：界面上删了、磁盘上还在，重启就回弹）。
   *
   * @returns 是否真的删掉了一条（id 不存在返回 false，不抛错）
   */
  remove(id: string): boolean {
    const before = this.index.items.slice()
    const next = before.filter((i) => i.id !== id)
    if (next.length === before.length) return false
    this.index.items = next
    try {
      this.persist()
    } catch (e) {
      this.index.items = before
      throw e
    }
    return true
  }

  /** 清空全部变更记录，返回清掉的条数。同样写失败回滚内存。 */
  clear(): number {
    const before = this.index.items
    if (before.length === 0) return 0
    this.index.items = []
    try {
      this.persist()
    } catch (e) {
      this.index.items = before
      throw e
    }
    return before.length
  }

  private prune(deviceId: DeviceId): void {
    const mine = this.index.items.filter((i) => i.deviceId === deviceId)
    if (mine.length <= MAX_PER_DEVICE) return
    const drop = new Set(mine.slice(MAX_PER_DEVICE).map((i) => i.id))
    this.index.items = this.index.items.filter((i) => !drop.has(i.id))
  }
}