import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import { useApp, formatMessageTime, type UiMessage } from '@/stores/app'
import type { ModelProfile, SessionNodeMeta } from '@shared/types'
import { activeProfileOf, enabledProfiles } from '@shared/profiles'
import { formatBytes, kindLabel } from '@shared/attachments'
import { blockedImagesForSend } from '@shared/image-attach'
import { ALL_PROVIDERS } from '@shared/providers'
import { pickRandomGoals, QUICK_PROMPT_COUNT } from '@shared/goals'
import { McpDialog } from './McpDialog'
import { ModelQuickPanel } from './ModelQuickPanel'
import { CopyButton, copyText } from './clipboard'
import { MarkdownView } from './MarkdownView'
import {
  Chip,
  DismissibleBanner,
  Empty,
  PanelHeader,
  formatMs,
  IconBot,
  IconSparkles,
  IconSend,
  IconPlus,
  IconTrash,
  IconStop,
  IconKey,
  IconAlertTriangle,
  IconPaperclip,
  IconPlug,
  IconChevronDown,
  IconClose,
  IconCopy,
  IconPin,
  IconFolder,
  IconUpload,
  IconTerminal,
  IconCheck,
  IconClipboard,
  IconQuote,
  IconCornerUpRight,
  IconRotateCcw,
  IconPause
} from '@/components/ui'
import { TodoPanel } from './TodoPanel'
import {
  dropEmptyMessages,
  groupMessages,
  hoistTrailingThinking,
  planRawCollapse,
  resolveTurnBoundary,
  splitTurnsReusing,
  type CollapseSignal,
  type Segment,
  type ToolMsg,
  type TurnSlice
} from './messageSegments'
import {
  DIFF_PREVIEW_LINES,
  buildStructuredView,
  describeDiff,
  lineTotalOf,
  type DiffView
} from './structuredResult'
import { CollapseContext, useCollapsible } from './collapseContext'
import { describeTurnUsage } from '@shared/turn-usage'
import { describeToolSummary } from '@shared/tool-summary'

/**
 * 未被点开过的轮：收起态。
 *
 * **必须是同一个对象**（模块级常量）：`useCollapsible` 的 effect 依赖 signal 引用，
 * 每次渲染新建 `{epoch:0,open:false}` 会让所有块的 effect 空转，把用户已经手动
 * 展开的块在父组件重渲染时反复拉回收起态。
 */
const COLLAPSED_SIGNAL: CollapseSignal = { epoch: 0, open: false }

/**
 * 「上次中断」横幅上的时间：今天只给时分，更早补上日期。
 * 不复用 `formatTime`（它只有时分，跨天时会显示成「刚刚」的错觉）。
 */
function shortDateTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/**
 * 右栏 AI 面板。
 *
 * 「纯代理」模式下这一栏是产品主轴：
 * - 常驻可见，执行轨迹逐步可见（计划 / 工具调用 / 原始回显）
 * - 执行中仍可输入 → 进入队列（v0.4 真正接上，不再只是 promise）
 * - v0.4：顶部「当前 / 历史」两个 tab —— 历史是会话树浏览器，
 *   根列表 → 展开节点 → 「从这里继续」（换路重走）/「导出」报告
 * - v1.5：输入区补齐「导入文件 / 切模型 / 增强提示词 / 连接 MCP」四件事 ——
 *   这一栏是用户唯一的入口，能力都收在这里，不再散落到设置页。
 */

