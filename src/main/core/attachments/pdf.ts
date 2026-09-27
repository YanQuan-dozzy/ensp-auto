import zlib from 'node:zlib'
import { decodeCp1252 } from '../charset/cp1252'
import { normalizeText } from './textNormalize'

/**
 * PDF 文本抽取（v2.1，零依赖）。
 *
 * 存在的理由：用户导入的附件里有大量 PDF（实验指导书、作业要求、厂商文档），
 * 而 PDF 是二进制格式 —— 旧实现只会在 `lineReader` 里判出「含 NUL = 二进制」
 * 然后拒绝，代理面对「按这份作业要求设计网络」直接卡死（2026-09-25 实测：
 * read_attachment 返回 BAD_PARAM，模型拿不到任何内容）。
 *
 * 为什么自己写而不是引依赖：
 * - 引 `pdfjs-dist` / `pdf-parse` 是 MB 级依赖，而这里只需要「把文字抠出来」；
 * - 与项目既有取向一致（iconv-lite 换内置 TextDecoder、避开 better-sqlite3）。
 *
 * 支持范围（明说边界，失败时给可读原因而不是静默返回空）：
 * - 经典对象 + 对象流（ObjStm，PDF 1.5 起常见）里的字典；
 * - FlateDecode / ASCIIHexDecode 流，Flate 支持带尾随垃圾（Z_SYNC_FLUSH）；
 * - 字体：Type0(Identity-H) + ToUnicode CMap（CID→Unicode）、简单字体（WinAnsi/标准编码）；
 * - 页树 Catalog→Pages→Kids（拿不到就按对象出现顺序兜底）。
 * **不支持**：加密 PDF（直接报错让用户解密）、扫描件/图片版（无文本可抽）、
 * 少数图像滤镜（DCTDecode 等，那些流里没有文字）。这些情况都返回结构化原因，
 * 由上层转成明确文案，绝不假装成功。
 *
 * 输出口径：按「行」组织（便于 read_attachment 的 offset/limit 分页），
 * 多页之间插入 `--- 第 N 页 ---` 分隔行 —— 版式（分栏、表格、图注位置）会丢失，
 * 这一点在工具返回里也写明了，免得模型把错位的表格当成真实结构。
 */

export type PdfFailureReason = 'not-pdf' | 'encrypted' | 'no-text' | 'parse-failed'

export type PdfExtractResult =
  | { ok: true; text: string; pages: number; /** 因缺少 ToUnicode 映射被丢弃的字符数 */ dropped: number }
  | { ok: false; reason: PdfFailureReason; error: string }

/** 抽取结果上限：够装下一本说明书，同时防止把上下文撑爆 */
const MAX_OUTPUT_CHARS = 2_000_000
/** 单个流解压后的上限（防 zip bomb / 畸形容器） */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024
/** 页数上限（异常文件可能自引用出一堆「页」） */
const MAX_PAGES = 2000
/** 页树递归深度上限 */
const MAX_TREE_DEPTH = 32

