/**
 * 消息流切段（v2.9，P5）—— 纯函数，供 `AgentPanel` 的渲染与单测共用。
 *
 * 为什么从 `AgentPanel.tsx` 里搬出来：
 * ① 流式输出期间每来一个 delta 就重算一遍「哪些消息该并成一组」，
 *    这段逻辑原本写在 JSX 的 IIFE 里，**没法 memo、也没法单测**；
 * ② 分组是一个纯粹的「列表 → 列表」变换，天然属于这里。
 *
 * 关于 memo 能不能生效（这是本次优化的关键，别改坏）：
 * React 的 memo 是**逐元素**比较的 —— `segs.map(...)` 出来的每个元素
 * 只有在其 `seg` 引用不变时才会跳过重渲染。所以 `groupMessages` 必须
 * 做到「前缀稳定」：历史消息没变时，前面那些 segment 必须返回**同一个对象**。
 * 因此实现里维护了一个 `prev` 数组做逐项复用（见 `groupMessages` 的 `reuse`），
 * 而不是每次 new 一批新对象 —— 后者会让整条消息流在流式期间全量重渲染。
 */
import type { UiMessage } from '@/stores/storeUtil'

export type ToolMsg = Extract<UiMessage, { kind: 'tool' }>

/** 连续工具调用合并成的一组 */
export interface ToolGroupSegment {
  kind: 'toolGroup'
  key: string
  items: ToolMsg[]
}

export type Segment = Exclude<UiMessage, { kind: 'tool' }> | ToolGroupSegment

/**
 * 消息流切段：把**连续**出现的工具调用合并成一组，整组可折叠；
 * 中间的思考 / 计划等消息会把它们打断成多个组。
 *
 * @param prev 上一次的分段结果。传入它可以让「未变化的前缀」复用同一个
 *   segment 对象，配合 `React.memo` 让已完成的部分不再重渲染。
 *   只传自己（不传 prev）也能正确工作，只是失去这层优化。
 */
export function groupMessages(list: UiMessage[], prev?: Segment[]): Segment[] {
  const out: Segment[] = []
  let buf: ToolMsg[] = []
  /** 按 key 找上一轮的同名 segment，找到则复用（引用相等 → memo 生效） */
  const prevByKey = new Map<string, Segment>()
  if (prev) for (const s of prev) prevByKey.set(segmentKey(s), s)

  const reuse = (seg: Segment): Segment => {
    const old = prevByKey.get(segmentKey(seg))
    if (old && sameSegment(old, seg)) return old
    return seg
  }

  const flush = (): void => {
    if (buf.length === 0) return
    const seg: ToolGroupSegment = { kind: 'toolGroup', key: `tg-${buf[0]!.id}`, items: buf }
    out.push(reuse(seg))
    buf = []
  }
  for (const m of list) {
    if (m.kind === 'tool') {
      buf.push(m)
    } else {
      flush()
      out.push(reuse(m))
    }
  }
  flush()
  return out
}

/** segment 的稳定标识：用于在上一轮结果里找回同一条 */
export function segmentKey(s: Segment): string {
  return s.kind === 'toolGroup' ? s.key : s.id
}

/**
 * 判断两个同 key 的 segment 是否「内容未变」。
 *
 * 工具组必须逐项比较：一个组里的工具卡片会从 `running` 变成 `ok`，
 * 而 key（`tg-<首个工具 id>`）在整组生命周期内是不变的 ——
 * 只比 key 会把「正在执行」的旧快照一直复用下去，界面永远停在转圈。
 */
function sameSegment(a: Segment, b: Segment): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'toolGroup' && b.kind === 'toolGroup') {
    if (a.items.length !== b.items.length) return false
    for (let i = 0; i < a.items.length; i++) {
      if (a.items[i] !== b.items[i]) return false
    }
    return true
  }
  return a === b
}

/**
 * 该消息是否「有可展示的内容」。
 *
 * 用来丢掉空壳：流式刚开始时会先落一条空的 assistant / thinking 消息，
 * 若照常渲染就是一个没有任何文字的步骤头 —— 视觉上像卡住了。
 */
export function hasRenderableContent(m: UiMessage): boolean {
  switch (m.kind) {
    case 'assistant':
    case 'thinking':
      return m.text.trim().length > 0
    case 'plan':
      return m.steps.length > 0
    case 'tool':
      return true
    case 'finish':
      return true
    case 'system':
      return m.text.trim().length > 0
    case 'user':
      return true
    default:
      return true
  }
}

/** 过滤掉空壳消息（保留工具与收尾卡这类「无文本但有信息」的） */
export function dropEmptyMessages(list: UiMessage[]): UiMessage[] {
  return list.filter(hasRenderableContent)
}

// ————————————————————— 本轮收尾锚点（v2.13） —————————————————————

