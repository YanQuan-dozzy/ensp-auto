import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import type { BranchComparison, DiffRow, SessionNode, ToolStep } from '@shared/types'
import {
  AdaptiveToolbar,
  AdaptiveButton,
  DismissibleBanner,
  IconRefresh,
  IconRotateCcw,
  IconSparkles
} from '@/components/ui'

/**
 * 执行轨迹（F11）。
 *
 * 数据全部来自会话树（`session.get`）—— 工具节点天然就是「按时间排好序的步骤序列」，
 * 所以「回放」不需要另建存储：把 role === 'tool' 的节点排成一条，游标走一遍即可。
 * 当前步的 args.deviceId 写进 store，由拓扑画布消费成节点高亮。
 *
 * 分支对比（F8）在同一棵树上就地展开：找 parentId 相同、兄弟 ≥ 2 的分叉点，
 * 两侧各取一个子节点交给主进程 `session.compare` 计算，渲染层只负责展示。
 */

const ROLE_TEXT: Record<SessionNode['role'], string> = {
  user: '指令',
  assistant: '回答',
  tool: '工具',
  thinking: '思考'
}

const DIFF_PREFIX: Record<DiffRow['kind'], string> = { same: '=', onlyA: '-', onlyB: '+' }

/** 回放粒度：所有工具节点 */
const PLAY_INTERVAL_MS = 1200

/** N17：轨迹长列表首屏步数（其余按「显示更多」追加） */
const TRACE_PAGE_SIZE = 120

