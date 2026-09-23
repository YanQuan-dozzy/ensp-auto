import { randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js'
import type { ToolSpec } from '../tools/registry'
import type { AgentDeps } from '../agent/runtime.iface'
import { isExternalToolName } from '../core/mcp/client'

/**
 * MCP 对外接口（v0.4 / F-：被 Trae / Claude 等客户端按 URL 调用）。
 *
 * 形态：Streamable HTTP，node:http 手装传输（SDK 自带 transport，无需 express），
 * 仅绑定 127.0.0.1，端口来自设置。工具来自 Tool Registry 的 toMcpTools 出口：
 * danger 工具既不列出也不允许调用（外部客户端权限 ≤ 应用内），其余工具调用时
 * requestGate 一律返回 false —— MCP 出口没有人工确认 UI，凡需确认的一律视为拒绝。
 */

export interface McpServerHandle {
  port: number
  url: string
  close(): Promise<void>
}

export interface McpServerOptions {
  deps: Pick<AgentDeps, 'tools' | 'buildContext'>
  port: number
}

export async function createMcpServer(opts: McpServerOptions): Promise<McpServerHandle> {
  const { deps, port } = opts

  /**
   * 唯一的外露口径，两道闸口：
   * 1. danger 工具既不列出、也不允许调用（外部客户端权限 ≤ 应用内）；
   * 2. 外部 MCP 工具（`mcp__<server>__<tool>`）一律不外露 —— 正常装配下这里
   *    只会收到 builtinTools()，但这是一道与调用方解耦的防线：哪天有人把
   *    agentTools 塞进来，也不会重新制造自环（D7，2026-09-23）。
   *
   * ListTools 与 CallTool 必须共用这一份判断（R31）—— 分开写迟早会漂移，
   * 而漂移的后果是「列表里看不到、但照着名字仍然调得动」这种最坏组合。
   */
  const exposedTools = deps.tools.filter((s) => s.risk !== 'danger' && !isExternalToolName(s.name))
  const toolMap = new Map<string, ToolSpec>(exposedTools.map((t) => [t.name, t]))

  // 低层 Server：ListTools / CallTool 两个处理器直接吃 registry 的数据
  const server = new Server(
    { name: 'ensp-auto', version: '0.4.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposedTools.map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: s.schema as Record<string, unknown>
    }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const spec = toolMap.get(name)
    if (!spec) {
      return {
        content: [{ type: 'text' as const, text: `未知工具：${name}` }],
        isError: true
      }
    }

    // 外部客户端无闸门 UI：requestGate 强制拒绝（restore 等内部闸门在此直接拒绝）
    const signal = new AbortController().signal
    const ctx = {
      ...deps.buildContext(signal),
      signal,
      requestGate: async () => false
    }
    try {
      const result = await spec.handler((args ?? {}) as never, ctx)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        isError: !result.ok
      }
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
        isError: true
      }
    }
  })

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  })
  await server.connect(transport)

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Mcp-Session-Id,Authorization'
      })
      res.end()
      return
    }
    void transport
      .handleRequest(req, res, undefined)
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500)
          res.end('internal error')
        }
      })
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (e) => reject(e as Error))
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })

  const actualPort = (httpServer.address() as { port: number }).port

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/mcp`,
    close: async () => {
      await transport.close()
      // Streamable HTTP 的长连接（keep-alive / 挂起的 SSE）会挂住 close 回调，
      // 让 applyMcp 的「关旧端口 → 起新端口」永远等不到 resolve（D7 备注）
      httpServer.closeAllConnections?.()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  }
}

export type { JSONRPCMessage }