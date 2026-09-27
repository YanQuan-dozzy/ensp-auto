/**
 * 会话标题（v2.8，P4）—— 归一化 + 提示词 + 设置项。
 *
 * 对标 `deepseek-harness` 的 `packages/session/session-title`：
 * 那边的做法是「首条人类消息触发一次**独立**的小请求，让模型给一个短标题」，
 * 并把它与「确定性兜底（取首条消息前若干字）」分成两条路 —— 模型失败时
 * 标题仍然可用，只是退化成截断而已。
 *
 * 为什么值得单独立一层（而不是塞进 ReactRuntime 里）：
 * ① 归一化必须是**纯函数**且被单测钉死 —— 模型能吐出引号、Markdown、换行、
 *    甚至 ANSI 转义序列（它可能把回显里的彩色文本一起抄进来），标题里出现这些
 *    会污染会话列表的排版；这些坑不写用例就会反复踩。
 * ② 标题是**会被持久化**的用户可见文本，跨会话保留；它的清洗口径必须一处定义。
 *
 * 与 dsh 的差异（有意为之）：
 * - dsh 用 UTF-8 **字节**预算，这里用**字符**预算 —— 标题只给界面看，
 *   30 个中文字符与 30 个英文单词在视觉上已经等价，用字节反而让中文标题莫名变短。
 * - 不引它的 provider/cordis 注册体系，只取「归一化 + 提示词 + 自动节奏」这三点。
 */

import type { ModelProfile } from './types'

// ————————————————————— 常量 —————————————————————

/** 标题字符上限（中文场景下 30 字已足够表达一个实验目标） */
export const TITLE_MAX_CHARS = 30

/** 自动生成标题时的目标长度（提示词里告诉模型「大约多少字」） */
export const TITLE_TARGET_CHARS = 16

/** 兜底标题（无 AI、或 AI 失败时）从首条消息取多少字符 */
export const TITLE_FALLBACK_CHARS = 24

/** 标题请求的输出上限：标题很短，200 token 足够，别把它变成一次昂贵请求 */
export const TITLE_MAX_TOKENS = 200

/** 摘要/标题这类辅助请求的默认超时 —— 它只是锦上添花，不能拖住主流程 */
export const DEFAULT_TITLE_TIMEOUT_MS = 15_000
export const TITLE_TIMEOUT_BOUNDS = { min: 3_000, max: 60_000 } as const

// ————————————————————— 归一化（纯函数） —————————————————————

/** OSC 序列（含未终止的尾部）：`ESC ] … BEL/ST` */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
/** CSI 序列（颜色码等）：`ESC [ … 最终字节` */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** 其余两字节 ESC 序列 */
const ESC_SEQUENCE = /\u001B[@-_]/gu
/** 非空白 C0/C1 控制字符 */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
/** 方向/不可见控制字符：能让**显示出来的**标题与实际内容不符 */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu
/** 成对的包裹符号：模型很爱给标题加书名号/引号，界面上会显得脏 */
const WRAPPERS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^"/, /"$/],
  [/^'/, /'$/],
  [/^“/, /”$/],
  [/^‘/, /’$/],
  [/^《/, /》$/],
  [/^「/, /」$/],
  [/^【/, /】$/],
  [/^`+/, /`+$/],
  [/^\*+/, /\*+$/]
]
/**
 * **单侧**前缀（只有开头、没有对应结尾）。Markdown 标题 `## 标题` 是模型
 * 最常见的越界输出之一 —— 它没有结尾的 `##`，放进成对表里永远不会被削掉。
 * 单独一条正则处理，避免把 `#` 从成对表里挪出去后忘了补上。
 */