function fmtTime(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** 取首行并截断：列表里内容可能是多行长文本，不截断会把行撑爆 */
function firstLine(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  const t = line.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 步骤/书签行的主文本：工具节点展示工具名（内容只是回显摘要） */
function nodeLabel(n: SessionNode): string {
  return n.role === 'tool' ? n.toolCall?.name ?? n.content : n.content
}

function stepStatus(ok: boolean | undefined): string {
  if (ok === undefined) return '…'
  return ok ? '✔' : '✘'
}

interface Fork {
  parent: SessionNode
  children: SessionNode[]
}

function MetricRow({ label, a, b }: { label: string; a: string; b: string }): ReactNode {
  return (
    <div className="trace-metric-row">
      <span>{label}</span>
      <span className="mono">{a}</span>
      <span className="mono">{b}</span>
    </div>
  )
}

function stepText(s: ToolStep): ReactNode {
  return (
    <>
      <span className={`trace-state${s.ok === false ? ' fail' : ''}`}>{stepStatus(s.ok)}</span>
      <span className="trace-diff-name mono">{s.name}</span>
      {/* argKey 可能很长：正文截断，完整值走 title */}
      <span className="trace-arg mono" title={s.argKey}>
        ({s.argKey})
      </span>
      <span className="trace-ms mono">{s.ms !== undefined ? `${s.ms}ms` : ''}</span>
    </>
  )
}

function DiffRowView({ row }: { row: DiffRow }): ReactNode {
  return (
    <div className={`trace-diff-row ${row.kind}`}>
      <span className="trace-diff-prefix mono">{DIFF_PREFIX[row.kind]}</span>
      <div className="trace-diff-side a">
        {row.a ? stepText(row.a) : <span className="trace-diff-none">-</span>}
      </div>
      <div className="trace-diff-side b">
        {row.b ? stepText(row.b) : <span className="trace-diff-none">-</span>}
      </div>
    </div>
  )
}

/**
 * 可折叠区块标题（整行可点，▸ / ▾ 指示状态）。
 *
 * 折叠态只是不渲染内容，**不影响回放游标**：游标指着第 i 步，折叠后再展开仍在第 i 步。
 */
function SectionHead({
  title,
  collapsed,
  onToggle,
  extra
}: {
  title: string
  collapsed: boolean
  onToggle: () => void
  extra?: ReactNode
}): ReactNode {
  return (
    <div
      className="trace-section-title clickable"
      onClick={onToggle}
      title={collapsed ? '展开' : '收起'}
    >
      <span className="trace-caret">{collapsed ? '▸' : '▾'}</span>
      <span>{title}</span>
      {extra}
    </div>
  )
}

export function TracePanel(): ReactNode {
  const activeRootId = useApp((s) => s.activeRootId)
  const sessions = useApp((s) => s.sessions)
  const topoHighlightDeviceId = useApp((s) => s.topoHighlightDeviceId)
  const setTopoHighlight = useApp((s) => s.setTopoHighlight)
  const loadSkills = useApp((s) => s.loadSkills)

  // 节点数据是本面板的私有视图状态，不进全局 store（别的标签页不关心它）
  const [nodes, setNodes] = useState<SessionNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [comparison, setComparison] = useState<BranchComparison | null>(null)
  const [compareError, setCompareError] = useState<string | null>(null)
  const [exportNote, setExportNote] = useState<string | null>(null)
  const [aSel, setASel] = useState('')
  const [bSel, setBSel] = useState('')
  const [comparing, setComparing] = useState(false)
  /** F13：沉淀排障技能的过程与结果提示 */
  const [distilling, setDistilling] = useState(false)
  const [distillNote, setDistillNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  /**
   * 面板自身的信息量控制。
   *
   * 会话一长，步骤列表 + 书签 + 对比结果三块叠起来会把这一栏撑到没法用；
   * 所以三块都可折叠（默认全展开），步骤列表另给「只看失败」筛选。
   */
  const [closed, setClosed] = useState<{ steps: boolean; bookmarks: boolean; compare: boolean }>({
    steps: false,
    bookmarks: false,
    compare: false
  })
  const [onlyFailed, setOnlyFailed] = useState(false)
  const timerRef = useRef<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!activeRootId) {
      setNodes([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      setNodes(await window.api.session.get(activeRootId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [activeRootId])

  // 切换会话必须整体复位：节点 id 体系换了，旧的游标 / 选中分支都失去意义
  useEffect(() => {
    setStepIndex(0)
    setPlaying(false)
    setComparison(null)
    setCompareError(null)
    setExportNote(null)
    setASel('')
    setBSel('')
    setDistillNote(null)
    setClosed({ steps: false, bookmarks: false, compare: false })
    setOnlyFailed(false)
    void load()
  }, [load])

  const sessionTitle = sessions.find((s) => s.id === activeRootId)?.title ?? '未命名会话'

  const steps = useMemo(
    () =>
      nodes
        .filter((n) => n.role === 'tool')
        .sort((a, b) =>
          a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        ),
    [nodes]
  )

  // 刷新后节点可能变少，把游标夹回有效范围，否则「第 i / N 步」会越界
  useEffect(() => {
    setStepIndex((i) => (steps.length === 0 ? 0 : Math.min(i, steps.length - 1)))
  }, [steps])

  useEffect(() => {
    if (!playing) return
    timerRef.current = window.setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, steps.length - 1))
    }, PLAY_INTERVAL_MS)
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [playing, steps.length])

  // 走到末尾自动收停（放在独立 effect 里，避免在上面的 updater 里再 setState）
  useEffect(() => {
    if (playing && steps.length > 0 && stepIndex >= steps.length - 1) setPlaying(false)
  }, [playing, stepIndex, steps.length])

  // 当前步 → 拓扑高亮。约定「这一步在操作哪台设备」记在 args.deviceId 上
  useEffect(() => {
    const args = steps[stepIndex]?.toolCall?.args
    const deviceId =
      args && typeof args === 'object' && typeof (args as Record<string, unknown>).deviceId === 'string'
        ? ((args as Record<string, unknown>).deviceId as string)
        : null
    setTopoHighlight(deviceId)
  }, [steps, stepIndex, setTopoHighlight])

  // 分叉点：parentId 相同且兄弟 ≥ 2 的那个父节点
  const forks = useMemo<Fork[]>(() => {
    const kids = new Map<string, SessionNode[]>()
    for (const n of nodes) {
      if (!n.parentId) continue
      const arr = kids.get(n.parentId)
      if (arr) arr.push(n)
      else kids.set(n.parentId, [n])
    }
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const out: Fork[] = []
    for (const [pid, list] of kids) {
      if (list.length < 2) continue
      const parent = byId.get(pid)
      if (!parent) continue
      list.sort((a, b) =>
        a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      )
      out.push({ parent, children: list })
    }
    // 排序只为「默认选中第一组分叉点」稳定可复现
    out.sort((x, y) =>
      x.parent.createdAt !== y.parent.createdAt ? x.parent.createdAt - y.parent.createdAt : x.parent.id < y.parent.id ? -1 : 1
    )
    return out
  }, [nodes])

  const branches = useMemo(() => forks.filter((f) => f.children.length >= 2), [forks])
  const canCompare = branches.length > 0

  // 默认选第一组分叉点的第 1 / 第 2 个子节点；已有选择仍有效时保留
  useEffect(() => {
    if (!canCompare) return
    const first = branches[0]
    if (!first) return
    const [c1, c2] = first.children
    if (!c1 || !c2) return
    const ids = new Set(nodes.map((n) => n.id))
    setASel((prev) => (prev && ids.has(prev) ? prev : c1.id))
    setBSel((prev) => (prev && ids.has(prev) ? prev : c2.id))
  }, [canCompare, branches, nodes])

  const options = useMemo(
    () =>
      forks.flatMap((f) => {
        const ptxt = firstLine(f.parent.content, 16)
        return f.children.map((c) => ({
          id: c.id,
          label: `${ptxt} › ${firstLine(c.content, 20) || ROLE_TEXT[c.role]}`
        }))
      }),
    [forks]
  )

  const bookmarks = useMemo(() => nodes.filter((n) => n.bookmarked), [nodes])
  /** F13：有失败调用时才提供「沉淀为技能」入口（没有失败就没有经验可沉淀） */
  const failedCount = useMemo(() => steps.filter((n) => n.toolCall?.ok === false).length, [steps])
  const hasFailure = failedCount > 0
  /**
   * 展示用步骤：**保留原始下标** —— 回放游标与行点击用的都是 `steps` 的下标，
   * 筛选如果重排下标，会出现「点第 1 行却跳到第 7 步」这种鬼现象。
   */
  const visibleSteps = useMemo(
    () => steps.map((n, i) => ({ n, i })).filter(({ n }) => !onlyFailed || n.toolCall?.ok === false),
    [steps, onlyFailed]
  )

  /**
   * N17：轨迹长列表同样分页展开。
   *
   * 一次长实验动辄上百次工具调用，全量挂 DOM 的布局开销与消息流叠加后很明显。
   * 与变更时间线同一口径：首屏 120 步，其余按需追加；**不重排下标**
   * （`i` 恒为 `steps` 里的原始下标，回放游标与行点击依赖它）。
   */
  const [limit, setLimit] = useState(TRACE_PAGE_SIZE)
  useEffect(() => {
    setLimit(TRACE_PAGE_SIZE)
  }, [onlyFailed])
  const shownSteps = useMemo(() => visibleSteps.slice(0, limit), [visibleSteps, limit])
  const hiddenSteps = visibleSteps.length - shownSteps.length

  const toggleBookmark = async (node: SessionNode): Promise<void> => {
    if (!activeRootId) return
    try {
      const res = await window.api.session.setBookmark(activeRootId, node.id, !node.bookmarked)
      if (!res.ok) {
        setError('书签更新失败：该节点已不存在')
        return
      }
      // 本地就地更新，省一次整树拉取（书签只影响这一个节点）
      setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, bookmarked: res.bookmarked } : n)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const runCompare = async (exportFile: boolean): Promise<void> => {
    if (!activeRootId || !aSel || !bSel) return
    setComparing(true)
    setCompareError(null)
    if (exportFile) setExportNote(null)
    try {
      const res = await window.api.session.compare(activeRootId, aSel, bSel, exportFile)
      setComparison(res.comparison)
      if (exportFile && res.path) setExportNote(res.path)
    } catch (e) {
      setCompareError(e instanceof Error ? e.message : String(e))
    } finally {
      setComparing(false)
    }
  }

  const reset = (): void => {
    setPlaying(false)
    setStepIndex(0)
  }

  /**
   * F13：把本会话的「失败 → 修正」轨迹交给模型，生成一份排障技能。
   *
   * 生成即保存但**默认未启用** —— 模型产出的排障手册可能含编造的命令，必须人工核对后启用，
   * 所以这里只提示「已生成，去技能页核对」，不代替用户做启用决定。
   */
  const distill = async (): Promise<void> => {
    if (!activeRootId) return
    setDistilling(true)
    setDistillNote(null)
    try {
      const r = await window.api.skill.distill(activeRootId)
      await loadSkills()
      setDistillNote({
        tone: 'ok',
        text: `已生成技能「${r.skill.name}」（基于 ${r.episodes} 个「失败→修正」片段）。默认未启用，请在技能页核对后勾选启用。`
      })
    } catch (e) {
      setDistillNote({ tone: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setDistilling(false)
    }
  }
  const play = (): void => {
    if (steps.length === 0) return
    if (stepIndex >= steps.length - 1) setStepIndex(0)
    setPlaying(true)
  }
  const pause = (): void => setPlaying(false)
  const next = (): void => {
    setPlaying(false)
    setStepIndex((i) => Math.min(i + 1, Math.max(steps.length - 1, 0)))
  }

  if (!activeRootId) {
    return (
      <div className="trace-panel">
        <div className="empty" style={{ padding: 24 }}>
          <div className="empty-content">
            还没有进行中的会话；发一条指令后这里会出现可回放的执行轨迹
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="trace-panel">
      <AdaptiveToolbar
        left={
          <div className="trace-toolbar-title">
            <IconRotateCcw size={15} style={{ color: 'var(--accent)' }} />
            执行轨迹
            <span className="trace-session" title={sessionTitle}>
              {sessionTitle}
            </span>
            <span className="chip">{steps.length} 步工具调用</span>
          </div>
        }
        right={
          <>
            {/* F13：只有真的失败过才给这个入口 —— 没有失败就没有经验可沉淀 */}
            {hasFailure ? (
              <AdaptiveButton
                icon={<IconSparkles size={14} />}
                label={distilling ? '沉淀中…' : '沉淀为技能'}
                priority="medium"
                disabled={distilling}
                onClick={() => void distill()}
                tooltip="把这轮「失败 → 修正」的轨迹交给模型，自动生成一份排障技能（默认不启用）"
              />
            ) : null}
            <AdaptiveButton
              icon={<IconRefresh size={14} />}
              label="刷新"
              priority="high"
              onClick={() => void load()}
              tooltip="重新读取会话树节点"
            />
          </>
        }
      />

      {loading ? (
        <div className="empty" style={{ padding: 24 }}>
          <div className="empty-content">正在读取轨迹…</div>
        </div>
      ) : error ? (
        <div className="banner danger">{error}</div>
      ) : (
        <>
          <div className="trace-controls">
            <button className="btn ghost sm" onClick={reset} title="回到第一步">
              ⏮ 复位
            </button>
            <button className="btn ghost sm" onClick={play} disabled={steps.length === 0} title="自动回放">
              ▶ 播放
            </button>
            <button className="btn ghost sm" onClick={pause} disabled={!playing} title="暂停回放">
              ⏸ 暂停
            </button>
            <button className="btn ghost sm" onClick={next} disabled={steps.length === 0} title="手动前进一步">
              ⏭ 下一步
            </button>
            <span className="trace-step-count mono">
              第 {steps.length ? stepIndex + 1 : 0} / {steps.length} 步
            </span>
          </div>
          <div className="trace-hint">
            高亮同步到『拓扑画布』标签页（切过去即可看到当前步骤操作的设备）
            {topoHighlightDeviceId ? (
              <span className="trace-hl">· 当前高亮 {topoHighlightDeviceId}</span>
            ) : null}
          </div>

          {distillNote ? (
            <DismissibleBanner
              tone={distillNote.tone === 'err' ? 'danger' : 'success'}
              onDismiss={() => setDistillNote(null)}
            >
              {distillNote.text}
            </DismissibleBanner>
          ) : null}

          <SectionHead
            title="执行步骤"
            collapsed={closed.steps}
            onToggle={() => setClosed((c) => ({ ...c, steps: !c.steps }))}
            extra={
              <button
                className={`btn ghost sm${onlyFailed ? ' active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setOnlyFailed((v) => !v)
                }}
                title="只列出失败的工具调用"
              >
                只看失败{failedCount > 0 ? ` (${failedCount})` : ''}
              </button>
            }
          />
          {!closed.steps ? (
            <div className="trace-list">
              {steps.length === 0 ? (
                <div className="empty" style={{ padding: 24 }}>
                  <div className="empty-content">这次会话还没有工具调用，暂无可回放的步骤。</div>
                </div>
              ) : visibleSteps.length === 0 ? (
                <div className="empty" style={{ padding: 24 }}>
                  <div className="empty-content">没有失败的步骤，取消「只看失败」可看全部。</div>
                </div>
              ) : (
                <>
                  {shownSteps.map(({ n, i }) => {
                    const tc = n.toolCall
                    return (
                      <div
                        key={n.id}
                        className={`trace-step${i === stepIndex ? ' active' : ''}`}
                        onClick={() => {
                          setPlaying(false)
                          setStepIndex(i)
                        }}
                        title={tc?.summary ?? n.content}
                      >
                        <span className="trace-idx mono">{i + 1}</span>
                        <span className="trace-time mono">{fmtTime(n.createdAt)}</span>
                        <span className={`trace-state${tc?.ok === false ? ' fail' : tc?.ok ? ' ok' : ''}`}>
                          {stepStatus(tc?.ok)}
                        </span>
                        <span className="trace-name mono">{tc?.name ?? n.content}</span>
                        <span className="trace-ms mono">{tc?.ms !== undefined ? `${tc.ms}ms` : ''}</span>
                        <span className="trace-summary">{tc?.summary ?? n.content}</span>
                        <button
                          className={`trace-bookmark${n.bookmarked ? ' on' : ''}`}
                          title={n.bookmarked ? '取消书签' : '标为阶段完成点'}
                          onClick={(e) => {
                            e.stopPropagation()
                            void toggleBookmark(n)
                          }}
                        >
                          {n.bookmarked ? '★' : '☆'}
                        </button>
                      </div>
                    )
                  })}
                  {/* N17：其余步骤按需展开（不改变任何回放语义，只是少挂 DOM） */}
                  {hiddenSteps > 0 ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0' }}>
                      <button
                        className="btn sm"
                        onClick={() => setLimit((l) => l + TRACE_PAGE_SIZE)}
                        title="继续往下显示步骤（不影响回放游标）"
                      >
                        显示更多（还有 {hiddenSteps} 步）
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {bookmarks.length > 0 ? (
            <div className="trace-bookmarks">
              <SectionHead
                title={`书签（阶段完成点 · ${bookmarks.length}）`}
                collapsed={closed.bookmarks}
                onToggle={() => setClosed((c) => ({ ...c, bookmarks: !c.bookmarks }))}
              />
              {!closed.bookmarks
                ? bookmarks.map((n) => (
                    <div key={n.id} className="trace-bookmark-row">
                      <span className="trace-time mono">{fmtTime(n.createdAt)}</span>
                      <span className="trace-role">{ROLE_TEXT[n.role]}</span>
                      <span className="trace-bookmark-text" title={nodeLabel(n)}>
                        {firstLine(nodeLabel(n), 40)}
                      </span>
                      <button className="btn ghost sm" onClick={() => void toggleBookmark(n)} title="取消该书签">
                        取消
                      </button>
                    </div>
                  ))
                : null}
            </div>
          ) : null}

          {canCompare ? (
            <div className="trace-compare">
              <SectionHead
                title="分支对比"
                collapsed={closed.compare}
                onToggle={() => setClosed((c) => ({ ...c, compare: !c.compare }))}
              />
              {!closed.compare ? (
                <>
              <div className="trace-compare-pickers">
                <label className="trace-picker">
                  分支 A
                  <select value={aSel} onChange={(e) => setASel(e.target.value)}>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="trace-picker">
                  分支 B
                  <select value={bSel} onChange={(e) => setBSel(e.target.value)}>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <AdaptiveButton
                  label="对比"
                  variant="primary"
                  priority="high"
                  disabled={comparing}
                  onClick={() => void runCompare(false)}
                  tooltip="对比两条分支的工具调用序列"
                />
                <AdaptiveButton
                  label="导出报告"
                  priority="medium"
                  disabled={comparing}
                  onClick={() => void runCompare(true)}
                  tooltip="把对比结果写成 Markdown 报告"
                />
                {/* 对比结果是这一栏里最大的一块；看完要能收掉，否则一直占着屏 */}
                {comparison ? (
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      setComparison(null)
                      setExportNote(null)
                    }}
                    title="清除对比结果（不删除任何数据）"
                  >
                    清除结果
                  </button>
                ) : null}
              </div>

              {compareError ? (
                <DismissibleBanner tone="danger" onDismiss={() => setCompareError(null)}>
                  {compareError}
                </DismissibleBanner>
              ) : null}
              {exportNote ? (
                <DismissibleBanner tone="info" onDismiss={() => setExportNote(null)}>
                  已导出：{exportNote}
                </DismissibleBanner>
              ) : null}

              {comparison ? (
                <div className="trace-compare-result">
                  <div className="trace-verdict">{comparison.verdict}</div>
                  <div className="trace-metrics">
                    <div className="trace-metric-row head">
                      <span>指标</span>
                      <span title={comparison.a.label}>A</span>
                      <span title={comparison.b.label}>B</span>
                    </div>
                    <MetricRow label="工具调用" a={String(comparison.a.tools)} b={String(comparison.b.tools)} />
                    <MetricRow label="失败调用" a={String(comparison.a.failed)} b={String(comparison.b.failed)} />
                    <MetricRow
                      label="总耗时"
                      a={fmtMs(comparison.a.totalMs)}
                      b={fmtMs(comparison.b.totalMs)}
                    />
                  </div>
                  <div className="trace-diff-head">
                    <span className="trace-diff-prefix" />
                    <span>A 侧</span>
                    <span>B 侧</span>
                  </div>
                  {comparison.rows.length === 0 ? (
                    <div className="trace-diff-none">两侧调用序列完全一致。</div>
                  ) : (
                    comparison.rows.map((row, i) => <DiffRowView key={i} row={row} />)
                  )}
                </div>
              ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}