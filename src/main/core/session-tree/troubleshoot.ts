import type { SessionNode } from '@shared/types'
import { toolStepsOf, type ToolStep } from './compare'

/**
 * 经验沉淀（F13，2026-09-26）—— 从会话轨迹里抽出「失败 → 修正」片段，供模型提炼成技能。
 *
 * 为什么值得做：会话树已经把**每次失败与之后的修正**完整落盘了 —— 这是最真实、
 * 最贴合本机环境的排障素材（不是教科书上的通用步骤，而是「在这台设备上踩过的坑」）。
 * 但它散落在几十条工具调用里，直接喂给模型噪声太大，所以先做一次确定性抽取。
 *
 * 本模块**纯函数、不调模型、不落盘**：抽取与提示拼装可单测；模型调用在
 * `agent/llm/distill.ts`，写盘在 SkillStore。
 */

export interface TroubleshootEpisode {
  /** 失败的调用 */
  failure: ToolStep
  /** 失败之后、下一次失败之前的调用（含真正的修正尝试） */
  after: ToolStep[]
}

/**
 * 抽出「失败 → 之后若干次调用」的片段。
 *
 * `maxAfter` 限制每段最多带多少次后续调用：一次失败之后可能跟着十几条无关调用，
 * 全带上会让提炼提示词噪声爆炸；取「最近的下一次失败之前」的前 N 条已经够用。
 */
export function findTroubleshootEpisodes(
  nodes: readonly SessionNode[],
  maxAfter = 6
): TroubleshootEpisode[] {
  const steps = toolStepsOf(nodes)
  const out: TroubleshootEpisode[] = []
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]!.ok !== false) continue
    const after: ToolStep[] = []
    for (let j = i + 1; j < steps.length && after.length < maxAfter; j++) {
      if (steps[j]!.ok === false) break
      after.push(steps[j]!)
    }
    out.push({ failure: steps[i]!, after })
  }
  return out
}

/**
 * 只保留「失败之后确实有成功调用」的片段。
 *
 * 判据是「后面出现过 ok === true」：这说明这条路最终走通了，才有资格叫「经验」。
 * 一路失败到底的片段沉淀出来的技能会教模型继续做错事。
 */
export function fixedEpisodes(episodes: readonly TroubleshootEpisode[]): TroubleshootEpisode[] {
  return episodes.filter((e) => e.after.some((s) => s.ok === true))
}

/** 一行调用的紧凑描述（失败带错误码/摘要，成功带耗时） */
function stepLine(s: ToolStep, mark: string): string {
  const status = s.ok === false ? `失败${s.errorCode ? `(${s.errorCode})` : ''}` : s.ok === true ? '成功' : '未完成'
  const summary = s.summary ? ` — ${s.summary}` : ''
  const ms = s.ms !== undefined ? ` ${s.ms}ms` : ''
  return `- ${mark} ${s.name}(${s.argKey}) ${status}${ms}${summary}`
}

/** 把片段拼成提炼提示词里的轨迹正文（截断到 maxChars，防止长会话把提示词撑爆） */
export function buildTroubleshootTranscript(
  episodes: readonly TroubleshootEpisode[],
  maxChars = 6000
): string {
  const blocks: string[] = []
  for (const [i, e] of episodes.entries()) {
    blocks.push(`## 场景 ${i + 1}`)
    blocks.push(stepLine(e.failure, '✘'))
    if (e.after.length) {
      blocks.push('之后的调用：')
      for (const s of e.after) blocks.push(stepLine(s, s.ok === true ? '✔' : '·'))
    }
    blocks.push('')
  }
  const text = blocks.join('\n').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（轨迹已截断）` : text
}

/**
 * 失败码 → 人话主题词。
 *
 * 为什么不直接堆工具名：列表里一行要放下「名称 + 描述」，`apply_config` 这类
 * 机器名既长又读不出「是哪类问题」；同一段轨迹里失败往往集中在同一个工具上，
 * 拼出来的标题（如「排障：connect_device、apply_config」）信息量接近零。
 * 错误码是人给的，天然就是主题词。
 */
const ERROR_THEME: Record<string, string> = {
  NOT_CONNECTED: '设备连接',
  DEVICE_BUSY: '设备占用',
  DANGER_COMMAND_BLOCKED: '危险命令',
  UNRECOGNIZED: '命令不被支持',
  FAILED: '配置下发',
  TIMEOUT: '操作超时'
}

/** 标题形态兜底：按工具名归主题（工具名是稳定的，比中文正文可靠） */
const TOOL_THEME: Record<string, string> = {
  connect_device: '设备连接',
  disconnect_device: '设备连接',
  register_device: '设备注册',
  apply_config: '配置下发',
  save_configuration: '配置保存',
  verify_ping: '连通性校验',
  verify_route: '路由校验',
  verify_dhcp: 'DHCP 校验',
  verify_nat: 'NAT 校验',
  verify_expectation: '回显校验'
}

/** 标题主题数上限：技能列表一行要放得下，再多就没有可读性了 */
const TITLE_THEME_MAX = 2

/**
 * 一段失败片段的主主题。
 *
 * ★ 错误码与工具名必须**二选一**，不能「错误码拿不到时再拿工具名补」：
 * 同一次失败会被两条路径各产出一个主题（`DANGER_COMMAND_BLOCKED` → 危险命令，
 * `apply_config` → 配置下发），标题立刻翻倍成「危险命令、配置下发排障」——
 * 读起来像是两类问题，其实只有一件。
 * 工具名只在错误码认不出来时兜底（工具名是稳定契约，别从中文摘要里猜）。
 */
function episodeTheme(failure: TroubleshootEpisode['failure']): string {
  if (failure.errorCode) {
    const byCode = ERROR_THEME[failure.errorCode.toUpperCase()]
    if (byCode) return byCode
  }
  return TOOL_THEME[failure.name] ?? ''
}

/**
 * 技能标题：**只给「是哪一类问题」的主题词**，不堆工具名。
 *
 * 榜单式标题（`排障：connect_device、apply_config`）在技能列表里会撑成一眼读不完的长串，
 * 而用户真正需要的只是「这条能解决什么」。所以一率收敛成「〈主题〉排障」，
 * 两三个不同主题时才并列；一个主题都认不出就退回通用名 —— 具体题目用户可在技能页改名。
 */
export function troubleshootDraftTitle(episodes: readonly TroubleshootEpisode[]): string {
  const themes: string[] = []
  for (const e of episodes) {
    const t = episodeTheme(e.failure)
    if (t && !themes.includes(t) && themes.length < TITLE_THEME_MAX) themes.push(t)
  }
  if (themes.length === 0) return '排障经验'
  return `${themes.join('、')}排障`
}

/** 技能描述：说明来源（让人一眼看出这是自动沉淀的、可能需要人工确认） */
export function troubleshootDraftDescription(episodes: readonly TroubleshootEpisode[]): string {
  return `本次轨迹沉淀：${episodes.length} 个「失败→修正」片段，基于本机实际操作，启用前请核对。`
}

/** 清洗模型输出：模型常无视「不要代码块」，这里剥掉最外层围栏与引导语（与 cleanEnhanced 同口径） */
export function cleanDistilled(raw: string, maxChars = 8000): string {
  let t = (raw ?? '').trim()
  if (!t) return ''
  const fence = /^```[A-Za-z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(t)
  if (fence && fence[1]) t = fence[1].trim()
  t = t.replace(/^(沉淀后|提炼后|技能正文|Skill)\s*[:：]\s*/i, '').trim()
  return t.slice(0, maxChars)
}