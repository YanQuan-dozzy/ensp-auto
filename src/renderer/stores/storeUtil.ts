/**
 * 渲染层全局 store 的共享类型与纯工具（T5.8 拆分后各 slice 共用）。
 *
 * 为什么单独一层：app.ts 按域拆成多个 action slice 后，
 * 消息流、设备排序、主题切换这些跨域共用工具如果留在 app.ts 里，
 * 每个 slice 都要 import 它 —— 那 app.ts 就没拆干净。
 * 这里放「无 store 依赖」的部分：UiMessage 类型、序号生成、错误文本、纯排序。
 */
import type { Device, RiskLevel, SessionNode } from '@shared/types'
import { parseDeviceId } from '@shared/transport'
import type { Attachment } from '@shared/attachments'

export type UiMessage =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'plan'; id: string; steps: string[] }
  | {
      kind: 'tool'
      id: string
      callId: string
      name: string
      args: unknown
      risk: RiskLevel
      status: 'running' | 'ok' | 'fail'
      ms?: number
      summary?: string
      raw?: string
      errorCode?: string
    }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'error' }

export interface GateView {
  gateId: string
  name: string
  args: unknown
  reason: string
}

/** 一键连接进度（done 指已处理完的设备数，ok 为成功数） */
export interface ConnectAllProgress {
  total: number
  done: number
  ok: number
}

export type MainTab = 'terminal' | 'topology' | 'skills'

/** 主会话（单会话模型；会话树分支用 activeRootId/activeStartNodeId 表达回溯） */
export const SESSION_ID = 'main'

let seq = 0
export const nextId = (): string => `m${++seq}`

/** 往消息流里放一条系统提示（失败反馈用；T3.5） */
export function systemNote(text: string, tone: 'info' | 'error' = 'error'): UiMessage {
  return { kind: 'system', id: nextId(), text, tone }
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 合并附件列表（v1.5）。
 * 以 path 去重：同一次导入里重复选中同一文件不会变成两条；
 * 不同文件即使同名也不会互相顶掉（归档名带 uuid 前缀，path 必然不同）。
 */
export function mergeAttachments(current: Attachment[], incoming: Attachment[]): Attachment[] {
  const byPath = new Map(current.map((a) => [a.path, a]))
  for (const a of incoming) byPath.set(a.path, a)
  return [...byPath.values()]
}

/** 被拒绝的附件要明说原因，不能静默丢弃 */
export function rejectionText(rejected: Array<{ name: string; reason: string }>): string {
  return `以下文件未导入：${rejected.map((r) => `${r.name}（${r.reason}）`).join('、')}`
}

/** 设备排序：已连接的在前，同连接态按端口号升序（ssh 设备端口解析与 telnet 共用单一事实源） */
export function sortDevices(list: Device[]): Device[] {
  return [...list].sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1
    const pa = parseDeviceId(a.id)?.port ?? a.port
    const pb = parseDeviceId(b.id)?.port ?? b.port
    return pa - pb
  })
}

/** 会话树节点 → AI 面板消息（历史浏览/回溯载入用） */
export function nodesToMessages(nodes: SessionNode[]): UiMessage[] {
  return nodes.map((n) => {
    if (n.role === 'user') return { kind: 'user', id: n.id, text: n.content }
    if (n.role === 'assistant') return { kind: 'assistant', id: n.id, text: n.content }
    const tc = n.toolCall
    return {
      kind: 'tool',
      id: n.id,
      callId: tc?.callId ?? n.id,
      name: tc?.name ?? n.content,
      args: tc?.args,
      risk: 'read' as RiskLevel,
      status: tc?.ok === false ? 'fail' : 'ok',
      ...(tc?.ms !== undefined ? { ms: tc.ms } : {}),
      summary: n.content
    }
  })
}

export function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme
  // 这一行让原生滚动条与表单控件跟着切，否则浅色主题下滚动条还是黑的
  document.documentElement.style.colorScheme = theme
}