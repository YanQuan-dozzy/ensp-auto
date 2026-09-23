/**
 * 模型档案 → 凭据 分区（T5.8 从 ProfileSettings.tsx 外提）。
 *
 * 密钥输入永远是「只写」的：存进去之后不再回显，界面只显示「已配置 / 未配置」。
 * 密钥本身存在主进程的系统凭据库里，由操作系统凭据库加密，从不由 IPC 回传渲染层。
 */
import { useState } from 'react'
import { Row, Section } from '@/components/settings-kit'

export function ApiKeyRow(props: {
  currentKeyed: boolean
  onSaveKey: (key: string) => Promise<void>
  onClearKey: () => void
}): React.ReactNode {
  const { currentKeyed, onSaveKey, onClearKey } = props
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaved, setKeySaved] = useState(false)

  const saveKey = async (): Promise<void> => {
    if (!keyDraft.trim()) return
    await onSaveKey(keyDraft.trim())
    setKeyDraft('')
    setKeySaved(true)
    setTimeout(() => setKeySaved(false), 2500)
  }

  return (
    <Section label="凭据">
      <Row
        title={`API Key（${currentKeyed ? '已配置' : '未配置'}）`}
        desc={`密钥按档案分档保管，由操作系统凭据库加密，应用不回显、不入日志。「清除」只删这一档，之后该档自动回退到 mock 运行时。${keySaved ? ' 已保存。' : ''}`}
        stacked
        control={
          <div className="set-ctl-line">
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={currentKeyed ? '留空则保持该档现有密钥' : '粘贴密钥'}
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && keyDraft.trim()) {
                  void saveKey()
                }
              }}
            />
            {keyDraft.trim() ? (
              <button
                className="btn sm primary"
                onClick={() => void saveKey()}
                title="立即保存该密钥到系统凭据库"
              >
                保存密钥
              </button>
            ) : null}
            {currentKeyed ? (
              <button
                className="btn sm"
                onClick={onClearKey}
                title="从系统凭据库删除这一档的密钥"
              >
                清除
              </button>
            ) : null}
          </div>
        }
      />
    </Section>
  )
}