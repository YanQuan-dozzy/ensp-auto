/**
 * LLM 服务商元信息（主进程装配与渲染层设置面板共用，避免端点/标签两处漂移）。
 *
 * 模型名清单为 2026-09 各厂商官方文档/发布记录核对的最新名称，已剔除官方下线/退役模型：
 * - deepseek：V4.1 Flash 起模型名统一为 deepseek-flash；deepseek-chat / deepseek-reasoner
 *   旧别名已于 2026-07 停止服务，不再列入。
 * - 智谱：GLM-5.x 为 2026 旗舰线；glm-4.7-flash / glm-4-flash 为免费档；GLM-4.5 及更旧代已移除。
 * - 千问：qwen3.7-max 为 2026-09 最新旗舰；qwen-turbo / qwen-long 已由 qwen-flash 等替代，不再列入。
 * - Kimi：kimi-k3 为最新旗舰；kimi-k2 系列、moonshot-v1 系列已于 2026-08 前全部下线。
 * - 豆包：doubao-seed-2.1 为当前推荐；doubao-seed-1.6 系列将于 2026-09-21 停服，不列入。
 * - 千帆：ernie-5.1 为最新（2026-05 发布），走 v2 OpenAI 兼容端点。
 * - MiniMax：MiniMax-M3 为最新旗舰（1M 上下文）。
 * - openai / anthropic / google：走 pi-ai 官方内建 provider，保存时主进程会校验目录，
 *   清单仅作输入提示，按 2026 当前代保留。
 */

export type CompatProvider =
  | 'deepseek'
  | 'zhipu'
  | 'qwen'
  | 'kimi'
  | 'doubao'
  | 'qianfan'
  | 'minimax'
  | 'custom'
export type NativeProvider = 'openai' | 'anthropic' | 'google'
export type LlmProvider = CompatProvider | NativeProvider

export interface ProviderMeta {
  /** 设置面板下拉标签 */
  label: string
  /** OpenAI 兼容线的默认端点；原生 provider 为 ''（不使用） */
  defaultBaseUrl: string
  /** 最新官方模型名建议，仅用于 UI 下拉提示（透传线不校验） */
  models: string[]
}

export const COMPAT_PROVIDERS: Record<CompatProvider, ProviderMeta> = {
  deepseek: {
    label: 'DeepSeek（OpenAI 兼容）',
    defaultBaseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash']
  },
  zhipu: {
    label: '智谱 GLM（OpenAI 兼容）',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-4.6', 'glm-4.7-flash', 'glm-4-flash']
  },
  qwen: {
    label: '通义千问（OpenAI 兼容）',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.7-max', 'qwen3-max', 'qwen-plus', 'qwen-flash', 'qwen3-coder-plus']
  },
  kimi: {
    label: '月之暗面 Kimi（OpenAI 兼容）',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed']
  },
  doubao: {
    label: '豆包·火山方舟（OpenAI 兼容）',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      'doubao-seed-evolving',
      'doubao-seed-2-1-pro-260628',
      'doubao-seed-2-1-turbo-260628',
      'doubao-seed-2-0-lite-260428',
      'doubao-seed-2-0-mini-260428'
    ]
  },
  qianfan: {
    label: '百度千帆（文心 ERNIE）',
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-5.1', 'ernie-5.0', 'ernie-4.5-turbo', 'ernie-4.5', 'ernie-x1']
  },
  minimax: {
    label: 'MiniMax（OpenAI 兼容）',
    defaultBaseUrl: 'https://api.minimax.cn/v1',
    models: [
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.1'
    ]
  },
  custom: {
    label: '自定义 OpenAI 兼容端点',
    defaultBaseUrl: '',
    models: []
  }
}

export const NATIVE_PROVIDERS: Record<NativeProvider, ProviderMeta> = {
  openai: {
    label: 'OpenAI（官方 API）',
    defaultBaseUrl: '',
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano']
  },
  anthropic: {
    label: 'Anthropic（Claude）',
    defaultBaseUrl: '',
    models: [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6'
    ]
  },
  google: {
    label: 'Google（Gemini）',
    defaultBaseUrl: '',
    models: ['gemini-3-pro', 'gemini-3-flash', 'gemini-3-flash-lite']
  }
}

export const ALL_PROVIDERS: Record<LlmProvider, ProviderMeta> = {
  ...COMPAT_PROVIDERS,
  ...NATIVE_PROVIDERS
}

/** 设置面板下拉的展示顺序 */
export const PROVIDER_ORDER: LlmProvider[] = [
  'deepseek',
  'zhipu',
  'qwen',
  'kimi',
  'doubao',
  'qianfan',
  'minimax',
  'openai',
  'anthropic',
  'google',
  'custom'
]

export function isCompatProvider(p: LlmProvider): p is CompatProvider {
  return p in COMPAT_PROVIDERS
}

export function isNativeProvider(p: LlmProvider): p is NativeProvider {
  return p in NATIVE_PROVIDERS
}
