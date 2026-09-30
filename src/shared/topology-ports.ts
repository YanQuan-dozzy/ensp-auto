/**
 * 接口标注偏移（B4）—— 数据侧的唯一事实源。
 *
 * 为什么单独一个模块：偏移要跨三处使用，口径必须一致 ——
 * ① 渲染层拖动标签后组装新偏移（`withPortOffset`）；
 * ② 主进程 IPC 边界做白名单校验（`sanitizePortOffsets`），否则字段会被
 *    逐字段重建的 sanitizeLinks 静默丢弃；
 * ③ 单测直接验证这两条纯函数（Harness 走 @shared 别名）。
 *
 * 偏移语义：只存**相对自动槽位的增量**，因此设备拖动、链路重排后依然成立。
 */
import type { TopologyLinkOffsets, TopologyPortOffset } from './types'

/** 单个方向偏移的幅度上限（画布像素）：远超正常拖拽范围，越界视为脏数据 */
export const MAX_PORT_OFFSET = 4000
/** 每条链路每端的条目数上限（与「最多 2 对端口」的标注约定留出余量） */
export const MAX_PORT_OFFSET_ITEMS = 8

/** 端口下标：与 splitPortLabel 的端口顺序一一对应 */
export type PortOffsetSide = 'from' | 'to'

function sanitizeOffsetSide(list: unknown): TopologyPortOffset[] | undefined {
  if (!Array.isArray(list)) return undefined
  const items: TopologyPortOffset[] = []
  for (const entry of list.slice(0, MAX_PORT_OFFSET_ITEMS)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const x = typeof e.x === 'number' ? e.x : Number.NaN
    const y = typeof e.y === 'number' ? e.y : Number.NaN
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (Math.abs(x) > MAX_PORT_OFFSET || Math.abs(y) > MAX_PORT_OFFSET) continue
    items.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 })
  }
  return items.length > 0 ? items : undefined
}

/**
 * 白名单校验（主进程 IPC 边界用）。
 *
 * 与节点/链路的其余字段同口径：非法值一律**丢弃**而不是兜底成 0 ——
 * 一条被污染的偏移只该让那一个标注失效，不该被写进持久化文件。
 * 返回 undefined = 这条链路没有可用偏移。
 */
export function sanitizePortOffsets(raw: unknown): TopologyLinkOffsets | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const from = sanitizeOffsetSide(o.from)
  const to = sanitizeOffsetSide(o.to)
  if (!from && !to) return undefined
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) }
}

/**
 * 把一次拖拽结果写进偏移表（渲染层用）。
 *
 * 返回**新对象**，不修改入参：调用方拿到的旧值可能正是 store 里的链路对象，
 * 就地改会让「未变」的链路引用发生变化，白跑一遍画布重建。
 * 中间缺位的端口用 {0,0} 补齐（下标即端口序号，不能压缩）。
 */
export function withPortOffset(
  prev: TopologyLinkOffsets | undefined,
  side: PortOffsetSide,
  index: number,
  offset: TopologyPortOffset
): TopologyLinkOffsets {
  const slot = Math.max(0, Math.trunc(index))
  const list: TopologyPortOffset[] = [...(prev?.[side] ?? [])]
  while (list.length <= slot) list.push({ x: 0, y: 0 })
  list[slot] = { x: Math.round(offset.x * 10) / 10, y: Math.round(offset.y * 10) / 10 }
  return { ...(prev ?? {}), [side]: list }
}
