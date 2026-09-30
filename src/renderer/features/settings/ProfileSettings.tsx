/**
 * 设置 → 模型 分区（T5.8 从 SettingsDialog.tsx 外提，v2.3 改为表格版式）。
 *
 * 版式：模型管理是一张表（模型 / 服务商 / 操作），增删改走「编辑模型」弹窗 ——
 * 一档模型的字段有十来个（端点、密钥、上下文窗口、思考模式、采样参数…），
 * 平铺在设置页里会让「有哪些模型」这件事反而看不见。
 *
 * 落盘语义：表格里的开关（启用）即时生效；弹窗里的字段点「保存模型」才生效 ——
 * 一档模型的参数是成套的，边打边落盘会让半成品配置被下一次真实请求用到。
 */
import { useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import { ALL_PROVIDERS } from '@shared/providers'
import { newProfileDraft, withProfileEnabled, activeProfile } from '@shared/profiles'
import type { AgentSettings, ModelProfile } from '@shared/types'
import {
  COMPACTION_BOUNDS,
  RETRY_BOUNDS,
  sanitizeCompaction,
  sanitizeRetry,
  type CompactionSettings,
  type RetrySettings
} from '@shared/runtime-policy'
import {
  Switch,
  DismissibleBanner,
  IconActivity,
  IconCpu,
  IconPlus,
  IconTrash,
  type BannerTone
} from '@/components/ui'
import { Row, Section } from '@/components/settings-kit'
import {
  CONCURRENCY_BOUNDS,
  sanitizeConcurrency,
  type ConcurrencySettings
} from '@shared/concurrency'
import {
  sanitizeRepeatGuard,
  type RepeatGuardSettings
} from '@shared/repeat-guard'
import {
  TITLE_BOUNDS,
  canGenerateTitle,
  sanitizeTitleSettings,
  type TitleSettings
} from '@shared/session-title'
import { ModelEditorDialog } from './ModelEditorDialog'
import type { ProfileTestResult } from '@shared/api'

/** 探活结论 → banner 配色（skipped 只算提示，不是错误） */
const TEST_TONE: Record<ProfileTestResult['level'], BannerTone> = {
  ok: 'success',
  warn: 'pending',
  fail: 'danger',
  skipped: 'info'
}

export function ProfileSettings(): ReactNode {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const setProfileKey = useApp((s) => s.setProfileKey)
  const configuredProfileIds = useApp((s) => s.configuredProfileIds)

  const agent = settings.agent
  const profiles = agent.profiles

  /** 编辑弹窗（null = 未打开） */
  const [editor, setEditor] = useState<{ profile: ModelProfile; isNew: boolean } | null>(null)
  /** 正在测试的档案 id */
  const [testing, setTesting] = useState<string | null>(null)
  /** 最近一次连通性测试结论 */
  const [tested, setTested] = useState<{ name: string; r: ProfileTestResult } | null>(null)

  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt)
  const [runtime, setRuntime] = useState(agent.runtime)
  // v1.7：请求韧性 / 上下文压缩。注意：这里的改动与表格里的开关一样是「即时落盘」的
  // （底栏 foot 文案也明说「其余配置改动即时生效」），不要误写成「点保存才落盘」
  const [retryDraft, setRetryDraft] = useState<RetrySettings>(() => ({ ...settings.retry }))
  const [compactDraft, setCompactDraft] = useState<CompactionSettings>(() => ({
    ...settings.compaction
  }))
  // v2.5：并发上限。老配置里可能没有这一块（sanitize 会补默认值），不能直接 spread
  const [concurrencyDraft, setConcurrencyDraft] = useState<ConcurrencySettings>(() =>
    sanitizeConcurrency(settings.concurrency)
  )
  // v2.8：会话标题。老配置没有这一块，必须 sanitize 补默认（默认关闭）
  const [titleDraft, setTitleDraft] = useState<TitleSettings>(() =>
    sanitizeTitleSettings(settings.title)
  )
  // v2.14：重复调用防护。老配置同样没有这一块，sanitize 补默认（默认开启）
  const [repeatGuardDraft, setRepeatGuardDraft] = useState<RepeatGuardSettings>(() =>
    sanitizeRepeatGuard(settings.repeatGuard)
  )

  /** 写 agent 分区：读 getState 拿最新值，避免连击快速写入时基于过期快照互相覆盖 */
  const writeAgent = (patch: Partial<AgentSettings>): Promise<void> =>
    updateSettings({ agent: { ...useApp.getState().settings.agent, ...patch } })

  /** 保存弹窗：新增 = 追加并切为活跃档；编辑 = 覆盖。密钥留空表示不改这一档的密钥 */
  const saveProfile = async (next: ModelProfile, key: string): Promise<void> => {
    const exists = useApp.getState().settings.agent.profiles.some((p) => p.id === next.id)
    const list = exists ? profiles.map((p) => (p.id === next.id ? next : p)) : [...profiles, next]
    await writeAgent({
      profiles: list,
      ...(exists ? {} : { activeProfileId: next.id })
    })
    if (key) await setProfileKey(next.id, key)
    // 写盘成功后才关弹窗：失败时留在原地，用户不必重填一遍
    setEditor(null)
  }

  /** 删除一档：至少留一档；顺手清掉该档密钥，避免凭据库里留孤儿 */
  const remove = async (p: ModelProfile): Promise<void> => {
    if (profiles.length <= 1) return
    if (!window.confirm(`删除模型「${p.label}」？该档已保存的 API Key 会一并删除。`)) return
    const list = profiles.filter((x) => x.id !== p.id)
    if (configuredProfileIds.includes(p.id)) await setProfileKey(p.id, '')
    await writeAgent({
      profiles: list,
      activeProfileId: agent.activeProfileId === p.id ? list[0]!.id : agent.activeProfileId
    })
  }

  /** 连通性测试：对指定档发一次最小真实请求（验端点 / 密钥 / 模型名三件事） */
  const runTest = async (p: ModelProfile): Promise<void> => {
    setTesting(p.id)
    setTested(null)
    try {
      const r = await window.api.settings.testProfile(p.id)
      setTested({ name: p.label, r })
    } catch (e) {
      setTested({
        name: p.label,
        r: { level: 'fail', detail: e instanceof Error ? e.message : String(e) }
      })
    } finally {
      setTesting(null)
    }
  }

  return (
    <>
      <section className="set-section">
        <div className="set-section-head">
          <span className="set-section-label">模型管理</span>
        </div>
        <div className="model-manage">
          <div className="model-manage-desc">
            配置 API Key 添加更多可用模型，预置模型默认使用稳定版本。
          </div>
          <div className="model-manage-actions">
            <button
              className="btn sm"
              onClick={() => setEditor({ profile: newProfileDraft(), isNew: true })}
              title="新增一个模型档案"
            >
              <IconPlus size={12} />
              添加模型
            </button>
          </div>

          {tested ? (
            <DismissibleBanner tone={TEST_TONE[tested.r.level]} onDismiss={() => setTested(null)}>
              <span>
                <b>{tested.name}</b>：{tested.r.detail}
                {tested.r.hint ? ` (${tested.r.hint})` : ''}
              </span>
              <button className="btn ghost icon sm" onClick={() => setTested(null)} title="收起该结论">
                ×
              </button>
            </DismissibleBanner>
          ) : null}

          <div className="model-table-wrap">
            <table className="model-table">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>服务商</th>
                  <th className="col-ops">操作</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id} className={p.enabled === false ? 'off' : ''}>
                    <td>
                      <button
                        type="button"
                        className="model-cell"
                        onClick={() => setEditor({ profile: p, isNew: false })}
                        title="点击编辑该模型"
                      >
                        <IconCpu size={14} className="model-cell-icon" />
                        <span className="model-cell-name">{p.label}</span>
                        {p.id === agent.activeProfileId ? (
                          <span className="chip agent">使用中</span>
                        ) : null}
                        {configuredProfileIds.includes(p.id) ? null : (
                          <span className="chip">未配密钥</span>
                        )}
                      </button>
                    </td>
                    <td className="model-cell-provider">
                      {ALL_PROVIDERS[p.provider]?.label ?? p.provider}
                    </td>
                    <td>
                      <span className="model-row-ops">
                        <button
                          className="icon-btn"
                          onClick={() => void runTest(p)}
                          disabled={testing === p.id}
                          title="连通性测试：发一次真实的最小请求，验证端点、密钥与模型名"
                        >
                          <IconActivity size={14} />
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => void remove(p)}
                          disabled={profiles.length <= 1}
                          title={profiles.length <= 1 ? '至少保留一个模型' : '删除该模型'}
                        >
                          <IconTrash size={14} />
                        </button>
                        <Switch
                          checked={p.enabled !== false}
                          onChange={(v) =>
                            void updateSettings({
                              agent: withProfileEnabled(useApp.getState().settings.agent, p.id, v)
                            })
                          }
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <Section label="运行参数">
        <Row
          title="运行时"
          desc="全局设置，不随模型切换；未配置密钥时会自动回退到 mock，不会因缺配置而报错。"
          control={
            <select
              value={runtime}
              onChange={(e) => {
                const next = e.target.value as 'react' | 'mock'
                setRuntime(next)
                void writeAgent({ runtime: next })
              }}
            >
              <option value="react">真实运行时（自研 ReAct 循环）</option>
              <option value="mock">mock 运行时（离线回放）</option>
            </select>
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
                void writeAgent({ systemPrompt: val })
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
          desc="只重试临时性失败（限流 429、超时、5xx、连接中断）；密钥无效、模型名不存在、额度耗尽这类确定性错误会立刻失败，重试它们只是让你多等几秒看到同一个错。"
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
          desc="整个对话的字符预算，超出即压缩老轮次。默认 80 万字符 ≈ 256k token，与默认模型窗口同量级；它和按窗口算的「触发水位」是双判据，谁先到谁触发。换了窗口明显更大的模型（512k / 1M）时，这个值也要跟着调大，否则压缩仍会提前触发，大窗口就白开了。"
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
        <Row
          title="用模型生成摘要"
          desc="把较早的几轮原文交给模型压成「结论摘要」再进上下文：设备名与 IP、掩码、VLAN、接口名、已下发的命令、验证结论、失败与未完成项都会原样保留，回显明细与中间推理则省略。多花一次模型请求。关掉则退回本地修剪：老工具输出会被换成「请重新调用该工具」，不再可恢复，但不多花请求。"
          control={
            <Switch
              checked={compactDraft.summarize}
              onChange={(v) => {
                const next = { ...compactDraft, summarize: v }
                setCompactDraft(next)
                void updateSettings({ compaction: next })
              }}
            />
          }
        />
        <Row
          title="触发水位（占模型窗口比例）"
          desc="真实用量达到窗口的这个比例就压缩，默认 0.75。用量数字来自服务商返回的 usage（已补上缓存命中部分），不是字符估算。留出的余量要给本轮输出与本轮工具回显，调到 0.9 以上基本等于等着溢出。"
          control={
            <input
              type="number"
              step={0.05}
              min={COMPACTION_BOUNDS.pressureRatio.min}
              max={COMPACTION_BOUNDS.pressureRatio.max}
              value={compactDraft.pressureRatio}
              disabled={!compactDraft.enabled}
              onChange={(e) => {
                const next = sanitizeCompaction(
                  { ...compactDraft, pressureRatio: e.target.value },
                  compactDraft
                )
                setCompactDraft(next)
                void updateSettings({ compaction: next })
              }}
            />
          }
        />
      </Section>

      <Section label="并发执行">
        <Row
          title="同时进行的调用上限"
          desc="批量巡检多台设备时，跨设备的只读命令可以同时下发，不用一台一台排队等回显。同设备仍然严格串行（VRP 一次只能跑一条命令），配置类写操作始终独占，且会把它前后的只读调用隔开，保证「改完再看」读到的是改后的状态。填 1 = 完全串行。"
          control={
            <input
              type="number"
              min={CONCURRENCY_BOUNDS.maxParallel.min}
              max={CONCURRENCY_BOUNDS.maxParallel.max}
              value={concurrencyDraft.maxParallel}
              onChange={(e) => {
                // 与其他数值设置同一口径：改的同时落盘（底栏写明「其余配置改动即时生效」）
                const next = sanitizeConcurrency(
                  { ...concurrencyDraft, maxParallel: e.target.value },
                  concurrencyDraft
                )
                setConcurrencyDraft(next)
                void updateSettings({ concurrency: next })
              }}
            />
          }
        />
      </Section>

      <Section label="重复调用防护">
        <Row
          title="重复调用提醒"
          desc="代理偶尔会卡在同一个动作上：用完全相同的参数反复调同一条命令，每次都得到同样的结果却继续重发，直到把轮次预算烧光。开启后，同一工具 + 同一参数连续出现第 3、5、8 次时，会在对话末尾追加一条系统提醒，让它换参数、换命令或直接给结论。只提醒、不改任何工具结果，也不改系统提示词（后者会让服务端缓存整段失效）。参数按「值」比较，键序不同视为同一次调用；你插一句话就重新计数。"
          control={
            <Switch
              checked={repeatGuardDraft.enabled}
              onChange={(v) => {
                const next = sanitizeRepeatGuard({ ...repeatGuardDraft, enabled: v }, repeatGuardDraft)
                setRepeatGuardDraft(next)
                void updateSettings({ repeatGuard: next })
              }}
            />
          }
        />
      </Section>

      <Section label="会话标题">
        <Row
          title="用模型给会话起名"
          desc="一轮任务成功收尾后，让模型用一两句话概括这次做了什么，作为会话标题（如「给 3 台接入交换机配 VLAN 10」），比「新建会话 1 / 2 / 3」好找。每轮只多花一次很小的模型请求（只在还没起过名时发）。首轮没起成（任务失败/被中止）时，之后成功收尾的轮次会自动补起。你手动改过的标题不会被覆盖。"
          control={
            <Switch
              checked={titleDraft.enabled}
              disabled={!canGenerateTitle(activeProfile(agent))}
              onChange={(v) => {
                const next = sanitizeTitleSettings({ ...titleDraft, enabled: v }, titleDraft)
                setTitleDraft(next)
                void updateSettings({ title: next })
              }}
            />
          }
        />
        <Row
          title="标题目标字数"
          desc="只是给模型的建议长度，不是硬截断；模型写超了会在 30 字硬上限处裁掉。默认 16 字，中文标题这个长度在侧栏列表里正好一行读完。"
          control={
            <input
              type="number"
              min={TITLE_BOUNDS.targetChars.min}
              max={TITLE_BOUNDS.targetChars.max}
              value={titleDraft.targetChars}
              disabled={!titleDraft.enabled}
              onChange={(e) => {
                const next = sanitizeTitleSettings(
                  { ...titleDraft, targetChars: e.target.value },
                  titleDraft
                )
                setTitleDraft(next)
                void updateSettings({ title: next })
              }}
            />
          }
        />
        <Row
          title="生成超时（毫秒）"
          desc="起名请求的等待上限，默认 15000。超时不会影响你的任务：请求被丢弃，标题退回「首条消息截断」的兜底值，任务照常收尾。"
          control={
            <input
              type="number"
              step={1000}
              min={TITLE_BOUNDS.timeoutMs.min}
              max={TITLE_BOUNDS.timeoutMs.max}
              value={titleDraft.timeoutMs}
              disabled={!titleDraft.enabled}
              onChange={(e) => {
                const next = sanitizeTitleSettings(
                  { ...titleDraft, timeoutMs: e.target.value },
                  titleDraft
                )
                setTitleDraft(next)
                void updateSettings({ title: next })
              }}
            />
          }
        />
      </Section>

      {editor ? (
        <ModelEditorDialog
          profile={editor.profile}
          isNew={editor.isNew}
          hasKey={configuredProfileIds.includes(editor.profile.id)}
          onClose={() => setEditor(null)}
          onSave={saveProfile}
        />
      ) : null}
    </>
  )
}