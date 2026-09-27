import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AttachmentStore,
  readZip,
  sniffDocumentKind,
  extractDocumentText,
  docxBodyToText,
  sheetToText,
  parseSharedStrings,
  slideToText,
  rtfToText,
  extractRtf,
  readCfb,
  classifyCfb,
  extractLegacyDoc,
  parseClx,
  parsePlcPcd,
  piecesToText,
  filterWordControls,
  buildAttachmentBlock,
  kindLabel,
  READABLE_DOC_EXTS
} from '../.build/harness.mjs'

/**
 * v2.1：常见文档附件能不能读（docx / xlsx / pptx / odt / 老式 doc / rtf）。
 *
 * 用户的要求是「不只有 pdf，md、docx、doc 这些也要能解析」。这里对每种格式钉三件事：
 * 识别（靠内容不靠扩展名）、正文抽取（段落/表格/幻灯片边界）、
 * 以及失败时给的是哪种原因（加密 / 不支持的老格式 / 没文字）。
 *
 * 容器一律在测试里手工构造（ZIP 与 CFB 都可控），不依赖本机任何文件。
 * 真实文件（本机的 .docx/.pptx/.doc）在开发时用探针另行验证过。
 */

// ———————————————————— 造容器：ZIP ————————————————————

/** 最小 ZIP 写入器（store 模式，不压缩）：够造 docx/xlsx/pptx/odt */
function makeZip(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8) // method = store
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    parts.push(local, nameBuf, data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const cenBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cenBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cenBuf, eocd])
}

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

// ———————————————————— 造容器：CFB（OLE2） ————————————————————

/** 目录项（128 字节；只填测试需要的字段） */
function dirEntry(name, type, startSector, size) {
  const e = Buffer.alloc(128)
  Buffer.from(name, 'utf16le').copy(e, 0)
  e.writeUInt16LE((name.length + 1) * 2, 0x40)
  e.writeUInt8(type, 0x42)
  e.writeUInt32LE(startSector, 0x74)
  e.writeUInt32LE(size, 0x78)
  return e
}

/**
 * 最小 CFB 写入器（512 字节扇区）。
 * `main` 流走主 FAT，`mini` 流走 MiniFAT（Word 的 1Table 通常 < 4096 字节，走的就是这条）。
 * 布局：0=FAT 1=目录 主 FAT 流… mini 容器 MiniFAT —— 两条路径都被覆盖到。
 */
function buildCfb(main, mini) {
  const SECTOR = 512
  const MINI = 64
  const mainSectors = main.map((s) => Math.ceil(s.data.length / SECTOR))
  const totalMain = mainSectors.reduce((a, b) => a + b, 0)
  const miniSectors = mini.map((s) => Math.ceil(s.data.length / MINI))
  const totalMini = miniSectors.reduce((a, b) => a + b, 0)
  const miniContainerSectors = Math.max(1, Math.ceil((totalMini * MINI) / SECTOR))

  const dirSector = 1
  let cursor = 2
  const mainStart = []
  for (const n of mainSectors) {
    mainStart.push(cursor)
    cursor += n
  }
  const miniContainerStart = cursor
  cursor += miniContainerSectors
  const miniFatStart = cursor

  const entries = [dirEntry('Root Entry', 5, miniContainerStart, totalMini * MINI)]
  main.forEach((s, i) => entries.push(dirEntry(s.name, 2, mainStart[i], s.data.length)))
  let miniIdx = 0
  mini.forEach((s, i) => {
    entries.push(dirEntry(s.name, 2, miniIdx, s.data.length))
    miniIdx += miniSectors[i]
  })
  while (entries.length < 4) entries.push(Buffer.alloc(128))

  const fat = Buffer.alloc(SECTOR, 0xff)
  fat.writeUInt32LE(0xfffffffd, 0) // FAT 自身
  fat.writeUInt32LE(0xfffffffe, dirSector * 4) // 目录：单扇区链
  mainSectors.forEach((n, i) => {
    for (let k = 0; k < n; k++) {
      const next = k === n - 1 ? 0xfffffffe : mainStart[i] + k + 1
      fat.writeUInt32LE(next, (mainStart[i] + k) * 4)
    }
  })
  for (let k = 0; k < miniContainerSectors; k++) {
    const next = k === miniContainerSectors - 1 ? 0xfffffffe : miniContainerStart + k + 1
    fat.writeUInt32LE(next, (miniContainerStart + k) * 4)
  }
  fat.writeUInt32LE(0xfffffffe, miniFatStart * 4)

  const miniFat = Buffer.alloc(SECTOR, 0xff)
  let mi = 0
  miniSectors.forEach((n) => {
    for (let k = 0; k < n; k++) miniFat.writeUInt32LE(k === n - 1 ? 0xfffffffe : mi + k + 1, (mi + k) * 4)
    mi += n
  })

  const miniData = Buffer.alloc(miniContainerSectors * SECTOR)
  let off = 0
  mini.forEach((s, i) => {
    s.data.copy(miniData, off)
    off += miniSectors[i] * MINI
  })

  const mainData = Buffer.alloc(totalMain * SECTOR)
  main.forEach((s, i) => s.data.copy(mainData, (mainStart[i] - 2) * SECTOR))

  const header = Buffer.alloc(SECTOR)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0)
  header.writeUInt16LE(0x003e, 0x18)
  header.writeUInt16LE(0x0003, 0x1a)
  header.writeUInt16LE(0xfffe, 0x1c)
  header.writeUInt16LE(9, 0x1e)
  header.writeUInt16LE(6, 0x20)
  header.writeUInt32LE(1, 0x2c)
  header.writeUInt32LE(dirSector, 0x30)
  header.writeUInt32LE(4096, 0x38)
  header.writeUInt32LE(miniFatStart, 0x3c)
  header.writeUInt32LE(1, 0x40)
  header.writeUInt32LE(0xfffffffe, 0x44)
  header.writeUInt32LE(0, 0x48)
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : 0xffffffff, 0x4c + i * 4)

  return Buffer.concat([header, fat, Buffer.concat(entries), mainData, miniData, miniFat])
}

