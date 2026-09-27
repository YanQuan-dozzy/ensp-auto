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

/**
 * 能**抽取正文**的文档扩展名（v2.1）。
 *
 * 这些格式在分类上算 `binary`（不参与内联预览），但 `read_attachment` 能把正文抽出来，
 * 所以提示词里必须写成「可以读」而不是「二进制读不了」——
 * 旧文案让模型直接放弃（2026-09-25 实测）。
 * 列表要与 `main/core/attachments/documents/index.ts` 的识别能力保持一致。
 */
export const READABLE_DOC_EXTS: ReadonlySet<string> = new Set([
  'pdf',
  'docx',
  'doc',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf'
])

/** 扩展名 → 展示名（比「二进制」有意义得多） */
const DOC_EXT_LABEL: Record<string, string> = {
  pdf: 'PDF',
  docx: 'Word',
  doc: 'Word（97-2003）',
  xlsx: 'Excel',
  pptx: 'PowerPoint',
  odt: 'ODF 文本文档',
  ods: 'ODF 表格',
  odp: 'ODF 演示',
  rtf: 'RTF'
}

/**
 * 分类的展示名。
 *
 * `ext` 是可选的：文档类在分类上仍是二进制，但对用户来说界面上标「PDF / Word / Excel」
 * 比标「二进制」清楚得多 —— 后者会让人以为「这文件还是读不了」。
 */
export function kindLabel(kind: AttachmentKind, ext = ''): string {
  if (ext && DOC_EXT_LABEL[ext]) return DOC_EXT_LABEL[ext]
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
  const lines = attachments.map((a) => `📎 ${a.name}（${formatBytes(a.size)} · ${kindLabel(a.kind, a.ext)}）`)
  return lines.join('\n')
}

/**
 * v2.22（F17）：图片进模型的结果 —— 决定图片那一行提示词怎么写。
 *
 * 为什么要显式传进来而不是让 buildAttachmentBlock 自己判断：
 * 「模型能不能看图」是**这一轮档案的能力**，「这张图有没有真的附上」是**读取结果**，
 * 两者都在调用方手里（运行时），本函数只负责渲染。
 */
export interface ImageBlockContext {
  /** 本轮模型能不能看图（`modelImageGate` 判定） */
  modelCanSee: boolean
  /** 附不上的图片：附件 id → 原因（格式不支持 / 超限 / 读取失败 / 模型不支持） */
  blocked?: ReadonlyMap<string, string>
}

/**
 * 拼「本次附加文件」提示词块。
 *
 * 非文本附件也会列出路径：模型虽然读不到图片像素，但可以据此判断
 * 「用户给的是截图」并主动询问，比装作没看见要好。
 *
 * v2.22（F17）：图片那一行按**真实结果**写 —— 附上了就说附上了（模型别再多此一举
 * 去读一遍），没附上就写明原因（模型和用户都不该以为「用户根本没给图」）。
 */
export function buildAttachmentBlock(
  attachments: readonly Attachment[],
  opts?: { perFileChars?: number; totalChars?: number; images?: ImageBlockContext }
): string {
  if (attachments.length === 0) return ''
  const perFile = Math.max(200, opts?.perFileChars ?? MAX_INLINE_CHARS)
  const total = Math.max(perFile, opts?.totalChars ?? MAX_TOTAL_INLINE_CHARS)

  let budget = total
  const parts: string[] = []

  attachments.forEach((a, i) => {
    const head = `${i + 1}. ${a.name}（${kindLabel(a.kind, a.ext)}，${formatBytes(a.size)}）\n   路径：${a.path}`
    if (a.kind !== 'text' || !a.preview) {
      // 文档类虽然算二进制，但 read_attachment 能抽出正文 —— 提示要写清「可用」，
      // 否则模型会像旧版一样以为「二进制 = 读不了」而放弃（2026-09-25 实测）
      const tail = READABLE_DOC_EXTS.has(a.ext)
        ? `   注意：这是 ${kindLabel(a.kind, a.ext)} 文档，可以直接用 read_attachment 读取正文` +
          '（自动抽取文本：版式、图片、批注不保留，表格按 Tab 分隔、段落按行；' +
          (a.ext === 'pdf' ? '多页以「--- 第 N 页 ---」分隔' : '多页/多表以标题行分隔') +
          '）。'
        : a.kind === 'image'
          ? imageAttachmentNote(a, opts?.images)
          : '   注意：这是二进制文件，无法内联；read_attachment 也读不了这种格式，' +
            '如需解析请说明你希望从中得到什么，或请用户导出为文本。'
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

/**
 * v2.22（F17）：图片那一条的提示词。
 *
 * 三种情形必须说清（旧实现只有第二种，于是「支持图片的模型」也被告知读不了图）：
 * ① 已随消息附上 → 让模型**别**再调 read_image 去取像素（多花一次往返还多一份 token）；
 * ② 没附上 → 写明原因（格式/体积/模型能力），模型才知道能不能继续指望它；
 * ③ 没传能力上下文 → 退回旧口径（模型看不到图，但知道「用户给了截图」）。
 */
function imageAttachmentNote(a: Attachment, ctx?: ImageBlockContext): string {
  const blocked = ctx?.blocked?.get(a.id)
  if (blocked) return `   注意：这张图片**没有**附给你，原因：${blocked}`
  if (ctx?.modelCanSee) {
    return (
      '   注意：这张图片已随本条消息**直接附给你**，可以直接观察其中的像素内容' +
      '（坐标按图片自身像素计）。不需要为了“看一眼”再调 read_image —— ' +
      '只有在需要原始文件尺寸、或需要把同一张图按路径再读一遍时才用它。'
    )
  }
  return '   注意：这是图片，当前模型无法读取像素内容。若任务依赖图片里的信息，请先向用户确认关键内容，或请用户切换到支持图片输入的模型。'
}

/** 把用户输入与附件提示词块合成真正送给模型的文本（纯函数，可测） */
export function composeUserMessage(
  text: string,
  attachments: readonly Attachment[],
  opts?: { perFileChars?: number; totalChars?: number; images?: ImageBlockContext }
): string {
  const block = buildAttachmentBlock(attachments, opts)
  return block ? `${text}${block}` : text
}

/**
 * v2.22（F17）：已经读成 base64 的图片，可直接放进 pi-ai 的 content parts。
 *
 * 形状与 pi-ai 的 `ImageContent` 一致，但**刻意不 import 它的类型**：
 * 本模块是两端（主进程 / 渲染层）共用的纯逻辑层，绑死 LLM SDK 会让它既进不了
 * 渲染层的 tsconfig、也让「附件」这件事莫名依赖某个 provider 库。
 */
export interface ResolvedImage {
  mimeType: string
  /** base64（不含 data: 前缀） */
  data: string
}

export type UserTextPart = { type: 'text'; text: string }
export type UserImagePart = { type: 'image'; mimeType: string; data: string }

/**
 * 合成真正送进模型的一轮用户消息。
 *
 * 没有图片时返回**字符串**（与旧行为逐字一致 —— 大量既有用例与提示词缓存都依赖这一点：
 * 图片附件的存在会改变消息前缀，但纯文本会话的前缀必须保持不变）。
 * 有图片时返回 parts 数组：文本在前、图片在后，顺序稳定。
 */
export function composeUserContent(
  text: string,
  images: readonly ResolvedImage[] = []
): string | Array<UserTextPart | UserImagePart> {
  if (images.length === 0) return text
  return [
    { type: 'text', text },
    ...images.map((img) => ({ type: 'image' as const, mimeType: img.mimeType, data: img.data }))
  ]
}