export function extractPdfText(buf: Buffer): PdfExtractResult {
  if (buf.length < 8 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { ok: false, reason: 'not-pdf', error: '不是 PDF 文件（缺少 %PDF- 魔数）' }
  }
  // latin1 与字节一一对应，索引可直接当「字节偏移」用 —— PDF 的字典是 ASCII，
  // 而流是二进制，用同一根字符串既能扫结构又能精确切片，省掉一套偏移映射
  const latin = buf.toString('latin1')
  if (/\/Encrypt\b/.test(latin)) {
    return {
      ok: false,
      reason: 'encrypted',
      error: 'PDF 已加密（有打开密码），无法抽取文本；请先解密/去除限制后重新导入'
    }
  }

  let doc: PdfDoc
  try {
    doc = new PdfDoc(latin, buf)
  } catch (e) {
    return { ok: false, reason: 'parse-failed', error: `PDF 结构解析失败：${msg(e)}` }
  }

  try {
    const pages = doc.pageObjects()
    if (pages.length === 0) {
      return { ok: false, reason: 'no-text', error: 'PDF 里没有找到页面对象，无法抽取文本' }
    }
    const blocks: string[] = []
    let dropped = 0
    let chars = 0
    pages.forEach((num, idx) => {
      if (chars >= MAX_OUTPUT_CHARS) return
      const page = doc.pageText(num)
      dropped += page.dropped
      const body = page.text.trim()
      const block = pages.length > 1 ? `--- 第 ${idx + 1} 页 ---\n${body}` : body
      chars += body.length
      if (body) blocks.push(block)
    })
    const text = normalizeText(blocks.join('\n\n')).slice(0, MAX_OUTPUT_CHARS)
    if (!text) {
      return dropped > 0
        ? {
            ok: false,
            reason: 'no-text',
            error:
              'PDF 的字体缺少 Unicode 映射（ToUnicode），文字无法还原；' +
              '常见于扫描件、图片版或经过特殊子集化处理的文档，请提供文字版内容'
          }
        : {
            ok: false,
            reason: 'no-text',
            error: 'PDF 里没有可抽取的文字（大概是扫描件/图片版），请提供文字版或截图'
          }
    }
    return { ok: true, text, pages: pages.length, dropped }
  } catch (e) {
    return { ok: false, reason: 'parse-failed', error: `PDF 文本抽取失败：${msg(e)}` }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ———————————————————————— 文档结构 ————————————————————————

interface RawObj {
  num: number
  /** 对象正文起点（`N G obj` 之后） */
  dict: string
  /** 流数据起点；无流为 null */
  streamStart: number | null
  /** `/Length` 直接是整数时给出（最可靠） */
  streamLength: number | null
  /** `/Length` 是间接引用时的对象号 */
  lengthRef: number | null
}

class PdfDoc {
  private objs = new Map<number, RawObj>()
  /** 惰性解压缓存：同一个流可能被 Resources/Contents 多次引用 */
  private inflated = new Map<number, Buffer | null>()

  constructor(
    private latin: string,
    private buf: Buffer
  ) {
    this.scan()
    this.expandObjectStreams()
  }

  /** 扫出所有 `N G obj` 头；正文切到下一个对象头之前（流的真实边界另由 /Length 或 endstream 定） */
  private scan(): void {
    const re = /(\d+)[ \t]+(\d+)[ \t]+obj\b/g
    const heads: Array<{ num: number; headerStart: number; bodyStart: number }> = []
    let m: RegExpExecArray | null
    while ((m = re.exec(this.latin))) {
      heads.push({ num: Number(m[1]), headerStart: m.index, bodyStart: m.index + m[0].length })
    }
    for (let i = 0; i < heads.length; i++) {
      const end = i + 1 < heads.length ? heads[i + 1].headerStart : this.latin.length
      const body = this.latin.slice(heads[i].bodyStart, end)
      const sm = /(?:^|[^A-Za-z])stream(\r\n|\n|\r)/.exec(body)
      const dict = sm ? body.slice(0, sm.index) : body
      let streamStart: number | null = null
      if (sm) streamStart = heads[i].bodyStart + sm.index + sm[0].length
      const direct = /\/Length\s+(\d+)(?![0-9\s]*\d+\s+R)/.exec(dict)
      const indirect = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict)
      this.objs.set(heads[i].num, {
        num: heads[i].num,
        dict,
        streamStart,
        streamLength: direct ? Number(direct[1]) : null,
        lengthRef: indirect ? Number(indirect[1]) : null
      })
    }
  }

  /**
   * 把对象流（`/Type /ObjStm`）里的对象补进表里。
   *
   * PDF 1.5 起很多生成器（LaTeX/LibreOffice/macOS）会把字典压进对象流，
   * 不展开的话「找不到页面对象」——而那个报错会误导用户以为文件是扫描件。
   * 经典对象优先（键已存在就不覆盖）。
   */
  private expandObjectStreams(): void {
    for (const obj of [...this.objs.values()]) {
      if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue
      const data = this.decodedStream(obj.num)
      if (!data) continue
      const text = data.toString('latin1')
      const n = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1] ?? 0)
      const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1] ?? 0)
      if (!Number.isFinite(n) || !Number.isFinite(first) || n <= 0 || first <= 0 || first > text.length) continue
      const pairs: Array<{ num: number; off: number }> = []
      const header = text.slice(0, first)
      for (const h of header.matchAll(/(\d+)\s+(\d+)/g)) {
        pairs.push({ num: Number(h[1]), off: Number(h[2]) })
        if (pairs.length >= n) break
      }
      for (let i = 0; i < pairs.length; i++) {
        if (this.objs.has(pairs[i].num)) continue
        const from = first + pairs[i].off
        const to = i + 1 < pairs.length ? first + pairs[i + 1].off : text.length
        if (from >= to) continue
        this.objs.set(pairs[i].num, {
          num: pairs[i].num,
          dict: text.slice(from, to),
          streamStart: null,
          streamLength: null,
          lengthRef: null
        })
      }
    }
  }

  dictOf(num: number | null | undefined): string {
    if (num == null) return ''
    return this.objs.get(num)?.dict ?? ''
  }

  /** 取 `/Key 12 0 R` 的对象号 */
  private refIn(dict: string, key: string): number | null {
    const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict)
    return m ? Number(m[1]) : null
  }

  /** 取 `/Key [ 1 0 R 2 0 R ]` 的对象号列表 */
  private refListIn(dict: string, key: string): number[] {
    const m = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(dict)
    if (!m) {
      const one = this.refIn(dict, key)
      return one == null ? [] : [one]
    }
    return [...m[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1]))
  }

  /** 取流数据（未解压） */
  private rawStream(num: number): Buffer | null {
    const o = this.objs.get(num)
    if (!o || o.streamStart == null) return null
    let len = o.streamLength
    if (len == null && o.lengthRef != null) {
      const n = Number.parseInt((this.objs.get(o.lengthRef)?.dict ?? '').trim(), 10)
      if (Number.isFinite(n) && n >= 0) len = n
    }
    const start = o.streamStart
    let end: number
    if (len != null) {
      end = start + len
    } else {
      // 没有可用的 /Length：退到「起点之后的第一个 endstream」，
      // 不依赖对象正文切片（流里出现 "1 0 obj" 这种字节时切片会偏短）
      const idx = this.latin.indexOf('endstream', start)
      if (idx < 0) return null
      end = idx
      // endstream 之前的换行不算数据
      while (end > start && (this.latin[end - 1] === '\n' || this.latin[end - 1] === '\r')) end--
    }
    end = Math.min(end, this.buf.length)
    if (end <= start) return null
    return this.buf.subarray(start, end)
  }

  /** 取流数据并按 /Filter 解码 */
  private decodedStream(num: number): Buffer | null {
    const cached = this.inflated.get(num)
    if (cached !== undefined) return cached
    let out: Buffer | null = null
    const raw = this.rawStream(num)
    if (raw) {
      const dict = this.dictOf(num)
      const filters = filterList(dict)
      out = raw
      for (const f of filters) {
        if (f === 'FlateDecode' || f === 'Fl') {
          out = inflate(out)
        } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
          out = asciiHexDecode(out)
        } else {
          // DCTDecode / JPXDecode 等图像滤镜：流里没有文字，直接放弃
          out = null
        }
        if (!out) break
        if (out.length > MAX_INFLATED_BYTES) {
          out = null
          break
        }
      }
    }
    this.inflated.set(num, out)
    return out
  }

  /** 页对象号（按页序）。Catalog→Pages→Kids 优先，失败则按对象出现顺序兜底 */
  pageObjects(): number[] {
    const out: number[] = []
    const seen = new Set<number>()
    const isPage = (d: string): boolean => /\/Type\s*\/Page(?!s)/.test(d)

    const catalog = [...this.objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict))
    const rootPages = catalog ? this.refIn(catalog.dict, 'Pages') : null
    const walk = (num: number, depth: number): void => {
      if (out.length >= MAX_PAGES || depth > MAX_TREE_DEPTH || seen.has(num)) return
      seen.add(num)
      const d = this.dictOf(num)
      if (!d) return
      if (isPage(d)) {
        out.push(num)
        return
      }
      for (const kid of this.refListIn(d, 'Kids')) walk(kid, depth + 1)
    }
    if (rootPages != null) walk(rootPages, 0)
    if (out.length > 0) return out
    return [...this.objs.values()].filter((o) => isPage(o.dict)).map((o) => o.num)
  }

  /** 取页的 /Resources（缺省沿 /Parent 继承） */
  private resourcesOf(pageNum: number): string {
    let cur: number | null = pageNum
    for (let hop = 0; hop < MAX_TREE_DEPTH && cur != null; hop++) {
      const d = this.dictOf(cur)
      const inline = extractInlineDict(d, 'Resources')
      if (inline) return inline
      const ref = this.refIn(d, 'Resources')
      if (ref != null) return this.dictOf(ref)
      cur = this.refIn(d, 'Parent')
    }
    return ''
  }

  /**
   * 抠一页的文字。
   *
   * 每一步都容错：字体解不出、内容流没有文字，都只是「这页没字」，
   * 而不是整份文件失败 —— 只有全篇都没字才由上层报 no-text。
   */
  pageText(pageNum: number): { text: string; dropped: number } {
    const pageDict = this.dictOf(pageNum)
    const fonts = this.fontDecoders(this.resourcesOf(pageNum))
    const refs = this.refListIn(pageDict, 'Contents')
    let text = ''
    let dropped = 0
    for (const ref of refs) {
      const data = this.decodedStream(ref)
      if (!data) continue
      const r = runContentStream(data.toString('latin1'), fonts)
      text += r.text
      dropped += r.dropped
    }
    return { text, dropped }
  }

  /** 资源字典里的字体 → 解码器（名称如 /F1） */
  private fontDecoders(resDict: string): Map<string, FontDecoder> {
    const out = new Map<string, FontDecoder>()
    const fontDict = extractInlineDict(resDict, 'Font') ?? this.dictOf(this.refIn(resDict, 'Font'))
    if (!fontDict) return out
    for (const m of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const name = m[1]
      const fd = this.dictOf(Number(m[2]))
      out.set(name, this.makeDecoder(fd))
    }
    return out
  }

  /**
   * 单个字体的解码器。
   *
   * 三种情形：
   * 1. 有 ToUnicode（CID 字体几乎必有）→ 用它的映射表，这是唯一可靠的路子；
   * 2. 简单字体（WinAnsi/标准编码）→ 字节直接就是码位（Latin-1 部分）；
   * 3. Type0 且没有 ToUnicode → 映射不可知（CID 是字形索引，不是 Unicode），
   *    选择「丢弃并计数」，让上层给出「字体缺少 Unicode 映射」这种可读原因 ——
   *    比硬凑出乱码把模型带偏要好。
   */
  private makeDecoder(fontDict: string): FontDecoder {
    const subtype = /\/Subtype\s*\/(\w+)/.exec(fontDict)?.[1] ?? ''
    const twoByte = subtype === 'Type0'
    const tuRef = this.refIn(fontDict, 'ToUnicode')
    if (tuRef != null) {
      const data = this.decodedStream(tuRef)
      if (data) {
        const cmap = parseCMap(data.toString('latin1'))
        if (cmap.size > 0) return cmapDecoder(cmap, twoByte)
      }
    }
    if (!twoByte) return simpleFontDecoder(fontDict)
    return { decode: (b) => ({ text: '', dropped: Math.ceil(b.length / 2) }), known: false, wide: true }
  }
}

