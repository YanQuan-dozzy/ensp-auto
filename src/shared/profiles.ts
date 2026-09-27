/**
 * 模型档案的纯逻辑（主进程与渲染层共用）。
 *
 * 这里刻意只放「不碰文件、不碰 Electron」的函数：
 * 解析活跃档案、把历史遗留的扁平设置迁移成档案、生成新 id。
 * 迁移逻辑之所以必须存在且必须幂等：老用户本地已经存着一份
 * `{ provider, baseUrl, model, maxRounds, temperature }` 的扁平 agent 设置，
 * 直接改成 profiles 会让他们的配置凭空消失（还会丢掉那把 API Key 的归属判断）。
 */

import { ALL_PROVIDERS, type LlmProvider } from './providers'
import { normalizeThinkingFields } from './model-thinking'
import {
  DEFAULT_PROFILES,
  MAX_CONTEXT_WINDOW,
  PRESET_CONTEXT_WINDOW,
  PRESET_MAX_ROUNDS,
  PROFILE_BOUNDS,
  REASONING_EFFORTS,
  type AgentSettings,
  type ModelProfile,
  type ReasoningEffort,
  type Settings
} from './types'

export const PROFILE_ID_RE = /^p-[a-z0-9][a-z0-9-]{0,63}$/
export const MCP_SERVER_ID_RE = /^m-[a-z0-9][a-z0-9-]{0,63}$/

