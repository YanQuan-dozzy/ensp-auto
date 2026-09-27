import zlib from 'node:zlib'

/**
 * 最小 ZIP 读取器（v2.1）。
 *
 * 为什么需要：`.docx` / `.xlsx` / `.pptx` / `.odt` 全是 ZIP 容器（OOXML 与 ODF），
 * 用户拿它们当「文档」送来，而旧实现只会判成「二进制」然后拒绝。
 *
 * 为什么不引 `yauzl` / `adm-zip`：这里只需要「按名字取几个 XML 流」，
 * 与项目既有取向一致（PDF 抽取也是自己写的），且能精确控制内存与失败口径。
 *
 * 支持：store（0）与 deflate（8）两种 method、ZIP64 的「是否出现」检测（出现就明确报错，
 * 不去猜）、常见数据描述符（bit 3）场景 —— 这种情况长度在本地头里是 0，改用中央目录
 * 里的值。**不支持**加密 ZIP（报错说明）与多分卷。
 */

export interface ZipEntry {
  name: string
  /** 解压后的内容（惰性：只有被取用过的条目才解压） */
  read(): Buffer | null
  size: number
}

export interface ZipReadResult {
  ok: true
  entries: Map<string, ZipEntry>
  names(): string[]
  get(name: string): Buffer | null
  /** 解压失败/不支持的条目名与原因（诊断用） */
  problems: string[]
}

export type ZipFailure = { ok: false; reason: 'not-zip' | 'zip64' | 'encrypted' | 'broken'; error: string }

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const ZIP64_EOCD_SIG = 0x06064b50
/** 单个条目解压后的上限（防 zip bomb：20 MB 的 docx 不该解出 2 GB） */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

export function readZip(buf: Buffer): ZipReadResult | ZipFailure {
  const eocd = findEndOfCentralDirectory(buf)
  if (eocd < 0) return { ok: false, reason: 'not-zip', error: '不是 ZIP 容器（找不到中央目录）' }
  const count = buf.readUInt16LE(eocd + 10)
  const cenSize = buf.readUInt32LE(eocd + 12)
  const cenOffset = buf.readUInt32LE(eocd + 16)

  // ZIP64：EOCD 里的字段是占位（0xFFFFFFFF），真值在 ZIP64 EOCD 里。这里不实现解析，
  // 但要**明确报错**而不是当成普通 ZIP 去读出垃圾
  if (count === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) {
    const z64 = buf.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))
    if (z64 >= 0 || buf.readUInt32LE(0) === ZIP64_EOCD_SIG) {
      return { ok: false, reason: 'zip64', error: 'ZIP64 容器暂不支持（文件超过 4GB 或条目数超限）' }
    }
  }

  const entries = new Map<string, ZipEntry>()
  const problems: string[] = []
  let p = cenOffset
  const end = Math.min(cenOffset + cenSize, buf.length)
  while (p + 46 <= end && buf.readUInt32LE(p) === CEN_SIG) {
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen

    if (flags & 0x1) {
      problems.push(`${name}：ZIP 已加密`)
      continue
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) {
      problems.push(`${name}：本地头损坏`)
      continue
    }
    const locNameLen = buf.readUInt16LE(localOffset + 26)
    const locExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + locNameLen + locExtraLen

    entries.set(name, {
      name,
      size: rawSize,
      read: () => {
        try {
          if (rawSize > MAX_ENTRY_BYTES) return null
          const dataEnd = Math.min(dataStart + compSize, buf.length)
          const raw = buf.subarray(dataStart, dataEnd)
          if (method === 0) return raw
          if (method === 8) {
            const out = zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
            return out.length > MAX_ENTRY_BYTES ? null : out
          }
          return null
        } catch {
          return null
        }
      }
    })
  }

  if (entries.size === 0) return { ok: false, reason: 'broken', error: 'ZIP 中央目录里没有可用条目' }

  return {
    ok: true,
    entries,
    names: () => [...entries.keys()],
    get: (name: string) => entries.get(name)?.read() ?? null,
    problems
  }
}

/** 从尾部往前找 EOCD（注释最长 64KB） */
function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}
