import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { DeviceId } from '@shared/types'
import {
  describeShapeWarning,
  isFiniteNumber,
  isNonEmptyString,
  sanitizeIndexItems
} from './index-shape'
import { atomicWriteJsonSync } from '../fs/atomic'

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
  /**
   * 采集是否完整（D3，2026-09-23）。
   *
   * 设备回显超过 `DEFAULT_TELNET_OPTIONS.maxBytes`（512KB）时，缓冲只保留
   * 「头 256KB + 尾 256KB，中间丢弃」——这份快照缺中间段，而 rollback 是按段
   * 解析的，缺段会把「其实存在的段」判成新增/删除，回滚会**报成功但没回到现场**。
   * 因此不完整快照不能作为回滚基线（restore_snapshot 直接拒绝）。
   *
   * 兼容：旧索引里没有该字段时，load 期归一化为 `true`。
   */
  complete: boolean
}

interface IndexFile {
  version: 1
  items: SnapshotMeta[]
}

const MAX_PER_DEVICE = 50

/** 索引条目的形状判定：写盘字段缺一个就说明这条记录不可信，丢掉 */
function isSnapshotMeta(v: unknown): v is SnapshotMeta {
  if (!v || typeof v !== 'object') return false
  const m = v as Partial<SnapshotMeta>
  return (
    isNonEmptyString(m.id) &&
    isNonEmptyString(m.deviceId) &&
    typeof m.label === 'string' &&
    isFiniteNumber(m.createdAt) &&
    // D3：complete 是后加字段，旧索引没有它 → 视为可选（load 期归一化为 true）
    (m.complete === undefined || typeof m.complete === 'boolean')
  )
}

export class SnapshotStore {
  private index: IndexFile = { version: 1, items: [] }
  /** 加载期发现的问题（形状不合法的条目等），供上层提示与测试断言 */
  private loadWarnings: string[] = []

  constructor(private baseDir: string) {
    this.load()
  }

  /** 本次加载的告警（每次 load 重置） */
  get warnings(): readonly string[] {
    return this.loadWarnings
  }

  setBaseDir(newDir: string): void {
    this.baseDir = newDir
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
    this.loadWarnings = []
    try {
      if (!fs.existsSync(this.indexFile)) return
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as Partial<IndexFile>
      // R22：形状校验。`parsed.items ?? []` 挡不住 {"items":"x"}，
      // 漏进去之后 list()/save() 里的 .filter/.unshift 会在别处抛 TypeError。
      const shaped = sanitizeIndexItems(parsed?.items, isSnapshotMeta)
      // D3：旧索引（无 complete 字段）一律按「完整」处理，避免历史快照被整体废弃
      this.index = {
        version: 1,
        items: shaped.items.map((m) => ({ ...m, complete: m.complete !== false }))
      }
      const warning = describeShapeWarning('快照', shaped)
      if (warning) {
        this.loadWarnings.push(warning)
        console.warn(`[snapshots] ${warning}（${this.indexFile}）`)
      }
    } catch {
      this.index = { version: 1, items: [] }
      this.loadWarnings.push('快照索引无法解析（文件损坏），已按空列表处理')
      console.warn(`[snapshots] 快照索引无法解析，已按空列表处理：${this.indexFile}`)
    }
  }

  private persist(): void {
    // T2.5：统一原子写（唯一临时名 + rename + 失败清理 + 退避重试）
    atomicWriteJsonSync(this.indexFile, this.index)
  }

  /**
   * @param opts.complete 采集是否完整（截断 / 解码有损时为 false）；缺省 true。
   *   不完整快照仍会入库（供查看与 diff），但不会被视为可用的回滚基线。
   */
  save(
    deviceId: DeviceId,
    config: string,
    label: string,
    opts: { complete?: boolean } = {}
  ): SnapshotMeta {
    const createdAt = Date.now()
    const id = `${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const hashShort = createHash('sha256').update(config, 'utf8').digest('hex').slice(0, 12)

    const dir = this.dirOf(deviceId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${id}.txt`)
    fs.writeFileSync(file, config, 'utf8')

    const meta: SnapshotMeta = {
      id,
      deviceId,
      label,
      sizeBytes: Buffer.byteLength(config, 'utf8'),
      hashShort,
      createdAt,
      complete: opts.complete !== false
    }
    this.index.items.unshift(meta)
    this.prune(deviceId)
    try {
      this.persist()
    } catch (e) {
      // v1.8：索引落盘失败 → 撤销内存条目 + 清理刚写的 .txt，避免留下孤儿文件
      this.index.items = this.index.items.filter((i) => i.id !== id)
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* 忽略清理失败 */
      }
      throw e
    }
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
    // v1.8：id 只认可本 store 生成的形态（base36 + 连字符），且必须归属该设备。
    // 把「路径逃逸」的信任边界锁在 store 内部，而不是依赖调用方传来的 id 干净。
    if (!/^[0-9a-z-]{6,64}$/.test(id)) return null
    if (!this.get(deviceId, id)) return null
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
