import type { ToolResult } from '@shared/types'

/**
 * 事件驱动抓包（F10，2026-09-26）—— 把抓包挂到任务生命周期上。
 *
 * 为什么是「识别工具名」而不是硬编码：真正干活的是外部 `wireshark-mcp` 包，
 * 它的工具名不在我们仓库里（随包版本变化）。硬编码一组名字，升级即失效且失效得很安静。
 * 所以这里按**名字/描述的模式**从「已连接的外部 MCP 工具清单」里认出「开始抓包 / 停止抓包」，
 * 认不出就什么都不做 —— 抓包是增强项，绝不能因为它而让实验本身失败。
 *
 * 分析仍交给代理：本模块只负责起停并把停止时的输出（通常含 pcap 路径）附进任务结果，
 * 下一步由代理用它已有的 wireshark 工具去分析。自动「起 → 停 → 分析」里，
 * 「分析」要选工具、要拼参数（pcap 路径还藏在输出文本里），猜错的代价是编造结论。
 */

export interface ExternalMcpToolInfo {
  namespaced: string
  name: string
  description?: string
}

/** 主进程主动调外部 MCP 的最小面（由 agent-wiring 注入，工具层不依赖 McpClientManager） */
export interface ExternalMcpHandle {
  tools: () => readonly ExternalMcpToolInfo[]
  call: (namespaced: string, args: unknown) => Promise<{ ok: boolean; text: string; error?: string }>
}

/** 起抓类名字：开始/启动 + 抓包，或 live capture 之类 */
const START_RE = /\b(start|begin)\b[\s\S]*\bcapture\b|\bcapture\b[\s\S]*\b(start|begin)\b|\blive[\s_-]?capture\b/i
/** 停抓类名字：停止/结束/完成 + 抓包 */
const STOP_RE = /\b(stop|end|halt|finish)\b[\s\S]*\bcapture\b|\bcapture\b[\s\S]*\b(stop|end|halt|finish)\b/i

export interface CaptureTools {
  start: ExternalMcpToolInfo | null
  stop: ExternalMcpToolInfo | null
  /** 认不出配对工具时的原因（进轨迹，便于用户知道为什么没抓） */
  reason?: string
}

/**
 * 从工具清单里认出「起抓 / 停抓」。
 *
 * 判据顺序：先看工具名，再看描述（很多包的抓包工具名很含蓄，描述里才有 capture 字样）。
 * **同一把工具同时命中起停**（toggle 型）时视为不可用：我们不知道它靠什么参数切换方向，
 * 盲调可能「起了又停」或「停了两次」，不如老实跳过。
 */
export function pickCaptureTools(tools: readonly ExternalMcpToolInfo[]): CaptureTools {
  if (tools.length === 0) return { start: null, stop: null, reason: '没有已连接的外部 MCP 工具' }
  /*
   * 匹配前先把 `_` / `-` 归一成空格再判词边界。
   *
   * 原因：`start_capture` 这类下划线命名里，`\b` 在 `t` 与 `_` 之间**不成立**
   * （下划线是词字符），于是 `\b(start|begin)\b` 会漏掉最常见的命名。
   * 归一后 `\b` 才按「词」工作，下划线名与空格描述走同一条判据。
   */
  const hayOf = (t: ExternalMcpToolInfo): string =>
    `${t.name} ${t.description ?? ''}`.replace(/[_-]+/g, ' ').toLowerCase()
  const byName = (re: RegExp): ExternalMcpToolInfo | null =>
    tools.find((t) => re.test(hayOf(t))) ?? null
  const start = byName(START_RE)
  const stop = byName(STOP_RE)
  if (!start) return { start: null, stop: null, reason: '外部 MCP 里没有「开始抓包」类工具' }
  if (!stop) return { start: null, stop: null, reason: '外部 MCP 里没有「停止抓包」类工具' }
  if (start.namespaced === stop.namespaced) {
    return { start: null, stop: null, reason: '起停是同一把开关型工具，无法安全自动驱动' }
  }
  return { start, stop }
}

export interface CaptureSession {
  active: boolean
  startTool: string | null
  stopTool: string | null
  startText?: string
  /** 未启动 / 启动失败的原因 */
  note?: string
}

export interface CaptureOutcome {
  started: boolean
  startTool?: string
  stopTool?: string
  /** 停止抓包的输出（通常含 pcap 路径）—— 交给代理接着分析 */
  text?: string
  note?: string
}

/** 起抓：认不出工具或调用失败都只是「不抓」，把原因放进 note，绝不影响任务本身 */
export async function startCapture(mcp: ExternalMcpHandle, _label: string): Promise<CaptureSession> {
  const picked = pickCaptureTools(mcp.tools())
  if (!picked.start || !picked.stop) {
    return { active: false, startTool: null, stopTool: null, ...(picked.reason ? { note: picked.reason } : {}) }
  }
  const r = await mcp.call(picked.start.namespaced, {})
  if (!r.ok) {
    return {
      active: false,
      startTool: picked.start.namespaced,
      stopTool: picked.stop.namespaced,
      note: `抓包启动失败：${r.error ?? '未知错误'}`
    }
  }
  return {
    active: true,
    startTool: picked.start.namespaced,
    stopTool: picked.stop.namespaced,
    ...(r.text ? { startText: r.text.slice(0, 500) } : {})
  }
}

/** 停抓：返回停止输出，供调用方附进任务结果 */
export async function stopCapture(
  mcp: ExternalMcpHandle,
  session: CaptureSession,
  _label: string
): Promise<CaptureOutcome> {
  if (!session.active || !session.stopTool) {
    return { started: false, ...(session.note ? { note: session.note } : {}) }
  }
  const r = await mcp.call(session.stopTool, {})
  return {
    started: true,
    ...(session.startTool ? { startTool: session.startTool } : {}),
    stopTool: session.stopTool,
    ...(r.ok
      ? { ...(r.text ? { text: r.text.slice(0, 2000) } : {}) }
      : { note: `停止抓包失败：${r.error ?? '未知错误'}` })
  }
}

/** 把抓包结论并进任务结果（data 可能不存在，合并时兜住） */
export function attachCapture(res: ToolResult, capture: CaptureOutcome): ToolResult {
  const data = res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : {}
  return { ...res, data: { ...data, capture } as never }
}