export function AgentPanel({ onOpenSettings }: { onOpenSettings?: () => void }): ReactNode {
  const messages = useApp((s) => s.messages)
  // R3：流式中的那条 assistant 正文单独订阅（不进 messages）。
  // 它挂在消息流末尾，渲染时作为一条**虚拟段**并进去 —— 于是整段流式输出
  // 期间 `messages` 引用不变，下面的四趟 O(n) 管线与 MarkdownView 的 memo 全部命中。
  const streamingText = useApp((s) => s.streamingText)
  const running = useApp((s) => s.agentRunning)
  const runtime = useApp((s) => s.agentRuntime)
  const hasApiKey = useApp((s) => s.hasApiKey)
  const queueCount = useApp((s) => s.queueCount)
  // v2.7：计划模式（本轮指令的属性）
  const planMode = useApp((s) => s.planMode)
  const setPlanMode = useApp((s) => s.setPlanMode)
  const sessions = useApp((s) => s.sessions)
  const activeRootId = useApp((s) => s.activeRootId)
  const send = useApp((s) => s.send)
  const abort = useApp((s) => s.abort)
  const clear = useApp((s) => s.clearConversation)
  const newSession = useApp((s) => s.newSession)
  // v1.5：输入区能力（附件 / 模型档案 / 提示词增强 / MCP）
  // v2.3：模型菜单只列「启用」的档案（停用的还在设置里，只是不进这个切换器）。
  // 必须过 useMemo：enabledProfiles 每次调用都返回新数组，直接塞进 zustand selector
  // 会让 useSyncExternalStore 认为快照一直在变（无限重渲染）。
  const agentSettings = useApp((s) => s.settings.agent)
  const profiles = useMemo(() => enabledProfiles(agentSettings), [agentSettings])
  const activeProfileId = useApp((s) => s.settings.agent.activeProfileId)
  const activeProfile = useApp((s) => activeProfileOf(s.settings))
  const configuredProfileIds = useApp((s) => s.configuredProfileIds)
  const attachments = useApp((s) => s.attachments)
  const pickAttachments = useApp((s) => s.pickAttachments)
  const importAttachmentPaths = useApp((s) => s.importAttachmentPaths)
  const removeAttachment = useApp((s) => s.removeAttachment)
  const setActiveProfile = useApp((s) => s.setActiveProfile)
  const updateSettings = useApp((s) => s.updateSettings)
  const enhanceDraft = useApp((s) => s.enhanceDraft)
  const enhancing = useApp((s) => s.enhancing)
  const mcpServers = useApp((s) => s.mcpServers)
  const noteSystemMessage = useApp((s) => s.noteSystemMessage)
  // v2.8：断点续跑。resumable 为 null = 还没读到或已处理，[] = 读到但没有未完成会话
  const resumable = useApp((s) => s.resumable)
  const resumeSession = useApp((s) => s.resumeSession)
  const dismissResume = useApp((s) => s.dismissResume)

  const [tab, setTab] = useState<'live' | 'history'>('live')
  const [text, setText] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  /**
   * v2.3：逐模型快捷设置浮层（hover 某一行时出现在菜单右侧）。
   * top/left 用 fixed 坐标计算 —— 菜单本身是 overflow:auto 的滚动容器，
   * 把浮层嵌在菜单里会被裁掉。
   */
  const [quick, setQuick] = useState<{ id: string; top: number; left: number } | null>(null)
  /** 快捷设置浮层的外层容器：用来量它的真实高度（视口底部兜底，见下面的 useLayoutEffect） */
  const quickRef = useRef<HTMLDivElement | null>(null)
  /** 会话区右键菜单（选中文字后复制单段） */
  const [streamMenu, setStreamMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  /**
   * v2.19：**按轮**折叠信号（键 = `TurnSlice.key`）。
   *
   * 语义变了：收尾行不再是一个"全局总开关"，而是**这一轮**过程的开关 ——
   * 点哪轮开哪轮。多轮会话里展开第 3 轮，不该把第 8 轮的过程也翻出来。
   *
   * 为什么带 `epoch` 而不是只存 `open`：用户可能反复点同一行，而
   * `useCollapsible` 是「signal 引用变了才应用」—— 只改 `open` 值不变时
   * effect 不触发，用户两轮点击之间手动收起过的块就不会被重新应用，像失灵。
   *
   * 未点开过的轮统一用 `COLLAPSED_SIGNAL`（模块级常量）—— 引用必须稳定：
   * 每次渲染新建 `{epoch:0,open:false}` 会让所有块的 effect 空转，
   * 把用户已经手动展开的块反复拉回收起态。
   */
  const [turnCollapse, setTurnCollapse] = useState<Record<string, CollapseSignal>>({})
  /**
   * R10（PERF-MEM-REVIEW-2026-09-29 §五）：切会话必须整体复位。
   *
   * `TurnSlice.key` 是按 user 段 id 建的，跨会话会撞键 —— 浏览 50 个会话 × 20 轮
   * 就是 1000 个永不回收的条目，而且撞上的那一轮会带着上一个会话的折叠态。
   * 对齐 `TracePanel.tsx:191` 的既有做法。
   *
   * 复位只动这张表，**不碰** `COLLAPSED_SIGNAL` 的模块级常量身份 ——
   * 未点开过的轮必须继续拿到同一个引用（N16/B5 的硬约束，见报告 §十.1）。
   */
  useEffect(() => {
    setTurnCollapse({})
  }, [activeRootId])
  /**
   * N16：必须是**稳定引用** —— 它会被透传给 `FinalResponseView`（memo 组件），
   * 每次渲染新建函数会让 memo 全部失效，历史轮在流式期间照样整棵重渲染。
   * 只用函数式 setState（不读任何外部值），所以依赖为空。
   */
  const toggleTurn = useCallback((key: string): void => {
    setTurnCollapse((prev) => {
      const cur = prev[key]
      const next: CollapseSignal = { epoch: (cur?.epoch ?? 0) + 1, open: !(cur?.open ?? false) }
      return { ...prev, [key]: next }
    })
  }, [])
  /**
   * 工具栏的「收起 / 展开全部」：给**每一轮**下发同一个意图（各自 epoch 递增）。
   * 未收尾的轮拿到的信号不产生可见变化 —— 它本来就不受折叠控制（过程必须可见）。
   */
  const collapseAllTurns = (open: boolean): void => {
    setTurnCollapse((prev) => {
      const next: Record<string, CollapseSignal> = { ...prev }
      for (const t of turns) {
        next[t.key] = { epoch: (prev[t.key]?.epoch ?? 0) + 1, open }
      }
      return next
    })
  }
  const streamRef = useRef<HTMLDivElement | null>(null)
  const modelMenuRef = useRef<HTMLDivElement | null>(null)
  const quickTimer = useRef<number | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // v1.10：空态快速目标来自「一句话实验目标存档」，每次打开软件随机抽三条。
  // null = 还没读到；[] = 读到了但存档为空（不展示，不造默认值）
  const [quickGoals, setQuickGoals] = useState<string[] | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.goals
      .list()
      .then((p) => {
        if (alive) setQuickGoals(pickRandomGoals(p.goals, QUICK_PROMPT_COUNT))
      })
      .catch(() => {
        if (alive) setQuickGoals([])
      })
    return () => {
      alive = false
    }
  }, [])

  /**
   * 是否「贴着底部」跟随流式输出（R28）。
   *
   * 判据必须由 onScroll 维护：旧实现在 effect 里**当场量**，
   * 而 effect 跑的时候新消息已经进了 DOM、scrollHeight 已经变大，
   * 量出来的「离底 80px 内」是个假结论 —— 连续输出时会莫名其妙停止跟随。
   */
  const stickToBottom = useRef(true)

  /**
   * v2.9：非贴底状态下是否又来了新内容。
   *
   * 用户上翻看历史时我们不把他拽回底部（见下面的 effect），但如果流式还在继续，
   * 他需要知道「下面有新东西」并且一键跳回去 —— 否则会误以为任务停了。
   */
  const [hasNewBelow, setHasNewBelow] = useState(false)

  /** 最近一次「用户贴底」时看到的消息条数；用于判断新内容是否发生在视野之外 */
  const seenCount = useRef(messages.length)

  const scrollToBottom = (): void => {
    const el = streamRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickToBottom.current = true
    seenCount.current = messages.length
    setHasNewBelow(false)
  }

  /**
   * R2（PERF-MEM-REVIEW-2026-09-29 §4.3）：跟随滚动用 rAF 合流。
   *
   * 原来的路径是「读-写交替」：`onStreamScroll` 读 `scrollHeight/scrollTop/clientHeight`
   * 三个布局属性 → effect 里写 `scrollTop = scrollHeight` → 写入又派发 `scroll`
   * → 回到 `onStreamScroll` 再读三个。**每个 token 4 次强制同步布局**，
   * 被 reflow 的是整条消息流的 DOM（几百个节点），且读写交替正是 layout thrash 的定义。
   *
   * 合流后一帧最多提交一次写，且写之前不再读布局（`scrollHeight` 本身就是读，
   * 但只有一帧一次、且不与别的读交替）。
   */
  const followRaf = useRef<number | null>(null)
  const scheduleFollow = (): void => {
    if (followRaf.current !== null) return
    followRaf.current = requestAnimationFrame(() => {
      followRaf.current = null
      const el = streamRef.current
      if (!el || !stickToBottom.current) return
      el.scrollTop = el.scrollHeight
    })
  }
  useEffect(
    () => () => {
      if (followRaf.current !== null) cancelAnimationFrame(followRaf.current)
    },
    []
  )

  const onStreamScroll = (): void => {
    const el = streamRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    // R2：只有「贴底与否」这个布尔翻转才值得 setState。用户手动滚动是 60~120Hz，
    // 每次都 set 会把 AgentPanel 顶层整个重渲（`hasNewBelow` 挂在它上面）。
    if (stickToBottom.current === atBottom) return
    stickToBottom.current = atBottom
    if (atBottom) {
      seenCount.current = messages.length
      setHasNewBelow(false)
    }
  }

  useEffect(() => {
    // 只在用户本来就贴着底部时自动滚到底；上翻看历史时不再被流式输出拽回
    if (stickToBottom.current) {
      seenCount.current = messages.length
      scheduleFollow()
    } else if (messages.length > seenCount.current) {
      // 视野之外多了新内容 → 亮出「有新内容」提示
      setHasNewBelow(true)
    }
  }, [messages, running, tab])

  /**
   * v2.9：消息切段。
   *
   * 两个要点：
   * ① 用 `useMemo` 缓存 —— 旧实现把 `groupMessages(messages)` 写在 JSX 的 IIFE 里，
   *    每次渲染（含每个流式 delta）都全量重算分组；
   * ② 把上一次结果作为 `prev` 传进去，让未变化的前缀复用同一个 segment 对象 ——
   *    `React.memo` 是逐元素比较的，segment 引用稳定，已完成的段才会真正跳过重渲染。
   */
  const segsRef = useRef<Segment[]>([])
  const segments = useMemo(() => {
    // v2.16：先把「吊在最终回答后面」的思考段搬回回答前面（部分端点在正文
    // 输出完之后才吐 reasoning），再去空壳、切段 —— 顺序归一必须在切段之前。
    const next = groupMessages(hoistTrailingThinking(dropEmptyMessages(messages)), segsRef.current)
    segsRef.current = next
    return next
  }, [messages])

  /**
   * R3：把 `streamingText` 作为一条**虚拟 assistant 段**挂在末尾。
   *
   * 为什么要虚拟段而不是直接 push 进 `messages`：`messages` 一换引用，
   * 上面那个 useMemo 就整个重跑（`dropEmptyMessages` 遍历 + 分配新数组、
   * `hoistTrailingThinking`、`groupMessages` 重建 size=n 的 Map）。
   * 单独拼在管线**之后**，`segments` 就能在整段流式期间保持同一引用。
   *
   * 段 id 用固定常量而不是 `nextId()`：它是「本轮正在流式的那一条」的身份，
   * 整段流式期间必须保持不变，否则 React 会把它当成一条新消息反复重建。
   */
  const STREAM_SEG_ID = 'm-streaming'
  const liveSegments = useMemo<Segment[]>(() => {
    if (!streamingText || !streamingText.trim()) return segments
    return [...segments, { kind: 'assistant', id: STREAM_SEG_ID, text: streamingText }]
  }, [segments, streamingText])

  /**
   * v2.13：本轮收尾锚点（回答 / 收尾卡的结构判定）。
   *
   * v2.19：判定下沉到**轮**粒度 —— 渲染不再只看「最后一条 user 之后」，
   * 而是每轮各判各的。于是历史轮次的收尾行（含耗时 / 用量 / 模型）也能正确挂到
   * 它自己的回答上，而不是整条流只认最后一张（旧实现里前几轮的收尾卡会被丢掉）。
   * 旧实现的两个坑（轮内最后一条日常信息被当成回答、收尾卡张冠李戴）
   * 在每轮内部由同一条规则挡住，见 `resolveTurnBoundary`。
   *
   * R3：改用带前缀复用的版本（`splitTurnsReusing`）—— 流式期间只有最后一轮在长，
   * 前面的轮直接复用同一个 `TurnSlice` 对象，`turn.body` 引用不变。
   */
  const turnsRef = useRef<TurnSlice[]>([])
  const turns = useMemo(() => {
    const next = splitTurnsReusing(liveSegments, turnsRef.current)
    turnsRef.current = next
    return next
  }, [liveSegments])

  /**
   * R3/R5（PERF-MEM-REVIEW-2026-09-29 §三 + §五）：把「每轮渲染」整段搬进 useMemo。
   *
   * 原来这段是写在 JSX 的 IIFE 里，等于**每次渲染**（含每个流式 delta）都重跑：
   * ① 每轮一次 `resolveTurnBoundary(turn.body)` —— 从尾部倒扫的 O(段数)，20 轮就是
   *    每 token 20 趟；
   * ② 每轮一次 `turn.body.map(...)` 新建 React 元素数组 ——
   *    这个数组作为 `process` prop 传给 memo 化的 `FinalResponseView`，
   *    **每次都是新引用 ⇒ 那一轮的 memo 100% 失效**。
   *    N16 当初的优化只覆盖了「折叠的轮」（`process={null}`，引用稳定），
   *    「用户手动展开过的历史轮」一直漏在优化之外（R5）。
   *
   * 搬进 useMemo 后依赖只有 `turns` 与 `turnCollapse`：
   * R3 让 `turns` 在整段流式期间只有**最后一轮**变引用（`splitTurnsReusing`），
   * 于是 memo 内部再按 `turn.body` 引用跳过未变的轮 —— 展开着的历史轮也重新吃到 memo。
   */
  const renderedTurns = useMemo(() => {
    return turns.map((turn) => {
      // 每轮各判各的收尾锚点：回答 = 本轮最后一次说话且之后再无工具调用
      const { replyIdx, tailIdx } = resolveTurnBoundary(turn.body)
      const replySeg = replyIdx >= 0 ? turn.body[replyIdx] : undefined
      const reply = replySeg && replySeg.kind === 'assistant' ? replySeg : undefined
      const tailSeg = tailIdx >= 0 ? turn.body[tailIdx] : undefined
      const turnEnd = tailSeg && tailSeg.kind === 'finish' ? tailSeg : undefined

      const sig = turnCollapse[turn.key] ?? COLLAPSED_SIGNAL
      /**
       * v2.19：**已收尾的轮，过程整体收起** —— 只留「收尾行 + 最终回答」。
       *
       * 判据是"这一轮有没有收尾卡"，不是"它是不是最后一轮"：
       * 正在执行的那一轮没有收尾卡 → 过程照常平铺可见（收起等于把
       * 「正在干什么」藏起来，用户会以为卡死）；一旦收尾卡到达，
       * 过程即刻收成一行，点收尾行才铺开 —— 与参考图的观感一致。
       */
      const folded = turnEnd !== undefined && !sig.open

      /**
       * 过程段：本轮 body 里除「回答」与「收尾卡」之外的全部段，保持事件顺序。
       *
       * **N16：折叠的轮根本不构造这段**。原实现无条件 `turn.body.map(...)`，
       * 于是一轮已收尾（= 已折叠）的历史轮，在每个流式 delta 上都要重建
       * O(段数) 个 React 元素对象 —— 这些对象随后被 `process={null}` 丢掉，
       * 纯浪费，而且长会话下正是掉帧的主因。折叠时不构造，展开的那一轮照旧。
       */
      const processNodes = folded
        ? null
        : turn.body.map((seg, i) => {
            if (i === replyIdx || i === tailIdx) return null
            if (seg.kind === 'toolGroup') {
              return <ToolGroup key={seg.key} items={seg.items} />
            }
            return <MessageView key={seg.id} m={seg} />
          })

      return (
        <Fragment key={turn.key}>
          {turn.user ? <MessageView m={turn.user} /> : null}
          <CollapseContext.Provider value={sig}>
            {reply ? (
              <FinalResponseView
                text={reply.text}
                {...(turnEnd ? { turnEnd } : {})}
                {...(turnEnd ? { turnKey: turn.key, onToggleTurn: toggleTurn } : {})}
                allOpen={sig.open}
                msgId={reply.id}
                process={processNodes}
                // R1：这一条还在流 → 不喂 react-markdown（对累积全文 O(len²) 重解析）
                streaming={reply.id === STREAM_SEG_ID}
              />
            ) : (
              <>
                {processNodes}
                {/* 没有可挂靠的正文（失败 / 达轮次上限而结束在工具上）时，
                    收尾行在本轮末尾单独成块 —— 信息不丢，也照样是过程开关 */}
                {turnEnd ? (
                  <TurnCompleteBanner
                    m={turnEnd}
                    turnKey={turn.key}
                    onToggleTurn={toggleTurn}
                    allOpen={sig.open}
                  />
                ) : null}
              </>
            )}
          </CollapseContext.Provider>
        </Fragment>
      )
    })
    // toggleTurn 是 useCallback([]) 恒稳定，不进依赖也不会造成漏算
  }, [turns, turnCollapse, toggleTurn])

  const autoGrow = (): void => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
  }

  /**
   * v2.11：消费「引用」请求 —— 气泡 hover 操作条把正文写进 store 的 quoteDraft，
   * 这里读走并作为引用块追加到输入框，随即清空（不清会重复插入）。
   *
   * 为什么不在气泡里直接改输入框：输入框文本是 AgentPanel 的局部 state，
   * 而从气泡传回调下去会破坏 `MessageView` 的 memo（见 appState.quoteDraft 注释）。
   */
  const quoteDraft = useApp((s) => s.quoteDraft)
  const clearQuoteDraft = useApp((s) => s.clearQuoteDraft)
  useEffect(() => {
    if (!quoteDraft) return
    // 引用块用「> 」前缀，模型与人一眼能看出这是引用而非新指令
    const quoted = quoteDraft
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
    setText((prev) => (prev.trim() ? `${prev}\n\n${quoted}\n\n` : `${quoted}\n\n`))
    clearQuoteDraft()
    if (taRef.current) {
      taRef.current.focus()
      requestAnimationFrame(autoGrow)
    }
  }, [quoteDraft, clearQuoteDraft])

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    // v2.22（F17）：图片进不去时**不发送、也不清空输入** —— 用户刚写完的字被吞掉
    // 比发不出去更让人恼火；原因写在输入框上方的横幅里，这里只补一条同样的说明。
    if (imageBlocked) {
      noteSystemMessage(imageBlocked.message, 'error')
      if (taRef.current) taRef.current.focus()
      return
    }
    setText('')
    requestAnimationFrame(autoGrow)
    void send(t)
  }

  const pickPrompt = (promptText: string): void => {
    setText(promptText)
    if (taRef.current) {
      taRef.current.focus()
      requestAnimationFrame(autoGrow)
    }
  }

  /** v1.5：拖入文件 → 取真实路径交给主进程归档（webUtils，Electron 32+ 的官方姿势） */
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragOver(false)
    const paths: string[] = []
    for (const f of Array.from(e.dataTransfer.files)) {
      const p = window.api.files.pathFor(f)
      if (p) paths.push(p)
    }
    if (paths.length > 0) void importAttachmentPaths(paths)
  }

  /** v1.5：一键增强 —— 用当前档案把草稿改写得更可执行，结果回填输入框 */
  const doEnhance = async (): Promise<void> => {
    const t = text.trim()
    if (!t || enhancing) return
    const better = await enhanceDraft(t)
    if (better) {
      setText(better)
      if (taRef.current) {
        taRef.current.focus()
        requestAnimationFrame(autoGrow)
      }
    }
  }

  /**
   * v2.3：逐模型快捷设置（思考强度 / 更大上下文）。
   *
   * 与设置页共用同一份数据：就地写回该档的 profiles[i]，改完立即生效。
   * 读 getState 而不是渲染闭包，避免连着点两下时基于过期快照互相覆盖。
   */
  const patchProfile = (id: string, patch: Partial<ModelProfile>): void => {
    const agent = useApp.getState().settings.agent
    void updateSettings({
      agent: {
        ...agent,
        profiles: agent.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p))
      }
    })
  }

  /**
   * v2.22（F17）：图片附件 + 不支持图片的模型 → 发送前拦下。
   *
   * 判定与主进程共用同一份（`blockedImagesForSend`），于是不会出现
   * 「界面说能发、主进程拒绝」这种自相矛盾。这里只负责**把它讲清楚并留住输入**：
   * 输入框里的字不清空、附件不自动丢，用户按提示处理完原样再发即可。
   */
  const imageBlocked = useMemo(
    () => blockedImagesForSend(attachments, activeProfile),
    [attachments, activeProfile]
  )

  /** 一键开启当前档的图片输入（改设置，立即生效 —— 下一轮请求就带上图片） */
  const enableImageInput = (): void => {
    patchProfile(activeProfile.id, { supportsImage: true })
  }

  /** 一键移除被拦下的图片（保留其它附件） */
  const dropBlockedImages = (): void => {
    for (const a of attachments) {
      if (a.kind === 'image') removeAttachment(a.id)
    }
  }

  /** 浮层定位：默认贴在模型菜单右侧；右边放不下就翻到左侧（fixed 坐标，不受菜单滚动容器裁剪） */
  const openQuick = (id: string, rowEl: HTMLElement | null): void => {
    const row = rowEl?.getBoundingClientRect()
    const menu = modelMenuRef.current?.getBoundingClientRect()
    const width = 300
    const right = (menu?.right ?? row?.right ?? 0) + 8
    const left =
      right + width > window.innerWidth - 8 ? Math.max(8, (menu?.left ?? 0) - width - 8) : right
    const top = Math.max(8, Math.min((row?.top ?? 0) - 8, window.innerHeight - 300))
    setQuick({ id, top, left })
  }

  const cancelQuickClose = (): void => {
    if (quickTimer.current !== null) window.clearTimeout(quickTimer.current)
  }

  /** 延迟关闭：鼠标从行移到浮层的过程中必然先离开行，立即关会让浮层点不到 */
  const scheduleQuickClose = (): void => {
    cancelQuickClose()
    quickTimer.current = window.setTimeout(() => setQuick(null), 260)
  }

  useEffect(() => cancelQuickClose, [])

  /**
   * 浮层高度只有渲染完才知道。openQuick 只能按「行的位置」猜一个起点，
   * 面板内容一高（窗口档位、思考强度、图片开关全展开）就会从窗口底部漏出去被切掉。
   * 这里量到真实高度后把溢出的部分顶回来；只上移、不下移（避免抖动）。
   */
  useLayoutEffect(() => {
    const el = quickRef.current
    if (!quick || !el) return
    const top = Math.max(8, Math.min(quick.top, window.innerHeight - el.offsetHeight - 8))
    if (Math.abs(top - quick.top) > 0.5) setQuick((q) => (q ? { ...q, top } : q))
  }, [quick])

  /**
   * v2.3：会话区右键 —— 只有「选中了文字」时才接管，复制选中的那一段。
   *
   * 为什么必须判选区：没选区时接管右键会让用户失去浏览器默认菜单（复制链接、
   * 检查元素等），那是纯粹的功能倒退。空选区一律放行。
   */
  const onStreamContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const sel = window.getSelection()
    const picked = sel && !sel.isCollapsed ? sel.toString().trim() : ''
    if (!picked) return
    e.preventDefault()
    setStreamMenu({ x: e.clientX, y: e.clientY, text: picked })
  }

  const mcpOkCount = mcpServers.filter((m) => m.connected).length
  const activeSession = sessions.find((s) => s.id === activeRootId)

  return (
    <div className="col agent-panel-col">
      <PanelHeader
        title={`AI 代理 · ${activeSession?.title ?? '新会话'}`}
        icon={<IconBot size={16} />}
        actionsWrap={true}
        actions={
          <>
            <div className="agent-tabs">
              <button className={`btn sm ghost${tab === 'live' ? ' primary' : ''}`} onClick={() => setTab('live')}>
                当前
              </button>
              <button className={`btn sm ghost${tab === 'history' ? ' primary' : ''}`} onClick={() => setTab('history')}>
                历史
              </button>
            </div>
            {tab === 'live' ? (
              <>
                {running ? (
                  <>
                    <Chip tone="warning">运行中</Chip>
                    <button className="btn sm danger" onClick={abort} title="中断当前代理执行">
                      <IconStop size={12} />
                      中断
                    </button>
                  </>
                ) : null}
                <button className="btn sm" onClick={newSession} title="开始新会话（保留历史）">
                  <IconPlus size={12} />
                  <span className="btn-label-sm">新会话</span>
                </button>
                {/* v2.9：全局折叠控制 —— 长会话里一条条点着收太累。
                    v2.19：作用域是「所有已完成任务的轮」，逐轮下发同一意图 */}
                {messages.length > 0 ? (
                  <>
                    <button
                      className="btn sm ghost"
                      title="收起所有任务的过程（只留各轮的收尾行与结果）"
                      onClick={() => collapseAllTurns(false)}
                    >
                      <IconChevronDown size={12} className="collapse-all-icon" />
                    </button>
                    <button
                      className="btn sm ghost"
                      title="展开所有任务的过程"
                      onClick={() => collapseAllTurns(true)}
                    >
                      <IconChevronDown size={12} />
                    </button>
                  </>
                ) : null}
                {messages.length > 0 ? (
                  <>
                    {/* v2.1：整段会话一次性复制走（含工具调用与原始回显）——
                        排查问题时不用再逐条挑着复制，也不用截图 */}
                    <CopyButton
                      getText={() => conversationToText(messages)}
                      title="复制整段会话（含工具调用与原始回显）为纯文本"
                      variant="button"
                    />
                    <button className="btn sm ghost" onClick={clear} title="清空当前消息流">
                      <IconTrash size={12} />
                    </button>
                  </>
                ) : null}
              </>
            ) : null}
          </>
        }
      />

      {tab === 'live' ? (
        <>
          {!hasApiKey ? (
            <div className="banner pending" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <IconAlertTriangle size={14} />
                未配置模型 API Key，当前使用 mock 运行时（固定离线回放）
              </span>
              {onOpenSettings ? (
                <button className="btn sm primary" onClick={onOpenSettings} style={{ height: 22, fontSize: 11 }}>
                  <IconKey size={11} />
                  去配置密钥
                </button>
              ) : null}
            </div>
          ) : null}

          {/* v2.8：断点续跑横幅。只列本机「上次没收尾」的会话（进程被杀 / 断电 / 崩溃），
              不复用消息流，因为它描述的是「树里有什么」而不是「屏幕上有过什么」 */}
          {resumable && resumable.length > 0 ? (
            <div
              className="banner info"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <IconRotateCcw size={14} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  上次任务在本机中断了：{resumable[0]!.title || '未命名会话'}
                  {resumable.length > 1 ? ` 等 ${resumable.length} 个` : ''}
                  {resumable[0]!.updatedAt ? `（${shortDateTime(resumable[0]!.updatedAt)}）` : ''}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button
                  className="btn sm primary"
                  style={{ height: 22, fontSize: 11 }}
                  onClick={() => void resumeSession(resumable[0]!.id)}
                >
                  继续上次任务
                </button>
                <button className="btn sm ghost" style={{ height: 22, fontSize: 11 }} onClick={dismissResume}>
                  忽略
                </button>
              </span>
            </div>
          ) : null}

          {/* v2.7：任务清单常驻条（空清单时不渲染）—— 它是「最新状态」而非历史，
              所以放在消息流之外，永远只有一份，切会话时自动换成该会话的清单 */}
          <TodoPanel />

          {/* v2.9：消息流与「有新内容」浮标共用一个相对定位容器 */}
          <div className="agent-stream-wrap">
          <div
            className="agent-stream"
            ref={streamRef}
            onScroll={onStreamScroll}
            onContextMenu={onStreamContextMenu}
          >
            {messages.length === 0 ? (
              <Empty icon={<IconSparkles size={26} />}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>用一句话下达网络实验目标</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 8 }}>
                  代理将自主规划步骤、调用 Telnet 工具并完成拓扑配置与验证
                </span>

                <div className="quick-prompts">
                  {quickGoals
                    ? quickGoals.map((g, i) => (
                        <div
                          key={`${i}-${g}`}
                          className="quick-prompt-chip"
                          onClick={() => pickPrompt(g)}
                        >
                          <span className="quick-prompt-text">{g}</span>
                          <span style={{ opacity: 0.6 }}>↵</span>
                        </div>
                      ))
                    : null}
                </div>
              </Empty>
            ) : (
              <>
                {renderedTurns}
              </>
            )}
          </div>

          {/* v2.9：上翻看历史时，视野之外来了新内容 → 一键跳回底部。
              不自动抢滚动位置（那会让用户正在读的内容跳走），只给一个明确的入口 */}
          {hasNewBelow ? (
            <button
              className="agent-new-below"
              onClick={scrollToBottom}
              title="跳到最新内容"
            >
              <IconChevronDown size={13} />
              有新内容
            </button>
          ) : null}
        </div>

        <div
            className={`agent-input-container${dragOver ? ' drop-active' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              if (!dragOver) setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <div className="agent-input-box">
              {/* v2.22（F17）：图片被拦下的常驻提示（不做成会自动消失的反馈条 ——
                  它描述的是「当前状态」，消失会让人以为问题已解决）*/}
              {imageBlocked ? (
                <div className="attach-warn" role="alert">
                  <IconAlertTriangle size={13} />
                  <div className="attach-warn-body">
                    <div className="attach-warn-title">
                      当前模型不支持图片输入，{imageBlocked.names.length} 张图片不会被发送
                    </div>
                    <div className="attach-warn-desc">
                      模型「{activeProfile.label} · {activeProfile.model}」未声明图片输入能力。
                      请开启该档的图片输入、或切换到支持视觉的模型档；本次不需要图片的话移除后即可发送。
                    </div>
                    <div className="attach-warn-actions">
                      <button className="btn-mini" onClick={enableImageInput}>
                        开启「{activeProfile.label}」的图片输入
                      </button>
                      <button className="btn-mini" onClick={dropBlockedImages}>
                        移除这些图片
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              {attachments.length > 0 ? (
                <div className="attach-list">
                  {attachments.map((a) => (
                    <span
                      key={a.id}
                      className={`attach-chip ${a.kind}${
                        imageBlocked && a.kind === 'image' ? ' blocked' : ''
                      }`}
                      title={
                        imageBlocked && a.kind === 'image'
                          ? `${a.path}\n（当前模型不支持图片输入，这张图不会被发送）`
                          : a.path
                      }
                    >
                      <IconPaperclip size={11} />
                      <span className="attach-name">{a.name}</span>
                      <span className="attach-meta">
                        {formatBytes(a.size)} · {kindLabel(a.kind, a.ext)}
                      </span>
                      <button
                        className="attach-remove"
                        onClick={() => removeAttachment(a.id)}
                        title="移除该附件"
                      >
                        <IconClose size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <textarea
                ref={taRef}
                value={text}
                placeholder={running ? '代理执行中，输入将进入排队序列…' : '描述实验目标，Enter 发送 / Shift+Enter 换行'}
                onChange={(e) => {
                  setText(e.target.value)
                  autoGrow()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
                onPaste={(e) => {
                  // v2.1：剪贴板里带磁盘路径的文件（在资源管理器里复制文件后粘贴）直接进附件。
                  // 纯文本一律交回浏览器原生粘贴 —— 光标位置与选区由它维护，比手写插入稳。
                  const files = Array.from(e.clipboardData?.files ?? [])
                  if (files.length === 0) return
                  const paths: string[] = []
                  for (const f of files) {
                    const p = window.api.files.pathFor(f)
                    if (p) paths.push(p)
                  }
                  if (paths.length === 0) {
                    // 截图工具直接复制的位图没有磁盘路径：明说一句，别让它静默消失
                    noteSystemMessage('剪贴板里是图片数据而非文件，请先另存为文件再拖入或粘贴', 'info')
                    return
                  }
                  e.preventDefault()
                  void importAttachmentPaths(paths)
                }}
              />

              <div className="agent-input-row">
                <div className="agent-input-tools">
                  <div className={`model-picker${modelMenuOpen ? ' open' : ''}`}>
                    <button
                      type="button"
                      className="model-btn"
                      onClick={() => setModelMenuOpen((v) => !v)}
                      title={`切换模型档案（每档独立 API Key）\n当前：${activeProfile.label} · ${activeProfile.model}`}
                    >
                      <IconBot size={13} className="model-btn-icon" />
                      <span className="model-name">{activeProfile.label}</span>
                      <IconChevronDown size={11} className="model-btn-arrow" />
                    </button>
                    {modelMenuOpen ? (
                      <>
                        <div
                          className="menu-backdrop"
                          onClick={() => {
                            // 浮层自己不再带遮罩（带了的遮罩会盖住面板本身，点不动）；
                            // 点空白处关菜单时一并把浮层清掉
                            setModelMenuOpen(false)
                            setQuick(null)
                          }}
                        />
                        <div className="model-menu" role="menu" ref={modelMenuRef}>
                          {profiles.map((p) => (
                            <div
                              key={p.id}
                              className={`model-menu-row${p.id === activeProfileId ? ' active' : ''}`}
                              // 鼠标落在行上即滑出该档的快捷设置（与参考版式一致）；
                              // 关闭延迟 260ms，让指针来得及移到浮层上
                              onMouseEnter={(e) => {
                                cancelQuickClose()
                                openQuick(p.id, e.currentTarget)
                              }}
                              onMouseLeave={scheduleQuickClose}
                            >
                              <button
                                className="model-menu-item"
                                onClick={() => {
                                  setModelMenuOpen(false)
                                  setQuick(null)
                                  void setActiveProfile(p.id)
                                }}
                              >
                                <span className="model-menu-label">{p.label}</span>
                                <span className="model-menu-sub">
                                  {ALL_PROVIDERS[p.provider]?.label ?? p.provider} · {p.model}
                                  {configuredProfileIds.includes(p.id) ? '' : ' · 未配密钥'}
                                </span>
                              </button>
                            </div>
                          ))}
                          {onOpenSettings ? (
                            <button
                              className="model-menu-item manage"
                              onClick={() => {
                                setModelMenuOpen(false)
                                onOpenSettings()
                              }}
                            >
                              <span className="model-menu-label">管理模型档案…</span>
                              <span className="model-menu-sub">新增 / 编辑 / 逐档配置 API Key</span>
                            </button>
                          ) : null}
                        </div>
                        {quick
                          ? (() => {
                              const target = profiles.find((p) => p.id === quick.id)
                              if (!target) return null
                              return (
                                <div
                                  ref={quickRef}
                                  style={{ position: 'fixed', top: quick.top, left: quick.left, zIndex: 102 }}
                                  onMouseEnter={cancelQuickClose}
                                  onMouseLeave={scheduleQuickClose}
                                >
                                  <ModelQuickPanel
                                    profile={target}
                                    onPatch={(patch) => patchProfile(target.id, patch)}
                                  />
                                </div>
                              )
                            })()
                          : null}
                      </>
                    ) : null}
                  </div>

                  <button
                    className="icon-btn"
                    onClick={() => void pickAttachments()}
                    title="导入文件（也可直接把文件拖进来）"
                  >
                    <IconPaperclip size={14} />
                  </button>

                  <button
                    className="icon-btn"
                    onClick={() => setMcpOpen(true)}
                    title={`连接 MCP（${mcpOkCount} 台已连接）`}
                  >
                    <IconPlug size={14} />
                    {mcpOkCount > 0 ? <span className="icon-btn-badge">{mcpOkCount}</span> : null}
                  </button>

                  {/* v2.7：计划模式 —— 开着发一条指令 = 只做只读探索并出方案，
                      方案评审批准后才转入执行（写操作在计划模式下会被运行时直接拒绝） */}
                  <button
                    className={`plan-mode-btn${planMode ? ' on' : ''}`}
                    onClick={() => setPlanMode(!planMode)}
                    title={
                      planMode
                        ? '计划模式已开：本条指令只做只读探索并给出方案，批准后才改动设备'
                        : '开启计划模式：先出方案，由你评审后再执行'
                    }
                  >
                    <IconClipboard size={12} />
                    <span>计划</span>
                  </button>

                  {running ? (
                    <span className="agent-input-status running" title="代理执行中">
                      <span className="dot pending" />
                      <span className="status-label">执行中</span>
                    </span>
                  ) : null}
                  {queueCount > 0 ? (
                    <span className="agent-input-status queue" title={`当前有 ${queueCount} 条排队指令`}>
                      排队 ×{queueCount}
                    </span>
                  ) : null}
                </div>

                <div className="agent-input-actions">
                  {runtime === 'mock' ? (
                    <span className="agent-input-status mock" title="当前为 mock 离线回放模式">
                      mock
                    </span>
                  ) : null}
                  <button
                    className="icon-btn"
                    onClick={() => void doEnhance()}
                    disabled={!text.trim() || enhancing}
                    title="增强提示词：用当前模型把草稿改写成更可执行的指令"
                  >
                    {enhancing ? <span className="dot pending" /> : <IconSparkles size={14} />}
                  </button>
                  <button
                    className="btn sm primary agent-send-btn"
                    onClick={submit}
                    disabled={!text.trim()}
                    title="发送指令 (Enter)"
                  >
                    <IconSend size={13} />
                    <span className="send-label">发送</span>
                    <span className="kbd-badge send-kbd">↵</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <SessionHistory onOpen={() => setTab('live')} />
      )}

      {mcpOpen ? <McpDialog onClose={() => setMcpOpen(false)} /> : null}

      {/* v2.3：选中会话文字后的右键菜单（只有「复制」一项） */}
      {streamMenu ? (
        <SelectionContextMenu
          x={streamMenu.x}
          y={streamMenu.y}
          text={streamMenu.text}
          onClose={() => setStreamMenu(null)}
        />
      ) : null}
    </div>
  )
}

/**
 * 会话区右键菜单（v2.3）：在会话里选中文字后右键 → 只复制选中的那一段。
 *
 * 为什么值得单独做：会话里的回答常常很长，用户往往只想把其中一段（报错原文、
 * 某个接口的回显）贴出去；原来只能整条复制再去文本编辑器里裁，或者靠系统级
 * 选中复制而对全局快捷键有依赖。这里把它做成一次右键 + 一次点击。
 * 「Ctrl + C」是提示而非唯一入口 —— 键盘原生复制仍然可用。
 */
function SelectionContextMenu({
  x,
  y,
  text,
  onClose
}: {
  x: number
  y: number
  text: string
  onClose: () => void
}): ReactNode {
  // 菜单约 180×40，贴边时向内收，避免溢出窗口
  const left = Math.max(8, Math.min(x, window.innerWidth - 190))
  const top = Math.max(8, Math.min(y, window.innerHeight - 48))
  return (
    <>
      <div
        className="menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div className="context-menu" style={{ left, top }} role="menu">
        <button
          className="context-menu-item"
          onClick={() => {
            void copyText(text)
            onClose()
          }}
        >
          <IconCopy size={13} />
          <span>复制</span>
          <span className="context-menu-kbd">Ctrl + C</span>
        </button>
      </div>
    </>
  )
}

/**
 * 历史会话（v2.2）：纯列表，一行一个会话，点击进入旧对话。
 * 右键菜单提供：置顶 / 在资源管理器打开 / 文件管理 / 分享（导出报告）/ 重命名 / 删除。
 */
function SessionHistory({ onOpen }: { onOpen: () => void }): ReactNode {
  const sessions = useApp((s) => s.sessions)
  const openSession = useApp((s) => s.openSession)
  const deleteSession = useApp((s) => s.deleteSession)
  const renameSession = useApp((s) => s.renameSession)
  const togglePinSession = useApp((s) => s.togglePinSession)
  const openSessionFile = useApp((s) => s.openSessionFile)
  const openSessionsDir = useApp((s) => s.openSessionsDir)
  const [notice, setNotice] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; meta: SessionNodeMeta } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const onExport = async (rootId: string, format: 'md' | 'json'): Promise<void> => {
    try {
      const r = await window.api.session.export(rootId, format)
      setNotice(`已导出：${r.path}`)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  const onEnter = (meta: SessionNodeMeta): void => {
    void openSession(meta.id)
      .then(onOpen)
      .catch(() => setNotice('读取会话失败'))
  }

  const onDelete = async (meta: SessionNodeMeta): Promise<void> => {
    if (!window.confirm(`删除会话「${meta.title}」？此操作不可撤销。`)) return
    try {
      await deleteSession(meta.id)
      setNotice(`已删除会话「${meta.title}」`)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  const startRename = (meta: SessionNodeMeta): void => {
    setEditingId(meta.id)
    setDraft(meta.title)
  }

  const doRename = async (meta: SessionNodeMeta): Promise<void> => {
    const t = draft.trim()
    setEditingId(null)
    if (!t || t === meta.title) return
    try {
      await renameSession(meta.id, t)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="agent-stream">
      {sessions.length === 0 ? (
        <Empty>
          <span>还没有历史会话</span>
          <span style={{ fontSize: 'var(--text-xs)' }}>发一条指令后，这里会出现可回溯的会话列表</span>
        </Empty>
      ) : (
        <>
          {notice ? (
            <DismissibleBanner tone="info" onDismiss={() => setNotice('')}>
              {notice}
            </DismissibleBanner>
          ) : null}
          <div className="session-list">
            {sessions.map((meta) => (
              <div
                key={meta.id}
                className={`session-item${meta.pinned ? ' pinned' : ''}`}
                onClick={() => onEnter(meta)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, meta })
                }}
                title="点击进入 · 右键更多操作"
              >
                {meta.pinned ? (
                  <IconPin size={12} className="session-item-pin" />
                ) : null}
                {editingId === meta.id ? (
                  <form
                    className="session-item-rename"
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.stopPropagation()}
                    onSubmit={(e) => {
                      e.preventDefault()
                      void doRename(meta)
                    }}
                  >
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => void doRename(meta)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                    />
                  </form>
                ) : (
                  <span className="session-item-title">{meta.title}</span>
                )}
                <span className="session-item-time">
                  {new Date(meta.updatedAt).toLocaleString('zh-CN')}
                </span>
                <span className="session-item-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn sm ghost"
                    onClick={() => void onExport(meta.id, 'md')}
                    title="导出 Markdown 报告"
                  >
                    导出 md
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() => void onExport(meta.id, 'json')}
                    title="导出 JSON 报告"
                  >
                    导出 json
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {menu ? (
        <SessionContextMenu
          x={menu.x}
          y={menu.y}
          meta={menu.meta}
          onClose={() => setMenu(null)}
          onPin={() => void togglePinSession(menu.meta.id).catch(() => setNotice('置顶操作失败'))}
          onOpenFile={() => void openSessionFile(menu.meta.id).catch(() => setNotice('打开会话文件失败'))}
          onOpenDir={() => void openSessionsDir().catch(() => setNotice('打开会话目录失败'))}
          onShare={() => void onExport(menu.meta.id, 'md')}
          onRename={() => startRename(menu.meta)}
          onDelete={() => void onDelete(menu.meta)}
        />
      ) : null}
    </div>
  )
}

/**
 * 历史会话右键菜单（v2.2）：fixed 定位浮层，backdrop 点击/右键关闭。
 * 删除项红色警示；「重命名」进入行内编辑态。
 */
function SessionContextMenu({
  x,
  y,
  meta,
  onClose,
  onPin,
  onOpenFile,
  onOpenDir,
  onShare,
  onRename,
  onDelete
}: {
  x: number
  y: number
  meta: SessionNodeMeta
  onClose: () => void
  onPin: () => void
  onOpenFile: () => void
  onOpenDir: () => void
  onShare: () => void
  onRename: () => void
  onDelete: () => void
}): ReactNode {
  // 菜单约 190×250，贴边时向内收，避免溢出窗口
  const left = Math.max(8, Math.min(x, window.innerWidth - 200))
  const top = Math.max(8, Math.min(y, window.innerHeight - 260))
  return (
    <>
      <div
        className="menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div className="context-menu" style={{ left, top }} role="menu">
        <button className="context-menu-item" onClick={() => { onPin(); onClose() }}>
          <IconPin size={13} />
          <span>{meta.pinned ? '取消置顶' : '置顶'}</span>
        </button>
        <button className="context-menu-item" onClick={() => { onOpenFile(); onClose() }}>
          <IconFolder size={13} />
          <span>在资源管理器打开</span>
        </button>
        <button className="context-menu-item" onClick={() => { onOpenDir(); onClose() }}>
          <IconFolder size={13} />
          <span>文件管理</span>
        </button>
        <button className="context-menu-item" onClick={() => { onShare(); onClose() }}>
          <IconUpload size={13} />
          <span>分享（导出报告）</span>
        </button>
        <button className="context-menu-item" onClick={() => { onRename(); onClose() }}>
          <span>重命名</span>
        </button>
        <div className="context-menu-sep" />
        <button className="context-menu-item danger" onClick={() => { onDelete(); onClose() }}>
          <IconTrash size={13} />
          <span>删除</span>
        </button>
      </div>
    </>
  )
}

/**
 * v2.1：把消息流序列化成纯文本（「复制」按钮与「复制全部会话」共用）。
 *
 * 目标是「粘进聊天/工单/记事本就看得懂」，所以不追求机器可解析：
 * 工具调用带上状态与耗时，回显整段保留 —— 排查模型报错时那段原文才是关键证据。
 */
function toolToText(m: Extract<UiMessage, { kind: 'tool' }>): string {
  const status = m.status === 'ok' ? '完成' : m.status === 'fail' ? '失败' : '执行中'
  const lines = [`[工具] ${m.name} · ${status}${m.ms !== undefined ? ` · ${formatMs(m.ms)}` : ''}`]
  if (m.summary) lines.push(`摘要：${m.summary}${m.errorCode ? ` · ${m.errorCode}` : ''}`)
  lines.push('参数：', safeJson(m.args))
  if (m.raw) lines.push('原始回显：', m.raw)
  return lines.join('\n')
}

function conversationToText(list: UiMessage[]): string {
  return list
    .map((m) => {
      if (m.kind === 'user') return `## 我\n${m.text}`
      if (m.kind === 'assistant') return `## 代理\n${m.text}`
      if (m.kind === 'thinking') return `## 思考\n${m.text}`
      if (m.kind === 'system') return `## 系统${m.tone === 'error' ? '（错误）' : ''}\n${m.text}`
      if (m.kind === 'plan') return `## 执行计划\n${m.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      if (m.kind === 'finish') {
        const label = m.reason === 'completed' ? '完成' : m.reason === 'aborted' ? '已中止' : '失败'
        return `## 任务收尾\n${label} · 耗时 ${formatMs(m.ms)}`
      }
      return toolToText(m)
    })
    .join('\n\n')
}