/**
 * 造一个 Word 97-2003 的 .doc：
 * WordDocument（4096 字节，走主 FAT）里放 FIB + 两段正文，
 * 1Table（64 字节，走 MiniFAT）里放 CLX/PlcPcd 分片表。
 * 分片 1 是压缩片（CP1252）、分片 2 是 Unicode 片 —— 两条解码路径都覆盖。
 */
function makeLegacyDoc({ encrypted = false } = {}) {
  const word = Buffer.alloc(4096)
  word.writeUInt16LE(0xa5ec, 0x00)
  word.writeUInt16LE(0x00c1, 0x02) // nFib = Word 97
  word.writeUInt16LE((encrypted ? 0x0100 : 0) | 0x0200 | 0x0004, 0x0a) // fEncrypted / 1Table / fComplex
  word.writeUInt32LE(1024, 0x18) // fcMin
  word.writeUInt32LE(1104, 0x1c) // fcMac
  word.write('Hello\r', 1024, 'latin1')
  word.write('中文', 1100, 'utf16le')

  const pcd1 = Buffer.alloc(8)
  pcd1.writeUInt32LE((1024 * 2) | 0x40000000, 2) // 压缩标志 + fc×2
  const pcd2 = Buffer.alloc(8)
  pcd2.writeUInt32LE(1100, 2) // 未压缩 → UTF-16LE
  const cps = Buffer.alloc(12)
  cps.writeUInt32LE(0, 0)
  cps.writeUInt32LE(6, 4)
  cps.writeUInt32LE(8, 8)
  const plcPcd = Buffer.concat([cps, pcd1, pcd2])
  const lcb = Buffer.alloc(4)
  lcb.writeUInt32LE(plcPcd.length, 0)
  const clx = Buffer.concat([Buffer.from([2]), lcb, plcPcd])
  // fcClx 指的是**table 流**里的偏移（不是 WordDocument 流）—— 分片表就住在 1Table 里
  word.writeUInt32LE(0, 0x01a2)
  word.writeUInt32LE(clx.length, 0x01a6)

  const table = Buffer.concat([clx, Buffer.alloc(64 - clx.length)])
  return buildCfb([{ name: 'WordDocument', data: word }], [{ name: '1Table', data: table }])
}

/** 加密的 OOXML（.docx 加了密码）其实是个 CFB 壳：只有 EncryptionInfo + EncryptedPackage */
function makeEncryptedOoxml() {
  const info = Buffer.alloc(22)
  Buffer.from('EncryptionInfo', 'latin1').copy(info, 0)
  const pkg = Buffer.alloc(16)
  Buffer.from('EncryptedPackage', 'latin1').copy(pkg, 0)
  return buildCfb(
    [],
    [
      { name: 'EncryptionInfo', data: info },
      { name: 'EncryptedPackage', data: pkg }
    ]
  )
}

