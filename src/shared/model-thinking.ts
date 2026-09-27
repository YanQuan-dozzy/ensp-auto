/**
 * 逐模型「思考能力」能力表（v2.3）。
 *
 * 为什么必须有这张表：思考（reasoning）在各家根本不是同一件事 ——
 * - **能不能关**不一样：GLM-5.3 / Kimi K3 / MiniMax M2.x 是「强制思考」，
 *   显式传关闭会直接报错；DeepSeek、GLM-5.2、qwen3.7、豆包 Seed 2.1 则可以关。
 * - **档位**不一样：DeepSeek / GLM-5.3 / Kimi K3 是 low·high·max，
 *   豆包是 minimal·low·medium·high，Claude 是 low·medium·high·xhigh·max，
 *   Gemini 3 用 thinking_level，而 GLM-5.1、Kimi K2.6 **根本没有强度参数**。
 * - **采样参数**也变了：Kimi K3 / Claude Sonnet 5 这类新模型对
 *   temperature / top_p 传非默认值会 400；DeepSeek 思考模式下它们则静默失效。
 *
 * 依据（2026-09 逐条核对官方文档）：
 * - DeepSeek `api-docs.deepseek.com/zh-cn/guides/thinking_mode`：
 *   开关 `thinking.type`（默认 enabled）；强度 `reasoning_effort` **low / high / max**；
 *   思考模式下不支持 temperature / top_p（传了不报错但不生效）。
 * - 智谱 `docs.bigmodel.cn/cn/guide/capabilities/thinking`：GLM-5.3 / 5.3-FLASH
 *   **强制思考，传 disabled 会报错**，且只接受 max / high / low；GLM-5.2 可关，
 *   支持 max/xhigh/high/medium/low/minimal/none（low·medium→high，xhigh→max）；
 *   GLM-5.1 及更早只有开关、没有 reasoning_effort。
 * - 千问 `help.aliyun.com/zh/model-studio/deep-thinking`：分为「混合思考模式」
 *   （enable_thinking 可开关，qwen3.7-max / qwen3-max / qwen-plus / qwen-flash 属此类）
 *   与「仅思考模式」（无法关闭，如 qwen3.7-max-preview）。强度只有 omni 系用 reasoning_effort，
 *   文本系列在 OpenAI 兼容线没有统一强度字段。
 * - Kimi `platform.kimi.com/docs/api/models-overview`：K3 **始终思考**（关闭会报错）、
 *   reasoning_effort low/high/max；K2.6 可开关无强度；K2.7-code 始终思考；
 *   这几个型号的 temperature / top_p **不可修改**（传值报错）。
 * - 豆包 `volcengine.com/docs/82379/2549861`：thinking 开关（默认开），
 *   reasoning_effort minimal / low / medium / high（默认 high）。
 * - MiniMax `platform.minimaxi.com/docs/api-reference/text-chat-anthropic`：
 *   M3 默认关闭 thinking，传 adaptive 开启、disabled 关闭，无强度档位；
 *   M2.x **thinking 无法关闭**（传 disabled 也仍开启）。
 * - Claude `platform.claude.com/docs/en/build-with-claude/effort`：5 系 / 4.7+
 *   走 adaptive thinking（默认开启，可用 thinking.type=disabled 关），
 *   强度用 output_config.effort = low/medium/high/xhigh/max；Fable / Mythos **只能 adaptive**；
 *   Sonnet 5 对 temperature / top_p / top_k 传非默认值会 400。
 * - Gemini `ai.google.dev/gemini-api/docs/thinking`：thinking_level（默认动态思考，
 *   按型号支持 minimal / low / medium / high）。
 * - 千帆 ERNIE：只有「常规模式 / 思考模式」两种，未见公开的强度档位文档。
 * - 自定义端点：无从核实，一律不干预（宁可少一个可调项，也不能猜错参数打成 400）。
 */
import type { LlmProvider } from './providers'
import type { ModelProfile, ReasoningEffort, ThinkingMode } from './types'

