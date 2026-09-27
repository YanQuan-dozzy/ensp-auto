/**
 * 模型切换器里的「逐模型快捷设置」浮层（v2.3）。
 *
 * 形态参考成熟客户端的模型列表：鼠标落在某一档上时，右侧滑出一小块面板，
 * 直接改这一档最常动的两项 —— 思考强度与「更大上下文（Max）」。
 * 为什么不做成设置页里再点两层：这两项是**每次任务都可能要换**的，
 * 放到设置弹窗里等于每次都要中断手头的活。
 *
 * 关键点：**选项由这一档模型的能力决定**（shared/model-thinking.ts）——
 * 强制思考的模型不出现「关闭」，只有开关没有强度参数的模型不出现档位按钮，
 * 未核实的服务商整块隐藏。硬编码「轻/高」两个按钮会在 GLM-5.3（只认 low/high/max）、
 * 豆包（minimal/low/medium/high）这些型号上直接把请求打成 400。
 */
import { type ReactNode } from 'react'
import { Switch } from '@/components/ui'
import {
  MAX_CONTEXT_WINDOW,
  REASONING_EFFORT_LABEL,
  type ModelProfile,
  type ReasoningEffort
} from '@shared/types'
import { effectiveContextWindow, formatContextWindow } from '@shared/profiles'
import { capabilityOf } from '@shared/model-thinking'

export function ModelQuickPanel({
  profile,
  onPatch,
  onClose
}: {
  profile: ModelProfile
  /** 只传要改的字段；调用方负责写回设置 */
  onPatch: (patch: Partial<ModelProfile>) => void
  onClose: () => void
}): ReactNode {
  const window = effectiveContextWindow(profile)
  const cap = capabilityOf(profile)

  return (
    <>
      <div className="menu-backdrop" onClick={onClose} onContextMenu={onClose} />
      <div className="model-quick" role="dialog" aria-label={`${profile.label} 的快捷设置`}>
        <div className="model-quick-title">{profile.label}</div>

        <div className="model-quick-row">
          <span className="model-quick-label">上下文窗口</span>
          <span className="model-quick-value">{formatContextWindow(window)}</span>
        </div>

        {cap.thinking === 'none' ? (
          <div className="model-quick-desc">{cap.note}</div>
        ) : (
          <>
            <div className="model-quick-sep" />
            <div className="model-quick-block">
              <div className="model-quick-label">思考强度</div>
              <div className="seg">
                {cap.thinking === 'toggle' ? (
                  <button
                    type="button"
                    className={`seg-item${profile.thinking === 'off' ? ' active' : ''}`}
                    onClick={() => onPatch({ thinking: 'off' })}
                    title="关闭思考：请求里显式下发关闭"
                  >
                    关闭
                  </button>
                ) : null}
                {cap.efforts.map((level: ReasoningEffort) => (
                  <button
                    key={level}
                    type="button"
                    className={`seg-item${
                      profile.thinking === 'on' && profile.reasoningEffort === level ? ' active' : ''
                    }`}
                    // 点强度即代表「开启思考」：用户在这里点某个档位的意图必然是
                    // 「打开并按这个强度来」，否则点完没有任何效果
                    onClick={() => onPatch({ thinking: 'on', reasoningEffort: level })}
                    title={`思考强度：${REASONING_EFFORT_LABEL[level]}`}
                  >
                    {REASONING_EFFORT_LABEL[level]}
                  </button>
                ))}
              </div>
              {profile.thinking === 'auto' ? (
                <div className="model-quick-hint">当前：跟随服务商默认（不下发思考参数）</div>
              ) : null}
              <div className="model-quick-desc">{cap.note}</div>
            </div>
          </>
        )}

        <div className="model-quick-sep" />

        <div className="model-quick-block">
          <div className="model-quick-switch">
            <span className="model-quick-label">更大上下文（Max）</span>
            <Switch checked={profile.maxContext} onChange={(v) => onPatch({ maxContext: v })} />
          </div>
          <div className="model-quick-desc">
            开启后上下文窗口扩展至 {formatContextWindow(MAX_CONTEXT_WINDOW)}，适用于复杂长任务；
            消耗的 token 也会明显变多。
          </div>
        </div>

        {/* v2.22（F17）：图片输入能力。
            放在这一层而不是只留在设置页里：它是「每次换模型都要确认一次」的属性 ——
            没开启时带图片的指令会被直接拦下，用户需要就地打开再发。 */}
        <div className="model-quick-sep" />

        <div className="model-quick-block">
          <div className="model-quick-switch">
            <span className="model-quick-label">支持图片输入</span>
            <Switch
              checked={profile.supportsImage}
              onChange={(v) => onPatch({ supportsImage: v })}
            />
          </div>
          <div className="model-quick-desc">
            开启后，导入的截图会直接附给模型，代理也能用 read_image 读取图片；
            关闭时带图片的指令会被拦下并提示（不支持的端点收到图片会直接报错）。
          </div>
        </div>
      </div>
    </>
  )
}