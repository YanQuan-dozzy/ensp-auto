import fs from 'node:fs'
import path from 'node:path'
import type { Skill, SkillSummary } from '@shared/types'
import { type SkillContent } from './prompt'
import {
  buildSkillMarkdown,
  deriveSkillMeta,
  fileNameToSkillName,
  isValidSkillId,
  parseSkillContent,
  skillIdBase,
  stripFrontmatter,
  uniqueSkillId
} from './parse'
import { BUILTIN_SKILLS } from './builtin'
import { atomicWriteFileSync, atomicWriteJsonSync } from '../core/fs/atomic'
import { structuredCloneSafe } from '@shared/clone'

/**
 * SkillStore —— 主进程技能状态的唯一真相。
 *
 * 存储布局（userData/skills/）：
 * - <id>.skill.md     每个技能一个 Markdown 文件（正文含 frontmatter 原文，可编辑）
 * - meta.json         元信息：seeded（是否已预置内置技能）、enabled（启用的 id）、
 *                     builtin（由来）、createdAt 时间戳
 *
 * 与 TopologyStore 相同的纪律：不依赖 Electron，便于 harness 单测；
 * 每次变更 persist + publish（onChange → EVENT.skillsUpdated）。
 */

export interface SkillStoreOptions {
  dir: string
  onChange?: (summaries: SkillSummary[]) => void
}

interface Meta {
  version: 1
  seeded: boolean
  enabled: string[]
  builtin: string[]
  createdAt: Record<string, number>
}

const EMPTY_META: Meta = { version: 1, seeded: false, enabled: [], builtin: [], createdAt: {} }

export interface ImportSkillResult {
  created: SkillSummary[]
  /** 未导入原因：重复 id / 非 .md / readme */
  skipped: string[]
}

export interface SaveSkillInput {
  /** 为空表示新建（主进程生成 id）；否则必须是合法 id */
  id?: string
  name?: string
  description?: string
  content: string
}

export class SkillStore {
  private meta: Meta = structuredCloneSafe(EMPTY_META)
  /** 加载/写入期发现的问题（供上层提示与测试断言） */
  private loadWarnings: string[] = []
  /**
   * 列表缓存（T4.7）。
   *
   * `list()` 过去对每个技能做 3 次同步 IO（exists / readFile / stat），
   * 而它在每次写操作后（publish）与每次 IPC 列举时都会被调用 ——
   * 20 个技能就是 60 次同步读盘。技能是低频写入的数据，进程内缓存足够，
   * 写路径统一在 publish()/writeSkill() 里失效。
   */
  private listCache: SkillSummary[] | null = null

  constructor(private readonly opts: SkillStoreOptions) {
    this.loadMeta()
    this.seedBuiltins()
  }

  get warnings(): readonly string[] {
    return this.loadWarnings
  }

  // ———————————————— 内部持久化 ————————————————

  private metaFile(): string {
    return path.join(this.opts.dir, 'meta.json')
  }

  private skillFile(id: string): string {
    return path.join(this.opts.dir, `${id}.skill.md`)
  }

  private loadMeta(): void {
    try {
      if (!fs.existsSync(this.metaFile())) return
      const parsed = JSON.parse(fs.readFileSync(this.metaFile(), 'utf8')) as Partial<Meta>
      this.meta = {
        version: 1,
        seeded: !!parsed.seeded,
        enabled: cleanIds(parsed.enabled),
        builtin: cleanIds(parsed.builtin),
        createdAt: parsed.createdAt && typeof parsed.createdAt === 'object'
          ? { ...(parsed.createdAt as Record<string, number>) }
          : {}
      }
    } catch {
      this.meta = structuredCloneSafe(EMPTY_META)
    }
  }

  /**
   * 落盘元信息。
   *
   * T2.6：不再吞异常。旧实现 `catch { /* 不阻塞 *\/ }` 的后果是「点了启用/删了技能，
   * 界面立即变了、磁盘没变」，重启后全部回弹，用户只会以为软件坏了。
   * 构造期（seedBuiltins）单独兜住，见那里的注释。
   */
  private persistMeta(): void {
    atomicWriteJsonSync(this.metaFile(), this.meta)
  }

  /**
   * 元信息「改内存 + 写盘」的事务封装：写失败回滚内存。
   * R21：不回滚的话，界面与磁盘的不一致会一直挂着，直到下次重启才暴露。
   */
  private commitMeta<T>(mutate: () => T): T {
    const before = structuredCloneSafe(this.meta)
    const result = mutate()
    try {
      this.persistMeta()
    } catch (e) {
      this.meta = before
      throw e
    }
    return result
  }

  private publish(): void {
    // 写路径的收敛点：先失效缓存，再对外广播最新列表（T4.7）
    this.invalidateListCache()
    this.opts.onChange?.(this.list())
  }

