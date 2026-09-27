import { decodeCp1252 } from '../../charset/cp1252'
import { normalizeText } from '../textNormalize'
import type { DocExtractResult } from './ooxml'

/**
 * 老式 Word（.doc，Word 97-2003 二进制）文本抽取（v2.1）。
 *
 * 为什么值得单独写：`.doc` 在中文学术/办公场景里仍然常见（本机就有一份 3.5 MB 的实验报告），
 * 而它是 **CFB（复合文档）** 容器 —— 不是 ZIP、不是文本，旧实现只能判「二进制」拒绝。
 *
 * 两步：
 * 1. **容器层**：解析 CFB 头 → FAT/DIFAT 扇区链 → 目录条目 → 取出 `WordDocument`
 *    与 `1Table` / `0Table` 两个流（小流走 MiniFAT，见 4096 字节的 miniStreamCutoff）；
 * 2. **文字层**：FIB 里 `fcClx`(0x01A2) / `lcbClx`(0x01A6) 给出分片表（CLX → PlcPcd），
 *    每片的 `fc` 最高位是「压缩（CP1252，1 字节/字符）」还是「Unicode（UTF-16LE）」，
 *    按 CP 区间长度逐片解码 —— 这是 Word 的「快速保存」能把删改片段留在文件里的原因，
 *    也是**不能**直接读 `fcMin..fcMac` 的原因（那样会把已删除的内容一起读出来）。
 *
 * 失败一律给结构化原因：加密（fEncrypted）、容器坏、无分片表可兜底。
 * 兜底路径只在拿不到 CLX 时启用（Word 6/95 或截断文件），并用「哪种解码更像文本」选择编码。
 */

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff

export type CfbResult =
  | { ok: true; streams: Map<string, Buffer> }
  | { ok: false; reason: 'parse-failed'; error: string }

interface DirEntry {
  name: string
  type: number
  startSector: number
  size: number
}

