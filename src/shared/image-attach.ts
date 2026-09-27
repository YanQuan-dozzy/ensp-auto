/**
 * 图片读取的纯逻辑（v2.22，F17）—— 格式嗅探 / 尺寸解析 / 闸门 / 文案。
 *
 * 为什么要有这一层（对标 deepseek-harness 的 `read_image` + attachment 能力闸门）：
 * 1. **模型必须先被证明能看图**。pi-ai 在 openai-completions 线里只对
 *    `model.input.includes('image')` 的模型附工具结果里的图片，其余**静默丢弃**；
 *    而用户消息里的图片更是直接发出去 —— 不支持视觉的端点会 400 或装作没看见。
 *    所以「能不能看图」必须在**发之前**判定，不能等 provider 报错。
 * 2. 图片与文本的失败语义完全不同：文本读不了可以换一条路，图片超限只能压缩。
 *    分码（`ImageGateCode`）才能让代理/用户各自做出正确决策。
 * 3. 嗅探与尺寸解析刻意**不依赖任何图像库**（本仓不允许为此引新依赖）：
 *    PNG/JPEG/GIF/WebP/BMP 的头部都是定长/可扫描的，纯字节解析即可，
 *    于是这条链路能进测试 harness，也能在沙箱里跑。
 */

/** 模型侧可接受的图片 MIME（OpenAI 兼容线、Anthropic、Google 三家共同支持的集合） */
export const MODEL_IMAGE_MIMES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
] as const

/** 扩展名 → MIME（仅限模型可接受的四种；其余图片格式按「不支持」处理） */
export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

/**
 * 认得出来、但**模型不吃**的图片格式。
 *
 * 单独列出来的价值在于文案：对 `.bmp` 说「这不是图片」是错的，说「请转存为 PNG/JPEG」
 * 才是可执行的建议（用户手上就有画图/截图工具）。
 */
export const UNSUPPORTED_IMAGE_EXTS: ReadonlySet<string> = new Set([
  'bmp',
  'ico',
  'tif',
  'tiff',
  'avif'
])

/**
 * 单张图片进模型的字节上限（编码后大小）。
 *
 * 取 5 MB 而不是附件的 20 MB：base64 展开约 4/3，再叠上请求体里其它内容，
 * 5 MB 已是 Anthropic 单图硬上限的量级 —— 超了必然被端点拒绝，
 * 与其把整轮请求打挂，不如在本地就给出「压缩后再来」的明确指令。
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** 单边像素上限（与多数视觉端点一致；超过等于白花流量） */
export const MAX_IMAGE_DIMENSION = 8000
/** 解码后总像素上限：拦住「边长不大但像素爆炸」的图（也拦住解压炸弹） */
export const MAX_IMAGE_PIXELS = 32_000_000

/**
 * 图片无法进模型的原因码。
 *
 * 与 `AttachmentReadError` 同一个思路：分码 → 调用方知道下一步该做什么。
 * 尤其 `MODEL_NO_IMAGE` 与 `IMAGE_TOO_LARGE` 必须分开 ——
 * 前者要用户换模型，后者要用户压图片，给成一条消息等于两条路都断了。
 */
export type ImageGateCode =
  /** 当前模型未开启图片输入能力（唯一需要用户改配置的一类） */
  | 'MODEL_NO_IMAGE'
  /** 格式不在模型可接受集合内（bmp/tiff/ico/avif…） */
  | 'IMAGE_UNSUPPORTED_FORMAT'
  /** 编码后字节超限 */
  | 'IMAGE_TOO_LARGE'
  /** 单边像素超限 */
  | 'IMAGE_DIMENSION_TOO_LARGE'
  /** 总像素超限 */
  | 'IMAGE_TOO_MANY_PIXELS'
  /** 认不出格式 / 头部残缺（不是可读的图片） */
  | 'IMAGE_UNREADABLE'

export interface ImageGateFailure {
  ok: false
  code: ImageGateCode
  /** 给用户/模型看的中文原因（不含路径，由调用方决定是否加「无法读取 X」前缀） */
  message: string
}

