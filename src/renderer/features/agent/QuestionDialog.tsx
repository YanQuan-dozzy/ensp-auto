import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import { IconAlertTriangle, IconCheck, IconSparkles } from '@/components/ui'

/**
 * 结构化提问卡（v2.7）。
 *
 * 与 GateDialog 的关系：两者都是「任务就地暂停等人」，但语义完全不同 ——
 * 闸门问的是「准不准」，这里问的是「是什么 / 选哪个」。所以刻意做成两个组件、
 * 两套文案、两种主按钮配色（这里的主按钮是普通 primary，不是 danger）。
 *
 * 计划模式的方案评审（source: 'plan'）复用同一个组件：它的形态就是
 * 「一个问题 + 三个选项 + 可以自己写意见」，与模型的提问完全同构。
 *
 * Esc = 取消（不是「提交默认值」）：把没作答当成作答，会让模型以为用户
 * 明确选了某个选项，这种误会在设备上会变成配错命令。
 */
export function QuestionDialog(): ReactNode {
  const question = useApp((s) => s.question)
  const answerQuestion = useApp((s) => s.answerQuestion)

  /** qid → 选中的标签（单选）或标签数组（多选） */
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  /** qid → 自由输入文本 */
  const [notes, setNotes] = useState<Record<string, string>>({})

  // 换一个提问就重置草稿：否则会把上一题的答案带到下一题（尤其在方案评审连续出现时）
  useEffect(() => {
    setPicked({})
    setNotes({})
  }, [question?.questionId])

  useEffect(() => {
    if (!question) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void answerQuestion(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [question, answerQuestion])

  /** 每题最终答案：优先自由输入（用户写了话就是要表达自己），否则用选中的标签 */
  const answers = useMemo(() => {
    if (!question) return {}
    const out: Record<string, string> = {}
    for (const q of question.questions) {
      const note = (notes[q.id] ?? '').trim()
      if (note) {
        out[q.id] = note
        continue
      }
      const sel = picked[q.id] ?? []
      if (sel.length > 0) out[q.id] = sel.join('、')
    }
    return out
  }, [question, picked, notes])

  if (!question) return null

  const isPlan = question.source === 'plan'
  const canSubmit = Object.keys(answers).length > 0

  const toggle = (qid: string, label: string, multi: boolean): void => {
    setPicked((prev) => {
      const cur = prev[qid] ?? []
      if (!multi) {
        // 单选再点一次即取消选择 —— 否则点错了没法回到「没选」状态
        return { ...prev, [qid]: cur[0] === label ? [] : [label] }
      }
      return {
        ...prev,
        [qid]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]
      }
    })
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={isPlan ? '方案评审' : '代理提问'}>
      <div className="dialog">
        <div className="dialog-bar" style={{ background: isPlan ? 'var(--accent)' : 'var(--info, #3b82f6)' }} />
        <div className="dialog-body">
          <div className="dialog-title" style={{ color: isPlan ? 'var(--accent)' : 'var(--text-primary)' }}>
            {isPlan ? <IconSparkles size={18} /> : <IconAlertTriangle size={18} />}
            {isPlan ? '方案评审' : '代理需要你确认几件事'}
          </div>

          <div className="question-list">
            {question.questions.map((q) => {
              const multi = q.multiSelect === true
              const sel = picked[q.id] ?? []
              return (
                <div key={q.id} className="question-item">
                  <div className="question-text">
                    {q.header ? <span className="question-chip">{q.header}</span> : null}
                    {q.question}
                  </div>
                  {q.options.length > 0 ? (
                    <div className="question-options">
                      {q.options.map((o) => {
                        const on = sel.includes(o.label)
                        return (
                          <button
                            key={o.label}
                            type="button"
                            className={`question-option${on ? ' on' : ''}`}
                            onClick={() => toggle(q.id, o.label, multi)}
                            title={o.description ?? o.label}
                          >
                            <span className={`question-mark${multi ? ' square' : ''}`}>
                              {on ? <IconCheck size={10} /> : null}
                            </span>
                            <span className="question-option-body">
                              <span className="question-option-label">{o.label}</span>
                              {o.description ? (
                                <span className="question-option-desc">{o.description}</span>
                              ) : null}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                  <input
                    className="question-note"
                    value={notes[q.id] ?? ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder={
                      q.options.length > 0 ? '也可以直接在这里写你的答案（会覆盖上面的选择）' : '请输入…'
                    }
                  />
                </div>
              )
            })}
          </div>

          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {isPlan
              ? '批准后我会按方案开始改动设备；写操作仍会逐次弹出危险操作确认。取消（Esc）则本轮结束，不碰任何设备。'
              : '回答后代理会带着答案继续当前任务，已连接的设备、已采集的回显都还在，无需重说一遍。'}
          </p>

          <div className="dialog-actions">
            <button className="btn" onClick={() => void answerQuestion(null)}>
              取消 (Esc)
            </button>
            <button
              className="btn primary"
              disabled={!canSubmit}
              onClick={() => void answerQuestion(answers)}
            >
              {isPlan ? '提交' : '回答并继续'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