function randomSuffix(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().toLowerCase()
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

export function newProfileId(): string {
  return `p-${randomSuffix()}`
}

export function newMcpServerId(): string {
  return `m-${randomSuffix()}`
}

export function isProfileId(v: unknown): v is string {
  return typeof v === 'string' && PROFILE_ID_RE.test(v)
}

export function isMcpServerId(v: unknown): v is string {
  return typeof v === 'string' && MCP_SERVER_ID_RE.test(v)
}

/** 由 provider + 模型名生成一个像样的默认显示名（用户可改） */
export function labelFor(provider: LlmProvider, model: string): string {
  const meta = ALL_PROVIDERS[provider]
  const short = (meta?.label ?? String(provider)).replace(/[（(].*?[)）]/g, '').trim()
  const m = model.trim()
  return m ? `${short} ${m}` : short
}

/**
 * 「添加模型」的空白草稿：给一个能直接保存的合法档案（预置服务商 + 它的首个推荐模型）。
 *
 * 为什么不是真的空对象：档案在清洗阶段就要求 provider 合法、模型名非空，
 * 让用户从一个非法状态开始填，等于把「保存失败」提前埋进流程里。
 */
export function newProfileDraft(provider: LlmProvider = 'deepseek'): ModelProfile {
  const meta = ALL_PROVIDERS[provider] ?? ALL_PROVIDERS.deepseek
  const model = meta.models[0] ?? ''
  return {
    id: newProfileId(),
    label: model || meta.label,
    provider,
    baseUrl: meta.defaultBaseUrl,
    model,
    contextWindow: PRESET_CONTEXT_WINDOW,
    maxOutputTokens: 16000,
    maxRounds: PRESET_MAX_ROUNDS,
    temperature: 0.2,
    supportsImage: false,
    thinking: 'auto',
    reasoningEffort: 'high',
    maxContext: false,
    topP: null,
    topK: null,
    enabled: true
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 单个档案的清洗：字段白名单 + 取值范围收敛。返回 null 表示这条不可用，应丢弃 */
export function sanitizeProfile(raw: unknown): ModelProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const provider = String(o.provider ?? '')
  if (!(provider in ALL_PROVIDERS)) return null
  const model = String(o.model ?? '').trim()
  if (!model) return null
  const label = String(o.label ?? '').trim()
  const B = PROFILE_BOUNDS
  // 思考模式 / 强度必须按「这一档模型的真实能力」收敛：给强制思考的模型存一个 off、
  // 或给 GLM-5.3 存一个 medium，都会在真实请求上变成 400（见 shared/model-thinking.ts）
  const thinking = normalizeThinkingFields({
    provider: provider as LlmProvider,
    model,
    thinking: o.thinking === 'on' || o.thinking === 'off' ? o.thinking : 'auto',
    reasoningEffort: REASONING_EFFORTS.includes(o.reasoningEffort as ReasoningEffort)
      ? (o.reasoningEffort as ReasoningEffort)
      : 'high'
  })
  return {
    id: isProfileId(o.id) ? o.id : newProfileId(),
    label: label || labelFor(provider as LlmProvider, model),
    provider: provider as LlmProvider,
    baseUrl: String(o.baseUrl ?? '').trim(),
    model,
    contextWindow: clampInt(
      o.contextWindow,
      B.contextWindow.min,
      B.contextWindow.max,
      PRESET_CONTEXT_WINDOW
    ),
    maxOutputTokens: clampInt(
      o.maxOutputTokens,
      B.maxOutputTokens.min,
      B.maxOutputTokens.max,
      16000
    ),
    maxRounds: clampInt(o.maxRounds, B.maxRounds.min, B.maxRounds.max, PRESET_MAX_ROUNDS),
    temperature: clampNum(o.temperature, B.temperature.min, B.temperature.max, 0.2),
    supportsImage: o.supportsImage === true,
    thinking: thinking.thinking,
    reasoningEffort: thinking.reasoningEffort,
    maxContext: o.maxContext === true,
    // Top P / K 的「留空」用 null 表达：与 0 区分（topP = 0 是合法采样值，含义与留空完全不同）
    topP: clampOptionalNum(o.topP, B.topP.min, B.topP.max),
    topK: clampOptionalInt(o.topK, B.topK.min, B.topK.max),
    // 老配置里没有这个字段：默认启用，否则升级后模型切换器会变空
    enabled: o.enabled !== false
  }
}

/** 可空的浮点清洗：空串 / null / undefined / 非数字 → null（留空，用服务商默认） */
function clampOptionalNum(v: unknown, min: number, max: number): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(min, Math.min(max, n))
}

function clampOptionalInt(v: unknown, min: number, max: number): number | null {
  const n = clampOptionalNum(v, min, max)
  return n === null ? null : Math.trunc(n)
}

export function sanitizeProfiles(raw: unknown): ModelProfile[] {
  if (!Array.isArray(raw)) return []
  const out: ModelProfile[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const p = sanitizeProfile(item)
    if (!p) continue
    // id 去重：重复 id 会让「活跃档案」二义，后到的重新发号
    if (seen.has(p.id)) p.id = newProfileId()
    seen.add(p.id)
    out.push(p)
  }
  return out
}

/** v1.4 及以前的扁平 agent 设置（迁移输入） */
export interface LegacyAgentFields {
  runtime?: unknown
  provider?: unknown
  baseUrl?: unknown
  model?: unknown
  maxRounds?: unknown
  temperature?: unknown
}

export type RawAgentSettings = Partial<AgentSettings> & LegacyAgentFields

/**
 * v2.9 之前「出厂预置档」的旧默认窗口，键为 `provider/model`。
 *
 * 为什么按 provider+model 精确匹配、而不是「窗口小于 256k 就抬」：
 * 用户可能特意给本地小模型（Ollama / vLLM）填一个 128k，甚至给 deepseek
 * 指向一个窗口更小的中转 —— 无差别抬高会让这些档案在请求时直接溢出。
 * 只认「出厂预置的那三档 + 仍是旧默认窗口」这一个组合，才能既完成升级
 * 又不碰用户自己调过的值。
 */
const LEGACY_PRESET_WINDOWS: Record<string, number> = {
  'deepseek/deepseek-flash': 128000,
  'zhipu/glm-5.3': 200000
}

/** v2.9 之前所有预置档的默认轮数 */
const LEGACY_DEFAULT_ROUNDS = 12
/** v2.9 之前在设置页能填的最大轮数（顶到它的档案 = 用户想调更大但被卡住了） */
const LEGACY_MAX_ROUNDS = 50

/**
 * v2.9：把「被旧 UI 卡住」的轮数抬到新默认值（12 / 50 → 200）。
 *
 * 为什么需要这一步：设置是本地持久化的，只改 DEFAULT_PROFILES 仅对全新安装生效，
 * 老用户的档案里仍是 12 轮（没动过）或 50 轮（顶到旧上限调不动了），等于改了没反应。
 *
 * 为什么只认这两个值、而不是「小于 200 就抬」：8 轮、30 轮这类是用户自己敲进去的，
 * 迁移不许把一个显式设置改掉（tests/unit 里就有守着这条的用例）。
 * 这两个判据恰好对应「没表达过意愿」和「表达了但被上限挡住」—— 也正是要修的两类。
 * 轮数多给只多花 token，不用完不产生费用，所以这里抬错的代价很低。
 *
 * 幂等：抬过之后就不再等于这两个值；不过真正保证「只跑一次」的是调用点
 * （store.ts 的 migrateDefaultValues 按落盘版本门控，见 upgradeAgentDefaults）。
 */
function upgradePresetDefaults(p: ModelProfile): ModelProfile {
  let next = p
  if (p.maxRounds === LEGACY_DEFAULT_ROUNDS || p.maxRounds === LEGACY_MAX_ROUNDS) {
    next = { ...next, maxRounds: PRESET_MAX_ROUNDS }
  }
  // 窗口只抬「出厂预置档 + 仍是旧默认窗口」这一个组合：窗口是硬约束，
  // 抬到超过模型真实上限会变成请求直接溢出，比轮数凶险得多，宁可少抬。
  const legacyWindow = LEGACY_PRESET_WINDOWS[`${p.provider}/${p.model}`]
  if (legacyWindow !== undefined && p.contextWindow === legacyWindow) {
    next = { ...next, contextWindow: PRESET_CONTEXT_WINDOW }
  }
  return next
}

/**
 * v2.9：把「被旧 UI 卡住」的默认值抬到新默认值（整块 agent 设置一起过）。
 *
 * **只在落盘版本落后时调用一次**（见 store.ts 的 migrateDefaultValues）。
 * 绝不能放进 normalizeAgentSettings —— 那个函数在每次 updateSettings 都会跑，
 * 用户之后主动填回 50 轮或 12 轮会被静默改回去，正是这个项目最讨厌的
 * 「改了没反应、还没有任何报错」。
 *
 * 没变化时返回**原对象**：调用方（zustand selector / store 比较）依赖引用稳定。
 */
export function upgradeAgentDefaults(agent: AgentSettings): AgentSettings {
  const profiles = agent.profiles.map(upgradePresetDefaults)
  const changed = profiles.some((p, i) => p !== agent.profiles[i])
  return changed ? { ...agent, profiles } : agent
}

/**
 * 把任意来源的 agent 设置（含 v1.4 的扁平形态）规整成 v1.5 形态。
 *
 * 迁移优先级：profiles（已迁移过）> 扁平字段（v1.4 遗留）> 预置档案。
 * 关键点：扁平字段迁移出的那档 id 固定为 `p-legacy`，这样「那把老密钥」
 * 在密钥迁移时能准确挂到同一档上，用户打开设置不会看到「模型在但密钥没了」。
 */
export const LEGACY_PROFILE_ID = 'p-legacy'

export function normalizeAgentSettings(raw: RawAgentSettings | undefined): AgentSettings {
  const r = raw ?? {}
  // 注意：这里**不做** v2.9 的默认值上调 —— 那个只在落盘版本落后时跑一次
  // （store.ts#migrateDefaultValues）。本函数每次 updateSettings 都会跑，
  // 往里塞「把 50 抬成 200」会让用户之后主动填的 50 每次保存都被改回去。
  let profiles = sanitizeProfiles(r.profiles)

  if (profiles.length === 0) {
    const legacy = sanitizeProfile({
      id: LEGACY_PROFILE_ID,
      label: '',
      provider: r.provider,
      baseUrl: r.baseUrl,
      model: r.model,
      maxRounds: r.maxRounds,
      temperature: r.temperature
    })
    if (legacy) {
      profiles = [legacy]
    } else {
      // 深拷贝预置档，避免调用方改到 DEFAULT_PROFILES 本体
      profiles = DEFAULT_PROFILES.map((p) => ({ ...p }))
    }
  }

  const wanted = typeof r.activeProfileId === 'string' ? r.activeProfileId : ''
  const activeProfileId = profiles.some((p) => p.id === wanted) ? wanted : profiles[0]!.id

  return {
    runtime: r.runtime === 'mock' ? 'mock' : 'react',
    profiles,
    activeProfileId,
    systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt : ''
  }
}

/**
 * 当前生效档案；永不为 undefined。
 *
 * 兜底顺序：命中的活跃档案 → 第一档 → 预置档。
 * 最后那层不是多余的：设置文件可能被手工改坏或由旧版本回写，
 * 而这个函数跑在体检、每次请求装配的热路径上，抛异常等于整个应用不可用。
 * 注意返回的是**稳定引用**（不 clone）—— 它被 zustand selector 直接使用，
 * 每次返回新对象会导致 React 无限重渲染。
 */
export function activeProfile(agent: AgentSettings): ModelProfile {
  const list = Array.isArray(agent?.profiles) ? agent.profiles : []
  const found = list.find((p) => p?.id === agent?.activeProfileId)
  if (found) return found
  if (list.length > 0) return list[0]!
  return DEFAULT_PROFILES[0]!
}

export function activeProfileOf(settings: Settings): ModelProfile {
  return activeProfile(settings.agent)
}

/**
 * 该档**实际**生效的上下文窗口（token）。
 *
 * 为什么不让调用方各自读 contextWindow：开了「更大上下文（Max）」之后，
 * 真实窗口是 1M 而不是用户填的基数 —— 溢出判定、压缩预算、模型元数据
 * 三处若各读各的，就会出现「请求按 1M 发、压缩按 128k 压」的错位。
 */
export function effectiveContextWindow(profile: ModelProfile): number {
  const base = Math.max(1000, profile.contextWindow)
  return profile.maxContext ? Math.max(base, MAX_CONTEXT_WINDOW) : base
}

/** 展示用的窗口文案（1M / 256k） */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1000000) return `${Math.round(tokens / 100000) / 10}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

/**
 * 模型切换器实际能选的档案：只列「启用」的那些。
 *
 * 兜底：一档都没启用时返回全部 —— 否则切换器会变空，用户连模型都换不了，
 * 而「全不启用」本身也不是一个有意义的配置。
 */
export function enabledProfiles(agent: AgentSettings): ModelProfile[] {
  const list = Array.isArray(agent?.profiles) ? agent.profiles : []
  const on = list.filter((p) => p?.enabled !== false)
  return on.length > 0 ? on : list
}

/**
 * 关闭某档（enabled = false）。
 *
 * 关掉的若是当前活跃档，必须顺势把活跃档挪到另一档启用的档案上：
 * 留着「活跃但已停用」的档案，代理下次请求还会用它，UI 上却看不到它。
 */
export function withProfileEnabled(
  agent: AgentSettings,
  profileId: string,
  enabled: boolean
): AgentSettings {
  const profiles = agent.profiles.map((p) => (p.id === profileId ? { ...p, enabled } : p))
  if (enabled || agent.activeProfileId !== profileId) return { ...agent, profiles }
  const next = profiles.find((p) => p.enabled) ?? profiles[0]!
  return { ...agent, profiles, activeProfileId: next.id }
}

/** 切换活跃档案，越界不生效（返回原对象） */
export function withActiveProfile(agent: AgentSettings, profileId: string): AgentSettings {
  if (!agent.profiles.some((p) => p.id === profileId)) return agent
  if (agent.activeProfileId === profileId) return agent
  return { ...agent, activeProfileId: profileId }
}

/**
 * 删除一档：至少保留一档（删到空就没模型可用了，UI 上也不该出现这种状态）。
 * 删掉的若是活跃档，顺位切到第一档。
 */
export function removeProfile(agent: AgentSettings, profileId: string): AgentSettings {
  if (agent.profiles.length <= 1) return agent
  const profiles = agent.profiles.filter((p) => p.id !== profileId)
  if (profiles.length === agent.profiles.length) return agent
  return {
    ...agent,
    profiles,
    activeProfileId: agent.activeProfileId === profileId ? profiles[0]!.id : agent.activeProfileId
  }
}
