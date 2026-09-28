/**
 * 「编辑模型」弹窗（设置 → 模型 → 添加模型 / 点某一行）。
 *
 * 取舍说明：
 * - 本地草稿 + 点「保存模型」才落盘。密钥与模型参数是成套的，边打边落盘会出现
 *   「模型名改了、密钥还是旧的」这种半成品状态被真实请求用到。
 * - API 端点 / 自定义模型名这两项是本应用特有的能力（用户常把 baseUrl 指到中转或
 *   本地 Ollama / vLLM），所以即便参考版式里没有，也必须留在弹窗里；
 *   原生 provider（OpenAI / Anthropic / Google）不用端点，直接隐藏。
 */
import { useState, type ReactNode } from 'react'
import { ALL_PROVIDERS, PROVIDER_ORDER, isNativeProvider, type LlmProvider } from '@shared/providers'
import { useEscLayer } from '@/features/shortcuts/useEscLayer'
import {
  PROFILE_BOUNDS,
  REASONING_EFFORT_LABEL,
  THINKING_MODE_LABEL,
  type ModelProfile,
  type ReasoningEffort,
  type ThinkingMode
} from '@shared/types'
import { availableEfforts, capabilityOf, normalizeThinkingFields } from '@shared/model-thinking'
import { IconClose, IconInfo } from '@/components/ui'

/** 上下文窗口 / 输出上限的快捷档位（与参考版式一致） */
const CTX_CHIPS = [
  { label: '128k', value: 128000 },
  { label: '256k', value: 256000 },
  { label: '512k', value: 512000 },
  { label: '1M', value: 1000000 }
]
const OUT_CHIPS = [
  { label: '4k', value: 4000 },
  { label: '16k', value: 16000 },
  { label: '32k', value: 32000 },
  { label: '128k', value: 128000 }
]

/** 自定义模型名的哨兵值（下拉里选它就切回自由输入） */
const CUSTOM_MODEL = '__custom__'

