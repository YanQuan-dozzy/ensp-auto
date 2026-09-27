/**
 * 渲染层全局 store 的共享类型与纯工具（T5.8 拆分后各 slice 共用）。
 *
 * 为什么单独一层：app.ts 按域拆成多个 action slice 后，
 * 消息流、设备排序、主题切换这些跨域共用工具如果留在 app.ts 里，
 * 每个 slice 都要 import 它 —— 那 app.ts 就没拆干净。
 * 这里放「无 store 依赖」的部分：UiMessage 类型、序号生成、错误文本、纯排序。
 */
import type { Device, RiskLevel, SessionNode } from '@shared/types'
import type { QuestionItem } from '@shared/interaction'
import { parseDeviceId } from '@shared/transport'
import type { Attachment } from '@shared/attachments'
import type { TurnUsage } from '@shared/turn-usage'

export type UiMessage =
  | { kind: 'user'; id: string; text: string; createdAt?: number }
  | { kind: 'assistant'; id: string; text: string }
  /** v2.2：模型思考（reasoning）段，渲染为可折叠的「思考」行，与正文分离 */
  | { kind: 'thinking'; id: string; text: string }
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
      /** v2.9：结构化结果载荷（见 AgentEvent.tool_end.data） */
      data?: unknown
      /**
       * H（v2.14）：落盘的**可回放**卡片数据（见 `SessionNode.toolCall.cardMeta`）。
       *
       * 回放/历史里没有 `data`（它是当次事件），卡片就是靠这个字段还原的。
       */
      cardMeta?: unknown
    }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'error' }
  /** v2.2：一轮任务的收尾卡（完成 / 中止 / 失败 + 耗时） */
  | {
      kind: 'finish'
      id: string
      reason: 'completed' | 'aborted' | 'failed'
      ms: number
      /** v2.10：本轮累计用量（多轮 ReAct 相加），无测量时为 undefined */
      usage?: TurnUsage
      /** v2.10：本轮使用的模型展示名（底部操作栏用） */
      model?: string
    }

export interface GateView {
  gateId: string
  name: string
  args: unknown
  reason: string
}

/**
 * v2.7：一次待回答的结构化提问。
 *
 * 与 GateView 分开建模而不是复用（虽然形状像）：闸门的语义是「批准/拒绝」，
 * 提问的语义是「收集内容」，共用一个类型迟早会出现「把答案当批准」这种调用错。
 * source 决定卡片的外观与文案：tool = 模型提问，plan = 计划模式的方案评审。
 */
export interface QuestionView {
  questionId: string
  questions: QuestionItem[]
  source: 'tool' | 'plan'
}

/** 一键连接进度（done 指已处理完的设备数，ok 为成功数） */
export interface ConnectAllProgress {  total: number
  done: number
  ok: number
}

export type MainTab = 'terminal' | 'topology' | 'skills' | 'changes' | 'trace'

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
  const msgs: UiMessage[] = nodes.map((n) => {
    if (n.role === 'user') return { kind: 'user', id: n.id, text: n.content, createdAt: n.createdAt }
    if (n.role === 'assistant') return { kind: 'assistant', id: n.id, text: n.content }
    if (n.role === 'thinking') return { kind: 'thinking', id: n.id, text: n.content }
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
      // H（v2.14）：把落盘的卡片数据带进消息 —— 回放/历史里没有 `data`，
      // 结构化结果卡（目前是快照 diff）就是靠它还原的。
      ...(tc?.cardMeta !== undefined ? { cardMeta: tc.cardMeta } : {}),
      summary: n.content
    }
  })
  // v2.16：按轮合成收尾卡（耗时 / 用量 / 模型）—— 实时流里它们是从 usage/done
  // 事件现攒的，历史里没有这些事件，只能靠 root.turnFinishes 落盘的记录还原。
  // 插入位置 = 该轮指令（user 节点）到下一条 user 消息之间，即这一轮的末尾；
  // 尾随思考的前移由渲染管线的 hoistTrailingThinking 统一处理。
  const finishes = nodes[0]?.turnFinishes
  if (!finishes) return msgs
  const out: UiMessage[] = []
  for (let i = 0; i < msgs.length; ) {
    const m = msgs[i]!
    out.push(m)
    i++
    if (m.kind !== 'user') continue
    const rec = finishes[m.id]
    if (!rec) continue
    while (i < msgs.length && msgs[i]!.kind !== 'user') {
      out.push(msgs[i]!)
      i++
    }
    out.push({
      kind: 'finish',
      id: `finish-${m.id}`,
      reason: rec.reason,
      ms: rec.ms,
      ...(rec.usage !== undefined ? { usage: rec.usage } : {}),
      ...(rec.model !== undefined ? { model: rec.model } : {})
    })
  }
  return out
}

