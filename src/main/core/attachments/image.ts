import fs from 'node:fs'
import path from 'node:path'
import type { Attachment } from '@shared/attachments'
import { formatBytes } from '@shared/attachments'
import {
  MAX_IMAGE_BYTES,
  checkImageLimits,
  parseImageSize,
  sniffImageMime,
  unsupportedFormatHint,
  type ImageGateCode
} from '@shared/image-attach'
import type { AttachmentStore } from './store'

/**
 * 把归档目录里的图片读成「模型能看的图片块」（v2.22，F17）。
 *
 * 与 `readText`（read_attachment 的正文读取）并列，但产出的是 base64 而不是行：
 * 图片没有「行」的概念，且模型的图片输入就是 base64（pi-ai 的 `ImageContent`）。
 *
 * 三条纪律：
 * ① **先判后读**。字节数在 stat 阶段就能确定，超过上限直接拒绝 ——
 *    读一个 18MB 的文件只为告诉用户「太大了」是纯浪费，而且它还要在内存里展开成 24MB 的 base64。
 * ② **以文件签名判格式，不以扩展名**。附件是从磁盘拷进来的，改名/导出错都很常见，
 *    错配发到 provider 那边是一次 400，在这里判出来是一条可执行的提示。
 * ③ **尺寸读不出来不算失败**。头部残缺时跳过尺寸检查只按字节判：
 *    本地解析能力不足不该成为「图片读不了」的理由，宁可让端点去拒。
 */

/** 图片读取失败的原因码：闸门码 + 两个「取不到字节」的码 */
export type ImageReadErrorCode =
  | ImageGateCode
  /** 路径不在受管目录内 / 文件不存在 / 不是普通文件 */
  | 'IMAGE_NOT_FOUND'
  /** 读盘失败（权限、被占用） */
  | 'IMAGE_READ_FAILED'

export interface ImageReadOk {
  ok: true
  /** 受管目录内的真实路径（realpath 后） */
  path: string
  name: string
  /** 由文件签名判定，不是扩展名 */
  mimeType: string
  /** base64，不含 data: 前缀 */
  data: string
  bytes: number
  width: number
  height: number
}

export interface ImageReadFailure {
  ok: false
  code: ImageReadErrorCode
  error: string
}

export type ImageReadResult = ImageReadOk | ImageReadFailure

/** 已通过沙箱校验的绝对路径 → 图片块（不做路径判定，调用方负责） */
export function encodeImageFile(file: string): ImageReadResult {
  const name = path.basename(file)
  let size: number
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) {
      return { ok: false, code: 'IMAGE_NOT_FOUND', error: `${name} 不是普通文件` }
    }
    size = st.size
  } catch {
    return { ok: false, code: 'IMAGE_NOT_FOUND', error: `${name} 不存在或无法访问` }
  }
  if (size === 0) {
    return { ok: false, code: 'IMAGE_UNREADABLE', error: `${name} 是空文件` }
  }
  if (size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      code: 'IMAGE_TOO_LARGE',
      error:
        `${name} ${formatBytes(size)} 超过单张图片 ${formatBytes(MAX_IMAGE_BYTES)} 的上限。` +
        '请先裁剪或压缩（另存为 JPEG 通常即可）后再试。'
    }
  }
  let buf: Buffer
  try {
    buf = fs.readFileSync(file)
  } catch (e) {
    return {
      ok: false,
      code: 'IMAGE_READ_FAILED',
      error: `${name} 读取失败：${e instanceof Error ? e.message : String(e)}`
    }
  }
  const mime = sniffImageMime(buf)
  if (!mime) {
    const ext = path.extname(name).replace('.', '').toLowerCase()
    return {
      ok: false,
      code: 'IMAGE_UNREADABLE',
      error:
        `${name} 的文件内容不是可识别的图片（PNG / JPEG / WebP / GIF / BMP）` +
        `${ext && !mime ? unsupportedFormatHint(ext) : ''}；文件可能损坏、被截断，或扩展名与内容不符。`
    }
  }
  const dims = parseImageSize(buf, mime)
  const gate = checkImageLimits({
    mime,
    bytes: buf.length,
    ...(dims ? { width: dims.width, height: dims.height } : {})
  })
  if (!gate.ok) return { ok: false, code: gate.code, error: gate.message }
  return {
    ok: true,
    path: file,
    name,
    mimeType: gate.mime,
    data: buf.toString('base64'),
    bytes: buf.length,
    width: gate.width,
    height: gate.height
  }
}

/**
 * 沙箱内解析 + 读取一张图片。
 *
 * 沙箱口径与 `read_attachment` **完全一致**（附件归档目录 + 导出目录）：
 * 代理能读到的东西与它能当文本读的东西是同一批，
 * 不给它开一条「读系统里任意图片」的新路。
 */
export function readImageForModel(
  store: AttachmentStore,
  filePath: string,
  extraRoots: readonly string[] = []
): ImageReadResult {
  const real = store.resolveReadable(filePath, extraRoots)
  if (!real) {
    return {
      ok: false,
      code: 'IMAGE_NOT_FOUND',
      error:
        '路径不在可读目录内或文件不存在（只能读附件归档目录' +
        (extraRoots.length > 0 ? '与导出目录' : '') +
        '里的文件，其它位置一律拒绝）'
    }
  }
  return encodeImageFile(real)
}

export interface ImageBatchItem {
  /** 附件 id（用于把失败原因回填到提示词） */
  id: string
  result: ImageReadResult
}

/**
 * 批量读取（本轮用户消息里的图片）。
 *
 * 逐张独立成败：一张挂了不该把同一轮的其它图片一起带下去 ——
 * 用户一次拖 3 张截图是常态，因为其中一张是 4K 就三张全丢，体验上无法接受。
 */
export function readImagesForModel(
  store: AttachmentStore,
  images: readonly Pick<Attachment, 'id' | 'path'>[],
  extraRoots: readonly string[] = []
): ImageBatchItem[] {
  return images.map((a) => ({ id: a.id, result: readImageForModel(store, a.path, extraRoots) }))
}
