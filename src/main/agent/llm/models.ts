import { createModels, createProvider, type MutableModels, type Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

/**
 * 按设置装配 pi-ai 的 Models 集合（多 provider 的单一装配点）。
 *
 * 划分（参照 pi 官方「自定义 Provider」文档的思路）：
 * - deepseek / custom   → OpenAI Chat Completions 兼容线（createProvider + openAICompletionsApi）。
 *   baseUrl 与 model 名都透传：DeepSeek 官方目录不含 deepseek-chat 这类旧名，且用户常把
 *   baseUrl 指到代理/中转，因此这两档合一走兼容线，差别只在 UI 标签。
 * - openai / anthropic / google → 官方内建 provider（各自的原生 API），model 须在目录里，
 *   API key 通过每请求的 apiKey 显式传入（最高优先级）。
 *
 * provider 工厂全部动态 import：anthropic/google 等原生 SDK 只在首次请求时加载，
 * 不进首屏主进程包（体积控制，对应 ARCHITECTURE §2.2 已落地的取舍）。
 */

export interface LLMSettings {
  provider: 'deepseek' | 'openai' | 'anthropic' | 'google' | 'custom'
  baseUrl: string
  model: string
  apiKey: string
}

export interface LLMHandle {
  models: MutableModels
  provider: string
  modelId: string
}

const BUILTIN_FACTORIES: Record<'openai' | 'anthropic' | 'google', () => Promise<Provider>> = {
  openai: () => import('@earendil-works/pi-ai/providers/openai').then((m) => m.openaiProvider()),
  anthropic: () =>
    import('@earendil-works/pi-ai/providers/anthropic').then((m) => m.anthropicProvider()),
  google: () =>
    import('@earendil-works/pi-ai/providers/google').then((m) => m.googleProvider())
}

export function buildLLM(settings: LLMSettings): Promise<LLMHandle> {
  if (settings.provider === 'deepseek' || settings.provider === 'custom') {
    return buildCompat(settings)
  }
  return buildBuiltin(settings)
}

async function buildCompat(settings: LLMSettings): Promise<LLMHandle> {
  const baseUrl = (settings.baseUrl || 'https://api.deepseek.com').trim()
  const models = createModels()
  const provider = createProvider({
    id: 'compat',
    name: settings.provider === 'deepseek' ? 'DeepSeek（OpenAI 兼容）' : '自定义 OpenAI 兼容端点',
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
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 16384
      }
    ],
    api: openAICompletionsApi()
  })
  models.setProvider(provider)
  return { models, provider: 'compat', modelId: settings.model }
}

async function buildBuiltin(settings: LLMSettings): Promise<LLMHandle> {
  // buildLLM 已把 deepseek/custom 分流到 buildCompat，这里只剩三个官方 provider
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