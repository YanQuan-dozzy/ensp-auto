import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import type { AgentEvent, GateDecision, SessionNode, Settings } from '@shared/types'
import { EVENT } from '@shared/channels'
import { JsonStore } from './core/store/store'
import { SnapshotStore } from './core/store/snapshots'
import { ChangeStore } from './core/store/changes'
import { TopologyStore } from './core/topology/store'
import { deriveTopology } from './core/topology/fromNeighbors'
import type { Topology } from './core/topology/model'
import { SessionTreeStore } from './core/session-tree/store'
import { collectSessionReport } from './tools/sessions'
import { probesFromSessions } from './tools/topology'
import { createMcpServer, type McpServerHandle } from './mcp/server'
import { SessionManager } from './core/session/SessionManager'
import { MockRuntime } from './agent/mock.runtime'
import { ReactRuntime } from './agent/react.runtime'
import type { AgentDeps, AgentRuntime } from './agent/runtime.iface'
import type { ToolContext, ToolSpec } from './tools/registry'
import { TOOLS } from './tools'
import { getApiKey, hasApiKey } from './settings/secrets'

interface ActiveAgent {
  sessionId: string
  controller: AbortController
  runtime: AgentRuntime
}

/**
 * 服务容器：把持久化、会话、工具、Agent 运行时装配起来。
 *
 * 主进程里只有这一个装配点，IPC 层只做「校验参数 → 调用服务 → 回传结果」，
 * 不持有业务逻辑。这样 IPC 层可以很薄，也容易审查。
 */
export class Services {
  readonly store: JsonStore
  readonly snapshots: SnapshotStore
  readonly changes: ChangeStore
  readonly sessions: SessionManager
  readonly topology: TopologyStore
  readonly sessionTree: SessionTreeStore
  /** 报告导出目录（userData/exports），工具与 IPC 共用 */
  readonly exportsDir: string

