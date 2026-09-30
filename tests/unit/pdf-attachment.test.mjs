import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  AttachmentStore,
  extractPdfText,
  parseCMap,
  buildAttachmentBlock,
  kindLabel
} from '../.build/harness.mjs'

/**
 * v2.1：PDF 附件读取。
 *
 * 背景：用户导入作业要求 PDF，模型调 read_attachment 只能拿到 BAD_PARAM ——
 * 旧实现把 PDF 当二进制直接拒了。现在走核心自己的抽取器（零依赖），
 * 这些用例钉住三件事：
 * 1. 抽取本身对不对（中文 ToUnicode、拉丁 WinAnsi、对象流、多页、换行与间距）；
 * 2. 失败必须**说清原因**（加密 / 扫描件 / 字体缺映射 / 不是 PDF），且码不再是 BAD_PARAM；
 * 3. 接进 AttachmentStore 后仍守既有分页契约（offset/limit、截断标记）。
 *
 * 测试用的 PDF 手写构造：解析器不依赖 xref，所以这里也不生成 xref（真实文件里
 * 那些是给别的阅读器用的）。流一律用 zlib.deflateSync 压成 FlateDecode。
 */

// ———————————————————— 造 PDF ————————————————————

function obj(num, body) {
  return `${num} 0 obj\n${body}\nendobj\n`
}

function streamObj(num, dict, raw) {
  const data = zlib.deflateSync(Buffer.from(raw, 'latin1'))
  // 必须用 Buffer.concat 拼流数据：`string + Buffer` 会走 Buffer.toString()（UTF-8），
  // 二进制会当场被替换成 U+FFFD，后面 inflate 必然失败（踩过一次）
  return Buffer.concat([
    Buffer.from(
      `${num} 0 obj\n<< ${dict} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`,
      'latin1'
    ),
    data,
    Buffer.from('\nendstream\nendobj\n', 'latin1')
  ])
}

/** 把若干片段拼成 PDF 字节（片段可以是 string 或 Buffer） */
function pdf(...parts) {
  const head = Buffer.from('%PDF-1.5\n%\xa1\xb3\xc5\xd7\n', 'latin1')
  const body = parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1')))
  return Buffer.concat([head, ...body, Buffer.from('%%EOF\n', 'latin1')])
}

