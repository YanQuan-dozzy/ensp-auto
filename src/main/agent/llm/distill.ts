import type { Message } from '@earendil-works/pi-ai'
import { buildLLM } from './models'
import { consumeEvent, newTurn } from './translate'
import { cleanDistilled } from '../../core/session-tree/troubleshoot'
import type { EnhanceOptions } from './enhance'

/**
 * 经验沉淀（F13）：把「失败 → 修正」轨迹交给当前活跃档案的模型，提炼成排障技能正文。
 *
 * 与 `enhancePrompt` 同一套「一次性模型调用」骨架（同一个 EnhanceOptions 形状、
 * 同样的超时与中止语义）—— 差别只在提示词与清洗规则。刻意**不在这一层写盘**：
 * 生成结果交给调用方（IPC / 界面）决定是否保存，避免模型幻觉直接污染技能库。
 *
 * 硬约束写进提示词：只准用轨迹里出现过的事实，不确定的标「待验证」。
 * 排障手册最危险的失败模式是「编一条看着合理的命令」，而这条命令在真机上会改错配置。
 */

export const DISTILL_SYSTEM_PROMPT = `你是网络实验排障经验的整理助手。用户会给你一段真实执行轨迹里的「失败 → 之后调用」片段，请把它整理成一份可复用的排障技能（Markdown 操作手册）。

输出要求：
1. 只输出 Markdown 正文：**不要**写 frontmatter（不要 \`---\` 块）、不要用代码块包住整篇、不要写「沉淀后：」之类的引导语。
2. 结构固定为四节：\`## 症状\`、\`## 判断依据\`、\`## 处置步骤\`、\`## 验证方式\`。
3. **只使用轨迹里出现过的事实**：命令、设备名、地址、错误码都必须来自轨迹，不得编造。
4. 轨迹没给出的关键前提（如某接口名、某 VLAN 号），写成「待验证：…」而不要猜。
5. 处置步骤用有序列表，每步一句话说清「做什么 + 为什么」。
6. 中文输出，全文控制在 600 字以内。`

export function buildDistillUserPrompt(transcript: string): string {
  return `以下是真实执行轨迹里抽取出的「失败 → 修正」片段：\n\n${transcript.trim()}\n\n请整理成一份排障技能（Markdown 正文，四节结构）。`
}

/**
 * 跑一次提炼。失败/超时的报错口径与 `enhancePrompt` 保持一致（用户看到的是同一类文案）。
 */
export async function distillSkill(transcript: string, opts: EnhanceOptions): Promise<string> {
  const text = (transcript ?? '').trim()
  if (!text) throw new Error('这段会话里没有可沉淀的失败轨迹')
  if (!opts.apiKey) throw new Error('当前模型档案未配置 API Key，无法自动沉淀排障技能')

  const timeoutMs = Math.max(3000, opts.timeoutMs ?? 60000)
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

  const handle = await buildLLM({
    provider: opts.profile.provider,
    baseUrl: opts.profile.baseUrl,
    model: opts.profile.model,
    apiKey: opts.apiKey
  })
  const model = handle.models.getModel(handle.provider, handle.modelId)
  if (!model) throw new Error(`模型不存在：${handle.modelId}`)

  const messages: Message[] = [
    { role: 'user', content: buildDistillUserPrompt(text), timestamp: Date.now() }
  ]
  const acc = newTurn()
  const stream = handle.models.stream(
    model,
    { systemPrompt: DISTILL_SYSTEM_PROMPT, messages },
    { apiKey: opts.apiKey, temperature: 0.3, signal }
  )

  try {
    for await (const ev of stream) {
      consumeEvent(acc, ev)
      if (ev.type === 'error') {
        throw new Error(
          ev.error?.errorMessage ?? (ev.reason === 'aborted' ? '请求已中止' : '模型请求失败')
        )
      }
    }
    await stream.result()
  } catch (e) {
    if (timeout.aborted) {
      throw new Error(`沉淀超时（${Math.round(timeoutMs / 1000)} 秒），请重试或换一个模型`)
    }
    throw e
  }

  const cleaned = cleanDistilled(acc.text)
  if (!cleaned) throw new Error('模型没有返回可用内容，请重试')
  return cleaned
}