import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  IMAGE_EXTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_INLINE_CHARS,
  PREVIEW_READ_BYTES,
  archivedFileName,
  classifyAttachment,
  extOf,
  formatBytes,
  type Attachment
} from '@shared/attachments'
import { decode, detectEncoding } from '../telnet/encoding'
import { isOffsetOutOfRange, readLineWindow, windowLineArray, READ_LIMIT_DEFAULT, READ_LIMIT_MAX } from './lineReader'
import { extractPdfText } from './pdf'
import {
  DOC_KIND_LABEL,
  documentToLines,
  extractDocumentText,
  sniffDocumentKind,
  type DocumentKind
} from './documents'

/**
 * 附件归档（v1.5）。
 *
 * 用户从输入框导入的文件会被**复制**到 userData/attachments/<会话>/，
 * 原因有两条：
 * 1. 代理后续要用 read_attachment 按需翻页读取，源文件随时可能被用户移动/删除；
 * 2. 工作目录被限制在归档目录内，代理就不可能借着「附件路径」去读系统里任意文件。
 *
 * 并发安全（同一时刻可能有多个任务/多次导入）：
 * - 归档文件名带 `a-<uuid>` 前缀，两次导入同名文件不会互相覆盖；
 * - 复制用 COPYFILE_EXCL，撞名宁可重发一个 id 也不覆盖（发现不一致比丢失更难查）；
 * - 目录创建用 recursive mkdir，本身幂等。
 */

export interface ImportRejection {
  name: string
  reason: string
}

export interface ImportResult {
  attachments: Attachment[]
  rejected: ImportRejection[]
}

/**
 * 读取失败的结构化原因（v2.1）。
 *
 * 为什么要分码：旧实现把**所有**失败都报成 `BAD_PARAM`，而「参数错」在代理眼里
 * 意味着「换个参数再试」—— 于是它会对着一个扫描件 PDF 反复重试，或者把
 * 「这个文件读不了」误读成「我路径写错了」。分码之后代理能做出正确决策：
 * 参数问题 → 改参数；格式问题 → 换一条路（问用户要文字版）。
 */
export type AttachmentReadError =
  /** 入参问题：路径不在归档内、分页参数非法、文件超限 */
  | 'BAD_PARAM'
  /** 不是可读文本（二进制且不是可抽取的文档，如 zip/exe/图片） */
  | 'NOT_TEXT'
  /** PDF 有密码，抽不了正文 */
  | 'PDF_ENCRYPTED'
  /** PDF 里抽不出文字：扫描件/图片版、或字体缺 Unicode 映射 */
  | 'PDF_NO_TEXT'
  /** 文档有密码（Office 加密 / 老式 .doc 的 fEncrypted） */
  | 'DOC_ENCRYPTED'
  /** 认得出格式但抽不出内容：老式 .xls/.ppt、损坏文件、空文档 */
  | 'DOC_UNREADABLE'
  /** 分页 offset 越界（v2.13）：已到末尾或翻过头，明确报出来免得模型对着空页反复翻 */
  | 'OFFSET_OUT_OF_RANGE'

export type AttachmentReadResult =
  | {
      ok: true
      text: string
      encoding: 'utf8' | 'gbk'
      totalLines: number
      from: number
      /** 实际返回的下一行起点（区间 [from, to)），等于 nextOffset */
      to: number
      /** 后续还有未返回的行（= !atEnd） */
      truncated: boolean
      /** v2.13：下一页起点（0-based）；未读完时用它续读 */
      nextOffset: number
      /** v2.13：本次是否已到文件末尾 */
      atEnd: boolean
      /** v2.13：本页是否因输出字节上限提前停止收行（后续行仍在，用 nextOffset 续读） */
      truncatedByBytes: boolean
      /** 内容来自文档抽取（PDF / Word / Excel / PowerPoint / ODF / RTF） */
      format?: AttachmentFormat
      /** 格式展示名（工具摘要用） */
      formatLabel?: string
      /** 给模型看的口径说明（抽取会丢失什么等） */
      note?: string
    }
  | { ok: false; error: string; code: AttachmentReadError }