// ———————————————————————— 字体解码 ————————————————————————

interface FontDecoder {
  decode(bytes: Buffer): { text: string; dropped: number }
  /** 是否识别（false = CID 字体缺 ToUnicode，只能丢弃并计数） */
  known: boolean
  /** 是否 2 字节码（Identity-H 恒为 2 字节；影响内容流里笔位估算的按字数） */
  wide: boolean
}

function cmapDecoder(cmap: Map<number, string>, twoByte: boolean): FontDecoder {
  // 源码可能是 2 字节（Identity-H）或 4 字节（极少数）；以映射表的键最大值判断
  let fourByte = false
  for (const k of cmap.keys()) {
    if (k > 0xffff) {
      fourByte = true
      break
    }
  }
  const step = fourByte ? 4 : twoByte ? 2 : 1
  return {
    known: true,
    wide: step > 1,
    decode: (bytes) => {
      let text = ''
      let dropped = 0
      for (let i = 0; i + step <= bytes.length; i += step) {
        const code =
          step === 1 ? bytes[i] : step === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes.readUInt32BE(i)
        const ch = cmap.get(code)
        if (ch === undefined) dropped++
        else text += ch
      }
      return { text, dropped }
    }
  }
}

function simpleFontDecoder(fontDict: string): FontDecoder {
  // WinAnsiEncoding（或未声明编码的简单字体）的 0x80–0x9F 走 CP1252 —— 与老式
  // Word 的压缩分片共用同一张表（`core/charset/cp1252.ts`），避免两处各抄一份
  const winAnsi = /\/Encoding\s*\/WinAnsiEncoding/.test(fontDict) || !/\/Encoding\s*\//.test(fontDict)
  return {
    known: true,
    wide: false,
    decode: (bytes) => ({
      text: winAnsi ? decodeCp1252(bytes) : Array.from(bytes, (b) => String.fromCharCode(b)).join(''),
      dropped: 0
    })
  }
}