/**
 * 一轮任务的收尾锚点（纯函数，供 `AgentPanel` 的渲染与单测共用）。
 *
 * 为什么不能按位置取「最后一条 assistant」：模型在一轮里会反复说话
 * （「我先看一下设备…」「接下来导出报告…」），这些是**过程中的日常信息**；
 * 真正的回答是「这一轮最后一次说话、且之后再没有工具调用」的那条。
 * 只按位置判定会把最后一条日常信息当成整轮的回答，并在它下面挂上
 * 「已完成 / 用量」的收尾行 —— 看着就像任务在那里结束了。
 *
 * 同理，收尾卡（`finish`）也**只认当前轮的那一张**：早先轮次的收尾卡
 * 若被拿来当本轮的结果，标注的耗时/用量/结束原因全对不上。
 */
export interface TurnBoundary {
  /** 可作为「回复」的 assistant 段下标；-1 = 本轮没有合格回答 */
  replyIdx: number
  /** 当前轮 `finish` 段的下标；-1 = 本轮尚未收尾（仍在执行 / 只有历史回溯） */
  tailIdx: number
}

/**
 * 判定当前轮的收尾锚点。
 *
 * 当前轮 = 最后一条 `user` 段之后。执行中插话只追加一条系统提示、不追加 user 段
 * （见 `agentActions.send`），所以这个边界不会被「排队中的下一条指令」提前切断。
 *
 * 判定规则（从尾部倒着看，遇到的第一个**定性段**说了算）：
 * - `finish`：记下收尾卡下标，继续往前找回答；
 * - `thinking` / `plan` / `system`：过程性内容，既不构成回答也不打断判定；
 * - `assistant`（有正文）：它是回答 —— 即本轮最后一次说话之后再没有工具调用；
 * - 工具组 / 空壳 assistant：本轮还没结束，没有可称为「回复」的内容。
 */
export function resolveTurnBoundary(segments: Segment[]): TurnBoundary {
  let start = 0
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]!.kind === 'user') {
      start = i + 1
      break
    }
  }
  let tailIdx = -1
  for (let i = segments.length - 1; i >= start; i--) {
    const seg = segments[i]!
    if (seg.kind === 'finish') {
      // 同一轮只会有一张收尾卡；倒着扫先遇到的就是最后那张
      if (tailIdx < 0) tailIdx = i
      continue
    }
    if (seg.kind === 'thinking' || seg.kind === 'plan' || seg.kind === 'system') continue
    return { replyIdx: seg.kind === 'assistant' && seg.text.trim() !== '' ? i : -1, tailIdx }
  }
  return { replyIdx: -1, tailIdx }
}

// ————————————————————— 尾随思考前移（v2.16） —————————————————————

/**
 * 把挂在「最终回答之后」的思考段搬回回答前面（纯展示层的顺序归一）。
 *
 * 为什么会有这种段：部分 OpenAI 兼容端点（实测 deepseek 聚合通道）会在**正文
 * 输出完之后**才把 reasoning_content 吐出来 —— thinking 事件在 text 全部下发完
 * 才到，界面（以及按事件顺序落盘的会话树）就成了「思考」吊在最终回答（连着
 * 已完结收尾行）的后面，看着像任务结束后又冒出一句没头没尾的话。
 *
 * 规则：
 * - 从尾部先剥掉**至多一张**收尾卡（finish）—— 实时流里 done 的收尾卡是最后
 *   追加的（顺序为 回答→思考→收尾卡），不剥它就永远扫不到后面的思考段；
 * - 再收集**连续**的 thinking 段；
 * - 允许隔着一张本轮收尾卡（finish）—— 历史回放里合成的收尾卡可能落在
 *   思考之前，两种形态都要能对上；
 * - 再往前必须是有正文的 assistant（本轮回答）→ 这批思考整体搬到它**前面**。
 * 其余形态（思考挂在 user / 工具组 / 空壳后面）一律不动 —— 那些位置本来合法。
 *
 * 为什么放在渲染管线而不是 store / 落盘层：会话树是只追加结构，已落盘的顺序
 * 改不了；渲染层归一能同时覆盖「实时流」与「历史回溯」两条路。挪动只跨角色、
 * 不改变 thinking 之间的相对顺序，`matchTreeNodes` 的按角色计数映射不受影响。
 */
