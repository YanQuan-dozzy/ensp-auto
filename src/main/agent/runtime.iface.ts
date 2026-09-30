import type { AgentEvent, GateDecision, RunInput, SessionNode, Settings } from '@shared/types'
import type { QuestionAnswers } from '@shared/interaction'
import type { ToolContext, ToolSpec } from '../tools/registry'
import type { TodoStore } from '../core/todo/store'
import type { SkillContent } from '../skills/prompt'

/**
 * AgentRuntime 抽象。
 *
 * 按「抽象接口 + real/mock 双实现」的交付习惯拆开：
 * - react.runtime.ts   生产实现（自研 ReAct 循环 + openai SDK）
 * - mock.runtime.ts    离线/测试实现（脚本回放，不依赖网络与设备）
 *
 * 之所以自研而不引 pi-agent-core：见 docs/ARCHITECTURE.md §2.2 的取证表。
 * 核心理由是工具循环与领域强耦合（闸门、快照、中断、轨迹都要长在循环里），
 * 套通用库反而要一路与它的抽象对抗。
 */

export interface AgentDeps {
  tools: readonly ToolSpec[]
  /** v1.3：已启用技能内容（注入 system prompt；缺省 = 无技能） */
  getSkills?: () => SkillContent[]
  /**
   * v1.5：活跃档案的自定义指令（设置「模型」页填的那段），注入 system prompt。
   *
   * 做成「取函数」而不是启动时快照：档案随时可切换/编辑，运行期取值才与设置页一致。
   * R53：这个字段曾经在最后一跳被漏传，导致用户写的指令从未进入任何一次请求。
   */
  getCustomInstructions?: () => string
  /** 每轮构建工具执行上下文（含闸门回调与中断信号） */
  buildContext: (signal: AbortSignal) => ToolContext
  getSettings: () => Settings
  /** v2.7：任务清单存储（`todo_write` 的出口；缺省时该工具返回 UNSUPPORTED） */
  todos?: TodoStore
  /**
   * v2.8：会话树（标题生成 + 断点续跑标记的出口）。
   *
   * 为什么必须给运行时：标题要在「本轮任务成功收尾之后」才生成，而那时
   * `drive()` 恰好知道本轮的 rootId 与是否首轮；宿主（services.startAgent）
   * 只负责转发事件，它不知道「现在是不是适合生成标题的时机」。
   * 缺省时整块标题功能关闭（外部 MCP 出口没有会话树）。
   */
  sessionTree?: SessionTreeLike
  /**
   * v2.14：把超大工具结果的**完整输出**归档到本地，返回可被 `read_attachment`
   * 读回的绝对路径；失败返回 `null`（运行时退回纯截断）。
   *
   * 为什么由宿主注入而不是运行时自己写文件：agent 层刻意不碰 fs（要能在 harness 里
   * 直接单测，见文件头「不依赖 Electron 与网络」），而且归档落在哪个目录是存储层的
   * 决定（附件根下的 `spills/`，见 `AttachmentStore#saveSpill`）。
   * 缺省 = 该出口不支持归档（如外部 MCP 出口），行为与 v2.13 完全一致。
   */
  spill?: (input: {
    rootId: string
    callId: string
    toolName: string
    text: string
  }) => Promise<string | null>
  /**
   * v2.15：**流外事件直发通道**。收尾阶段的标题生成是 fire-and-forget，等它
   * 跑完时本轮事件流早已 `close()`（push 进 closed 流会被 EventStream 静默
   * 丢弃），`title_updated` 必须经这个通道由宿主直接转发给渲染层。
   * 缺省（单测 / 无宿主）= 只 push 不直发，行为退回 v2.14。
   */
  emitEvent?: (event: AgentEvent) => void
  /**
   * v2.22（F17）：把受管目录里的图片读成模型可用的图片块（base64）。
   *
   * 为什么由宿主注入而不是运行时自己读：agent 层刻意不碰 fs（见文件头），
   * 而「只管目录内」这条沙箱口径属于存储层（`AttachmentStore.resolveReadable`），
   * 与 `read_attachment` 共用同一套边界。
   *
   * 缺省 = 该出口不支持图片（如外部 MCP 出口）：图片附件会退化为文字说明，
   * 绝不静默丢掉 —— 模型必须知道「用户给了图但没进来」。
   */
  readImageParts?: (images: readonly ImageRequestRef[]) => Promise<ImagePartResult[]>
}

/** v2.22（F17）：要点读的图片（id 用于把失败原因回填到提示词） */
export interface ImageRequestRef {
  id: string
  /** 受管目录内的绝对路径 */
  path: string
}

