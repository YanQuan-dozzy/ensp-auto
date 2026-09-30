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
 *
 * R1（PERF-MEM-REVIEW-2026-09-29 §三）：**流式期间不解析 markdown**。
 *
 * 机制：`text` 在流式期是**一条持续变长的字符串**，`memo` 的比较键就是它，
 * 于是永不命中；而 `react-markdown` + `remark-gfm`（完整 micromark 扩展）
 * 对同一篇文档做的是全量重新解析，累积成本 O(len²) ——
 * 一篇 2000 token 的最终回答 = 2000 次全量解析，50 token/s 即
 * **每秒 100~250ms 主线程解析时间**（输入框、滚动、终端全跟着卡）。
 *
 * 两态分流：`streaming` 时输出纯文本（保留换行），段落收束（并进 messages）
 * 后自动切成完整 markdown 渲染。纯文本阶段看不出 markdown 记号，
 * 但那正是「还在写」的阶段 —— 用户此时读的是内容，不是排版。
 *
 * ⚠️ 本组件是全仓**唯一**的 markdown 渲染点，改它等于改一处、全局生效。
 */
export const MarkdownView = memo(function MarkdownView({
  text,
  streaming = false
}: {
  text: string
  /** 该段是否仍在流式输出中（true 时不解析 markdown） */
  streaming?: boolean
}): ReactNode {
  return (
    <div className="md-body">
      {streaming ? (
        <div className="md-streaming">{text}</div>
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      )}
    </div>
  )
})