const LEADING_DECORATION = /^(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/

/**
 * 标题清洗：剥控制序列 → 压成单行 → 去掉包裹符号。
 *
 * 压成单行是必须的：标题在会话列表里是**单行**元素，模型偶尔会返回
 * 「第一行标题\n第二行解释」，不压扁的话列表里会出现半截被截断的换行符。
 */
export function cleanTitleText(input: string): string {
  let s = String(input ?? '')
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()

  // 去掉包裹符号与单侧前缀。**两件事必须放在同一个循环里**：
  // 模型会写 `## 「配置 VLAN」` —— 先跑成对表时开头是 `#` 对不上 `「`，
  // 削掉 `##` 后引号才露出来；分成两轮就会留下一层没削干净的符号。
  for (let guard = 0; guard < 6; guard++) {
    let changed = false
    for (const [open, close] of WRAPPERS) {
      if (open.test(s) && close.test(s) && s.length > 1) {
        s = s.replace(open, '').replace(close, '').trim()
        changed = true
      }
    }
    if (LEADING_DECORATION.test(s)) {
      s = s.replace(LEADING_DECORATION, '').trim()
      changed = true
    }
    if (!changed) break
  }
  // 模型常见的「标题：xxx」前缀
  s = s.replace(/^(?:标题|会话标题|title)\s*[:：]\s*/iu, '').trim()
  return s
}

/** 按**码点**截断（不切开代理对，避免把 emoji / 生僻字截成乱码） */
export function truncateCodePoints(input: string, maxChars: number): string {
  const limit = Math.max(1, Math.floor(maxChars))
  let count = 0
  let end = 0
  for (const ch of input) {
    if (count === limit) return input.slice(0, end)
    count += 1
    end += ch.length
  }
  return input
}

/** 归一化一个模型给出的标题：清洗 → 截断。可能返回空串（调用方须有兜底） */
export function normalizeTitle(input: string, maxChars = TITLE_MAX_CHARS): string {
  return truncateCodePoints(cleanTitleText(input), maxChars).trim()
}

/**
 * 确定性兜底标题：取首条用户消息的首行前若干字符。
 * 空消息返回空串（调用方决定用什么占位文案）。
 */
export function fallbackTitle(input: string, maxChars = TITLE_FALLBACK_CHARS): string {
  const one = cleanTitleText((input ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '')
  return truncateCodePoints(one, maxChars).trim()
}

/**
 * 判定「这个标题是否值得视为模型真的给了内容」。
 * 空串、纯标点、与兜底完全相同（说明模型只是把输入抄了回来）都算无效 ——
 * 后者若被接受，会出现「AI 标题 = 首条消息截断」的假象，用户以为 AI 没工作。
 */
export function isUsefulTitle(title: string, fallback: string): boolean {
  const t = title.trim()
  if (!t) return false
  // 至少含一个字母 / 数字 / 表意文字，纯符号不算标题
  if (!/[\p{L}\p{N}]/u.test(t)) return false
  return t !== fallback.trim()
}

// ————————————————————— 提示词 —————————————————————

/**
 * 标题生成的系统指令。
 *
 * 「不要引号、不要 Markdown、不要前缀、不要解释」这一串是必须的：
 * 模型在默认风格下几乎一定会给 `「OSPF 实验」` 或 `**标题：OSPF 实验**`，
 * 而本地清洗只能兜住常见形态 —— 与其在清洗里无限打补丁，不如在提示词里就要干净输出。
 */
export function titleSystemPrompt(targetChars = TITLE_TARGET_CHARS): string {
  return [
    '你是会话标题生成器。根据给定的人类指令，为这次网络实验会话起一个简短标题。',
    '只输出标题本身，一行纯文本，使用与指令相同的语言。',
    '不要引号、不要书名号、不要 Markdown、不要序号、不要「标题：」这类前缀，不要任何解释。',
    `长度约 ${targetChars} 个字（中文）或 ${targetChars} 个词（英文），上限 ${TITLE_MAX_CHARS} 字。`,
    '不要复述整条指令，要概括它要做的事。'
  ].join('\n')
}

/**
 * 把待概括的文本包成 JSON 数组 —— 与 dsh 的 frameMessages 同一理由：
 * 用户指令里可能有换行、引号、甚至是「请忽略上面的指令」这类注入尝试，
 * 用结构化的 JSON 包裹能明确边界，不让用户文本冒充提示词结构。
 */
export function buildTitleUserMessage(texts: readonly string[]): string {
  const items = texts.map((t) => truncateCodePoints(String(t ?? '').trim(), 600)).filter(Boolean)
  return `请为下面的人类指令生成会话标题：\n${JSON.stringify(items, null, 0)}`
}

// ————————————————————— 设置项 —————————————————————

/**
 * 会话标题设置。
 *
 * `enabled` 默认**开启**（v2.15 改）：标题停留在「首条消息截断」是用户实测
 * 最容易报告的体验问题（「AI 怎么不给会话起名」），而一次标题请求的成本
 * 极小（≤200 token、仅首轮/欠名时才发）。用户随时可以在设置里关掉。
 */
export interface TitleSettings {
  enabled: boolean
  /** 目标字数（提示词用） */
  targetChars: number
  /** 生成超时（毫秒）；超时即放弃，保留兜底标题 */
  timeoutMs: number
}

export const DEFAULT_TITLE_SETTINGS: TitleSettings = {
  enabled: true,
  targetChars: TITLE_TARGET_CHARS,
  timeoutMs: DEFAULT_TITLE_TIMEOUT_MS
}

export const TITLE_BOUNDS = {
  targetChars: { min: 4, max: TITLE_MAX_CHARS },
  timeoutMs: TITLE_TIMEOUT_BOUNDS
} as const

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

export function sanitizeTitleSettings(
  patch: unknown,
  base: TitleSettings = DEFAULT_TITLE_SETTINGS
): TitleSettings {
  const p = (patch ?? {}) as Partial<TitleSettings>
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    targetChars: clampInt(
      p.targetChars,
      TITLE_BOUNDS.targetChars.min,
      TITLE_BOUNDS.targetChars.max,
      base.targetChars
    ),
    timeoutMs: clampInt(
      p.timeoutMs,
      TITLE_BOUNDS.timeoutMs.min,
      TITLE_BOUNDS.timeoutMs.max,
      base.timeoutMs
    )
  }
}

/**
 * 该档案是否具备生成标题的条件。
 *
 * 只做「有没有模型名」这一条静态判断（界面用它来 disable 开关）——
 * 密钥是否存在是运行时的事（在 `generateTitle` 里失败即静默降级），
 * 把它塞进这里会让设置页在「密钥存在但模型名空」时给出误导性提示。
 */
export function canGenerateTitle(profile: ModelProfile | null | undefined): boolean {
  if (!profile) return false
  return Boolean(String(profile.model ?? '').trim())
}
