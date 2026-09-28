import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  TelnetClient,
  JsonStore,
  SessionManager,
  createIacStripper,
  stripIac,
  encode,
  EncodeError,
  decode,
  parseNetwork,
  parseInterfaceBrief
} from '../.build/harness.mjs'
import { MockVrp } from '../mock-device/MockVrp.mjs'

/**
 * 通信层正确性（B4：N10 / N28 / N29 / N30 / N38 / N39）。
 *
 * 这些点的共同特征是「分片/时序/编码」层面的失真 —— 只在真机或长会话里偶发，
 * 靠人工点不出来，所以这里用**可控的假字节管道**与 MockVrp 把它们钉死。
 */

let seq = 0
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ensp-b4-${++seq}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs = 3000, stepMs = 25) {
  const until = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > until) return false
    await delay(stepMs)
  }
}

/** 可控的假字节管道：记录设备侧收到的每一个字节，并允许测试主动喂数据/断开 */
function fakeChannel() {
  const dataCbs = new Set()
  const closeCbs = new Set()
  const bytes = []
  return {
    writable: true,
    destroyed: false,
    bytes,
    write(data) {
      if (this.destroyed) return false
      for (const b of Uint8Array.from(data)) bytes.push(b)
      return true
    },
    destroy() {
      this.destroyed = true
      this.writable = false
    },
    onData(cb) {
      dataCbs.add(cb)
      return () => dataCbs.delete(cb)
    },
    onClose(cb) {
      closeCbs.add(cb)
      return () => closeCbs.delete(cb)
    },
    onError() {
      return () => {}
    },
    /** 设备 → 客户端 */
    emit(text) {
      const buf = Buffer.from(text, 'utf8')
      for (const cb of dataCbs) cb(new Uint8Array(buf))
    },
    /** 设备侧断开 */
    drop() {
      for (const cb of closeCbs) cb()
    },
    text() {
      return Buffer.from(bytes).toString('utf8')
    }
  }
}

/** 建一个握手完成的 TelnetClient（关分页关闭，避免额外命令干扰断言） */
async function connectedClient(ch, options = {}) {
  const client = new TelnetClient({
    disablePagingOnConnect: false,
    connectTimeoutMs: 3000,
    timeoutMs: 3000,
    quietMs: 60,
    ...options
  })
  const p = client.connectChannel(ch)
  ch.emit('<Huawei>')
  await p
  return client
}

// ———————————————————————————— N28：分片协商序列 ————————————————————————————

test('N28 stripIac：协商序列被切成 3 片时不再泄漏成正文', () => {
  const strip = createIacStripper()
  // IAC WILL ECHO 被切在 3 个位置
  assert.equal(strip.push(Buffer.from([0xff])).length, 0)
  assert.equal(strip.push(Buffer.from([0xfb])).length, 0)
  const out = strip.push(Buffer.from([0x01, ...Buffer.from('hi', 'utf8')]))
  assert.equal(out.toString('utf8'), 'hi', '协商字节不得漏进正文')
})

test('N28 stripIac：子协商（SB…SE）跨片、以及尾部转义 0xFF 跨片', () => {
  const strip = createIacStripper()
  assert.equal(strip.push(Buffer.from([0xff, 0xfa, 0x01])).length, 0) // SB 未结束
  const out = strip.push(Buffer.from([0x02, 0xff, 0xf0, ...Buffer.from('ok', 'utf8')]))
  assert.equal(out.toString('utf8'), 'ok')

  const s2 = createIacStripper()
  assert.equal(s2.push(Buffer.from([0xff])).length, 0)
  assert.deepEqual([...s2.push(Buffer.from([0xff]))], [0xff], '转义 0xFF 应还原为单个字节')
})

test('N28 stripIac：一次性 stripIac 仍与旧行为一致（完整序列/单字节命令）', () => {
  const input = Buffer.concat([
    Buffer.from([0xff, 0xfb, 0x01]),
    Buffer.from('hello', 'utf8'),
    Buffer.from([0xff, 0xf1]), // 两字节命令 NOP
    Buffer.from(' world', 'utf8')
  ])
  assert.equal(stripIac(input).toString('utf8'), 'hello world')
})

// ———————————————————————————— N10：出站编码 ————————————————————————————

test('N10 encode：utf8 与旧的 Buffer.from(str) 逐字节一致', () => {
  for (const s of ['display version\r\n', 'sysname 核心交换机\r\n', '\x03']) {
    assert.deepEqual([...encode(s, 'utf8')], [...Buffer.from(s, 'utf8')])
  }
})

test('N10 encode：gbk 往返等于原字节；无法映射的字符显式抛错（不静默替换）', () => {
  const bytes = encode('测试 中文\r\n', 'gbk')
  const back = decode(bytes, 'gbk')
  assert.equal(back.text, '测试 中文\r\n')
  assert.equal(back.issues, false)
  // 制表符/控制字符必须原样直通
  assert.deepEqual([...encode('\r\n\x03', 'gbk')], [0x0d, 0x0a, 0x03])
  // 表情符号不在 GBK 里 → 抛错（而不是变成 '?' 存进设备配置）
  assert.throws(() => encode('😀', 'gbk'), EncodeError)
})

