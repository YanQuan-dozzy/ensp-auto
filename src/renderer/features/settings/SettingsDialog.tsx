import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'

/**
 * 设置面板。分区与 UI-SPEC 的标签结构对齐，v0.1 只做模型与外观两区。
 *
 * 密钥处理：输入框永远是「只写」的 —— 存进去之后不再回显，
 * 界面只显示「已配置 / 未配置」。密钥本身存在主进程的系统凭据库里，
 * 从不由 IPC 回传渲染层。
 */
export function SettingsDialog({ onClose }: { onClose: () => void }): ReactNode {
  const settings = useApp((s) => s.settings)
  const hasApiKey = useApp((s) => s.hasApiKey)
  const mcpStatus = useApp((s) => s.mcpStatus)
  const updateSettings = useApp((s) => s.updateSettings)
  const setApiKey = useApp((s) => s.setApiKey)
  const setTheme = useApp((s) => s.setTheme)

  const [tab, setTab] = useState<'model' | 'integration' | 'appearance'>('model')
  const [provider, setProvider] = useState(settings.agent.provider)
  const [baseUrl, setBaseUrl] = useState(settings.agent.baseUrl)
  const [model, setModel] = useState(settings.agent.model)
  const [maxRounds, setMaxRounds] = useState(String(settings.agent.maxRounds))
  const [temperature, setTemperature] = useState(String(settings.agent.temperature))
  const [runtime, setRuntime] = useState(settings.agent.runtime)
  const [mcpEnabled, setMcpEnabled] = useState(settings.mcp.enabled)
  const [mcpPort, setMcpPort] = useState(String(settings.mcp.port))
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaved, setKeySaved] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (): Promise<void> => {
    await updateSettings({
      agent: {
        provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        maxRounds: Math.max(1, Math.min(50, Number.parseInt(maxRounds, 10) || 12)),
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2,
        runtime
      },
      mcp: {
        enabled: mcpEnabled,
        port: Math.max(1024, Math.min(65535, Number.parseInt(mcpPort, 10) || 49150))
      }
    })
    if (keyDraft.trim()) {
      await setApiKey(keyDraft.trim())
      setKeyDraft('')
      setKeySaved(true)
      setTimeout(() => setKeySaved(false), 2500)
    }
    onClose()
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="设置">
      <div className="dialog" style={{ maxWidth: 520 }}>
        <div className="dialog-bar" style={{ background: 'var(--accent)' }} />
        <div className="dialog-body">
          <div className="dialog-title">设置</div>

          <div className="tabstrip" style={{ marginBottom: 4 }}>
            <span
              className={`tab${tab === 'model' ? ' active' : ''}`}
              onClick={() => setTab('model')}
            >
              模型
            </span>
            <span
              className={`tab${tab === 'integration' ? ' active' : ''}`}
              onClick={() => setTab('integration')}
            >
              集成
            </span>
            <span
              className={`tab${tab === 'appearance' ? ' active' : ''}`}
              onClick={() => setTab('appearance')}
            >
              外观
            </span>
          </div>

          {tab === 'model' ? (
            <div className="settings-grid">
              <div className="field">
                <label>服务商（Provider）</label>
                <div className="field-row">
                  <select
                    value={provider}
                    onChange={(e) => setProvider(e.target.value as typeof provider)}
                  >
                    <option value="deepseek">DeepSeek（OpenAI 兼容）</option>
                    <option value="openai">OpenAI（官方 API）</option>
                    <option value="anthropic">Anthropic（Claude）</option>
                    <option value="google">Google（Gemini）</option>
                    <option value="custom">自定义 OpenAI 兼容端点</option>
                  </select>
                </div>
                <span className="hint">
                  DeepSeek 与自定义端点使用 OpenAI 兼容协议（baseUrl 可指向中转/代理）；
                  其余走各自官方原生 API，模型名须在官方目录中。
                </span>
              </div>

              <div className="field">
                <label>API 端点</label>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com"
                />
                <span className="hint">
                  仅 DeepSeek / 自定义端点使用。可填任何 OpenAI 兼容端点：Kimi / 通义 / 智谱 / Ollama / vLLM
                </span>
              </div>

              <div className="field">
                <label>模型名</label>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-chat"
                />
                <span className="hint">
                  DeepSeek / 自定义端点可任意填写；OpenAI / Anthropic / Google 需使用官方模型 ID
                </span>
              </div>

              <div className="field">
                <label>API Key {hasApiKey ? '（已配置）' : '（未配置）'}</label>
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={hasApiKey ? '留空则保持现有密钥' : '粘贴密钥'}
                  autoComplete="off"
                />
                <span className="hint">
                  密钥由操作系统凭据库加密保管，应用不回显、不入日志。
                  {keySaved ? ' 已保存。' : ''}
                </span>
              </div>

              <div className="field">
                <label>运行时</label>
                <div className="field-row">
                  <select
                    value={runtime}
                    onChange={(e) => setRuntime(e.target.value as 'react' | 'mock')}
                  >
                    <option value="react">真实运行时（自研 ReAct 循环）</option>
                    <option value="mock">mock 运行时（离线回放）</option>
                  </select>
                </div>
                <span className="hint">
                  未配置 Key 时会自动回退到 mock，不会因缺配置而报错。
                </span>
              </div>

              <div className="field">
                <label>最大轮次 / 温度</label>
                <div className="field-row">
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={maxRounds}
                    onChange={(e) => setMaxRounds(e.target.value)}
                  />
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    max={2}
                    value={temperature}
                    onChange={(e) => setTemperature(e.target.value)}
                    style={{ width: 88 }}
                  />
                </div>
                <span className="hint">轮次上限用于防止代理在失败路径上无限重试。</span>
              </div>
            </div>
          ) : tab === 'integration' ? (
            <div className="settings-grid">
              <div className="field">
                <label>MCP 对外服务</label>
                <div className="field-row">
                  <select value={mcpEnabled ? '1' : '0'} onChange={(e) => setMcpEnabled(e.target.value === '1')}>
                    <option value="0">关闭</option>
                    <option value="1">开启</option>
                  </select>
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={mcpPort}
                    onChange={(e) => setMcpPort(e.target.value)}
                    style={{ width: 96 }}
                    disabled={!mcpEnabled}
                  />
                </div>
                <span className="hint">
                  开启后在 127.0.0.1:{mcpPort} 提供 Streamable HTTP 服务，
                  供 Trae / Claude 等客户端按 URL 调用（工具与内置代理同一套 schema，danger 工具不外露）。
                </span>
                {mcpStatus.running ? (
                  <div className="banner info" style={{ marginTop: 6 }}>
                    运行中：{mcpStatus.url}
                  </div>
                ) : mcpStatus.error ? (
                  <div className="banner danger" style={{ marginTop: 6 }}>
                    启动失败：{mcpStatus.error}
                  </div>
                ) : null}
                <span className="hint">
                  配置保存后即时生效（开/关、改端口都会重启服务）。
                  HTTP 客户端限制本地回环，无鉴权，仅限本机使用。
                </span>
              </div>
            </div>
          ) : (
            <div className="settings-grid">
              <div className="field">
                <label>主题</label>
                <div className="field-row">
                  <button
                    className={`btn${settings.theme === 'dark' ? ' primary' : ''}`}
                    onClick={() => void setTheme('dark')}
                  >
                    深色
                  </button>
                  <button
                    className={`btn${settings.theme === 'light' ? ' primary' : ''}`}
                    onClick={() => void setTheme('light')}
                  >
                    浅色
                  </button>
                </div>
                <span className="hint">
                  切换会同步终端配色与滚动条；终端与拓扑不读 CSS 变量，需要显式同步。
                </span>
              </div>

              <div className="field">
                <label>设备回显编码</label>
                <div className="field-row">
                  <select
                    value={settings.deviceEncoding}
                    onChange={(e) =>
                      void updateSettings({
                        deviceEncoding: e.target.value as 'auto' | 'utf8' | 'gbk'
                      })
                    }
                  >
                    <option value="auto">自动（UTF-8 优先，失败回退 GBK）</option>
                    <option value="utf8">强制 UTF-8</option>
                    <option value="gbk">强制 GBK</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          <div className="dialog-actions">
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn primary" onClick={() => void save()}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
