import { safeFileName } from './naming'
/**
 * 附件（v1.5）的纯逻辑：分类、预览截断、提示词块拼装。
 *
 * 为什么附件要「落盘 + 给路径」而不是把内容塞进消息里：
 * - 一条 display current-configuration 的回显动辄几千行，整段内联会直接把上下文撑爆；
 * - 代理需要**按需**再读（read_attachment 支持 offset/limit 翻页），
 *   这和网络实验里「先看摘要、再定位细节」的工作方式是同构的。
 * 因此消息里只带「清单 + 文本类前若干字符」，完整内容留在磁盘上等代理来取。
 */

export type AttachmentKind = 'text' | 'image' | 'binary'

export interface Attachment {
  /** 形如 a-xxxxxxxx */
  id: string
  /** 用户原始文件名（仅用于展示，不参与路径拼接） */
  name: string
  /** 归档后的绝对路径（已复制进 userData/attachments/<session>/） */
  path: string
  size: number
  kind: AttachmentKind
  /** 小写扩展名，不含点；无扩展名为空串 */
  ext: string
  addedAt: number
  /** 文本类附件的正文预览（已截断）；非文本类为空 */
  preview?: string
  /** 预览是否被截断（被截断的完整内容要用 read_attachment 取） */
  truncated?: boolean
  /** 预览文本的判定编码 */
  encoding?: 'utf8' | 'gbk'
}

export const TEXT_EXTS: ReadonlySet<string> = new Set([
  'txt', 'md', 'markdown', 'log', 'cfg', 'conf', 'config', 'ini', 'json', 'yaml', 'yml',
  'csv', 'tsv', 'xml', 'topo', 'html', 'htm', 'svg', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'py', 'sh', 'ps1', 'bat', 'cmd', 'sql', 'env', 'toml', 'properties', 'rst', 'text'
])

export const IMAGE_EXTS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'avif'
])

/** 单文件上限：超过就直接拒绝并说明原因，不静默截断（截断的配置可能把代理带偏） */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** 单条消息的附件数上限 */
export const MAX_ATTACHMENTS = 20
/** 单个文本附件内联进提示词的最大字符数 */
export const MAX_INLINE_CHARS = 4000
/** 所有文本附件内联合计上限 */
export const MAX_TOTAL_INLINE_CHARS = 16000
/** 生成预览时最多读取的字节数（避免读一个 100MB 的日志把主进程卡住） */
export const PREVIEW_READ_BYTES = 64 * 1024

/**
 * 取小写扩展名（不含点）。
 *
 * 点开头文件（.env / .gitignore）刻意算作「扩展名为 env / gitignore」：
 * 它们内容就是文本，若返回空串会被判成二进制、连预览都不给，属于明显误伤。
 * 纯点组成的名字（"." / ".."）仍返回空串。
 */
export function extOf(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? ''
  if (/^\.+$/.test(base)) return ''
  const i = base.lastIndexOf('.')
  if (i === base.length - 1) return ''
  if (i < 0) return ''
  return base.slice(i + 1).toLowerCase()
}

export function classifyAttachment(fileName: string): AttachmentKind {
  const ext = extOf(fileName)
  if (TEXT_EXTS.has(ext)) return 'text'
  if (IMAGE_EXTS.has(ext)) return 'image'
  return 'binary'
}

export function kindLabel(kind: AttachmentKind): string {
  return kind === 'text' ? '文本' : kind === 'image' ? '图片' : '二进制'
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 截断预览。刻意在字符数上截断而不是字节数上：反正最终以 UTF-16 长度进模型，
 * 按字符截断才能给出确定的 token 上限。
 */
export function truncatePreview(text: string, limit = MAX_INLINE_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

/**
 * 文件名安全化：先剥掉路径（只留基名），再走统一的 safeFileName（T5.3）。
 * 这样附件归档名与导出目录名不会各有一套规则。
 */
export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  return safeFileName(base, { fallback: 'file', maxLen: 120 })
}

/** 归档文件名：id 前缀保证并发导入同名文件时互不覆盖 */
export function archivedFileName(id: string, name: string): string {
  return `${id}-${sanitizeFileName(name)}`
}

/**
 * 写进会话树 user 节点尾巴的附件清单（一行一条）。
 * 目的是让历史回放与导出的报告里也能看出「这条指令带了什么文件」。
 */
export function attachmentNoteLine(attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return ''
  const lines = attachments.map((a) => `📎 ${a.name}（${formatBytes(a.size)} · ${kindLabel(a.kind)}）`)
  return lines.join('\n')
}

/**
 * 拼「本次附加文件」提示词块。
 *
 * 非文本附件也会列出路径：模型虽然读不到图片像素，但可以据此判断
 * 「用户给的是截图」并主动询问，比装作没看见要好。
 */
export function buildAttachmentBlock(
  attachments: readonly Attachment[],
  opts?: { perFileChars?: number; totalChars?: number }
): string {
  if (attachments.length === 0) return ''
  const perFile = Math.max(200, opts?.perFileChars ?? MAX_INLINE_CHARS)
  const total = Math.max(perFile, opts?.totalChars ?? MAX_TOTAL_INLINE_CHARS)

  let budget = total
  const parts: string[] = []

  attachments.forEach((a, i) => {
    const head = `${i + 1}. ${a.name}（${kindLabel(a.kind)}，${formatBytes(a.size)}）\n   路径：${a.path}`
    if (a.kind !== 'text' || !a.preview) {
      const tail =
        a.kind === 'image'
          ? '   注意：这是图片，你无法直接读取像素内容。若任务依赖图片里的信息，请先向用户确认关键内容。'
          : '   注意：这是二进制文件，无法内联。如需解析请说明你希望从中得到什么。'
      parts.push(`${head}\n${tail}`)
      return
    }
    const take = Math.min(perFile, Math.max(0, budget))
    const { text, truncated } = truncatePreview(a.preview, take)
    budget -= text.length
    const note = truncated || a.truncated
      ? `\n   （以上为前 ${text.length} 个字符${a.encoding ? `，按 ${a.encoding} 解码` : ''}；完整内容请用 read_attachment 读取，支持 offset/limit 翻页）`
      : a.encoding
        ? `\n   （按 ${a.encoding} 解码的完整内容）`
        : ''
    parts.push(`${head}\n\`\`\`\n${text}\n\`\`\`${note}`)
  })

  return `\n\n# 本次附加文件\n${parts.join('\n\n')}`
}

/** 把用户输入与附件提示词块合成真正送给模型的文本（纯函数，可测） */
export function composeUserMessage(text: string, attachments: readonly Attachment[]): string {
  const block = buildAttachmentBlock(attachments)
  return block ? `${text}${block}` : text
}
