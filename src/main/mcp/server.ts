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

/**
 * MCP 对外接口（v0.4 / F-：被 Trae / Claude 等客户端按 URL 调用）。
 *
 * 形态：Streamable HTTP，node:http 手装传输（SDK 自带 transport，无需 express），
 * 仅绑定 127.0.0.1，端口来自设置。工具来自 Tool Registry 的 toMcpTools 出口：
 * danger 工具已过滤（外部客户端权限 ≤ 应用内），调用时 requestGate 一律返回 false。
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
  const toolMap = new Map<string, ToolSpec>(deps.tools.map((t) => [t.name, t]))

  // 低层 Server：ListTools / CallTool 两个处理器直接吃 registry 的数据
  const server = new Server(
    { name: 'ensp-auto', version: '0.4.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.tools
      .filter((s) => s.risk !== 'danger')
      .map((s) => ({
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

    // 外部客户端无闸门 UI：requestGate 强制拒绝（danger 已过滤；restore 等内部闸门在此直接拒绝）
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
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  }
}

export type { JSONRPCMessage }