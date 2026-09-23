import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig, McpServerStatus, McpToolInfo } from '@shared/types'
import {
  MCP_SERVER_SEGMENT_MAX,
  MCP_TOOL_SEGMENT_MAX,
  sanitizeNameSegment,
  shortHashOf
} from '@shared/naming'

/**
 * 外部 MCP 客户端（v1.5）。
 *
 * v0.4 做的是「对外提供 MCP 服务」；这里补上反方向：用户把自己别的 MCP 服务器
 * （文件系统、内部平台、数据库…）挂进来，工具以 `mcp__<服务器>__<工具>` 注入内置代理。
 * 两个方向刻意不复用同一套连接对象，避免「自己连自己」时把工具表搅成一团。
 *
 * 并发口径（用户可能在代理跑任务时改 MCP 配置）：
 * - sync() 是单飞的：并发调用会串到同一条链上依次执行，最后落地的必是最后一次配置；
 * - 每条连接的建立都带超时，卡死的服务器不会把整个 sync 拖住（超时即记为 error）；
 * - 连接对象按「签名」（传输方式 + 地址 + 参数）复用，配置没变就不重连。
 *
 * 安全口径：外部工具的默认风险等级是 danger（走人工闸门），
 * 用户在设置里对某台服务器勾了「信任」才降为 write。绝不因为「工具是别人提供的」
 * 就假定它无害 —— 恰恰相反。
 */

const CONNECT_TIMEOUT_MS = 8000
const CALL_TIMEOUT_MS = 30000

/** 工具名命名空间前缀（与 MCP 生态惯例一致，一眼能认出是外部工具） */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * 名字约束（字符集 / 长度）已上提到 `@shared/naming` —— 渲染层的「粘贴 JSON 导入」
 * 要在用户确认前就告诉他名字会被收敛成什么，两边必须用同一份规则。
 * 这里保留 re-export，历史调用点（含测试）不受影响。
 */
export { sanitizeNameSegment }

/**
 * 生成对模型可见的工具名。
 * 长度预算：`mcp__`(5) + 段(≤16) + `__`(2) + 工具(≤41) = 64，正好卡在约束上。
 */
export function namespaceToolName(serverName: string, toolName: string): string {
  const name = `${MCP_TOOL_PREFIX}${sanitizeNameSegment(serverName, MCP_SERVER_SEGMENT_MAX)}__${sanitizeNameSegment(toolName, MCP_TOOL_SEGMENT_MAX)}`
  assertToolNameLen(name)
  return name
}

/** MCP 工具名排重（D8）：
 *  - 首轮未碰撞 → 直接用 namespaceToolName（≤64）；
 *  - 碰撞时**先裁工具段、再带哈希后缀** —— 后缀混入工具名，同一服务器内两个
 *    截断后同名的工具后缀也不同（旧实现只取 server id，同类碰撞消除不掉）；
 *  - 恒定长：5 + 16 + 2 + (41 - 7) + 7 = 64，不撑破 OpenAI 兼容端 64 字符上限。
 *  导出供测试（同时这里也是 unit/integration 盯防的排重入口）。
 */
export function dedupeToolName(serverName: string, toolName: string, seen: Set<string>): string {
  const plain = namespaceToolName(serverName, toolName)
  if (!seen.has(plain)) return plain
  const suffixOf = (n: number): string => `_${shortHashOf(`${serverName}:${toolName}:${n}`, 6)}`
  const toolSeg = sanitizeNameSegment(toolName, MCP_TOOL_SEGMENT_MAX - suffixOf(0).length)
  let candidate = `${MCP_TOOL_PREFIX}${sanitizeNameSegment(serverName, MCP_SERVER_SEGMENT_MAX)}__${toolSeg}${suffixOf(0)}`
  for (let n = 1; seen.has(candidate) && n < 64; n++) {
    candidate = `${MCP_TOOL_PREFIX}${sanitizeNameSegment(serverName, MCP_SERVER_SEGMENT_MAX)}__${toolSeg}${suffixOf(n)}`
  }
  assertToolNameLen(candidate)
  return candidate
}

/** 总长硬约束：≤64。开发期 throw（把问题暴露在改动时），生产期截断 + warning 兜底 */
function assertToolNameLen(name: string): void {
  if (name.length <= 64) return
  if (process.env.NODE_ENV !== 'production') {
    throw new Error(`MCP 工具名超长（${name.length} > 64）：${name}`)
  }
  console.warn(`MCP 工具名超长被截断：${name}`)
}

export function isExternalToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX) && name.includes('__', MCP_TOOL_PREFIX.length)
}

/** 供 UI/日志展示：mcp__ensp-auto__list_devices → ensp-auto / list_devices */
export function splitExternalToolName(name: string): { server: string; tool: string } | null {
  if (!isExternalToolName(name)) return null
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const i = rest.indexOf('__')
  if (i <= 0) return null
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) }
}

