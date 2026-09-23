import type { Message } from '@earendil-works/pi-ai'
import type { ModelProfile } from '@shared/types'
import { buildLLM } from './models'
import { consumeEvent, newTurn } from './translate'

/**
 * 一键增强提示词（v1.5）。
 *
 * 存在的理由：这个应用的使用门槛不在「点哪」，而在「怎么把实验目标说清楚」。
 * 用户写「配一下 vlan」时，代理只能反复追问；把它重写成一条自包含、可执行的指令，
 * 代理第一轮就能干对事。用的是**当前活跃档案**的模型，所以切模型后增强风格也会跟着变。
 *
 * 约束：只做改写，不执行、不调工具、不引入用户没说的设备名与地址。
 * 缺信息时留明确的占位提示（如 <请补充：VLAN 号>），而不是替用户编一个。
 */

export const ENHANCE_SYSTEM_PROMPT = `你是网络实验指令改写助手。用户会给你一句粗糙的实验需求草稿，你把它改写成一条精准、可执行的实验目标。

改写要求：
1. 保留用户的全部原意，不新增用户没提到的设备名、IP、VLAN 号、协议参数。
2. 补齐隐含但必要的动作：先了解设备现状 → 需要改配置时先建快照 → 改完做结构化验证 → 给出结论。
3. 用户草稿里缺失的关键信息，用尖括号占位标出，例如 <请补充：目标 VLAN 号>；不要自行推测填值。
4. 涉及验证时写明用什么手段验证（如 verify_ping / verify_connectivity / display 具体命令）。
5. 语言与用户草稿一致（中文草稿就用中文）。
6. 只输出改写后的指令正文：不要解释、不要列举你的改写思路、不要用代码块包裹、不要写「改写后：」之类的引导语。
7. 长度控制在 300 字以内，一段话即可。`

export function buildEnhanceUserPrompt(draft: string): string {
  return `原始草稿：\n${draft.trim()}\n\n请输出改写后的实验目标。`
}

/**
 * 清洗模型输出：模型偶尔会无视「不要代码块」的要求。
 * 这里做保守清理（只剥最外层围栏与常见引导语），不重排内容。
 */
export function cleanEnhanced(raw: string, maxChars = 2000): string {
  let t = (raw ?? '').trim()
  if (!t) return ''
  // 剥掉最外层 ```lang ... ``` 围栏
  const fence = /^```[A-Za-z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(t)
  if (fence && fence[1]) t = fence[1].trim()
  // 剥掉常见的引导语前缀
  t = t.replace(/^(改写后|增强后|优化后|重新表述|增强结果)\s*[:：]\s*/, '').trim()
  // 两端可能残留的引号（模型把整段包在引号里）
  if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('「') && t.endsWith('」')))) {
    t = t.slice(1, -1).trim()
  }
  return t.slice(0, maxChars)
}

export interface EnhanceOptions {
  profile: ModelProfile
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
}

export async function enhancePrompt(draft: string, opts: EnhanceOptions): Promise<string> {
  const text = (draft ?? '').trim()
  if (!text) throw new Error('请先写下你的实验目标，再点增强')
  if (!opts.apiKey) throw new Error('当前模型档案未配置 API Key，无法使用提示词增强')

  const timeoutMs = Math.max(3000, opts.timeoutMs ?? 45000)
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

  const messages: Message[] = [{ role: 'user', content: buildEnhanceUserPrompt(text), timestamp: Date.now() }]
  const acc = newTurn()
  const stream = handle.models.stream(
    model,
    { systemPrompt: ENHANCE_SYSTEM_PROMPT, messages },
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
    if (timeout.aborted) throw new Error(`提示词增强超时（${Math.round(timeoutMs / 1000)} 秒），请重试或换一个模型`)
    throw e
  }

  const cleaned = cleanEnhanced(acc.text)
  if (!cleaned) throw new Error('模型没有返回可用内容，请重试')
  return cleaned
}
