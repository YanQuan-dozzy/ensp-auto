import type { RiskLevel } from './types'

/**
 * 危险工具闸门策略（决策 D1）。
 *
 * 背景（R3）：`confirmDanger = false` 时运行时把 `requestGate` 直接接成 `return false`，
 * 于是「关掉确认框」实际变成「危险工具全部永久失败」，而轨迹里还写着
 * 「用户拒绝了该危险操作」—— 根本没有人被问过。三处文档（类型注释 / 界面横幅 /
 * services 注释）描述的语义与实现完全相反，说明是接线接反，而不是有意收紧。
 *
 * 这里把「该问 / 该跳过 / 该拒绝」抽成纯函数，让两条分支都能被用例锁住：
 * - `run`：非危险工具，直接执行；
 * - `ask`：默认策略，弹人工闸门等用户裁决；
 * - `skip-confirm`：用户关掉了确认框 → **直接执行**，但必须在轨迹里标注跳过确认；
 * - `deny`：闸门已作出否定裁决（任务已中止），此时文案绝不能说成"用户拒绝"。
 */

/** 闸门被否时的统一原因：覆盖「用户拒绝」「任务已中止」「出口无闸门（如 MCP）」三种来源 */
export const GATE_DENIED_REASON =
  '该危险操作未获批准：用户拒绝、任务已中止，或当前出口不支持人工确认'

/** 策略跳过确认时，追加在 tool_end 摘要后的标注 */
export const GATE_SKIPPED_NOTE = '（确认框已关闭，按策略跳过确认）'

/** 闸门被否时给界面 / 轨迹的一行摘要 */
export const GATE_DENIED_SUMMARY = '危险操作未获批准，已跳过执行'

export type DangerGatePlan =
  | { kind: 'run' }
  | { kind: 'skip-confirm'; note: string }
  | { kind: 'ask' }
  | { kind: 'deny'; reason: string; summary: string }

export function planDangerGate(input: {
  risk: RiskLevel
  /** 设置里的「危险操作需人工确认」；false = 用户关掉了确认框（界面横幅已明说不可撤销） */
  confirmDanger: boolean
  /** 任务是否已中止：已中止时连闸门都不发，避免"批准 Promise 永不 resolve"式挂死 */
  aborted?: boolean
}): DangerGatePlan {
  if (input.risk !== 'danger') return { kind: 'run' }
  if (input.aborted) {
    return { kind: 'deny', reason: GATE_DENIED_REASON, summary: GATE_DENIED_SUMMARY }
  }
  if (!input.confirmDanger) return { kind: 'skip-confirm', note: GATE_SKIPPED_NOTE }
  return { kind: 'ask' }
}
