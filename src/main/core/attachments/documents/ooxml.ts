import { readZip, type ZipReadResult } from './zip'
import { collectBlockText, scanXml } from './xmlText'
import { normalizeText } from '../textNormalize'

/**
 * OOXML（docx / xlsx / pptx）与 OpenDocument（odt / ods / odp）文本抽取（v2.1）。
 *
 * 共同点：它们都是 ZIP + XML。抽取策略是「**保文字、保段落边界、简化表格**」：
 * 段落 → 换行，表格单元格 → Tab、行 → 换行，页（幻灯片/工作表）→ 分隔标题。
 * 版式（字号、颜色、图片、批注）一律丢弃 —— 代理要的是「文档说了什么」，
 * 不是「它长什么样」；这一点在工具返回的 note 里也写明了。
 *
 * 为什么不引 `mammoth` / `xlsx` 之类的库：见 zip.ts 的说明（这里只要文字）。
 */

export type DocumentKind = 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'doc' | 'rtf'

export type DocExtractResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-text' | 'parse-failed' | 'unsupported'; error: string }

/** 从一个 ZIP 容器认出这是哪种文档（靠条目名，不靠扩展名） */
export function sniffZipKind(zip: ZipReadResult): DocumentKind | null {
  const names = new Set(zip.names().map((n) => n.toLowerCase()))
  if (names.has('word/document.xml')) return 'docx'
  if (names.has('xl/workbook.xml')) return 'xlsx'
  if (names.has('ppt/presentation.xml')) return 'pptx'
  if (names.has('content.xml') && names.has('mimetype')) {
    const mime = zip.get('mimetype')?.toString('utf8').trim() ?? ''
    if (mime.includes('spreadsheet')) return 'ods'
    if (mime.includes('presentation')) return 'odp'
    return 'odt'
  }
  return null
}

export function extractZipDocument(buf: Buffer, kind: DocumentKind): DocExtractResult {
  const zip = readZip(buf)
  if (!zip.ok) return { ok: false, reason: 'parse-failed', error: zip.error }
  switch (kind) {
    case 'docx':
      return extractDocx(zip)
    case 'xlsx':
      return extractXlsx(zip)
    case 'pptx':
      return extractPptx(zip)
    default:
      return extractOdf(zip, kind)
  }
}

function done(raw: string, what: string): DocExtractResult {
  const text = normalizeText(raw)
  if (!text) return { ok: false, reason: 'no-text', error: `${what}里没有可抽取的文字` }
  return { ok: true, text }
}

// ———————————————————————— Word（docx） ————————————————————————

export function extractDocx(zip: ZipReadResult): DocExtractResult {
  const body = zip.get('word/document.xml')
  if (!body) return { ok: false, reason: 'parse-failed', error: 'docx 缺少 word/document.xml' }
  return done(docxBodyToText(body.toString('utf8')), 'Word 文档')
}

/**
 * 正文 XML → 文本。
 *
 * 段落成行、制表/换行符保留、表格落成 TSV（见 `collectBlockText` 的说明）。
 * `w:instrText`（域代码，如 `PAGE \* MERGEFORMAT`）与 `w:delText`（修订删除的文本）
 * 都不是正文，整段丢弃。
 */
export function docxBodyToText(xml: string): string {
  return collectBlockText(xml, {
    paragraph: new Set(['w:p']),
    cell: new Set(['w:tc']),
    row: new Set(['w:tr']),
    inline: { 'w:tab': '\t', 'w:br': '\n', 'w:cr': '\n' },
    skipScope: new Set(['w:instrText', 'w:delText'])
  })
}

// ———————————————————————— Excel（xlsx） ————————————————————————

export function extractXlsx(zip: ZipReadResult): DocExtractResult {
  const shared = parseSharedStrings(zip.get('xl/sharedStrings.xml')?.toString('utf8') ?? '')
  const sheets = sheetOrder(zip)
  const parts: string[] = []
  sheets.forEach((s, i) => {
    const xml = zip.get(s.path)
    if (!xml) return
    const body = sheetToText(xml.toString('utf8'), shared)
    if (body.trim()) parts.push(`--- ${s.name || `工作表 ${i + 1}`} ---\n${body}`)
  })
  if (parts.length === 0) return { ok: false, reason: 'no-text', error: 'Excel 里没有可抽取的单元格文字' }
  return done(parts.join('\n\n'), 'Excel 工作簿')
}

/** 共享字符串表：`<si>` 一个条目（可能由多个 `<t>` 组成，也含日文注音 rPh 需跳过） */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSi = false
  let phonetic = 0
  scanXml(xml, {
    tag: (name, isClose) => {
      if (name === 'si') {
        if (isClose) {
          out.push(cur)
          cur = ''
          inSi = false
        } else inSi = true
        return
      }
      if (name === 'rPh' || name === 'phoneticPr') phonetic += isClose ? -1 : 1
    },
    text: (t) => {
      if (inSi && phonetic <= 0) cur += t
    }
  })
  return out
}

/** 工作表顺序与名字：workbook.xml 的 sheet 顺序 + rels 映射 rId → 文件路径 */
function sheetOrder(zip: ZipReadResult): Array<{ name: string; path: string }> {
  const wb = zip.get('xl/workbook.xml')?.toString('utf8') ?? ''
  const rels = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  const relMap = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relMap.set(m[1], m[2])
  }
  const out: Array<{ name: string; path: string }> = []
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(m[0])?.[1] ?? ''
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? ''
    const target = relMap.get(rid) ?? ''
    if (!target) continue
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    out.push({ name: decodeXmlAttr(name), path })
  }
  if (out.length > 0) return out
  // 兜底：直接按文件名里的序号取
  return zip
    .names()
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n))
    .sort((a, b) => sheetNo(a) - sheetNo(b))
    .map((p) => ({ name: '', path: p }))
}

