/**
 * v2.13：参考配置（analyze_reference_configs）读取的编码与准入。
 *
 * 旧实现 `readFileSync(path, 'utf8')` 硬解 UTF-8：中文的实验指导书 / 标准配置样例
 * 大量是 GBK，会整份变成 U+FFFD，而模型随后会「照此摘要配置真机」—— 乱码直接变成
 * 错误配置。这里守三件事：按内容判编码（UTF-8 优先 / GBK 回退）、二进制拒绝、超限拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeReferenceConfigs, readReferenceTextFile } from '../.build/harness.mjs'

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ensp-ref-${tag}-`))
}

/** 手工构造 GBK 字节：中=D6D0 文=CEC4（与附件 GBK 用例同一组判据） */
function gbkBytes(text) {
  const table = { 中: [0xd6, 0xd0], 文: [0xce, 0xc4] }
  const out = []
  for (const ch of text) {
    if (table[ch]) out.push(...table[ch])
    else out.push(ch.charCodeAt(0))
  }
  return Buffer.from(out)
}

test('v2.13 readReferenceTextFile：GBK 参考配置按内容判编码，不再读出乱码', async () => {
  const dir = tmpDir('gbk')
  const file = path.join(dir, 'guide.cfg')
  fs.writeFileSync(file, gbkBytes('sysname 中文\nvlan batch 10\n'))

  const read = readReferenceTextFile(file)
  assert.equal(read.ok, true)
  assert.equal(read.encoding, 'gbk')
  assert.match(read.text, /sysname 中文/)
  assert.ok(!read.text.includes('\uFFFD'), '不允许出现替换符（乱码）')

  // 端到端：handler 抽出的设备名必须是中文而不是乱码
  const res = await analyzeReferenceConfigs.handler({ path: file }, {})
  assert.equal(res.ok, true)
  assert.ok(
    res.data.devices.includes('中文'),
    `设备名应为中文，实际 ${JSON.stringify(res.data.devices)}`
  )
  assert.ok(!JSON.stringify(res.data).includes('\uFFFD'), '摘要里不允许出现乱码')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('v2.13 readReferenceTextFile：含 NUL 的「配置」按二进制拒绝', () => {
  const dir = tmpDir('bin')
  const file = path.join(dir, 'fake.cfg')
  fs.writeFileSync(file, Buffer.from([0x73, 0x00, 0x01, 0x02]))

  const read = readReferenceTextFile(file)
  assert.equal(read.ok, false)
  assert.match(read.error, /二进制/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('v2.13 analyze_reference_configs：超过 512KB 拒绝（回归保护）', async () => {
  const dir = tmpDir('big')
  const file = path.join(dir, 'big.cfg')
  fs.writeFileSync(file, 'x'.repeat(512 * 1024 + 1), 'utf8')

  const res = await analyzeReferenceConfigs.handler({ path: file }, {})
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'BAD_PARAM')
  assert.match(res.error.message, /512KB/)

  fs.rmSync(dir, { recursive: true, force: true })
})