/** 老式 .xls：CFB 里是 Workbook 流（BIFF 记录，本轮不解析） */
function makeLegacyXls() {
  return buildCfb([{ name: 'Workbook', data: Buffer.alloc(4096) }], [])
}

// ———————————————————— 造容器：文档 ————————————————————

function makeDocx() {
  const body =
    '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' +
    '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p>' +
    '<w:tbl><w:tr>' +
    '<w:tc><w:p><w:r><w:t>设备</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>IP</w:t></w:r></w:p></w:tc>' +
    '</w:tr><w:tr>' +
    '<w:tc><w:p><w:r><w:t>R1</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>10.0.0.1</w:t></w:r></w:p></w:tc>' +
    '</w:tr></w:tbl>' +
    '<w:p><w:r><w:instrText>PAGE \\* MERGEFORMAT</w:instrText></w:r></w:p>' +
    '<w:p><w:r><w:t>末段</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  return makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', body]
  ])
}

function makeXlsx() {
  const shared = '<sst><si><t>名称</t></si><si><t>核心交换机</t></si><si><t>数量</t></si></sst>'
  // 第 1 行三个共享串；第 2 行只有 C 列（A/B 被省略 → 必须补位）；第 3 行内联字符串
  const sheet1 =
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
    '<row r="2"><c r="C2"><v>5</v></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>直写</t></is></c></row>' +
    '</sheetData></worksheet>'
  const wb = '<workbook><sheets><sheet name="设备表" sheetId="1" r:id="rId1"/></sheets></workbook>'
  const rels =
    '<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>'
  return makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/workbook.xml', wb],
    ['xl/_rels/workbook.xml.rels', rels],
    ['xl/sharedStrings.xml', shared],
    ['xl/worksheets/sheet1.xml', sheet1]
  ])
}

function makePptx() {
  const slide = (paras) =>
    '<p:sld><p:cSld><p:spTree>' +
    paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('') +
    '</p:spTree></p:cSld></p:sld>'
  return makeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/presentation.xml', '<p:presentation/>'],
    ['ppt/slides/slide1.xml', slide(['ECC 基础', '椭圆曲线'])],
    ['ppt/slides/slide2.xml', slide(['哈希函数'])]
  ])
}

function makeOdt() {
  const content =
    '<office:document-content>' +
    '<office:meta><dc:title>不该出现</dc:title></office:meta>' +
    '<office:body><office:text>' +
    '<text:h>标题</text:h><text:p>正文一</text:p>' +
    '<table:table><table:table-row>' +
    '<table:table-cell><text:p>甲</text:p></table:table-cell>' +
    '<table:table-cell><text:p>乙</text:p></table:table-cell>' +
    '</table:table-row></table:table>' +
    '</office:text></office:body></office:document-content>'
  return makeZip([
    ['mimetype', 'application/vnd.oasis.opendocument.text'],
    ['content.xml', content]
  ])
}

// ———————————————————— 识别 ————————————————————

test('文档识别靠内容而不是扩展名：docx / xlsx / pptx / odt / rtf / doc / 加密 OOXML', () => {
  assert.equal(sniffDocumentKind(makeDocx()), 'docx')
  assert.equal(sniffDocumentKind(makeXlsx()), 'xlsx')
  assert.equal(sniffDocumentKind(makePptx()), 'pptx')
  assert.equal(sniffDocumentKind(makeOdt()), 'odt')
  assert.equal(sniffDocumentKind(Buffer.from('{\\rtf1\\ansi hi}', 'latin1')), 'rtf')
  assert.equal(sniffDocumentKind(makeLegacyDoc()), 'doc')
  assert.equal(sniffDocumentKind(makeEncryptedOoxml()), 'doc', '加密 OOXML 是 CFB 壳，也走 doc 这条路')
  assert.equal(sniffDocumentKind(makeZip([['a.txt', 'hi']])), null, '普通 ZIP 不认')
  assert.equal(sniffDocumentKind(Buffer.from('hello')), null)
})

// ———————————————————— 各格式正文 ————————————————————

test('docx：段落成行、表格落成 TSV、域代码被丢弃', () => {
  const r = extractDocumentText(makeDocx())
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  const lines = r.text.split('\n')
  assert.equal(lines[0], '第一段')
  assert.equal(lines[1], 'Hello World')
  assert.equal(lines[2], '设备\tIP')
  assert.equal(lines[3], 'R1\t10.0.0.1')
  assert.equal(lines[4], '末段')
  assert.doesNotMatch(r.text, /MERGEFORMAT/, '域代码不是正文')
})

