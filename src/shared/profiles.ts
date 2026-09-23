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
import { DEFAULT_PROFILES, type AgentSettings, type ModelProfile, type Settings } from './types'

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
  return {
    id: isProfileId(o.id) ? o.id : newProfileId(),
    label: label || labelFor(provider as LlmProvider, model),
    provider: provider as LlmProvider,
    baseUrl: String(o.baseUrl ?? '').trim(),
    model,
    maxRounds: clampInt(o.maxRounds, 1, 50, 12),
    temperature: clampNum(o.temperature, 0, 2, 0.2)
  }
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
 * 把任意来源的 agent 设置（含 v1.4 的扁平形态）规整成 v1.5 形态。
 *
 * 迁移优先级：profiles（已迁移过）> 扁平字段（v1.4 遗留）> 预置档案。
 * 关键点：扁平字段迁移出的那档 id 固定为 `p-legacy`，这样「那把老密钥」
 * 在密钥迁移时能准确挂到同一档上，用户打开设置不会看到「模型在但密钥没了」。
 */
export const LEGACY_PROFILE_ID = 'p-legacy'

export function normalizeAgentSettings(raw: RawAgentSettings | undefined): AgentSettings {
  const r = raw ?? {}
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
