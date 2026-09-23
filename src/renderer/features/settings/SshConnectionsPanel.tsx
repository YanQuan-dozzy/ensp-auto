import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '@/stores/app'
import type { SshAuthInput, SshCredentialMeta } from '@shared/api'
import { Row, Section } from '@/components/settings-kit'

/**
 * 设置 → SSH 连接 面板（v2.0）。
 *
 * 职责：管理多条已保存的 SSH 连接（自定义主机/端口/用户名/认证），并可手动逐个连接。
 * - 列表来自主进程加密凭据库（只回 meta，密码/私钥永不出主进程）；连接用 credentialId。
 * - 连接成功后设备的 `sshCredentialId` 会指向本条目，行内红绿灯据此展示「已连接/未连接」，
 *   并可直接在该行断开（连了多个设备时在这里统一目视与收口）。
 * - 认证载荷只在「保存」时提交一次；连接阶段主进程解密，渲染层不持有明文。
 */
export function SshConnectionsPanel(): ReactNode {
  const devices = useApp((s) => s.devices)
  const [creds, setCreds] = useState<SshCredentialMeta[]>([])
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 正在连接/断开的条目 id（按钮禁用 + 转圈提示） */
  const [busyId, setBusyId] = useState<string | null>(null)

  // 表单字段（只在点「添加」时重置）
  const [name, setName] = useState('')
  const [host, setHost] = useState('127.0.0.1')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [authType, setAuthType] = useState<'password' | 'privateKey'>('password')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')

  const load = (): void => {
    void window.api.device.ssh.list().then(setCreds).catch(() => setCreds([]))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const deviceOf = (credId: string): ReturnType<typeof devices.find> =>
    devices.find((d) => d.sshCredentialId === credId)

  const doConnect = async (cred: SshCredentialMeta): Promise<void> => {
    setBusyId(cred.id)
    setError(null)
    try {
      await useApp.getState().connectSsh({ credentialId: cred.id })
    } catch (e) {
      setError(`连接 ${cred.name} 失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const doDisconnect = async (cred: SshCredentialMeta): Promise<void> => {
    const d = deviceOf(cred.id)
    if (!d) return
    setBusyId(cred.id)
    try {
      await useApp.getState().disconnect(d.id)
    } finally {
      setBusyId(null)
    }
  }

  const doRemove = async (cred: SshCredentialMeta): Promise<void> => {
    const d = deviceOf(cred.id)
    if (d && d.connected) await useApp.getState().disconnect(d.id)
    await window.api.device.ssh.remove(cred.id)
    load()
  }

  const authPayload = (): SshAuthInput | null => {
    if (authType === 'password') {
      if (!password) return null
      return { type: 'password', password }
    }
    if (!privateKey.trim()) return null
    return { type: 'privateKey', key: privateKey, ...(passphrase ? { passphrase } : {}) }
  }

  const submit = async (): Promise<void> => {
    const p = Number.parseInt(port, 10)
    if (!host.trim() || p < 1 || p > 65535) {
      setError('主机地址或端口非法')
      return
    }
    if (!username.trim()) {
      setError('用户名不能为空')
      return
    }
    const auth = authPayload()
    if (!auth) {
      setError(authType === 'password' ? '密码不能为空' : '私钥不能为空')
      return
    }
    setError(null)
    try {
      await window.api.device.ssh.save({
        name: name.trim() || `${host.trim()}:${p}`,
        host: host.trim(),
        port: p,
        username: username.trim(),
        auth
      })
      // 清空表单并收拢
      setAdding(false)
      setName('')
      setHost('127.0.0.1')
      setPort('22')
      setUsername('')
      setPassword('')
      setPrivateKey('')
      setPassphrase('')
      setAuthType('password')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="settings-scroll-inner" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <Section
        label={`已保存的 SSH 连接（${creds.length}）`}
        action={
          <button className="btn sm" onClick={() => setAdding((v) => !v)}>
            {adding ? '收起' : '+ 添加连接'}
          </button>
        }
      >
        {creds.length === 0 ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: '4px 0' }}>
            还没有保存的连接。点右上角「添加连接」录入主机与认证，即可在此管理并手动连接多台设备。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {creds.map((c) => {
              const d = deviceOf(c.id)
              const connected = !!d && d.connected
              return (
                <div
                  key={c.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)'
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 99,
                      background: connected ? 'var(--success)' : 'var(--text-muted)',
                      flexShrink: 0
                    }}
                    title={connected ? '已连接' : '未连接'}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                      {c.name}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {c.username}@{c.host}:{c.port}
                    </div>
                  </div>
                  {connected ? (
                    <button
                      className="btn ghost sm"
                      onClick={() => void doDisconnect(c)}
                      disabled={busyId === c.id}
                    >
                      断开
                    </button>
                  ) : (
                    <button
                      className="btn primary sm"
                      onClick={() => void doConnect(c)}
                      disabled={busyId === c.id}
                    >
                      {busyId === c.id ? '连接中…' : '连接'}
                    </button>
                  )}
                  <button
                    className="btn ghost icon sm"
                    title="删除该连接"
                    onClick={() => void doRemove(c)}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      {adding ? (
        <Section label="添加 SSH 连接">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Row
              title="名称（可选）"
              desc="便于识别的名字，默认 主机:端口"
              control={
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：接入层交换机"
                />
              }
            />
            <Row
              title="主机与端口"
              desc="IPv4 或域名；eNSP 虚拟设备填 127.0.0.1 与对应端口"
              control={
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={host} onChange={(e) => setHost(e.target.value)} style={{ flex: 1 }} />
                  <input
                    value={port}
                    onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    style={{ width: 84 }}
                    aria-label="端口"
                  />
                </div>
              }
            />
            <Row
              title="用户名"
              control={
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin / huawei"
                />
              }
            />
            <Row
              title="认证方式"
              stacked
              control={
                <div style={{ display: 'flex', gap: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      checked={authType === 'password'}
                      onChange={() => setAuthType('password')}
                    />
                    密码
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      checked={authType === 'privateKey'}
                      onChange={() => setAuthType('privateKey')}
                    />
                    私钥
                  </label>
                </div>
              }
            />
            {authType === 'password' ? (
              <Row
                title="密码"
                control={
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void submit()}
                  />
                }
              />
            ) : (
              <>
                <Row
                  title="私钥（OpenSSH / PEM 文本）"
                  control={
                    <textarea
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                      rows={3}
                      spellCheck={false}
                      style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 11, resize: 'vertical' }}
                    />
                  }
                />
                <Row
                  title="口令（passphrase，私钥加密时）"
                  control={
                    <input
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                    />
                  }
                />
              </>
            )}
            {error ? (
              <div className="banner danger" style={{ marginTop: 4 }}>
                {error}
              </div>
            ) : null}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn primary sm" onClick={() => void submit()}>
                保存连接
              </button>
            </div>
          </div>
        </Section>
      ) : null}
    </div>
  )
}