export interface ModelCapability {
  /** toggle 可开可关 / always 只能思考（显式关闭会报错）/ none 不提供思考参数 */
  thinking: 'toggle' | 'always' | 'none'
  /** 支持的强度档位；空数组 = 该模型没有强度参数，只有开关 */
  efforts: readonly ReasoningEffort[]
  /** 默认档位（用户没选过时下发它） */
  defaultEffort: ReasoningEffort
  /** 是否接受 temperature / top_p / top_k（部分新模型传了会 400） */
  sampling: boolean
  /** 面向用户的一句话说明：解释「为什么这里只有这些选项」 */
  note: string
}

/** 未核实的服务商：不干预思考与采样，全部沿用服务商默认 */
const UNKNOWN: ModelCapability = {
  thinking: 'none',
  efforts: [],
  defaultEffort: 'high',
  sampling: true,
  note: '该服务商的思考参数口径未核实，这里不干预，按服务商默认行为执行。'
}

/** DeepSeek V4 / V4.1 全系：开关 + low/high/max 三档 */
const DEEPSEEK: ModelCapability = {
  thinking: 'toggle',
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
  sampling: true,
  note: 'DeepSeek：thinking.type 开关（默认开启），强度 reasoning_effort 三档 low / high / max（默认 high）。思考模式下 temperature / top_p 不生效。'
}

/** GLM-5.3 / 5.3-FLASH：强制思考，只有 low/high/max */
const GLM_53: ModelCapability = {
  thinking: 'always',
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'max',
  sampling: true,
  note: 'GLM-5.3 强制思考（传关闭会被服务端拒绝），强度仅支持 low / high / max。'
}

/** GLM-5.2：可关；其余档位会被服务端映射，这里只列有效档 */
const GLM_52: ModelCapability = {
  thinking: 'toggle',
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'max',
  sampling: true,
  note: 'GLM-5.2 可开关思考；low / medium 会被服务端映射为 high、xhigh 映射为 max，因此只列有效档。'
}

/** GLM-5.1 及更早 / GLM-4.6 / 4.5：只有开关 */
const GLM_LEGACY: ModelCapability = {
  thinking: 'toggle',
  efforts: [],
  defaultEffort: 'high',
  sampling: true,
  note: 'GLM-5.1 及更早只支持思考开关，没有强度参数（传 reasoning_effort 无效）。'
}

/** 千问混合思考模型：只有 enable_thinking 开关 */
const QWEN_MIXED: ModelCapability = {
  thinking: 'toggle',
  efforts: [],
  defaultEffort: 'high',
  sampling: true,
  note: '千问混合思考模型用 enable_thinking 开关（默认开启）；OpenAI 兼容线没有统一的强度字段，因此这里只有开关。'
}

const KIMI_K3: ModelCapability = {
  thinking: 'always',
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'max',
  sampling: false,
  note: 'Kimi K3 始终思考（传关闭会报错），强度 low / high / max；temperature / top_p 不可修改，传值会报错。'
}

const KIMI_K26: ModelCapability = {
  thinking: 'toggle',
  efforts: [],
  defaultEffort: 'high',
  sampling: false,
  note: 'Kimi K2.6 可开关思考，没有强度参数；temperature / top_p 不可修改。'
}

const KIMI_CODE: ModelCapability = {
  thinking: 'always',
  efforts: [],
  defaultEffort: 'high',
  sampling: false,
  note: 'Kimi K2.7-code 始终思考且不可关闭；temperature / top_p 不可修改。'
}

const DOUBAO: ModelCapability = {
  thinking: 'toggle',
  efforts: ['minimal', 'low', 'medium', 'high'],
  defaultEffort: 'high',
  sampling: true,
  note: '豆包 Seed 系列默认开启深度思考，可关闭；强度 minimal / low / medium / high。'
}

/** MiniMax M3：默认关闭思考，可显式开启；无强度档位 */
const MINIMAX_M3: ModelCapability = {
  thinking: 'toggle',
  efforts: [],
  defaultEffort: 'high',
  sampling: true,
  note: 'MiniMax M3 在 OpenAI 兼容线默认开启思考，可显式关闭；没有强度档位。'
}

/** MiniMax M2.x：thinking 关不掉 */
const MINIMAX_M2: ModelCapability = {
  thinking: 'always',
  efforts: [],
  defaultEffort: 'high',
  sampling: true,
  note: 'MiniMax M2.x 的思考无法关闭（传关闭也仍然开启），也没有强度档位。'
}