test('N10 出站默认仍是 utf8（未声明设备字符集时字节不变）', async () => {
  const ch = fakeChannel()
  const client = await connectedClient(ch)
  const before = ch.bytes.length
  await client.exec('sysname 测试', { timeoutMs: 150 })
  // 假管道不会回提示符，命令等超时才结算；字节在超时前就已下发
  const sent = ch.text().slice(before)
  assert.ok(sent.startsWith('sysname 测试\r\n'), `应按 utf8 下发：${JSON.stringify(sent)}`)
  client.close()
})

test('N10 出站编码跟随显式声明：outboundEncoding=gbk 时按 GBK 下发', async () => {
  const ch = fakeChannel()
  const client = await connectedClient(ch, { outboundEncoding: 'gbk' })
  const before = ch.bytes.length
  await client.exec('sysname 测试', { timeoutMs: 150 })
  const sent = ch.bytes.slice(before)
  const expected = [...encode('sysname 测试\r\n', 'gbk')]
  assert.deepEqual(sent.slice(0, expected.length), expected, '应按 GBK 下发')
  client.close()
})

// ———————————————————————————— N29：逐字节定时器可取消 ————————————————————————————

test('N29 charDelayMs：中断后旧 payload 的剩余字节不再下发（不与新命令交错）', async () => {
  const ch = fakeChannel()
  const client = await connectedClient(ch, { charDelayMs: 15 })
  const before = ch.bytes.length

  const ac = new AbortController()
  const p = client.exec('display interface brief', { signal: ac.signal, timeoutMs: 5000 })
  await delay(70) // 让几个字节先出去
  const mid = ch.bytes.length
  assert.ok(mid > before && mid < before + 24, `应处于逐字节慢发中途，实际 ${mid - before} 字节`)
  ac.abort()
  await p
  const afterAbort = ch.bytes.length

  await delay(250) // 远超剩余字节「本该发完」的时间
  assert.equal(ch.bytes.length, afterAbort, '中断后不得再有旧 payload 的字节下发')

  // 已下发的必须只是 payload 的前缀（末尾那个字节是中断用的 Ctrl+C）
  const text = ch.text().slice(before)
  const idx = text.lastIndexOf('\x03')
  assert.ok(idx >= 0, '中断应向设备发 Ctrl+C')
  assert.equal(text.slice(idx + 1), '', 'Ctrl+C 之后不应再有旧命令的字节')
  assert.ok('display interface brief\r\n'.startsWith(text.slice(0, idx)), '已发部分必须是原命令的前缀')
  client.close()
})

// ———————————————————————————— N30：远端断开清理 ————————————————————————————

test('N30 远端断开：会话与设备锁都被清理，并广播离线状态', async (t) => {
  const dir = tmpDir(t)
  const store = new JsonStore(path.join(dir, 'settings.json'))
  const mock = new MockVrp({})
  const port = await mock.listen()
  const closed = []
  const states = []
  const mgr = new SessionManager(store, {
    getSettings: () => store.getSettings(),
    onRaw: () => {},
    onClosed: (deviceId, reason) => closed.push({ deviceId, reason }),
    onStateChanged: (d) => states.push(d)
  })
  try {
    const dev = await mgr.connect(port)
    const id = dev.id
    assert.ok(mgr.get(id), '连接后应持有会话')
    assert.equal(mgr.tryAcquireDevice(id, 'test-owner'), true)
    assert.ok(mgr.deviceLockHolder(id), '应持有设备锁')
    states.length = 0

    mock.killConnections() // 设备侧把 socket 断掉（不走 disconnect()）

    assert.equal(
      await waitFor(() => !mgr.get(id)),
      true,
      '远端断开后必须清理 sessions（否则含最大 256KB 回放缓冲的 DeviceSession 常驻）'
    )
    assert.equal(mgr.deviceLockHolder(id), undefined, '设备锁必须一并释放')
    assert.equal(closed.length, 1, '应转发 onClosed（渲染层要收 terminal-closed）')
    assert.ok(
      states.some((d) => d.id === id && d.connected === false),
      '应广播一次离线状态，否则界面继续显示「已连接」'
    )
  } finally {
    await mock.close()
  }
})

// ———————————————————————————— N38 / N39：解析器 ————————————————————————————

test('N38 parseNetwork：首字节 ≥128 的网段不再产出负数', () => {
  const n = parseNetwork('128.0.0.0/1')
  assert.ok(n)
  assert.ok(n.base >= 0, `base 必须无符号，实际 ${n.base}`)
  assert.equal(n.base, 0x80000000)
  assert.equal(parseNetwork('255.255.255.0/24').base, 0xffffff00)
  assert.equal(parseNetwork('0.0.0.0/0').base, 0)
})

test('N39 parseInterfaceBrief：默认表（无 Description 列）不再把 InUti 等数字当描述', () => {
  const text = [
    'Interface                         PHY   Protocol InUti OutUti  inErrors  outErrors',
    'GE0/0/1                           up    up      0%    0%      0         0'
  ].join('\n')
  const rows = parseInterfaceBrief(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].description, undefined, '不应把剩余列当 description（假字段）')

  const withDesc = [
    'Interface                         PHY   Protocol Description',
    'GE0/0/1                           up    up       上联口 To-Core'
  ].join('\n')
  assert.equal(parseInterfaceBrief(withDesc)[0].description, '上联口 To-Core')
})