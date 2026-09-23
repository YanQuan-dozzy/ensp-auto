/**
 * 设置 → 模型 分区（T5.8 从 SettingsDialog.tsx 外提）。
 *
 * 自包含：本地草稿 + 即时落盘（每次改动都 updateSettings），
 * 与拆分前「在 SettingsDialog 组件里」的行为逐条等价 —— 这些字段本来就是
 * 「改了立即生效」的，摘成独立组件后只在进入该分区时初始化一次，反而更贴合分区语义。
 */
import { useEffect, useState } from 'react'
import { useApp } from '@/stores/app'
import { ALL_PROVIDERS, PROVIDER_ORDER, type LlmProvider } from '@shared/providers'
import { labelFor, newProfileId } from '@shared/profiles'
import type { ModelProfile } from '@shared/types'
import {
  COMPACTION_BOUNDS,
  RETRY_BOUNDS,
  sanitizeCompaction,
  sanitizeRetry,
  type CompactionSettings,
  type RetrySettings
} from '@shared/runtime-policy'
import { Switch } from '@/components/ui'
import { Row, Section } from '@/components/settings-kit'
import { ApiKeyRow } from './ApiKeyRow'

export function ProfileSettings() {
  const updateSettings = useApp((s) => s.updateSettings)
  const setProfileKey = useApp((s) => s.setProfileKey)
  const configuredProfileIds = useApp((s) => s.configuredProfileIds)
  const settings = useApp((s) => s.settings)

  // —— 模型档案（本地草稿 + 即时落盘：每个改动都 updateSettings）——
  const [draft, setDraft] = useState<ModelProfile[]>(() =>
    settings.agent.profiles.map((p) => ({ ...p }))
  )
  const [activeId, setActiveId] = useState(settings.agent.activeProfileId)
  const [systemPrompt, setSystemPrompt] = useState(settings.agent.systemPrompt)
  const [rounds, setRounds] = useState('12')
  const [temp, setTemp] = useState('0.2')

  const [runtime, setRuntime] = useState(settings.agent.runtime)
  // v1.7：请求韧性 / 上下文压缩。注意：这里的改动与模型档案一样是「即时落盘」的
  // （底栏 foot 文案也明说「所有配置改动即时生效」），不要误写成「点保存才落盘」
  const [retryDraft, setRetryDraft] = useState<RetrySettings>(() => ({ ...settings.retry }))
  const [compactDraft, setCompactDraft] = useState<CompactionSettings>(() => ({
    ...settings.compaction
  }))

  const current = draft.find((p) => p.id === activeId) ?? draft[0]!

  // 切档时把数值输入框重置为该档的值。
  // 刻意只依赖 current.id：数值框允许空串（清空重打），若把 maxRounds/temperature
  // 也放进依赖，用户每敲一个字符都会把输入框弹回 draft 的值，反而打不进去。
  useEffect(() => {
    setRounds(String(current.maxRounds))
    setTemp(String(current.temperature))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id])

  const patchCurrent = (patch: Partial<ModelProfile>): void => {
    const nextProfiles = draft.map((p) => (p.id === current.id ? { ...p, ...patch } : p))
    setDraft(nextProfiles)
    // v1.8：从 getState 读最新 agent（不用渲染闭包），避免连击快速补丁时基于过期快照互相覆盖
    void updateSettings({
      agent: { ...useApp.getState().settings.agent, profiles: nextProfiles, activeProfileId: activeId }
    })
  }

  /**
   * 切换服务商：若端点/模型名仍是「某个 provider 的默认值」（说明没被自定义过），
   * 就带出新 provider 的默认端点与推荐模型 —— 避免「改了服务商忘了改端点」。
   */
  const onProviderChange = (next: LlmProvider): void => {
    const meta = ALL_PROVIDERS[next]
    if (!meta) return
    const isKnownDefault = (v: string): boolean =>
      !v.trim() ||
      Object.values(ALL_PROVIDERS).some((m) => !!m.defaultBaseUrl && m.defaultBaseUrl === v.trim())
    const isKnownModel = (v: string): boolean =>
      !v.trim() || Object.values(ALL_PROVIDERS).some((m) => m.models.includes(v.trim()))
    const patch: Partial<ModelProfile> = { provider: next }
    if (isKnownDefault(current.baseUrl)) patch.baseUrl = meta.defaultBaseUrl
    if (isKnownModel(current.model)) patch.model = meta.models[0] ?? ''
    patchCurrent(patch)
  }

  /** 新增一档：从当前档复制，省掉重填端点与模型；随后自动切到新档 */
  const addProfile = (): void => {
    const copy: ModelProfile = {
      ...current,
      id: newProfileId(),
      label: `${labelFor(current.provider, current.model)} 副本`
    }
    const nextProfiles = [...draft, copy]
    setDraft(nextProfiles)
    setActiveId(copy.id)
    void updateSettings({
      // R25：读最新 agent（不用渲染闭包），避免与其它分区的写入互相覆盖
      agent: {
        ...useApp.getState().settings.agent,
        profiles: nextProfiles,
        activeProfileId: copy.id
      }
    })
  }

  /** 删除一档：至少留一档；删掉的若配过密钥，顺手清掉，避免密钥文件里留孤儿 */
  const removeProfile = async (): Promise<void> => {
    if (draft.length <= 1) return
    const gone = current.id
    const nextProfiles = draft.filter((p) => p.id !== gone)
    const nextActive = nextProfiles[0]!.id
    setDraft(nextProfiles)
    setActiveId(nextActive)
    if (configuredProfileIds.includes(gone)) await setProfileKey(gone, '')
    void updateSettings({
      agent: {
        ...useApp.getState().settings.agent,
        profiles: nextProfiles,
        activeProfileId: nextActive
      }
    })
  }

  const providerMeta = ALL_PROVIDERS[current.provider]
  const isNative =
    current.provider === 'openai' || current.provider === 'anthropic' || current.provider === 'google'
  const currentKeyed = configuredProfileIds.includes(current.id)

  return (
                      <>
                        <Section
                          label="模型档案"
                          action={
                            <span className="set-section-actions">
                              <button className="btn sm" onClick={addProfile} title="复制当前档为新的一档">
                                新增档案
                              </button>
                              <button
                                className="btn sm"
                                onClick={() => void removeProfile()}
                                disabled={draft.length <= 1}
                                title={draft.length <= 1 ? '至少保留一档' : '删除当前档案'}
                              >
                                删除
                              </button>
                            </span>
                          }
                        >
                          <Row
                            title="当前档案"
                            desc="代理实际使用的那一档；每档的端点、模型与密钥互相独立。"
                            control={
                              <>
                                <select
                                  value={current.id}
                                  onChange={(e) => {
                                    const nextId = e.target.value
                                    setActiveId(nextId)
                                    void updateSettings({
                                      agent: {
                                        ...useApp.getState().settings.agent,
                                        activeProfileId: nextId
                                      }
                                    })
                                  }}
                                >
                                  {draft.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.label || labelFor(p.provider, p.model)}
                                      {configuredProfileIds.includes(p.id) ? '（已配置密钥）' : ''}
                                    </option>
                                  ))}
                                </select>
                                <span className={`chip${currentKeyed ? ' success' : ''}`}>
                                  {currentKeyed ? '已配置' : '未配置'}
                                </span>
                              </>
                            }
                          />
                          <Row
                            title="档案名"
                            desc="只用于你自己辨认，随便改；留空则按服务商与模型名自动生成。"
                            control={
                              <input
                                value={current.label}
                                onChange={(e) => patchCurrent({ label: e.target.value })}
                                placeholder={labelFor(current.provider, current.model)}
                              />
                            }
                          />
                        </Section>
      
                        <Section label="服务商与端点">
                          <Row
                            title="服务商"
                            desc="国产平台（DeepSeek / 智谱 / 千问 / Kimi / 豆包 / 千帆 / MiniMax）与自定义端点走 OpenAI 兼容协议；其余走各自官方原生 API。"
                            control={
                              <select
                                value={current.provider}
                                onChange={(e) => onProviderChange(e.target.value as LlmProvider)}
                              >
                                {PROVIDER_ORDER.map((p) => (
                                  <option key={p} value={p}>
                                    {ALL_PROVIDERS[p].label}
                                  </option>
                                ))}
                              </select>
                            }
                          />
                          <Row
                            title="API 端点"
                            desc={
                              isNative
                                ? 'OpenAI / Anthropic / Google 走官方原生 API，此字段不生效。'
                                : `默认 ${providerMeta.defaultBaseUrl || '留空'}，可填任何 OpenAI 兼容端点：Kimi / Ollama / vLLM 等`
                            }
                            control={
                              <input
                                value={current.baseUrl}
                                onChange={(e) => patchCurrent({ baseUrl: e.target.value })}
                                placeholder={providerMeta.defaultBaseUrl || 'OpenAI 兼容端点地址'}
                              />
                            }
                          />
                          <Row
                            title="模型名"
                            desc={
                              isNative
                                ? '候选为 2026-09 各厂商官方最新模型名；官方 API 保存时会校验模型目录。'
                                : '候选为 2026-09 各厂商官方最新模型名；OpenAI 兼容线可任意填写。'
                            }
                            control={
                              <>
                                <input
                                  list="model-suggestions"
                                  value={current.model}
                                  onChange={(e) => patchCurrent({ model: e.target.value })}
                                  placeholder={providerMeta.models[0] ?? '模型名'}
                                />
                                <datalist id="model-suggestions">
                                  {providerMeta.models.map((m) => (
                                    <option key={m} value={m} />
                                  ))}
                                </datalist>
                              </>
                            }
                          />
                        </Section>
      
                        <ApiKeyRow
                          currentKeyed={currentKeyed}
                          onSaveKey={(k) => setProfileKey(current.id, k)}
                          onClearKey={() => void setProfileKey(current.id, '')}
                        />
      
                        <Section label="运行参数">
                          <Row
                            title="运行时"
                            desc="全局设置，不随档案切换；未配置密钥时会自动回退到 mock，不会因缺配置而报错。"
                            control={
                              <select
                                value={runtime}
                                onChange={(e) => {
                                  const next = e.target.value as 'react' | 'mock'
                                  setRuntime(next)
                                  void updateSettings({
                                    agent: { ...useApp.getState().settings.agent, runtime: next }
                                  })
                                }}
                              >
                                <option value="react">真实运行时（自研 ReAct 循环）</option>
                                <option value="mock">mock 运行时（离线回放）</option>
                              </select>
                            }
                          />
                          <Row
                            title="最大轮次"
                            desc="本档的轮次上限，用于防止代理在失败路径上无限重试。"
                            control={
                              <input
                                type="number"
                                min={1}
                                max={50}
                                value={rounds}
                                onChange={(e) => {
                                  setRounds(e.target.value)
                                  const n = Number.parseInt(e.target.value, 10)
                                  if (Number.isFinite(n)) {
                                    patchCurrent({ maxRounds: Math.max(1, Math.min(50, n)) })
                                  }
                                }}
                              />
                            }
                          />
                          <Row
                            title="温度"
                            desc="本档的采样随机性，越低越稳定，建议 0 ~ 0.3。"
                            control={
                              <input
                                type="number"
                                step={0.1}
                                min={0}
                                max={2}
                                value={temp}
                                onChange={(e) => {
                                  setTemp(e.target.value)
                                  const n = Number(e.target.value)
                                  if (Number.isFinite(n)) {
                                    patchCurrent({ temperature: Math.max(0, Math.min(2, n)) })
                                  }
                                }}
                              />
                            }
                          />
                        </Section>
      
                        <Section label="自定义指令">
                          <Row
                            title="追加指令"
                            desc="写完的这段文字会拼在基础系统提示词之后，作为常驻要求（技能内容会附在其后）。留空表示不加。"
                            stacked
                            control={
                              <textarea
                                value={systemPrompt}
                                onChange={(e) => {
                                  const val = e.target.value
                                  setSystemPrompt(val)
                                  void updateSettings({
                                    agent: {
                                      ...useApp.getState().settings.agent,
                                      systemPrompt: val
                                    }
                                  })
                                }}
                                placeholder="例如：实验命名统一用 Lab-N 前缀；配置前先说明将要下发的命令。"
                                rows={4}
                              />
                            }
                          />
                        </Section>
      
                        <Section label="请求韧性">
                          <Row
                            title="失败自动重试"
                            desc="只重试临时性失败（限流 429、超时、5xx、连接中断）；密钥无效、模型名不存在、额度耗尽这类确定性错误会立刻失败 —— 重试它们只是让你多等几秒看到同一个错。"
                            control={
                              <Switch
                                checked={retryDraft.enabled}
                                onChange={(v) => {
                                  const next = { ...retryDraft, enabled: v }
                                  setRetryDraft(next)
                                  void updateSettings({ retry: next })
                                }}
                              />
                            }
                          />
                          <Row
                            title="最大重试次数"
                            desc="不含首次调用。等待按指数退避（基数 × 2 的 n-1 次方，上限 30 秒），并带 0~25% 随机抖动。"
                            control={
                              <input
                                type="number"
                                min={RETRY_BOUNDS.maxRetries.min}
                                max={RETRY_BOUNDS.maxRetries.max}
                                value={retryDraft.maxRetries}
                                disabled={!retryDraft.enabled}
                                onChange={(e) => {
                                  const next = sanitizeRetry(
                                    { ...retryDraft, maxRetries: e.target.value },
                                    retryDraft
                                  )
                                  setRetryDraft(next)
                                  void updateSettings({ retry: next })
                                }}
                              />
                            }
                          />
                          <Row
                            title="退避基数（毫秒）"
                            desc="第一次重试的等待时长，之后翻倍。设得太小会在对端限流时反复撞墙。"
                            control={
                              <input
                                type="number"
                                step={100}
                                min={RETRY_BOUNDS.baseDelayMs.min}
                                max={RETRY_BOUNDS.baseDelayMs.max}
                                value={retryDraft.baseDelayMs}
                                disabled={!retryDraft.enabled}
                                onChange={(e) => {
                                  const next = sanitizeRetry(
                                    { ...retryDraft, baseDelayMs: e.target.value },
                                    retryDraft
                                  )
                                  setRetryDraft(next)
                                  void updateSettings({ retry: next })
                                }}
                              />
                            }
                          />
                        </Section>
      
                        <Section label="上下文压缩">
                          <Row
                            title="自动压缩历史"
                            desc="代理干活时会累积大量命令回显（一条 display current-configuration 就可能几十万字符）。开启后超出预算的旧轮次会被压成摘要：只改内容、不删消息，任务目标与最近几轮保持原文，用户说的每一句话也原样保留。"
                            control={
                              <Switch
                                checked={compactDraft.enabled}
                                onChange={(v) => {
                                  const next = { ...compactDraft, enabled: v }
                                  setCompactDraft(next)
                                  void updateSettings({ compaction: next })
                                }}
                              />
                            }
                          />
                          <Row
                            title="单条工具结果上限"
                            desc="超出即保头 60% + 保尾 40%（结论通常在末尾），并附一句「如何拿全」。界面上的工具输出仍是完整的，这里只限制交给模型的那一份。"
                            control={
                              <input
                                type="number"
                                step={1000}
                                min={COMPACTION_BOUNDS.toolResultMaxChars.min}
                                max={COMPACTION_BOUNDS.toolResultMaxChars.max}
                                value={compactDraft.toolResultMaxChars}
                                disabled={!compactDraft.enabled}
                                onChange={(e) => {
                                  const next = sanitizeCompaction(
                                    { ...compactDraft, toolResultMaxChars: e.target.value },
                                    compactDraft
                                  )
                                  setCompactDraft(next)
                                  void updateSettings({ compaction: next })
                                }}
                              />
                            }
                          />
                          <Row
                            title="上下文预算（字符）"
                            desc="按字符估算而非 token —— 本地没有分词器，宁可估得保守。超出这个预算才开始压缩老轮次。"
                            control={
                              <input
                                type="number"
                                step={10000}
                                min={COMPACTION_BOUNDS.transcriptMaxChars.min}
                                max={COMPACTION_BOUNDS.transcriptMaxChars.max}
                                value={compactDraft.transcriptMaxChars}
                                disabled={!compactDraft.enabled}
                                onChange={(e) => {
                                  const next = sanitizeCompaction(
                                    { ...compactDraft, transcriptMaxChars: e.target.value },
                                    compactDraft
                                  )
                                  setCompactDraft(next)
                                  void updateSettings({ compaction: next })
                                }}
                              />
                            }
                          />
                          <Row
                            title="保留最近轮数"
                            desc="这几轮的原文不动，只压更早的轮次；第一轮（任务描述与附件清单）永远保留。"
                            control={
                              <input
                                type="number"
                                min={COMPACTION_BOUNDS.keepRounds.min}
                                max={COMPACTION_BOUNDS.keepRounds.max}
                                value={compactDraft.keepRounds}
                                disabled={!compactDraft.enabled}
                                onChange={(e) => {
                                  const next = sanitizeCompaction(
                                    { ...compactDraft, keepRounds: e.target.value },
                                    compactDraft
                                  )
                                  setCompactDraft(next)
                                  void updateSettings({ compaction: next })
                                }}
                              />
                            }
                          />
                        </Section>
                      </>
  )
}