export interface ImageGateOk {
  ok: true
  mime: string
  width: number
  height: number
  bytes: number
}

export type ImageGateResult = ImageGateOk | ImageGateFailure

/** 只取判定所需的最小形状 —— 刻意不 import `Attachment`，避免 shared 内部成环 */
export interface ImageCandidate {
  name: string
  ext: string
  size: number
  kind: string
}

/**
 * 当前模型能否看图。
 *
 * 只看档案上的显式声明（`supportsImage`），**不做型号猜测**：
 * 猜错的代价是整轮请求 400，而声明错误的代价只是一次显式的拒绝提示。
 */
export function modelImageGate(
  profile: { label?: string; model?: string; supportsImage?: boolean } | undefined
): { ok: true } | ImageGateFailure {
  if (profile?.supportsImage === true) return { ok: true }
  const name = [profile?.label, profile?.model].filter(Boolean).join(' · ') || '当前模型'
  return {
    ok: false,
    code: 'MODEL_NO_IMAGE',
    message:
      `当前模型「${name}」未声明图片输入能力，无法读取图片。` +
      '请到「设置 → 模型」勾选这一档的「支持图片输入」，或改用支持视觉的模型档' +
      '（输入框左下角的模型切换器可直接切换）。'
  }
}

/** 附件里的图片（按输入顺序） */
export function imageAttachmentsOf<T extends ImageCandidate>(attachments: readonly T[]): T[] {
  return attachments.filter((a) => a.kind === 'image')
}

/** 由扩展名推 MIME；不认识的图片格式返回 undefined */
export function imageMimeOfExt(ext: string): string | undefined {
  return IMAGE_MIME_BY_EXT[ext.toLowerCase()]
}

// ———————————————————————— 头部解析（无依赖） ————————————————————————

function startsWith(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false
  for (let i = 0; i < expected.length; i++) if (bytes[offset + i] !== expected[i]) return false
  return true
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) return false
  for (let i = 0; i < value.length; i++) if (bytes[offset + i] !== value.charCodeAt(i)) return false
  return true
}

const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!
const u16le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8)
const u32le = (b: Uint8Array, i: number): number =>
  (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0
const u32be = (b: Uint8Array, i: number): number =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0

/**
 * 按文件签名识别格式（不信扩展名）。
 *
 * 为什么以内容为准：附件是从磁盘拷进来的，`a.png` 完全可能是别的格式（改名、导出错），
 * 而这种错配发到模型那边就是一次 400，本地判出来则是一条可执行的提示。
 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'image/gif'
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp'
  if (ascii(bytes, 0, 'BM')) return 'image/bmp'
  if (startsWith(bytes, 0, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'image/tiff'
  }
  if (startsWith(bytes, 0, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon'
  return undefined
}

/** PNG：IHDR 紧随签名，宽高各 4 字节大端 */
function pngSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 24) return undefined
  return { width: u32be(b, 16), height: u32be(b, 20) }
}

/** GIF：逻辑屏幕描述符宽高各 2 字节小端 */
function gifSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 10) return undefined
  return { width: u16le(b, 6), height: u16le(b, 8) }
}

/**
 * JPEG：没有固定头部，必须扫 SOF 段。
 *
 * 只能扫前若干 KB（附件读取是流式头部读取，不是整份）：SOF 段出现在
 * 压缩数据之前，正常照片里它总在前几百字节内；扫不到就说明头部异常，
 * 交给上层按「认不出尺寸」处理。
 */
function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]!
    // 填充字节（0xFF 连续）跳过
    if (marker === 0xff) {
      i++
      continue
    }
    // 无长度字段的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = u16be(b, i + 2)
    if (len < 2) return undefined
    // SOF0-3 / SOF5-7 / SOF9-11 / SOF13-15：0xC4(DHT)/0xC8(JPG)/0xCC(DAC) 不是 SOF
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (i + 9 > b.length) return undefined
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) }
    }
    // SOS 之后就是压缩数据，不可能再有 SOF
    if (marker === 0xda) return undefined
    i += 2 + len
  }
  return undefined
}

