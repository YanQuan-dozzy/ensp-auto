import fs from 'node:fs'
import path from 'node:path'

/**
 * 数据目录体检与清理（v1.6）。
 *
 * 为什么值得单独做一块：这个应用把会话树、附件归档、配置快照、导出报告全都写在
 * userData 下，用户看不见也不理解「我的磁盘为什么少了 800MB」。设置页里给一条
 * 「占了多少 / 在哪儿 / 怎么清」的出口，比让人去翻 AppData 找文件夹务实得多。
 *
 * 纪律：
 * - 只统计本应用自己写的目录，不把 Chromium 的 Cache/GPUCache 算进来（那部分不可清理，
 *   混进来只会让数字变得无法解释）；
 * - 所有清理动作都先 path.resolve 再校验落在 userData 内，杜绝「拼接路径越界删库」。
 */

export type StorageScope = 'sessions' | 'attachments' | 'exports'
export type StorageEntryKey = StorageScope | 'snapshots' | 'config'

export interface StorageEntry {
  key: StorageEntryKey
  label: string
  bytes: number
  files: number
}

export interface StorageReport {
  entries: StorageEntry[]
  /** 上列条目之和（本应用自管数据） */
  totalBytes: number
  /** 所在卷的可用 / 总容量，用于「已用 vs 可用」的直观对比 */
  diskFreeBytes: number
  diskTotalBytes: number
  userDataDir: string
}

export interface ClearResult {
  scope: StorageScope
  removedFiles: number
  freedBytes: number
}

/** 递归统计目录：文件数 + 字节数。读不到就当 0（权限/占用中不阻塞界面） */
export function dirUsage(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (d: string): void => {
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      const p = path.join(d, it.name)
      if (it.isDirectory()) {
        walk(p)
        continue
      }
      try {
        bytes += fs.statSync(p).size
        files += 1
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return { bytes, files }
}

/** 一组单个文件的合计（userData 根下的几个 json） */
function fileListUsage(list: readonly string[]): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  for (const f of list) {
    try {
      const st = fs.statSync(f)
      if (st.isFile()) {
        bytes += st.size
        files += 1
      }
    } catch {
      /* 不存在就跳过 */
    }
  }
  return { bytes, files }
}

function diskSpace(dir: string): { free: number; total: number } {
  try {
    const st = fs.statfsSync(dir)
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }
  } catch {
    // statfs 不可用（老 Node / 特殊文件系统）时不阻断报告，只是不显示容量
    return { free: 0, total: 0 }
  }
}

export interface StoragePathsOptions {
  userDataDir: string
  exportsDir?: string
  attachmentsDir?: string
  snapshotsDir?: string
  sessionsDir?: string
}

/**
 * 统计本应用自管数据的分布。
 * 条目顺序固定为「用户能理解的数据分类」：会话 / 附件 / 快照 / 导出 / 设置，
 * 不按大小排序 —— 顺序稳定才好和上一次对照。
 * 支持传入独立自定义目录。
 */
export function measureStorage(arg: string | StoragePathsOptions): StorageReport {
  const opts = typeof arg === 'string' ? { userDataDir: arg } : arg
  const userDataDir = opts.userDataDir
  const p = (...s: string[]): string => path.join(userDataDir, ...s)
  const exportsDir = opts.exportsDir || p('exports')
  const attachmentsDir = opts.attachmentsDir || p('attachments')
  const snapshotsDir = opts.snapshotsDir || p('snapshots-data')
  const sessionsDir = opts.sessionsDir || p('sessions')

  const configFiles = fileListUsage([p('ensp-auto.json'), p('topology.json'), p('api-keys.json')])
  const skills = dirUsage(p('skills'))
  const entries: StorageEntry[] = [
    { key: 'sessions', label: '会话历史', ...dirUsage(sessionsDir) },
    { key: 'attachments', label: '附件归档', ...dirUsage(attachmentsDir) },
    { key: 'snapshots', label: '配置快照', ...dirUsage(snapshotsDir) },
    { key: 'exports', label: '导出报告', ...dirUsage(exportsDir) },
    {
      key: 'config',
      label: '设置与技能',
      bytes: configFiles.bytes + skills.bytes,
      files: configFiles.files + skills.files
    }
  ]
  const { free, total } = diskSpace(userDataDir)
  return {
    entries,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    diskFreeBytes: free,
    diskTotalBytes: total,
    userDataDir
  }
}