/**
 * offset 越界的统一失败结果（v2.13）。
 *
 * 为什么是失败而不是「空页 + ok」：旧实现返回 ok 空 text，模型分不清
 * 「读到末尾」与「文件就是空的」，会对着同一页反复翻（长会话里代价很高）。
 * 越界是调用方可自纠的明确错误，报出来它才会改 offset。
 */
function outOfRangeResult(
  from: number,
  totalLines: number
): { ok: false; code: AttachmentReadError; error: string } | null {
  if (!isOffsetOutOfRange(from, totalLines)) return null
  const error =
    from === totalLines
      ? `offset ${from} 已到文件末尾（共 ${totalLines} 行，offset 从 0 开始），无需继续读取`
      : `offset ${from} 超出文件范围（共 ${totalLines} 行，offset 从 0 开始，有效 0-${totalLines - 1}）`
  return { ok: false, code: 'OFFSET_OUT_OF_RANGE', error }
}

function sanitizeSessionId(sessionId: string): string {
  const s = sessionId.replace(/[^0-9a-zA-Z._-]/g, '_').slice(0, 64)
  // R47：`.` / `..` 完全合法字符集，但落到路径上就是目录穿越 —— 必须单独挡掉
  if (!s || /^\.+$/.test(s)) return 'default'
  return s
}

/**
 * v2.14：溢出归档的子目录名（挂在附件根下）。
 *
 * 为什么不另建一个独立目录：附件根**已经**是 `read_attachment` 的可读根，
 * 也已经在「清理附件」的递归清空范围内 —— 挂进来就同时拿到「可读」与「可清」
 * 两件事，而不必再往工具的可读根列表和清理白名单里各加一处。
 */
export const SPILL_DIR = 'spills'

/**
 * 把外部路径解析成 root 内的真实路径（realpath 前后各校验一次，软链同样拦）。
 * 不在 root 内、不存在、不是普通文件一律返回 null；root 本身不存在时同样返回 null
 * （调用方按「这个根当前不可读」处理，不影响其它根）。
 */
function resolveWithin(rootDir: string, filePath: string): string | null {
  try {
    if (!filePath) return null
    const rootReal = fs.realpathSync(rootDir)
    const target = path.resolve(filePath)
    const rel = path.relative(rootDir, target)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null
    const real = fs.realpathSync(target)
    const relReal = path.relative(rootReal, real)
    if (!relReal || relReal.startsWith('..') || path.isAbsolute(relReal)) return null
    return real
  } catch {
    return null
  }
}

/** 读文件头部若干字节（不要为预览把整个大文件读进内存） */
function readHead(file: string, bytes: number): Buffer {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const n = fs.readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n)
  } finally {
    fs.closeSync(fd)
  }
}

export class AttachmentStore {
  /**
   * 文档抽取缓存（v2.1）：key = 归档路径，值按 size+mtime 认版本，翻页时不必重抽。
   *
   * M5（PERF-MEM-REVIEW-2026-09-29 §4.1）：三条纪律，缺一条就是无界驻留 ——
   * ① **LRU 而不是 FIFO**：`get` 命中时要把条目提到队尾，否则「翻第 5 页时把
   *    第 1 页的文档挤掉、翻回去又要重抽整份 PDF」；
   * ② **总字节预算**：条目数封顶 4 挡不住单条巨大 —— `DocLinesOk.lines` 的上限是
   *    `MAX_OUTPUT_CHARS`（200 万字符），4 份满额 ≈ 16MB 常驻，且每行是独立
   *    string 对象；
   * ③ **`setRootDir` 必须清缓存**：切换附件目录后，旧目录下的大文档再也不会被
   *    访问，却仍钉在内存里。
   *
   * 只缓存 `ok: true`：失败结果是「这份文件抽不出文本」，重试代价只是一次
   * 快速失败，没有缓存价值，却会占掉一个名额把真正有用的成功结果挤走。
   */
  private docCache = new Map<string, { key: string; result: DocLinesResult; chars: number }>()
  /** 缓存内 `lines` 字符数合计（`docCache` 的伴随记账，用于按字节淘汰） */
  private docCacheChars = 0

  constructor(private rootDir: string) {}

