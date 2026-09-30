import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import type { ChangeRecord, ChangeResult } from '@shared/types'
import {
  IconActivity,
  IconAlertTriangle,
  IconCheck,
  IconRefresh,
  IconTrash,
  IconUpload,
  AdaptiveToolbar,
  AdaptiveButton,
  DismissibleBanner
} from '@/components/ui'

/**
 * 变更审计时间线（F6）。
 *
 * 所有设备 × 一条时间轴 —— `ChangeStore` 已经记录了 actor / deviceId / commands /
 * result / snapshotId / verified，但过去只能按设备查（`list(deviceId)`），
 * 没有「这配置谁在什么时候改的」这个跨设备视图。
 *
 * 纯消费现有数据（`window.api.changes.list` → `ChangeStore.recent`），不新增任何存储。
 * 刻意不做「跳转快照 / 跳转会话节点」两个按钮：`ChangeRecord` 里没有 rootId / nodeId，
 * 也没有快照浏览界面 —— 摆一个点了没反应的按钮比没有更糟，等链接字段补上再说。
 */

const KIND_LABEL: Record<ChangeRecord['kind'], string> = {
  apply: '下发',
  restore: '回滚',
  save: '保存'
}

const RESULT_META: Record<ChangeResult, { label: string; tone: string }> = {
  ok: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  rejected: { label: '被拒', tone: 'warning' },
  blocked: { label: '被拦截', tone: 'warning' }
}

const FILTERS: Array<{ id: 'all' | ChangeResult; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'ok', label: '成功' },
  { id: 'failed', label: '失败' },
  { id: 'rejected', label: '被拒' },
  { id: 'blocked', label: '被拦截' }
]

/** N17：长列表首屏条数（其余按「显示更多」追加） */
const PAGE_SIZE = 120

