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
import { atomicWriteFileSync, atomicWriteJsonSync } from '../fs/atomic'
import { quarantineFile } from '../fs/quarantine'

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

/** 从快照 id 前缀解析 createdAt（id 形如 `${createdAt.toString(36)}-${random}`） */
function parseCreatedAtFromId(id: string): number | null {
  const head = id.split('-')[0]
  if (!head || !/^[0-9a-z]+$/.test(head)) return null
  const n = parseInt(head, 36)
  return Number.isFinite(n) && n > 0 ? n : null
}

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

  /** 快照正文目录根（每设备一个子目录） */
  private get dataRoot(): string {
    return path.join(this.baseDir, 'snapshots')
  }

  private dirOf(deviceId: DeviceId): string {
    // Windows 目录名不允许冒号：deviceId 形如 127.0.0.1:2008，必须转义
    return path.join(this.dataRoot, deviceId.replace(/[^0-9a-zA-Z.-]/g, '_'))
  }

  /**
   * 从磁盘上的 .txt 正文重建索引（N22，仅索引损坏时走这里）。
   *
   * 可逆性依据：目录名是 deviceId 的转义形态（非 `[0-9a-zA-Z.-]` → `_`），而合法的
   * deviceId 只有 `127.0.0.1:2008` / `ssh:host:port` 两种（`shared/transport.ts`），
   * **不含下划线** → `_` 一律还原为 `:` 是无歧义的。
   *
   * 重建条目一律 `complete: false`：正文里没有任何「采集是否被截断」的信息，而把一份
   * 可能被截断的快照标成完整会让它被当成回滚基线（违反 D3）。宁可要求重新采集。
   */
  private rebuildFromDisk(): SnapshotMeta[] {
    const items: SnapshotMeta[] = []
    let dirs: fs.Dirent[]
    try {
      dirs = fs.readdirSync(this.dataRoot, { withFileTypes: true })
    } catch {
      return items
    }
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue
      const deviceId = ent.name.replace(/_/g, ':')
      const dir = path.join(this.dataRoot, ent.name)
      let files: string[]
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'))
      } catch {
        continue
      }
      for (const name of files) {
        const id = name.slice(0, -'.txt'.length)
        if (!/^[0-9a-z-]{6,64}$/.test(id)) continue
        let config: string
        let mtimeMs: number
        try {
          config = fs.readFileSync(path.join(dir, name), 'utf8')
          mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs
        } catch {
          continue
        }
        items.push({
          id,
          deviceId,
          label: '索引损坏后恢复的快照',
          sizeBytes: Buffer.byteLength(config, 'utf8'),
          hashShort: createHash('sha256').update(config, 'utf8').digest('hex').slice(0, 12),
          // id 前缀是 createdAt 的 base36；解析不出就退回文件 mtime
          createdAt: parseCreatedAtFromId(id) ?? Math.floor(mtimeMs),
          complete: false
        })
      }
    }
    items.sort((a, b) => b.createdAt - a.createdAt)
    return items
  }

  private load(): void {
    this.loadWarnings = []
    if (!fs.existsSync(this.indexFile)) return
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as Partial<IndexFile>
      // R22：形状校验。`parsed.items ?? []` 挡不住 {"items":"x"}，
      // 漏进去之后 list()/save() 里的 .filter/.unshift 会在别处抛 TypeError。
      const shaped = sanitizeIndexItems(parsed?.items, isSnapshotMeta)
      if (shaped.notArray) {
        // N22：整个 items 字段不可用 → 与「解析失败」同等处置（留档 + 重建）。
        // 否则下一次任意写入就把空索引覆盖上去，磁盘上的正文就此无人引用。
        this.recoverFromUnusableIndex('的 items 字段不是数组')
        return
      }
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
      this.recoverFromUnusableIndex('无法解析（文件损坏）')
    }
  }

  /**
   * N22：索引不可用（解析失败 / items 字段整体不可用）时的统一恢复 —— 留档 + 从正文重建。
   * 绝不静默置空：置空后下一次写入即永久覆盖原索引，数据「假消失且不可恢复」。
   */
  private recoverFromUnusableIndex(reason: string): void {
    const archived = quarantineFile(this.indexFile)
    const rebuilt = this.rebuildFromDisk()
    this.index = { version: 1, items: rebuilt }
    const msg =
      `快照索引${reason}${archived ? `，原文件已留档为 ${archived}` : ''}；` +
      `已从磁盘上的 ${rebuilt.length} 份快照正文重建索引。` +
      '重建条目一律标记为不完整（complete=false），可查看与 diff，但需重新采集才能作为回滚基线'
    this.loadWarnings.push(msg)
    console.warn(`[snapshots] ${msg}`)
  }

  private persist(): void {
    // T2.5：统一原子写（唯一临时名 + rename + 失败清理 + 退避重试）
    // D4：索引关掉 fsync（同 changes.ts 的理由：fsync 同步阻塞主进程，
    // 而这里的写盘节奏由 apply_config 驱动，一次任务十几次）。
    // **正文（`atomicWriteFileSync(file, config)`）仍保持 fsync** —— 快照正文是
    // 回滚基线的真相来源，没有别处能重建；关掉它会直接违反
    // 「不完整快照不得作回滚基线」这条既有约束。
    // 这里同样不去抖：`save()` 的「落盘失败 → 回滚内存 + 删掉刚写的正文」
    // 是硬纪律（write-pipeline.test.mjs 守着），去抖会把它变成异步失败。
    atomicWriteJsonSync(this.indexFile, this.index, { fsync: false })
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
    // N21：正文同样走原子写（+ fsync）。此前是裸 writeFileSync，索引已 complete:true
    // 而正文可能是半截 —— 恰好绕过「不完整快照不得作回滚基线」的既有约束。
    atomicWriteFileSync(file, config)

    const meta: SnapshotMeta = {
      id,
      deviceId,
      label,
      sizeBytes: Buffer.byteLength(config, 'utf8'),
      hashShort,
      createdAt,
      complete: opts.complete !== false
    }
    // N20：先记下旧索引，失败时才能完整恢复（与 ChangeStore.add 同口径）
    const before = this.index.items.slice()
    this.index.items.unshift(meta)
    // 淘汰只改内存索引；正文文件等 persist 成功后再删 —— 否则 persist 抛错时
    // 磁盘索引（旧的，仍在）里会引用到已被删掉的 .txt，形成「有 meta 无文件」的孤儿
    const dropped = this.pruneInMemory(deviceId)
    try {
      this.persist()
    } catch (e) {
      // v1.8：索引落盘失败 → 内存恢复成与磁盘一致，并清理刚落的新正文
      this.index.items = before
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* 忽略清理失败 */
      }
      throw e
    }
    // persist 成功后，被淘汰的正文才真正删除（删失败只留无引用的孤儿文件，无害）
    this.removeFiles(deviceId, dropped)
    return meta
  }

  /**
   * 每设备只保留最近 MAX_PER_DEVICE 份：**仅从内存索引移除**，返回被淘汰的 id。
   * 正文删除由调用方在 persist 成功后执行（N20：顺序反了会造成索引/实体脱节）。
   */
  private pruneInMemory(deviceId: DeviceId): string[] {
    const mine = this.index.items.filter((i) => i.deviceId === deviceId)
    if (mine.length <= MAX_PER_DEVICE) return []
    const drop = mine.slice(MAX_PER_DEVICE).map((i) => i.id)
    const dropSet = new Set(drop)
    this.index.items = this.index.items.filter((i) => !dropSet.has(i.id))
    return drop
  }

  private removeFiles(deviceId: DeviceId, ids: string[]): void {
    if (ids.length === 0) return
    const dir = this.dirOf(deviceId)
    for (const id of ids) {
      try {
        fs.rmSync(path.join(dir, `${id}.txt`), { force: true })
      } catch {
        /* 忽略清理失败 */
      }
    }
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