/** 解析 CFB 容器，返回「名字 → 流内容」（全部读进内存：Word 正文流通常只有几百 KB） */
export function readCfb(buf: Buffer): CfbResult {
  if (buf.length < 512 || !buf.subarray(0, 8).equals(CFB_SIGNATURE)) {
    return { ok: false, reason: 'parse-failed', error: '不是 CFB 容器（缺少 OLE2 魔数）' }
  }
  const sectorSize = 1 << buf.readUInt16LE(0x1e)
  const miniSectorSize = 1 << buf.readUInt16LE(0x20)
  const sectorBase = sectorSize === 4096 ? 4096 : 512
  if (sectorSize < 512 || sectorSize > 4096 || buf.length < sectorBase) {
    return { ok: false, reason: 'parse-failed', error: `CFB 扇区尺寸异常（${sectorSize}）` }
  }
  const sectorOffset = (n: number): number => sectorBase + n * sectorSize

  const numFatSectors = buf.readUInt32LE(0x2c)
  const firstDirSector = buf.readUInt32LE(0x30)
  const miniStreamCutoff = buf.readUInt32LE(0x38) || 4096
  const firstMiniFat = buf.readUInt32LE(0x3c)
  const numMiniFat = buf.readUInt32LE(0x40)
  const firstDifat = buf.readUInt32LE(0x44)
  const numDifat = buf.readUInt32LE(0x48)

  // —— FAT 扇区清单：头里 109 个，不够再顺着 DIFAT 链取 ——
  const fatSectors: number[] = []
  for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4)
    if (s !== FREESECT) fatSectors.push(s)
  }
  let difat = firstDifat
  const perDifat = sectorSize / 4 - 1
  for (let i = 0; i < numDifat && difat !== ENDOFCHAIN && difat !== FREESECT; i++) {
    const base = sectorOffset(difat)
    if (base + sectorSize > buf.length) break
    for (let j = 0; j < perDifat && fatSectors.length < numFatSectors; j++) {
      const s = buf.readUInt32LE(base + j * 4)
      if (s !== FREESECT) fatSectors.push(s)
    }
    difat = buf.readUInt32LE(base + perDifat * 4)
  }

  const fat: number[] = []
  for (const s of fatSectors) {
    const base = sectorOffset(s)
    if (base + sectorSize > buf.length) continue
    for (let i = 0; i < sectorSize / 4; i++) fat.push(buf.readUInt32LE(base + i * 4))
  }
  if (fat.length === 0) return { ok: false, reason: 'parse-failed', error: 'CFB 没有可用的 FAT' }

  /** 沿 FAT 链拼出扇区数据 */
  const readChain = (start: number, size: number): Buffer => {
    const parts: Buffer[] = []
    let cur = start
    let left = size
    const guard = new Set<number>()
    while (cur !== ENDOFCHAIN && cur !== FREESECT && left > 0 && !guard.has(cur)) {
      guard.add(cur)
      const base = sectorOffset(cur)
      if (base >= buf.length) break
      const chunk = buf.subarray(base, Math.min(base + sectorSize, buf.length))
      parts.push(chunk)
      left -= chunk.length
      cur = fat[cur] ?? ENDOFCHAIN
    }
    const all = Buffer.concat(parts)
    return size >= 0 && size < all.length ? all.subarray(0, size) : all
  }

  // —— 目录 ——
  if (firstDirSector >= fat.length && firstDirSector !== ENDOFCHAIN) {
    return { ok: false, reason: 'parse-failed', error: 'CFB 目录扇区越界' }
  }
  const dirData = readChain(firstDirSector, Number.MAX_SAFE_INTEGER)
  const entries: DirEntry[] = []
  for (let p = 0; p + 128 <= dirData.length; p += 128) {
    const nameLen = dirData.readUInt16LE(p + 0x40)
    const type = dirData[p + 0x42]
    if (type === 0) continue
    const nameBytes = dirData.subarray(p, p + Math.max(0, Math.min(64, nameLen - 2)))
    const name = nameBytes.toString('utf16le')
    entries.push({
      name,
      type,
      startSector: dirData.readUInt32LE(p + 0x74),
      size: dirData.readUInt32LE(p + 0x78)
    })
  }
  const root = entries.find((e) => e.type === 5)
  if (!root) return { ok: false, reason: 'parse-failed', error: 'CFB 缺少根目录条目' }

  // —— MiniFAT（小于 4096 字节的流住在根流里） ——
  const miniFat: number[] = []
  if (numMiniFat > 0) {
    const miniFatData = readChain(firstMiniFat, numMiniFat * sectorSize)
    for (let i = 0; i + 4 <= miniFatData.length; i += 4) miniFat.push(miniFatData.readUInt32LE(i))
  }
  const miniStream = readChain(root.startSector, root.size)

  const readStream = (e: DirEntry): Buffer => {
    if (e.size < miniStreamCutoff) {
      const parts: Buffer[] = []
      let cur = e.startSector
      let left = e.size
      const guard = new Set<number>()
      while (cur !== ENDOFCHAIN && cur !== FREESECT && left > 0 && !guard.has(cur)) {
        guard.add(cur)
        const base = cur * miniSectorSize
        if (base >= miniStream.length) break
        const chunk = miniStream.subarray(base, Math.min(base + miniSectorSize, miniStream.length))
        parts.push(chunk)
        left -= chunk.length
        cur = miniFat[cur] ?? ENDOFCHAIN
      }
      const all = Buffer.concat(parts)
      return e.size < all.length ? all.subarray(0, e.size) : all
    }
    return readChain(e.startSector, e.size)
  }

  const streams = new Map<string, Buffer>()
  for (const e of entries) {
    if (e.type !== 2) continue
    try {
      streams.set(e.name, readStream(e))
    } catch {
      // 单个流读不出来不影响其它流（Word 文档里常带损坏的图片流）
    }
  }
  return { ok: true, streams }
}