  setRootDir(newDir: string): void {
    if (newDir === this.rootDir) return
    this.rootDir = newDir
    // M5：换了根目录 → 旧路径的缓存条目再也命中不了，直接清掉（否则旧目录的
    // 大文档会一直占到进程退出）。不解引用也不影响正确性，只是白占内存。
    this.clearDocCache()
  }

  /** M5：清空文档抽取缓存（`setRootDir` 与测试用） */
  clearDocCache(): void {
    this.docCache.clear()
    this.docCacheChars = 0
  }

  /** M5：测试/诊断用 —— 当前缓存的条目数与字符数 */
  docCacheStats(): { entries: number; chars: number } {
    return { entries: this.docCache.size, chars: this.docCacheChars }
  }

  /** M5：缓存条目的容量记账 —— 只算 `lines` 与几个小字符串（其余是定长字段） */
  private static cacheCharsOf(result: DocLinesResult): number {
    if (!result.ok) return 0
    let n = result.label.length + result.note.length + result.format.length
    for (const line of result.lines) n += line.length
    return n
  }

  get root(): string {
    return this.rootDir
  }

  sessionDir(sessionId: string): string {
    return path.join(this.rootDir, sanitizeSessionId(sessionId))
  }

  /**
   * 把外部路径解析成归档目录内的真实路径。
   * 不在归档目录内、不存在、不是普通文件、或经 realpath 后越界（软链）都返回 null。
   */
  resolve(filePath: string): string | null {
    return resolveWithin(this.rootDir, filePath)
  }

  /**
   * readText 用的解析：**附件归档** 或任一额外根（v2.2：导出目录）。
   *
   * 为什么放宽（2026-09-25 实测）：代理用 export_session_report 导出报告、拿到路径后，
   * 手里**没有任何工具能读回它** —— 唯一的文本读取工具就是 read_attachment，而它只认
   * 附件归档，于是模型只能放弃「读回自己刚写的文件」，绕路去连拓扑文件，反而把
   * activeTopology 覆盖掉。导出目录与本工具同属应用受管目录（见 core/storage/usage.ts
   * 的清空白名单），读它不新增越界风险：沙箱边界仍是「应用管理的那几个目录」，
   * 不是「系统里任意文件」。
   *
   * 额外根不存在（导出目录还没建过）时静默跳过，不影响附件本身的读取。
   */
  resolveReadable(filePath: string, extraRoots: readonly string[] = []): string | null {
    for (const root of [this.rootDir, ...extraRoots]) {
      const hit = resolveWithin(root, filePath)
      if (hit) return hit
    }
    return null
  }

