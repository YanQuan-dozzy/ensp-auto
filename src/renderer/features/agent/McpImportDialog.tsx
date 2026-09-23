import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { McpServerConfig } from '@shared/types'
import { MCP_IMPORT_EXAMPLE, parseMcpServersJson } from '@shared/mcp-import'
import { IconAlertTriangle, IconCheck, IconClose, IconUpload } from '@/components/ui'

/**
 * 手动配置：粘贴一段 JSON 导入外部 MCP 服务器（v1.6）。
 *
 * 交互参照成熟客户端的口径：**先粘、再确认**（不是边输边校验）。
 * 用户是「从服务器介绍页复制一段 JSON」过来的，中间任何一步报错都应当等他点「确认导入」
 * 再说话 —— 边打边飘红只会让一段半截 JSON 看起来像错误。
 *
 * 与 Trae 那版的两个刻意差异：
 * 1. 示例用 **placeholder** 而不是预填正文 —— 预填意味着用户得先全选删掉才能粘贴；
 *    这里粘贴会直接覆盖 placeholder，零多余动作（要看示例可以点「填入示例」）。
 * 2. 确认后把「忽略了哪些字段」逐条列出来，不静默吞掉：`env` / `headers` 这类
 *    本应用不注入的字段如果不说，用户会一直以为配好了却不生效。
 */
export function McpImportDialog({
  existing,
  onCancel,
  onImported
}: {
  existing: readonly McpServerConfig[]
  onCancel: () => void
  onImported: (servers: McpServerConfig[], warnings: string[]) => void
}): ReactNode {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])

  // v1.8：onCancel 是父组件内联箭头函数，每次 render 新引用 —— 用 ref 存最新回调，
  // 避免 Esc 监听随每次渲染反复 remove/add（与 McpDialog / SettingsDialog 同一修法）
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 本层开着时 Esc 只关本层 —— 否则一次按键会连着关掉设置页
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancelRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  /** 实时给出「看起来能不能解析」的提示，但不拦着用户点确认（真正的判定在确认时做） */
  const preview = useMemo(() => {
    const t = text.trim()
    if (!t) return null
    const r = parseMcpServersJson(t, existing)
    return r.ok ? { tone: 'ok' as const, names: r.servers.map((s) => s.name) } : null
  }, [text, existing])

  const confirm = (): void => {
    const r = parseMcpServersJson(text, existing)
    if (!r.ok) {
      setError(r.error ?? '导入失败')
      setWarnings(r.warnings)
      return
    }
    onImported(r.servers, r.warnings)
  }

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label="手动配置"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="dialog" style={{ maxWidth: 620 }}>
        <div
          className="dialog-bar"
          style={{ background: 'linear-gradient(90deg, var(--agent), var(--accent))' }}
        />
        <div className="dialog-body">
          <div className="dialog-header">
            <div className="dialog-title">
              <IconUpload size={17} style={{ color: 'var(--agent)' }} />
              手动配置
            </div>
            <button className="btn ghost icon sm" onClick={onCancel} title="关闭 (Esc)">
              <IconClose size={15} />
            </button>
          </div>

          <p className="mcp-import-hint">
            从 MCP 服务器的介绍页复制 JSON，整段粘贴到下面即可（优先用 NPX / UVX 或 HTTP
            端点形式的配置）。支持 <code>{'{ "mcpServers": { … } }'}</code>、
            <code>{'{ "servers": { … } }'}</code> 以及直接用「服务器名 → 配置」的对象；
            <code>//</code> 注释与尾逗号会被自动忽略。
          </p>

          <div className="mcp-import-box">
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setError('')
              }}
              placeholder={MCP_IMPORT_EXAMPLE}
              spellCheck={false}
              rows={12}
              autoFocus
            />
          </div>

          <div className="mcp-import-tools">
            <button className="btn ghost sm" onClick={() => setText(MCP_IMPORT_EXAMPLE)}>
              填入示例
            </button>
            {text ? (
              <button className="btn ghost sm" onClick={() => setText('')}>
                清空
              </button>
            ) : null}
            <span className="mcp-import-count">
              {preview ? (
                <>
                  <IconCheck size={12} />
                  认出 {preview.names.length} 台：{preview.names.join('、')}
                </>
              ) : text.trim() ? (
                '还差一点 —— 点「确认导入」看具体问题'
              ) : (
                '等待粘贴'
              )}
            </span>
          </div>

          {error ? <div className="banner danger">{error}</div> : null}
          {warnings.length > 0 ? (
            <div className="mcp-import-notes">
              {warnings.map((w, i) => (
                <div key={`${i}-${w}`}>{w}</div>
              ))}
            </div>
          ) : null}

          <div className="dialog-actions mcp-import-foot">
            <span className="mcp-import-warn">
              <IconAlertTriangle size={12} />
              配置前请确认来源，甄别风险
            </span>
            <button className="btn" onClick={onCancel}>
              取消
            </button>
            <button className="btn primary" onClick={confirm} disabled={!text.trim()}>
              确认导入
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
