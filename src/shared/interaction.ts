/**
 * 模型 ↔ 用户的**轮内交互**契约（v2.7）。
 *
 * 两件事共用一份契约，因为它们的机制完全一样：模型发起 → 运行时就地暂停 →
 * 界面收集 → 决议回灌 → 任务继续。区别只在「谁在问」：
 * - `ask_user_question` 工具：模型自己缺参数/要做选择时问；
 * - 计划模式评审：运行时在方案产出后替用户问「批不批准」。
 *
 * 为什么不让模型「在文本里问一句然后结束这一轮」：那会丢掉整轮的现场
 * （已建立的连接、已收集的回显、快照上下文），用户答完得从头再说一遍。
 * 轮内暂停则答完就接着干。
 */

/** 选项上限：选项太多本身就说明这个问题没问清楚 */
export const MAX_QUESTION_OPTIONS = 4
/** 单次提问的问题数上限：一次问一堆等于把决策负担甩给用户 */
export const MAX_QUESTIONS_PER_REQUEST = 4

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionItem {
  /** 同一批问题内唯一；答案是 `qid → 文本` 的映射 */
  id: string
  question: string
  /** 短标签（界面上的小标题），可选 */
  header?: string
  /** 2..4 个选项；**空数组 = 纯自由文本问题** */
  options: QuestionOption[]
  /** 多选（默认单选） */
  multiSelect?: boolean
}

/**
 * 回答：`qid → 用户给的文本`。
 *
 * 多选以「、」连接（界面上点选的多个标签直接拼起来），自由文本原样带回 ——
 * 刻意不做「选项 id → 结构化值」的映射：模型要的就是一句人话，
 * 多一层映射只会多一处可能对不上的地方。
 */
export type QuestionAnswers = Record<string, string>

/** 计划的三个决议（与界面按钮文案一一对应） */
export const PLAN_APPROVE = '批准并执行'
export const PLAN_REVISE = '继续完善方案'
export const PLAN_STOP = '不执行，结束'

function toText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export type SanitizeQuestionsResult =
  | { ok: true; questions: QuestionItem[] }
  | { ok: false; error: string }

/**
 * 收敛模型给出的问题列表。
 *
 * 做**硬校验而不是静默修补**：问题结构不对时，模型得到的应该是「你哪里写错了」，
 * 而不是一个被悄悄改过的版本 —— 后者会让它以为用户看到了别的问题。
 */
export function sanitizeQuestions(raw: unknown): SanitizeQuestionsResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'questions 必须是非空数组' }
  }
  if (raw.length > MAX_QUESTIONS_PER_REQUEST) {
    return { ok: false, error: `一次最多问 ${MAX_QUESTIONS_PER_REQUEST} 个问题` }
  }
  const out: QuestionItem[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const q = (item ?? {}) as Record<string, unknown>
    const question = toText(q.question, 300)
    if (!question) return { ok: false, error: '每个问题都必须有 question 文本' }
    const id = toText(q.id, 40) || `q${out.length + 1}`
    if (seen.has(id)) return { ok: false, error: `问题 id 重复：${id}` }
    seen.add(id)
    const rawOptions = Array.isArray(q.options) ? q.options : []
    if (rawOptions.length > MAX_QUESTION_OPTIONS) {
      return { ok: false, error: `单个问题最多 ${MAX_QUESTION_OPTIONS} 个选项` }
    }
    const options: QuestionOption[] = []
    for (const o of rawOptions) {
      const opt = (o ?? {}) as Record<string, unknown>
      const label = toText(opt.label, 60)
      if (!label) continue
      const description = toText(opt.description, 200)
      options.push({ label, ...(description ? { description } : {}) })
    }
    // 恰好 1 个选项是「伪问题」（用户没得选），也判为写错
    if (options.length === 1) {
      return { ok: false, error: '选项要么不给（纯自由文本），要么给 2 个以上' }
    }
    out.push({
      id,
      question,
      ...(toText(q.header, 20) ? { header: toText(q.header, 20) } : {}),
      options,
      ...(q.multiSelect === true ? { multiSelect: true } : {})
    })
  }
  return { ok: true, questions: out }
}

