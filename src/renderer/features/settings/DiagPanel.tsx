import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { DiagCheck, DiagLevel, DiagReport } from '@shared/types'
import { useApp } from '@/stores/app'
import { Chip, Dot, IconRefresh } from '@/components/ui'

/**
 * 环境体检面板。
 *
 * 定位：设置页里唯一「主动告诉你哪里坏了」的地方。原来用户只有跑到第一次任务失败
 * 才知道 eNSP 路径不对 / 模型名写错 / 端口被占，现在这些判断前置到打开设置就能看到。
 *
 * 打开即自动跑一次（用户不必先点按钮），但网络探活有 8 秒上限，所以过程中显示进行态，
 * 不阻塞其它分区。
 */

const LEVEL_LABEL: Record<DiagLevel, string> = {
  ok: '通过',
  warn: '注意',
  fail: '失败',
  skipped: '跳过'
}

const LEVEL_TONE: Record<DiagLevel, 'success' | 'warning' | 'danger' | 'plain'> = {
  ok: 'success',
  warn: 'warning',
  fail: 'danger',
  skipped: 'plain'
}

const LEVEL_DOT: Record<DiagLevel, 'up' | 'down' | 'err' | 'pending'> = {
  ok: 'up',
  warn: 'pending',
  fail: 'err',
  skipped: 'down'
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function DiagRow({ check, onFixEnsp, fixing }: {
  check: DiagCheck
  onFixEnsp: () => void
  fixing: boolean
}): ReactNode {
  return (
    <div className={`set-row wide diag-row${check.level === 'fail' ? ' bad' : ''}`}>
      <div className="set-info">
        <div className="set-title">
          <Dot tone={LEVEL_DOT[check.level]} />
          {check.label}
        </div>
        {check.hint ? <div className="set-desc">{check.hint}</div> : null}
      </div>
      <div className="set-ctl diag-ctl">
        <span className={`diag-detail lv-${check.level}`}>{check.detail}</span>
        <Chip tone={LEVEL_TONE[check.level]}>{LEVEL_LABEL[check.level]}</Chip>
        {check.action === 'pick-ensp' ? (
          <button className="btn sm" onClick={onFixEnsp} disabled={fixing}>
            {fixing ? '选择中…' : '指定路径'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function DiagPanel(): ReactNode {
  const updateSettings = useApp((s) => s.updateSettings)
  const [report, setReport] = useState<DiagReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  const run = useCallback(async (): Promise<void> => {
    setRunning(true)
    setError(null)
    try {
      setReport(await window.api.diag.run())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }, [])

  // 打开即体检：用户不该为了知道「坏没坏」先点一次按钮
  useEffect(() => {
    void run()
  }, [run])

  /** 体检发现 eNSP 未找到时就地修复：选路径 → 落设置 → 复检，不用跳去别的分区 */
  const fixEnsp = useCallback(async (): Promise<void> => {
    setPicking(true)
    try {
      const picked = await window.api.ensp.pickExe()
      if (!picked?.exePath) return
      await updateSettings({ ensp: { exePath: picked.exePath } })
      await run()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPicking(false)
    }
  }, [run, updateSettings])

  const checks = report?.checks ?? []
  const okCount = checks.filter((c) => c.level === 'ok').length
  const badCount = checks.filter((c) => c.level === 'fail' || c.level === 'warn').length

  return (
    <section className="set-section">
      <div className="set-section-head">
        <span className="set-section-label">
          环境体检
          <span className="set-section-sub">
            {running
              ? '正在检测…'
              : report
                ? `上次检测 ${fmtTime(report.ranAt)} · ${checks.length} 项中 ${okCount} 项通过` +
                  (badCount > 0 ? `，${badCount} 项需处理` : '')
                : '尚未检测'}
          </span>
        </span>
        <button className="btn sm" onClick={() => void run()} disabled={running}>
          {running ? <IconRefresh size={12} className="dot pending" /> : <IconRefresh size={12} />}
          重新体检
        </button>
      </div>

      <div className="settings-card">
        {error ? <div className="banner danger">体检执行失败：{error}</div> : null}
        {checks.map((c) => (
          <DiagRow key={c.id} check={c} onFixEnsp={() => void fixEnsp()} fixing={picking} />
        ))}
        {!report && running
          ? ['模型端点', 'API 密钥', 'eNSP 客户端', 'MCP 对外服务', '数据目录'].map((label) => (
              <div className="set-row wide diag-row" key={label}>
                <div className="set-info">
                  <div className="set-title">
                    <Dot tone="pending" />
                    {label}
                  </div>
                </div>
                <div className="set-ctl diag-ctl">
                  <span className="diag-detail">检测中…</span>
                </div>
              </div>
            ))
          : null}
      </div>

      <div className="hint">
        体检只做只读探测：模型端点的「通过」会真实发出一次最小请求以同时验证端点、密钥与模型名，
        其余检查均为本地探测，不会改动任何配置。
      </div>
    </section>
  )
}
