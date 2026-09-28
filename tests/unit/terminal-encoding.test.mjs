import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamDecoder, TelnetClient, DeviceSession } from '../.build/harness.mjs'
import { MockVrp } from '../mock-device/MockVrp.mjs'

/**
 * 终端中文显示（v2.25，2026-09-28）。
 *
 * 用户报的现象：设备 `language-mode chinese` 之后，终端里的中文全是乱码，
 * 而且设置里**无论选 utf8 还是 gbk 都一样**。
 *
 * 根因：xterm.js 的输入解码器只认 UTF-8，而设备切中文后回显是 GBK。
 * 「把原始字节丢给 xterm、让它按设备字节渲染」这个口径在高位字节上根本不成立 ——
 * lib/xterm.mjs 的 Utf8ToUtf32 遇到非法续接字节直接跳过，于是
 * 「是否更改当前语言环境，确认切换？」被解成 `ǷĵǰԻȷл`（拉丁扩展/希腊/西里尔字母，
 * 缺字形的地方还渲染成 `?`）。而 deviceEncoding 那条设置当时**只作用于主进程的
 * 业务解码**，终端那条线完全没接它 —— 所以选哪个都一样乱。
 *
 * 本用例守四件事：
 *   1. 字节 → 文本必须按设备回显编码解（GBK 出中文，UTF-8 不了）；
 *   2. 解码必须**有状态**：汉字被 TCP 分片劈开时不能吐替换符；
 *   3. 编码判定要**先于**原始字节广播 —— 否则第一段中文（language-mode 的 [Y/N] 提示）
 *      会按旧编码解释，屏幕上的第一句中文永远乱码；
 *   4. 设置里的编码偏好要能**即时**作用到活动会话（用户改完就盯着屏幕看）。
 */

/** 「是否更改当前语言环境，确认切换？」的 GBK 字节（用 Python 的 gbk 编解码器核对过） */
const GBK_PROMPT = new Uint8Array([
  0xca, 0xc7, 0xb7, 0xf1, 0xb8, 0xfc, 0xb8, 0xc4, 0xb5, 0xb1, 0xc7, 0xb0, 0xd3, 0xef, 0xd1, 0xd4,
  0xbb, 0xb7, 0xbe, 0xb3, 0xa3, 0xac, 0xc8, 0xb7, 0xc8, 0xcf, 0xc7, 0xd0, 0xbb, 0xbb, 0xa3, 0xbf
])
const PROMPT_TEXT = '是否更改当前语言环境，确认切换？'
/** 「中文」的 GBK 字节（与 mock 设备的 display chinese 一致） */
const GBK_ZHONGWEN = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])

test('StreamDecoder：GBK 字节解出中文，UTF-8 解不出来（这就是过去的乱码）', () => {
  const gbk = createStreamDecoder('gbk')
  assert.equal(gbk.push(GBK_PROMPT), PROMPT_TEXT)
  assert.equal(createStreamDecoder('gbk').push(GBK_ZHONGWEN), '中文')

  // 复现修复前的行为：同一串字节按 UTF-8 解 → 满屏替换符/拉丁扩展字母，绝不是中文
  const utf8 = createStreamDecoder('utf8')
  const mojibake = utf8.push(GBK_PROMPT)
  assert.notEqual(mojibake, PROMPT_TEXT)
  assert.ok(mojibake.includes('\uFFFD'), '非法字节必须显形为替换符，不能静默丢掉')
})

test('StreamDecoder：汉字被分片劈开时不吐替换符（有状态解码）', () => {
  const dec = createStreamDecoder('gbk')
  // 「中」= D6 D0 被切成两片
  assert.equal(dec.push(GBK_ZHONGWEN.subarray(0, 1)), '', '半截汉字不能立刻产出字符')
  assert.equal(dec.push(GBK_ZHONGWEN.subarray(1)), '中文')

  const u8 = createStreamDecoder('utf8')
  const bytes = new TextEncoder().encode('中文')
  // 「中」= E4 B8 AD，按 3 字节边界切：第一片正好一个完整字
  assert.equal(u8.push(bytes.subarray(0, 3)), '中')
  assert.equal(u8.push(bytes.subarray(3)), '文')
  // 落在字中间（E4 B8）也不能吐替换符：留下来等下一片
  const u8b = createStreamDecoder('utf8')
  assert.equal(u8b.push(bytes.subarray(0, 2)), '')
  assert.equal(u8b.push(bytes.subarray(2)), '中文', '续接字节到齐后要还原成完整汉字，不得出现 U+FFFD')
})

test('StreamDecoder：切换编码必须丢掉旧解码器的待续状态', () => {
  const dec = createStreamDecoder('utf8')
  dec.push(GBK_ZHONGWEN.subarray(0, 1)) // 留一个半截字节在内部
  dec.setEncoding('gbk')
  assert.equal(dec.encoding, 'gbk')
  assert.equal(dec.push(GBK_ZHONGWEN), '中文', '旧编码的残留字节不得污染新编码的输出')
})

