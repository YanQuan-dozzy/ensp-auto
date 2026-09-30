/**
 * 拓扑加载进度条（v2.29）。
 *
 * 为什么需要它：导入大工程后要跑「布局重排 + 走线」，这两段是**同步计算**，
 * 期间界面完全无法响应。实测 300 台拓扑的走线内核在老实现下要 64ms（优化后 11.6ms），
 * 加上布局与首屏元素构建，用户点完「导入」会看到画布僵住一会儿 —— 分不清是在算
 * 还是已经卡死。这个进度条把真实阶段亮出来，并显示已耗时，让人知道「它在动」。
 *
 * 三条设计约束：
 * ① **进度必须真实**：阶段来自 `TopoLoadProgress.phase`，由 store 在真实执行点上报；
 *    不搞定时器假动画（那种条走到 90% 停住反而更让人怀疑卡死）。
 * ② **不抢交互**：`pointer-events: none`，覆盖层不吃点击 —— 加载中用户仍能切标签页。
 * ③ **收尾有兜底**：正常由画布首帧后清空；万一没人清，超时也会自己消失（见 useEffect）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import { TOPO_LOAD_PHASES, type TopoLoadPhase } from '@/stores/storeUtil'

/**
 * 阶段权重：按实测耗时占比分配，进度条推进速度才与真实观感一致。
 *
 * 实测（优化后，40 台综合拓扑）：读文件 + 解析 ≈ 主进程，布局 ≈ 0.3ms，
 * 走线与首屏元素 ≈ 3.5ms。总体上「解析」与「布局+绘制」各占大头，因此 read 与
 * layout/render 给足权重 —— 权重失真会让进度条在慢阶段卡住不动（正是要避免的观感）。
 */
const PHASE_WEIGHT: Record<TopoLoadPhase, number> = {
  read: 0.3,
  layout: 0.3,
  route: 0.2,
  render: 0.2
}

/** 进度条最长存活时间：没人来收尾就自己走（避免异常路径下永久挂着挡住画布） */
const MAX_ALIVE_MS = 8000

/** 把「阶段 + 阶段内比例」折成 0~1 的总进度 */
export function overallRatio(phase: TopoLoadPhase, ratio: number): number {
  let base = 0
  for (const p of TOPO_LOAD_PHASES) {
    if (p === phase) break
    base += PHASE_WEIGHT[p]
  }
  return Math.min(1, base + PHASE_WEIGHT[phase] * Math.max(0, Math.min(1, ratio)))
}

export function TopoLoadingBar(): ReactNode {
  const loading = useApp((s) => s.topoLoading)
  const setTopoLoading = useApp((s) => s.setTopoLoading)
  /** 每秒重算一次「已耗时」，让用户看到秒数在涨（而不是静止的假象） */
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!loading) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [loading])

  // 兜底自动收尾（见文件头约束 ③）
  useEffect(() => {
    if (!loading) return
    const t = window.setTimeout(() => setTopoLoading(null), MAX_ALIVE_MS)
    return () => window.clearTimeout(t)
  }, [loading, setTopoLoading])

  if (!loading) return null

  const pct = Math.round(overallRatio(loading.phase, loading.ratio) * 100)
  const elapsed = Math.max(0, now - loading.startedAt)
  /** 只在对用户有意义的量级上显示耗时（<300ms 一闪而过，显示反而闪烁） */
  const showElapsed = elapsed >= 300
  const phaseLabel = PHASE_LABELS[loading.phase]

  return (
    <div className="topo-loading" role="status" aria-live="polite" aria-busy="true">
      <div className="topo-loading-card">
        <div className="topo-loading-head">
          <span className="topo-loading-spinner" aria-hidden="true" />
          <span className="topo-loading-title">{phaseLabel}</span>
          <span className="topo-loading-pct">{pct}%</span>
        </div>
        <div
          className="topo-loading-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className="topo-loading-fill" style={{ width: `${pct}%` }} />
        </div>
        {loading.detail ? <div className="topo-loading-detail">{loading.detail}</div> : null}
        {showElapsed ? (
          <div className="topo-loading-elapsed">已耗时 {(elapsed / 1000).toFixed(1)} 秒</div>
        ) : null}
      </div>
    </div>
  )
}

const PHASE_LABELS: Record<TopoLoadPhase, string> = {
  read: '读取工程文件',
  layout: '重排布局',
  route: '计算连线走线',
  render: '绘制画布'
}