/**
 * 目标路径必须**严格**落在 userData 内（自身与越界都拒绝）。
 *
 * 注意（D4，2026-09-23）：这条规则比「是否归我们管」**更紧**，不适合用来判断
 * 「能不能清理」。attachments / exports 支持自定义到任意目录，用本函数当清理判据
 * 会让「换了自定义目录」的用户 100% 清不了数据（R17 的过度收紧）。
 * 清理类判据请用「受管根白名单 + `assertInsideOrEqual`」（见 `services.ts#clearData`）。
 */
export function assertInside(userDataDir: string, target: string): void {
  const root = path.resolve(userDataDir)
  const t = path.resolve(target)
  const rel = path.relative(root, t)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝操作数据目录之外的路径：${t}`)
  }
}

/** 允许 target 等同于 rootDir 或位于 rootDir 之下 */
export function assertInsideOrEqual(rootDir: string, target: string): void {
  const root = path.resolve(rootDir)
  const t = path.resolve(target)
  if (root === t) return
  const rel = path.relative(root, t)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝操作受管目录之外的路径：${t}`)
  }
}

/**
 * 是否磁盘/文件系统根（`D:\`、`/`）。
 *
 * 清理与迁移都必须显式拒绝根目录当目标：`emptyDir('D:\\')` 会删掉整个盘，
 * 而这类值只可能来自被手工改坏或恶意的设置项。
 */
export function isDriveRoot(target: string): boolean {
  const t = path.resolve(target)
  return path.dirname(t) === t
}

/**
 * 校验「切换数据主目录」的目标，返回解析后的绝对路径。
 *
 * 先校验再 resolve 是关键：`path.resolve('')` 返回进程工作目录、永远不为假，
 * 所以 `if (!resolved) throw` 是一句死代码 —— 空串会「悄悄把数据目录设成 cwd」。
 */
export function validateUserDataTarget(raw: unknown, currentUserDataDir: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('目标路径无效：请选择一个具体目录')
  }
  const resolved = path.resolve(raw.trim())
  if (isDriveRoot(resolved)) {
    throw new Error(`不能把数据主目录设为磁盘根目录：${resolved}`)
  }
  if (resolved === path.resolve(currentUserDataDir)) {
    throw new Error('目标目录与当前数据目录相同，无需切换')
  }
  return resolved
}

/** 各可清理范围对应的目录名（IPC 层做二次校验与提示文案用） */
export const SCOPE_DIR: Record<StorageScope, string> = {
  sessions: 'sessions',
  attachments: 'attachments',
  exports: 'exports'
}

/** 三个受管根：数据根 / 附件归档 / 报告导出（后两者可被设置指到自定义目录） */
export interface ManagedRoots {
  userDataDir: string
  attachmentsDir: string
  exportsDir: string
}

/**
 * 校验清理目标，返回 resolve 后的绝对路径；不合法抛错（**删除任何文件之前**调用）。
 *
 * D4（2026-09-23）：判据从 R17 的「是否在 userData 之下」改成**受管根白名单**。
 * 后者把「用了自定义附件/导出目录」的用户全部误杀（功能 100% 不可用，且报的是
 * 安全告警式文案）；前者才是「是否归我们管」的正确表达。
 *
 * 三条硬规则：
 * 1. 必须落在三个受管根之一（含其子目录）—— 否则等于删别人的文件；
 * 2. 不能等于数据根**本身** —— 它会一次性带走设置、技能、快照与会话；
 * 3. 不能是盘根 —— `emptyDir('D:\\')` 会清掉整个盘。
 */