/** 认一认这个 CFB 到底是什么（决定报「加密」还是「不支持的老格式」） */
export function classifyCfb(
  streams: Map<string, Buffer>
): 'doc' | 'xls' | 'ppt' | 'encrypted' | 'unknown' {
  const names = [...streams.keys()]
  if (names.some((n) => /^EncryptionInfo$/i.test(n) || /^EncryptedPackage$/i.test(n))) return 'encrypted'
  if (names.some((n) => n === 'WordDocument')) return 'doc'
  if (names.some((n) => /^(Workbook|Book)$/i.test(n))) return 'xls'
  if (names.some((n) => /^PowerPoint Document$/i.test(n))) return 'ppt'
  return 'unknown'
}

/** 走完两步，抽正文 */
export function extractLegacyDoc(buf: Buffer): DocExtractResult {
  const cfb = readCfb(buf)
  if (!cfb.ok) return { ok: false, reason: 'parse-failed', error: cfb.error }
  const kind = classifyCfb(cfb.streams)
  if (kind === 'encrypted') {
    return { ok: false, reason: 'unsupported', error: '文档已加密（带打开密码），请先去除密码后重新导入' }
  }
  if (kind === 'xls') {
    return { ok: false, reason: 'unsupported', error: '这是老式 Excel（.xls / BIFF 格式），暂不支持；请另存为 .xlsx 后重新导入' }
  }
  if (kind === 'ppt') {
    return { ok: false, reason: 'unsupported', error: '这是老式 PowerPoint（.ppt），暂不支持；请另存为 .pptx 后重新导入' }
  }
  if (kind !== 'doc') {
    return { ok: false, reason: 'parse-failed', error: 'CFB 容器里没有 WordDocument 流（不是 Word 文档？）' }
  }

  const word = cfb.streams.get('WordDocument')
  if (!word) return { ok: false, reason: 'parse-failed', error: '缺少 WordDocument 流' }

  const flags = word.readUInt16LE(0x0a)
  if (flags & 0x0100) {
    return { ok: false, reason: 'unsupported', error: '文档已加密（带打开密码），请先去除密码后重新导入' }
  }
  const tableName = flags & 0x0200 ? '1Table' : '0Table'
  const table = cfb.streams.get(tableName) ?? cfb.streams.get('0Table') ?? cfb.streams.get('1Table')
  const fcClx = word.length >= 0x1aa ? word.readUInt32LE(0x01a2) : 0
  const lcbClx = word.length >= 0x1aa ? word.readUInt32LE(0x01a6) : 0

  let raw = ''
  if (table && lcbClx > 0 && fcClx + lcbClx <= table.length) {
    raw = piecesToText(word, parseClx(table.subarray(fcClx, fcClx + lcbClx), word))
  }
  if (!raw.trim()) {
    // 兜底：Word 6/95 或分片表不可用 —— 读 fcMin..fcMac 并猜编码
    raw = bestEffortRange(word)
  }
  const text = normalizeText(filterWordControls(raw))
  if (!text) return { ok: false, reason: 'no-text', error: 'Word 文档里没有可抽取的正文' }
  return { ok: true, text }
}

export interface DocPiece {
  cpStart: number
  cpEnd: number
  /** 文本在 WordDocument 流里的字节偏移（压缩分片已除以 2） */
  fc: number
  compressed: boolean
}

/** 解析 CLX（Prc 序列 + Pcdt）里的 PlcPcd 分片表 */
export function parseClx(clx: Buffer, _word: Buffer): DocPiece[] {
  let i = 0
  while (i < clx.length) {
    const kind = clx[i]
    if (kind === 1) {
      // Prc：跳过（那是样式等二进制块）
      if (i + 3 > clx.length) return []
      const cb = clx.readInt16LE(i + 1)
      i += 3 + Math.max(0, cb)
      continue
    }
    if (kind === 2) {
      if (i + 5 > clx.length) return []
      const lcb = clx.readUInt32LE(i + 1)
      const plc = clx.subarray(i + 5, i + 5 + lcb)
      return parsePlcPcd(plc)
    }
    return []
  }
  return []
}