function formatTime(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function ChangeTimeline(): ReactNode {
  const devices = useApp((s) => s.devices)
  const [records, setRecords] = useState<ChangeRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | ChangeResult>('all')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setRecords(await window.api.changes.list(300))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 删除单条：只改本地列表，不重新拉全量 —— 时间线可能上千条，删一条就整表重读太浪费。
   * 主进程已落盘，本地乐观更新失败只可能是 IPC 异常，这时才回退重读。
   */
  const removeOne = useCallback(async (id: string): Promise<void> => {
    try {
      const r = await window.api.changes.remove(id)
      if (!r.removed) setNotice('该条记录已不存在')
      setRecords((rs) => rs.filter((x) => x.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await load()
    }
  }, [load])

  /** 清空全部：破坏性操作，必须先确认（文案说明「不影响设备配置与会话」） */
  const clearAll = useCallback(async (): Promise<void> => {
    if (records.length === 0) return
    if (!window.confirm(`清空全部 ${records.length} 条变更记录？\n只清审计流水，不影响设备配置与本会话内容。`)) return
    try {
      const r = await window.api.changes.clear()
      setRecords([])
      setNotice(`已清空 ${r.removed} 条变更记录`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [records.length])

  /**
   * v2.20：导出「设备配置命令报告」。
   *
   * 带**当前筛选条件** —— 用户切到「只看失败」再点导出，拿到的就该是失败清单，
   * 而不是把屏幕上没显示的东西也塞进文件。筛选口径会写进报告页头的统计口径行，
   * 标题也带上筛选名，避免同一目录里堆一串无法区分的文件。
   *
   * 正文与 agent 工具 `export_change_report` 同源（`core/store/change-report.ts`），
   * 因此点按钮导出和让代理导出拿到的内容一致。
   */
  const exportReport = useCallback(async (): Promise<void> => {
    const only = filter === 'all' ? null : FILTERS.find((f) => f.id === filter)
    try {
      setError(null)
      const r = await window.api.changes.exportReport({
        ...(filter === 'all' ? {} : { result: filter }),
        title: only ? `设备配置命令报告（${only.label}）` : '设备配置命令报告'
      })
      setNotice(`已导出 ${r.count} 条变更 → ${r.path}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [filter])

  const nameOf = useMemo(() => {
    const map = new Map(devices.map((d) => [d.id, d.name]))
    return (deviceId: string): string => map.get(deviceId) ?? deviceId
  }, [devices])

  const shown = useMemo(
    () => (filter === 'all' ? records : records.filter((r) => r.result === filter)),
    [records, filter]
  )

  /**
   * N17：渐进渲染（长列表）。
   *
   * 每次最多拉 300 条并**一次性全部挂进 DOM** —— 变更记录是审计流水，跑一整天实验
   * 很容易攒到几百条，DOM 节点数与布局开销随之线性增长（叠加消息流后就是掉帧）。
   * 这里不引入虚拟滚动库（会与现有行内展开/删除的局部 state 冲突），只做**分页展开**：
   * 首屏 120 条，其余按需追加 —— 既保住「点开看完整命令」的交互，又把首屏成本固定住。
   */
  const [limit, setLimit] = useState(PAGE_SIZE)
  useEffect(() => {
    // 换筛选条件 = 换了一份列表，回到首屏（否则「只看失败」时可能一上来就展开一大截）
    setLimit(PAGE_SIZE)
  }, [filter])

  const visible = useMemo(() => shown.slice(0, limit), [shown, limit])
  const hiddenCount = shown.length - visible.length

  const counts = useMemo(() => {
    const c: Record<string, number> = { ok: 0, failed: 0, rejected: 0, blocked: 0 }
    for (const r of records) c[r.result] = (c[r.result] ?? 0) + 1
    return c
  }, [records])

  return (
    <div className="changes-panel">
      <AdaptiveToolbar
        left={
          <div className="changes-toolbar-title">
            <IconActivity size={15} style={{ color: 'var(--accent)' }} />
            变更时间线
            <span className="chip" style={{ marginLeft: 8 }}>
              共 {records.length} 条
            </span>
          </div>
        }
        right={
          <>
            {/* 导出不是破坏性操作，但结果不落盘就看不见 —— 导出路径在成功 banner 里回显 */}
            {records.length > 0 ? (
              <AdaptiveButton
                icon={<IconUpload size={14} />}
                label="导出报告"
                priority="medium"
                onClick={() => void exportReport()}
                tooltip={
                  filter === 'all'
                    ? '导出设备配置命令报告（含 IP 地址规划、实施过程、失败记录）'
                    : `只导出当前筛选（${FILTERS.find((f) => f.id === filter)?.label ?? ''}）的记录`
                }
              />
            ) : null}
            {/* 时间线只增不减会越看越累：给一个明确的「清空」出口（带确认） */}
            {records.length > 0 ? (
              <AdaptiveButton
                icon={<IconTrash size={14} />}
                label="清空"
                priority="medium"
                onClick={() => void clearAll()}
                tooltip="清空全部变更记录（只清审计流水，不影响设备配置）"
              />
            ) : null}
            <AdaptiveButton
              icon={<IconRefresh size={14} />}
              label="刷新"
              priority="high"
              onClick={() => void load()}
              tooltip="重新读取变更记录"
            />
          </>
        }
      />

      <div className="changes-hint">
        所有设备的配置变更（下发 / 回滚 / 保存）按时间倒序汇总。点开任意一条可看完整命令、
        依据的快照与失败原因，用于排障与「这配置谁在什么时候改的」的取证。
      </div>

      <div className="changes-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`btn ghost sm${filter === f.id ? ' active' : ''}`}
            onClick={() => setFilter(f.id)}
            title={`只看${f.label}`}
          >
            {f.label}
            {f.id !== 'all' ? <span className="changes-filter-count">{counts[f.id] ?? 0}</span> : null}
          </button>
        ))}
      </div>

      {error ? (
        <DismissibleBanner tone="danger" onDismiss={() => setError(null)}>
          <IconAlertTriangle size={14} />
          {error}
        </DismissibleBanner>
      ) : null}

      {notice ? (
        <DismissibleBanner tone="success" onDismiss={() => setNotice(null)}>
          <IconCheck size={14} />
          {notice}
        </DismissibleBanner>
      ) : null}

      <div className="changes-list">
        {loading && records.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>
            <div className="empty-content">正在读取变更记录…</div>
          </div>
        ) : shown.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>
            <div className="empty-content">
              {records.length === 0
                ? '还没有配置变更记录。代理下发配置、回滚或保存配置后，这里会出现条目。'
                : '当前筛选条件下没有记录。'}
            </div>
          </div>
        ) : (
          <>
            {visible.map((r) => (
              <ChangeRow key={r.id} record={r} deviceName={nameOf(r.deviceId)} onRemove={removeOne} />
            ))}
            {/* N17：其余条目按需展开 —— 明确写出还剩多少，避免用户以为列表就这么长 */}
            {hiddenCount > 0 ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0' }}>
                <button
                  className="btn sm"
                  onClick={() => setLimit((l) => l + PAGE_SIZE)}
                  title="继续往下显示（不改变磁盘数据）"
                >
                  显示更多（还有 {hiddenCount} 条）
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function ChangeRow({
  record,
  deviceName,
  onRemove
}: {
  record: ChangeRecord
  deviceName: string
  onRemove: (id: string) => void | Promise<void>
}): ReactNode {
  const meta = RESULT_META[record.result]
  const [open, setOpen] = useState(false)
  return (
    <div className={`change-row${open ? ' open' : ''}`}>
      <div className="change-row-head" onClick={() => setOpen((v) => !v)}>
        <span className="change-time mono">{formatTime(record.at)}</span>
        <span className={`change-result ${meta.tone}`}>
          {record.result === 'ok' ? <IconCheck size={12} /> : <IconAlertTriangle size={12} />}
          {meta.label}
        </span>
        <span className="change-kind">{KIND_LABEL[record.kind]}</span>
        <span className="change-device" title={record.deviceId}>
          {deviceName}
        </span>
        <span className="change-desc" title={record.description}>
          {record.description}
        </span>
        <span className="change-caret">{open ? '收起' : '展开'}</span>
        {/* 删除按钮在点击区里，必须 stopPropagation，否则点删除会顺手把行展开 */}
        <button
          className="btn ghost icon sm danger-hover"
          title="删除这条记录"
          onClick={(e) => {
            e.stopPropagation()
            void onRemove(record.id)
          }}
        >
          <IconTrash size={13} />
        </button>
      </div>

      {open ? (
        <div className="change-detail">
          {record.error ? (
            <div className="change-error">
              {record.error.code}：{record.error.message}
            </div>
          ) : null}
          <dl className="kv">
            <dt>设备</dt>
            <dd className="mono">{record.deviceId}</dd>
            <dt>操作者</dt>
            <dd>{record.actor === 'agent' ? '代理' : '用户'}</dd>
            {record.snapshotId ? (
              <>
                <dt>依据快照</dt>
                <dd className="mono">{record.snapshotId}</dd>
              </>
            ) : null}
            {record.verified !== undefined ? (
              <>
                <dt>期望校验</dt>
                <dd>{record.verified ? '通过' : '未通过'}</dd>
              </>
            ) : null}
          </dl>
          <div className="field">
            <label>命令（{record.commands?.length ?? 0} 条）</label>
            <pre className="change-commands mono">
              {record.commands?.length ? record.commands.join('\n') : '（本次无命令）'}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  )
}