import { createModels, createProvider, type MutableModels, type Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { COMPAT_PROVIDERS, isCompatProvider, type CompatProvider, type LlmProvider } from '@shared/providers'
import { thinkingLevelMap } from '@shared/model-thinking'
import type { ReasoningEffort } from '@shared/types'

/**
 * 按设置装配 pi-ai 的 Models 集合（多 provider 的单一装配点）。
 *
 * 划分（参照 pi 官方「自定义 Provider」文档的思路）：
 * - deepseek / zhipu / qwen / kimi / doubao / qianfan / minimax / custom → OpenAI Chat
 *   Completions 兼容线（createProvider + openAICompletionsApi）。baseUrl 与 model 名都透传：
 *   国产主流平台官方均提供 OpenAI 兼容端点，且用户常把 baseUrl 指到代理/中转，
 *   因此这几档合一走兼容线，差别只在默认端点与 UI 标签。
 * - openai / anthropic / google → 官方内建 provider（各自的原生 API），model 须在目录里，
 *   API key 通过每请求的 apiKey 显式传入（最高优先级）。
 *
 * provider 工厂全部动态 import：anthropic/google 等原生 SDK 只在首次请求时加载，
 * 不进首屏主进程包（体积控制，对应 ARCHITECTURE §2.2 已落地的取舍）。
 */

export interface LLMSettings {
  provider: LlmProvider
  baseUrl: string
  model: string
  apiKey: string
  /** 逐档的上下文窗口（token）；缺省用兼容线的保守默认值 */
  contextWindow?: number
  /** 逐档的输出上限（token） */
  maxOutputTokens?: number
  /** 该档是否支持图片输入（决定模型元数据里的 input 能力声明） */
  supportsImage?: boolean
  /**
   * 思考能力（来自 shared/model-thinking.ts 的能力表）。
   *
   * 为什么不让装配层自己判断：pi-ai 只在 `model.reasoning` 为真时才会走各家的思考分支，
   * 而「能不能关 / 支持哪几档」是逐模型的事实，必须由能力表一处给出。
   */
  thinking?: 'toggle' | 'always' | 'none'
  /** 该模型支持的强度档位（空数组 = 只有开关，没有强度参数） */
  thinkingEfforts?: readonly ReasoningEffort[]
}

export interface LLMHandle {
  models: MutableModels
  provider: string
  modelId: string
}

/** 兼容线的兜底窗口与输出上限：用户没填时用这两个值，与档案默认值保持一致 */
const DEFAULT_CONTEXT_WINDOW = 256000
const DEFAULT_MAX_TOKENS = 16000

const BUILTIN_FACTORIES: Record<'openai' | 'anthropic' | 'google', () => Promise<Provider>> = {
  openai: () => import('@earendil-works/pi-ai/providers/openai').then((m) => m.openaiProvider()),
  anthropic: () =>
    import('@earendil-works/pi-ai/providers/anthropic').then((m) => m.anthropicProvider()),
  google: () =>
    import('@earendil-works/pi-ai/providers/google').then((m) => m.googleProvider())
}

export function buildLLM(settings: LLMSettings): Promise<LLMHandle> {
  if (isCompatProvider(settings.provider)) {
    return buildCompat(settings)
  }
  return buildBuiltin(settings)
}

async function buildCompat(settings: LLMSettings): Promise<LLMHandle> {
  const provider = settings.provider as CompatProvider
  const preset = COMPAT_PROVIDERS[provider]
  const baseUrl = (settings.baseUrl || preset.defaultBaseUrl).trim()
  const models = createModels()
  // 只有模型确实有思考能力时才声明 reasoning —— pi 的思考分支以此为开关；
  // 未核实的服务商（custom 等）保持 false，请求里不会多出任何思考字段
  const supportsThinking = settings.thinking === 'toggle' || settings.thinking === 'always'
  const p = createProvider({
    id: 'compat',
    name: preset.label,
    baseUrl,
    auth: {
      apiKey: {
        name: 'API Key',
        // 密钥不落地任何 credential store，运行时每请求显式传 apiKey（优先级最高）。
        resolve: async () => ({ auth: {}, source: 'per-request' })
      }
    },
    models: [
      {
        id: settings.model,
        name: settings.model,
        api: 'openai-completions',
        provider: 'compat',
        baseUrl,
        reasoning: supportsThinking,
        ...(supportsThinking
          ? {
              // 逐档声明：不支持的档位写 null，pi 的 clamp 才会真的拦住它们
              thinkingLevelMap: thinkingLevelMap({
                thinking: settings.thinking === 'always' ? 'always' : 'toggle',
                efforts: settings.thinkingEfforts ?? [],
                defaultEffort: 'high',
                sampling: true,
                note: ''
              })
            }
          : {}),
        input: settings.supportsImage ? ['text', 'image'] : ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Math.max(1000, settings.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
        maxTokens: Math.max(256, settings.maxOutputTokens ?? DEFAULT_MAX_TOKENS)
      }
    ],
    api: openAICompletionsApi()
  })
  models.setProvider(p)
  return { models, provider: 'compat', modelId: settings.model }
}

async function buildBuiltin(settings: LLMSettings): Promise<LLMHandle> {
  // buildLLM 已把 deepseek/zhipu/qwen/custom 分流到 buildCompat，这里只剩三个官方 provider
  const providerId = settings.provider as 'openai' | 'anthropic' | 'google'
  const factory = BUILTIN_FACTORIES[providerId]
  const models = createModels()
  const provider = await factory()
  models.setProvider(provider)

  const model = models.getModel(providerId, settings.model)
  if (!model) {
    const available = models
      .getModels(providerId)
      .slice(0, 16)
      .map((m) => m.id)
      .join('、')
    throw new Error(
      `模型「${settings.model}」不在 ${settings.provider} 的目录中，可用：${available || '无'}` +
        '。如需自定义模型或端点，请把 provider 切到「自定义 OpenAI 兼容端点」。'
    )
  }
  return { models, provider: providerId, modelId: settings.model }
}