/** WebP：三种子格式（有损 VP8 / 无损 VP8L / 扩展 VP8X）各有一套尺寸编码 */
function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 30) return undefined
  if (ascii(b, 12, 'VP8X')) {
    const w = b[24]! | (b[25]! << 8) | (b[26]! << 16)
    const h = b[27]! | (b[28]! << 8) | (b[29]! << 16)
    return { width: w + 1, height: h + 1 }
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return undefined
    const v = u32le(b, 21)
    return { width: (v >>> 1 & 0x3fff) + 1, height: ((v >>> 15) & 0x3fff) + 1 }
  }
  if (ascii(b, 12, 'VP8 ')) {
    // 帧头起始码必须命中，否则说明这里不是关键帧数据
    if (!startsWith(b, 23, [0x9d, 0x01, 0x2a])) return undefined
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  return undefined
}

/** BMP：DIB 头宽度/高度各 4 字节小端（高度可为负 = 自上而下） */
function bmpSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 26) return undefined
  const dib = u32le(b, 14)
  if (dib < 12) return undefined
  const width = u32le(b, 18)
  const rawH = u32le(b, 22)
  const height = rawH > 0x7fffffff ? 0x100000000 - rawH : rawH
  return { width: Math.abs(width), height: Math.abs(height) }
}

/**
 * 从文件头解析像素尺寸（不解码像素）。
 *
 * 返回 undefined = 头部残缺或格式不支持解析。调用方**不应**把它当成致命错误：
 * 尺寸只是闸门输入，拿不到就跳过尺寸检查、只按字节数判（宁可放行也不能误拦）。
 */
export function parseImageSize(
  bytes: Uint8Array,
  mime?: string
): { width: number; height: number } | undefined {
  const kind = mime ?? sniffImageMime(bytes)
  switch (kind) {
    case 'image/png':
      return pngSize(bytes)
    case 'image/jpeg':
      return jpegSize(bytes)
    case 'image/gif':
      return gifSize(bytes)
    case 'image/webp':
      return webpSize(bytes)
    case 'image/bmp':
      return bmpSize(bytes)
    default:
      return undefined
  }
}

// ———————————————————————— 闸门 ————————————————————————

/**
 * 对一张**已读到字节**的图片做闸门判定。
 *
 * 顺序是刻意的：格式 → 字节 → 边长 → 总像素。
 * 格式排第一是因为后面三项对不可识别的字节没有意义；
 * 字节排第二是因为它是唯一「不需要解析就绝对确定」的信息。
 *
 * `width/height` 缺失（头部残缺）时跳过两项尺寸检查 —— 宁可让端点去拒，
 * 也不能因为本地读不出尺寸就把一张正常图片拦下。
 */
export function checkImageLimits(input: {
  /** 已识别的 MIME（由 sniffImageMime 得到，不用扩展名） */
  mime: string
  bytes: number
  width?: number
  height?: number
}): ImageGateResult {
  if (!MODEL_IMAGE_MIMES.includes(input.mime)) {
    const label = input.mime.replace(/^image\//, '').toUpperCase()
    return {
      ok: false,
      code: 'IMAGE_UNSUPPORTED_FORMAT',
      message:
        `图片格式 ${label} 不被模型接受。可用格式为 PNG / JPEG / WebP / GIF，` +
        '请先转存为其中一种再重试。'
    }
  }
  if (input.bytes > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      code: 'IMAGE_TOO_LARGE',
      message:
        `图片 ${formatMegabytes(input.bytes)} 超过 ${formatMegabytes(MAX_IMAGE_BYTES)} 上限。` +
        '请先裁剪或压缩（另存为 JPEG 通常即可）后再重试。'
    }
  }
  const { width, height } = input
  if (typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0) {
    if (Math.max(width, height) > MAX_IMAGE_DIMENSION) {
      return {
        ok: false,
        code: 'IMAGE_DIMENSION_TOO_LARGE',
        message:
          `图片 ${width}×${height} 的单边超过 ${MAX_IMAGE_DIMENSION}px 上限。` +
          '请先缩小尺寸后再重试。'
      }
    }
    if (width * height > MAX_IMAGE_PIXELS) {
      return {
        ok: false,
        code: 'IMAGE_TOO_MANY_PIXELS',
        message:
          `图片 ${width}×${height} 超过 ${MAX_IMAGE_PIXELS / 1_000_000} 百万像素上限。` +
          '请先缩小尺寸后再重试。'
      }
    }
    return { ok: true, mime: input.mime, width, height, bytes: input.bytes }
  }
  return { ok: true, mime: input.mime, width: 0, height: 0, bytes: input.bytes }
}