/** 极简假管道：直接往 client 里灌字节（交互通道测试用） */
function fakeChannel() {
  const written = []
  const subs = {}
  return {
    written,
    writable: true,
    write(b) {
      written.push(Buffer.from(b))
      return true
    },
    destroy() {},
    onData(cb) {
      subs.data = cb
      return () => {}
    },
    onClose(cb) {
      subs.close = cb
      return () => {}
    },
    onError(cb) {
      subs.error = cb
      return () => {}
    },
    emit(bytes) {
      subs.data?.(Buffer.from(bytes))
    }
  }
}

test('TelnetClient：原始字节广播带上判定后的编码（判定先于广播）', async () => {
  const mock = new MockVrp({})
  const port = await mock.listen()
  const client = new TelnetClient({ quietMs: 60, stallMs: 400 })
  /** 带高位字节的原始片 + **回调当刻**客户端认定的编码（TCP 分片不保证一片到底） */
  const seen = []
  client.onRawData((chunk) => {
    if (chunk.some((b) => b > 0x7f)) seen.push({ enc: client.currentEncoding, chunk })
  })
  try {
    await client.connect(port)
    const r = await client.exec('display chinese')
    assert.equal(r.ok, true)

    assert.ok(seen.length >= 1, 'GBK 回显应当被广播出来')
    assert.ok(
      seen.every((s) => s.enc === 'gbk'),
      '★ 这些片必须已按 gbk 打标，否则终端第一句中文就乱'
    )
    // TCP 可能把命令回显、GBK 正文、提示符粘成一片 —— 只要这一片被标成 gbk，
    // 整片（含 ASCII 部分）按 GBK 解就是对的（ASCII 在两种编码下等价）
    const joined = Buffer.concat(seen.map((s) => Buffer.from(s.chunk)))
    assert.ok(
      createStreamDecoder('gbk').push(joined).includes('中文'),
      '按打标编码解码必须得到中文'
    )
  } finally {
    client.close()
    await mock.close()
  }
})

test('TelnetClient：setEncodingPref 即时生效（显式声明锁死 / auto 交回探测）', async () => {
  const chan = fakeChannel()
  const client = new TelnetClient({ disablePagingOnConnect: false, connectNudgeMs: 5, quietMs: 40 })
  const p = client.connectChannel(chan)
  chan.emit('<Huawei>')
  await p
  try {
    // 纯 ASCII 握手后仍是 auto 判定的 utf8
    assert.equal(client.currentEncoding, 'utf8')

    client.setEncodingPref('gbk')
    assert.equal(client.currentEncoding, 'gbk', '显式声明要立刻生效，不必等下一片回显')

    // 出站编码同步跟随：终端里敲中文要按 GBK 下发（设备此刻正是 GBK 中文模式）
    const before = chan.written.length
    client.writeInteractive('中')
    const sent = Buffer.concat(chan.written.slice(before))
    assert.deepEqual(
      [...sent],
      [0xd6, 0xd0],
      '声明 GBK 后，交互通道下发的中文必须编成 GBK 字节'
    )

    client.setEncodingPref('auto')
    assert.equal(client.currentEncoding, 'gbk', 'auto 只是解锁，当前判定值保留到有新证据')
    client.setEncodingPref('gbk')
    assert.equal(client.currentEncoding, 'gbk')
  } finally {
    client.close()
  }
})

test('DeviceSession：回放快照带回当前编码，并随判定更新 + 广播状态', async () => {
  const mock = new MockVrp({})
  const port = await mock.listen()
  const states = []
  const rawEncs = []
  const { session } = await DeviceSession.open(
    port,
    'IT',
    {},
    {
      onRaw: (_id, _chunk, _fromAgent, _seq, encoding) => rawEncs.push(encoding),
      onClosed() {},
      onStateChanged: (d) => states.push(d.encoding)
    }
  )
  try {
    assert.equal(session.terminalBuffer().encoding, 'utf8', '握手阶段只有 ASCII')

    await session.exec('display chinese')
    assert.equal(session.encoding, 'gbk')
    assert.equal(session.terminalBuffer().encoding, 'gbk', '快照必须带上编码，字节本身不带')
    assert.ok(rawEncs.includes('gbk'), 'onRaw 要把编码一起交出去（终端靠它解码）')
    assert.ok(states.includes('gbk'), '编码锁定要广播状态，界面状态栏才不是死的')

    // 设置里改成强制 utf8 → 会话即时跟随（无需重连），终端据此重画整屏
    session.setEncodingPref('utf8')
    assert.equal(session.terminalBuffer().encoding, 'utf8')
  } finally {
    session.close()
    await mock.close()
  }
})
