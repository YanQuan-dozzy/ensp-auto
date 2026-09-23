import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import { isContextOverflow, isRecoverableLength } from '@earendil-works/pi-ai/utils/overflow'

/**
 * 失败分类（v1.7）：pi-ai 的两套判定器，本项目唯一的接入点。
 *
 * 为什么直接复用而不是自己写正则：
 * 1. 「哪些错误值得重试」是**各 provider 的错误文案知识**（限流、超时、5xx、连接中断，
 *    以及额度耗尽这类看似限流实则确定性的错误），pi 把这份知识维护在
 *    `utils/retry.ts` 的 RETRYABLE / NON_RETRYABLE 两张表里，且与它自家 coding-agent
 *    的 `settings.retry` 同源 —— 自己抄一份必然会随 provider 文案变化而腐烂。
 * 2. 「这是不是上下文溢出」更是纯文案学：Anthropic 说 prompt is too long、
 *    OpenAI 说 exceeds the context window、xAI 说 maximum prompt length is…，
 *    外加 z.ai 的「静默溢出」（请求成功但 input 已超窗口）和 MiMo 的 length-stop 变体。
 *    `utils/overflow.ts` 把这些分成了 3 类并逐家标注，重写一遍没有任何收益。
 *
 * 这两张判定表都是**纯函数、零依赖**（只读 stopReason / errorMessage / usage），
 * 所以可以在不引入额外包体的情况下直接用。
 *
 * 判定之外的策略（退避、预算、压缩）在 `shared/runtime-policy.ts`，不在这里 ——
 * 这一层刻意只回答「这是什么失败」，不回答「那该怎么办」。
 */

/** 判定器真正读到的字段（列出来是为了让「为什么这里能传稀疏对象」有据可查） */
export type ClassifiableMessage = Pick<AssistantMessage, 'stopReason' | 'errorMessage'> &
  Partial<Pick<AssistantMessage, 'usage'>>

/**
 * 请求层抛异常（网络中断、DNS 失败、SDK 内部错误）时没有 AssistantMessage 可判定，
 * 造一个只带 stopReason/errorMessage 的最小对象喂给 pi 的判定器。
 * 判定器不读其它字段，所以这个对象不需要「完整」。
 */
export function synthError(message: string): ClassifiableMessage {
  return { stopReason: 'error', errorMessage: message }
}

/** 临时性失败（限流 / 超时 / 5xx / 连接中断）——值得退避重试 */
export function isRetryableFailure(m: ClassifiableMessage): boolean {
  return isRetryableAssistantError(m as AssistantMessage)
}

/** 上下文溢出 —— 压缩后重试才有意义，重试原样的请求只会再失败一次 */
export function isOverflowFailure(m: ClassifiableMessage, contextWindow?: number): boolean {
  return isContextOverflow(m as AssistantMessage, contextWindow)
}

/** 输出被长度上限截断且没有产出（MiMo 式）——可降 maxTokens 重试，与溢出区分开 */
export function isLengthStarved(m: ClassifiableMessage, desiredMaxOutput: number): boolean {
  return isRecoverableLength(m as AssistantMessage, desiredMaxOutput)
}

/**
 * 给用户的失败说明。pi 的判定器只告诉我们「是不是临时性」，用户需要的是
 * **能不能再试、该改什么** —— 尤其认证/额度这类错误，重试三次只是让人多等 3 秒。
 *
 * 注意判定顺序：额度/计费要**先查**。它恰恰是「不可重试」的那一类
 * （pi 的 NON_RETRYABLE 表里就包含 insufficient_quota / billing），
 * 若挂在「可重试」分支里做细分，最需要被解释清楚的这种失败反而会漏成原文照搬。
 */
export function explainFailure(m: ClassifiableMessage, contextWindow?: number): string {
  const raw = m.errorMessage ?? '模型请求失败'
  if (/(quota|billing|insufficient|balance|out of budget|欠费|余额)/i.test(raw)) {
    return `额度或计费问题（重试无用，请检查账户余额与配额）：${raw}`
  }
  if (isOverflowFailure(m, contextWindow)) {
    return `上下文已超模型窗口（${contextWindow ?? '未知'} tokens）：${raw}`
  }
  if (isRetryableFailure(m)) {
    return `请求暂时失败（已按策略重试）：${raw}`
  }
  if (/401|403|unauthorized|invalid api key|authentication/i.test(raw)) {
    return `密钥无效或无权限（401/403）：${raw}`
  }
  if (/404|not found|unknown model|model_not_found/i.test(raw)) {
    return `端点或模型名不可用（404）：${raw}`
  }
  return raw
}
