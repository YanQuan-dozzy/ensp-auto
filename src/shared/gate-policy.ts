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

/**
 * 命令级清单放行时的标注（追加在 tool_end 摘要后）。
 *
 * 与 `GATE_SKIPPED_NOTE` 分开两个常量：一个说的是「工具级闸门被策略跳过」，
 * 一个说的是「命令级清单被策略放行」—— 二者的触发条件与后果不同，混用会让轨迹
 * 无法回答「这次到底是哪一层被松开了」。
 */
export const COMMAND_GATE_SKIPPED_NOTE = '（确认框已关闭，命令级危险清单同步放行）'

/**
 * 命令级危险清单的策略判定（决策 D1 的延伸，2026-09-28）。
 *
 * 背景：D1 只松开了**工具级**闸门（`planDangerGate`），命令级清单
 * （`classifyDanger` / `DANGEROUS_COMMANDS`）仍无条件硬拦。于是用户关掉
 * 「危险操作需人工确认」后仍然拿不到 reboot / reset saved-configuration 这类命令 ——
 * 开关的语义（界面横幅明说「代理可以直接执行重启、清空配置、恢复出厂等破坏性操作」）
 * 与实际行为再次不一致，与 R3 是同一类缺陷。
 *
 * 这里把「命令命中清单后该拦还是该放」抽成纯函数，两条分支都能被用例锁住：
 * - `run`：命令未命中清单（或命中但策略已放行）→ 继续下发；
 * - `block`：默认策略 → 拦截整批命令。
 *
 * ★ 放行的**边界**（哪些不放行，与开关无关）：
 * - 多行命令（含 \r / \n）：这不是「危险分类」而是**判定本身的前提** ——
 *   设备会逐行执行，单条判定管不住第二行。放行等于让判定失效，故永远拦。
 *   传 `multiLine: true` 时一律 block，`confirmDanger` 说了不算。
 */
export type CommandGatePlan =
  | { kind: 'run'; note?: string }
  | { kind: 'block'; reason: string }

export function planCommandGate(input: {
  /** `classifyDanger(cmd)` 的结论 */
  dangerous: boolean
  /** 命中原因（来自 classifyDanger，用于闸门文案） */
  reason?: string
  /** 是否为多行命令：多行永远不放行（判定的前提，不是分类） */
  multiLine: boolean
  /** 设置里的「危险操作需人工确认」；false = 用户已显式接受无回滚的破坏性操作 */
  confirmDanger: boolean
}): CommandGatePlan {
  if (!input.dangerous) return { kind: 'run' }
  if (input.multiLine) {
    return { kind: 'block', reason: input.reason ?? '命令包含多行，设备会逐行依次执行' }
  }
  if (!input.confirmDanger) return { kind: 'run', note: COMMAND_GATE_SKIPPED_NOTE }
  return { kind: 'block', reason: input.reason ?? '命令命中危险清单' }
}

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