export interface ExternalToolDef {
  serverId: string
  serverName: string
  /** 服务器原始工具名 */
  toolName: string
  /** 注入模型时的名字（带命名空间） */
  namespaced: string
  description: string
  inputSchema: Record<string, unknown>
  trusted: boolean
}

interface Connection {
  config: McpServerConfig
  signature: string
  client: Client
  tools: McpToolInfo[]
  /** 原始 JSON Schema（工具名 → schema），注入模型时直接透传给 function calling */
  rawSchemas: Map<string, Record<string, unknown>>
  latencyMs: number
}

export interface McpClientManagerOptions {
  /** 状态变化回调（主进程广播给渲染层） */
  onChange?: (statuses: McpServerStatus[]) => void
}

export function signatureOf(cfg: McpServerConfig): string {
  return [cfg.transport, cfg.url, cfg.command, cfg.args.join('\u0000')].join('|')
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

export class McpClientManager {
  private readonly conns = new Map<string, Connection>()
  private readonly statuses = new Map<string, McpServerStatus>()
  private syncing: Promise<McpServerStatus[]> | null = null

  constructor(private readonly opts: McpClientManagerOptions = {}) {}

  list(): McpServerStatus[] {
    return [...this.statuses.values()].map((s) => ({ ...s, tools: [...s.tools] }))
  }

  /**
   * 按配置同步连接。并发调用会串行化（后一次覆盖前一次的结果），
   * 保证同一时刻只有一条 sync 在建立连接。
   */
  sync(configs: readonly McpServerConfig[]): Promise<McpServerStatus[]> {
    const snapshot = configs.map((c) => ({ ...c, args: [...c.args] }))
    const run = (): Promise<McpServerStatus[]> => this.doSync(snapshot)
    const chained = this.syncing ? this.syncing.then(run, run) : run()
    // 记录链尾；即使这一次失败，下一次仍能接着来
    this.syncing = chained.catch(() => [])
    return chained
  }

  private async doSync(configs: readonly McpServerConfig[]): Promise<McpServerStatus[]> {
    const keep = new Set<string>()

    for (const cfg of configs) {
      keep.add(cfg.id)
      const existing = this.conns.get(cfg.id)

      if (!cfg.enabled) {
        if (existing) {
          await this.closeOne(cfg.id)
        }
        this.statuses.set(cfg.id, statusOf(cfg, { connected: false, tools: [] }))
        continue
      }

      if (existing && existing.signature === signatureOf(cfg)) {
        // 连接参数没变：复用连接，但**必须**把配置副本换成最新的 ——
        // trusted / name / enabled 只影响元数据不进签名，否则会出现
        //「刚勾上信任，工具却还是 danger」这种只在内存里错的状态。
        existing.config = { ...cfg, args: [...cfg.args] }
        this.statuses.set(
          cfg.id,
          statusOf(cfg, { connected: true, tools: existing.tools, latencyMs: existing.latencyMs })
        )
        continue
      }

      if (existing) await this.closeOne(cfg.id)

      const t0 = Date.now()
      try {
        const conn = await this.connect(cfg, Date.now() - t0)
        this.conns.set(cfg.id, conn)
        this.statuses.set(
          cfg.id,
          statusOf(cfg, { connected: true, tools: conn.tools, latencyMs: conn.latencyMs })
        )
      } catch (e) {
        this.statuses.set(
          cfg.id,
          statusOf(cfg, {
            connected: false,
            tools: [],
            error: e instanceof Error ? e.message : String(e)
          })
        )
      }
    }

    // 配置里已删除的服务器：断开并清掉状态
    for (const id of [...this.conns.keys()]) {
      if (!keep.has(id)) await this.closeOne(id)
    }
    for (const id of [...this.statuses.keys()]) {
      if (!keep.has(id)) this.statuses.delete(id)
    }

    const out = this.list()
    this.opts.onChange?.(out)
    return out
  }

  /** 单台测试：不影响已有连接（用临时 client，测完断开） */
  async test(cfg: McpServerConfig): Promise<McpServerStatus> {
    const t0 = Date.now()
    try {
      const conn = await this.connect(cfg, 0)
      await conn.client.close().catch(() => undefined)
      return statusOf(cfg, { connected: true, tools: conn.tools, latencyMs: conn.latencyMs })
    } catch (e) {
      return statusOf(cfg, {
        connected: false,
        tools: [],
        error: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - t0
      })
    }
  }

  private async connect(cfg: McpServerConfig, _elapsed: number): Promise<Connection> {
    const t0 = Date.now()
    const client = new Client(
      { name: 'ensp-auto', version: '1.5.0' },
      { capabilities: {} }
    )

    if (cfg.transport === 'http') {
      const url = cfg.url.trim()
      if (!/^https?:\/\//i.test(url)) throw new Error('HTTP 传输需要以 http:// 或 https:// 开头的地址')
      const transport = new StreamableHTTPClientTransport(new URL(url))
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, '连接 MCP 服务器')
    } else {
      const command = cfg.command.trim()
      if (!command) throw new Error('stdio 传输需要填写可执行命令')
      const transport = new StdioClientTransport({
        command,
        args: [...cfg.args],
        stderr: 'ignore'
      })
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, '启动 MCP 进程')
    }

    let tools: McpToolInfo[] = []
    const rawSchemas = new Map<string, Record<string, unknown>>()
    try {
      const res = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, '获取工具清单')
      for (const t of res.tools ?? []) {
        if (typeof t?.name !== 'string' || !t.name) continue
        tools.push({ name: t.name, description: t.description ?? '' })
        if (t.inputSchema && typeof t.inputSchema === 'object') {
          rawSchemas.set(t.name, t.inputSchema as Record<string, unknown>)
        }
      }
    } catch (e) {
      // 连上了但拿不到工具清单：断开，避免留下半死不活的连接
      await client.close().catch(() => undefined)
      throw e
    }

    return {
      config: { ...cfg, args: [...cfg.args] },
      signature: signatureOf(cfg),
      client,
      tools,
      rawSchemas,
      latencyMs: Date.now() - t0
    }
  }

  private async closeOne(id: string): Promise<void> {
    const conn = this.conns.get(id)
    this.conns.delete(id)
    if (!conn) return
    await conn.client.close().catch(() => undefined)
  }

  /** 注入内置代理的外部工具清单（只含已连接且已启用的服务器） */
  externalTools(): ExternalToolDef[] {
    const seen = new Set<string>()
    const out: ExternalToolDef[] = []
    for (const [id, conn] of this.conns) {
      const cfg = conn.config
      if (!cfg.enabled) continue
      for (const t of conn.tools) {
        // D8：碰撞兜底改为「先裁长度、再带服务器+工具名派生的哈希后缀」（dedupeToolName）
        const namespaced = dedupeToolName(cfg.name, t.name, seen)
        seen.add(namespaced)
        out.push({
          serverId: id,
          serverName: cfg.name,
          toolName: t.name,
          namespaced,
          description: t.description || `来自 MCP 服务器「${cfg.name}」的工具`,
          inputSchema: conn.rawSchemas.get(t.name) ?? { type: 'object', properties: {} },
          trusted: cfg.trusted
        })
      }
    }
    return out
  }

  /** 调用外部工具；namespaced 必须是 externalTools() 里给出的名字 */
  async callTool(
    namespaced: string,
    args: unknown
  ): Promise<{ ok: boolean; text: string; error?: string }> {
    const def = this.externalTools().find((t) => t.namespaced === namespaced)
    if (!def) return { ok: false, text: '', error: `未连接的工具：${namespaced}` }
    const conn = this.conns.get(def.serverId)
    if (!conn) return { ok: false, text: '', error: `MCP 服务器未连接：${def.serverName}` }

    try {
      const res = await withTimeout(
        conn.client.callTool({
          name: def.toolName,
          arguments: (args ?? {}) as Record<string, unknown>
        }),
        CALL_TIMEOUT_MS,
        '调用 MCP 工具'
      )
      const text = extractText(res)
      const isError = Boolean((res as { isError?: boolean }).isError)
      return isError ? { ok: false, text, error: text || '外部工具返回错误' } : { ok: true, text }
    } catch (e) {
      return { ok: false, text: '', error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 原始 JSON Schema（从工具清单里取，供注入模型时使用） */
  schemaOf(namespaced: string): Record<string, unknown> | null {
    const def = this.externalTools().find((t) => t.namespaced === namespaced)
    if (!def) return null
    const conn = this.conns.get(def.serverId)
    const raw = conn?.rawSchemas?.get(def.toolName)
    return raw ?? null
  }

  async closeAll(): Promise<void> {
    const ids = [...this.conns.keys()]
    await Promise.all(ids.map((id) => this.closeOne(id)))
    this.statuses.clear()
    this.syncing = null
  }
}

function statusOf(
  cfg: McpServerConfig,
  over: { connected: boolean; tools: McpToolInfo[]; error?: string; latencyMs?: number }
): McpServerStatus {
  return {
    id: cfg.id,
    name: cfg.name,
    transport: cfg.transport,
    enabled: cfg.enabled,
    trusted: cfg.trusted,
    connected: over.connected,
    toolCount: over.tools.length,
    tools: over.tools,
    error: over.error ?? null,
    ...(over.latencyMs !== undefined ? { latencyMs: over.latencyMs } : {})
  }
}

function extractText(res: unknown): string {
  const content = (res as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (o.type === 'text' && typeof o.text === 'string') parts.push(o.text)
    else if (o.type === 'image') parts.push('[图片内容]')
    else if (typeof o.text === 'string') parts.push(o.text)
  }
  return parts.join('\n')
}
