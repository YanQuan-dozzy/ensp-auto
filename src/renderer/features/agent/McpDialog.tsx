import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import { newMcpServerId } from '@shared/profiles'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import { Row, Section } from '@/components/settings-kit'
import {
  Switch,
  Chip,
  Dot,
  IconClose,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUpload
} from '@/components/ui'
import { McpImportDialog } from './McpImportDialog'

/**
 * 连接 MCP（v1.5）。
 *
 * 这个弹窗管的是**出方向**：把用户别的 MCP 服务器挂进来，
 * 其工具以 `mcp__<服务器>__<工具>` 注入内置代理。
 * （入方向 —— 把本应用当作 MCP 服务提供给 Trae/Claude —— 在「设置 → 集成」里。）
 *
 * 版式与设置页共用同一套行式语言（settings-kit 的 Row / Section）：
 * 两个入口（AI 面板插头按钮、设置 → 集成「管理…」）打开的是同一个弹窗，
 * 因此它必须长得像设置页的一部分，而不是早期那种一列堆叠的表单。
 *
 * 安全口径在界面上明说：外部工具默认需要人工确认，勾了「信任」才免确认。
 * 用户看不懂后果的开关，等于没有开关。
 */
function blankDraft(): McpServerConfig {
  return {
    id: newMcpServerId(),
    name: '',
    transport: 'http',
    url: '',
    command: '',
    args: [],
    enabled: true,
    trusted: false
  }
}

function statusOf(list: McpServerStatus[], id: string): McpServerStatus | undefined {
  return list.find((s) => s.id === id)
}