  /** 首次启动预置内置技能；seeded 落盘后不再重复（用户删除的不会被复活） */
  private seedBuiltins(): void {
    if (this.meta.seeded) return
    const existing = new Set(this.listIds())
    const seeded: string[] = []
    const createdAt: Record<string, number> = { ...this.meta.createdAt }
    const now = Date.now()
    for (const def of BUILTIN_SKILLS) {
      if (existing.has(def.id)) continue
      this.writeSkill(def.id, def.content)
      seeded.push(def.id)
      if (!(def.id in createdAt)) createdAt[def.id] = now
    }
    if (seeded.length > 0 || this.meta.builtin.length === 0) {
      this.meta.builtin = [...new Set([...this.meta.builtin, ...seeded])]
    }
    this.meta.createdAt = createdAt
    this.meta.seeded = true
    // 构造期不因落盘失败让整个应用起不来：降级为「本次会话内有效」并留下告警
    try {
      this.persistMeta()
    } catch (e) {
      const msg = `内置技能元信息写入失败：${e instanceof Error ? e.message : String(e)}`
      this.loadWarnings.push(msg)
      console.warn(`[skills] ${msg}`)
    }
  }

  // ———————————————— 读取 ————————————————

  private listIds(): string[] {
    try {
      if (!fs.existsSync(this.opts.dir)) return []
      return fs
        .readdirSync(this.opts.dir)
        .filter((f) => f.endsWith('.skill.md'))
        .map((f) => f.slice(0, -'.skill.md'.length))
        .filter(isValidSkillId)
        .sort()
    } catch {
      return []
    }
  }

  private readSkill(id: string): Skill | null {
    const file = this.skillFile(id)
    try {
      if (!fs.existsSync(file)) return null
      const raw = fs.readFileSync(file, 'utf8')
      const meta = deriveSkillMeta(raw, fileNameToSkillName(id))
      const stat = fs.statSync(file)
      return {
        id,
        name: meta.name,
        description: meta.description,
        content: raw,
        enabled: this.meta.enabled.includes(id),
        builtin: this.meta.builtin.includes(id),
        createdAt: this.meta.createdAt[id] ?? stat.birthtimeMs ?? Date.now(),
        updatedAt: stat.mtimeMs
      }
    } catch {
      return null
    }
  }