/**
 * 解析 ToUnicode CMap 的 bfchar / bfrange。
 * 值按 UTF-16BE 还原（因此代理对天然可用），多字符映射（连字）也保留原样。
 */
export function parseCMap(text: string): Map<number, string> {
  const map = new Map<number, string>()

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(Number.parseInt(pair[1], 16), hexToUtf16(pair[2]))
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]
    // 形如 <lo> <hi> [<d1> <d2> ...]：逐项列出（优先匹配，避免被下面的通配吃掉）
    const listed = new Set<number>()
    for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = Number.parseInt(r[1], 16)
      const items = [...r[3].matchAll(/<([0-9A-Fa-f]+)>/g)]
      items.forEach((it, i) => {
        map.set(lo + i, hexToUtf16(it[1]))
        listed.add(lo + i)
      })
    }
    // 形如 <lo> <hi> <dst>：dst 末尾码位递增
    for (const r of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = Number.parseInt(r[1], 16)
      const hi = Number.parseInt(r[2], 16)
      const base = hexToBytes(r[3])
      for (let code = lo; code <= hi && code - lo < 65536; code++) {
        if (listed.has(code)) continue
        const next = Buffer.from(base)
        const inc = code - lo
        if (next.length >= 2) {
          const at = next.length - 2
          const v = next.readUInt16BE(at) + inc
          if (v > 0xffff) continue
          next.writeUInt16BE(v, at)
        } else if (next.length === 1) {
          next[0] = (next[0] + inc) & 0xff
        }
        map.set(code, utf16beToString(next))
      }
    }
  }
  return map
}

