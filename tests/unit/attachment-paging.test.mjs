import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AttachmentStore,
  readLineWindow,
  windowLineArray,
  isOffsetOutOfRange,
  READ_MAX_LINE_CHARS
} from '../.build/harness.mjs'

/**
 * 第 4 轮：附件分页与热路径（T4.8 / T4.2）。
 *
 * T4.8 守两件事：分页参数非法时不许返回 NaN 这种"看起来能继续翻"的结论；
 * 大文件翻页不许整份读进内存。
 */

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ensp-att-${tag}-`))
}

test('T4.8 readLineWindow：行窗口正确，跨分片的长行不断裂', () => {
  const dir = tmpDir('window')
  const file = path.join(dir, 'a.txt')
  const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}`)
  fs.writeFileSync(file, lines.join('\n'), 'utf8')

  const win = readLineWindow(file, 100, 3)
  assert.equal(win.from, 100)
  assert.equal(win.to, 103)
  assert.equal(win.text, 'line-100\nline-101\nline-102')
  assert.equal(win.totalLines, 5000)
  assert.equal(win.truncated, true)

  const tail = readLineWindow(file, 4998, 10)
  assert.equal(tail.text, 'line-4998\nline-4999')
  assert.equal(tail.to, 5000)
  assert.equal(tail.truncated, false)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('T4.8 readLineWindow：CRLF 被剥掉；GBK 中文跨分片不解成乱码', () => {
  const dir = tmpDir('crlf')
  const file = path.join(dir, 'b.txt')
  fs.writeFileSync(file, 'a\r\nb\r\nc', 'utf8')
  const win = readLineWindow(file, 0, 10)
  assert.equal(win.text, 'a\nb\nc')

  const gbkFile = path.join(dir, 'c.txt')
  // 每个汉字 2 字节；造足够多行把分片边界"喂"给解码器
  const zh = Array.from({ length: 2000 }, (_, i) => `配置-${i}-中文`)
  fs.writeFileSync(gbkFile, iconvToGbk(zh.join('\r\n')))
  const g = readLineWindow(gbkFile, 3, 2)
  assert.equal(g.encoding, 'gbk')
  assert.equal(g.text, '配置-3-中文\n配置-4-中文')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('T4.8 readLineWindow：含 NUL 视为二进制，拒绝按文本读', () => {
  const dir = tmpDir('bin')
  const file = path.join(dir, 'x.bin')
  fs.writeFileSync(file, Buffer.from([0x41, 0x00, 0x42]))
  const r = readLineWindow(file, 0, 10)
  assert.ok('error' in r)
  assert.match(r.error, /二进制/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('T4.8 AttachmentStore.readText：offset/limit 非法时明确报错，不再返回 from: NaN', async () => {
  const dir = tmpDir('store')
  const store = new AttachmentStore(dir)
  const src = path.join(dir, 'src.txt')
  fs.writeFileSync(src, Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n'), 'utf8')

  const imported = await store.import('s1', [src])
  assert.equal(imported.attachments.length, 1)
  const archived = imported.attachments[0].path

  for (const bad of ['abc', null, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = await store.readText(archived, bad, 10)
    assert.equal(r.ok, false, `offset=${String(bad)} 必须被拒`)
    assert.match(r.error, /offset \/ limit 必须是数字/)
  }
  const badLimit = await store.readText(archived, 0, 'many')
  assert.equal(badLimit.ok, false)

  const good = await store.readText(archived, 10, 2)
  assert.equal(good.ok, true)
  assert.equal(good.from, 10)
  assert.equal(good.to, 12)
  assert.equal(good.text, 'L10\nL11')
  assert.equal(good.totalLines, 100)
  assert.equal(good.truncated, true)

  const end = await store.readText(archived, 99, 10)
  assert.equal(end.text, 'L99')
  assert.equal(end.truncated, false)

  fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * v2.13：有界读取（参照 deepseek-harness 的 read 工具）。
 *
 * 旧实现没有单行上限、没有输出字节上限、也没有续读指针 —— 一行超长就能把结果撑爆，
 * 整份文件无换行时 `carry` 还会无界增长。这里守三件事：结果有界、可续读、越界可辨。
 */
test('v2.13 readLineWindow：超长单行按上限截断，不整行进结果', () => {
  const dir = tmpDir('longline')
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, `${'x'.repeat(5000)}\nshort`, 'utf8')

  const win = readLineWindow(file, 0, 10)
  assert.equal(win.totalLines, 2)
  assert.match(win.text, /本行超长，已截断至 2000 字符/)
  assert.match(win.text, /short$/)
  assert.ok(win.text.length < 2200, `单行必须被截断，实际 ${win.text.length} 字符`)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('v2.13 readLineWindow：无换行巨型文件不爆内存且返回有界', () => {
  const dir = tmpDir('oneline')
  const file = path.join(dir, 'huge.txt')
  fs.writeFileSync(file, 'y'.repeat(2 * 1024 * 1024), 'utf8')

  const win = readLineWindow(file, 0, 10)
  assert.equal(win.totalLines, 1)
  assert.ok(win.text.length <= READ_MAX_LINE_CHARS + 100, '结果必须有界')
  assert.equal(win.atEnd, true)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('v2.13 readLineWindow：输出字节上限触发 truncatedByBytes，且每页必前进（不会死循环）', () => {
  const dir = tmpDir('bytes')
  const file = path.join(dir, 'b.txt')
  fs.writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n'), 'utf8')

  const first = readLineWindow(file, 0, 1000, { maxBytes: 40 })
  assert.equal(first.truncatedByBytes, true)
  assert.equal(first.truncated, true)
  assert.equal(first.atEnd, false)
  assert.equal(first.nextOffset, first.to)
  assert.ok(first.to > 0 && first.to < first.totalLines)
  assert.ok(first.text.length > 0, '当页首行必收，否则翻页原地打转')

  // 续读闭环：offset 一路跟着 nextOffset 走，累计行数必须等于总行数（无跳行/重行）
  let offset = 0
  let seen = 0
  for (let guard = 0; guard < 100; guard += 1) {
    const w = readLineWindow(file, offset, 1000, { maxBytes: 40 })
    seen += w.to - w.from
    if (w.atEnd) break
    assert.ok(w.nextOffset > offset, '每页必须前进，否则会死循环')
    offset = w.nextOffset
  }
  assert.equal(seen, 50)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('v2.13 windowLineArray / isOffsetOutOfRange：文档路径与文本路径同一套口径', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `d${i}`)
  const w = windowLineArray(lines, 10, 5)
  assert.equal(w.totalLines, 30)
  assert.equal(w.from, 10)
  assert.equal(w.to, 15)
  assert.equal(w.nextOffset, 15)
  assert.equal(w.atEnd, false)
  assert.equal(w.truncatedByBytes, false)
  assert.equal(w.text, 'd10\nd11\nd12\nd13\nd14')

  assert.equal(isOffsetOutOfRange(29, 30), false)
  assert.equal(isOffsetOutOfRange(30, 30), true)
  assert.equal(isOffsetOutOfRange(0, 0), false)
  assert.equal(isOffsetOutOfRange(1, 0), true)
})

test('v2.13 AttachmentStore.readText：offset 越界明确报错（不再返回空页）', async () => {
  const dir = tmpDir('oor')
  const store = new AttachmentStore(dir)
  const src = path.join(dir, 'src.txt')
  fs.writeFileSync(src, Array.from({ length: 5 }, (_, i) => `L${i}`).join('\n'), 'utf8')
  const { attachments } = await store.import('s1', [src])
  const archived = attachments[0].path

  const atEnd = await store.readText(archived, 5, 10)
  assert.equal(atEnd.ok, false)
  assert.equal(atEnd.code, 'OFFSET_OUT_OF_RANGE')
  assert.match(atEnd.error, /共 5 行/)

  const beyond = await store.readText(archived, 9, 10)
  assert.equal(beyond.ok, false)
  assert.equal(beyond.code, 'OFFSET_OUT_OF_RANGE')
  assert.match(beyond.error, /有效 0-4/)

  const last = await store.readText(archived, 4, 10)
  assert.equal(last.ok, true)
  assert.equal(last.text, 'L4')
  assert.equal(last.atEnd, true)
  assert.equal(last.nextOffset, 5)

  const page = await store.readText(archived, 0, 2)
  assert.equal(page.ok, true)
  assert.equal(page.to, 2)
  assert.equal(page.nextOffset, 2)
  assert.equal(page.atEnd, false)
  assert.equal(page.truncatedByBytes, false)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('v2.13 AttachmentStore.readText：空文件 offset=0 可读且 atEnd=true，offset=1 越界', async () => {
  const dir = tmpDir('empty')
  const store = new AttachmentStore(dir)
  const src = path.join(dir, 'empty.txt')
  fs.writeFileSync(src, '', 'utf8')
  const { attachments } = await store.import('s1', [src])
  const archived = attachments[0].path

  const head = await store.readText(archived, 0, 10)
  assert.equal(head.ok, true)
  assert.equal(head.text, '')
  assert.equal(head.atEnd, true)

  const over = await store.readText(archived, 1, 10)
  assert.equal(over.ok, false)
  assert.equal(over.code, 'OFFSET_OUT_OF_RANGE')

  fs.rmSync(dir, { recursive: true, force: true })
})

/** 把字符串转成 GBK 字节（测试里手工构造 GBK 附件用；Node 自带 TextDecoder 只能解码） */
function iconvToGbk(text) {
  // 用 TextEncoder 拿不到 GBK 编码，这里借助 Node 的 ICU：先按 UTF-8 存，再用 Buffer 转
  // 简化处理：仅覆盖本用例用到的汉字集合（配置中文-数字）
  const table = { 配: [0xc5, 0xe4], 置: [0xd6, 0xc3], 中: [0xd6, 0xd0], 文: [0xce, 0xc4] }
  const out = []
  for (const ch of text) {
    if (table[ch]) out.push(...table[ch])
    else out.push(ch.charCodeAt(0))
  }
  return Buffer.from(out)
}