/**
 * v2.22（F17）：一张图片的读取结果。
 *
 * 是「扁平结果」而不是抛异常：同一轮里可能有多张图，一张挂了不该把别的带下去
 * （用户一次拖三张截图是常态）。
 */
export interface ImagePartResult {
  id: string
  ok: boolean
  /** base64（不含 data: 前缀） */
  data?: string
  mimeType?: string
  /** 失败原因（中文，可直接进提示词） */
  error?: string
}

/**
 * v2.8：运行时需要的会话树最小面（结构化类型，避免 agent 层直接 import
 * `core/session-tree/store` 而把它拖进 harness 的依赖图）。
 */
export interface SessionTreeLike {
  getTree(rootId: string): SessionNode[]
  setAutoTitle(rootId: string, title: string, aiTitled?: boolean): boolean
  titleEditable(rootId: string): boolean
  /** v2.15：标题未被用户钉住、且 AI 尚未成功起过名（是否还欠一个 AI 标题） */
  needsAutoTitle(rootId: string): boolean
  markSettled(rootId: string, doneNodeId: string): void
}

export interface AgentRuntime {
  run(input: RunInput): AsyncIterable<AgentEvent>
  resolveGate(gateId: string, decision: GateDecision): void
  /**
   * v2.7：裁决一次结构化提问（`ask_user_question` 与计划模式评审共用）。
   * 传 null 表示取消（用户关掉卡片 / 任务被中止），调用方会退回「按最合理假设继续」。
   */
  resolveQuestion?(questionId: string, answers: QuestionAnswers | null): void
  /** v0.4：执行中插话。返回是否接受（仅 running 时入队） */
  enqueue?(text: string): boolean
  /** v0.4：取走尚未消费的排队输入（任务结束收尾时由宿主调用，避免丢消息） */
  takePendingInput?(): string[]
}

/**
 * 把「推」模型的事件源转成「拉」模型的 AsyncIterable。
 *
 * 为什么需要它：Agent 循环是推式的（模型流式吐 token、工具回调触发事件），
 * 而 IPC 与调用方是拉式的（逐个消费事件）。中间的缓冲必须有，否则
 * 事件会在消费者准备好之前到达而丢失。
 */
export class EventStream<T> implements AsyncIterable<T> {
  private buffer: T[] = []
  private waiters: Array<(r: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
      return
    }
    this.buffer.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // 注意：这里**不能**清 buffer。事件流的契约是「缓冲里的先发完、再报 done」
    // （见 next()：先 shift，再看 closed）—— `finish()` 是先 push({done}) 再
    // close() 的，那条 done 往往还躺在缓冲里。在 close() 里清空会把每轮任务的
    // 收尾事件（error / done）直接吞掉，表现为「任务卡在运行中」。
    // 释放改在「缓冲真的被读空 / 消费者放弃」之后做，见 next() 与 return()。
    for (const waiter of this.waiters.splice(0, this.waiters.length)) {
      waiter({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift()
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false })
        if (this.closed) {
          // M2（PERF-MEM-REVIEW-2026-09-29 §4.1）：缓冲里是 `tool_end.raw`
          // ——设备原始回显，单条上限 512KB（DEFAULT_TELNET_OPTIONS.maxBytes）。
          // 抛错 / 中止路径上常有大量未被消费的 raw 挂在这里（一条长实验几十次
          //「读配置」就是几十 MB）。消费完毕后没有理由继续持有，把数组缩回空壳，
          // 元素随之可回收。放在这里而不是 close()：此刻缓冲已确认读空。
          if (this.buffer.length > 0) this.buffer.length = 0
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
      return: (): Promise<IteratorResult<T>> => {
        // 消费者提前 break（中止后不再收事件）：缓冲直接丢弃
        this.buffer.length = 0
        this.close()
        return Promise.resolve({ value: undefined as never, done: true })
      }
    }
  }
}

/** 工具名 → 摘要文本，供执行轨迹展示 */
export function summarizeToolCall(
  spec: ToolSpec | undefined,
  args: unknown,
  result: { ok: boolean; data?: unknown },
  fallbackName: string
): string {
  if (!spec) return fallbackName
  try {
    return spec.summarize
      ? spec.summarize(args as never, result as never)
      : `${spec.name}${result.ok ? '' : '（失败）'}`
  } catch {
    return spec.name
  }
}

