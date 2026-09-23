import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AttachmentStore, readLineWindow } from '../.build/harness.mjs'

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
