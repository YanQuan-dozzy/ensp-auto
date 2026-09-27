import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { IconCheck, IconCopy } from '@/components/ui'

/**
 * 会话里的复制 / 粘贴（v2.1）。
 *
 * 复制一律走主进程剪贴板通道（`src/main/ipc/clipboard.ts`）：
 * 渲染层的 `navigator.clipboard.writeText` 要求文档处于焦点，Electron 各版本的
 * 授权策略也不一致，打包后还是 `file://` 页面 —— 而主进程那条路没有任何门槛。
 * 这里保留 `navigator.clipboard` 作为第二兜底（旧版 preload 尚未带通道时仍可用），
 * 两条都失败则返回 false，由按钮保持原样（不做「假装成功了」的反馈）。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    const r = await window.api.clipboard.writeText(text)
    if (r?.ok) return true
  } catch {
    // 落到渲染层兜底
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 读剪贴板纯文本；读不到（空/无权限）返回空串 */
export async function readClipboardText(): Promise<string> {
  try {
    const r = await window.api.clipboard.readText()
    return r?.text ?? ''
  } catch {
    return ''
  }
}

/**
 * 复制按钮。
 *
 * 反馈就地给（图标换成对勾 + 「已复制」），1.4s 后复位 —— 会话流里没有 toast，
 * 靠按钮自身变色是唯一「看得见」的确认；复位时间足够读完但不会一直亮着。
 */
export function CopyButton({
  text,
  getText,
  title = '复制',
  label,
  className = '',
  variant = 'reveal'
}: {
  /** 现成文本（消息体这类本来就拿在手里的字符串） */
  text?: string
  /**
   * 或点击时才生成文本。
   *
   * 为什么需要它：会话全文 / 工具回显这类内容要遍历整条消息流拼装，成本随长度增长，
   * 而流式输出时**每个 delta 都会重渲整条列表** —— 提前拼好等于每帧白算一遍。
   * 复制是低频动作，把它推迟到点击那一刻是纯赚。
   */
  getText?: () => string
  title?: string
  /** 传了就在图标右侧显示文字（默认纯图标） */
  label?: string
  className?: string
  /**
   * reveal：默认隐形，hover 所属行时才出现（消息流里不把版面切碎）
   * inline：常显的小胶囊按钮（工具卡 / 计划卡的头部）
   * button：与面板头部 `.btn sm ghost` 同一外观（顶部「复制全部会话」）
   */
  variant?: 'reveal' | 'inline' | 'button'
}): ReactNode {
  const [done, setDone] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    // 工具卡 / 计划卡的头部本身可点击（展开详情），复制不该顺带把卡片折叠了
    e.stopPropagation()
    void copyText(getText ? getText() : (text ?? '')).then((ok) => {
      if (!ok) return
      setDone(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setDone(false), 1400)
    })
  }

  const cls =
    variant === 'button'
      ? `btn sm ghost copy-btn-toolbar${done ? ' done' : ''}`
      : `copy-btn${done ? ' done' : ''}${variant === 'inline' ? ' always' : ''}`

  return (
    <button
      type="button"
      className={`${cls}${className ? ` ${className}` : ''}`}
      title={done ? '已复制到剪贴板' : title}
      // 传了 getText 就没有现成文本可判空（判了就等于提前拼装，白算）；交点击时兜底
      disabled={getText ? false : !text}
      onClick={onClick}
    >
      {done ? <IconCheck size={12} /> : <IconCopy size={12} />}
      {label ? <span className="copy-btn-label">{done ? '已复制' : label}</span> : null}
    </button>
  )
}