function formatMegabytes(n: number): string {
  const mb = n / 1024 / 1024
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`
}

/** 格式不支持时按扩展名给出的具体建议（`.bmp` ≠ 「不是图片」） */
export function unsupportedFormatHint(ext: string): string {
  const e = ext.toLowerCase()
  if (!UNSUPPORTED_IMAGE_EXTS.has(e)) return ''
  return `（.${e} 属于模型不接受的格式，转存为 PNG 或 JPEG 即可）`
}

/**
 * 一次「把附件的图片送进本轮消息」的计划（纯函数，运行时与界面共用同一份判定）。
 *
 * 返回的 `blocked` 不是异常而是**要写进提示词的说明** ——
 * 图片没能附上时让模型知道「用户给了图但没进来、原因是什么」，
 * 比让它以为「用户根本没给图」要好得多（旧实现就是这个毛病）。
 */
export interface ImageSendPlan<T extends ImageCandidate = ImageCandidate> {
  /** 可以真的附给模型的图片（还需经过字节/尺寸闸门） */
  images: T[]
  /** 附不上的图片及其原因 */
  blocked: { attachment: T; reason: string }[]
  /** 模型本身能不能看图（false 时 images 恒为空） */
  modelCanSee: boolean
}

export function planUserImages<T extends ImageCandidate>(
  attachments: readonly T[],
  profile: { label?: string; model?: string; supportsImage?: boolean } | undefined
): ImageSendPlan<T> {
  const all = imageAttachmentsOf(attachments)
  const gate = modelImageGate(profile)
  if (!gate.ok) {
    return { images: [], blocked: all.map((a) => ({ attachment: a, reason: gate.message })), modelCanSee: false }
  }
  const images: T[] = []
  const blocked: { attachment: T; reason: string }[] = []
  for (const a of all) {
    const mime = imageMimeOfExt(a.ext)
    if (!mime) {
      blocked.push({
        attachment: a,
        reason:
          `格式 .${a.ext} 不被模型接受${unsupportedFormatHint(a.ext)}` +
          '（可用：PNG / JPEG / WebP / GIF）'
      })
      continue
    }
    images.push(a)
  }
  return { images, blocked, modelCanSee: true }
}

/**
 * v2.22（F17）：界面上的「这次发送里图片进不去」判定。
 *
 * 与主进程用**同一份**能力判定（`modelImageGate`），避免出现
 * 「界面说能发、主进程拒绝」这种自相矛盾（这个项目吃过太多契约漂移的亏）。
 * 返回 null = 没有图片，或没有图片被拦下。
 */
export interface BlockedImageSend {
  /** 被拦下的图片名（用于提示与界面标记） */
  names: string[]
  code: ImageGateCode
  /** 可直接展示给用户的完整说明（含出路） */
  message: string
}

export function blockedImagesForSend<T extends ImageCandidate>(
  attachments: readonly T[],
  profile: { label?: string; model?: string; supportsImage?: boolean } | undefined
): BlockedImageSend | null {
  const images = imageAttachmentsOf(attachments)
  if (images.length === 0) return null
  const gate = modelImageGate(profile)
  if (gate.ok) return null
  const names = images.map((a) => a.name)
  return {
    names,
    code: gate.code,
    message:
      `${gate.message}\n本次选择的图片：${names.join('、')}。` +
      '请先在该档开启图片输入、或切换到支持图片的模型档；若本次不需要图片，移除后即可发送。'
  }
}