/** PlcPcd：n+1 个 CP（u32）后跟 n 个 PCD（8 字节） */
export function parsePlcPcd(plc: Buffer): DocPiece[] {
  if (plc.length < 16) return []
  const n = Math.floor((plc.length - 4) / 12)
  if (n <= 0) return []
  const cps: number[] = []
  for (let i = 0; i <= n; i++) cps.push(plc.readUInt32LE(i * 4))
  const pcdBase = (n + 1) * 4
  const pieces: DocPiece[] = []
  for (let i = 0; i < n; i++) {
    const p = pcdBase + i * 8
    if (p + 8 > plc.length) break
    const fcRaw = plc.readUInt32LE(p + 2)
    const compressed = (fcRaw & 0x40000000) !== 0
    const fc = fcRaw & 0x3fffffff
    pieces.push({
      cpStart: cps[i],
      cpEnd: cps[i + 1],
      fc: compressed ? fc >> 1 : fc,
      compressed
    })
  }
  return pieces
}

/** 按分片解码正文（压缩片是 CP1252，未压缩片是 UTF-16LE） */
export function piecesToText(word: Buffer, pieces: DocPiece[]): string {
  let out = ''
  for (const p of pieces) {
    const cch = Math.max(0, p.cpEnd - p.cpStart)
    if (cch === 0) continue
    if (p.compressed) {
      const end = Math.min(p.fc + cch, word.length)
      if (p.fc >= end) continue
      out += decodeCp1252(word.subarray(p.fc, end))
    } else {
      const end = Math.min(p.fc + cch * 2, word.length)
      if (p.fc >= end) continue
      out += word.subarray(p.fc, end).toString('utf16le')
    }
  }
  return out
}

/** 没有分片表时的兜底：取 fcMin..fcMac，哪种解码更像文本就用哪种 */
function bestEffortRange(word: Buffer): string {
  const fcMin = word.readUInt32LE(0x18)
  const fcMac = word.readUInt32LE(0x1c)
  if (fcMin >= fcMac || fcMac > word.length) return ''
  const slice = word.subarray(fcMin, fcMac)
  const utf16 = slice.toString('utf16le')
  const latin = decodeCp1252(slice)
  return scoreText(utf16) >= scoreText(latin) ? utf16 : latin
}

/** 粗略打分：可打印字符与 CJK 加分，替换符/控制字符减分 */
function scoreText(s: string): number {
  let score = 0
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (c === 0xfffd || c === 0) score -= 4
    else if (c >= 0x4e00 && c <= 0x9fff) score += 3
    else if (c >= 0x20 && c < 0x7f) score += 1
    else if (c === 0x0d || c === 0x0a || c === 0x09) score += 1
    else score -= 1
  }
  return score
}

/**
 * Word 的控制字符收拾干净。
 *
 * `0x13 … 0x14` 之间是**域代码**（如 `PAGE \* MERGEFORMAT`），不是正文，必须丢；
 * `0x07` 是单元格/行结束符，落成 Tab 保留表格形状；`0x0B/0x0C` 是换行/分页。
 */
export function filterWordControls(s: string): string {
  let out = ''
  let inField = false
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (c === 0x13) {
      inField = true
      continue
    }
    if (c === 0x14) {
      inField = false
      continue
    }
    if (c === 0x15) continue
    if (inField) continue
    if (c === 0x0d || c === 0x0b || c === 0x0c) out += '\n'
    else if (c === 0x07) out += '\t'
    else if (c === 0x09) out += '\t'
    else if (c === 0x1e || c === 0x1f) out += '-'
    else if (c === 0xa0) out += ' '
    else if (c < 0x20) continue
    else out += ch
  }
  return out
}