test('docx：制表符与软换行直接测 XML → 文本', () => {
  const xml =
    '<w:body><w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>C</w:t><w:br/><w:t>D</w:t></w:r></w:p></w:body>'
  assert.equal(docxBodyToText(xml).trim(), 'A\tB\nC\nD')
})

test('xlsx：工作表名、共享字符串、被省略的空列要补位', () => {
  const zip = readZip(makeXlsx())
  assert.equal(zip.ok, true)
  const shared = parseSharedStrings(zip.get('xl/sharedStrings.xml').toString('utf8'))
  assert.deepEqual(shared, ['名称', '核心交换机', '数量'])
  const lines = sheetToText(zip.get('xl/worksheets/sheet1.xml').toString('utf8'), shared)
    .trim()
    .split('\n')
  assert.equal(lines[0], '名称\t核心交换机\t数量')
  assert.equal(lines[1], '\t\t5', 'B2 缺失 → 必须补两列，否则整表左移')
  assert.equal(lines[2], '直写')

  const r = extractDocumentText(makeXlsx())
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  assert.match(r.text, /--- 设备表 ---/)
})

test('pptx：按页抽取、页号分隔', () => {
  const zip = readZip(makePptx())
  assert.equal(zip.ok, true)
  assert.equal(slideToText(zip.get('ppt/slides/slide1.xml').toString('utf8')).trim(), 'ECC 基础\n椭圆曲线')
  const r = extractDocumentText(makePptx())
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  assert.equal(r.text, '--- 幻灯片 1 ---\nECC 基础\n椭圆曲线\n\n--- 幻灯片 2 ---\n哈希函数')
})

test('odt：只取 office:body（元数据不算正文），标题/段落/单元格各归位', () => {
  const r = extractDocumentText(makeOdt())
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  assert.doesNotMatch(r.text, /不该出现/, 'office:meta 里的内容不是正文')
  const lines = r.text.split('\n').map((l) => l.trim()).filter(Boolean)
  assert.deepEqual(lines, ['标题', '正文一', '甲\t乙'])
})

test('rtf：\\par / \\tab / \\uN / \\\'hh（按代码页整体解码）与字体表跳过', () => {
  const rtf =
    '{\\rtf1\\ansi\\ansicpg936{\\fonttbl{\\f0\\fnil\\fcharset134 SimSun;}}' +
    '{\\*\\generator Riched20 10.0;}Hello\\par ' +
    'Unicode:\\u20013?\\u25991?\\tab 转义:\\\'d6\\\'d0\\\'ce\\\'c4\\par}'
  const text = rtfToText(rtf)
  assert.match(text, /Hello/)
  assert.match(text, /Unicode:中文/)
  assert.match(text, /转义:中文/, "连续 \\'hh 要按代码页整体解码，不能逐字节当字符")
  assert.doesNotMatch(text, /SimSun|Riched20/, '字体表与生成器信息要整组跳过')

  const r = extractRtf(Buffer.from(rtf, 'latin1'))
  assert.equal(r.ok, true)
  assert.match(r.text, /Unicode:中文/)
})

// ———————————————————— 老式 .doc ————————————————————

test('CFB 容器：认出 Word / 加密文档 / 老式 xls', () => {
  const doc = readCfb(makeLegacyDoc())
  assert.equal(doc.ok, true, doc.ok ? '' : doc.error)
  assert.equal(classifyCfb(doc.streams), 'doc')
  assert.equal(classifyCfb(readCfb(makeEncryptedOoxml()).streams), 'encrypted')
  assert.equal(classifyCfb(readCfb(makeLegacyXls()).streams), 'xls')
})

test('.doc：分片表（CLX/PlcPcd）—— 压缩片 CP1252 + Unicode 片 UTF-16LE', () => {
  const buf = makeLegacyDoc()
  const cfb = readCfb(buf)
  assert.equal(cfb.ok, true)
  const word = cfb.streams.get('WordDocument')
  const table = cfb.streams.get('1Table')
  assert.ok(word && table, '两个流都要取出来（1Table 走 MiniFAT）')

  const fcClx = word.readUInt32LE(0x01a2)
  const lcbClx = word.readUInt32LE(0x01a6)
  const pieces = parseClx(table.subarray(fcClx, fcClx + lcbClx), word)
  assert.equal(pieces.length, 2)
  assert.equal(pieces[0].compressed, true)
  assert.equal(pieces[0].fc, 1024)
  assert.equal(pieces[1].compressed, false)
  assert.equal(piecesToText(word, pieces), 'Hello\r中文')

  const r = extractLegacyDoc(buf)
  assert.equal(r.ok, true, r.ok ? '' : r.error)
  assert.equal(r.text, 'Hello\n中文', '\\r 是 Word 的段落结束符，要落成换行')
})

