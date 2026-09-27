/**
 * 结构化工具结果的解析与展示（v2.9，P5）—— 纯函数，供卡片渲染与单测共用。
 *
 * 背景：工具的结论有时是**结构化**的（快照 diff 的 `{added[], removed[]}`），
 * 只渲染成一行 `summary` 会把最有价值的信息（改了哪几行）丢掉。
 * 这里负责把这些载荷识别成一个「可展示的视图模型」，渲染层只负责画。
 *
 * 为什么单独一层：识别逻辑必须能被单测钉死 —— 模型/工具给的 data 形状
 * 随时可能变（多一个字段、少一个字段），「识别不出来就退回原样」这条
 * 降级路径必须始终成立，不能让一个形状变化把整条消息流渲染炸掉。
 */

/** 一种结构化结果的展示视图 */
export interface DiffView {
  kind: 'diff'
  /** 设备 id（有则显示在卡头） */
  deviceId?: string
  snapshotId?: string
  /** 是否有变化 */
  changed: boolean
  added: string[]
  removed: string[]
  /**
   * H（v2.14）：单侧**总行数**。
   *
   * 为什么需要：回放时数据来自 `toolCall.cardMeta`，而那时的 `added`/`removed`
   * 已被工具侧的投影**截断到 40 行**（超上限会整块丢卡片，所以只能截断）。
   * 卡头若按 `added.length` 计数，就会把「改了 500 行」显示成「改了 40 行」——
   * 一个看起来完全正常的错误数字。所以计数一律走 `lineTotalOf()`。
   */
  addedTotal?: number
  removedTotal?: number
}

export type StructuredView = DiffView

/**
 * 把一次工具调用的 (name, data) 认成一张可展示的卡。
 * 认不出来返回 null —— 调用方什么都不渲染，绝不报错。
 */
export function buildStructuredView(name: string, data: unknown): StructuredView | null {
  if (name === 'diff_with_snapshot') return asDiffView(data)
  return null
}

/** 某一侧的总行数：优先用载荷给的总数，否则退回数组长度（总数不得小于实际拿到的行数） */
export function lineTotalOf(lines: readonly string[], total: number | undefined): number {
  return typeof total === 'number' && Number.isFinite(total) && total >= lines.length
    ? total
    : lines.length
}

/**
 * `diff_with_snapshot` 的载荷 → 视图。
 *
 * 校验要点：`added` / `removed` 必须是**字符串数组**。工具侧虽然保证，
 * 但 data 是 `unknown`（跨 IPC 后类型不保证），逐项过一遍比信任它便宜。
 *
 * 两个来源共用这一条路径：实时流给的是 `tool_end.data`（未截断），回放给的是
 * `toolCall.cardMeta`（已截断 + 带总数）—— 后者形状是前者的子集，所以同一套校验够用。
 */
function asDiffView(data: unknown): DiffView | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const added = stringArray(d.added)
  const removed = stringArray(d.removed)
  if (added === null || removed === null) return null
  const changed = typeof d.changed === 'boolean' ? d.changed : added.length > 0 || removed.length > 0
  const view: DiffView = { kind: 'diff', changed, added, removed }
  if (typeof d.snapshotId === 'string' && d.snapshotId) view.snapshotId = d.snapshotId
  if (typeof d.deviceId === 'string' && d.deviceId) view.deviceId = d.deviceId
  if (typeof d.addedTotal === 'number') view.addedTotal = d.addedTotal
  if (typeof d.removedTotal === 'number') view.removedTotal = d.removedTotal
  return view
}

/** 严格取字符串数组；含非字符串项即整项作废（宁可不出卡，也不显示半个） */
function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  for (const x of v) if (typeof x !== 'string') return null
  return v as string[]
}

/** 卡片头的一句话结论（计数按总行数 —— 回放时数组可能已被截断） */
export function describeDiff(v: DiffView): string {
  if (!v.changed) return '配置无变化'
  const parts: string[] = []
  const added = lineTotalOf(v.added, v.addedTotal)
  const removed = lineTotalOf(v.removed, v.removedTotal)
  if (added > 0) parts.push(`新增 ${added} 行`)
  if (removed > 0) parts.push(`删除 ${removed} 行`)
  return `配置有变化：${parts.join(' · ')}`
}

/** 单侧最多先展示多少行（卡片里不做无限长列表，超出靠「查看全部」） */
export const DIFF_PREVIEW_LINES = 40