const OPENAI_REASONING: ModelCapability = {
  thinking: 'toggle',
  efforts: ['minimal', 'low', 'medium', 'high'],
  defaultEffort: 'medium',
  sampling: false,
  note: 'GPT-5 系推理模型用 reasoning_effort 控强度（可选 none / minimal / low / medium / high，因型号而异）；部分型号不接受 temperature，这里按不传采样参数处理。'
}

const CLAUDE_ADAPTIVE: ModelCapability = {
  thinking: 'toggle',
  efforts: ['low', 'medium', 'high', 'max'],
  defaultEffort: 'high',
  sampling: false,
  note: 'Claude 5 系 / 4.7+ 默认自适应思考，可用 thinking.type=disabled 关闭；强度走 effort 参数；Sonnet 5 等型号不接受非默认采样参数。'
}

/** Fable / Mythos：只支持自适应思考，关不掉 */
const CLAUDE_ALWAYS: ModelCapability = {
  thinking: 'always',
  efforts: ['low', 'medium', 'high', 'max'],
  defaultEffort: 'high',
  sampling: false,
  note: '该 Claude 型号只支持自适应思考，无法关闭；强度走 effort 参数。'
}

/** Claude 4.5 及更早：旧版扩展思考，没有强度档位 */
const CLAUDE_LEGACY: ModelCapability = {
  thinking: 'toggle',
  efforts: [],
  defaultEffort: 'high',
  sampling: true,
  note: '该 Claude 型号使用旧版扩展思考（思考预算随 max_tokens 处理），没有强度档位。'
}

const GEMINI3: ModelCapability = {
  thinking: 'always',
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
  sampling: true,
  note: 'Gemini 3 默认动态思考（无法真正关闭）；用 thinking_level 调档，具体支持哪些档位因型号而异（minimal 仅部分型号支持）。'
}

/** 千帆 ERNIE：常规 / 思考两种模式，未见公开的强度档位 */
const QIANFAN: ModelCapability = {
  thinking: 'toggle',
  efforts: [],
  defaultEffort: 'high',
  sampling: true,
  note: '千帆 ERNIE 有常规模式与思考模式两种；未见公开的强度档位文档，因此这里只有开关。'
}

/** 模型名 → 能力：按前缀/精确名匹配，命中第一条即返回 */
function matchModel(provider: LlmProvider, model: string): ModelCapability | null {
  const m = model.trim().toLowerCase()

  if (provider === 'deepseek') {
    // V4 全系（deepseek-flash 即 V4.1-Flash）口径一致
    return DEEPSEEK
  }

  if (provider === 'zhipu') {
    if (m.startsWith('glm-5.3')) return GLM_53
    if (m.startsWith('glm-5.2')) return GLM_52
    if (
      m.startsWith('glm-5') ||
      m.startsWith('glm-4.7') ||
      m.startsWith('glm-4.6') ||
      m.startsWith('glm-4.5')
    ) {
      return GLM_LEGACY
    }
    // glm-4-flash 系列不在深度思考支持列表里
    return { ...GLM_LEGACY, thinking: 'none', note: '该 GLM 型号不支持深度思考参数。' }
  }

  if (provider === 'qwen') {
    // 「仅思考模式」的型号无法关闭
    if (/preview|thinking-only/.test(m)) {
      return { ...QWEN_MIXED, thinking: 'always', note: '该千问型号仅支持思考模式，无法关闭。' }
    }
    return QWEN_MIXED
  }

  if (provider === 'kimi') {
    if (m.startsWith('kimi-k3')) return KIMI_K3
    if (m.startsWith('kimi-k2.7-code')) return KIMI_CODE
    return KIMI_K26
  }

  if (provider === 'doubao') return DOUBAO

  if (provider === 'minimax') {
    return m.startsWith('minimax-m3') ? MINIMAX_M3 : MINIMAX_M2
  }

  if (provider === 'openai') return OPENAI_REASONING

  if (provider === 'anthropic') {
    if (m.startsWith('claude-fable') || m.startsWith('claude-mythos')) return CLAUDE_ALWAYS
    if (
      m.startsWith('claude-opus-5') ||
      m.startsWith('claude-sonnet-5') ||
      m.startsWith('claude-opus-4-8') ||
      m.startsWith('claude-opus-4-7') ||
      m.startsWith('claude-sonnet-4-6')
    ) {
      return CLAUDE_ADAPTIVE
    }
    return CLAUDE_LEGACY
  }

  if (provider === 'google') return GEMINI3

  if (provider === 'qianfan') return QIANFAN

  // custom：端点与模型名都是用户自填的，无从核实
  return UNKNOWN
}

