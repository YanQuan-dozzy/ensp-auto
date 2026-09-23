/**
 * 技能 → system prompt 片段（纯函数，可测）。
 *
 * 已启用技能按固定模板追加到代理基础提示词后面，让 AI 在自主完成任务时
 * 「优先遵循已启用技能中的指令」。模板与 Trae/Claude 的 skills 注入方式对齐：
 * 每个技能 = 名称 + 描述 + 正文，语义上是一段独立的操作手册。
 */

export interface SkillContent {
  name: string
  description: string
  content: string
}

/** 已启用技能注入 system prompt 的总预算（超过即整体丢弃后续技能，见 D14） */
export const SKILL_PROMPT_MAX_CHARS = 60_000

export interface BuildSkillPromptOptions {
  /** 注入总预算；默认 SKILL_PROMPT_MAX_CHARS。为 0 时不注入任何技能 */
  maxChars?: number
}

export function buildSkillPrompt(
  skills: readonly SkillContent[],
  opts: BuildSkillPromptOptions = {}
): string {
  const budget = opts.maxChars ?? SKILL_PROMPT_MAX_CHARS
  const enabled = skills.filter((s) => (s.name || '').trim() && (s.content || '').trim())
  if (enabled.length === 0) return ''

  const header = '\n\n# 已启用技能（以下技能是用户当前选中的操作手册，请优先遵循其中的指令）\n\n'
  // 预算闸（D14）：按启用顺序累加，超限的**整段**丢弃并在尾部说明。
  // 不做半截截断 —— 半截技能（开头完整、结尾被腰斩）比没有更危险：
  // 模型会照着一段不完整的操作手册去执行。
  let used = header.length
  const parts: string[] = []
  const skipped: string[] = []
  for (const s of enabled) {
    const block = buildSkillBlock(s)
    if (budget > 0 && used + block.length + 2 > budget) {
      skipped.push(s.name.trim())
      continue
    }
    parts.push(block)
    used += block.length + 2
  }

  if (parts.length === 0) return ''

  const body = parts.join('\n\n')
  const note =
    skipped.length > 0
      ? `\n\n（已按上下文预算跳过 ${skipped.length} 个技能：${skipped.join('、')}。若需要用到的操作未被覆盖，请减少启用技能或精简技能正文。）`
      : ''
  return header + body + note
}

function buildSkillBlock(s: SkillContent): string {
  const lines = [`## 技能：${s.name.trim()}`]
  if ((s.description || '').trim()) lines.push(s.description.trim())
  lines.push('', s.content.trim())
  return lines.join('\n')
}