/** 答案归一化：只保留问过的问题，值截断，空值丢弃 */
export function sanitizeAnswers(raw: unknown, questions: readonly QuestionItem[]): QuestionAnswers {
  const src = (raw ?? {}) as Record<string, unknown>
  const out: QuestionAnswers = {}
  for (const q of questions) {
    const v = toText(src[q.id], 2_000)
    if (v) out[q.id] = v
  }
  return out
}

/** 回答是否完整（每个问题都答了）。缺项不算完整，但**不阻止提交** —— 用户可能只想答一部分 */
export function unansweredQuestions(
  answers: QuestionAnswers,
  questions: readonly QuestionItem[]
): string[] {
  return questions.filter((q) => !answers[q.id]).map((q) => q.id)
}

// ————————————————————— 待办清单 —————————————————————

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
  /** 这条属于哪台设备（eNSP 场景里「改哪台」是必须写清的信息） */
  deviceId?: string
}

export const MAX_TODOS = 30
export const MAX_TODO_CONTENT = 200

const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed']

/**
 * 整表替换的清洗（`todo_write` 的语义就是「整表替换」，不是增量合并）。
 *
 * 为什么整表替换而不是 add/update/remove 三个动作：模型维护一个短列表的成本很低，
 * 而增量接口必须处理「改哪一条」的定位问题 —— 那正是模型最容易搞错的地方
 * （它会删错行、或者给两条一样的任务分别打状态）。
 */
export function sanitizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const out: TodoItem[] = []
  for (const item of raw) {
    if (out.length >= MAX_TODOS) break
    const t = (item ?? {}) as Record<string, unknown>
    const content = toText(t.content, MAX_TODO_CONTENT)
    if (!content) continue
    const status = TODO_STATUSES.includes(t.status as TodoStatus)
      ? (t.status as TodoStatus)
      : 'pending'
    const deviceId = toText(t.deviceId, 64)
    out.push({ content, status, ...(deviceId ? { deviceId } : {}) })
  }
  return out
}

export interface TodoProgress {
  total: number
  completed: number
  inProgress: number
  pending: number
  /** 0..1 */
  ratio: number
}

export function todoProgress(todos: readonly TodoItem[]): TodoProgress {
  const completed = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.filter((t) => t.status === 'in_progress').length
  const pending = todos.length - completed - inProgress
  return {
    total: todos.length,
    completed,
    inProgress,
    pending,
    ratio: todos.length === 0 ? 0 : completed / todos.length
  }
}

/** 给模型看的清单文本（也用于 system prompt 里的「当前任务清单」块） */
export function formatTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return ''
  const mark: Record<TodoStatus, string> = {
    pending: '[ ]',
    in_progress: '[~]',
    completed: '[x]'
  }
  return todos
    .map((t) => `${mark[t.status]} ${t.content}${t.deviceId ? `（${t.deviceId}）` : ''}`)
    .join('\n')
}

/** 给用户看的一句话进度 */
export function describeTodos(todos: readonly TodoItem[]): string {
  const p = todoProgress(todos)
  return `任务清单 ${p.completed}/${p.total} 已完成${p.inProgress > 0 ? `，${p.inProgress} 项进行中` : ''}`
}

/**
 * 注入 system prompt 的「当前任务清单」块（v2.7）。
 *
 * 为什么要进 system prompt 而不只是靠工具结果：清单要**跨任务持久**。
 * 用户重开一个会话继续干活时，模型必须知道上一段已经做到哪一步了 ——
 * 只靠上一轮的工具结果回显，那些回显其实还在消息里，但用户的记忆已经断了，
 * 模型很容易重新做一遍已完成的事（在设备上表现为「重复下发同一条配置」）。
 */
export function buildTodoPromptBlock(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return ''
  return (
    '\n\n# 当前任务清单（用户可见，跨轮次持续）\n\n' +
    formatTodos(todos) +
    '\n\n维护要求：每完成一步就调用 todo_write 整表更新（把该步标成 completed，' +
    '把下一步标成 in_progress）；不要重做已标 completed 的步骤。'
  )
}
