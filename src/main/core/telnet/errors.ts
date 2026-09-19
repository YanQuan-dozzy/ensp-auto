import { CARET_MARKER_RE, ERROR_PATTERNS, WARNING_RE } from './patterns'

/**
 * 设备错误识别。
 *
 * 这是修掉源项目最致命缺陷的地方：源实现把设备报错当成功返回，
 * 代理因此会带着错误结果继续推理，越走越偏。
 *
 * 本模块把错误文本转成机器可判定的 code，让代理能立刻改道。
 */

export interface ErrorInfo {
  code: string
  /** 人类可读说明 */
  message: string
  /** 完整错误行原文 */
  line: string
  /** 命中模式的含义 */
  meaning: string
}

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1
  let end = text.indexOf('\n', index)
  if (end === -1) end = text.length
  return text.slice(start, end).trim()
}

export function detectError(text: string): ErrorInfo | null {
  if (!text) return null
  for (const p of ERROR_PATTERNS) {
    const m = p.re.exec(text)
    if (!m || m.index === undefined) continue
    return {
      code: p.code,
      message: `${p.meaning}（${m[0].trim()}）`,
      line: lineAt(text, m.index),
      meaning: p.meaning
    }
  }
  return null
}

export function hasWarning(text: string): boolean {
  return WARNING_RE.test(text)
}

/** 是否含错误定位标记行（单独一个 ^），与错误信息配合指认出错位置 */
export function hasCaretMarker(text: string): boolean {
  return CARET_MARKER_RE.test(text)
}
