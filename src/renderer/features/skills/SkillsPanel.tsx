import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import {
  IconAlertTriangle,
  IconCheck,
  IconFolder,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconUpload,
  AdaptiveToolbar,
  AdaptiveButton
} from '@/components/ui'

/**
 * 技能面板（v1.3）。
 *
 * 左列：技能列表（启用勾选、删除、选中）。
 * 右列：编辑器 —— 名称 / 描述 / 正文（Markdown，不含 frontmatter）。
 * 保存时主进程统一组装成「frontmatter(name/description) + 正文」落盘，
 * 保证显示名称/描述与文件一致。
 *
 * 导入：系统文件多选（.md）或目录（递归收集 .md，覆盖 SKILL.md / *.skill.md）。
 * 启用含义：已启用技能的内容会注入代理每次运行的 system prompt。
 */

interface Notice {
  tone: 'info' | 'error' | 'ok'
  text: string
}

const NEW_SKILL_TEMPLATE = `# 技能说明

在这里写这个技能的用途、触发场景与操作手册（Markdown）。

## 用法
- 步骤一：…
- 步骤二：…

> 启用后，本内容会作为「已启用技能」注入代理的提示词。
`

/** 与主进程剥离 frontmatter 保持一致的本地小实现（渲染层不引入 main 代码） */
function stripFrontmatter(raw: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(raw.replace(/^\uFEFF/, ''))
  return m ? (m[1] ?? '').trim() : raw.trim()
}