function hexToBytes(hex: string): Buffer {
  const even = hex.length % 2 === 1 ? `0${hex}` : hex
  return Buffer.from(even, 'hex')
}

function hexToUtf16(hex: string): string {
  return utf16beToString(hexToBytes(hex))
}

/** 大端 UTF-16 字节 → 字符串（代理对按原样还原） */
function utf16beToString(bytes: Buffer): string {
  const copy = bytes.length % 2 === 1 ? Buffer.concat([Buffer.from([0]), bytes]) : Buffer.from(bytes)
  copy.swap16()
  return copy.toString('utf16le')
}

// ———————————————————————— 内容流 ————————————————————————

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: Buffer }
  | { t: 'name'; v: string }
  | { t: 'arr'; v: Tok[] }
  | { t: 'op'; v: string }

/** 垂直位移超过它（文本空间单位）才算换行，而不是同一行内的微调 */
const LINE_TOLERANCE = 0.5
/** 同一行里两段文字之间的空隙超过 0.3 em 就补一个空格 */
const GAP_RATIO = 0.3
/**
 * 刻意**不做**「拉丁词边界」启发式（上一段以字母结尾就补空格）。
 *
 * 试过，结果是负分：生成器会按字体/大小写边界把词切成多段
 * （`Eth-Trunk` → `Eth` + `-Trunk`、`eNSP` → `e` + `NSP`、`300` → `3` + `00`），
 * 而笔位是估算的，**分不清「真实词距」与「估算误差」** —— 补空格就会把
 * 这些词与数字切开（实测把 `300 台` 切成 `3 00 台`）。
 * 纯几何判据（空隙 > 0.3em）虽然会漏掉个别拉丁词间距，但不会破坏词与数字。
 * 中文学位论文/作业这类 CJK 主文档里，段间本来就无需空格，收益远大于损失。
 */
