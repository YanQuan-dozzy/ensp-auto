import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useApp, type UiMessage } from '@/stores/app'
import type { SessionNode, SessionNodeMeta } from '@shared/types'
import { Chip, Empty, PanelHeader, formatMs } from '@/components/ui'

/**
 * 右栏 AI 面板。
 *
 * 「纯代理」模式下这一栏是产品主轴：
 * - 常驻可见，执行轨迹逐步可见（计划 / 工具调用 / 原始回显）
 * - 执行中仍可输入 → 进入队列（v0.4 真正接上，不再只是 promise）
 * - v0.4：顶部「当前 / 历史」两个 tab —— 历史是会话树浏览器，
 *   根列表 → 展开节点 → 「从这里继续」（换路重走）/「导出」报告
 */

export function AgentPanel(): ReactNode {
  const messages = useApp((s) => s.messages)
  const running = useApp((s) => s.agentRunning)
  const runtime = useApp((s) => s.agentRuntime)
  const hasApiKey = useApp((s) => s.hasApiKey)
  const model = useApp((s) => s.settings.agent.model)
  const queueCount = useApp((s) => s.queueCount)
  const sessions = useApp((s) => s.sessions)
  const activeRootId = useApp((s) => s.activeRootId)
  const send = useApp((s) => s.send)
  const abort = useApp((s) => s.abort)
  const clear = useApp((s) => s.clearConversation)
  const newSession = useApp((s) => s.newSession)

  const [tab, setTab] = useState<'live' | 'history'>('live')
  const [text, setText] = useState('')
  const streamRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, running, tab])

  const autoGrow = (): void => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`
  }

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    setText('')
    requestAnimationFrame(autoGrow)
    void send(t)
  }

  const activeSession = sessions.find((s) => s.id === activeRootId)

  return (
    <div className="col">
      <PanelHeader
        title={`AI 代理 · ${activeSession?.title ?? '新会话'}`}
        actions={
          <>
            <div className="agent-tabs">
              <button className={`btn ghost${tab === 'live' ? ' primary' : ''}`} onClick={() => setTab('live')}>
                当前
              </button>
              <button className={`btn ghost${tab === 'history' ? ' primary' : ''}`} onClick={() => setTab('history')}>
                历史
              </button>
            </div>
            {tab === 'live' ? (
              <>
                {running ? (
                  <>
                    <Chip tone="warning">运行中</Chip>
                    <button className="btn" onClick={abort}>
                      中断
                    </button>
                  </>
                ) : null}
                <button className="btn" onClick={newSession} title="开始新会话（不清除历史）">
                  新会话
                </button>
                {messages.length > 0 ? (
                  <button className="btn ghost" onClick={clear} title="清空当前视图">
                    清空
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
            <div className="banner pending">未配置模型 API Key，当前使用 mock 运行时（固定回放，不调用模型）</div>
          ) : null}

          <div className="agent-stream" ref={streamRef}>
            {messages.length === 0 ? (
              <Empty>
                <span>用一句话下达实验目标</span>
                <span style={{ fontSize: 'var(--text-xs)' }}>
                  例如：扫描本机设备，连上第一台，告诉我它的型号和接口状态
                </span>
              </Empty>
            ) : (
              messages.map((m) => <MessageView key={m.id} m={m} />)
            )}
          </div>

          <div className="agent-input">
            <textarea
              ref={taRef}
              value={text}
              placeholder={running ? '代理执行中，输入将进入队列…' : '描述实验目标，Enter 发送 / Shift+Enter 换行'}
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
              <span className="agent-input-meta" title={`${model} · ${runtime}`}>
                {model} · {runtime === 'mock' ? 'mock 运行时' : '真实运行时'}
                {running ? ' · 执行中' : ''}
                {queueCount > 0 ? (
                  <Chip tone="warning">已排队 ×{queueCount}</Chip>
                ) : null}
              </span>
              <button className="btn primary" onClick={submit} disabled={!text.trim()}>
                发送
              </button>
            </div>
          </div>
        </>
      ) : (
        <SessionHistory />
      )}
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

function MessageView({ m }: { m: UiMessage }): ReactNode {
  if (m.kind === 'user') return <div className="msg-user">{m.text}</div>
  if (m.kind === 'assistant') return <div className="msg-assistant">{m.text}</div>
  if (m.kind === 'system') {
    return <div className={`msg-system${m.tone === 'error' ? ' error' : ''}`}>{m.text}</div>
  }
  if (m.kind === 'plan') {
    return (
      <div className="card">
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>计划 {m.steps.length} 步</div>
        <div className="plan-steps">
          {m.steps.map((s, i) => (
            <div key={i}>
              <span className="idx">{i + 1}</span>
              {s}
            </div>
          ))}
        </div>
      </div>
    )
  }
  return <ToolCard m={m} />
}

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
        {m.risk === 'danger' ? <Chip tone="danger">危险</Chip> : null}
        <span className="tool-ms">
          {m.ms !== undefined ? formatMs(m.ms) : ''} {open ? '收起' : '展开'}
        </span>
      </div>

      {m.summary ? (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 4 }}>
          {m.summary}
          {m.errorCode ? (
            <span style={{ fontFamily: 'var(--font-mono)' }}> · {m.errorCode}</span>
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