export function McpDialog({ onClose }: { onClose: () => void }): ReactNode {
  const settings = useApp((s) => s.settings)
  const statuses = useApp((s) => s.mcpServers)
  const busy = useApp((s) => s.mcpBusy)
  const updateSettings = useApp((s) => s.updateSettings)
  const sync = useApp((s) => s.syncMcpServers)
  const test = useApp((s) => s.testMcpServer)

  const [draft, setDraft] = useState<McpServerConfig>(blankDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [argsText, setArgsText] = useState('')
  const [notice, setNotice] = useState('')
  /** 粘贴 JSON 导入（手动配置）子弹窗 */
  const [importOpen, setImportOpen] = useState(false)
  /** 上一次导入的说明（忽略了哪些字段、名字被收敛成什么），导入后常驻可查 */
  const [importNotes, setImportNotes] = useState<string[]>([])

  const servers = settings.mcp.servers
  /** 最新服务器列表快照：commit 类操作一律从 getState 读，避免连点时的 lost-update */
  const latestServers = (): McpServerConfig[] => useApp.getState().settings.mcp.servers

  // v1.8：onClose 是父组件内联箭头函数，每次 render 都是新引用 —— 用 ref 存最新回调，
  // 让 Esc 的监听 effect 不随每次渲染反复 remove/add
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    void useApp.getState().loadMcpServers()
    const onKey = (e: KeyboardEvent): void => {
      // 手动配置弹窗开着时 Esc 归它 —— 否则一次按键会连着关掉两层
      if (e.key === 'Escape' && !importOpen) onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [importOpen])

  /** 写服务器列表（主进程会按新列表重连，幂等） */
  const commit = async (next: McpServerConfig[], tip: string): Promise<void> => {
    await updateSettings({ mcp: { ...useApp.getState().settings.mcp, servers: next } })
    setNotice(tip)
    void sync()
  }

  const startEdit = (cfg: McpServerConfig): void => {
    setEditingId(cfg.id)
    setDraft({ ...cfg })
    setArgsText(cfg.args.join(' '))
    setNotice('')
  }

  const resetDraft = (): void => {
    setEditingId(null)
    setDraft(blankDraft())
    setArgsText('')
  }

  const saveDraft = async (): Promise<void> => {
    const cfg: McpServerConfig = {
      ...draft,
      name: draft.name.trim(),
      url: draft.url.trim(),
      command: draft.command.trim(),
      args: argsText.trim() ? argsText.trim().split(/\s+/) : []
    }
    if (!cfg.name) {
      setNotice('请填写服务器名称')
      return
    }
    if (cfg.transport === 'http' ? !cfg.url : !cfg.command) {
      setNotice(cfg.transport === 'http' ? 'HTTP 传输需要填写地址' : 'stdio 传输需要填写命令')
      return
    }
    const list = latestServers()
    const next = editingId ? list.map((s) => (s.id === editingId ? cfg : s)) : [...list, cfg]
    await commit(next, editingId ? '已保存修改' : '已添加服务器')
    resetDraft()
  }

  const remove = async (id: string): Promise<void> => {
    await commit(
      latestServers().filter((s) => s.id !== id),
      '已删除服务器（连接已断开）'
    )
    if (editingId === id) resetDraft()
  }

  const toggle = async (cfg: McpServerConfig, enabled: boolean): Promise<void> => {
    await commit(
      latestServers().map((s) => (s.id === cfg.id ? { ...s, enabled } : s)),
      enabled ? `已启用 ${cfg.name}` : `已停用 ${cfg.name}`
    )
  }

  /** 一键把本应用自己的对外 MCP 地址加进来（自测/串联时常用） */
  const addSelf = async (): Promise<void> => {
    if (!useApp.getState().settings.mcp.enabled) {
      setNotice('本应用的 MCP 对外服务未开启，先在「设置 → 集成」里打开')
      return
    }
    const cfg: McpServerConfig = {
      ...blankDraft(),
      name: 'ensp-auto（本机）',
      transport: 'http',
      url: `http://127.0.0.1:${useApp.getState().settings.mcp.port}/mcp`,
      enabled: true,
      trusted: true
    }
    await commit([...latestServers(), cfg], '已加入本机 MCP 服务')
  }

  /**
   * 从粘贴的 JSON 导入：解析层已经做过名字去重与连接去重，
   * 这里只负责接在现有列表后面落盘。
   */
  const importServers = async (
    imported: McpServerConfig[],
    warnings: string[]
  ): Promise<void> => {
    setImportOpen(false)
    setImportNotes(warnings)
    await commit([...latestServers(), ...imported], `已从 JSON 导入 ${imported.length} 台服务器`)
  }

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label="连接 MCP"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog" style={{ maxWidth: 680 }}>
        <div
          className="dialog-bar"
          style={{ background: 'linear-gradient(90deg, var(--agent), var(--accent))' }}
        />
        <div className="dialog-body">
          <div className="dialog-header">
            <div className="dialog-title">
              <IconPlug size={17} style={{ color: 'var(--agent)' }} />
              连接 MCP
            </div>
            <button className="btn ghost icon sm" onClick={onClose} title="关闭 (Esc)">
              <IconClose size={15} />
            </button>
          </div>

          {notice ? <div className="banner info">{notice}</div> : null}
          {importNotes.length > 0 ? (
            <details className="mcp-import-report">
              <summary>上次导入的说明（{importNotes.length} 条）</summary>
              <div className="mcp-import-notes">
                {importNotes.map((w, i) => (
                  <div key={`${i}-${w}`}>{w}</div>
                ))}
              </div>
            </details>
          ) : null}

          <div className="mcp-scroll">
            <Section
              label={`外部服务器（${servers.length}）`}
              action={
                <span className="set-section-actions">
                  <button
                    className="btn sm"
                    onClick={() => void addSelf()}
                    title="把本应用的对外 MCP 地址挂上来自测"
                  >
                    加入本机服务
                  </button>
                  <button
                    className="btn sm"
                    onClick={() => setImportOpen(true)}
                    title="粘贴 MCP 服务器介绍页里的 JSON，一次导入多台"
                  >
                    <IconUpload size={11} />
                    粘贴 JSON
                  </button>
                  <button className="btn sm" disabled={busy} onClick={() => void sync()}>
                    <IconRefresh size={11} />
                    全部重连
                  </button>
                </span>
              }
            >
              {servers.length === 0 ? (
                <Row
                  title="还没有外部服务器"
                  desc="在下方添加，或点「加入本机服务」把本应用自己的对外 MCP 地址挂上来自测。"
                />
              ) : (
                servers.map((cfg) => {
                  const st = statusOf(statuses, cfg.id)
                  const tone = !cfg.enabled
                    ? 'plain'
                    : st?.connected
                      ? 'success'
                      : st?.error
                        ? 'danger'
                        : 'warning'
                  const label = !cfg.enabled
                    ? '未启用'
                    : st?.connected
                      ? `已连接 · ${st.toolCount} 个工具`
                      : st?.error
                        ? '连接失败'
                        : '未连接'
                  return (
                    <div key={cfg.id} className="mcp-item">
                      <Row
                        title={
                          <>
                            <Dot
                              tone={cfg.enabled && st?.connected ? 'up' : st?.error ? 'err' : 'pending'}
                            />
                            {cfg.name}
                            <Chip tone={tone === 'plain' ? undefined : tone}>{label}</Chip>
                            {cfg.trusted ? (
                              <Chip tone="agent">已信任</Chip>
                            ) : (
                              <Chip tone="danger">需确认</Chip>
                            )}
                          </>
                        }
                        desc={
                          <span className="mono">
                            {cfg.transport === 'http'
                              ? cfg.url
                              : `${cfg.command} ${cfg.args.join(' ')}`}
                          </span>
                        }
                        control={
                          <>
                            <button className="btn sm" onClick={() => startEdit(cfg)}>
                              编辑
                            </button>
                            <button
                              className="btn sm"
                              disabled={busy}
                              onClick={() => void test(cfg.id)}
                              title="连接并列出工具（不影响其他连接）"
                            >
                              <IconRefresh size={11} />
                              测试
                            </button>
                            <button
                              className="btn sm"
                              onClick={() => void toggle(cfg, !cfg.enabled)}
                            >
                              {cfg.enabled ? '停用' : '启用'}
                            </button>
                            <button
                              className="btn sm danger"
                              onClick={() => void remove(cfg.id)}
                              title="删除该服务器"
                            >
                              <IconTrash size={11} />
                            </button>
                          </>
                        }
                      />
                      {st?.error ? <div className="banner danger">{st.error}</div> : null}
                      {st && st.connected && st.tools.length > 0 ? (
                        <div className="mcp-tools">
                          {st.tools.map((t) => (
                            <div key={t.name}>
                              <span className="mono">
                                mcp__{cfg.name}__{t.name}
                              </span>
                              {t.description ? ` — ${t.description}` : ''}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )
                })
              )}
            </Section>

            <Section label={editingId ? '编辑服务器' : '添加服务器'}>
              <Row
                title="名称"
                desc="用于拼工具命名空间（mcp__名称__工具），建议短英文。"
                control={
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="如 filesystem"
                  />
                }
              />
              <Row
                title="传输方式"
                desc="HTTP 适合本地或内网的 MCP 服务端点；stdio 适合以子进程方式拉起本地命令。"
                control={
                  <div className="seg">
                    <button
                      type="button"
                      className={`seg-item${draft.transport === 'http' ? ' active' : ''}`}
                      onClick={() => setDraft({ ...draft, transport: 'http' })}
                    >
                      HTTP
                    </button>
                    <button
                      type="button"
                      className={`seg-item${draft.transport === 'stdio' ? ' active' : ''}`}
                      onClick={() => setDraft({ ...draft, transport: 'stdio' })}
                    >
                      stdio
                    </button>
                  </div>
                }
              />
              {draft.transport === 'http' ? (
                <Row
                  title="服务地址"
                  stacked
                  control={
                    <div className="set-ctl-line">
                      <input
                        value={draft.url}
                        onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                        placeholder="http://127.0.0.1:3000/mcp"
                      />
                    </div>
                  }
                />
              ) : (
                <>
                  <Row
                    title="启动命令"
                    desc="按空格拆分参数；命令需在 PATH 中或写绝对路径。"
                    stacked
                    control={
                      <div className="set-ctl-line">
                        <input
                          value={draft.command}
                          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                          placeholder="可执行命令，如 npx"
                        />
                        <input
                          value={argsText}
                          onChange={(e) => setArgsText(e.target.value)}
                          placeholder="参数，空格分隔"
                        />
                      </div>
                    }
                  />
                </>
              )}
              <Row
                title="启用"
                desc="停用只是断开连接，配置仍留在列表里。"
                control={
                  <Switch
                    checked={draft.enabled}
                    onChange={(v) => setDraft({ ...draft, enabled: v })}
                  />
                }
              />
              <Row
                title="信任该服务器"
                desc="信任后它的工具不再逐次弹出人工确认（仍不进只读白名单，危险操作照旧受拦）。"
                control={
                  <Switch
                    checked={draft.trusted}
                    onChange={(v) => setDraft({ ...draft, trusted: v })}
                  />
                }
              />
            </Section>
          </div>

          <div className="dialog-actions">
            <span className="settings-foot-hint">
              外部工具默认按高危处理：每次调用都要你在确认框里点「执行」。
            </span>
            {editingId ? (
              <button className="btn" onClick={resetDraft}>
                取消编辑
              </button>
            ) : null}
            <button className="btn primary" onClick={() => void saveDraft()}>
              <IconPlus size={12} />
              {editingId ? '保存修改' : '添加'}
            </button>
          </div>
        </div>
      </div>

      {/* 手动配置（粘贴 JSON）—— 从服务器介绍页整段复制过来的那条路径 */}
      {importOpen ? (
        <McpImportDialog
          existing={servers}
          onCancel={() => setImportOpen(false)}
          onImported={(list, warnings) => void importServers(list, warnings)}
        />
      ) : null}
    </div>
  )
}