function sheetNo(p: string): number {
  return Number(/sheet(\d+)\.xml/i.exec(p)?.[1] ?? 0)
}

function decodeXmlAttr(s: string): string {
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_m, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 工作表 XML → TSV 文本。
 *
 * 用单元格的 `r` 属性（如 `C5`）补足空列：Excel 不写空单元格，
 * 只按出现顺序拼 Tab 会让整张表的列错位 —— 对「读表格」来说是致命的。
 */
export function sheetToText(xml: string, shared: string[]): string {
  let out = ''
  let row = ''
  let col = 0
  let cellType = ''
  let cellRef = ''
  let val = ''
  let collecting = false
  let inline = false

  const flushCell = (): void => {
    let text = val.trim()
    if (cellType === 's') {
      // 共享字符串：`<v>` 里是索引，不是值
      const idx = Number(text)
      text = Number.isFinite(idx) ? (shared[idx] ?? '') : ''
    } else if (cellType === 'b') {
      text = text === '1' ? 'TRUE' : 'FALSE'
    }
    // 补齐被 Excel 省略掉的空列：`r="C5"` 说明它落在第 3 列，前面两列是空的。
    // 少补一列整表就左移（读表最致命的错），多补一列同样错位 —— 所以是 colOf - 1
    while (col < colOf(cellRef) - 1) {
      row += '\t'
      col += 1
    }
    row += text.replace(/[\t\n]+/g, ' ') + '\t'
    col += 1
    val = ''
    collecting = false
    inline = false
    cellType = ''
    cellRef = ''
  }

  scanXml(xml, {
    tag: (name, isClose, attrs) => {
      if (name === 'c') {
        if (isClose) {
          flushCell()
          return
        }
        cellRef = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? ''
        cellType = /t="([^"]+)"/.exec(attrs)?.[1] ?? ''
        val = ''
        return
      }
      if (name === 'v') {
        collecting = !isClose
        return
      }
      if (name === 'is') {
        inline = !isClose
        return
      }
      if (name === 'row' && isClose) {
        const line = row.replace(/\t+$/, '')
        if (line.trim()) out += line + '\n'
        row = ''
        col = 0
        return
      }
    },
    text: (t) => {
      if (!collecting && !inline) return
      val += t
    }
  })
  return out
}

/** 列字母 → 序号（`A`=1，`AA`=27） */
function colOf(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0) - 64
    if (c < 1 || c > 26) continue
    n = n * 26 + c
  }
  return n
}

// ———————————————————————— PowerPoint（pptx） ————————————————————————

export function extractPptx(zip: ZipReadResult): DocExtractResult {
  const slides = zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => slideNo(a) - slideNo(b))
  if (slides.length === 0) return { ok: false, reason: 'parse-failed', error: 'pptx 里没有找到幻灯片' }
  const parts: string[] = []
  slides.forEach((path) => {
    const xml = zip.get(path)
    if (!xml) return
    const body = slideToText(xml.toString('utf8'))
    if (body.trim()) parts.push(`--- 幻灯片 ${slideNo(path)} ---\n${body}`)
  })
  if (parts.length === 0) return { ok: false, reason: 'no-text', error: '幻灯片里没有可抽取的文字' }
  return done(parts.join('\n\n'), '演示文稿')
}

function slideNo(p: string): number {
  return Number(/slide(\d+)\.xml/i.exec(p)?.[1] ?? 0)
}

/** 单页 → 文本：段落换行、制表/换行符保留；注音（a:rPh）不是正文，丢掉 */
export function slideToText(xml: string): string {
  return collectBlockText(xml, {
    paragraph: new Set(['a:p']),
    inline: { 'a:br': '\n', 'a:tab': '\t' },
    skipScope: new Set(['a:rPh'])
  })
}

// ———————————————————————— OpenDocument（odt / ods / odp） ————————————————————————

export function extractOdf(zip: ZipReadResult, kind: DocumentKind): DocExtractResult {
  const content = zip.get('content.xml')
  if (!content) return { ok: false, reason: 'parse-failed', error: 'ODF 缺少 content.xml' }
  return done(odfContentToText(content.toString('utf8')), `ODF 文档（${kind}）`)
}

/**
 * 只取 `office:body` 子树：`content.xml` 前半部分是样式与元数据
 * （字体名、模板名、生成器版本），整篇扫会把它们当正文混进来。
 *
 * 表格与 docx 同一套口径（单元格 → Tab、行 → 换行），共用 `collectBlockText`。
 * `text:s`（连续空格）简化为一个空格 —— 它带 `text:c` 表示个数，这里不做细究。
 */
export function odfContentToText(xml: string): string {
  const start = xml.indexOf('<office:body')
  const end = xml.indexOf('</office:body>')
  const body = start >= 0 && end > start ? xml.slice(start, end) : xml
  return collectBlockText(body, {
    paragraph: new Set(['text:p', 'text:h']),
    cell: new Set(['table:table-cell']),
    row: new Set(['table:table-row', 'table:table']),
    inline: { 'text:line-break': '\n', 'text:tab': '\t', 'text:s': ' ' }
  })
}
