import {
  describeTodos,
  formatTodos,
  sanitizeQuestions,
  type QuestionItem
} from '@shared/interaction'
import { fail, ok, Type, type ToolSpec } from './registry'

/**
 * 交互类工具（v2.7）：结构化提问 + 可见任务清单。
 *
 * 这两个工具都不碰设备，scope 一律 `local`、`risk: 'read'`，
 * 并且**不带 `concurrencySafe`**：它们会就地暂停等待用户（提问）或改写共享状态（清单），
 * 与「并行执行只读调用」的前提冲突。
 */

const questionOptionSchema = Type.Object(
  {
    label: Type.String({ description: '选项文案，简短（≤ 20 字），如「用 /30 掩码」' }),
    description: Type.Optional(Type.String({ description: '这个选项意味着什么（可选）' }))
  },
  { additionalProperties: false }
)

const questionSchema = Type.Object(
  {
    id: Type.String({ description: '问题标识，答案按它回传，如 "mask"' }),
    question: Type.String({ description: '要问用户的完整问题（一句话说清缺什么）' }),
    header: Type.Optional(Type.String({ description: '短标题，如「掩码」' })),
    options: Type.Array(questionOptionSchema, {
      description: '2~4 个可选项；留空数组表示这题要用户自由输入'
    }),
    multiSelect: Type.Optional(Type.Boolean({ description: '是否允许多选（默认单选）' }))
  },
  { additionalProperties: false }
)

export const askUserQuestion: ToolSpec<{ questions: QuestionItem[] }> = {
  name: 'ask_user_question',
  description:
    '【只在真的需要用户决定时调用】暂停当前任务，向用户结构化提问：给出 2~4 个选项，' +
    '用户也可以自由输入。用于「缺一个只有用户才知道的参数」（网段/掩码/VLAN ID/用哪台设备/' +
    '是否保留现场）以及「有多种合理做法需要用户拍板」的情况。' +
    '答完会拿到回答并**继续当前任务**（连接、回显、快照都在）。' +
    '不要用它问「确认是否继续」这类废话，也不要问能从设备上查到的东西（那些用只读命令查）。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object({ questions: Type.Array(questionSchema) }, { additionalProperties: false }),
  summarize: (_args, result) => {
    const d = result.data as { answers?: Record<string, string> } | undefined
    const n = d?.answers ? Object.keys(d.answers).length : 0
    return n > 0 ? `用户已回答 ${n} 个问题` : '提问未获回答'
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const parsed = sanitizeQuestions(args?.questions)
    if (!parsed.ok) return fail('BAD_PARAM', `提问格式不合法：${parsed.error}`, { ms: Date.now() - t0 })
    if (!ctx.askUser) {
      // 对外 MCP 出口没有提问通道：如实告诉模型「这条路走不通」，而不是静默返回空答案
      return fail(
        'UNSUPPORTED',
        '当前运行环境没有提问通道（例如通过 MCP 被外部客户端调用时）。' +
          '请改用最合理的默认做法并在结论里说明你假设了什么，或直接结束任务让用户补充。',
        { ms: Date.now() - t0 }
      )
    }
    if (ctx.signal?.aborted) return fail('ABORTED', '任务已中止，提问未发出', { ms: Date.now() - t0 })

    const answers = await ctx.askUser({ questions: parsed.questions, source: 'tool' })
    if (!answers) {
      return fail(
        'QUESTION_CANCELLED',
        '用户取消了本次提问（或任务被中止）。请基于最合理的假设继续，并在结论里写明你的假设。',
        { ms: Date.now() - t0 }
      )
    }
    return ok({ answers } as never, { ms: Date.now() - t0 })
  }
}

const todoSchema = Type.Object(
  {
    content: Type.String({ description: '一步具体动作，如「在 SW1 上创建 VLAN 10 并把 GE0/0/1 加入」' }),
    status: Type.String({
      description: 'pending（未开始）/ in_progress（进行中）/ completed（已完成）'
    }),
    deviceId: Type.Optional(Type.String({ description: '这一步针对哪台设备（可选）' }))
  },
  { additionalProperties: false }
)

export const todoWrite: ToolSpec<{ todos: Array<{ content: string; status: string; deviceId?: string }> }> =
  {
    name: 'todo_write',
    description:
      '【多步任务必用】维护一份用户可见的任务清单：把工作拆成具体步骤写进来，' +
      '开始某步时把它标成 in_progress，做完标成 completed。**每次调用整表替换**（不是增量改），' +
      '所以每次都要把完整的清单发过来。清单跨轮次、跨重新打开的会话持续存在，用户能实时看到进度。' +
      '单步就能完成的小事不必用它。',
    risk: 'read',
    scope: 'local',
    schema: Type.Object({ todos: Type.Array(todoSchema) }, { additionalProperties: false }),
    summarize: (_args, result) => {
      const d = result.data as { todos?: unknown[] } | undefined
      return d?.todos ? `任务清单已更新（${d.todos.length} 项）` : '任务清单已更新'
    },
    handler: async (args, ctx) => {
      const t0 = Date.now()
      if (!ctx.todos || !ctx.todoOwnerId) {
        return fail(
          'UNSUPPORTED',
          '当前运行环境没有可持久化的任务清单（例如通过 MCP 被外部客户端调用时）。' +
            '请直接在回答里用 Markdown 列表说明步骤。',
          { ms: Date.now() - t0 }
        )
      }
      const todos = ctx.todos.set(ctx.todoOwnerId, args?.todos)
      // 只返回清单本身：模型每次整表发过来，回显一份带编号的版本便于它在下一轮引用
      return ok(
        {
          todos,
          progress: describeTodos(todos),
          rendered: formatTodos(todos)
        } as never,
        { ms: Date.now() - t0 }
      )
    }
  }