  /**
   * v2.14：把工具结果的**完整输出**归档成「可被 `read_attachment` 逐行读回」的文本文件。
   *
   * 落点：`<附件根>/spills/<会话>/<调用 id>.txt` —— 附件根既是 `read_attachment`
   * 的可读根，也在「清理附件」的递归清空范围内，所以归档**天然可读、也天然可清**。
   *
   * 三条纪律：
   * ① **任何失败都返回 null**（调用方退回纯截断）。落盘是锦上添花，不能把这一轮任务带下去，
   *    更不能给出一个其实读不回来的路径；
   * ② 超过 `MAX_ATTACHMENT_BYTES` 的内容直接放弃 —— 那是 `read_attachment` 读不了的大小，
   *    归档了也等于没归档；
   * ③ 文件名清洗后**若与原值不同**就再挂一个随机后缀：清洗是有损的
   *    （`a/b` 与 `a_b` 都会变成 `a_b`），不补后缀就会让两次调用互相覆盖，
   *    模型读回的是**另一次**的结果 —— 这类静默错配比读不到更糟。
   *
   * @param rootId - 会话根 ID（分目录，便于整场实验的归档一起清理）
   * @param callId - 工具调用 ID（同一轮里可能有多次同类调用）
   * @param text - 已渲染好的行可寻址文本（见 `@shared/spill#renderSpillDump`）
   * @returns 归档文件的绝对路径；失败返回 null
   */
  async saveSpill(rootId: string, callId: string, text: string): Promise<string | null> {
    try {
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes === 0 || bytes > MAX_ATTACHMENT_BYTES) return null
      const dir = path.join(this.rootDir, SPILL_DIR, sanitizeSessionId(rootId))
      await fs.promises.mkdir(dir, { recursive: true })
      const safeId = sanitizeSessionId(callId)
      const name = safeId === callId ? callId : `${safeId}-${randomUUID().slice(0, 8)}`
      const file = path.join(dir, `${name}.txt`)
      await fs.promises.writeFile(file, text, 'utf8')
      return file
    } catch {
      return null
    }
  }

  async import(sessionId: string, paths: readonly string[]): Promise<ImportResult> {
    const dir = this.sessionDir(sessionId)
    fs.mkdirSync(dir, { recursive: true })

    const attachments: Attachment[] = []
    const rejected: ImportRejection[] = []
    const list = Array.isArray(paths) ? paths.slice(0, MAX_ATTACHMENTS) : []

    if (Array.isArray(paths) && paths.length > MAX_ATTACHMENTS) {
      rejected.push({ name: `${paths.length - MAX_ATTACHMENTS} 个文件`, reason: `单次最多 ${MAX_ATTACHMENTS} 个附件` })
    }

    for (const raw of list) {
      const src = typeof raw === 'string' ? raw : ''
      const shown = path.basename(src) || src || '（无效路径）'
      try {
        if (!src) {
          rejected.push({ name: shown, reason: '路径为空' })
          continue
        }
        const abs = path.resolve(src)
        if (!fs.existsSync(abs)) {
          rejected.push({ name: shown, reason: '文件不存在' })
          continue
        }
        const st = fs.statSync(abs)
        if (!st.isFile()) {
          rejected.push({ name: shown, reason: '不是普通文件（目录请打包后再导入）' })
          continue
        }
        if (st.size > MAX_ATTACHMENT_BYTES) {
          rejected.push({ name: shown, reason: `超过 ${formatBytes(MAX_ATTACHMENT_BYTES)} 上限` })
          continue
        }

        const name = path.basename(abs)
        const kind = classifyAttachment(name)
        let dest: string | null = null
        let id = ''
        // 撞名重试：COPYFILE_EXCL 保证「要么写成功，要么没碰过目标文件」
        for (let attempt = 0; attempt < 3 && !dest; attempt++) {
          id = `a-${randomUUID().toLowerCase()}`
          const candidate = path.join(dir, archivedFileName(id, name))
          try {
            await fs.promises.copyFile(abs, candidate, fs.constants.COPYFILE_EXCL)
            dest = candidate
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code
            if (code === 'EEXIST') continue
            throw e
          }
        }
        if (!dest) {
          rejected.push({ name, reason: '归档失败（文件名冲突）' })
          continue
        }

        attachments.push({
          id,
          name,
          path: dest,
          size: st.size,
          kind,
          ext: extOf(name),
          addedAt: Date.now(),
          ...buildPreview(dest, kind, st.size)
        })
      } catch (e) {
        rejected.push({ name: shown, reason: e instanceof Error ? e.message : String(e) })
      }
    }

    return { attachments, rejected }
  }

  /**
   * 由归档目录内的路径重建附件元数据（含预览）。
   *
   * 存在的理由：IPC 层不信任渲染层 —— 渲染层回传的 size/kind/preview 一律丢弃，
   * 以磁盘上的真实文件为准重建。这样「附件内容」就只有一条可信来源。
   */
  describe(filePath: string): Attachment | null {
    const real = this.resolve(filePath)
    if (!real) return null
    try {
      const st = fs.statSync(real)
      if (!st.isFile() || st.size > MAX_ATTACHMENT_BYTES) return null
      const archived = path.basename(real)
      const m = /^(a-[0-9a-f-]{36})-(.+)$/.exec(archived)
      const id = m?.[1] ?? `a-${randomUUID().toLowerCase()}`
      const name = m?.[2] ?? archived
      const kind = classifyAttachment(name)
      return {
        id,
        name,
        path: real,
        size: st.size,
        kind,
        ext: extOf(name),
        addedAt: Date.now(),
        ...buildPreview(real, kind, st.size)
      }
    } catch {
      return null
    }
  }

  /**
   * 读取附件内容（read_attachment 工具用）。
   * offset/limit 以行为单位，便于「先看头 100 行，再往下翻」。
   *
   * v2.1：可抽取的**文档格式**先转成文本再按同一套行分页返回 ——
   * PDF（`core/attachments/pdf.ts`）与 Office / RTF（`core/attachments/documents/`）。
   * 附件里有大量这类文件（实验指导书、作业要求、实验报告），旧实现在这里判出
   * 「二进制」就直接拒绝，代理完全无从下手。
   */
  async readText(
    filePath: string,
    // 参数刻意收 unknown：模型可以传 "10" / null / NaN，schema 不保证被运行时校验，
    // 所以「非法值」必须在这里被显式识别（R45），不能靠类型声明兜着
    offset: unknown = 0,
    limit: unknown = READ_LIMIT_DEFAULT,
    // v2.2：额外可读根（导出目录，由工具层从 ctx 取实时值传入 —— 设置里能自定义该目录，
    // 所以在 store 里缓存一份会与设置脱节）
    opts?: { extraRoots?: readonly string[] }
  ): Promise<AttachmentReadResult> {
    const extraRoots = opts?.extraRoots ?? []
    const real = this.resolveReadable(filePath, extraRoots)
    if (!real) {
      return {
        ok: false,
        code: 'BAD_PARAM',
        error:
          '路径不在可读目录内或文件不存在（只能读附件归档目录' +
          (extraRoots.length > 0 ? '与导出目录' : '') +
          '里的文件，其它位置一律拒绝）'
      }
    }
    try {
      const st = fs.statSync(real)
      if (st.size > MAX_ATTACHMENT_BYTES) {
        return {
          ok: false,
          code: 'BAD_PARAM',
          error: `文件过大（${formatBytes(st.size)}），请改用更小的片段或先在外部拆分`
        }
      }
      // R45：offset/limit 必须先判有限性。旧实现 `Math.trunc('abc')` → NaN，
      // 再经 Math.max(0, NaN) 仍是 NaN，最后返回 `from: NaN` —— 调用方拿着
      // 「第 NaN 行起」的结论继续翻页，永远翻不到内容也不会报错。
      if (!isPageNumber(offset) || !isPageNumber(limit)) {
        return {
          ok: false,
          code: 'BAD_PARAM',
          error: `offset / limit 必须是数字，收到 offset=${String(offset)} limit=${String(limit)}`
        }
      }
      const from = Math.max(0, Math.trunc(offset))
      const take = Math.max(1, Math.min(READ_LIMIT_MAX, Math.trunc(limit)))

      // 文档类（PDF / Office / RTF）：先抽成文本，再走同一套行分页
      const doc = this.documentLines(real, st)
      if (doc) {
        if (!doc.ok) return doc
        // v2.13：文档抽取路径同样走窗口裁剪（原先 slice 绕过了单行/字节上限）
        const win = windowLineArray(doc.lines, from, take)
        const docOutOfRange = outOfRangeResult(from, win.totalLines)
        if (docOutOfRange) return docOutOfRange
        return {
          ok: true,
          text: win.text,
          encoding: 'utf8',
          totalLines: win.totalLines,
          from: win.from,
          to: win.to,
          truncated: win.truncated,
          nextOffset: win.nextOffset,
          atEnd: win.atEnd,
          truncatedByBytes: win.truncatedByBytes,
          format: doc.format,
          formatLabel: doc.label,
          note: doc.note
        }
      }

      // T4.8：按行窗口流式读，不再整份 readFileSync + split
      const win = readLineWindow(real, from, take)
      if ('error' in win) {
        // 「二进制」不是参数错误 —— 分开报码，附上「怎么办」的具体建议
        return { ok: false, code: 'NOT_TEXT', error: `${win.error}${binaryHint(real)}` }
      }
      const textOutOfRange = outOfRangeResult(from, win.totalLines)
      if (textOutOfRange) return textOutOfRange
      return {
        ok: true,
        text: win.text,
        encoding: win.encoding,
        totalLines: win.totalLines,
        from: win.from,
        to: win.to,
        truncated: win.truncated,
        nextOffset: win.nextOffset,
        atEnd: win.atEnd,
        truncatedByBytes: win.truncatedByBytes
      }
    } catch (e) {
      return { ok: false, code: 'BAD_PARAM', error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 文档类附件的抽取（PDF / OOXML / ODF / 老式 doc / RTF），带缓存。
   *
   * 返回 `null` 表示「不是我们能抽的文档」—— 调用方回落到普通文本读取
   * （于是普通 ZIP 会得到 NOT_TEXT + 「先解压」的建议，而不是被当成损坏文档）。
   * 缓存按「路径 + 大小 + mtime」认文件：翻第 2 页时不必重抽整份文档。
   * 容量与淘汰口径见 `docCache` 的注释（M5：LRU + 总字符预算）。
   */
  private documentLines(file: string, st: fs.Stats): DocLinesResult | null {
    const head = readHead(file, 8)
    const isPdf = head.subarray(0, 5).toString('latin1') === '%PDF-'
    if (!isPdf && !looksLikeDocContainer(head)) return null

    const key = `${st.size}:${st.mtimeMs}`
    const hit = this.docCache.get(file)
    if (hit && hit.key === key) {
      // M5：LRU 触达 —— 删了重插把它提到队尾（Map 保持插入序）
      this.docCache.delete(file)
      this.docCache.set(file, hit)
      return hit.result
    }

    // 只有确认要抽文档时才整份读：ZIP 与 CFB 的格式判定必须看全量
    // （中央目录在尾部、目录流在文件中间，头部若干字节认不出来）
    let buf: Buffer
    try {
      buf = fs.readFileSync(file)
    } catch (e) {
      return {
        ok: false,
        code: isPdf ? 'PDF_NO_TEXT' : 'DOC_UNREADABLE',
        error: `读取文件失败：${e instanceof Error ? e.message : String(e)}`
      }
    }

    const result = isPdf ? this.extractPdf(buf) : this.extractDoc(buf)
    if (!result) return null

    // M5：失败结果不缓存（见 docCache 注释第 ③ 条）
    if (result.ok) {
      // 同路径的旧条目（版本已过期）先摘掉，避免它的记账残留
      this.dropDocCacheEntry(file)
      const chars = AttachmentStore.cacheCharsOf(result)
      this.docCache.set(file, { key, result, chars })
      this.docCacheChars += chars
      this.trimDocCache()
    }
    return result
  }

  /** M5：摘掉某条缓存并同步字符记账 */
  private dropDocCacheEntry(file: string): void {
    const cur = this.docCache.get(file)
    if (!cur) return
    this.docCacheChars -= cur.chars
    this.docCache.delete(file)
  }

  /**
   * M5：缓存淘汰 —— 先按条数（4 条），再按总字符预算（200 万）。
   *
   * 两条都要，因为两条各自都挡不住极端：条数上限挡不住「4 份各 200 万字」，
   * 字符预算挡不住「很多份小文档」把 Map 撑出大量小对象。
   * 一律**整条淘汰最旧的**（LRU：队首就是最久没被命中的）。
   */
  private trimDocCache(): void {
    while (this.docCache.size > AttachmentStore.DOC_CACHE_MAX_ENTRIES) {
      const oldest = this.docCache.keys().next().value
      if (oldest === undefined) break
      this.dropDocCacheEntry(oldest)
    }
    while (
      this.docCacheChars > AttachmentStore.DOC_CACHE_MAX_CHARS &&
      this.docCache.size > 1
    ) {
      const oldest = this.docCache.keys().next().value
      if (oldest === undefined) break
      this.dropDocCacheEntry(oldest)
    }
  }

  /** M5：缓存条目数上限（原实现的口径，保留） */
  private static readonly DOC_CACHE_MAX_ENTRIES = 4
  /** M5：缓存 `lines` 字符数总预算 —— 约等于原实现「4 份满额」的 1/4，够翻页用 */
  private static readonly DOC_CACHE_MAX_CHARS = 500_000

  private extractPdf(buf: Buffer): DocLinesOk | DocLinesFail {
    const r = extractPdfText(buf)
    if (!r.ok) {
      return {
        ok: false,
        code: r.reason === 'encrypted' ? 'PDF_ENCRYPTED' : 'PDF_NO_TEXT',
        error: r.error
      }
    }
    return {
      ok: true,
      lines: r.text.split('\n'),
      format: 'pdf',
      label: 'PDF',
      note:
        '内容由 PDF 自动抽取（版式、表格行列结构会丢失，多页之间以「--- 第 N 页 ---」分隔）' +
        (r.dropped > 0 ? `；有 ${r.dropped} 个字符因字体缺少 Unicode 映射被丢弃` : '')
    }
  }

  /** 返回 null = 不是可抽取的文档（普通 ZIP 等），交给调用方回落文本路径 */
  private extractDoc(buf: Buffer): DocLinesOk | DocLinesFail | null {
    const kind = sniffDocumentKind(buf)
    if (!kind) return null
    const r = extractDocumentText(buf)
    if (!r.ok) {
      return {
        ok: false,
        code: /加密/.test(r.error) ? 'DOC_ENCRYPTED' : 'DOC_UNREADABLE',
        error: r.error
      }
    }
    const label = DOC_KIND_LABEL[kind]
    return {
      ok: true,
      lines: documentToLines(r.text),
      format: kind,
      label,
      note: `内容由 ${label} 自动抽取（字体、颜色、图片、批注等版式信息不保留；表格按 Tab 分隔、段落按行）`
    }
  }
}

/** 文档容器的头部特征（ZIP / CFB / RTF）：命中才值得把整份文件读进来做格式判定 */
function looksLikeDocContainer(head: Buffer): boolean {
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return true
  if (head.length >= 8 && head.subarray(0, 8).equals(CFB_SIGNATURE)) return true
  return head.subarray(0, 5).toString('latin1') === '{\\rtf'
}

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

type DocLinesOk = {
  ok: true
  lines: string[]
  format: AttachmentFormat
  label: string
  note: string
}
type DocLinesFail = { ok: false; code: AttachmentReadError; error: string }
type DocLinesResult = DocLinesOk | DocLinesFail

/** 附件格式（抽取来源）：pdf 与 Office/RTF 各一套实现，但对外是同一个口径 */
export type AttachmentFormat = 'pdf' | DocumentKind

/** 二进制文件的具体处置建议 —— 泛泛一句「无法读取」对谁都没用 */
function binaryHint(file: string): string {
  const ext = extOf(path.basename(file))
  if (ext === 'xls' || ext === 'ppt') {
    return `；这是老式 Office 格式（.${ext}），请另存为 ${ext === 'xls' ? '.xlsx' : '.pptx'} 后重新导入`
  }
  if (IMAGE_EXTS.has(ext)) return '；这是图片，无法当作文本读取，请把其中的文字内容贴成文本'
  if (ext === 'zip' || ext === 'rar' || ext === '7z' || ext === 'gz' || ext === 'tar') {
    return '；这是压缩包，请解压后再导入其中的文本文件'
  }
  return '；请先用编辑器导出为纯文本（txt/md/csv）再导入'
}

/** 分页参数是否可用（有限数字；缺省由调用方填默认值） */
function isPageNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 文本类附件抽取预览：读头部 → 判编码 → 截断 */
function buildPreview(file: string, kind: Attachment['kind'], size: number): Partial<Attachment> {
  if (kind !== 'text') return {}
  try {
    const head = readHead(file, PREVIEW_READ_BYTES)
    if (head.length === 0) return { preview: '', truncated: false, encoding: 'utf8' }
    // 含 NUL 视为二进制（扩展名骗人时以内容为准）
    if (head.includes(0)) return {}
    const encoding = detectEncoding(head)
    const { text } = decode(head, encoding)
    // 两种「不完整」都要标出来：文本被字符数截断，或文件本身比读到的头部更长
    const incomplete = size > head.length
    if (text.length <= MAX_INLINE_CHARS && !incomplete) {
      return { preview: text, truncated: false, encoding }
    }
    return { preview: text.slice(0, MAX_INLINE_CHARS), truncated: true, encoding }
  } catch {
    return {}
  }
}
