import type { AgentEvent, GateDecision, RunInput } from '@shared/types'
import { EventStream, summarizeToolCall, type AgentDeps, type AgentRuntime } from './runtime.iface'

/**
 * Mock 运行时：脚本回放，完全不依赖网络与模型。
 *
 * 用途有两个：
 * 1. 离线开发 —— 没配 API Key 也能把 UI 与工具链路跑通
 * 2. 自动化测试 —— 事件序列可预期，便于断言
 *
 * 它不是空壳：会真的调用工具（扫描 / 连接 / 读上下文），
 * 只是「决定调什么」这一步由规则而非模型完成。
 */
export class MockRuntime implements AgentRuntime {
  constructor(private readonly deps: AgentDeps) {}

  resolveGate(): void {
    /* mock 不产生危险操作，无需裁决 */
  }

  run(input: RunInput): AsyncIterable<AgentEvent> {
    const stream = new EventStream<AgentEvent>()
    void this.drive(input, stream)
    return stream
  }

  private async drive(input: RunInput, stream: EventStream<AgentEvent>): Promise<void> {
    const text = input.text.trim()
    const wantConnect = /连接|connect|接入/i.test(text)
    const wantScan = /扫描|scan|发现|设备列表/i.test(text)

    try {
      await sleep(200)

      const plan: string[] = []
      if (wantScan || wantConnect) plan.push('扫描本机 eNSP 设备')
      if (wantConnect) plan.push('连接目标设备')
      plan.push('读取设备上下文')
      plan.push('汇总结论')

      stream.push({ type: 'plan', steps: plan })

      let found = 0
      let connected: string | undefined

      if (wantScan || wantConnect) {
        const scanSpec = this.deps.tools.find((t) => t.name === 'scan_devices')
        if (scanSpec) {
          const callId = `mock-${Date.now()}-scan`
          stream.push({
            type: 'tool_start',
            callId,
            name: 'scan_devices',
            args: { start: 2000, end: 2050 },
            risk: scanSpec.risk
          })
          const t0 = Date.now()
          const ctx = this.deps.buildContext(input.signal)
          const result = await scanSpec.handler({ start: 2000, end: 2050 }, ctx)
          const devices = (result.data as { devices?: Array<{ port: number; id: string }> } | undefined)
            ?.devices
          found = devices?.length ?? 0
          stream.push({
            type: 'tool_end',
            callId,
            ok: result.ok,
            ms: Date.now() - t0,
            summary: summarizeToolCall(scanSpec, { start: 2000, end: 2050 }, result, 'scan_devices'),
            ...(devices?.length ? { raw: devices.map((d) => `${d.id}`).join('\n') } : {})
          })

          if (wantConnect && devices?.length) {
            const target = devices[0]!
            const connectSpec = this.deps.tools.find((t) => t.name === 'connect_device')
            if (connectSpec) {
              const cid = `mock-${Date.now()}-connect`
              stream.push({
                type: 'tool_start',
                callId: cid,
                name: 'connect_device',
                args: { port: target.port },
                risk: connectSpec.risk
              })
              const t1 = Date.now()
              const cres = await connectSpec.handler({ port: target.port }, ctx)
              connected = cres.ok ? target.id : undefined
              stream.push({
                type: 'tool_end',
                callId: cid,
                ok: cres.ok,
                ms: Date.now() - t1,
                summary: summarizeToolCall(connectSpec, { port: target.port }, cres, 'connect_device'),
                ...(cres.error ? { errorCode: cres.error.code, raw: cres.error.raw ?? cres.error.message } : {})
              })
            }
          }
        }
      }

      if (connected) {
        const ctx = this.deps.buildContext(input.signal)
        const ctxSpec = this.deps.tools.find((t) => t.name === 'get_device_context')
        if (ctxSpec) {
          const callId = `mock-${Date.now()}-ctx`
          stream.push({
            type: 'tool_start',
            callId,
            name: 'get_device_context',
            args: { deviceId: connected },
            risk: ctxSpec.risk
          })
          const t0 = Date.now()
          const result = await ctxSpec.handler({ deviceId: connected }, ctx)
          stream.push({
            type: 'tool_end',
            callId,
            ok: result.ok,
            ms: Date.now() - t0,
            summary: summarizeToolCall(ctxSpec, { deviceId: connected }, result, 'get_device_context')
          })

          const data = result.data as
            | { model?: string; vrpVersion?: string; interfaces?: unknown[] }
            | undefined
          stream.push({
            type: 'text',
            delta: [
              `（mock 运行时）已读取 ${connected} 的上下文：`,
              `- 型号：${data?.model ?? '未知'}`,
              `- VRP 版本：${data?.vrpVersion ?? '未知'}`,
              `- 接口数：${data?.interfaces?.length ?? 0}`,
              '',
              '这是 mock 运行时的固定回放。配置真实模型 API 后将由模型自主决策。'
            ].join('\n')
          })
        }
      } else {
        stream.push({
          type: 'text',
          delta: [
            `（mock 运行时）扫描完成，发现 ${found} 个设备。`,
            found === 0
              ? '没有发现设备。请确认 eNSP 已启动并运行了网络设备。'
              : '如需进一步操作，请在设置中配置模型 API 后使用真实运行时。'
          ].join('\n')
        })
      }

      stream.push({ type: 'done', reason: 'completed' })
    } catch (e) {
      stream.push({ type: 'error', message: (e as Error).message, recoverable: false })
      stream.push({ type: 'done', reason: 'failed' })
    } finally {
      stream.close()
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 供测试断言用：mock 运行时的事件序列契约 */
export const MOCK_EVENT_ORDER: AgentEvent['type'][] = [
  'plan',
  'tool_start',
  'tool_end',
  'text',
  'done'
]

export type { AgentDeps, GateDecision }
