import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TerminalBuffer,
  DEFAULT_TERMINAL_BUFFER_BYTES,
  DEFAULT_TERMINAL_MAX_SEGMENTS
} from '../.build/harness.mjs'

/**
 * 终端回放缓冲（2026-09-25）。
 *
 * 背景：xterm 实例活在渲染层，设备字节流从连接成功那一刻就开始到达；
 * 切换设备会 dispose 旧实例、重建新实例，没有回放缓冲就只能看到一片空白
 * （连握手 banner 与提示符都看不到）。这里守三件事：
 *   1. latin1 编码能无损还原原始字节（中文不被破坏）；
 *   2. seq 单调且不因裁剪/清空回退（渲染层拿它当去重水位）；
 *   3. 裁剪必须落在合法字节边界上，不能从多字节字符中间切开。
 */

const utf8 = (s) => new TextEncoder().encode(s)
const toBytes = (latin1) => Uint8Array.from(latin1, (c) => c.charCodeAt(0))

test('TerminalBuffer：按序追加、seq 单调、fromAgent 标记保留', () => {
  const buf = new TerminalBuffer()
  const s1 = buf.append(utf8('<Huawei>'), false)
  const s2 = buf.append(utf8('display version\r\n'), true)

  assert.equal(s1, 1)
  assert.equal(s2, 2)
  assert.equal(buf.lastSeq, 2)
  assert.equal(buf.byteLength, '<Huawei>'.length + 'display version\r\n'.length)

  const snap = buf.snapshot()
  assert.deepEqual(
    snap.map((s) => s.seq),
    [1, 2]
  )
  assert.deepEqual(
    snap.map((s) => s.fromAgent),
    [false, true]
  )
  assert.equal(new TextDecoder().decode(toBytes(snap[0].data)), '<Huawei>')
  assert.equal(new TextDecoder().decode(toBytes(snap[1].data)), 'display version\r\n')
})

test('TerminalBuffer：latin1 承载多字节中文，往返无损', () => {
  const buf = new TerminalBuffer()
  const src = '<Huawei>display version\r\nVRP (R) software\r\n描述：路由器与交换机\r\n'
  buf.append(utf8(src), false)

  const restored = new TextDecoder('utf-8', { fatal: true }).decode(toBytes(buf.snapshot()[0].data))
  assert.equal(restored, src)
})

test('TerminalBuffer：空块不落段（避免堆积占位段），但序号照常递增', () => {
  const buf = new TerminalBuffer()
  assert.equal(buf.append(new Uint8Array(0), false), 1)
  assert.equal(buf.segmentCount, 0)
  assert.equal(buf.byteLength, 0)
  assert.equal(buf.append(utf8('x'), false), 2)
  assert.equal(buf.segmentCount, 1)
})

test('TerminalBuffer：超出容量按整段丢弃最旧的，只保留最新内容', () => {
  const buf = new TerminalBuffer(20)
  buf.append(utf8('aaaaaaaaaa'), false)
  buf.append(utf8('bbbbbbbbbb'), false)
  buf.append(utf8('cccccccccc'), false) // 30 > 20 → 丢掉最早一段

  assert.deepEqual(
    buf.snapshot().map((s) => s.data),
    ['bbbbbbbbbb', 'cccccccccc']
  )
  assert.equal(buf.byteLength, 20)
  assert.equal(buf.lastSeq, 3, '裁剪不得让 seq 回退')
})

test('TerminalBuffer：单段自身超限时保留尾部，且对齐到 UTF-8 字符边界', () => {
  const text = 'AAAAAAAAAA中文中文' // 10 + 4×3 = 22 字节
  // 22-11 = 11 → 正落在「中」的第 2 个字节（continuation）上，必须往后跳到下一个字符
  const buf = new TerminalBuffer(11)
  buf.append(utf8(text), false)

  const raw = buf.snapshot()[0].data
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(toBytes(raw))
  assert.equal(decoded, '文中文', '不得从字符中间切开')
  assert.ok(raw.length <= 11)
  assert.equal(buf.byteLength, raw.length)
})

test('TerminalBuffer：clear 清内容但序号不回退（水位不能倒退）', () => {
  const buf = new TerminalBuffer()
  buf.append(utf8('a'), false)
  buf.append(utf8('b'), false)
  buf.clear()

  assert.equal(buf.snapshot().length, 0)
  assert.equal(buf.byteLength, 0)
  assert.equal(buf.lastSeq, 2, 'clear 后 lastSeq 保持，否则渲染层会把新数据误判成旧数据')
  assert.equal(buf.append(utf8('c'), false), 3)
})

test('TerminalBuffer：默认容量为 256KB', () => {
  assert.equal(DEFAULT_TERMINAL_BUFFER_BYTES, 256 * 1024)
})

// ——————————————————————————————————————————————————————————————
// M4（PERF-MEM-REVIEW-2026-09-29 §4.1）：段数上限
// ——————————————————————————————————————————————————————————————

test('M4：逐字节回显不得撑出无界 segment 对象（字节上限挡不住这种形态）', () => {
  // 设备分页续读 / 逐字符回显：每 chunk 1 字节。字节上限 256KB 要 26 万个 chunk
  // 才触发，而那时段数早已是 26 万条对象（单设备 25~50MB）。
  const buf = new TerminalBuffer(DEFAULT_TERMINAL_BUFFER_BYTES, 64)
  for (let i = 0; i < 5000; i++) buf.append(utf8('x'), false)

  assert.ok(
    buf.segmentCount <= 64,
    `段数没有上界：${buf.segmentCount} 条（上限 64）`
  )
  // 字节计数必须与实际保留内容一致，否则下一次 trim 会算错
  assert.equal(
    buf.byteLength,
    buf.snapshot().reduce((n, s) => n + s.data.length, 0),
    'bytes 记账与实际段内容不符'
  )
})

test('M4：段数裁剪只能整段丢弃，不能切断（seq 仍严格单调）', () => {
  const buf = new TerminalBuffer(1024 * 1024, 3)
  buf.append(utf8('aaaaaa'), false)
  buf.append(utf8('bbbbbb'), false)
  buf.append(utf8('cccccc'), false)
  buf.append(utf8('dddddd'), false)

  assert.equal(buf.segmentCount, 3)
  // 最旧的那段被整段丢掉，留下后三段（内容不被切开）
  assert.deepEqual(
    buf.snapshot().map((s) => s.data),
    ['bbbbbb', 'cccccc', 'dddddd']
  )
})

test('M4：每个 chunk 的 seq 必须严格递增（渲染层靠它水位去重，复用会丢字节）', () => {
  const buf = new TerminalBuffer(1024 * 1024, 8)
  const seqs = []
  for (let i = 0; i < 40; i++) seqs.push(buf.append(utf8('x'), i % 2 === 0))

  assert.equal(new Set(seqs).size, 40, '出现了重复 seq：渲染层会把后到的那条静默丢弃')
  for (let i = 1; i < seqs.length; i++) {
    assert.equal(seqs[i], seqs[i - 1] + 1, `seq 不连续：${seqs[i - 1]} → ${seqs[i]}`)
  }
  // 最后一段的 seq 必须是最后一次 append 的编号（快照水位依赖它）
  assert.equal(buf.snapshot()[buf.snapshot().length - 1].seq, buf.lastSeq)
})