/**
 * 格式化会话消息时间戳（对齐参考图 2：昨天 17:46 / 今天 16:57）。
 */
export function formatMessageTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`

  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()

  if (isSameDay) return `今天 ${time}`

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()

  if (isYesterday) return `昨天 ${time}`

  if (d.getFullYear() === now.getFullYear()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}

// ————— v2.12：消息删除 / 重新生成 —————

/**
 * 剥掉指令末尾的附件清单行（`📎 …`）。
 *
 * 为什么需要：渲染层气泡把附件名单拼在正文后（一行、顿号分隔），主进程落树的
 * `withAttachmentNote` 是一行一条带体积与类型 —— 两者格式不同但都紧跟在正文后。
 * 对齐消息与节点时只比附件行之前的部分，重发指令时也只取正文。
 */
export function stripAttachmentNote(text: string): string {
  const idx = text.indexOf('\n\n📎')
  return (idx >= 0 ? text.slice(0, idx) : text).trim()
}

/** 内容是否指同一条消息：先精确比 trim，再退到前 40 字符前缀比（容忍尾部截断/注记差异） */
function sameContent(a: string, b: string): boolean {
  const ta = a.trim()
  const tb = b.trim()
  if (ta === tb) return true
  return ta.length >= 40 && tb.length >= 40 && ta.slice(0, 40) === tb.slice(0, 40)
}

/**
 * UI 消息 ↔ 会话树节点 的映射（v2.12，删除/重新生成用）。
 *
 * 为什么不能按下标整体 zip：渲染层与主进程对「assistant 段在工具边界处的切分」
 * 存在合理的顺序差（模型在两次工具调用之间说话时，主进程先 flush 正文再落工具节点，
 * 渲染层则是工具消息先出现）—— 整体 zip 一旦错位，**后面全部映射跟着错**，
 * 而这里映射错的代价是删错分支。
 *
 * 所以按**角色分道、逐类计数**匹配：第 k 条 user 消息 ↔ 第 k 个 user 节点，
 * 第 k 条 assistant 消息 ↔ 第 k 个 assistant 节点（附内容校验），工具按 callId 精确配对。
 * 任何一类对不上就停在那一条（宁可「删不了」也不「删错」）。
 *
 * @returns UiMessage.id → SessionNode.id 的映射
 */
export function matchTreeNodes(messages: UiMessage[], nodes: SessionNode[]): Map<string, string> {
  const map = new Map<string, string>()
  const counters = { user: 0, assistant: 0, thinking: 0, tool: 0 }
  const byRole = new Map<string, SessionNode[]>()
  for (const n of nodes) {
    const list = byRole.get(n.role) ?? []
    list.push(n)
    byRole.set(n.role, list)
  }
  const toolNodeByCallId = new Map<string, SessionNode>()
  for (const n of nodes) {
    if (n.role === 'tool' && n.toolCall?.callId) toolNodeByCallId.set(n.toolCall.callId, n)
  }

  for (const m of messages) {
    if (m.kind !== 'user' && m.kind !== 'assistant' && m.kind !== 'thinking' && m.kind !== 'tool') {
      continue // system / plan / finish 是纯 UI 消息，树里没有对应节点
    }
    if (m.kind === 'tool') {
      const n = toolNodeByCallId.get(m.callId)
      if (n) map.set(m.id, n.id)
      continue
    }
    const candidates = byRole.get(m.kind) ?? []
    const k = counters[m.kind]
    const n = candidates[k]
    if (!n) continue
    counters[m.kind] = k + 1
    if (m.kind === 'user') {
      // user 气泡可能带 📎 注记行，节点内容也可能带 —— 都剥掉再比
      if (!sameContent(stripAttachmentNote(m.text), stripAttachmentNote(n.content))) continue
    } else if (m.kind === 'assistant') {
      if (!sameContent(m.text, n.content)) continue
    }
    map.set(m.id, n.id)
  }
  return map
}

/**
 * 找 node 的最近 user 祖先（含自身）。重新生成的锚点：回到产生这条回答的指令。
 * 找不到（链断/坏数据）返回 null。
 */
export function nearestUserAncestor(nodes: SessionNode[], nodeId: string): SessionNode | null {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  let cur = byId.get(nodeId)
  const guard = new Set<string>()
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id)
    if (cur.role === 'user') return cur
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return null
}

export function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme
  // 这一行让原生滚动条与表单控件跟着切，否则浅色主题下滚动条还是黑的
  document.documentElement.style.colorScheme = theme
}