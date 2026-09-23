/**
 * 技能 Markdown 解析（纯函数，可测）。
 *
 * 参考 Claude Code / Trae skills 与 ensp-skills 仓库的约定：
 * - 技能文件可以是 `*.skill.md` 或任意 `.md`（如 SKILL.md）
 * - 支持前导 `---` frontmatter：`name` / `description` 两个键（宽松解析，值可带引号）
 * - 无 frontmatter 时退化为「文件名作名称 + 首个标题/首行作描述」
 */

export interface ParsedSkillMeta {
  name: string
  description: string
  /** 剥离 frontmatter 后的正文（用于描述兜底） */
  body: string
}

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** 宽松解析 frontmatter 键值：`name: xxx` 或 `description: "xxx"`，其余键忽略 */
export function parseSkillContent(raw: string): ParsedSkillMeta {
  const m = FRONTMATTER_RE.exec(raw.replace(/^\uFEFF/, ''))
  if (!m) return { name: '', description: '', body: raw.trim() }

  let name = ''
  let description = ''
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^[\s]*([A-Za-z_-]+)[\s]*:[\s]*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]!.toLowerCase()
    const val = kv[2]!.trim().replace(/^["']|["']$/g, '')
    if (!val) continue
    if (key === 'name') name = val
    else if (key === 'description' || key === 'desc') description = val
  }
  return { name, description, body: (m[2] ?? '').trim() }
}

/** 从 Markdown 正文里提取首个标题行（# / ## 级别）作为候选描述 */
export function firstHeading(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const h = /^\s*#{1,2}\s+(.+?)\s*$/.exec(line)
    if (h) return h[1]!.trim()
  }
  return ''
}

/** 从正文首段非空行提取描述（截断到 maxLen） */
export function firstLine(body: string, maxLen = 120): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t
  }
  return ''
}

/** 生成技能元信息：frontmatter 优先，缺省回退文件名 / 标题 / 首行 */
export function deriveSkillMeta(raw: string, fallbackName: string): ParsedSkillMeta {
  const parsed = parseSkillContent(raw)
  const name = parsed.name || fallbackName || '未命名技能'
  const description =
    parsed.description || firstHeading(parsed.body) || firstLine(parsed.body, 120) || ''
  return { name, description, body: parsed.body }
}

/** 从文件名（如 ensp-config.skill.md / SKILL.md）整理出可读名称 */
export function fileNameToSkillName(fileName: string): string {
  const base = fileName.replace(/\.skill\.md$/i, '').replace(/\.md$/i, '')
  if (!base) return 'SKILL'
  return base.replace(/[-_]+/g, ' ')
}

/** 生成安全的文件名 slug（技能 id）。
 * 只保留小写字母/数字/连字符；纯中文或空串回退 fallback。
 */
export function slugify(name: string, fallback = 'skill'): string {
  const s = slugifyRaw(name)
  return /^[a-z0-9]/.test(s) ? s : fallback
}

/** slugify 的「不兜底」版本：中文/符号名会得到空串，调用方自己决定怎么退 */
export function slugifyRaw(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidSkillId(id: string): boolean {
  return ID_RE.test(id)
}

/**
 * 由名称生成稳定的技能 id 基名。
 *
 * R46：这里必须用**不兜底**的 slug。旧实现调 `slugify(name)`，而 slugify 在
 * slug 为空时会自己返回字面量 `'skill'`（长度 5 ≥ 3），于是第二个参数
 * （文件名基名）永远走不到 —— 一批中文名技能全部挤在 `skill` 上，
 * 导入结果只剩第一个，其余被当成「已存在同名技能」静默丢掉。
 */
export function skillIdBase(name: string, fallback: string): string {
  const s = slugifyRaw(name)
  if (s.length >= 3) return s
  const f = slugifyRaw(fallback)
  if (f.length >= 3) return f
  // 两边都太短（纯中文名 + 纯中文文件名）：给一个合法基名，
  // 具体落成什么 id 由 uniqueSkillId 在同批次内去重决定，绝不返回空串。
  if (s) return s
  if (f) return f
  return 'skill'
}

/** 在已有 id 集合里去重（追加 -2/-3… 后缀） */
export function uniqueSkillId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base
  for (let i = 2; ; i++) {
    const next = `${base}-${i}`
    if (!existing.has(next)) return next
  }
}

/** 剥离前导 frontmatter，返回正文（无 frontmatter 时原样返回） */
export function stripFrontmatter(raw: string): string {
  const m = FRONTMATTER_RE.exec(raw.replace(/^\uFEFF/, ''))
  return m ? (m[2] ?? '').trim() : raw.trim()
}

/** 把「正文 + 元信息」组装成带 frontmatter 的完整技能 Markdown */
export function buildSkillMarkdown(name: string, description: string, body: string): string {
  const meta = [`name: ${quoteValue(name || '未命名技能')}`]
  if ((description || '').trim()) meta.push(`description: ${quoteValue(description.trim())}`)
  const normalizedBody = (body ?? '').replace(/^\uFEFF?/, '').trim()
  return `---\n${meta.join('\n')}\n---\n${normalizedBody ? `\n${normalizedBody}\n` : ''}`
}

function quoteValue(v: string): string {
  // 含冒号等特殊字符时加引号，避免破坏 frontmatter 解析
  return /[:#[\]]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v
}