export function ModelEditorDialog({
  profile,
  isNew,
  hasKey,
  onClose,
  onSave
}: {
  /** 打开时的初值（编辑 = 该档副本；新增 = 空白草稿） */
  profile: ModelProfile
  isNew: boolean
  /** 该档是否已存过密钥（只影响占位文案，密钥本身不回传渲染层） */
  hasKey: boolean
  onClose: () => void
  /** key 非空时才需要落盘密钥 */
  onSave: (next: ModelProfile, key: string) => Promise<void>
}): ReactNode {
  const [draft, setDraft] = useState<ModelProfile>(() => ({ ...profile }))
  const [keyDraft, setKeyDraft] = useState('')
  const [advanced, setAdvanced] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  /**
   * N66：Esc 只关本层。
   *
   * 这个弹窗是**本地草稿 + 点保存才落盘**（见文件头取舍说明），误按 Esc 的代价
   * 是「填了十几个字段的草稿静默丢失」。原实现没有任何 Esc 处理，而
   * `SettingsDialog` 在冒泡阶段、`App.tsx` 在捕获阶段都会把 Esc 变成「关掉整个设置页」——
   * 一次按键连关两层。`useEscLayer` 同时解决两件事：捕获阶段 `stopPropagation`
   * 挡住 SettingsDialog，认领一层让 App 的全局监听早退。
   */
  useEscLayer(onClose)

  const meta = ALL_PROVIDERS[draft.provider]
  const models = meta?.models ?? []
  const manualModel = models.length === 0 || !models.includes(draft.model)
  const isNative = isNativeProvider(draft.provider)
  // v2.3：这一档模型「实际支持什么」—— 能否关思考、支持哪几档强度、接不接受采样参数
  const cap = capabilityOf(draft)

  const patch = (p: Partial<ModelProfile>): void => setDraft((d) => ({ ...d, ...p }))

  /** 换模型/换服务商后，思考模式与强度必须按新模型的能力重新收敛 */
  const patchModelFields = (next: Partial<ModelProfile>): void =>
    setDraft((d) => {
      const merged = { ...d, ...next }
      return { ...merged, ...normalizeThinkingFields(merged) }
    })

  /**
   * 切服务商：端点与模型名仍停留在「已知默认值」时才跟着换 ——
   * 用户手填过中转地址 / 私有模型名时不动它，避免把自定义配置冲掉。
   */
  const onProviderChange = (next: LlmProvider): void => {
    const nextMeta = ALL_PROVIDERS[next]
    const knownBase = (v: string): boolean =>
      !v.trim() || Object.values(ALL_PROVIDERS).some((m) => !!m.defaultBaseUrl && m.defaultBaseUrl === v.trim())
    const nextModel = nextMeta.models[0] ?? ''
    const keepModel = !knownBase(draft.model) && !models.includes(draft.model)
    const model = keepModel ? draft.model : nextModel
    const merged: ModelProfile = {
      ...draft,
      provider: next,
      baseUrl: knownBase(draft.baseUrl) ? nextMeta.defaultBaseUrl : draft.baseUrl,
      model,
      label: model || nextMeta.label
    }
    setDraft({ ...merged, ...normalizeThinkingFields(merged) })
  }

  const onModelChange = (model: string): void => patchModelFields({ model, label: model })

  const save = async (): Promise<void> => {
    if (!draft.model.trim() || saving) return
    setSaving(true)
    setSaveError('')
    try {
      await onSave(
        {
          ...draft,
          model: draft.model.trim(),
          baseUrl: draft.baseUrl.trim(),
          label: draft.label.trim() || draft.model.trim()
        },
        keyDraft.trim()
      )
    } catch (e) {
      // 失败留在弹窗里，把原因亮出来 —— 否则用户只看到「点了保存但没反应」
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={isNew ? '添加模型' : '编辑模型'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog model-editor">
        <div className="model-editor-head">
          <div className="dialog-title">{isNew ? '添加模型' : '编辑模型'}</div>
          <button className="btn ghost icon sm" onClick={onClose} title="关闭">
            <IconClose size={15} />
          </button>
        </div>

        <div className="model-editor-body">
          <label className="field">
            <span className="field-label">
              <i className="req">*</i>服务商
            </span>
            <select value={draft.provider} onChange={(e) => onProviderChange(e.target.value as LlmProvider)}>
              {PROVIDER_ORDER.map((p) => (
                <option key={p} value={p}>
                  {ALL_PROVIDERS[p].label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">
              <i className="req">*</i>模型
            </span>
            {models.length > 0 ? (
              <select
                value={manualModel ? CUSTOM_MODEL : draft.model}
                onChange={(e) =>
                  e.target.value === CUSTOM_MODEL
                    ? onModelChange('')
                    : onModelChange(e.target.value)
                }
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>自定义模型名…</option>
              </select>
            ) : null}
            {manualModel ? (
              <input
                value={draft.model}
                onChange={(e) => onModelChange(e.target.value)}
                placeholder="填服务商支持的模型名，例如 my-model-v1"
                autoFocus={models.length === 0}
              />
            ) : null}
          </label>

          <label className="field">
            <span className="field-label">
              <span className="field-label-line">
                API 密钥
                {meta?.keyUrl ? (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => void window.api.app.openExternal(meta.keyUrl)}
                  >
                    获取 API 密钥
                  </button>
                ) : null}
              </span>
            </span>
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={hasKey ? '留空则保持该档现有密钥' : '粘贴密钥'}
              autoComplete="off"
            />
          </label>

          <div className="model-editor-adv">
            <button
              type="button"
              className="model-editor-adv-head"
              onClick={() => setAdvanced((v) => !v)}
            >
              高级配置
              <span className={`collapse-caret${advanced ? '' : ' closed'}`}>⌄</span>
            </button>

            {advanced ? (
              <div className="model-editor-adv-body">
                {!isNative ? (
                  <label className="field">
                    <span className="field-label">API 端点</span>
                    <input
                      value={draft.baseUrl}
                      onChange={(e) => patch({ baseUrl: e.target.value })}
                      placeholder={meta?.defaultBaseUrl || 'OpenAI 兼容端点地址'}
                    />
                  </label>
                ) : null}

                <div className="field">
                  <span className="field-label">上下文窗口（Token）</span>
                  <div className="token-row">
                    <span className="token-label">输入</span>
                    <input
                      type="number"
                      min={PROFILE_BOUNDS.contextWindow.min}
                      max={PROFILE_BOUNDS.contextWindow.max}
                      value={draft.contextWindow}
                      onChange={(e) => patch({ contextWindow: Number(e.target.value) || 0 })}
                    />
                    <span className="token-chips">
                      {CTX_CHIPS.map((c) => (
                        <button
                          type="button"
                          key={c.label}
                          className={`token-chip${draft.contextWindow === c.value ? ' active' : ''}`}
                          onClick={() => patch({ contextWindow: c.value })}
                        >
                          {c.label}
                        </button>
                      ))}
                    </span>
                  </div>
                  <div className="token-row">
                    <span className="token-label">输出</span>
                    <input
                      type="number"
                      min={PROFILE_BOUNDS.maxOutputTokens.min}
                      max={PROFILE_BOUNDS.maxOutputTokens.max}
                      value={draft.maxOutputTokens}
                      onChange={(e) => patch({ maxOutputTokens: Number(e.target.value) || 0 })}
                    />
                    <span className="token-chips">
                      {OUT_CHIPS.map((c) => (
                        <button
                          type="button"
                          key={c.label}
                          className={`token-chip${draft.maxOutputTokens === c.value ? ' active' : ''}`}
                          onClick={() => patch({ maxOutputTokens: c.value })}
                        >
                          {c.label}
                        </button>
                      ))}
                    </span>
                  </div>
                </div>

                <label className="field">
                  <span className="field-label">工具调用轮数</span>
                  <input
                    type="number"
                    min={PROFILE_BOUNDS.maxRounds.min}
                    max={PROFILE_BOUNDS.maxRounds.max}
                    value={draft.maxRounds}
                    onChange={(e) => patch({ maxRounds: Number(e.target.value) || 1 })}
                  />
                </label>

                <div className="field">
                  <span className="field-label">
                    支持图片输入
                    <span
                      className="field-hint-icon"
                      title={
                        '声明该档能否接收图片内容块。\n' +
                        '「支持」：导入的图片会直接附给模型，代理也能用 read_image 读取受管目录里的图片。\n' +
                        '「不支持」：带图片的指令会被拦下并提示（图片发出去必然被端点拒绝，所以在本地拦），\n' +
                        '要用图片请改为「支持」或切换到支持视觉的模型档。'
                      }
                    >
                      <IconInfo size={12} />
                    </span>
                  </span>
                  <div className="radio-line">
                    <Radio
                      name="supports-image"
                      checked={draft.supportsImage}
                      label="支持"
                      onChange={() => patch({ supportsImage: true })}
                    />
                    <Radio
                      name="supports-image"
                      checked={!draft.supportsImage}
                      label="不支持"
                      onChange={() => patch({ supportsImage: false })}
                    />
                  </div>
                </div>

                <div className="field">
                  <span className="field-label">
                    思考模式
                    <span
                      className="field-hint-icon"
                      title="按这一档模型的官方参数口径给出可选项：强制思考的模型（GLM-5.3 / Kimi K3 等）不接受关闭，未核实的服务商不下发任何思考参数"
                    >
                      <IconInfo size={12} />
                    </span>
                  </span>
                  {cap.thinking === 'none' ? (
                    <div className="field-note">{cap.note}</div>
                  ) : cap.thinking === 'always' ? (
                    <>
                      <div className="field-note">{cap.note}</div>
                      <div className="radio-line">
                        <Radio
                          name="thinking"
                          checked={draft.thinking === 'on'}
                          label="开启思考（该模型唯一的可用状态）"
                          onChange={() => patch({ thinking: 'on' })}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="radio-line">
                      {(['auto', 'on', 'off'] as ThinkingMode[]).map((m) => (
                        <Radio
                          key={m}
                          name="thinking"
                          checked={draft.thinking === m}
                          label={THINKING_MODE_LABEL[m]}
                          onChange={() => patch({ thinking: m })}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {cap.thinking !== 'none' ? (
                  <div className="field">
                    <span className="field-label">
                      思考强度
                      <span className="field-hint-icon" title="各家的档位名称与实际可选项不同，这里只列这一档模型真正接受的档位">
                        <IconInfo size={12} />
                      </span>
                    </span>
                    {cap.efforts.length === 0 ? (
                      <div className="field-note">该模型没有强度档位（只支持开关）。</div>
                    ) : (
                      <div className="seg">
                        {availableEfforts(cap).map((level: ReasoningEffort) => (
                          <button
                            key={level}
                            type="button"
                            className={`seg-item${
                              draft.thinking === 'on' && draft.reasoningEffort === level ? ' active' : ''
                            }`}
                            onClick={() => patch({ thinking: 'on', reasoningEffort: level })}
                          >
                            {REASONING_EFFORT_LABEL[level]}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}

                <div className="field">
                  <span className="field-label">
                    采样参数
                    <span className="field-hint-icon" title="留空即用服务商默认值；同时设置了 Top P 与 Top K 时，具体以服务商实现为准">
                      <IconInfo size={12} />
                    </span>
                  </span>
                  {cap.sampling ? null : (
                    <div className="field-note">
                      该模型不接受 sampling 参数（传非默认值会报错），请求里不会下发这三项。
                    </div>
                  )}
                  <div className="sampling-row">
                    <span className="sampling-label">Temperature</span>
                    <input
                      type="number"
                      step={0.1}
                      min={PROFILE_BOUNDS.temperature.min}
                      max={PROFILE_BOUNDS.temperature.max}
                      value={draft.temperature}
                      disabled={!cap.sampling}
                      onChange={(e) => patch({ temperature: Number(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="sampling-row">
                    <span className="sampling-label">Top P</span>
                    <input
                      type="number"
                      step={0.05}
                      min={PROFILE_BOUNDS.topP.min}
                      max={PROFILE_BOUNDS.topP.max}
                      value={draft.topP ?? ''}
                      disabled={!cap.sampling}
                      placeholder="留空使用最佳配置，或输入 0 ~ 1 之间的数值"
                      onChange={(e) =>
                        patch({ topP: e.target.value === '' ? null : Number(e.target.value) })
                      }
                    />
                  </div>
                  <div className="sampling-row">
                    <span className="sampling-label">Top K</span>
                    <input
                      type="number"
                      min={PROFILE_BOUNDS.topK.min}
                      max={PROFILE_BOUNDS.topK.max}
                      value={draft.topK ?? ''}
                      disabled={!cap.sampling}
                      placeholder="留空使用最佳配置，或输入 1 ~ 100 之间的数值"
                      onChange={(e) =>
                        patch({ topK: e.target.value === '' ? null : Number(e.target.value) })
                      }
                    />
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="model-editor-foot">
          <span className="model-editor-note">
            <IconInfo size={12} />
            {saveError ? (
              <span className="model-editor-error">保存失败：{saveError}</span>
            ) : (
              '点「保存模型」后，可直接用列表里的测试按钮发一次真实请求验证连通性'
            )}
          </span>
          <span className="model-editor-actions">
            <button className="btn sm" onClick={() => setDraft({ ...profile, id: draft.id })}>
              重置
            </button>
            <button
              className="btn sm primary"
              onClick={() => void save()}
              disabled={!draft.model.trim() || saving}
            >
              {saving ? '保存中…' : '保存模型'}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

/** 单选：原生 input 的外观在不同平台差异大，这里统一成小圆点 + 文字 */
function Radio({
  name,
  checked,
  label,
  onChange
}: {
  name: string
  checked: boolean
  label: string
  onChange: () => void
}): ReactNode {
  return (
    <label className="radio">
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span className="radio-dot" />
      <span>{label}</span>
    </label>
  )
}