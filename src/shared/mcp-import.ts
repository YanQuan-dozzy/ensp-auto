import { MCP_SERVER_SEGMENT_MAX, sanitizeNameSegment } from './naming'
import { newMcpServerId } from './profiles'
import type { McpServerConfig } from './types'

/**
 * 「手动配置」—— 粘贴一段 JSON 就挂上外部 MCP 服务器（v1.6）。
 *
 * 为什么需要：真实世界里没人手抄 command / args。MCP 服务器的官方介绍页给的
 * 就是一段 JSON，Trae / Claude / Cursor 也都是「粘贴 JSON」这个交互。
 * 本应用此前只能一个字段一个字段填，等于把最容易出错的一步留给了用户。
 *
 * 三件必须做对的事：
 * 1. **认多种写法**：`{mcpServers:{...}}`（Claude / 本应用）、`{servers:{...}}`（VS Code）、
 *    裸的「名字 → 配置」对象、以及带 `name` 字段的数组。用户不会替你规范格式。
 * 2. **容忍注释与尾逗号**：官方文档里的示例 JSON 十有八九带 `//` 注释，直接
 *    `JSON.parse` 会报「Unexpected token /」——那不是用户错，是工具不友好。
 * 3. **不假装支持**：`env` / `headers` 这类字段本应用的连接层不注入，必须**明说被忽略**，
 *    否则用户会困惑「我明明配了 API Key 为什么不生效」。宁可诚实地报一条 warning。
 *
 * 解析结果只描述「要导入什么」，不碰磁盘 —— 落盘由 IPC 层的 settingsSet 白名单负责。
 */

/** 粘贴框里的示例（界面直接展示；带注释是为了示范「注释也能吃」） */
export const MCP_IMPORT_EXAMPLE = `// 从 MCP 服务器的介绍页复制 JSON，整段粘进来即可
// 支持 { "mcpServers": {...} } / { "servers": {...} } / 直接写服务器对象
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "F:/lab"]
    },
    "internal-api": {
      "type": "http",
      "url": "http://10.0.0.8:3000/mcp"
    }
  }
}`

export interface McpImportResult {
  ok: boolean
  /** ok=false 时的原因（一句话，直接展示在粘贴框下方） */
  error?: string
  servers: McpServerConfig[]
  /** 逐条「跳过了什么 / 忽略了什么 / 名字被收敛成什么」，导入后在界面上明说 */
  warnings: string[]
}

/** spec 里被本应用认下来的字段；其余一律进 warnings，不静默吞掉 */
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'url',
  'serverUrl',
  'httpUrl',
  'command',
  'args',
  'type',
  'transport',
  'disabled',
  'enabled'
])

/** 判断一个对象「像不像服务器配置」——用于识别裸的名字映射写法 */
const CANDIDATE_RE = /^(command|url|serverUrl|httpUrl|type|transport)$/

