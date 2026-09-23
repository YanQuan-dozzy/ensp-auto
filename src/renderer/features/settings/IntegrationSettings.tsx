/**
 * 设置 → 集成 分区（T5.8 从 SettingsDialog.tsx 外提）。
 *
 * MCP 对外服务开关/端口与 eNSP 路径都是「主进程可能直改」的设置（如 Wireshark 挂载），
 * 所以保留 D9 的 settings 广播跟随 effect；「管理…」按钮打开的是对话框级 MCP 管理弹窗，
 * 由父组件握状态，这里通过 onManage 回调触发。
 */
import { useEffect, useState } from 'react'
import { useApp } from '@/stores/app'
import { ENSP_SOURCE_LABEL, type EnspLocatePayload } from '@shared/types'
import { Switch } from '@/components/ui'
import { Row, Section } from '@/components/settings-kit'

export function IntegrationSettings({ onManage }: { onManage: () => void }) {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const mcpStatus = useApp((s) => s.mcpStatus)

  const [mcpEnabled, setMcpEnabled] = useState(settings.mcp.enabled)
  const [mcpPort, setMcpPort] = useState(String(settings.mcp.port))
  const [mcpExpose, setMcpExpose] = useState(settings.mcp.exposeToAgent)
  const [enspPath, setEnspPath] = useState(settings.ensp.exePath)

  // D9：跟随主进程广播的 settings —— 旧实现只在挂载时取一次 settings 快照，
  // 主进程直改的 mcp 开关（如挂载 Wireshark 会把 exposeToAgent 置 true）在界面上
  // 不可见、改了之后还会被这里的旧闭包写回抹掉。广播到达后把开关态同步回来。
  useEffect(() => {
    setMcpEnabled(settings.mcp.enabled)
    setMcpExpose(settings.mcp.exposeToAgent)
    setMcpPort(String(settings.mcp.port))
    // 只依赖这两把主进程可能直改的开关；端口输入框允许用户编辑，不放进依赖
  }, [settings.mcp.enabled, settings.mcp.exposeToAgent])

  // eNSP 自动检测结果（只在本次打开面板期间有效；落盘的是输入框里的值）
  const [locate, setLocate] = useState<EnspLocatePayload | null>(null)
  const [locating, setLocating] = useState(false)

  /** 自动检测是只读探测：找到就把路径填进输入框并即时保存 */
  const doLocate = async (): Promise<void> => {
    setLocating(true)
    try {
      const r = await window.api.ensp.locate()
      setLocate(r)
      if (r.found) {
        setEnspPath(r.found)
        void updateSettings({ ensp: { exePath: r.found } })
      }
    } finally {
      setLocating(false)
    }
  }

  const doPick = async (): Promise<void> => {
    const picked = await window.api.ensp.pickExe()
    if (!picked?.exePath) return
    setEnspPath(picked.exePath)
    setLocate(null)
    void updateSettings({ ensp: { exePath: picked.exePath } })
  }

  return (
                      <>
                        <Section label="MCP 对外服务">
                          <Row
                            title="启用服务"
                            desc={`开启后在 127.0.0.1:${mcpPort} 提供 Streamable HTTP 服务，供 Trae / Claude 等客户端按 URL 调用（工具与内置代理同一套 schema，danger 工具不外露）。`}
                            control={
                              <Switch
                                checked={mcpEnabled}
                                onChange={(v) => {
                                  setMcpEnabled(v)
                                  // D9：读实时值而非 render 期闭包 —— 主进程可能刚改过 mcp
                                  //（如挂载 Wireshark），旧闭包会把刚写入的 servers 抹掉
                                  const cur = useApp.getState().settings.mcp
                                  void updateSettings({ mcp: { ...cur, enabled: v } })
                                }}
                              />
                            }
                          />
                          <Row
                            title="服务端口"
                            desc="HTTP 客户端限制本地回环，无鉴权，仅限本机使用。"
                            control={
                              <input
                                type="number"
                                min={1024}
                                max={65535}
                                value={mcpPort}
                                onChange={(e) => {
                                  setMcpPort(e.target.value)
                                  const p = Number.parseInt(e.target.value, 10)
                                  if (Number.isFinite(p) && p >= 1024 && p <= 65535) {
                                    const cur = useApp.getState().settings.mcp
                                    void updateSettings({ mcp: { ...cur, port: p } })
                                  }
                                }}
                                disabled={!mcpEnabled}
                              />
                            }
                          />
                          {mcpStatus.running || mcpStatus.error ? (
                            <Row
                              title="服务状态"
                              control={
                                mcpStatus.running ? (
                                  <span className="chip success mono">{mcpStatus.url}</span>
                                ) : (
                                  <span className="chip danger">启动失败：{mcpStatus.error}</span>
                                )
                              }
                            />
                          ) : null}
                        </Section>
      
                        <Section
                          label="外部 MCP 服务器"
                          action={
                            <button className="btn sm" onClick={onManage}>
                              管理…
                            </button>
                          }
                        >
                          <Row
                            title="本应用作为 MCP 客户端"
                            desc="上方的「MCP 对外服务」是别人连我们；反过来把外部 MCP 服务器挂进来（文件系统 / 内部平台等），其工具会以 mcp__服务器__工具 注入 AI 代理。点右上角「管理…」增删、测试与逐台授权；AI 面板输入框旁的插头按钮是同一个入口。"
                            control={
                              <span className="chip mono">
                                {settings.mcp.servers.length} 台 ·{' '}
                                {mcpExpose ? '已注入代理' : '未注入'}
                              </span>
                            }
                          />
                          <Row
                            title="注入外部工具"
                            desc="关闭后仅保留连通性与工具浏览，不把外部工具交给代理。"
                            control={
                              <Switch
                                checked={mcpExpose}
                                onChange={(v) => {
                                  setMcpExpose(v)
                                  const cur = useApp.getState().settings.mcp
                                  void updateSettings({ mcp: { ...cur, exposeToAgent: v } })
                                }}
                              />
                            }
                          />
                        </Section>
      
                        <Section label="eNSP 客户端">
                          <Row
                            title="eNSP_Client.exe 路径"
                            desc="用于把 AI 生成或修改后的拓扑交给 eNSP 打开。留空时按「环境变量 ENSP_EXE_PATH → .topo 文件关联 → 常见安装路径」顺序自动探测；eNSP 装在非默认位置时请在此指定。"
                            stacked
                            control={
                              <>
                                <div className="set-ctl-line">
                                  <input
                                    value={enspPath}
                                    onChange={(e) => {
                                      const val = e.target.value
                                      setEnspPath(val)
                                      void updateSettings({ ensp: { exePath: val } })
                                    }}
                                    placeholder="留空则自动探测"
                                    title="eNSP_Client.exe 的完整路径"
                                  />
                                  <button
                                    className="btn sm"
                                    onClick={() => void doLocate()}
                                    disabled={locating}
                                  >
                                    {locating ? '检测中…' : '自动检测'}
                                  </button>
                                  <button className="btn sm" onClick={() => void doPick()}>
                                    浏览…
                                  </button>
                                </div>
                                {locate ? (
                                  locate.found ? (
                                    <div className="banner success">
                                      检测到：{locate.found}（来源：{ENSP_SOURCE_LABEL[locate.source]}）
                                    </div>
                                  ) : (
                                    <div className="banner danger">
                                      未找到 eNSP_Client.exe（已探测 {locate.candidates.length}{' '}
                                      个候选路径），请用「浏览…」指定
                                    </div>
                                  )
                                ) : null}
                                {locate && locate.candidates.length > 0 ? (
                                  <details className="cand-details">
                                    <summary>查看探测过的 {locate.candidates.length} 个位置</summary>
                                    <ul>
                                      {locate.candidates.map((c) => (
                                        <li key={c.path} className={c.exists ? 'hit' : ''}>
                                          <span className="mono">{c.path}</span>
                                          <span className="src">{ENSP_SOURCE_LABEL[c.source]}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </details>
                                ) : null}
                              </>
                            }
                          />
                        </Section>
                      </>
  )
}