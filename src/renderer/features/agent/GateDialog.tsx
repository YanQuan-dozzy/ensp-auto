import { useEffect, type ReactNode } from 'react'
import { useApp } from '@/stores/app'

/**
 * 危险操作闸门。
 *
 * 这是整个界面里唯一允许打断用户的操作，因此：
 * - 不可点击遮罩关闭，Esc 等价于「拒绝」（拒绝永远比批准安全）
 * - 明确展示后果与「是否有可用快照」——
 *   有安全网时用户更敢批准，没有时会本能地更谨慎，这个信息必须给
 * - 主按钮用 danger 变体，视觉上与常规确认区分开
 */
export function GateDialog(): ReactNode {
  const gate = useApp((s) => s.gate)
  const resolveGate = useApp((s) => s.resolveGate)

  useEffect(() => {
    if (!gate) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void resolveGate('reject')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gate, resolveGate])

  if (!gate) return null

  const argsText = safeFormat(gate.args)

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="危险操作确认">
      <div className="dialog">
        <div className="dialog-bar" />
        <div className="dialog-body">
          <div className="dialog-title">危险操作确认</div>

          <dl className="kv">
            <dt>工具</dt>
            <dd className="mono">{gate.name}</dd>
            <dt>参数</dt>
            <dd className="mono" style={{ maxHeight: 160, overflow: 'auto' }}>
              {argsText}
            </dd>
            <dt>后果</dt>
            <dd>{gate.reason}</dd>
          </dl>

          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            该操作不可撤销。批准后将立即在设备上执行。
          </p>

          <div className="dialog-actions">
            <button className="btn" onClick={() => void resolveGate('reject')}>
              拒绝
            </button>
            <button className="btn danger" onClick={() => void resolveGate('approve')}>
              确认执行
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function safeFormat(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
