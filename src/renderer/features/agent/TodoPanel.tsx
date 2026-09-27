import { useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import { todoProgress, type TodoItem } from '@shared/interaction'
import { IconCheck, IconChevronDown, IconClipboard } from '@/components/ui'

/**
 * 任务清单条（v2.7）。
 *
 * 为什么不放进消息流当一条消息：清单是**始终有效的最新状态**，而消息流是历史。
 * 混在一起会出现「往上滚还看到三份过期清单」，用户得自己判断哪份最新。
 * 做成对话区顶部的常驻条，界面上永远只有一份，且切会话时自动换成该会话的清单。
 *
 * 空清单时完全不渲染（不占位、不显示空壳）—— 单步任务不该被一个空面板挡着。
 */
export function TodoPanel(): ReactNode {
  const todos = useApp((s) => s.agentTodos)
  const [open, setOpen] = useState(false)

  if (todos.length === 0) return null
  const p = todoProgress(todos)
  const current = todos.find((t) => t.status === 'in_progress')

  return (
    <div className={`todo-panel${open ? ' open' : ''}`}>
      <div className="todo-head" onClick={() => setOpen((v) => !v)}>
        <span className="todo-icon">
          <IconClipboard size={12} />
        </span>
        <span className="todo-title">任务清单</span>
        <span className="todo-progress-text">
          {p.completed}/{p.total}
        </span>
        <span className="todo-bar" aria-hidden>
          <span className="todo-bar-fill" style={{ width: `${Math.round(p.ratio * 100)}%` }} />
        </span>
        {current && !open ? (
          <span className="todo-current" title={current.content}>
            进行中：{current.content}
          </span>
        ) : null}
        <span className="todo-caret">
          <IconChevronDown size={12} className={`agent-step-caret${open ? '' : ' closed'}`} />
        </span>
      </div>
      {open ? (
        <div className="todo-body">
          {todos.map((t, i) => (
            <TodoRow key={`${i}-${t.content}`} t={t} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TodoRow({ t }: { t: TodoItem }): ReactNode {
  const mark =
    t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : 'todo'
  return (
    <div className={`todo-row ${mark}`}>
      <span className="todo-mark">
        {t.status === 'completed' ? (
          <IconCheck size={10} />
        ) : t.status === 'in_progress' ? (
          <span className="dot pending" />
        ) : null}
      </span>
      <span className="todo-content">{t.content}</span>
      {t.deviceId ? <span className="todo-device">{t.deviceId}</span> : null}
    </div>
  )
}