/** 单字节字形的平均宽度（em）：拉丁/数字/标点的经验值，只用来估笔位 */
const NARROW_RATIO = 0.5
/** 空格本身的宽度（em），用于笔位估计 */
const SPACE_RATIO = 0.3

/**
 * 跑一段内容流，抠出绘制出来的文字。
 *
 * 关键点：**不能见到 Td/Tm 就换行**。Word 这类生成器会把一行拆成很多段
 * （中英文混排、样式切换），每段一次 `Td` —— 按操作符换行会把「学校教学区网络
 * 规划与设计」拆成七八行，模型读到的是一地碎片（实测就是这个结果）。
 *
 * 所以这里维护一个极简的「文本矩阵」：
 * - `Td/TD` 按规范是相对**行原点**平移（不是相对笔位），`Tm` 是绝对设置；
 * - 垂直位移 > LINE_TOLERANCE → 才是新的一行；
 * - 同一行内的水平跳跃用「段间距」判断：上一段的估算结束位置到新段起点
 *   超过 0.3 em 就补一个空格。
 *
 * 笔位是**估算**的（没有字体宽度表）：CJK 按 1 em、拉丁按 0.5 em。误差只影响
 * 「要不要补空格」，不会漏字或错字；判断窗口又限定在「上一段」，误差不沿整行累积。
 */
export function runContentStream(
  content: string,
  fonts: Map<string, FontDecoder>
): { text: string; dropped: number } {
  let out = ''
  let dropped = 0
  let font: FontDecoder | null = null
  let twoByte = false
  let size = 12

  // 行矩阵原点（BT 会清零 —— 规范如此）与「上一次真正落笔的基线 y」（跨 BT 保留，
  // 用来判两段文字是不是同一行；Word 常把每段写成独立的 BT…ET 块，见下方 BT 注释）
  let mX = 0
  let mY = 0
  let baseY = Number.NaN
  let runAdvance = 0
  let prevEndX: number | null = null

  let cur: Tok[] = []

  const newline = (): void => {
    if (out && !out.endsWith('\n')) out += '\n'
    runAdvance = 0
    prevEndX = null
  }
  const space = (): void => {
    if (out && !/\s$/.test(out)) out += ' '
    runAdvance += size * SPACE_RATIO
    prevEndX = mX + runAdvance
  }
  const emit = (bytes: Buffer | null): void => {
    if (!bytes || bytes.length === 0) return
    const dec = font ? font.decode(bytes) : { text: '', dropped: bytes.length }
    dropped += dec.dropped
    if (dec.text) out += dec.text
    const glyphs = twoByte ? Math.ceil(bytes.length / 2) : bytes.length
    runAdvance += glyphs * size * (twoByte ? 1 : NARROW_RATIO)
    prevEndX = mX + runAdvance
  }

  for (const tok of tokenize(content)) {
    if (tok.t !== 'op') {
      cur.push(tok)
      continue
    }
    switch (tok.v) {
      case 'Tf': {
        const name = cur.find((x) => x.t === 'name')
        font = name && name.t === 'name' ? (fonts.get(name.v) ?? null) : null
        const nums = cur.filter((x) => x.t === 'num')
        if (nums.length > 0) {
          const s = nums[nums.length - 1].v
          if (s > 0 && s < 400) size = s
        }
        twoByte = font?.wide ?? false
        break
      }
      case 'Tj': {
        emit(firstBytes(cur))
        break
      }
      case 'TJ': {
        const arr = cur.find((x) => x.t === 'arr')
        if (arr && arr.t === 'arr') {
          for (const el of arr.v) {
            if (el.t === 'num') {
              // 数字是字形间距（1/1000 em）。字偶调整通常 < 100，词间距远大于此：
              // 补一个空格，宁可多也不能把两个词粘成一个拼不出的词
              if (el.v <= -150) space()
            } else if (el.t === 'str') {
              emit(el.v)
            }
          }
        }
        break
      }
      case "'":
      case '"': {
        newline()
        emit(firstBytes(cur))
        break
      }
      case 'Td':
      case 'TD':
      case 'Tm': {
        const nums = cur.filter((x) => x.t === 'num')
        let nx: number
        let ny: number
        if (tok.v === 'Tm') {
          if (nums.length < 6) break
          nx = nums[4].v
          ny = nums[5].v
        } else {
          if (nums.length < 2) break
          nx = mX + nums[nums.length - 2].v
          ny = mY + nums[nums.length - 1].v
        }
        // 先判换行，再决定要不要补空格 —— 换行时 X 没有可比性
        if (!Number.isFinite(baseY) || Math.abs(ny - baseY) > LINE_TOLERANCE) {
          newline()
        } else if (prevEndX !== null && nx - prevEndX > GAP_RATIO * size) {
          space()
        }
        mX = nx
        mY = ny
        baseY = ny
        runAdvance = 0
        break
      }
      case 'T*': {
        newline()
        mY -= size * 1.2
        baseY = mY
        break
      }
      case 'BT': {
        // 刻意**不**换行：Word/ WPS 会把同一行的每一段写成独立的 BT…ET，
        // 见到 BT 就断行会把一句话拆成一地碎片（实测过）。换行只由上面的 y 比较决定。
        mX = 0
        mY = 0
        runAdvance = 0
        break
      }
      case 'ET': {
        runAdvance = 0
        break
      }
      default:
        break
    }
    cur = []
  }
  return { text: out, dropped }
}