/**
 * 用户消息卡片视图（对齐参考图 2）：
 * - 卡片包裹结构（.msg-user-card），支持超长文本渐变截断与「展示更多 / 收起」切换；
 * - 底部右对齐信息栏（.msg-user-footer）：
 *   - 左侧时间戳（如「昨天 17:46」或「今天 16:57」）；
 *   - 右侧高频动作图标组（复制 [⧉]、引用 [↗]、删除 [🗑]、重新生成 [↺]）；
 * - 纯净幽灵图标风格，悬浮微亮微缩，平滑过渡。
 */
function UserMessageView({ m }: { m: Extract<UiMessage, { kind: 'user' }> }): ReactNode {
  const quote = useApp((s) => s.quoteIntoInput)
  const regenerate = useApp((s) => s.regenerateMessage)
  const remove = useApp((s) => s.deleteMessage)
  const running = useApp((s) => s.agentRunning)

  // 超过 5 行或超过 240 字符时视为长文本，默认折叠并提供展开切换
  const isLong = useMemo(() => {
    return m.text.length > 240 || m.text.split('\n').length > 5
  }, [m.text])

  const [expanded, setExpanded] = useState(false)
  const timeStr = useMemo(() => formatMessageTime(m.createdAt), [m.createdAt])

  return (
    <div className="msg-row user">
      <div className="msg-user-wrap">
        <div className="msg-user-card">
          <div className={`msg-user-content${isLong && !expanded ? ' collapsed' : ''}`}>
            {m.text}
          </div>
          {isLong ? (
            <button
              type="button"
              className="msg-user-expand-btn"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? '收起' : '展示更多'}
            </button>
          ) : null}
        </div>
        <div className="msg-user-footer">
          {timeStr ? <span className="msg-user-time">{timeStr}</span> : null}
          <div className="msg-user-actions">
            <CopyButton text={m.text} title="复制指令内容" variant="inline" className="msg-action-btn" />
            {quote ? (
              <button
                type="button"
                className="msg-action-btn"
                title="引用指令到输入框"
                onClick={() => quote(m.text)}
              >
                <IconCornerUpRight size={13} />
              </button>
            ) : null}
            {m.id ? (
              <>
                <button
                  type="button"
                  className="msg-action-btn danger"
                  title="删除本条指令及其之后的所有消息"
                  disabled={running}
                  onClick={() => {
                    if (window.confirm('删除这条消息以及它之后的所有消息？此操作不可撤销。')) {
                      void remove(m.id)
                    }
                  }}
                >
                  <IconTrash size={13} />
                </button>
                <button
                  type="button"
                  className="msg-action-btn"
                  title="重新生成：回到产生本回答的指令，截断旧回答后重跑"
                  disabled={running}
                  onClick={() => void regenerate(m.id)}
                >
                  <IconRotateCcw size={13} />
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 单条消息（T4.1：memo 化）。
 *
 * 流式输出时 store 每个 delta 都会换掉 messages 数组并重渲整个列表，
 * 未 memo 的话「50 条历史 + 1 条在流」每次都要重建 51 棵子树 —— 输入直接掉帧。
 * props 只有 m，且未变动的消息对象引用是稳定的（只有正在流的那条会换引用），
 * 所以 memo 的浅比较正好命中。
 *
 * v2.1：每条消息外套一行 `.msg-row`，右侧挂一个 hover 才出现的复制按钮。
 * 报错信息（系统消息）同样可复制 —— 之前只能靠截图往外传，正是这次要解决的问题。
 *
 * v2.19：本轮回答不再从这里渲染（它带着收尾行与过程区，结构不同，由 `FinalResponseView`
 * 直接承载）—— 这里只剩"过程段"，props 也随之收窄到只有 `m`，memo 的浅比较更省。
 */
const MessageView = memo(function MessageView({ m }: { m: UiMessage }): ReactNode {
  if (m.kind === 'user') {
    return <UserMessageView m={m} />
  }
  if (m.kind === 'assistant') {
    return <AssistantStepBlock text={m.text} isLast={false} defaultOpen={false} />
  }
  if (m.kind === 'thinking') {
    return (
      <div className="msg-row thinking">
        <ThinkingBlock text={m.text} />
      </div>
    )
  }
  if (m.kind === 'system') {
    return (
      <div className="msg-row system">
        <div className={`msg-system${m.tone === 'error' ? ' error' : ''}`}>
          {m.tone === 'error' ? <IconAlertTriangle size={13} /> : <IconBot size={13} />}
          <span>{m.text}</span>
        </div>
        <MsgActions text={m.text} title="这条提示（报错原文可直接贴出去排查）" />
      </div>
    )
  }
  if (m.kind === 'finish') {
    // 兜底：收尾卡正常由所属轮渲染（挂回答上或单独成块），走到这里说明它被单独使用
    return <TurnCompleteBanner m={m} />
  }
  if (m.kind === 'plan') {
    return <PlanStepBlock steps={m.steps} />
  }
  return <ToolCard m={m} />
})

/**
 * 会话树动作组（v2.12）：「重新生成」与「删除」两个按钮的复用片段。
 *
 * 动作都从 store 取（`regenerateMessage` / `deleteMessage` 是 zustand 的稳定引用，
 * 订阅它们不破坏消息流的 memo）；`running` 只用来禁用按钮 —— 任务执行中截断会话树
 * 会与正在写入的分支互相踩。
 *
 * - 重新生成：回到产生这条回答的指令，截断旧回答后用原指令重跑（语义见 store 注释）。
 * - 删除：截断该节点及其全部后代 —— 树是前缀稳定的，删中间节点必然连子树一起走，
 *   所以确认文案说清「以及之后的所有消息」，避免误以为是单条删除。
 */
function TreeNodeActions({
  msgId,
  btnClass = 'msg-action-btn',
  size = 12
}: {
  msgId: string
  /** 按钮样式类：hover 操作条用 `msg-action-btn`，尾部状态行用 `turn-status-btn` */
  btnClass?: string
  size?: number
}): ReactNode {
  const regenerate = useApp((s) => s.regenerateMessage)
  const remove = useApp((s) => s.deleteMessage)
  const running = useApp((s) => s.agentRunning)
  return (
    <>
      <button
        type="button"
        className={btnClass}
        title="重新生成：回到产生本回答的指令，截断旧回答后重跑"
        disabled={running}
        onClick={() => void regenerate(msgId)}
      >
        <IconRotateCcw size={size} />
      </button>
      <button
        type="button"
        className={`${btnClass} danger`}
        title="删除本条及其之后的所有消息"
        disabled={running}
        onClick={() => {
          if (window.confirm('删除这条消息以及它之后的所有消息？此操作不可撤销。')) {
            void remove(msgId)
          }
        }}
      >
        <IconTrash size={size} />
      </button>
    </>
  )
}

/**
 * 消息气泡的 hover 操作条（v2.11，参考图 3）。
 *
 * 为什么从「一个复制按钮」扩成一排图标：参考图里 hover 气泡右下角出现的是一组
 * 高频动作（复制 / 引用 / 删除）。会话流里逐条右键太重，hover 就地给入口最省事。
 *
 * v2.12：`msgId` 存在时（该消息能映射到会话树节点）追加 重新生成 / 删除；
 * system 提示这类未落盘消息不传 `msgId`，保持只有复制与引用。
 * `text` 用于直接复制，`title` 是提示文案。
 */
function MsgActions({
  text,
  title,
  msgId
}: {
  text: string
  title: string
  msgId?: string
}): ReactNode {
  const quote = useApp((s) => s.quoteIntoInput)
  return (
    <div className="msg-actions">
      <CopyButton text={text} title={`复制${title}`} />
      {quote ? (
        <button
          type="button"
          className="msg-action-btn"
          title={`引用${title}到输入框`}
          onClick={() => quote(text)}
        >
          <IconQuote size={12} />
        </button>
      ) : null}
      {msgId ? <TreeNodeActions msgId={msgId} /> : null}
    </div>
  )
}

/**
 * 连续工具调用组（v2.11 改版，参考图 5）：默认收起成**一行语义摘要**。
 *
 * ```
 * › 工具调用  scan_devices, get_topology…            3 次完成  ⧉  ⌄
 * ```
 *
 * 摘要用「已读取 15 个文件，搜索 14 次文件，执行 11 条命令」这类**动作类型 × 次数**
 * （`@shared/tool-summary`），而不是罗列工具名 —— 工具名对用户无意义，
 * 「读了多少、改了多少」才是这一轮的关键信息。工具名退到 `title` 里 hover 可见。
 *
 * 展开时机（这也是「平常收起」的例外，必须保留）：**失败** 或 **正在执行**。
 * 后者尤其重要：执行中收起等于把「正在干什么」藏起来，用户会以为卡死。
 * 展开态不对全局收起/展开信号免疫 —— `useCollapsible` 已经处理。
 *
 * N16：`memo` 化 —— `items` 来自复用的段对象（`groupMessages` 的前缀复用），
 * 引用稳定，流式期间历史轮的工具组不再重渲染。
 */
const ToolGroup = memo(function ToolGroup({ items }: { items: ToolMsg[] }): ReactNode {
  const ok = items.filter((m) => m.status === 'ok').length
  const fail = items.filter((m) => m.status === 'fail').length
  const hasRunning = items.some((m) => m.status === 'running')
  // v2.11：平常收起（参考图 5）；仅失败或执行中例外展开
  const [open, setOpen] = useCollapsible(fail > 0 || hasRunning)

  useEffect(() => {
    if (fail > 0 || hasRunning) setOpen(true)
  }, [fail, hasRunning])

  const summaryText = useMemo(() => describeToolSummary(items), [items])
  const namesSummary = useMemo(
    () => Array.from(new Set(items.map((m) => m.name))).join(', '),
    [items]
  )

  return (
    <div className="agent-step-block tool-group-step">
      <div className="agent-step-head" onClick={() => setOpen((v) => !v)}>
        <span className="agent-step-icon">
          <IconTerminal size={13} style={{ color: '#38bdf8' }} />
        </span>
        <span className="agent-step-title">工具调用</span>
        <span className="agent-step-preview" title={namesSummary}>
          {summaryText}
        </span>
        <span className="agent-step-meta">
          <Chip tone={fail > 0 ? 'danger' : hasRunning ? 'warning' : 'success'}>
            {fail > 0 ? `失败 ${fail} · 成功 ${ok}` : hasRunning ? '执行中' : `${items.length} 次完成`}
          </Chip>
        </span>
        <CopyButton
          getText={() => items.map((m) => toolToText(m)).join('\n\n')}
          title="复制本组全部工具调用"
          variant="inline"
        />
        <IconChevronDown size={12} className={`agent-step-caret${open ? '' : ' closed'}`} />
      </div>
      {open ? (
        <div className="agent-step-body">
          <div className="agent-step-panel tool-panel">
            <div className="tool-group-list">
              {items.map((m) => (
                <ToolCard key={m.id} m={m} compact />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
})

/**
 * 助手消息步骤块（v2.4）：与思考信息、工具调用统一规范。
 * 中间说明默认折叠，折叠时仅保留单行紧凑头部（微图标 + 标题 + 首行微预览 + 展开箭头），
 * 最终回复默认展开且同样可折叠，使 AI 消息展示尽量折叠、消息长度变短。
 */
function AssistantStepBlock({
  text,
  isLast = false,
  defaultOpen = false
}: {
  text: string
  isLast?: boolean
  defaultOpen?: boolean
}): ReactNode {
  const [open, setOpen] = useCollapsible(defaultOpen)

  useEffect(() => {
    if (isLast) setOpen(true)
  }, [isLast])

  const preview = useMemo(() => {
    const firstLine = text.trim().split('\n')[0] ?? ''
    return firstLine.slice(0, 48)
  }, [text])

  const title = isLast ? '回复' : '日常信息'

  return (
    <div className={`agent-step-block assistant-step${isLast ? ' is-last' : ''}`}>
      <div className="agent-step-head" onClick={() => setOpen((v) => !v)}>
        <span className="agent-step-icon">
          <IconBot size={13} style={{ color: 'var(--agent, #60a5fa)' }} />
        </span>
        <span className="agent-step-title">{title}</span>
        <span className="agent-step-preview" title={preview}>
          {preview}
        </span>
        <CopyButton
          text={text}
          title={`复制${title}`}
          variant="inline"
        />
        <IconChevronDown size={12} className={`agent-step-caret${open ? '' : ' closed'}`} />
      </div>
      {open ? (
        <div className="agent-step-body">
          <div className="agent-step-panel assistant-panel">
            <MarkdownView text={text} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 思考块（v2.4）：对齐通用步骤流规范。
 * 默认折叠，展示单行摘要微预览，减少视觉噪声与页面垂直占用；点击整行展开/收起。
 *
 * v2.19：**不再接全局折叠信号，只认自己的点击**。
 *
 * 为什么要脱离全局：思考动辄几千字，"展开本轮过程"若把它一并铺开，正文会被顶到
 * 屏幕外 —— 过程区展开时应只看到它的一行摘要，想读全文再点它自己。
 * 用最朴素的局部 state 即可：过程区收起时整段不渲染，下次展开自然回到收起态
 * （不接 `useCollapsible` 就不会被 `CollapseSignal(open: true)` 批量拉开）。
 */
function ThinkingBlock({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const preview = useMemo(() => {
    const firstLine = text.trim().split('\n')[0] ?? ''
    return firstLine.slice(0, 48)
  }, [text])

  return (
    <div className="agent-step-block thinking-step">
      <div className="agent-step-head" onClick={() => setOpen((v) => !v)}>
        <span className="agent-step-icon">
          <IconSparkles size={12} style={{ color: '#a78bfa' }} />
        </span>
        <span className="agent-step-title">思考</span>
        <span className="agent-step-preview" title={preview}>
          {preview}
        </span>
        <CopyButton text={text} title="复制思考过程" variant="inline" />
        <IconChevronDown size={12} className={`agent-step-caret${open ? '' : ' closed'}`} />
      </div>
      {open ? (
        <div className="agent-step-body">
          <div className="agent-step-panel thinking-panel">
            <MarkdownView text={text} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 任务收尾行（v2.11 起，v2.19 收敛为「本轮过程开关」）：一行「任务已完成 · 任务耗时 10m 22s ›」。
 *
 * 三条铁律（都是从参考图反推的）：
 * ① **完成 / 中止 / 失败一律默认收起** —— 收尾后这一轮只剩「收尾行 + 最终回答」；
 * ② **点这一行 → 展开本轮的过程**（工具组 / 思考 / 日常信息 / 计划），再点收起。
 *    v2.19 起作用域是**本轮**，不再是整条消息流的全局总开关：多轮会话里
 *    展开第 3 轮不该把第 8 轮的过程也翻出来（各轮状态见 `AgentPanel.turnCollapse`）；
 * ③ 耗时行本身就是全部信息，**不再另开一期展开区** —— 用量与模型移到右下角状态行
 *    （见 `TurnStatusLine`），它们和耗时行是同一类元信息。
 *
 * N16：`memo` 化。props 全是稳定引用（`m` 是复用的段对象，
 * `onToggleTurn` 是 `useCallback` 的稳定函数，其余是字符串/布尔），
 * 于是流式输出时历史轮的收尾行完全不重渲染。
 * 回调签名改为 `(turnKey, onToggleTurn)` 而不是传内联箭头 —— 传箭头会让 memo 失效。
 */
const TurnCompleteBanner = memo(function TurnCompleteBanner({
  m,
  turnKey,
  onToggleTurn,
  allOpen = false
}: {
  m: Extract<UiMessage, { kind: 'finish' }>
  /** N16：本轮的 key（与 `onToggleTurn` 配对，避免为了传闭包而破坏 memo） */
  turnKey?: string
  onToggleTurn?: (key: string) => void
  allOpen?: boolean
}): ReactNode {
  const ok = m.reason === 'completed'
  const isAborted = m.reason === 'aborted'
  const lead = ok ? '任务已完成' : isAborted ? '任务已中止' : '任务未完成'
  const expand = turnKey && onToggleTurn ? (): void => onToggleTurn(turnKey) : undefined
  return (
    <div className={`turn-complete-banner ${m.reason}`}>
      <button
        type="button"
        className="turn-complete-head"
        onClick={expand}
        title="展开 / 收起本轮全部过程（工具调用 · 思考 · 参考内容）"
        disabled={!expand}
      >
        <span className="turn-complete-icon">
          {ok ? (
            <IconCheck size={13} />
          ) : isAborted ? (
            <IconPause size={13} />
          ) : (
            <IconAlertTriangle size={13} />
          )}
        </span>
        <span className="turn-complete-title">{lead}</span>
        <span className="turn-complete-time">任务耗时 {formatDuration(m.ms)}</span>
        {/*
         * v2.19：箭头**恒渲染**，不再挂在 `onExpandAll` 上。
         *
         * 收尾行本身就是「过程在这儿、可展开」的指示牌，少了箭头这行就退化成一句
         * 普通灰字 —— 用户报的「耗时的指示箭头消失」正是这种形态。回调缺失时按钮
         * 已经 disabled，箭头留着表达"这里本来有过程"，比整块消失诚实。
         */}
        <IconChevronDown size={12} className={`turn-complete-caret${allOpen ? '' : ' closed'}`} />
      </button>
    </div>
  )
})

/**
 * 类 Codex 最终交付成果视图（v2.11 改版 / v2.19 加过程区）。
 *
 * 结构对齐参考图：
 * ```
 * [品牌行]  🤖 AI 代理
 * [耗时行]  任务已中止 · 任务耗时 10m 22s ›   ← 点击 = 展开 / 收起**本轮过程**
 * [过程区]  日常信息 · 思考 · 工具调用 …      ← 仅展开时出现，收起时整段消失
 * [正文]    MarkdownView
 * [状态行]  ⏸ 手动终止输出 | [图标]        8.1k tokens · 3 轮 · deepseek-chat   ← 左下 / 右下
 * ```
 * 正文在耗时行**下方**：先给「这轮干了多久 / 结果在下面」的锚点，再读正文；
 * 与参考图的阅读顺序一致。
 *
 * v2.19 的关键变化：过程区不再是"每个块各占一行的平铺列表"，而是**整段可收**——
 * 收尾后默认收起（只剩耗时行 + 正文），点耗时行才把过程铺在耗时行与正文之间。
 * 过程区由调用方（`AgentPanel`）装配好传进来：它需要按轮过滤哪些段属于过程，
 * 那部分判断不该塞进这个纯展示组件里。
 *
 * N16：`memo` 化 + 回调改为 `(turnKey, onToggleTurn)`。
 * 这是全消息流最重的一棵子树（含 `MarkdownView`），而历史轮的 props 在流式期间
 * 完全不变（`text` / `msgId` 是字符串，`turnEnd` 是复用的段对象，`process` 折叠时是
 * `null`）—— memo 一挂，流式 delta 就只重渲染"正在进行的那一轮"。
 * **不要**把 `onToggleTurn` 换回内联箭头（那是 memo 失效的直接原因）。
 */
const FinalResponseView = memo(function FinalResponseView({
  text,
  turnEnd,
  turnKey,
  onToggleTurn,
  process,
  allOpen = false,
  msgId,
  streaming = false
}: {
  text: string
  turnEnd?: Extract<UiMessage, { kind: 'finish' }>
  /** N16：本轮 key（与 `onToggleTurn` 配对，避免传内联闭包破坏 memo） */
  turnKey?: string
  onToggleTurn?: (key: string) => void
  /** v2.19：本轮过程段（收起时为 null，整段不渲染） */
  process?: ReactNode
  /** v2.19：本轮过程区的开合态（决定收尾行箭头方向） */
  allOpen?: boolean
  /** R1：这条正文还在流式输出中（此时不解析 markdown，见 MarkdownView） */
  streaming?: boolean
  /** v2.12：本条回答在会话树中的 UI 消息 id —— 提供给尾部状态行的 重新生成/删除 */
  msgId?: string
}): ReactNode {
  const agentRunning = useApp((s) => s.agentRunning)
  const rootId = useApp((s) => s.activeRootId)

  const onExport = useCallback(async (): Promise<void> => {
    try {
      if (!rootId) {
        noteSystemMessageToStore('当前会话尚未落盘，稍后再试导出')
        return
      }
      const r = await window.api.session.export(rootId, 'md')
      noteSystemMessageToStore(`已导出报告：${r.path}`)
    } catch (e) {
      noteSystemMessageToStore(e instanceof Error ? e.message : String(e))
    }
  }, [rootId])

  // N16：传给 `TurnStatusLine` 的两个回调必须稳定引用，否则 memo 白挂
  const copyReply = useCallback((): string => text, [text])

  return (
    <div className="turn-final-response">
      <div className="turn-final-header">
        <div className="turn-brand">
          <span className="turn-avatar">
            <IconBot size={13} />
          </span>
          <span className="turn-name">AI 代理</span>
        </div>
      </div>
      {turnEnd ? (
        <TurnCompleteBanner m={turnEnd} {...(turnKey ? { turnKey } : {})} {...(onToggleTurn ? { onToggleTurn } : {})} allOpen={allOpen} />
      ) : null}
      {process ? <div className="turn-process">{process}</div> : null}
      <div className="turn-final-body">
        <MarkdownView text={text} streaming={streaming} />
      </div>
      <TurnStatusLine
        turnEnd={turnEnd}
        copyText={copyReply}
        onExport={onExport}
        running={agentRunning}
        msgId={msgId}
      />
    </div>
  )
})

/** 通知 store 追加一条系统消息（导出结果 / 失败提示）—— 借 noteSystemMessage */
function noteSystemMessageToStore(text: string): void {
  useApp.getState().noteSystemMessage(text, 'info')
}

/**
 * 尾部状态行（v2.11，参考图 4）：左下「⏸ 手动终止输出 | 复制 引用 导出」，右下「用量 · 模型」。
 *
 * 为什么以「手动终止输出」起头：中止/失败时用户最想知道的是「它是怎么结束的」——
 * 这句话就是结论；正常完成时换成「已完成」，语义一致但语气不同。
 * 右侧只留**用量 + 模型**这类客观运行信息，不放「由 AI 生成」这类署名式文案。
 *
 * N16：`memo` 化（props 全稳定 —— 两个回调由 `FinalResponseView` 用 `useCallback` 备好）。
 */
const TurnStatusLine = memo(function TurnStatusLine({
  turnEnd,
  copyText,
  onExport,
  running,
  msgId
}: {
  turnEnd?: Extract<UiMessage, { kind: 'finish' }>
  copyText: () => string
  onExport: () => void
  running: boolean
  /** v2.12：本条回答对应的消息 id —— 存在时在动作区追加 重新生成 / 删除 */
  msgId?: string
}): ReactNode {
  const quote = useApp((s) => s.quoteIntoInput)
  const reason = turnEnd?.reason
  // v2.13：本轮还没收尾（回答仍在流式输出 / 任务仍在跑）时不能说「已完成」——
  // 结束判定的唯一依据是本轮的收尾卡，不能再按位置猜。
  const pending = turnEnd === undefined && running
  const leadLabel = pending
    ? '输出中'
    : reason === 'aborted'
      ? '手动终止输出'
      : reason === 'failed'
        ? '执行失败'
        : '已完成'
  const usageLine = turnEnd?.usage ? describeTurnUsage(turnEnd.usage) : ''
  const meta = [usageLine, turnEnd?.model].filter(Boolean).join(' · ')

  return (
    <div className="turn-status-line">
      <span className="turn-status-lead">
        {pending || reason === 'aborted' || reason === 'failed' ? (
          <IconPause size={13} />
        ) : (
          <IconCheck size={13} />
        )}
        {leadLabel}
      </span>
      <span className="turn-status-actions">
        <CopyButton getText={copyText} title="复制本轮回答" variant="inline" className="turn-status-btn" />
        {quote ? (
          <button
            type="button"
            className="turn-status-btn"
            title="引用本轮回答到输入框"
            onClick={() => quote(copyText())}
            disabled={running}
          >
            <IconQuote size={13} />
          </button>
        ) : null}
        {/* v2.12：对这条回答的 重新生成 / 删除（能映射到会话树时才出现） */}
        {msgId ? <TreeNodeActions msgId={msgId} btnClass="turn-status-btn" size={13} /> : null}
        <button
          type="button"
          className="turn-status-btn"
          title="把本会话导出为 Markdown 报告"
          onClick={onExport}
          disabled={running}
        >
          <IconUpload size={13} />
        </button>
      </span>
      {meta ? <span className="turn-status-meta">{meta}</span> : null}
    </div>
  )
})

/**
 * 执行计划步骤块（类 Codex 步骤流规范）
 */
function PlanStepBlock({ steps }: { steps: string[] }): ReactNode {
  const [open, setOpen] = useCollapsible(true)
  const preview = steps[0] ? `第 1 步: ${steps[0]}` : ''

  return (
    <div className="agent-step-block plan-step-block">
      <div className="agent-step-head" onClick={() => setOpen((v) => !v)}>
        <span className="agent-step-icon">
          <IconSparkles size={12} style={{ color: 'var(--warning, #f59e0b)' }} />
        </span>
        <span className="agent-step-title">执行计划</span>
        <span className="agent-step-preview" title={preview}>
          {preview}
        </span>
        <span className="agent-step-meta">
          <Chip tone="agent">{steps.length} 步</Chip>
        </span>
        <CopyButton
          getText={() => steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
          title="复制计划步骤"
          variant="inline"
        />
        <IconChevronDown size={12} className={`agent-step-caret${open ? '' : ' closed'}`} />
      </div>
      {open ? (
        <div className="agent-step-body">
          <div className="agent-step-panel plan-panel">
            <div className="plan-steps-compact">
              {steps.map((s, i) => (
                <div key={i} className="plan-step-compact-item">
                  <span className="idx">{i + 1}</span>
                  <span>{s}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** 收尾头专用的耗时格式：分钟级任务不再以几百秒的形态出现（2m 8s） */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/**
 * 单次工具调用卡。
 *
 * N16：`memo` 化 —— props 是 `m`（复用的消息对象）+ `compact`，
 * 状态没变时（`status` / `ms` / `raw` 都不动）不再整块重渲染。
 */
const ToolCard = memo(function ToolCard({
  m,
  compact = false
}: {
  m: Extract<UiMessage, { kind: 'tool' }>
  compact?: boolean
}): ReactNode {
  // 失败的调用默认展开，让人第一眼就看到原因
  const [open, setOpen] = useCollapsible(m.status === 'fail')

  useEffect(() => {
    if (m.status === 'fail') setOpen(true)
  }, [m.status])

  const tone = m.status === 'ok' ? 'success' : m.status === 'fail' ? 'danger' : 'warning'
  const label = m.status === 'ok' ? '完成' : m.status === 'fail' ? '失败' : '执行中'

  const content = (
    <>
      <div className="tool-head" onClick={() => setOpen((v) => !v)}>
        <IconChevronDown size={11} className={`collapse-caret${open ? '' : ' closed'}`} />
        <span className={`dot ${m.status === 'running' ? 'pending' : m.status === 'ok' ? 'up' : 'err'}`} />
        <span className="tool-name">{m.name}</span>
        <Chip tone={tone}>{label}</Chip>
        {m.risk === 'danger' ? <Chip tone="danger">高危</Chip> : null}
        <CopyButton
          getText={() => toolToText(m)}
          title="复制本次调用（参数 + 原始回显）"
          variant="inline"
        />
        <span className="tool-ms">{m.ms !== undefined ? formatMs(m.ms) : ''}</span>
      </div>

      {open ? (
        <div className="tool-body">
          {m.summary ? (
            <div className="tool-summary">
              {m.summary}
              {m.errorCode ? (
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--danger)' }}> · {m.errorCode}</span>
              ) : null}
            </div>
          ) : null}
          <div style={{ color: 'var(--text-muted)' }}>参数</div>
          <div>{safeJson(m.args)}</div>
          {m.raw ? (
            <>
              <div style={{ color: 'var(--text-muted)', marginTop: 8 }}>原始回显</div>
              <RawBlock text={m.raw} />
            </>
          ) : null}
          {/* v2.9：结构化结果卡（目前只有快照 diff 有） */}
          <StructuredResult name={m.name} data={m.data} cardMeta={m.cardMeta} />
        </div>
      ) : null}
    </>
  )

  if (compact) {
    return <div className="tool-group-item">{content}</div>
  }

  return (
    <div className="agent-step-block tool-step">
      <div className="agent-step-body" style={{ marginLeft: 0 }}>
        <div className="agent-step-panel tool-panel">{content}</div>
      </div>
    </div>
  )
})

/**
 * v2.9：长回显二级折叠 —— 头 RAW_COLLAPSE_LINES 行 + 「展开全部 N 行」。
 *
 * 与工具卡自身的折叠是两级：卡片收起时完全看不到回显，
 * 卡片展开后回显本身还可能几百行，这一级专门治「展开了但整屏都是配置」。
 */
function RawBlock({ text }: { text: string }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const plan = useMemo(() => planRawCollapse(text), [text])

  if (!plan.collapses || expanded) {
    return (
      <div className="tool-raw">
        {plan.collapses ? text : plan.visible.join('\n')}
        {plan.collapses ? (
          <button className="raw-expand-toggle" onClick={() => setExpanded(false)}>
            收起（共 {plan.visible.length + plan.hiddenCount} 行）
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="tool-raw">
      {plan.visible.join('\n')}
      <div className="raw-collapsed-tail">… 已省略 {plan.hiddenCount} 行</div>
      <button className="raw-expand-toggle" onClick={() => setExpanded(true)}>
        展开全部 {plan.visible.length + plan.hiddenCount} 行
      </button>
    </div>
  )
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/**
 * v2.9：结构化结果卡。
 *
 * 认得出形状就画卡（目前只有 `diff_with_snapshot`），认不出什么都不画 ——
 * 结果本身已经在「原始回显」里，卡片只是把它整理得更好读，不是唯一信息源。
 *
 * v2.14（H）：`data` 是**当次**的（`tool_end.data`），回放/历史里没有它，
 * 那时改用落盘的 `cardMeta`（`toolCall.cardMeta`）。两者形状一致，差别只在
 * cardMeta 里的数组已被工具截断、并带 `*Total` 总数（所以计数走 `lineTotalOf`）。
 * 实时优先用 `data`（未截断，信息更全）。
 */
function StructuredResult({
  name,
  data,
  cardMeta
}: {
  name: string
  data: unknown
  cardMeta?: unknown
}): ReactNode {
  const source = data ?? cardMeta
  const view = useMemo(() => buildStructuredView(name, source), [name, source])
  if (!view) return null
  if (view.kind === 'diff') return <DiffCard v={view} />
  return null
}

/** 配置变更对比卡：added / removed 分色列表（红加绿删不符合本项目口径，用词区分） */
function DiffCard({ v }: { v: DiffView }): ReactNode {
  const [showAll, setShowAll] = useState(false)
  const cut = (lines: string[]): string[] =>
    showAll ? lines : lines.slice(0, DIFF_PREVIEW_LINES)
  const addedTotal = lineTotalOf(v.added, v.addedTotal)
  const removedTotal = lineTotalOf(v.removed, v.removedTotal)
  const overflow = !showAll && (v.added.length > DIFF_PREVIEW_LINES || v.removed.length > DIFF_PREVIEW_LINES)
  /**
   * v2.14：手里确实还有更多行可展开吗？回放时 cardMeta 已被工具截到 40 行，
   * 那时「查看全部」按下去也不会多出一行 —— 改为如实说明「仅显示前 N 行」。
   */
  const truncated = addedTotal > v.added.length || removedTotal > v.removed.length

  return (
    <div className="structured-card diff-card">
      <div className="structured-head">
        <span className="structured-title">配置变更对比</span>
        {v.deviceId ? <span className="structured-device">{v.deviceId}</span> : null}
        <Chip tone={v.changed ? 'warning' : 'success'}>{describeDiff(v)}</Chip>
      </div>
      {v.changed ? (
        <div className="diff-cols">
          <div className="diff-col">
            <div className="diff-col-head">新增 {addedTotal} 行</div>
            <pre className="diff-lines added">
              {cut(v.added).join('\n') || '（无）'}
            </pre>
          </div>
          <div className="diff-col">
            <div className="diff-col-head">删除 {removedTotal} 行</div>
            <pre className="diff-lines removed">
              {cut(v.removed).join('\n') || '（无）'}
            </pre>
          </div>
        </div>
      ) : (
        <div className="structured-note">与快照一致，设备配置没有被改动。</div>
      )}
      {overflow ? (
        <button className="raw-expand-toggle" onClick={() => setShowAll(true)}>
          查看全部（新增 {v.added.length} / 删除 {v.removed.length} 行）
        </button>
      ) : null}
      {!overflow && truncated ? (
        <div className="structured-note">
          历史记录里每侧最多保留 {DIFF_PREVIEW_LINES} 行，未展开的部分见当次对话的原始回显或报告导出。
        </div>
      ) : null}
      {v.snapshotId ? <div className="structured-foot">对比快照：{v.snapshotId}</div> : null}
    </div>
  )
}