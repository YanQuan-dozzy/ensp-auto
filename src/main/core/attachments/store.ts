import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
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
import { readLineWindow } from './lineReader'

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

function sanitizeSessionId(sessionId: string): string {
  const s = sessionId.replace(/[^0-9a-zA-Z._-]/g, '_').slice(0, 64)
  // R47：`.` / `..` 完全合法字符集，但落到路径上就是目录穿越 —— 必须单独挡掉
  if (!s || /^\.+$/.test(s)) return 'default'
  return s
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
  constructor(private rootDir: string) {}

  setRootDir(newDir: string): void {
    this.rootDir = newDir
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
    try {
      if (!filePath) return null
      const rootReal = fs.realpathSync(this.rootDir)
      const target = path.resolve(filePath)
      const rel = path.relative(this.rootDir, target)
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
   */
  async readText(
    filePath: string,
    // 参数刻意收 unknown：模型可以传 "10" / null / NaN，schema 不保证被运行时校验，
    // 所以「非法值」必须在这里被显式识别（R45），不能靠类型声明兜着
    offset: unknown = 0,
    limit: unknown = 400
  ): Promise<
    | { ok: true; text: string; encoding: 'utf8' | 'gbk'; totalLines: number; from: number; to: number; truncated: boolean }
    | { ok: false; error: string }
  > {
    const real = this.resolve(filePath)
    if (!real) return { ok: false, error: '路径不在附件归档目录内或文件不存在' }
    try {
      const st = fs.statSync(real)
      if (st.size > MAX_ATTACHMENT_BYTES) {
        return { ok: false, error: `文件过大（${formatBytes(st.size)}），请改用更小的片段或先在外部拆分` }
      }
      // R45：offset/limit 必须先判有限性。旧实现 `Math.trunc('abc')` → NaN，
      // 再经 Math.max(0, NaN) 仍是 NaN，最后返回 `from: NaN` —— 调用方拿着
      // 「第 NaN 行起」的结论继续翻页，永远翻不到内容也不会报错。
      if (!isPageNumber(offset) || !isPageNumber(limit)) {
        return { ok: false, error: `offset / limit 必须是数字，收到 offset=${String(offset)} limit=${String(limit)}` }
      }
      const from = Math.max(0, Math.trunc(offset))
      const take = Math.max(1, Math.min(4000, Math.trunc(limit)))
      // T4.8：按行窗口流式读，不再整份 readFileSync + split
      const win = readLineWindow(real, from, take)
      if ('error' in win) return { ok: false, error: win.error }
      return {
        ok: true,
        text: win.text,
        encoding: win.encoding,
        totalLines: win.totalLines,
        from: win.from,
        to: win.to,
        truncated: win.truncated
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
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
