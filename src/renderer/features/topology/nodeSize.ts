/**
 * 节点尺寸估算（B4 第二批）—— 布局与走线共用的「设备框占多大地方」。
 *
 * 为什么需要估算：布局与走线都跑在纯函数里（可单测、可离线复算），拿不到 DOM 实测尺寸；
 * 而 `getBoundingClientRect` 只能在渲染后拿到，且会把几何计算绑死在渲染时序上。
 * 这里按 `.topo-node` 的真实排版参数估算（min-width 130 / 图标 24 / 间距 10 /
 * padding 10+12 / 边框 1.5；名称 13px 600、副标题 11px），并**宁可估大不估小** ——
 * 估小的后果是连线穿过设备框，估大只是多留一点空隙。
 */
import type { TopologyRole } from '@shared/types'
import { ROLE_LABEL } from './TopoRender'

export interface NodeSize {
  w: number
  h: number
}

/** padding(10+12) + 图标 24 + gap 10 + 边框 3 */
const CHROME_W = 59
const MIN_W = 130
/** 两行文字（13px×1.3 + 11px×1.4）+ 上下 padding 16 + 边框 3 */
const NODE_H = 52

/** 单行文本宽度估算：CJK/全角按字号全宽，其余按 0.56 倍（等宽与常见无衬线字的折中） */
export function textWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) {
    w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch)
      ? fontSize
      : fontSize * 0.56
  }
  return w
}

/** 设备框尺寸估算（与 node 的实际渲染宽度对齐：取名称行与副标题行里更宽的那行） */
export function estimateNodeSize(label: string, role: TopologyRole, model?: string): NodeSize {
  const sub = `${ROLE_LABEL[role] ?? role}${model ? ` · ${model}` : ''}`
  const w = Math.max(MIN_W, CHROME_W + Math.max(textWidth(label, 13), textWidth(sub, 11)))
  return { w: Math.ceil(w), h: NODE_H }
}

/**
 * 设备框尺寸的**统一入口** —— 每台设备只取一次，供「布局坐标 ↔ 画布坐标」换算。
 *
 * 为什么需要缓存：`estimateNodeSize` 只是个取整的字符宽度估算，但换算函数要在每次
 * 拖动、每帧重排里对每台设备各调一次；无缓存时它是「每条链路 × 两端」的字符遍历。
 * 缓存键已包含全部入参，语义与直接调用完全一致。
 */
const SIZE_CACHE = new Map<string, NodeSize>()

export function nodeSizeOf(label: string, role: TopologyRole, model?: string): NodeSize {
  const key = `${role}\u0000${model ?? ''}\u0000${label}`
  const hit = SIZE_CACHE.get(key)
  if (hit) return hit
  const size = estimateNodeSize(label, role, model)
  // 设备名与型号的组合是有限集合（一张图里几十上百种），不会无界增长
  if (SIZE_CACHE.size > 4096) SIZE_CACHE.clear()
  SIZE_CACHE.set(key, size)
  return size
}

/**
 * 布局坐标（= **设备框中心**）落在 LAYOUT_GRID 格点上的硬约束。
 *
 * 布局输出的每个坐标都是 `格点`，含义是**设备框中心**；画布（React Flow）要的是
 * **左上角**，故渲染前统一减去半个框。为了让「网格十字中心」真的压在设备中心，
 * 减完之后必须仍是格点 —— 于是要求 `w` 与 `h` 都是偶数。
 *
 * 为什么必须由尺寸保证而不是四舍五入：四舍五入会把换算后的坐标推离格点，而
 * `alignToGrid`（把**画布**坐标取整到格点）随后又会把它们挪成奇数偏移，
 * 用户点一次「对齐到网格」网格就歪半个格 —— 正是本次要修的现象。
 */
function evenCeil(v: number): number {
  const c = Math.ceil(v)
  return c % 2 === 0 ? c : c + 1
}

/**
 * 设备框尺寸估算（**宽高均为偶数**）—— 布局几何一律用它。
 *
 * 与 `estimateNodeSize` 的关系：后者保留原口径（含 130 / 52 这类奇数），供
 * `nodeSize.ts` 之外**不做中心换算**的调用点继续使用；本函数在其结果上向上取整到
 * 最近的偶数，差值 ≤ 1px，肉眼不可辨，但换来「中心永远落格点」这条不变式。
 */
export function estimateNodeSizeAligned(label: string, role: TopologyRole, model?: string): NodeSize {
  const s = nodeSizeOf(label, role, model)
  return { w: evenCeil(s.w), h: evenCeil(s.h) }
}
