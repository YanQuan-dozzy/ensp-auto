/**
 * 计划模式（v2.7）：先探索出方案、用户批准后再动手。
 *
 * 与危险操作闸门的区别：闸门管**单次**破坏性调用（批准一次执行一次），
 * 计划模式管**整段**工作（一次评审放行一整批操作）。
 *
 * ★ 这里刻意是**硬约束**，不靠提示词：项目已有的纪律是「闸门拦在 handler 执行之前，
 * 不依赖提示词」（见 gate-policy.ts）。计划模式同理 —— 提示词只是告诉模型「别乱动」，
 * 真正保证「方案没批准就不会碰设备」的是下面这个判定函数。
 */
import type { RiskLevel } from './types'
import { PLAN_APPROVE, PLAN_REVISE, PLAN_STOP } from './interaction'

export interface PlanModeDecision {
  /** allow = 放行；block = 拒绝执行并回一条失败结果给模型 */
  kind: 'allow' | 'block'
  reason?: string
  /** 回给模型的错误码 */
  code?: string
}

export const PLAN_MODE_BLOCK_CODE = 'PLAN_MODE_READONLY'

/**
 * 计划模式下能否执行某个工具。
 *
 * 判据是 `risk !== 'read'`：write / danger 一律拒绝。
 * 只读工具（含 `connect_device` / `save_config_snapshot` 这些 risk 标 read 的）放行 ——
 * 探索本来就需要连设备、看配置、存快照；它们**不改设备配置**，
 * 而「不改设备配置」正是计划模式要保证的事。
 */
export function planModeToolDecision(input: {
  planMode: boolean
  risk: RiskLevel
  toolName: string
}): PlanModeDecision {
  if (!input.planMode) return { kind: 'allow' }
  if (input.risk === 'read') return { kind: 'allow' }
  return {
    kind: 'block',
    code: PLAN_MODE_BLOCK_CODE,
    reason:
      `当前处于计划模式，不允许执行会改动设备的工具：${input.toolName}。` +
      '请把它写进方案里（说明要动哪台设备、下发哪些命令、如何验证、如何回滚），' +
      '等用户在方案评审里批准之后再执行。'
  }
}

/**
 * 方案的评审问题（运行时替用户问，与 `ask_user_question` 复用同一套机制）。
 *
 * 三个选项的**文案就是协议**：运行时拿回来的答案是字符串，靠比对
 * `PLAN_APPROVE` / `PLAN_STOP` 决定走哪条分支。所以这里必须引用常量、
 * 不能各写一份字面量 —— 两处字面量一旦有一个字不同，批准会静默变成「继续修订」。
 */
export const PLAN_REVIEW_QUESTION_ID = 'plan-review'

export function buildPlanReviewOptions(): Array<{ label: string; description: string }> {
  return [
    {
      label: PLAN_APPROVE,
      description: '按方案开始改动设备。写操作仍会逐次经过危险操作闸门。'
    },
    {
      label: PLAN_REVISE,
      description: '在下方输入修改意见，代理继续做只读探索并修订方案。'
    },
    { label: PLAN_STOP, description: '保留方案文本，本轮任务到此为止，不碰任何设备。' }
  ]
}