export function hoistTrailingThinking(list: UiMessage[]): UiMessage[] {
  let end = list.length
  // 实时流：done 的收尾卡最后追加（回答→思考→收尾卡），先剥掉再找思考段
  let tailFinish: UiMessage | undefined
  if (end > 0 && list[end - 1]!.kind === 'finish') {
    tailFinish = list[end - 1]
    end--
  }
  let runStart = end
  while (runStart > 0 && list[runStart - 1]!.kind === 'thinking') runStart--
  if (runStart === end) return list // 末尾没有 thinking，原样返回（引用稳定）
  let anchor = runStart - 1
  if (anchor >= 0 && list[anchor]!.kind === 'finish') anchor-- // 隔一张收尾卡
  const m = anchor >= 0 ? list[anchor] : undefined
  if (!m || m.kind !== 'assistant' || m.text.trim() === '') return list
  const moved = [...list.slice(0, anchor), ...list.slice(runStart, end), ...list.slice(anchor, runStart)]
  return tailFinish ? [...moved, tailFinish] : moved
}

// ————————————————————— 长回显二级折叠（v2.9） —————————————————————

/** 原始回显超过这么多行就默认收起尾部（设备配置动辄几百行） */
export const RAW_COLLAPSE_LINES = 24

/** 二级折叠的预计算：头 N 行 + 剩余行数 + 是否需要折叠 */
export interface RawCollapse {
  /** 应当展示的行 */
  visible: string[]
  /** 被收起未展示的行数（0 = 不需要折叠） */
  hiddenCount: number
  collapses: boolean
}

/**
 * 按行切分并决定是否折叠。
 *
 * 注意按 **行** 而不是按字符截断：设备回显的行是有语义的
 * （一条 `interface` 段、一行 `ip address`），在字符中间砍掉会给出
 * 一个看起来语法错误的半截命令，反而更容易误导人。
 *
 * @param keepLines 保留的行数，默认 `RAW_COLLAPSE_LINES`
 */
export function planRawCollapse(raw: string, keepLines = RAW_COLLAPSE_LINES): RawCollapse {
  const lines = String(raw ?? '').split('\n')
  const keep = Math.max(1, Math.floor(keepLines))
  if (lines.length <= keep) return { visible: lines, hiddenCount: 0, collapses: false }
  return {
    visible: lines.slice(0, keep),
    hiddenCount: lines.length - keep,
    collapses: true
  }
}

// ————————————————————— 全局折叠控制（v2.9） —————————————————————

/**
 * 一次「全部折叠 / 全部展开」信号。
 *
 * 为什么用上下文而不是把 open 提升到 store：折叠是**纯视图状态**，
 * 且每个块的默认值还依赖自身内容（失败的工具卡默认展开）——
 * 提升到 store 会把「渲染偏好」和「会话数据」混在一起，还要改十几个组件。
 *
 * 为什么带 `epoch` 而不是只传 `open`：用户可能反复点同一个按钮。
 * 若只传 `{ open: true }`，用户在两轮点击之间手动收起某个块，
 * 再点「全部展开」时值没变 → effect 不触发 → 那个块不会被展开，看起来像失灵。
 */
export interface CollapseSignal {
  epoch: number
  open: boolean
}

// ————————————————————— 按轮切分（v2.19） —————————————————————

/**
 * 一轮任务的段切片。
 *
 * 为什么要按轮切：任务收尾后，这一轮的**全部过程**（日常信息 / 思考 / 工具组 / 计划）
 * 要整体收成一行 —— 只留「收尾行 + 最终回答」，点收尾行才把过程铺开。
 * 要做到这一点，渲染层必须先知道「哪些段属于同一轮」，而段的边界就是 user 段。
 */
export interface TurnSlice {
  /**
   * 稳定 key：取该轮 user 段的 id。会话树节点 id 唯一，且回溯/续写前缀稳定，
   * 于是「这一轮是否被点开」不会被相邻轮串档 —— 也不能用下标（回溯会整体前移）。
   */
  key: string
  /** 该轮的指令段；历史回溯 / 续写（开头没有 user 段）的兜底轮为 undefined */
  user?: Extract<Segment, { kind: 'user' }>
  /** user 之后、下一轮 user 之前的全部段：过程 + 回答 + 收尾卡，保持事件顺序 */
  body: Segment[]
}

/**
 * 按 user 段把消息流切成若干轮（纯函数）。
 *
 * 开头没有 user 段的自成一"兜底轮"（历史回溯到中途、单会话续写），
 * key 由首段导出 —— 同样稳定，不依赖位置。
 * 轮内「谁才是回答 / 收尾卡」交给 `resolveTurnBoundary(body)` 判定：
 * body 里已无 user 段，它的起点就是本轮起点，语义正好对上。
 */
export function splitTurns(segments: Segment[]): TurnSlice[] {
  const out: TurnSlice[] = []
  let cur: TurnSlice | null = null
  for (const seg of segments) {
    if (seg.kind === 'user') {
      cur = { key: seg.id, user: seg, body: [] }
      out.push(cur)
      continue
    }
    if (!cur) {
      cur = { key: `turn-head-${segmentKey(seg)}`, body: [] }
      out.push(cur)
    }
    cur.body.push(seg)
  }
  return out
}