  list(): SkillSummary[] {
    if (this.listCache) return this.listCache.map((s) => ({ ...s }))
    const computed = this.listIds()
      .map((id) => this.readSkill(id))
      .filter((s): s is Skill => !!s)
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
        return b.updatedAt - a.updatedAt
      })
      .map(toSummary)
    this.listCache = computed
    return computed.map((s) => ({ ...s }))
  }

  /** 让列表缓存失效（任何落盘变更后都要调） */
  private invalidateListCache(): void {
    this.listCache = null
  }

  get(id: string): Skill | null {
    return isValidSkillId(id) ? this.readSkill(id) : null
  }

  /** 已启用技能的注入内容（system prompt 用） */
  enabledContents(): SkillContent[] {
    return this.meta.enabled
      .filter((id) => this.meta.enabled.includes(id))
      .map((id) => this.readSkill(id))
      .filter((s): s is Skill => !!s)
      .map((s) => ({ name: s.name, description: s.description, content: s.content }))
  }

  // ———————————————— 写操作 ————————————————

  private writeSkill(id: string, content: string): void {
    // T2.5：统一原子写（技能正文是纯文本，用文本版）
    atomicWriteFileSync(this.skillFile(id), content)
    // 文件变了，进程内列表缓存必然过期（seedBuiltins 走的就是这条路径）
    this.invalidateListCache()
  }

  /** 新建或更新技能。id 为空 → 由 name 生成唯一 id。
   * input.content 是编辑器正文（不含 frontmatter）；保存时统一组装成
   * 「frontmatter(name/description) + 正文」，保证名称/描述与文件一致。 */
  save(input: SaveSkillInput): Skill {
    const body = stripFrontmatter(input.content ?? '')
    if (!body.trim()) throw new Error('技能内容不能为空')

    const existing = input.id && isValidSkillId(input.id) ? this.readSkill(input.id) : null
    const name = (input.name ?? '').trim() || (existing?.name ?? '未命名技能')
    const description = (input.description ?? '').trim() || (existing?.description ?? '')

    let id = input.id ?? ''
    if (!id || !isValidSkillId(id)) {
      id = uniqueSkillId(skillIdBase(name, 'skill'), new Set(this.listIds()))
    } else {
      // 显式 id 但文件不存在 → 视为新建；已存在 → 更新（内容仍以传入为准）
      if (!existing) {
        const ids = new Set(this.listIds())
        if (ids.has(id)) throw new Error(`技能 ID 已存在：${id}`)
      }
    }

    this.writeSkill(id, buildSkillMarkdown(name, description, body))
    this.commitMeta(() => {
      if (!(id in this.meta.createdAt)) this.meta.createdAt[id] = Date.now()
      if (existing?.builtin && !this.meta.builtin.includes(id)) this.meta.builtin.push(id)
    })
    this.publish()
    const saved = this.readSkill(id)
    if (!saved) throw new Error('技能保存后读取失败')
    return saved
  }

  remove(id: string): boolean {
    if (!isValidSkillId(id) || !this.readSkill(id)) return false
    try {
      fs.rmSync(this.skillFile(id), { force: true })
    } catch {
      return false
    }
    this.commitMeta(() => {
      this.meta.enabled = this.meta.enabled.filter((x) => x !== id)
      this.meta.builtin = this.meta.builtin.filter((x) => x !== id)
      delete this.meta.createdAt[id]
    })
    this.publish()
    return true
  }

  /** 整体替换启用集合（渲染层勾选后整表提交，原子持久化） */
  setEnabled(ids: string[]): SkillSummary[] {
    const valid = new Set(this.listIds())
    this.commitMeta(() => {
      this.meta.enabled = [...new Set(cleanIds(ids).filter((id) => valid.has(id)))]
    })
    this.publish()
    return this.list()
  }

  /** 从一组 .md 文件导入技能（文件选择/目录扫描共用），同名 id 已存在则跳过 */
  importFromPaths(filePaths: string[]): ImportSkillResult {
    const existing = new Set(this.listIds())
    const created: SkillSummary[] = []
    const skipped: string[] = []

    for (const filePath of filePaths) {
      let ext: string
      let isDir = false
      try {
        const stat = fs.statSync(filePath)
        isDir = stat.isDirectory()
        ext = isDir ? '.md' : path.extname(filePath).toLowerCase()
      } catch {
        skipped.push(path.basename(filePath))
        continue
      }
      if (!isDir) {
        this.importOneFile(filePath, ext, existing, created, skipped)
        continue
      }
      // 目录：递归收集 .md（覆盖 SKILL.md / *.skill.md 子目录场景），跳过 readme
      for (const f of walkMarkdown(filePath)) {
        this.importOneFile(f, '.md', existing, created, skipped)
      }
    }
    // 导入期 created 只是「写成功了哪些」；元信息落盘失败必须让调用方看到
    this.persistMeta()
    this.publish()
    return { created, skipped }
  }

  private importOneFile(
    filePath: string,
    ext: string,
    existing: Set<string>,
    created: SkillSummary[],
    skipped: string[]
  ): void {
    const base = path.basename(filePath)
    if (ext !== '.md' || /^readme\.md$/i.test(base)) {
      skipped.push(`${base}（非技能文档）`)
      return
    }
    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf8')
    } catch {
      skipped.push(`${base}（读取失败）`)
      return
    }
    const fallbackName = fileNameToSkillName(path.basename(filePath, '.md'))
    const meta = deriveSkillMeta(raw, fallbackName)
    const idBase = skillIdBase(meta.name, fallbackName)

    // 落盘内容先算出来：有 frontmatter 就原样存，没有就补一份（前缀文件名转的可读名），
    // 避免后续 readSkill 只能回退到 id 名（如 SKILL.md → skill）
    const content = parseSkillContent(raw).name
      ? raw
      : buildSkillMarkdown(meta.name, meta.description, meta.body)

    // R46：同基名不再一律跳过。先看「有没有一份内容完全相同的」——有才是真重复，
    // 明确报「已存在」；否则按 -2/-3… 分配新 id，让同目录里的同名（如多个中文名）
    // 文件都能导入进来，而不是只留第一个、其余静默消失。
    const identical = this.findIdenticalContent(idBase, content, existing)
    if (identical) {
      skipped.push(`${path.basename(filePath)}（已存在：${identical}）`)
      return
    }
    const id = uniqueSkillId(idBase, existing)
    existing.add(id)
    this.writeSkill(id, content)
    if (!(id in this.meta.createdAt)) this.meta.createdAt[id] = Date.now()
    const skill = this.readSkill(id)
    if (skill) created.push(toSummary(skill))
  }

  /**
   * 在「同 id 基名」的候选里找内容一致的那份（skill、skill-2、skill-3…）。
   *
   * 只沿着同基名往后找，不做全量扫描：导入一批文件时的读盘量与「重复技能数」成正比，
   * 而不是与技能总数成正比。
   */
  private findIdenticalContent(
    idBase: string,
    content: string,
    existing: ReadonlySet<string>
  ): string | null {
    if (!existing.has(idBase)) return null
    const candidates = [idBase]
    for (let i = 2; existing.has(`${idBase}-${i}`); i++) candidates.push(`${idBase}-${i}`)
    for (const id of candidates) {
      if (this.readSkill(id)?.content === content) return id
    }
    return null
  }
}

// ———————————————— helpers ————————————————

function toSummary(s: Skill): SkillSummary {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    enabled: s.enabled,
    builtin: s.builtin,
    updatedAt: s.updatedAt
  }
}

function cleanIds(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list.filter((v): v is string => typeof v === 'string' && isValidSkillId(v))
}

/** 递归收集目录下所有 .md 文件（按名称排序，结果确定） */
export function walkMarkdown(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(d, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(p)
      }
    } catch {
      /* 子目录不可读则跳过 */
    }
  }
  walk(dir)
  return out
}