/**
 * v2.9：结构化结果的**尺寸闸门**。
 *
 * 决定一次工具结果能不能作为 `data` 送进事件流（进而进渲染层做卡片）。
 *
 * 为什么必须有这道闸门：像 `get_topology` / `save_config_snapshot` 这类工具的
 * `data` 可能是一整份配置或整张拓扑，把它们塞进每条 `tool_end` 事件会让
 * 事件流、会话树、渲染层内存同时膨胀 —— 而这些内容**原始回显里本来就有**，
 * 卡片并不需要它们。这里只放行小对象（快照 diff 的 added/removed 那种量级）。
 *
 * 序列化失败（循环引用等）一律不放行：宁可没有卡片，也不能让事件流炸掉。
 */
export function smallToolData(
  result: { ok: boolean; data?: unknown },
  maxChars = 8000
): unknown {
  if (!result.ok || result.data === undefined || result.data === null) return undefined
  const d = result.data
  // 只放行「结构化的聚合结果」：对象/数组。字符串与数字卡片没意义（summary 已覆盖）
  if (typeof d !== 'object') return undefined
  // 空数组 / 空对象没有任何可展示的内容 —— 放行只会在界面上留一个空壳卡
  if (Array.isArray(d) ? d.length === 0 : Object.keys(d as object).length === 0) return undefined
  let size: number
  try {
    size = JSON.stringify(d)?.length ?? 0
  } catch {
    return undefined
  }
  if (size === 0 || size > maxChars) return undefined
  return d
}

/** H（v2.14）：可回放卡片数据的体积上限（字符）。比 `smallToolData` 更紧 —— 它要落盘 */
export const CARD_META_MAX_CHARS = 4000

/**
 * H（v2.14）：求一次工具调用的**可回放卡片数据**（`ToolSpec.presentationMeta` 的出口）。
 *
 * 为什么要有这一层兜底，而不是在运行时直接 `spec.presentationMeta?.(...)`：
 * - **绝不抛**。投影器自己写错时只丢卡片数据，不能把这一轮工具调用带下去
 *   （卡片是展示，工具调用才是正事）；
 * - **体积闸门 + 只放行 JSON 可序列化的值**。这份数据会进 `tool_end` 并落进会话树的
 *   jsonl，而树在重命名 / 收尾 / 书签时会**整份重写** —— 无上限的卡片数据会放大写放大。
 *   超限一律**整块丢弃**（不是截断成半个对象：半个卡片比没有卡片更容易误导）；
 * - **缺省 = 不落盘**（返回 undefined）。所以它必须由工具显式声明 —— 本仓绝大多数
 *   工具的 `data` 只是给当次界面看的，回放时不需要。
 */
export function cardMetaOf(
  spec: ToolSpec | undefined,
  args: unknown,
  result: { ok: boolean; data?: unknown },
  maxChars = CARD_META_MAX_CHARS
): unknown {
  const project = spec?.presentationMeta
  if (!project) return undefined
  let value: unknown
  try {
    value = project(args as never, result as never)
  } catch {
    return undefined
  }
  if (value === undefined || value === null) return undefined
  let size: number
  try {
    size = JSON.stringify(value)?.length ?? 0
  } catch {
    return undefined
  }
  if (size === 0 || size > maxChars) return undefined
  return value
}

/**
 * v2.22（F17）：工具结果里「随本结果附一张图片」的**约定载荷**。
 *
 * 为什么是约定而不是给运行时特判工具名：运行时不该知道 `read_image` 的存在 ——
 * 它只认一条通用规则「结果里带 `data.image` 就要把那张图附上去」。
 * 于是将来任何工具（截屏、导出图表、抓包预览）都能复用同一条通道，
 * 也不必在循环里堆 `if (name === 'read_image')`。
 *
 * 结构非法（路径为空/非字符串）一律返回 undefined：宁可不附图，也不能让
 * 一个写错的工具把整轮请求带下去。
 */
export interface ToolImageRef {
  path: string
  name?: string
  mimeType?: string
  width?: number
  height?: number
  bytes?: number
}

export function toolImageRef(result: { ok: boolean; data?: unknown }): ToolImageRef | undefined {
  if (!result.ok) return undefined
  const data = result.data as { image?: unknown } | null | undefined
  const img = data?.image as Record<string, unknown> | null | undefined
  if (!img || typeof img !== 'object') return undefined
  const p = img.path
  if (typeof p !== 'string' || p.trim().length === 0) return undefined
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  return {
    path: p,
    ...(typeof img.name === 'string' ? { name: img.name } : {}),
    ...(typeof img.mimeType === 'string' ? { mimeType: img.mimeType } : {}),
    ...(num(img.width) !== undefined ? { width: num(img.width)! } : {}),
    ...(num(img.height) !== undefined ? { height: num(img.height)! } : {}),
    ...(num(img.bytes) !== undefined ? { bytes: num(img.bytes)! } : {})
  }
}
