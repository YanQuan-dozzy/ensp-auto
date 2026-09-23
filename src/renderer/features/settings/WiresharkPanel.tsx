import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { EVENT } from '@shared/channels'
import type {
  WiresharkAvailabilityPayload,
  WiresharkInstallProgressPayload
} from '@shared/api'
import { Row, Section } from '@/components/settings-kit'
import { Chip, IconAlertTriangle, IconCheck, IconRefresh } from '@/components/ui'
import { useApp } from '@/stores/app'

/**
 * Wireshark 抓包分析接入面板（v1.9）。
 *
 * 三态界面，刻意按「用户现在卡在哪一步」来组织，而不是把四个按钮一次全摆出来：
 *   ① 没探测到 Wireshark → 只给「安装 Wireshark」的指引 + 手动指定目录
 *   ② 探测到了但组件没装 → 只给「安装分析组件」（联网一次）
 *   ③ 都就绪 → 给「启用/停用」与档位选择，并显示代理可用工具数
 *
 * 为什么不让用户自己去配 MCP：抓包分析对 eNSP 排障是刚需，但它有 6 个环境变量要填、
 * 还要建 venv —— 让每个用户手抄一遍既不合理也必然抄错。这里把「探测 → 装配 → 挂载」
 * 全自动做掉，用户只需要点一次。
 */

const TOOL_LABEL: Record<string, string> = {
  tshark: 'tshark',
  capinfos: 'capinfos',
  mergecap: 'mergecap',
  editcap: 'editcap',
  dumpcap: 'dumpcap',
  text2pcap: 'text2pcap'
}

/** 工具呈现顺序：核心引擎在首行，辅助处理工具在次行，3×2 严整对称 */
const TOOL_ORDER: string[] = ['tshark', 'dumpcap', 'capinfos', 'mergecap', 'editcap', 'text2pcap']

const REQUIREMENT_LABEL: Record<string, string> = {
  required: '硬需求',
  recommended: '推荐',
  optional: '可选'
}

const STAGE_LABEL: Record<WiresharkInstallProgressPayload['stage'], string> = {
  'detect-python': '查找 Python',
  'create-venv': '准备运行环境',
  'install-package': '下载分析组件',
  verify: '校验',
  done: '完成'
}