test('.doc：分片表解析的边界（空表 / 截断不抛）', () => {
  assert.deepEqual(parsePlcPcd(Buffer.alloc(8)), [])
  assert.deepEqual(parseClx(Buffer.from([9, 9, 9]), Buffer.alloc(0)), [])
  const plc = Buffer.alloc(16)
  plc.writeUInt32LE(0, 0)
  plc.writeUInt32LE(3, 4)
  const pieces = parsePlcPcd(plc)
  assert.equal(pieces.length, 1)
  assert.equal(pieces[0].cpEnd, 3)
})

test('Word 控制字符：域代码丢弃、单元格/换行保留', () => {
  assert.equal(filterWordControls('A\u0013 PAGE \u0014 1\u0015 B'), 'A 1 B')
  assert.equal(filterWordControls('a\rb\u0007c\u000bd'), 'a\nb\tc\nd')
})

test('加密文档：老式 .doc 与加密 OOXML 都报「加密」而不是「读不了」', () => {
  const r = extractLegacyDoc(makeLegacyDoc({ encrypted: true }))
  assert.equal(r.ok, false)
  assert.match(r.error, /加密/)

  const e = extractDocumentText(makeEncryptedOoxml())
  assert.equal(e.ok, false)
  assert.match(e.error, /加密/)
})

test('老式 .xls：明确告诉用户「另存为 .xlsx」', () => {
  const r = extractDocumentText(makeLegacyXls())
  assert.equal(r.ok, false)
  assert.match(r.error, /xlsx/)
})

// ———————————————————— 接进 AttachmentStore ————————————————————

test('AttachmentStore.readText：docx 走抽取 + 行分页，返回 format/label/note', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-doc-store-'))
  const store = new AttachmentStore(dir)
  const src = path.join(dir, '报告.docx')
  fs.writeFileSync(src, makeDocx())
  const imported = await store.import('s1', [src])
  const archived = imported.attachments[0].path

  const all = await store.readText(archived, 0, 400)
  assert.equal(all.ok, true)
  assert.equal(all.format, 'docx')
  assert.equal(all.formatLabel, 'Word')
  assert.match(all.note, /自动抽取/)
  assert.match(all.text, /第一段/)

  const page = await store.readText(archived, 2, 2)
  assert.equal(page.from, 2)
  assert.equal(page.text.split('\n')[0], '设备\tIP')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('AttachmentStore.readText：老式 .xls 报 DOC_UNREADABLE 并带处置建议', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-doc-xls-'))
  const store = new AttachmentStore(dir)
  const src = path.join(dir, '旧表.xls')
  fs.writeFileSync(src, makeLegacyXls())
  const imported = await store.import('s1', [src])
  const r = await store.readText(imported.attachments[0].path, 0, 10)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DOC_UNREADABLE')
  assert.match(r.error, /xlsx/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('附件提示词块：docx/xlsx/rtf 都写明「可以读」，图片仍然是「读不了」', () => {
  assert.ok(READABLE_DOC_EXTS.has('docx') && READABLE_DOC_EXTS.has('doc') && READABLE_DOC_EXTS.has('rtf'))
  assert.equal(kindLabel('binary', 'docx'), 'Word')
  assert.equal(kindLabel('binary', 'xlsx'), 'Excel')
  const block = buildAttachmentBlock([
    { id: 'a', name: '作业.docx', path: 'C:/x/作业.docx', size: 10, kind: 'binary', ext: 'docx', addedAt: 0 },
    { id: 'b', name: '表.xlsx', path: 'C:/x/表.xlsx', size: 10, kind: 'binary', ext: 'xlsx', addedAt: 0 },
    { id: 'c', name: '截图.png', path: 'C:/x/截图.png', size: 10, kind: 'image', ext: 'png', addedAt: 0 }
  ])
  assert.match(block, /可以直接用 read_attachment 读取正文/)
  assert.match(block, /这是图片/)
  assert.doesNotMatch(block, /图片[\s\S]*read_attachment 也读不了/)
})