  private readonly active = new Map<string, ActiveAgent>()
  /** v0.4：MCP 服务运行态 */
  private mcpHandle: McpServerHandle | null = null
  private mcpRunning = false
  private mcpUrl = ''
  private mcpError: string | null = null

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    const userData = app.getPath('userData')
    this.store = new JsonStore(path.join(userData, 'ensp-auto.json'))
    this.snapshots = new SnapshotStore(path.join(userData, 'snapshots-data'))
    this.changes = new ChangeStore(path.join(userData, 'snapshots-data'))
    this.exportsDir = path.join(userData, 'exports')
    this.topology = new TopologyStore({
      file: path.join(userData, 'topology.json'),
      onChange: (t) => this.send(EVENT.topologyUpdated, t)
    })
    this.sessionTree = new SessionTreeStore({
      dir: path.join(userData, 'sessions'),
      onChange: (list) => this.send(EVENT.sessionListUpdated, list)
    })
    this.sessions = new SessionManager(this.store, {
      getSettings: () => this.store.getSettings(),
      onRaw: (deviceId, chunk, fromAgent) => {
        this.send(EVENT.terminalData, { deviceId, chunk, fromAgent })
      },
      onClosed: (deviceId, reason) => {
        this.send(EVENT.terminalClosed, { deviceId, reason })
      },
      onStateChanged: (device) => {
        this.send(EVENT.deviceStateChanged, device)
      }
    })
  }

  private send(channel: string, payload: unknown): void {
    const win = this.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  getSettings(): Settings {
    return this.store.getSettings()
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const before = this.store.getSettings()
    const after = this.store.updateSettings(patch)
    // MCP 开关/端口变化 → 重启服务（幂等，失败只记状态不抛给渲染层）
    if (before.mcp.enabled !== after.mcp.enabled || before.mcp.port !== after.mcp.port) {
      void this.applyMcp().catch(() => undefined)
    }
    return after
  }

  /** 按当前设置启停 MCP 服务（app ready 与设置变更共用） */
  async applyMcp(): Promise<void> {
    const s = this.store.getSettings().mcp
    try {
      if (!s.enabled) {
        if (this.mcpHandle) {
          await this.mcpHandle.close()
          this.mcpHandle = null
        }
        this.mcpRunning = false
        this.mcpUrl = ''
        this.mcpError = null
      } else {
        if (this.mcpHandle && this.mcpHandle.port === s.port) {
          // 同端口已运行，幂等跳过
        } else {
          if (this.mcpHandle) {
            await this.mcpHandle.close()
            this.mcpHandle = null
          }
          const handle = await createMcpServer({ deps: this.agentDeps(), port: s.port })
          this.mcpHandle = handle
          this.mcpRunning = true
          this.mcpUrl = handle.url
          this.mcpError = null
        }
      }
    } catch (e) {
      this.mcpRunning = false
      this.mcpError = e instanceof Error ? e.message : String(e)
    }
    this.send(EVENT.mcpStatus, {
      running: this.mcpRunning,
      url: this.mcpUrl,
      error: this.mcpError
    })
  }

  getMcpStatus(): { running: boolean; url: string; error: string | null } {
    return { running: this.mcpRunning, url: this.mcpUrl, error: this.mcpError }
  }

  // ———————————————————————— Agent ————————————————————————

  private agentDeps(): AgentDeps {
    const tools: readonly ToolSpec[] = TOOLS
    return {
      tools,
      getSettings: () => this.store.getSettings(),
      buildContext: (signal: AbortSignal): ToolContext => ({
        sessions: this.sessions,
        settings: this.store.getSettings(),
        snapshots: this.snapshots,
        changes: this.changes,
        topology: this.topology,
        sessionTree: this.sessionTree,
        exportsDir: this.exportsDir,
        signal,
        // 默认闸门：一律拒绝。真实闸门由 ReactRuntime 覆盖为「问用户」。
        requestGate: async () => false
      })
    }
  }

  createRuntime(): { runtime: AgentRuntime; kind: 'react' | 'mock' } {
    const settings = this.store.getSettings()
    const apiKey = getApiKey()
    const wantReact = settings.agent.runtime === 'react'
    if (wantReact && apiKey) {
      return {
        runtime: new ReactRuntime(this.agentDeps(), { apiKey }),
        kind: 'react'
      }
    }
    return { runtime: new MockRuntime(this.agentDeps()), kind: 'mock' }
  }

  /**
   * 启动一轮代理任务。
   * v0.4：会话树落盘 —— 无 rootId 则新建会话，有 startNodeId 则在该节点下「换路重走」；
   * 运行期把 user/assistant/tool 节点增量写入树，供回溯与报告使用。
   */
  async startAgent(
    sessionId: string,
    text: string,
    opts?: { rootId?: string | null; startNodeId?: string | null }
  ): Promise<void> {
    if (this.active.has(sessionId)) {
      throw new Error('该会话已有任务在运行')
    }

    // —— 会话树：定位父节点并写好本次 user 节点 ——
    let history: SessionNode[] = []
    let tail: SessionNode
    if (opts?.rootId && opts?.startNodeId && this.sessionTree.getById(opts.startNodeId)) {
      history = this.sessionTree.pathTo(opts.rootId, opts.startNodeId)
      tail = this.sessionTree.append(opts.startNodeId, {
        id: `n-${randomUUID()}`,
        role: 'user',
        content: text
      })
    } else {
      const root = this.sessionTree.createRoot(text.slice(0, 60))
      tail = root
    }

    const controller = new AbortController()
    const { runtime, kind } = this.createRuntime()
    this.active.set(sessionId, { sessionId, controller, runtime })

    // 增量节点收集：assistant 文本按「工具调用边界」收束成节点，工具成对落节点
    let pendingAssistant: string | null = null
    const flushAssistant = (): void => {
      if (pendingAssistant === null || !pendingAssistant.trim()) return
      const node = this.sessionTree.append(tail.id, {
        id: `n-${randomUUID()}`,
        role: 'assistant',
        content: pendingAssistant.trimEnd()
      })
      tail = node
      pendingAssistant = null
    }
    const pendingTools = new Map<string, NonNullable<SessionNode['toolCall']>>()

    const collect = (event: AgentEvent): void => {
      switch (event.type) {
        case 'text':
          pendingAssistant = (pendingAssistant ?? '') + event.delta
          return
        case 'tool_start':
          flushAssistant()
          pendingTools.set(event.callId, {
            callId: event.callId,
            name: event.name,
            args: event.args
          })
          return
        case 'tool_end': {
          const tc = pendingTools.get(event.callId)
          if (tc) {
            const node = this.sessionTree.append(tail.id, {
              id: `n-${randomUUID()}`,
              role: 'tool',
              content: `${tc.name}(${safeJsonPeek(tc.args)})`,
              ...(tc ? { toolCall: { ...tc, ok: event.ok, ms: event.ms } } : {})
            })
            tail = node
            pendingTools.delete(event.callId)
          }
          return
        }
        default:
          return
      }
    }

    try {
      for await (const event of runtime.run({
        sessionId,
        text,
        signal: controller.signal,
        history
      })) {
        collect(event)
        this.send(EVENT.agentEvent, {
          sessionId,
          event,
          runtime: kind
        } satisfies { sessionId: string; event: AgentEvent; runtime: 'react' | 'mock' })
      }
    } catch (e) {
      flushAssistant()
      this.send(EVENT.agentEvent, {
        sessionId,
        event: {
          type: 'error',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false
        } satisfies AgentEvent,
        runtime: kind
      })
      this.send(EVENT.agentEvent, {
        sessionId,
        event: { type: 'done', reason: 'failed' } satisfies AgentEvent,
        runtime: kind
      })
    } finally {
      flushAssistant()
      // R3：任务结束时队列里还有输入，明确提示，不静默丢掉
      const remains = runtime.takePendingInput?.() ?? []
      this.active.delete(sessionId)
      if (remains.length > 0) {
        this.send(EVENT.agentEvent, {
          sessionId,
          event: {
            type: 'error',
            message: `以下输入在本轮任务结束后未执行：${remains.map((s) => `「${s}」`).join('、')}。可再次发送。`,
            recoverable: true
          } satisfies AgentEvent,
          runtime: kind
        })
      }
    }
  }

  /** 向正在运行的任务投递纠偏消息（仅运行时支持时有效） */
  enqueueInput(sessionId: string, text: string): boolean {
    const a = this.active.get(sessionId)
    if (!a || !a.runtime.enqueue) return false
    return a.runtime.enqueue(text)
  }

  abortAgent(sessionId: string): boolean {
    const a = this.active.get(sessionId)
    if (!a) return false
    a.controller.abort()
    return true
  }

  isAgentRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  resolveGate(sessionId: string, gateId: string, decision: GateDecision): boolean {
    const a = this.active.get(sessionId)
    if (!a) return false
    a.runtime.resolveGate(gateId, decision)
    return true
  }

  hasApiKey(): boolean {
    return hasApiKey()
  }

  /** 对已连接设备实采 LLDP 邻居，重推拓扑并持久化（IPC topology:refresh 用） */
  async refreshTopology(): Promise<Topology> {
    const t = await deriveTopology(probesFromSessions(this.sessions))
    this.topology.set(t)
    return t
  }

  /** 导出会话报告到 userData/exports（IPC session:export 与工具共用） */
  exportSessionReport(rootId: string, format: 'md' | 'json'): { path: string } {
    return collectSessionReport(this.sessionTree, this.exportsDir, rootId, format)
  }

  shutdown(): void {
    for (const a of this.active.values()) a.controller.abort()
    this.active.clear()
    this.sessions.closeAll()
    void this.mcpHandle?.close().catch(() => undefined)
    this.mcpHandle = null
    this.mcpRunning = false
  }
}

function safeJsonPeek(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s && s.length > 120 ? `${s.slice(0, 120)}…` : (s ?? '')
  } catch {
    return String(v)
  }
}
