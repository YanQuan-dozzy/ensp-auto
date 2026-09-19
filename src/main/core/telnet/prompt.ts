import type { PromptInfo, ViewKind } from '@shared/types'
import { PROMPT_REJECT_RE, PROMPT_TAIL_RE, VIEW_KEYWORDS } from './patterns'

/**
 * 提示符解析与视图推断。
 *
 * 这是通信层最有价值的产出：提示符直接暴露当前视图，
 * 代理因此知道「我现在在系统视图还是接口视图」，而不需要猜。
 *
 * 防误判靠两道关：
 * 1. 提示符内容不得含空白与常见标点（挡掉输出正文里的 [OK] 之类）
 * 2. 若已知宿主名，要求解析出的宿主名完全一致
 */

interface ViewSplit {
  host: string
  suffix: string
  view: ViewKind | null
  uncommitted: boolean
}

/** 从括号内容中切出宿主名与视图后缀 */
export function extractView(rawContent: string): ViewSplit {
  const uncommitted = rawContent.startsWith('~')
  const body = uncommitted ? rawContent.slice(1) : rawContent

  for (const kw of VIEW_KEYWORDS) {
    const m = kw.re.exec(body)
    if (!m) continue
    const host = body.slice(0, m.index).replace(/-+$/, '')
    const suffix = body.slice(m.index).replace(/^-+/, '')
    return { host, suffix, view: kw.view as ViewKind, uncommitted }
  }

  return { host: body, suffix: '', view: null, uncommitted }
}

export interface PromptMatch {
  info: PromptInfo
  /** 匹配起点在缓冲区中的下标（用于切掉尾部提示符） */
  start: number
}

export function matchPromptTail(tail: string, expectedHost?: string): PromptMatch | null {
  const m = PROMPT_TAIL_RE.exec(tail)
  if (!m || m.index === undefined) return null

  const open = m[1]!
  const rawContent = m[2]!
  const close = m[3]!

  // 括号必须配对
  if (open === '<' && close !== '>') return null
  if (open === '[' && close !== ']') return null

  // 含空白或常见标点的内容基本可断定是输出正文
  if (PROMPT_REJECT_RE.test(rawContent)) return null

  const split = extractView(rawContent)
  if (!split.host) return null

  // 已知宿主名时做强约束，这是挡掉 [OK] / [ERROR] 之类误判的关键
  if (expectedHost && split.host !== expectedHost) return null

  const view: ViewKind =
    open === '<' ? 'user' : (split.view ?? 'system')

  const info: PromptInfo = {
    raw: `${open}${rawContent}${close}`,
    host: split.host,
    suffix: split.suffix,
    view,
    uncommitted: split.uncommitted
  }

  return { info, start: m.index }
}

/**
 * 从缓冲区尾部切掉提示符，返回主体与提示符信息。
 * 主体用于 clean 字段，提示符单独放在 prompt 字段 —— 上层看到的信息更干净。
 */
export function splitTrailingPrompt(
  text: string,
  expectedHost?: string
): { body: string; prompt: PromptInfo | null } {
  const match = matchPromptTail(text, expectedHost)
  if (!match) return { body: text, prompt: null }
  return { body: text.slice(0, match.start), prompt: match.info }
}

const VIEW_LABELS: Record<ViewKind, string> = {
  user: '用户视图',
  system: '系统视图',
  interface: '接口视图',
  vlan: 'VLAN 视图',
  ospf: 'OSPF 视图',
  acl: 'ACL 视图',
  other: '其他视图'
}

export function viewLabel(view: ViewKind): string {
  return VIEW_LABELS[view]
}
