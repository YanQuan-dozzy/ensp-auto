import { memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 消息正文的 Markdown 渲染（v2.2）。
 *
 * 此前助手正文是 `<div>{text}</div>` 原样输出 —— 模型输出里的 `**`、`#`、`-` 等
 * 标记符号会原样露在界面上（「不应该显示这些 md 符号」）。
 * 这里用 react-markdown + remark-gfm 渲染，样式收敛在 .md-body 类下（见 app.css），
 * 不影响项目其他卡片。
 */
export const MarkdownView = memo(function MarkdownView({ text }: { text: string }): ReactNode {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
})