/** 操作数里最后一个字符串（Tj / ' / " 都只吃一个字符串） */
function firstBytes(operands: Tok[]): Buffer | null {
  for (let i = operands.length - 1; i >= 0; i--) {
    const o = operands[i]
    if (o.t === 'str') return o.v
  }
  return null
}

const WS = new Set([' ', '\t', '\r', '\n', '\f', '\0'])
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])

function isDelimOrWs(ch: string): boolean {
  return WS.has(ch) || DELIM.has(ch)
}

export function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (WS.has(c)) {
      i++
      continue
    }
    if (c === '%') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++
      continue
    }
    if (c === '(') {
      const r = readLiteralString(src, i)
      out.push({ t: 'str', v: r.bytes })
      i = r.next
      continue
    }
    if (c === '<') {
      if (src[i + 1] === '<') {
        i = skipDict(src, i)
        continue
      }
      const end = src.indexOf('>', i + 1)
      if (end < 0) break
      out.push({ t: 'str', v: hexToBytes(src.slice(i + 1, end)) })
      i = end + 1
      continue
    }
    if (c === '>') {
      i++
      continue
    }
    if (c === '[') {
      const r = readArray(src, i + 1)
      out.push({ t: 'arr', v: r.items })
      i = r.next
      continue
    }
    if (c === ']' || c === '{' || c === '}') {
      i++
      continue
    }
    if (c === '/') {
      let j = i + 1
      while (j < src.length && !isDelimOrWs(src[j])) j++
      out.push({ t: 'name', v: src.slice(i + 1, j) })
      i = j
      continue
    }
    let j = i
    while (j < src.length && !isDelimOrWs(src[j])) j++
    const word = src.slice(i, j)
    if (j === i) {
      i++
      continue
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) out.push({ t: 'num', v: Number(word) })
    else out.push({ t: 'op', v: word })
    i = j
  }
  return out
}

function readArray(src: string, from: number): { items: Tok[]; next: number } {
  const items: Tok[] = []
  let i = from
  while (i < src.length) {
    const c = src[i]
    if (WS.has(c)) {
      i++
      continue
    }
    if (c === ']') return { items, next: i + 1 }
    if (c === '(') {
      const r = readLiteralString(src, i)
      items.push({ t: 'str', v: r.bytes })
      i = r.next
      continue
    }
    if (c === '<') {
      const end = src.indexOf('>', i + 1)
      if (end < 0) return { items, next: src.length }
      items.push({ t: 'str', v: hexToBytes(src.slice(i + 1, end)) })
      i = end + 1
      continue
    }
    if (c === '[') {
      const r = readArray(src, i + 1)
      items.push({ t: 'arr', v: r.items })
      i = r.next
      continue
    }
    if (c === '/') {
      let j = i + 1
      while (j < src.length && !isDelimOrWs(src[j])) j++
      items.push({ t: 'name', v: src.slice(i + 1, j) })
      i = j
      continue
    }
    if (DELIM.has(c)) {
      i++
      continue
    }
    let j = i
    while (j < src.length && !isDelimOrWs(src[j])) j++
    const word = src.slice(i, j)
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) items.push({ t: 'num', v: Number(word) })
    else items.push({ t: 'op', v: word })
    i = j
  }
  return { items, next: i }
}