export function WiresharkPanel(): ReactNode {
  const cachedProbe = useApp((s) => s.settings.wireshark?.cachedProbe)
  const mcpServers = useApp((s) => s.settings.mcp?.servers)

  const [state, setState] = useState<WiresharkAvailabilityPayload | null>(() => cachedProbe ?? null)
  const [busy, setBusy] = useState<'probe' | 'install' | 'attach' | null>(() =>
    cachedProbe ? null : 'probe'
  )
  const [progress, setProgress] = useState<WiresharkInstallProgressPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState<'analysis' | 'full'>('analysis')

  // 若 store 里的持久化缓存有更新（如初次写入或更换目录），同步给 state
  useEffect(() => {
    if (cachedProbe) {
      setState((prev) => prev ?? cachedProbe)
    }
  }, [cachedProbe])

  const refresh = useCallback(async (force = false): Promise<void> => {
    setBusy('probe')
    try {
      const r = await window.api.wireshark.probe({ force })
      setState(r)
      setError(null)
    } catch (e) {
      // R26：探测失败过去没有 catch —— busy 归零、state 仍为 null，
      // 界面永远停在「检测中…」，用户看到的是一块不会动的转圈。
      setError(`探测 Wireshark 环境失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }, [])

  // 只有在无持久化结果时，才在挂载时自动跑探测；已有探测内容时切 Tab 直接复用，不重复探测
  useEffect(() => {
    if (!state) {
      void refresh(false)
    }
  }, [state, refresh])

  // 安装进度是主进程推的：下载可能持续一两分钟，没有进度条用户会以为卡死
  useEffect(() => {
    return window.api.on<WiresharkInstallProgressPayload>(EVENT.wiresharkInstallProgress, (p) => {
      setProgress(p)
    })
  }, [])

  const doInstall = useCallback(async (): Promise<void> => {
    setBusy('install')
    setError(null)
    setProgress(null)
    try {
      const r = await window.api.wireshark.install()
      if (!r.ok) setError(r.error ?? '安装失败')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
      await refresh(true)
    }
  }, [refresh])

  const doAttach = useCallback(
    async (on: boolean): Promise<void> => {
      if (!on) {
        // 停用 = 真卸载（主进程把 m-wireshark 条目停用并 sync），配置保留备用。
        // 旧实现这里调的是 attach ——「停用」按钮实际上又挂了一次（R26）。
        setBusy('attach')
        setError(null)
        try {
          const r = await window.api.wireshark.detach()
          if (!r.ok) setError(r.error ?? '卸载失败')
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(null)
          await refresh(true)
        }
        return
      }
      setBusy('attach')
      setError(null)
      try {
        const r = await window.api.wireshark.attach({ profile })
        if (!r.ok) setError(r.error ?? '挂载失败')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
        await refresh(true)
      }
    },
    [profile, refresh]
  )

  const pickDir = useCallback(async (): Promise<void> => {
    const dir = await window.api.wireshark.pickDir()
    if (dir) await refresh(true)
    else if (!state?.probe.canAnalyze) setError('所选目录中没有找到 tshark.exe，请选择 Wireshark 的安装目录')
  }, [refresh, state])

  const probe = state?.probe
  // 以主进程的探测结果为准：它是「条目是否 enabled」的实时视图；
  // settings.mcp.servers 是持久化快照，detach 后 sync 完成前会短暂不一致（R26）。
  const attached = useMemo(() => {
    if (state && typeof state.attached === 'boolean') return state.attached
    if (mcpServers) return mcpServers.some((s) => s.id === 'm-wireshark' && s.enabled !== false)
    return false
  }, [mcpServers, state])

  return (
    <>
      {error ? (
        <Section label="问题">
          <div className="set-note err">
            <IconAlertTriangle size={15} />
            <span>{error}</span>
          </div>
        </Section>
      ) : null}

      <Section
        label="Wireshark 抓包分析"
        action={
          <button
            className="btn sm"
            onClick={() => void refresh(true)}
            disabled={busy !== null}
            title="重新探测本机环境"
          >
            <IconRefresh size={14} />
            {busy === 'probe' ? '检测中' : '重新检测'}
          </button>
        }
      >
        <Row
          title="状态"
          desc="让代理能读懂 .pcap：协议分层、会话矩阵、DNS/HTTP 内容提取与异常检测。分析引擎是 Wireshark 官方的 tshark，本应用不自带解析器。"
          control={
            !state ? (
              <Chip>检测中…</Chip>
            ) : state.usable ? (
              <Chip tone="success">
                <IconCheck size={13} /> 可用
                {probe?.version ? ` · tshark ${probe.version}` : ''}
              </Chip>
            ) : (
              <Chip tone="warning">
                <IconAlertTriangle size={13} /> {state.reason ?? '不可用'}
              </Chip>
            )
          }
        />

        <Row
          title="Wireshark 安装位置"
          desc={
            probe?.suiteDir
              ? `已找到：${probe.suiteDir}`
              : '未找到。请先安装 Wireshark（安装时勾选 TShark 与 Npcap），或手动指定安装目录。'
          }
          control={
            <>
              <button className="btn sm" onClick={() => void pickDir()} disabled={busy !== null}>
                选择目录
              </button>
              {probe?.suiteDir ? (
                <button
                  className="btn sm ghost"
                  onClick={() => void refresh(true)}
                  disabled={busy !== null}
                >
                  重新探测
                </button>
              ) : null}
            </>
          }
        />

        {probe ? (
          <Row
            title="工具链"
            desc="tshark 是硬需求；实时抓包还需要 dumpcap。缺失项只会让少数工具不可用，不影响离线分析。"
            wide
            control={
              <div className="ws-tool-grid">
                {[...probe.tools]
                  .sort((a, b) => {
                    const ia = TOOL_ORDER.indexOf(a.tool)
                    const ib = TOOL_ORDER.indexOf(b.tool)
                    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
                  })
                  .map((t) => (
                    <span
                      key={t.tool}
                      className={`ws-tool${t.path ? ' ok' : ' miss'}`}
                      title={`${t.tool}（${REQUIREMENT_LABEL[t.requirement] ?? '可选'}）· ${t.purpose}\n${t.path ? `已就绪：${t.path}` : '未找到'}`}
                    >
                      <span className="ws-tool-dot" />
                      <span className="ws-tool-name">{TOOL_LABEL[t.tool] ?? t.tool}</span>
                    </span>
                  ))}
              </div>
            }
          />
        ) : null}
      </Section>

      {/* 第 ② 步：组件未装 —— 只给安装入口，别让用户先看到挂载开关 */}
      {state && probe?.canAnalyze && !state.installed ? (
        <Section label="分析组件">
          <Row
            title="安装分析组件"
            desc="Wireshark 的官方命令行工具只负责解析报文，还需要一层 MCP 适配器代理才能调用它。该组件将安装到本应用的独立目录中，不影响系统 Python 环境。需要联网下载一次（约 1 MB 本体 + 依赖）。"
            control={
              <button className="btn primary sm" onClick={() => void doInstall()} disabled={busy !== null}>
                {busy === 'install' ? '安装中…' : '安装'}
              </button>
            }
          />
          {progress ? (
            <Row
              title={STAGE_LABEL[progress.stage]}
              desc={progress.message}
              control={
                <div className="ws-progress" aria-label="安装进度">
                  <div
                    className="ws-progress-bar"
                    style={{ width: `${progress.percent ?? 100}%` }}
                  />
                </div>
              }
            />
          ) : null}
        </Section>
      ) : null}

      {/* 第 ③ 步：都就绪 —— 给启用与档位 */}
      {state?.usable ? (
        <Section label="接入代理">
          <Row
            title="挂载为 MCP 工具"
            desc="挂载后代理会获得一批 mcp__wireshark__* 工具，可自主打开并分析抓包文件，结论能落到具体包号与会话。"
            control={
              <>
                <button
                  className="btn sm"
                  onClick={() => void doAttach(!attached)}
                  disabled={busy !== null}
                >
                  {busy === 'attach' ? '处理中…' : attached ? '重新挂载' : '挂载'}
                </button>
                <Chip tone={attached ? 'success' : undefined}>{attached ? '已挂载' : '未挂载'}</Chip>
              </>
            }
          />
          <Row
            title="能力档位"
            desc="分析档：40 个只读分析工具，够用且上下文开销小，覆盖 eNSP 绝大多数排障场景。完整档：52 个，额外含实时抓网卡与写文件，需要管理员权限与 Npcap。"
            control={
              <div className="seg">
                <button
                  type="button"
                  className={`seg-item${profile === 'analysis' ? ' active' : ''}`}
                  onClick={() => setProfile('analysis')}
                >
                  分析
                </button>
                <button
                  type="button"
                  className={`seg-item${profile === 'full' ? ' active' : ''}`}
                  onClick={() => setProfile('full')}
                >
                  完整
                </button>
              </div>
            }
          />
          <Row
            title="审批口径"
            desc="由「权限与审批」决定：外部工具默认每次都要人工确认。若你信任它、想让它自主跑完整套分析流程，可在那里对 wireshark 这台服务器勾选信任。"
            control={<Chip>走人工闸门</Chip>}
          />
        </Section>
      ) : null}
    </>
  )
}