export function SkillsPanel(): ReactNode {
  const skills = useApp((s) => s.skills)
  const loadSkills = useApp((s) => s.loadSkills)
  const saveSkill = useApp((s) => s.saveSkill)
  const removeSkill = useApp((s) => s.removeSkill)
  const toggleSkill = useApp((s) => s.toggleSkill)
  const importSkillFiles = useApp((s) => s.importSkillFiles)
  const importSkillDir = useApp((s) => s.importSkillDir)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const enabledCount = useMemo(() => skills.filter((s) => s.enabled).length, [skills])

  useEffect(() => {
    setNotice(null)
  }, [selectedId])

  const flash = (tone: Notice['tone'], text: string): void => {
    setNotice({ tone, text })
  }

  const openSkill = async (id: string): Promise<void> => {
    setLoading(true)
    try {
      const skill = await window.api.skill.get(id)
      if (!skill) {
        flash('error', '技能不存在或已被删除')
        setSelectedId(null)
        return
      }
      setSelectedId(id)
      setName(skill.name)
      setDescription(skill.description)
      setBody(stripFrontmatter(skill.content))
    } catch (e) {
      flash('error', e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const createNew = (): void => {
    setSelectedId(null)
    setName('')
    setDescription('')
    setBody(NEW_SKILL_TEMPLATE)
  }

  const save = async (): Promise<void> => {
    if (!body.trim()) {
      flash('error', '技能内容不能为空')
      return
    }
    setLoading(true)
    try {
      const r = await saveSkill({
        ...(selectedId ? { id: selectedId } : {}),
        name,
        description,
        content: body
      })
      flash('ok', selectedId ? '已保存' : '已创建')
      if (r) setSelectedId(r.id)
    } catch (e) {
      flash('error', e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const onToggle = (id: string, enabled: boolean): void => {
    void toggleSkill(id, enabled)
      .then(() => loadSkills())
      .catch((e: unknown) => flash('error', e instanceof Error ? e.message : String(e)))
  }

  const onRemove = async (id: string, skillName: string): Promise<void> => {
    if (!window.confirm(`删除技能「${skillName}」？此操作不可撤销。`)) return
    const ok = await removeSkill(id)
    if (ok && selectedId === id) {
      setSelectedId(null)
      setName('')
      setDescription('')
      setBody('')
    }
    flash(ok ? 'ok' : 'error', ok ? '已删除' : '删除失败')
  }

  const onImportFiles = async (): Promise<void> => {
    const r = await importSkillFiles()
    if (!r) return
    await loadSkills()
    flash(
      r.created.length > 0 ? 'ok' : 'info',
      r.created.length > 0
        ? `导入成功：${r.created.length} 个技能`
        : '没有新技能被导入'
    )
  }

  const onImportDir = async (): Promise<void> => {
    const r = await importSkillDir()
    if (!r) return
    await loadSkills()
    flash(
      r.created.length > 0 ? 'ok' : 'info',
      r.created.length > 0
        ? `导入成功：${r.created.length} 个技能${r.skipped.length > 0 ? `，跳过 ${r.skipped.length} 项` : ''}`
        : `目录中没有可导入的 .md 技能${r.skipped.length > 0 ? `（跳过 ${r.skipped.length} 项）` : ''}`
    )
  }

  return (
    <div className="skills-panel">
      <AdaptiveToolbar
        left={
          <div className="skills-toolbar-title">
            <IconSparkles size={15} style={{ color: 'var(--accent)' }} />
            技能库
            <span className="chip" style={{ marginLeft: 8 }}>
              已启用 {enabledCount}/{skills.length}
            </span>
          </div>
        }
        right={
          <>
            <AdaptiveButton
              icon={<IconUpload size={14} />}
              label="导入文件"
              priority="medium"
              onClick={() => void onImportFiles()}
              tooltip="从 .md 文件导入技能"
            />
            <AdaptiveButton
              icon={<IconFolder size={14} />}
              label="导入文件夹"
              priority="medium"
              onClick={() => void onImportDir()}
              tooltip="从目录递归收集 .md 导入"
            />
            <AdaptiveButton
              icon={<IconPlus size={14} />}
              label="新建技能"
              variant="primary"
              priority="high"
              onClick={createNew}
              tooltip="新建空白技能"
            />
          </>
        }
      />

      <div className="skills-hint">
        勾选启用的技能会成为代理的「已启用技能」，每次运行前注入提示词；技能是 Markdown
        说明书，可随时编辑与删除。
      </div>

      {notice ? (
        <div className={`banner ${notice.tone === 'error' ? 'danger' : notice.tone === 'ok' ? 'success' : 'info'}`}>
          {notice.tone === 'error' ? <IconAlertTriangle size={14} /> : <IconCheck size={14} />}
          {notice.text}
        </div>
      ) : null}

      <div className="skills-body">
        <div className="skills-list">
          {skills.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>
              <div className="empty-content">
                还没有技能。点击「导入文件 / 导入文件夹」从本机 Markdown 导入，
                或「新建技能」从零编写。
              </div>
            </div>
          ) : (
            skills.map((s) => (
              <div
                key={s.id}
                className={`skill-item${selectedId === s.id ? ' active' : ''}`}
                onClick={() => void openSkill(s.id)}
              >
                <div className="skill-item-main">
                  <div className="skill-item-title">
                    {s.builtin ? <span className="chip" style={{ fontSize: 10 }}>内置</span> : null}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                  </div>
                  {s.description ? (
                    <div className="skill-item-desc">{s.description}</div>
                  ) : null}
                </div>
                <div className="skill-item-actions" onClick={(e) => e.stopPropagation()}>
                  <label className="skill-toggle" title={s.enabled ? '停用：不再注入提示词' : '启用：注入提示词'}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) => void onToggle(s.id, e.target.checked)}
                    />
                    <span className="skill-toggle-track" />
                  </label>
                  <button
                    className="btn ghost icon sm danger-hover"
                    title="删除技能"
                    onClick={() => void onRemove(s.id, s.name)}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="skills-editor">
          {selectedId === null && body === '' && name === '' ? (
            <div className="empty" style={{ alignSelf: 'center', maxWidth: 360 }}>
              <div className="empty-icon-wrap">
                <IconSparkles size={22} />
              </div>
              <div className="empty-content">
                选择左侧技能进行编辑，或新建/导入一个技能。
              </div>
            </div>
          ) : (
            <>
              <div className="skills-editor-fields">
                <div className="field" style={{ flex: 2 }}>
                  <label>名称</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="技能名称" />
                </div>
                <div className="field" style={{ flex: 3 }}>
                  <label>描述</label>
                  <input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="一句话说明用途（可选）"
                  />
                </div>
              </div>
              <div className="field skills-editor-content">
                <label>内容（Markdown）</label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="# 技能说明&#10;&#10;在这里写操作手册…"
                  spellCheck={false}
                />
              </div>
              <div className="skills-editor-actions">
                <span className="hint">保存后 frontmatter 会自动与「名称/描述」同步。</span>
                <button className="btn primary" onClick={() => void save()} disabled={loading}>
                  <IconCheck size={14} />
                  {loading ? '保存中…' : selectedId ? '保存修改' : '创建技能'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}