/** 读 `(` 起头的字面字符串（处理转义与嵌套括号），返回字节与下一个扫描位置 */
export function readLiteralString(src: string, from: number): { bytes: Buffer; next: number } {
  const out: number[] = []
  let depth = 1
  let i = from + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      const nx = src[i + 1] ?? ''
      if (nx === 'n') {
        out.push(10)
        i += 2
      } else if (nx === 'r') {
        out.push(13)
        i += 2
      } else if (nx === 't') {
        out.push(9)
        i += 2
      } else if (nx === 'b') {
        out.push(8)
        i += 2
      } else if (nx === 'f') {
        out.push(12)
        i += 2
      } else if (nx === '(' || nx === ')' || nx === '\\') {
        out.push(nx.charCodeAt(0))
        i += 2
      } else if (nx >= '0' && nx <= '7') {
        let oct = ''
        let k = i + 1
        while (k < src.length && oct.length < 3 && src[k] >= '0' && src[k] <= '7') oct += src[k++]
        out.push(Number.parseInt(oct, 8) & 0xff)
        i = k
      } else if (nx === '\n') {
        i += 2
      } else if (nx === '\r') {
        i += src[i + 2] === '\n' ? 3 : 2
      } else if (nx === '') {
        i++
      } else {
        out.push(nx.charCodeAt(0) & 0xff)
        i += 2
      }
      continue
    }
    if (ch === '(') {
      depth++
      out.push(0x28)
      i++
      continue
    }
    if (ch === ')') {
      depth--
      i++
      if (depth === 0) break
      out.push(0x29)
      continue
    }
    // latin1 字符串：charCode 就是字节
    out.push(ch.charCodeAt(0) & 0xff)
    i++
  }
  return { bytes: Buffer.from(out), next: i }
}

/** 跳过 `<< ... >>`（含嵌套与字符串里的 `>>`） */
export function skipDict(src: string, from: number): number {
  let depth = 0
  let i = from
  while (i < src.length) {
    if (src.startsWith('<<', i)) {
      depth++
      i += 2
      continue
    }
    if (src.startsWith('>>', i)) {
      depth--
      i += 2
      if (depth <= 0) break
      continue
    }
    if (src[i] === '(') {
      i = readLiteralString(src, i).next
      continue
    }
    i++
  }
  return i
}

// ———————————————————————— 小工具 ————————————————————————

/** 取 `/Key << ... >>` 的内联字典内容（不含外层尖括号） */
export function extractInlineDict(dict: string, key: string): string | null {
  const m = new RegExp(`/${key}\\s*<<`).exec(dict)
  if (!m) return null
  const start = m.index + m[0].length
  const end = skipDict(dict, start - 2)
  if (end <= start) return null
  return dict.slice(start, end - 2)
}

function filterList(dict: string): string[] {
  const arr = /\/Filter\s*\[([^\]]*)\]/.exec(dict)
  if (arr) return [...arr[1].matchAll(/\/(\w+)/g)].map((m) => m[1])
  const one = /\/Filter\s*\/(\w+)/.exec(dict)
  return one ? [one[1]] : []
}

/**
 * 解 Flate。用 Z_SYNC_FLUSH 作 finishFlush —— PDF 里 deflate 流后面常带填充字节，
 * 严格模式下会直接抛「unexpected end of file」，而这里只要内容。
 */
function inflate(data: Buffer): Buffer | null {
  try {
    return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
  } catch {
    try {
      return zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    } catch {
      return null
    }
  }
}

function asciiHexDecode(data: Buffer): Buffer {
  const s = data.toString('latin1')
  const end = s.indexOf('>')
  const hex = (end >= 0 ? s.slice(0, end) : s).replace(/[^0-9A-Fa-f]/g, '')
  return hexToBytes(hex)
}

// 行文本收敛与 Office / RTF 抽取共用（`attachments/textNormalize.ts`），此处保留出口
export { normalizeText } from './textNormalize'
