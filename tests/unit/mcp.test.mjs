/**
 * MCP Streamable HTTP 出口（v0.4）端到端测试。
 * 用临时端口起真实 transport + node:http，裸 fetch 走 Initialize → ListTools：
 * 工具与内置代理同一份 schema，danger 工具不外露。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createMcpServer,
  TOOLS,
  builtinTools,
  agentTools,
  McpClientManager
} from '../.build/harness.mjs'

async function rpcClient(base, log = console.error) {
  let sessionId = null
  const call = async (method, params) => {
    const body = { jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    }
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    const res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body) })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const raw = await res.text()
    let payload
    // 响应可能是 JSON，也可能是 SSE（event-stream）
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) {
          payload = JSON.parse(line.slice(5).trim())
          break
        }
      }
    } else {
      try {
        payload = JSON.parse(raw)
      } catch {
        log(`non-json response: ${raw.slice(0, 200)}`)
        throw new Error('响应既不是 JSON 也不是 SSE')
      }
    }
    if (payload?.error) throw new Error(`MCP 错误：${JSON.stringify(payload.error).slice(0, 300)}`)
    return payload?.result
  }
  return { call, getSessionId: () => sessionId }
}

test('MCP：Initialize → ListTools 全链路，danger 工具不外露', async (t) => {
  // buildContext 只在 CallTool 时被用到；本测试只走到 ListTools
  const deps = {
    tools: TOOLS,
    buildContext: () => {
      throw new Error('本测试不调用工具')
    }
  }
  const srv = await createMcpServer({ deps, port: 0 })
  t.after(() => void srv.close())
  assert.ok(srv.port > 0)
  assert.ok(srv.url.startsWith('http://127.0.0.1:'))

  const client = await rpcClient(srv.url)
  const init = await client.call('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'ensp-auto-test', version: '1.0' }
  })
  assert.ok(init.serverInfo.name)
  assert.ok(init.capabilities.tools)

  const listed = await client.call('tools/list', {})
  const names = listed.tools.map((t) => t.name)
  assert.ok(names.includes('list_sessions'), 'v0.4 工具应在 MCP 出口')
  assert.ok(names.includes('scan_devices'))
  assert.ok(!names.includes('save_configuration'), 'danger 工具不应暴露')

  const show = listed.tools.find((t) => t.name === 'list_sessions')
  assert.equal(show.inputSchema.type, 'object')
  assert.ok(show.inputSchema, 'TypeBox schema 直通 MCP')
})

test('MCP：CallTool 未知工具返回 isError,非倾轧', async (t) => {
  const deps = {
    tools: TOOLS,
    buildContext: () => {
      throw new Error('not reached')
    }
  }
  const srv = await createMcpServer({ deps, port: 0 })
  t.after(() => void srv.close())
  const client = await rpcClient(srv.url)
  await client.call('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 't', version: '1' }
  })
  const result = await client.call('tools/call', {
    name: 'no_such_tool',
    arguments: {}
  })
  assert.equal(result.isError, true)
  assert.ok(result.content[0].text.includes('未知工具'))
})

test('MCP：CallTool 执行异常被捕获为 isError，服务不崩', async (t) => {
  const deps = {
    tools: TOOLS,
    // 空 ctx：list_snapshots 的 handler 访问 ctx.snapshots 时在 try 内抛错 → 转 isError
    buildContext: () => ({})
  }
  const srv = await createMcpServer({ deps, port: 0 })
  t.after(() => void srv.close())
  const client = await rpcClient(srv.url)
  await client.call('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 't', version: '1' }
  })
  const result = await client.call('tools/call', { name: 'list_snapshots', arguments: { deviceId: '127.0.0.1:1' } })
  assert.equal(result.isError, true)
})

// ———————————————— D7（2026-09-23）：对外出口绝不暴露外部工具 ————————————————

test('D7：外部工具即使 risk=write（受信任）也不进 ListTools，调用返回未知工具', async (t) => {
  const fakeExternal = {
    name: 'mcp__files__read_file',
    description: '[MCP · files] 外部工具',
    risk: 'write', // 受信任的外部工具正是这个等级 —— 旧实现会在这里穿透 danger 过滤
    scope: 'local',
    schema: { type: 'object', properties: {} },
    handler: async () => ({ ok: true, data: {}, meta: { ms: 1 } })
  }
  const deps = {
    // 模拟误把 agentTools（含外部工具）塞给对外出口
    tools: [...TOOLS, fakeExternal],
    buildContext: () => ({})
  }
  const srv = await createMcpServer({ deps, port: 0 })
  t.after(() => void srv.close())
  const client = await rpcClient(srv.url)
  await client.call('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 't', version: '1' }
  })

  const listed = await client.call('tools/list', {})
  const names = listed.tools.map((x) => x.name)
  assert.ok(!names.includes('mcp__files__read_file'), '外部工具不得出现在对外清单')
  assert.ok(names.every((n) => TOOLS.some((t) => t.name === n)), '外露清单只含内置工具')
  assert.ok(names.includes('list_devices'), '内置工具照常外露')

  const called = await client.call('tools/call', {
    name: 'mcp__files__read_file',
    arguments: {}
  })
  assert.equal(called.isError, true)
  assert.match(called.content[0].text, /未知工具/, '照着名字也调不动（R31 的口径）')
})

test('D7：builtinTools / agentTools 是两个集合，对外出口用前者', () => {
  const mgr = new McpClientManager({ onChange() {} })
  const settingsOff = { mcp: { exposeToAgent: false }, permission: { externalToolConfirm: false } }
  const settingsOn = { mcp: { exposeToAgent: true }, permission: { externalToolConfirm: false } }
  // 无外部连接时两者数量一致，但语义不同：前者恒等于内置表
  assert.equal(agentTools(settingsOff, mgr).length, TOOLS.length)
  assert.equal(agentTools(settingsOn, mgr).length, TOOLS.length)
  assert.ok(builtinTools().every((t) => !t.name.startsWith('mcp__')))
})