/** 本应用不注入这些连接参数，需要在界面上明说，而不是当没看见 */
const UNSUPPORTED_KEYS: Record<string, string> = {
  env: '环境变量',
  headers: '请求头'
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function asMap(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * 去掉 `//`、`/* *\/` 注释与尾逗号 —— 带字符串状态机，绝不误伤字符串里的 `//`
 * （例如 URL `"http://x"` 或路径 `"F:/lab"`）。
 */
export function relaxJson(text: string): string {
  let stripped = ''
  let i = 0
  let inStr = false
  while (i < text.length) {
    const c = text[i]!
    if (inStr) {
      if (c === '\\') {
        stripped += c + (text[i + 1] ?? '')
        i += 2
        continue
      }
      stripped += c
      if (c === '"') inStr = false
      i += 1
      continue
    }
    const n = text[i + 1]
    if (c === '"') {
      inStr = true
      stripped += c
      i += 1
      continue
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    stripped += c
    i += 1
  }
  return stripTrailingCommas(stripped)
}

function stripTrailingCommas(s: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!
    if (inStr) {
      if (c === '\\') {
        out += c + (s[i + 1] ?? '')
        i += 1
        continue
      }
      out += c
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === ',') {
      // 只在后面（跳过空白）紧跟 } 或 ] 时丢弃 —— 数组里的正常逗号必须留着
      let j = i + 1
      while (j < s.length && /\s/.test(s[j]!)) j += 1
      if (s[j] === '}' || s[j] === ']') continue
    }
    out += c
  }
  return out
}

/** 现有服务器 + 本批次内的名字去重：名字就是工具命名空间的来源，重了模型侧会撞名 */
function makeUniquifier(existing: readonly McpServerConfig[]): (base: string) => string {
  const used = new Set(existing.map((s) => s.name))
  return (base: string): string => {
    const seed = base || 'server'
    if (!used.has(seed)) {
      used.add(seed)
      return seed
    }
    for (let i = 2; i < 1000; i += 1) {
      const c = `${seed}-${i}`
      if (!used.has(c)) {
        used.add(c)
        return c
      }
    }
    const c = `${seed}-${used.size + 1}`
    used.add(c)
    return c
  }
}

/** 配置指纹：用来识别「这段 JSON 我上次已经导过了」 */
function fingerprint(transport: string, url: string, command: string, args: string[]): string {
  return `${transport}\u0000${url || `${command} ${args.join(' ')}`}`
}

type Normalized = { cfg: McpServerConfig; notes: string[] } | { skip: string }

/** 一个条目（原始名 + spec）→ McpServerConfig */
function normalizeSpec(spec: Record<string, unknown>, name: string): Normalized {
  const notes: string[] = []

  const url = asString(spec.url) ?? asString(spec.serverUrl) ?? asString(spec.httpUrl)
  const command = asString(spec.command)
  let kind = (asString(spec.type) ?? asString(spec.transport) ?? '').toLowerCase()

  if (kind === 'sse') {
    notes.push('`type: sse` 是旧式 SSE 端点，本应用走 Streamable HTTP，可能连不上')
    kind = 'http'
  } else if (kind === 'streamable-http' || kind === 'streamablehttp') {
    kind = 'http'
  } else if (kind === 'command' || kind === 'process') {
    kind = 'stdio'
  } else if (kind && kind !== 'http' && kind !== 'stdio') {
    notes.push(`传输方式 \`${kind}\` 不认识，已按 command / url 推断`)
    kind = ''
  }

  if (!url && !command) return { skip: '既没有 command 也没有 url' }
  if (kind === 'http' && !url) return { skip: '声明了 HTTP 传输但没有 url' }
  if (kind === 'stdio' && !command) return { skip: '声明了 stdio 传输但没有 command' }

  // 没声明传输方式时按「有 url 就是 HTTP」推断；两边都有则 URL 优先（远端更明确）
  const useHttp = kind === 'http' ? true : kind === 'stdio' ? false : Boolean(url)
  if (url && command && useHttp) notes.push('同时给了 command 与 url，已按 HTTP 导入')
  if (url && command && !useHttp) notes.push('同时给了 command 与 url，已按 stdio 导入')

  let args: string[] = []
  if (Array.isArray(spec.args)) {
    const bad = spec.args.filter((a) => typeof a !== 'string').length
    args = spec.args.filter((a): a is string => typeof a === 'string')
    if (bad > 0) notes.push(`${bad} 个非字符串参数被丢弃`)
  } else if (typeof spec.args === 'string' && spec.args.trim()) {
    args = spec.args.trim().split(/\s+/)
    notes.push('args 是字符串，已按空格拆分')
  } else if (spec.args !== undefined && spec.args !== null && !Array.isArray(spec.args)) {
    notes.push('args 类型无法识别，已忽略')
  }

  for (const k of Object.keys(spec)) {
    if (KNOWN_KEYS.has(k)) continue
    const what = UNSUPPORTED_KEYS[k]
    notes.push(
      what
        ? `\`${k}\`（${what}）被忽略 —— 本应用的连接层不注入它`
        : `\`${k}\` 不是本应用认识的字段，已忽略`
    )
  }

  const cfg: McpServerConfig = {
    id: newMcpServerId(),
    name,
    transport: useHttp ? 'http' : 'stdio',
    url: useHttp ? (url ?? '') : '',
    command: useHttp ? '' : (command ?? ''),
    args: useHttp ? [] : args,
    // 停用的服务器也导入：用户得先看见它，才知道自己导进来了
    enabled: !(spec.disabled === true || spec.enabled === false),
    // 绝不因为 JSON 里写了 autoApprove 之类就免确认 —— 信任只能逐台点出来
    trusted: false
  }
  return { cfg, notes }
}

/** 从三种顶层写法里抽出「服务器名 → spec」列表 */
function pickEntries(root: unknown): Array<{ name: string; spec: Record<string, unknown> }> | string {
  const fromArray = (arr: unknown[]): Array<{ name: string; spec: Record<string, unknown> }> => {
    const out: Array<{ name: string; spec: Record<string, unknown> }> = []
    for (const it of arr) {
      const m = asMap(it)
      const n = m ? asString(m.name) : undefined
      if (m && n) out.push({ name: n, spec: m })
    }
    return out
  }

  const rootMap = asMap(root)
  if (rootMap) {
    const wrapper = asMap(rootMap.mcpServers) ?? asMap(rootMap.servers)
    if (wrapper) {
      return Object.entries(wrapper).flatMap(([name, spec]) => {
        const m = asMap(spec)
        return m ? [{ name, spec: m }] : []
      })
    }
    if (Array.isArray(rootMap.servers)) return fromArray(rootMap.servers as unknown[])
    const values = Object.values(rootMap)
    const looksLikeSpecs =
      values.length > 0 &&
      values.every((v) => {
        const m = asMap(v)
        return m !== null && Object.keys(m).some((k) => CANDIDATE_RE.test(k))
      })
    if (!looksLikeSpecs) {
      return '没认出这是 MCP 配置：需要 `{ "mcpServers": { … } }`、`{ "servers": { … } }`，或直接写出「服务器名 → 配置」的对象。'
    }
    return Object.entries(rootMap).flatMap(([name, spec]) => {
      const m = asMap(spec)
      return m ? [{ name, spec: m }] : []
    })
  }
  if (Array.isArray(root)) {
    const out = fromArray(root)
    return out.length > 0 ? out : '数组形式的配置里每一项都需要 `name` 字段。'
  }
  return '顶层既不是对象也不是数组，粘错文件了？'
}

/**
 * 解析粘贴的 JSON。
 * `existing` 用于名字去重与重复导入识别（同一段 JSON 粘第二遍不会变成两份）。
 */
export function parseMcpServersJson(
  text: string,
  existing: readonly McpServerConfig[] = []
): McpImportResult {
  const fail = (error: string, warnings: string[] = []): McpImportResult => ({
    ok: false,
    error,
    servers: [],
    warnings
  })

  const raw = text.trim()
  if (!raw) return fail('粘贴框是空的 —— 把服务器介绍页里的 JSON 复制进来再试。')

  let root: unknown
  try {
    root = JSON.parse(relaxJson(raw))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return fail(`JSON 解析失败：${msg}`)
  }

  const picked = pickEntries(root)
  if (typeof picked === 'string') return fail(picked)
  if (picked.length === 0) return fail('解析成功，但没有找到任何服务器条目。')

  const uniquify = makeUniquifier(existing)
  const seen = new Set(existing.map((s) => fingerprint(s.transport, s.url, s.command, s.args)))
  const servers: McpServerConfig[] = []
  const warnings: string[] = []

  for (const { name: rawName, spec } of picked) {
    const name = uniquify(sanitizeNameSegment(rawName, MCP_SERVER_SEGMENT_MAX))
    const r = normalizeSpec(spec, name)
    if ('skip' in r) {
      warnings.push(`跳过「${rawName}」：${r.skip}。`)
      continue
    }
    const fp = fingerprint(r.cfg.transport, r.cfg.url, r.cfg.command, r.cfg.args)
    if (seen.has(fp)) {
      warnings.push(`跳过「${rawName}」：同样的连接配置已经在列表里了。`)
      continue
    }
    seen.add(fp)
    servers.push(r.cfg)

    if (name !== rawName.trim()) {
      warnings.push(
        `「${rawName}」的名字按模型命名约束收敛为「${name}」，模型侧工具名是 mcp__${name}__<工具>。`
      )
    }
    if (!r.cfg.enabled) warnings.push(`「${rawName}」在 JSON 里是停用状态，已按停用导入。`)
    for (const n of r.notes) warnings.push(`「${rawName}」：${n}。`)
  }

  if (servers.length === 0) {
    return fail('所有条目都没能导入，原因见下方说明。', warnings)
  }
  return { ok: true, servers, warnings }
}
