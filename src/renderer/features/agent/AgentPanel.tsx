import { memo, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useApp, type UiMessage } from '@/stores/app'
import type { SessionNode, SessionNodeMeta } from '@shared/types'
import { activeProfileOf } from '@shared/profiles'
import { formatBytes, kindLabel } from '@shared/attachments'
import { ALL_PROVIDERS } from '@shared/providers'
import { pickRandomGoals, QUICK_PROMPT_COUNT } from '@shared/goals'
import { McpDialog } from './McpDialog'
import {
  Chip,
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
  IconClose
} from '@/components/ui'

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
  const running = useApp((s) => s.agentRunning)
  const runtime = useApp((s) => s.agentRuntime)
  const hasApiKey = useApp((s) => s.hasApiKey)
  const queueCount = useApp((s) => s.queueCount)
  const sessions = useApp((s) => s.sessions)
  const activeRootId = useApp((s) => s.activeRootId)
  const send = useApp((s) => s.send)
  const abort = useApp((s) => s.abort)
  const clear = useApp((s) => s.clearConversation)
  const newSession = useApp((s) => s.newSession)
  // v1.5：输入区能力（附件 / 模型档案 / 提示词增强 / MCP）
  const profiles = useApp((s) => s.settings.agent.profiles)
  const activeProfileId = useApp((s) => s.settings.agent.activeProfileId)
  const activeProfile = useApp((s) => activeProfileOf(s.settings))
  const configuredProfileIds = useApp((s) => s.configuredProfileIds)
  const attachments = useApp((s) => s.attachments)
  const pickAttachments = useApp((s) => s.pickAttachments)
  const importAttachmentPaths = useApp((s) => s.importAttachmentPaths)
  const removeAttachment = useApp((s) => s.removeAttachment)
  const setActiveProfile = useApp((s) => s.setActiveProfile)
  const enhanceDraft = useApp((s) => s.enhanceDraft)
  const enhancing = useApp((s) => s.enhancing)
  const mcpServers = useApp((s) => s.mcpServers)

  const [tab, setTab] = useState<'live' | 'history'>('live')
  const [text, setText] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const streamRef = useRef<HTMLDivElement | null>(null)
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

  const onStreamScroll = (): void => {
    const el = streamRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    // 只在用户本来就贴着底部时自动滚到底；上翻看历史时不再被流式输出拽回
    if (stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, running, tab])

  const autoGrow = (): void => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
  }

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
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

  const mcpOkCount = mcpServers.filter((m) => m.connected).length
  const activeSession = sessions.find((s) => s.id === activeRootId)

  return (
    <div className="col">
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
                {messages.length > 0 ? (
                  <button className="btn sm ghost" onClick={clear} title="清空当前消息流">
                    <IconTrash size={12} />
                  </button>
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

          <div className="agent-stream" ref={streamRef} onScroll={onStreamScroll}>
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
              messages.map((m) => <MessageView key={m.id} m={m} />)
            )}
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
              {attachments.length > 0 ? (
                <div className="attach-list">
                  {attachments.map((a) => (
                    <span key={a.id} className={`attach-chip ${a.kind}`} title={a.path}>
                      <IconPaperclip size={11} />
                      <span className="attach-name">{a.name}</span>
                      <span className="attach-meta">
                        {formatBytes(a.size)} · {kindLabel(a.kind)}
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
                        <div className="menu-backdrop" onClick={() => setModelMenuOpen(false)} />
                        <div className="model-menu" role="menu">
                          {profiles.map((p) => (
                            <button
                              key={p.id}
                              className={`model-menu-item${p.id === activeProfileId ? ' active' : ''}`}
                              onClick={() => {
                                setModelMenuOpen(false)
                                void setActiveProfile(p.id)
                              }}
                            >
                              <span className="model-menu-label">{p.label}</span>
                              <span className="model-menu-sub">
                                {ALL_PROVIDERS[p.provider]?.label ?? p.provider} · {p.model}
                                {configuredProfileIds.includes(p.id) ? '' : ' · 未配密钥'}
                              </span>
                            </button>
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
        <SessionHistory />
      )}

      {mcpOpen ? <McpDialog onClose={() => setMcpOpen(false)} /> : null}
    </div>
  )
}

/** 历史会话：根列表 → 展开会话树 → 节点级「从这里继续」+ 会话级「导出」 */
function SessionHistory(): ReactNode {
  const sessions = useApp((s) => s.sessions)
  const continueFrom = useApp((s) => s.continueFrom)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [trees, setTrees] = useState<Record<string, SessionNode[]>>({})
  const [notice, setNotice] = useState('')

  const toggle = async (meta: SessionNodeMeta): Promise<void> => {
    if (expanded === meta.id) {
      setExpanded(null)
      return
    }
    if (!trees[meta.id]) {
      try {
        const nodes = await window.api.session.get(meta.id)
        setTrees((t) => ({ ...t, [meta.id]: nodes }))
      } catch {
        setNotice('读取会话失败')
        return
      }
    }
    setExpanded(meta.id)
  }

  const onExport = async (rootId: string, format: 'md' | 'json'): Promise<void> => {
    try {
      const r = await window.api.session.export(rootId, format)
      setNotice(`已导出：${r.path}`)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  const onContinue = (rootId: string, node: SessionNode): void => {
    void continueFrom(rootId, node)
  }

  return (
    <div className="agent-stream">
      {sessions.length === 0 ? (
        <Empty>
          <span>还没有历史会话</span>
          <span style={{ fontSize: 'var(--text-xs)' }}>发一条指令后，这里会出现可回溯的会话树</span>
        </Empty>
      ) : (
        <>
          {notice ? <div className="banner info">{notice}</div> : null}
          {sessions.map((meta) => {
            const nodes = trees[meta.id]
            return (
              <div key={meta.id} className="card" style={{ marginBottom: 8 }}>
                <div
                  className="tool-head"
                  onClick={() => void toggle(meta)}
                  style={{ cursor: 'pointer' }}
                >
                  <span className="tool-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
  {meta.title}
</span>
                  <Chip tone="agent">{meta.nodeCount} 条</Chip>
                  <span className="tool-ms">
                    {new Date(meta.updatedAt).toLocaleString('zh-CN')} {expanded === meta.id ? '收起' : '展开'}
                  </span>
                </div>
                <div className="tool-head" style={{ gap: 6 }}>
                  <button
                    className="btn"
                    onClick={() => void onExport(meta.id, 'md')}
                    title="导出 Markdown 报告"
                  >
                    导出 md
                  </button>
                  <button
                    className="btn"
                    onClick={() => void onExport(meta.id, 'json')}
                    title="导出 JSON 报告"
                  >
                    导出 json
                  </button>
                </div>
                {expanded === meta.id && nodes ? (
                  <div className="history-tree">
                    {renderTree(nodes, onContinue)}
                  </div>
                ) : null}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

function renderTree(
  nodes: SessionNode[],
  onContinue: (rootId: string, node: SessionNode) => void
): ReactNode {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const depth = new Map<string, number>()
  for (const n of nodes) {
    let d = 0
    let cur: SessionNode | undefined = n
    const seen = new Set<string>()
    while (cur?.parentId && !seen.has(cur.id)) {
      seen.add(cur.id)
      d += 1
      cur = byId.get(cur.parentId)
    }
    depth.set(n.id, d)
  }

  return nodes.map((n) => {
    const tc = n.toolCall
    const label =
      n.role === 'user'
        ? n.content
        : n.role === 'assistant'
          ? n.content.slice(0, 80)
          : `[工具] ${tc?.name ?? n.content}${tc?.ok === false ? '（失败）' : ''}`
    return (
      <div
        key={n.id}
        className="history-node"
        style={{ marginLeft: Math.min(depth.get(n.id) ?? 0, 6) * 14 }}
      >
        <span className={`dot ${n.role === 'tool' && tc?.ok === false ? 'err' : n.role === 'tool' ? 'up' : 'pending'}`} />
        <span className="history-node-text">{label}</span>
        <button
          className="btn"
          title="从这里继续，后面的消息将成为它的新分支"
          onClick={() => onContinue(findRootId(nodes, n), n)}
        >
          继续
        </button>
      </div>
    )
  })
}

function findRootNode(nodes: SessionNode[], n: SessionNode): SessionNode {
  const byId = new Map(nodes.map((x) => [x.id, x]))
  let cur = n
  const seen = new Set<string>()
  while (cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id)
    const p = byId.get(cur.parentId)
    if (!p) break
    cur = p
  }
  return cur
}

function findRootId(nodes: SessionNode[], n: SessionNode): string {
  return findRootNode(nodes, n).id
}

/**
 * 单条消息（T4.1：memo 化）。
 *
 * 流式输出时 store 每个 delta 都会换掉 messages 数组并重渲整个列表，
 * 未 memo 的话「50 条历史 + 1 条在流」每次都要重建 51 棵子树 —— 输入直接掉帧。
 * props 只有 m，且未变动的消息对象引用是稳定的（只有正在流的那条会换引用），
 * 所以 memo 的浅比较正好命中。
 */
const MessageView = memo(function MessageView({ m }: { m: UiMessage }): ReactNode {
  if (m.kind === 'user') return <div className="msg-user">{m.text}</div>
  if (m.kind === 'assistant') return <div className="msg-assistant">{m.text}</div>
  if (m.kind === 'system') {
    return <div className={`msg-system${m.tone === 'error' ? ' error' : ''}`}>{m.text}</div>
  }
  if (m.kind === 'plan') {
    return (
      <div className="card">
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)' }}>
          <IconSparkles size={14} style={{ color: 'var(--accent)' }} />
          执行计划
          <Chip tone="agent">{m.steps.length} 步</Chip>
        </div>
        <div className="plan-steps">
          {m.steps.map((s, i) => (
            <div key={i} className="plan-step-item">
              <span className="idx">{i + 1}</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }
  return <ToolCard m={m} />
})

function ToolCard({
  m
}: {
  m: Extract<UiMessage, { kind: 'tool' }>
}): ReactNode {
  // 失败的调用默认展开，让人第一眼就看到原因
  const [open, setOpen] = useState(m.status === 'fail')

  useEffect(() => {
    if (m.status === 'fail') setOpen(true)
  }, [m.status])

  const tone = m.status === 'ok' ? 'success' : m.status === 'fail' ? 'danger' : 'warning'
  const label = m.status === 'ok' ? '完成' : m.status === 'fail' ? '失败' : '执行中'

  return (
    <div className="card">
      <div className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className={`dot ${m.status === 'running' ? 'pending' : m.status === 'ok' ? 'up' : 'err'}`} />
        <span className="tool-name">{m.name}</span>
        <Chip tone={tone}>{label}</Chip>
        {m.risk === 'danger' ? <Chip tone="danger">高危</Chip> : null}
        <span className="tool-ms">
          {m.ms !== undefined ? formatMs(m.ms) : ''} · {open ? '收起' : '展开详情'}
        </span>
      </div>

      {m.summary ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.45 }}>
          {m.summary}
          {m.errorCode ? (
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--danger)' }}> · {m.errorCode}</span>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div className="tool-body">
          <div style={{ color: 'var(--text-muted)' }}>参数</div>
          <div>{safeJson(m.args)}</div>
          {m.raw ? (
            <>
              <div style={{ color: 'var(--text-muted)', marginTop: 8 }}>原始回显</div>
              <div>{m.raw}</div>
            </>
          ) : null}
        </div>
      ) : null}
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