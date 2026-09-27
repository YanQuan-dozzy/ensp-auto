import { readZip } from './zip'
import {
  extractZipDocument,
  sniffZipKind,
  type DocExtractResult,
  type DocumentKind
} from './ooxml'
import { classifyCfb, extractLegacyDoc, readCfb } from './legacyDoc'
import { extractRtf } from './rtf'
import { normalizeText } from '../textNormalize'

/**
 * 文档抽取的总入口（v2.1）：**按内容认格式**，不看扩展名。
 *
 * 认得出并抽得出文字的类型：
 * - `docx` / `xlsx` / `pptx`（OOXML，ZIP+XML）
 * - `odt` / `ods` / `odp`（OpenDocument，同样是 ZIP+XML）
 * - `doc`（Word 97-2003 二进制，CFB 容器 + 分片表）
 * - `rtf`
 * - `pdf`（在 `../pdf.ts`，单独一条路 —— 它不是 ZIP 也不是 CFB）
 *
 * 认得出但明确不支持的：加密文档（OOXML 的密码保护其实是个 CFB 壳，里面是
 * `EncryptionInfo` + `EncryptedPackage`）、老式 `.xls` / `.ppt`（BIFF / 二进制格式，
 * 本轮不做）—— 这些返回可读原因，让上层给出「另存为 .xlsx/.pptx」这类具体建议。
 */

export type { DocumentKind, DocExtractResult } from './ooxml'

const CFB_SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/** 是不是「我们认得、并会尝试抽取」的文档（决定要不要走文档这条路，而不是纯文本路径） */
export function isDocumentBuffer(buf: Buffer): boolean {
  return sniffDocumentKind(buf) !== null
}

/** 认格式；认不出返回 null（调用方应回落到普通文本读取） */
export function sniffDocumentKind(buf: Buffer): DocumentKind | null {
  if (buf.length < 8) return null
  if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const zip = readZip(buf)
    return zip.ok ? sniffZipKind(zip) : null
  }
  if (buf.subarray(0, 8).equals(CFB_SIG)) {
    const cfb = readCfb(buf)
    if (!cfb.ok) return null
    const kind = classifyCfb(cfb.streams)
    if (kind === 'doc' || kind === 'encrypted') return 'doc'
    // .xls / .ppt 也走 doc 这条路去拿结构化原因（见 extractDocumentText）
    return kind === 'xls' || kind === 'ppt' ? 'doc' : null
  }
  if (buf.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf'
  return null
}

/** 抽取正文本体；调用方负责在失败时按 reason 落成错误码 */
export function extractDocumentText(buf: Buffer): DocExtractResult {
  const kind = sniffDocumentKind(buf)
  if (!kind) return { ok: false, reason: 'parse-failed', error: '无法识别的文档格式' }
  if (kind === 'doc') {
    // CFB 只有 Word 与加密文档能读；xls/ppt/加密都由它返回结构化原因
    const r = extractLegacyDoc(buf)
    if (!r.ok) return r
    return r
  }
  if (kind === 'rtf') return extractRtf(buf)
  return extractZipDocument(buf, kind)
}

/** 格式 → 展示名（工具摘要、note 用） */
export const DOC_KIND_LABEL: Record<DocumentKind, string> = {
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PowerPoint',
  odt: 'ODF 文本文档',
  ods: 'ODF 表格',
  odp: 'ODF 演示',
  doc: 'Word（97-2003）',
  rtf: 'RTF'
}

/** 抽取结果统一收敛成「按行文本」（与 read_attachment 的分页口径一致） */
export function documentToLines(text: string): string[] {
  return normalizeText(text).split('\n')
}