export function checkClearTarget(roots: ManagedRoots, rawTarget: string): string {
  const target = path.resolve(rawTarget)
  const allowed = [roots.userDataDir, roots.attachmentsDir, roots.exportsDir].map((r) => path.resolve(r))
  const inAllowed = allowed.some((root) => {
    try {
      assertInsideOrEqual(root, target)
      return true
    } catch {
      return false
    }
  })
  if (!inAllowed) {
    throw new Error(
      `拒绝清理未受管目录：${target}。清理目标只能落在数据根、附件目录或导出目录（含其子目录）内`
    )
  }
  if (target === path.resolve(roots.userDataDir)) {
    throw new Error('拒绝清空数据根目录本身，请选择具体的数据类别（会话 / 附件 / 报告）')
  }
  if (isDriveRoot(target)) {
    throw new Error(`拒绝清理磁盘根目录：${target}`)
  }
  return target
}

/** 目录类设置项的长度上限（与 ensp.exePath 同一口径） */
export const MAX_DIR_PATH_LEN = 512

/** 可自定义的三个子目录（userDataDir 走 bootstrap，不在此列，见 validateUserDataTarget） */
export type CustomDirKey = 'exportsDir' | 'attachmentsDir' | 'snapshotsDir'

/**
 * 清洗 storage 设置补丁（IPC 白名单用）。
 *
 * 三条纪律：
 * - 白名单字段：只认 exports/attachments/snapshots 三个子目录；
 * - 空串 = 恢复默认（这是唯一允许「清空」的写法）；
 * - 非字符串 / 超长 / 盘根一律带可读原因拒绝，不静默丢弃也不静默收敛
 *   （静默收敛会让界面显示与实际生效的值不一致，正是 R16 那类问题的温床）。
 */
export function sanitizeStorageSettings(
  patch: unknown,
  cur: { userDataDir: string; exportsDir: string; attachmentsDir: string; snapshotsDir: string }
): { userDataDir: string; exportsDir: string; attachmentsDir: string; snapshotsDir: string } {
  const p = (patch ?? {}) as Record<string, unknown>
  const dirOf = (v: unknown, fallback: string): string => {
    if (v === undefined) return fallback
    // 非字符串按「非法」处理而不是当空串：空串的语义是「恢复默认」，
    // 把 42 当成恢复默认会静静地改掉用户的目录
    if (typeof v !== 'string') throw new Error('目录必须是字符串（传空串表示恢复默认）')
    const t = v.trim()
    if (!t) return ''
    if (t.length > MAX_DIR_PATH_LEN) {
      throw new Error(`路径过长（上限 ${MAX_DIR_PATH_LEN} 字符），请换一个更短的目录`)
    }
    if (isDriveRoot(t)) {
      throw new Error(`不能把数据目录设为磁盘根目录：${t}`)
    }
    return t
  }
  return {
    // userDataDir 的唯一真相源是 storage-bootstrap.json（切换需重启 + 可选迁移）
    userDataDir: cur.userDataDir,
    exportsDir: dirOf(p['exportsDir'], cur.exportsDir),
    attachmentsDir: dirOf(p['attachmentsDir'], cur.attachmentsDir),
    snapshotsDir: dirOf(p['snapshotsDir'], cur.snapshotsDir)
  }
}

export function scopeDir(userDataDir: string, scope: StorageScope): string {
  return path.join(userDataDir, SCOPE_DIR[scope])
}

/** 清空目录内容但保留目录本身（目录会被上层 store 继续复用） */
export function emptyDir(dir: string): number {
  let removed = 0
  if (!fs.existsSync(dir)) return 0
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, it.name)
    try {
      fs.rmSync(p, { recursive: true, force: true })
      removed += 1
    } catch {
      /* 被占用（如正在写入）时跳过，不中断整次清理 */
    }
  }
  return removed
}
