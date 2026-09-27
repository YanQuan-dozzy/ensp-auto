/**
 * XML 扫描与文本化（v2.1，供 OOXML / ODF 抽取用）。
 *
 * 只做一件事：把 XML 拆成「标签」与「文本」两类事件，交给调用方决定怎么落成文本。
 * 刻意不引 XML 解析器 —— 这些文档要的只是文字顺序与段落边界，
 * 而树化解析反而会引入「命名空间/实体/编码」一堆与本任务无关的复杂度。
 */

export interface XmlHandlers {
  /** 每个标签一次；name 已去掉属性与首尾斜杠（如 `w:p`、`w:br`），大小写保留 */
  tag?: (name: string, isClose: boolean, attrs: string) => void
  /** 标签之间的文本（已做实体反转义） */
  text?: (text: string) => void
}

/** 逐个标签地扫过去；`<![CDATA[...]]>` 按文本处理，注释/声明直接跳过 */
export function scanXml(xml: string, on: XmlHandlers): void {
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) {
      if (on.text && i < xml.length) on.text(decodeXmlEntities(xml.slice(i)))
      return
    }
    if (lt > i && on.text) on.text(decodeXmlEntities(xml.slice(i, lt)))
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      const stop = end < 0 ? xml.length : end
      if (on.text) on.text(xml.slice(lt + 9, stop))
      i = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      i = end < 0 ? xml.length : end + 3
      continue
    }
    const gt = xml.indexOf('>', lt)
    if (gt < 0) return
    const full = xml.slice(lt, gt + 1)
    if (full.startsWith('<?') || full.startsWith('<!')) {
      i = gt + 1
      continue
    }
    let inner = full.slice(1, -1).trim()
    const isClose = inner.startsWith('/')
    if (isClose) inner = inner.slice(1).trim()
    // 自闭合：`w:br/` → 去掉尾斜杠后按 open 处理（调用方只看 name）
    inner = inner.replace(/\/\s*$/, '')
    const sp = inner.search(/[\s>]/)
    const name = sp < 0 ? inner : inner.slice(0, sp)
    const attrs = sp < 0 ? '' : inner.slice(sp).trim()
    if (name) on.tag?.(name, isClose, attrs)
    i = gt + 1
  }
}

/** 实体反转义（含数字实体；`&#x` 与 `&#` 两种写法） */
export function decodeXmlEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_m, h: string) => codePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => codePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&')
}

/** 码位 → 字符串（越界或非法码位返回空，别让一个坏实体炸掉整份文档） */
function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

/** 标签名 → 替换文本（同时作用于开闭标签，如 `w:p` 命中 `<w:p>` 与 `</w:p>`） */
export type XmlTextRules = Record<string, string>

/** 通用 XML → 文本：命中规则的标签换成规则里的文本，其余标签丢弃，标签间文本原样保留 */
export function xmlToText(xml: string, rules: XmlTextRules): string {
  let out = ''
  scanXml(xml, {
    tag: (name) => {
      const r = rules[name]
      if (r) out += r
    },
    text: (t) => {
      out += t
    }
  })
  return out
}

export interface BlockTextOptions {
  /** 段落标签（结束一个段落 → 换行；单元格内则降级为空格） */
  paragraph: ReadonlySet<string>
  /** 单元格标签：其中的段落不断行，单元格结束时补 Tab */
  cell?: ReadonlySet<string>
  /** 表格行标签：结束时补换行 */
  row?: ReadonlySet<string>
  /** 开标签 → 立即输出的文本（如 `w:br` → 换行、`a:tab` → 制表） */
  inline?: Record<string, string>
  /** 这些标签包裹的内容整段丢弃（域代码、修订删除文本、注音等不是正文） */
  skipScope?: ReadonlySet<string>
}

/**
 * 「段落 / 单元格感知」的文本收集器（docx 与 ODF 共用一份状态机）。
 *
 * 为什么必须区分单元格：Word 与 ODF 的每个表格单元格里至少有一个段落，
 * 若一律「段落 → 换行」，一行表格就会被炸成「每格一行」，行列关系彻底丢失。
 * 这里的规则是：单元格内段落降级为空格、单元格结束补 Tab、行结束补换行 ——
 * 表格于是落成 TSV，人和模型都还能看出结构。
 */
export function collectBlockText(xml: string, opts: BlockTextOptions): string {
  let out = ''
  let cellBuf = ''
  let cellDepth = 0
  let skip = 0
  const push = (s: string): void => {
    if (!s) return
    if (cellDepth > 0) cellBuf += s
    else out += s
  }
  const endParagraph = (): void => {
    if (cellDepth > 0) {
      if (cellBuf && !cellBuf.endsWith(' ')) cellBuf += ' '
    } else if (out && !out.endsWith('\n')) {
      out += '\n'
    }
  }

  scanXml(xml, {
    tag: (name, isClose) => {
      if (opts.skipScope?.has(name)) {
        skip += isClose ? -1 : 1
        return
      }
      const inlineText = opts.inline?.[name]
      if (inlineText && !isClose) push(inlineText)
      if (opts.cell?.has(name)) {
        if (isClose) {
          cellDepth = Math.max(0, cellDepth - 1)
          if (cellDepth === 0) {
            out += cellBuf.trim() + '\t'
            cellBuf = ''
          } else {
            cellBuf += '\t'
          }
        } else {
          cellDepth += 1
        }
        return
      }
      if (opts.paragraph.has(name) && isClose) endParagraph()
      else if (opts.row?.has(name) && isClose) endParagraph()
    },
    text: (t) => {
      if (skip <= 0) push(t)
    }
  })
  if (cellBuf) out += cellBuf
  return out
}