/** 单页 + 简单字体（WinAnsi）的最小 PDF */
function simplePdf(contentStream) {
  return pdf(
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    obj(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
        '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
    ),
    obj(4, '<< /Type /Font /Subtype /TrueType /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    streamObj(5, '', contentStream)
  )
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ensp-pdf-${tag}-`))
}

// ———————————————————— 抽取本身 ————————————————————

test('PDF 抽取：拉丁文本按 WinAnsi 还原，同一行的多段按间距补空格、跨行断行', () => {
  // 第 1、2 段同在 y=700（Word 风格：每段一个 BT…ET 块，段间有真实空隙），第 3 段换行
  const content =
    'BT /F1 12 Tf 1 0 0 1 72 700 Tm (Hello) Tj ET\n' +
    'BT /F1 12 Tf 1 0 0 1 140 700 Tm (World) Tj ET\n' +
    'BT /F1 12 Tf 1 0 0 1 72 680 Tm (second line) Tj ET\n' +
    'BT /F1 12 Tf 1 0 0 1 72 660 Tm (esc: \\(a\\) \\011 tab) Tj ET'
  const r = extractPdfText(simplePdf(content))
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  assert.equal(r.pages, 1)
  assert.equal(r.text, 'Hello World\nsecond line\nesc: (a) \t tab')
})

test('PDF 抽取：紧挨着的两段不补空格（避免把 Eth-Trunk / 300 这类词切开）', () => {
  // 生成器常在字体/大小写边界分段；间距小于阈值时必须原样拼接，
  // 这个用例是「不要再加拉丁词边界启发式」的回归守卫（加过，实测把 300 切成 3 00）
  const content =
    'BT /F1 12 Tf 1 0 0 1 72 700 Tm (Eth) Tj ET\n' +
    'BT /F1 12 Tf 1 0 0 1 90 700 Tm (-Trunk) Tj ET\n' +
    'BT /F1 12 Tf 1 0 0 1 72 680 Tm (3) Tj ET\n' +
    'BT /F1 12 Tf 1 0 0 1 77 680 Tm (00) Tj ET'
  const r = extractPdfText(simplePdf(content))
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  assert.equal(r.text, 'Eth-Trunk\n300')
})

test('PDF 抽取：Type0/Identity-H + ToUnicode 的中文（含 bfchar 与 bfrange）', () => {
  const content =
    'BT /F2 12 Tf 1 0 0 1 72 700 Tm <00010002> Tj ET\n' +
    'BT /F2 12 Tf 1 0 0 1 72 680 Tm <001000110012> Tj ET'
  const cmap =
    '/CIDInit /ProcSet findresource begin\n' +
    '4 beginbfchar\n<0001> <4F5C>\n<0002> <4E1A>\nendbfchar\n' +
    '3 beginbfrange\n<0010> <0012> <0041>\nendbfrange\nend'
  const bytes = pdf(
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    obj(
      3,
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 4 0 R >> >> /Contents 5 0 R >>'
    ),
    obj(
      4,
      '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H ' +
        '/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'
    ),
    streamObj(5, '', content),
    obj(6, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun >>'),
    streamObj(7, '', cmap)
  )
  const r = extractPdfText(bytes)
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  assert.equal(r.text, '作业\nABC')
  assert.equal(r.dropped, 0)
})

test('PDF 抽取：对象流（ObjStm）里的字典也能找到（PDF 1.5 常见布局）', () => {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /TrueType /Encoding /WinAnsiEncoding >>'
  ]
  const nums = [1, 2, 3, 4]
  const offsets = []
  let acc = ''
  for (const b of bodies) {
    offsets.push(acc.length)
    acc += b + ' '
  }
  const header = nums.map((n, i) => `${n} ${offsets[i]}`).join(' ') + ' '
  const first = header.length
  const objStmBody = header + acc
  const payload = zlib.deflateSync(Buffer.from(objStmBody, 'latin1'))
  const bytes = pdf(
    Buffer.concat([
      Buffer.from(
        `9 0 obj\n<< /Type /ObjStm /N 4 /First ${first} /Length ${payload.length} /Filter /FlateDecode >>\nstream\n`,
        'latin1'
      ),
      payload,
      Buffer.from('\nendstream\nendobj\n', 'latin1')
    ]),
    streamObj(5, '', 'BT /F1 12 Tf 1 0 0 1 72 700 Tm (from ObjStm) Tj ET')
  )
  const r = extractPdfText(bytes)
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  assert.equal(r.text, 'from ObjStm')
})

test('PDF 抽取：多页之间插入页码分隔行', () => {
  const page = (num) =>
    obj(
      num,
      `<< /Type /Page /Parent 9 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents ${num + 100} 0 R >>`
    )
  const bytes = pdf(
    obj(1, '<< /Type /Catalog /Pages 9 0 R >>'),
    obj(9, '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>'),
    obj(4, '<< /Type /Font /Subtype /TrueType /Encoding /WinAnsiEncoding >>'),
    page(2),
    page(3),
    streamObj(102, '', 'BT /F1 12 Tf 1 0 0 1 72 700 Tm (page one) Tj ET'),
    streamObj(103, '', 'BT /F1 12 Tf 1 0 0 1 72 700 Tm (page two) Tj ET')
  )
  const r = extractPdfText(bytes)
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  assert.equal(r.pages, 2)
  assert.equal(r.text, '--- 第 1 页 ---\npage one\n\n--- 第 2 页 ---\npage two')
})

test('PDF 抽取失败：加密 / 扫描件（无可抽取文字）/ 字体缺 ToUnicode，都给出可读原因', () => {
  const empty = extractPdfText(pdf(obj(1, '<< /Type /Catalog /Pages 2 0 R >>'), obj(2, '<< /Type /Pages /Kids [] /Count 0 >>')))
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, 'no-text')

  const encrypted = extractPdfText(
    pdf(
      obj(1, '<< /Type /Catalog /Pages 2 0 R >>'),
      obj(9, '<< /Filter /Standard /V 2 /R 3 >>'),
      'trailer\n<< /Size 10 /Root 1 0 R /Encrypt 9 0 R >>\n'
    )
  )
  assert.equal(encrypted.ok, false)
  assert.equal(encrypted.reason, 'encrypted')
  assert.match(encrypted.error, /加密/)

  // Type0 但没有 ToUnicode：映射不可知 → 丢弃并计数，报「字体缺映射」
  const noMap = extractPdfText(
    pdf(
      obj(1, '<< /Type /Catalog /Pages 2 0 R >>'),
      obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      obj(3, '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 4 0 R >> >> /Contents 5 0 R >>'),
      obj(4, '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H >>'),
      streamObj(5, '', 'BT /F2 12 Tf 1 0 0 1 72 700 Tm <00010002> Tj ET')
    )
  )
  assert.equal(noMap.ok, false)
  assert.equal(noMap.reason, 'no-text')
  assert.match(noMap.error, /Unicode 映射/)

  assert.equal(extractPdfText(Buffer.from('not a pdf at all')).reason, 'not-pdf')
})

test('parseCMap：bfchar / bfrange / 多字符映射（连字）', () => {
  const map = parseCMap(
    'beginbfchar\n<01> <0066006C>\n<02> <4F60>\nendbfchar\n' +
      'beginbfrange\n<10> <11> <0030>\n<20> <21> [<0041> <0042>]\nendbfrange'
  )
  assert.equal(map.get(0x01), 'fl')
  assert.equal(map.get(0x02), '你')
  assert.equal(map.get(0x10), '0')
  assert.equal(map.get(0x11), '1')
  assert.equal(map.get(0x20), 'A')
  assert.equal(map.get(0x21), 'B')
})

// ———————————————————— 接进 AttachmentStore ————————————————————

test('AttachmentStore.readText：PDF 按行分页，返回 format=pdf 与抽取口径说明', async () => {
  const dir = tmpDir('pdfstore')
  const store = new AttachmentStore(dir)
  // 每行一个 BT…ET（真实生成器的写法）：同一 y 的两段会并成一行，这里刻意每行各自换 y
  const content = Array.from(
    { length: 60 },
    (_, i) => `BT /F1 12 Tf 1 0 0 1 72 ${700 - i * 14} Tm (line ${i}) Tj ET`
  ).join('\n')
  const src = path.join(dir, '要求.pdf')
  fs.writeFileSync(src, simplePdf(content))

  const imported = await store.import('s1', [src])
  assert.equal(imported.attachments.length, 1)
  const archived = imported.attachments[0].path
  assert.equal(imported.attachments[0].kind, 'binary', 'PDF 仍归类为二进制（不参与内联预览）')

  const all = await store.readText(archived, 0, 400)
  assert.equal(all.ok, true)
  assert.equal(all.format, 'pdf')
  assert.equal(all.encoding, 'utf8')
  assert.equal(all.totalLines, 60)
  assert.match(all.note, /PDF 自动抽取/)
  assert.equal(all.text.split('\n')[0], 'line 0')

  const page = await store.readText(archived, 10, 2)
  assert.equal(page.text, 'line 10\nline 11')
  assert.equal(page.from, 10)
  assert.equal(page.to, 12)
  assert.equal(page.truncated, true)

  const tail = await store.readText(archived, 59, 10)
  assert.equal(tail.text, 'line 59')
  assert.equal(tail.truncated, false)

  // 第二遍走缓存（同一份文件不应重复抽取）：结果必须逐字一致
  const again = await store.readText(archived, 10, 2)
  assert.deepEqual(
    { text: again.text, totalLines: again.totalLines },
    { text: page.text, totalLines: page.totalLines }
  )

  fs.rmSync(dir, { recursive: true, force: true })
})

// ——————————————————————————————————————————————————————————————
// M5（PERF-MEM-REVIEW-2026-09-29 §4.1）：docCache 的 LRU + 字节预算 + 换目录清理
// ——————————————————————————————————————————————————————————————

/** 造一份 PDF，正文共 `lines` 行（每行内容可控长度） */
function pdfWithLines(lines, pad = 0) {
  const content = Array.from(
    { length: lines },
    (_, i) => `BT /F1 12 Tf 1 0 0 1 72 ${700 - i * 14} Tm (${'x'.repeat(pad)}${i}) Tj ET`
  ).join('\n')
  return simplePdf(content)
}

test('M5：缓存是 LRU —— 命中过的文档翻回来仍在缓存里（FIFO 会被挤掉重抽）', async () => {
  const dir = tmpDir('doclru')
  const store = new AttachmentStore(dir)

  const files = []
  for (let i = 0; i < 4; i++) {
    const src = path.join(dir, `doc${i}.pdf`)
    fs.writeFileSync(src, pdfWithLines(5))
    const imported = await store.import('s1', [src])
    files.push(imported.attachments[0].path)
  }

  // 先把 4 份都读一遍填满缓存，再回头读第 1 份（把它提到队尾）
  for (const f of files) await store.readText(f, 0, 10)
  assert.equal(store.docCacheStats().entries, 4)
  await store.readText(files[0], 0, 10)
  // 再读一份新的（第 5 份）触发淘汰 —— 被淘汰的应是「最久未用」的那份，
  // 也就是 files[1]，而刚命中的 files[0] 必须留下
  const extra = path.join(dir, 'doc-extra.pdf')
  fs.writeFileSync(extra, pdfWithLines(5))
  const imp = await store.import('s1', [extra])
  await store.readText(imp.attachments[0].path, 0, 10)

  assert.ok(store.docCacheStats().entries <= 4, '条目数超上限')
  // 仍然能正确读出内容（淘汰只影响性能，不影响正确性）
  const back = await store.readText(files[0], 0, 10)
  assert.equal(back.ok, true)
  assert.equal(back.text.split('\n')[0], '0')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('M5：总字符预算必须封顶（4 份 200 万字符 ≈ 16MB 常驻）', async () => {
  const dir = tmpDir('docbudget')
  const store = new AttachmentStore(dir)

  // 每份约 6 万字符 × 4 份 = 24 万 → 低于 50 万预算，应全留
  for (let i = 0; i < 4; i++) {
    const src = path.join(dir, `big${i}.pdf`)
    fs.writeFileSync(src, pdfWithLines(30, 2000))
    const imported = await store.import('s1', [src])
    await store.readText(imported.attachments[0].path, 0, 5)
  }
  const st = store.docCacheStats()
  assert.ok(st.chars <= 500_000, `字符预算超了：${st.chars}`)
  assert.ok(st.chars > 0, '缓存没生效（characters 记账为 0）')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('M5：setRootDir 必须清缓存（旧目录的大文档不该继续驻留）', async () => {
  const dir = tmpDir('docroot')
  const store = new AttachmentStore(dir)
  const src = path.join(dir, 'a.pdf')
  fs.writeFileSync(src, pdfWithLines(5))
  const imported = await store.import('s1', [src])
  await store.readText(imported.attachments[0].path, 0, 10)
  assert.ok(store.docCacheStats().entries > 0)

  store.setRootDir(path.join(dir, 'other'))
  assert.equal(store.docCacheStats().entries, 0, 'setRootDir 没有清缓存')
  assert.equal(store.docCacheStats().chars, 0, '字符记账没有归零')
  // 同一个目录再设一次不应白清（幂等）
  store.setRootDir(path.join(dir, 'other'))
  assert.equal(store.docCacheStats().entries, 0)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('M5：失败结果不进缓存（否则会把有用的成功结果挤走）', async () => {
  const dir = tmpDir('docfail')
  const store = new AttachmentStore(dir)
  // 加密 PDF：抽取必然失败
  const enc = pdf(obj(1, '<< /Type /Catalog /Pages 2 0 R >>'), obj(2, '<< /Type /Pages >>'), 'trailer\n<< /Encrypt 9 0 R >>\n')
  const src = path.join(dir, 'enc.pdf')
  fs.writeFileSync(src, enc)
  const imported = await store.import('s1', [src])
  const r = await store.readText(imported.attachments[0].path, 0, 10)
  assert.equal(r.ok, false)
  assert.equal(store.docCacheStats().entries, 0, '失败结果被缓存了')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('AttachmentStore.readText：非文档二进制报 NOT_TEXT 且给出处置建议（不再一律 BAD_PARAM）', async () => {
  const dir = tmpDir('binstore')
  const store = new AttachmentStore(dir)
  // 普通压缩包（不是 Office 文档）：走文本路径被拒，提示要具体
  const src = path.join(dir, 'pkg.zip')
  fs.writeFileSync(src, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x41]))

  const imported = await store.import('s1', [src])
  const r = await store.readText(imported.attachments[0].path, 0, 10)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NOT_TEXT')
  assert.match(r.error, /二进制/)
  assert.match(r.error, /解压/)

  // 加密 PDF：码要区分开，代理才知道是「解密」而不是「参数错」
  const encSrc = path.join(dir, 'locked.pdf')
  fs.writeFileSync(
    encSrc,
    pdf(
      obj(1, '<< /Type /Catalog /Pages 2 0 R >>'),
      obj(9, '<< /Filter /Standard /V 1 >>'),
      'trailer\n<< /Size 10 /Encrypt 9 0 R >>\n'
    )
  )
  const enc = await store.import('s1', [encSrc])
  const er = await store.readText(enc.attachments[0].path, 0, 10)
  assert.equal(er.ok, false)
  assert.equal(er.code, 'PDF_ENCRYPTED')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('附件提示词块：PDF 要写明「可以用 read_attachment 读正文」', () => {
  const meta = {
    id: 'a-1',
    name: '作业要求.pdf',
    path: 'C:/x/作业要求.pdf',
    size: 1024,
    kind: 'binary',
    ext: 'pdf',
    addedAt: 0
  }
  const block = buildAttachmentBlock([meta])
  assert.match(block, /read_attachment/)
  assert.doesNotMatch(block, /read_attachment 也读不了/)
  // 界面上标「PDF」而不是「二进制」：后者会让人以为这文件仍然读不了
  assert.equal(kindLabel('binary', 'pdf'), 'PDF')
  assert.equal(kindLabel('binary'), '二进制')
})