export function modelCapability(provider: LlmProvider, model: string): ModelCapability {
  return matchModel(provider, model) ?? UNKNOWN
}

export function capabilityOf(profile: Pick<ModelProfile, 'provider' | 'model'>): ModelCapability {
  return modelCapability(profile.provider, profile.model)
}

/** 该档位是否被这个模型支持 */
export function supportsEffort(cap: ModelCapability, effort: ReasoningEffort): boolean {
  return cap.efforts.includes(effort)
}

/**
 * 把用户选的值收敛到该模型真正支持的范围。
 *
 * 三件事：
 * 1. 模型不支持思考参数（none）→ 思考模式回落 auto（不下发），强度保留但不会用到；
 * 2. 模型强制思考（always）→ 不允许 off（传关闭会报错），off 收敛成 on；
 * 3. 强度不在支持列表里 → 用默认档（例如从豆包切到 GLM-5.3 时 medium 就不合法了）。
 *
 * 为什么在「清洗」和「切模型」两处都调用：档案是持久化的，用户可能先存了豆包的
 * medium 再把模型名改成 glm-5.3；只在 UI 上收敛不够，主进程读到的仍是脏值。
 */
export function normalizeThinkingFields<
  T extends Pick<ModelProfile, 'provider' | 'model' | 'thinking' | 'reasoningEffort'>
>(profile: T): Pick<ModelProfile, 'thinking' | 'reasoningEffort'> {
  const cap = capabilityOf(profile)
  let thinking: ThinkingMode = profile.thinking
  if (cap.thinking === 'none') thinking = 'auto'
  else if (cap.thinking === 'always' && thinking === 'off') thinking = 'on'

  const effort =
    cap.efforts.length === 0
      ? cap.defaultEffort
      : supportsEffort(cap, profile.reasoningEffort)
        ? profile.reasoningEffort
        : cap.defaultEffort

  return { thinking, reasoningEffort: effort }
}

/** 浮层 / 弹窗的一句话说明（说明「为什么只有这些选项」） */
export function capabilityNote(profile: Pick<ModelProfile, 'provider' | 'model'>): string {
  return capabilityOf(profile).note
}

/** pi-ai 认识的档位集合（含 off，比用户可选档位多一个） */
const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'max'] as const

/**
 * 该模型「实际可用」的档位集合（供运行时与 UI 共用）。
 *
 * 没有强度参数的模型（GLM-5.1、Kimi K2.6 这类只有开关的）单独给一个中性档 'high'：
 * 运行时要表达的是「开启思考」，而 pi 的适配层只看档位是否存在来决定下发 enable 字段，
 * 因此必须给一个合法档位，不能留空集合。
 */
export function availableEfforts(cap: ModelCapability): readonly ReasoningEffort[] {
  return cap.efforts.length > 0 ? cap.efforts : ['high']
}

/**
 * 生成给 pi-ai 的 `thinkingLevelMap`。
 *
 * 为什么要显式声明：pi 的 clampThinkingLevel 会按它裁剪档位，**未声明**的 'max'
 * 会被判成不可用而默默降档；把不支持的档位显式写成 null 才能真正拦住
 * 「给 GLM-5.3 传 medium 直接报错」这类事故。
 */
export function thinkingLevelMap(cap: ModelCapability): Record<string, string | null> {
  const allowed = new Set<string>(availableEfforts(cap))
  const map: Record<string, string | null> = {}
  for (const level of PI_LEVELS) {
    if (level === 'off') {
      // 强制思考的模型不允许关闭：off 映射成 null，pi 就不会下发关闭语义的字段
      map[level] = cap.thinking === 'toggle' ? 'off' : null
      continue
    }
    map[level] = allowed.has(level) ? level : null
  }
  return map
}