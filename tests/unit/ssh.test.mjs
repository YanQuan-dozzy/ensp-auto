import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { TelnetClient, connectSsh, parseDeviceId, deviceIdForSsh } from '../.build/harness.mjs'
import { MockSshVrp } from '../mock-device/MockSshVrp.mjs'

/**
 * SSH 传输层集成测试。
 *
 * 核心断言：TelnetClient 的状态机（队列/提示符/分页/编码/清洗）在 SSH 字节管道上
 * 与 telnet 完全一致 —— 复用 MockSshVrp（ssh2 Server 端模拟 VRP），不依赖 eNSP。
 * 对应 docs/TELNET-SPEC.md §14.2 的清单，走 SSH 协议重跑一遍关键场景。
 */

const USER = 'admin'
const PASS = 'secret123'

function genKey(opts = {}) {
  return generateKeyPairSync('rsa', { modulusLength: 1024, ...opts }).privateKey.export({
    type: 'pkcs1',
    format: 'pem'
  })
}

async function setup(mockOpts = {}, clientOpts = {}) {
  const mock = new MockSshVrp({
    username: USER,
    password: PASS,
    ...mockOpts
  })
  const port = await mock.listen()
  const ch = await connectSsh({
    host: '127.0.0.1',
    port,
    username: USER,
    auth: { type: 'password', password: PASS }
  })
  const client = new TelnetClient(clientOpts)
  const info = await client.connectChannel(ch)
  return { mock, client, port, info, ch }
}

async function teardown(ctx) {
  ctx.client.close()
  await ctx.mock.close()
}

test('SSH 密码认证：握手读提示符 + 关分页 + 执行命令', async () => {
  const ctx = await setup()
  try {
    assert.equal(ctx.mock.authMethod, 'password')
    assert.equal(ctx.mock.authUser, USER)
    assert.equal(ctx.info.prompt.raw, '<Huawei>')
    assert.equal(ctx.info.prompt.view, 'user')
    assert.ok(ctx.mock.receivedCommands.some((c) => /screen-length 0 temporary/.test(c)))
    const r = await ctx.client.exec('display version')
    assert.equal(r.ok, true)
    assert.equal(r.settled, 'prompt')
    assert.equal(r.prompt, '<Huawei>')
    assert.ok(r.clean.includes('AR2220'), 'SSH 通道回显与 telnet 一致')
  } finally {
    await teardown(ctx)
  }
})

test('SSH 私钥 + passphrase 认证成功', async () => {
  const passphrase = 'pp-1234'
  const key = genKey({ cipher: 'aes-128-cbc', passphrase })
  const mock = new MockSshVrp({ username: USER, password: PASS })
  const port = await mock.listen()
  try {
    const ch = await connectSsh({
      host: '127.0.0.1',
      port,
      username: USER,
      auth: { type: 'privateKey', key, passphrase }
    })
    const client = new TelnetClient()
    const info = await client.connectChannel(ch)
    assert.equal(info.prompt.raw, '<Huawei>')
    assert.equal(mock.authMethod, 'publickey')
    client.close()
  } finally {
    await mock.close()
  }
})

test('SSH 错误密码：连接被拒，不悬挂', async () => {
  const mock = new MockSshVrp({ username: USER, password: PASS })
  const port = await mock.listen()
  try {
    await assert.rejects(
      connectSsh({
        host: '127.0.0.1',
        port,
        username: USER,
        auth: { type: 'password', password: 'wrong-password' }
      })
    )
  } finally {
    await mock.close()
  }
})

test('SSH 断线：onClose 触发，队列剩余项结算为 CLOSED', async () => {
  const ctx = await setup()
  try {
    const p = ctx.client.exec('display version')
    // 掐断 server 侧连接（模拟远端断开）
    ctx.mock.killConnections()
    const r = await p
    assert.equal(r.ok, false)
    assert.equal(r.errorCode, 'CLOSED')
    assert.equal(ctx.client.isClosed, true)
    // 后续命令直接返回 CLOSED，不悬挂
    const r2 = await ctx.client.exec('display version')
    assert.equal(r2.errorCode, 'CLOSED')
  } finally {
    await teardown(ctx)
  }
})

test('SSH 通道分页续读：长输出自动推进不缺失', async () => {
  const lines = Array.from({ length: 8 }, (_, i) => `ssh config line ${i + 1}`)
  const ctx = await setup(
    { pageSize: 2, handlers: [{ match: /^display long$/i, respond: () => ({ text: lines.join('\r\n') }) }] },
    { disablePagingOnConnect: false }
  )
  try {
    const r = await ctx.client.exec('display long')
    assert.equal(r.ok, true)
    assert.equal(r.settled, 'prompt')
    for (const line of lines) assert.ok(r.clean.includes(line), `分页续读后应包含：${line}`)
    assert.ok(!r.clean.includes('More'))
  } finally {
    await teardown(ctx)
  }
})

test('SSH 通道 GBK 输出：编码自适配，中文无替换符', async () => {
  const ctx = await setup()
  try {
    const r = await ctx.client.exec('display chinese')
    assert.equal(r.ok, true)
    assert.equal(r.decodeIssues, undefined, 'GBK 中文应无需替换符')
    assert.ok(r.clean.length > 0)
  } finally {
    await teardown(ctx)
  }
})

test('SSH 通道确认提示：[Y/N] 不被自动应答', async () => {
  const ctx = await setup()
  try {
    const r = await ctx.client.exec('reboot')
    assert.equal(r.awaitingConfirm, true, '应标记为等待人工确认')
    assert.equal(r.settled, 'quiet')
    assert.ok(r.confirmText?.includes('[Y/N]'))
  } finally {
    await teardown(ctx)
  }
})

test('SSH 通道慢响应：静默兜底不提前收尾', async () => {
  const ctx = await setup({ delayMs: 400 })
  try {
    const r = await ctx.client.exec('display version')
    assert.equal(r.ok, true)
    assert.equal(r.settled, 'prompt')
  } finally {
    await teardown(ctx)
  }
})

test('parseDeviceId：telnet 与 ssh 双格式', () => {
  assert.deepEqual(parseDeviceId('127.0.0.1:2008'), { transport: 'telnet', host: '127.0.0.1', port: 2008 })
  assert.deepEqual(parseDeviceId('ssh:192.168.1.10:22'), { transport: 'ssh', host: '192.168.1.10', port: 22 })
  assert.equal(deviceIdForSsh('192.168.1.10', 22), 'ssh:192.168.1.10:22')
  // 非法输入
  assert.equal(parseDeviceId(''), null)
  assert.equal(parseDeviceId('2008'), null)
  assert.equal(parseDeviceId('ssh:host'), null)
  assert.equal(parseDeviceId('ssh:host:99999'), null) // 端口越界
  assert.equal(parseDeviceId('ssh:2008'), null)
  // IPv6 冒号整体拒绝（首版不做 IPv6）
  assert.equal(parseDeviceId('ssh:[::1]:22'), null)
})

test('ByteChannel 内存 mock：仅靠接口即可驱动完整状态机', async () => {
  class FakeChannel {
    constructor() {
      this.written = []
    }
    write(data) {
      this.written.push(Buffer.from(data))
      return true
    }
    get writable() {
      return true
    }
    destroy() {
      this.closed = true
    }
    onData(cb) {
      this.dataCb = cb
      return () => {}
    }
    onClose() {
      return () => {}
    }
    onError() {
      return () => {}
    }
    emit(text) {
      this.dataCb?.(Buffer.from(text))
    }
  }

  const ch = new FakeChannel()
  const client = new TelnetClient()
  const handshake = client.connectChannel(ch)
  // 喂 banner + 首个提示符
  ch.emit('Info: The max number of VTY users is 10.\r\n<Huawei>')
  const info = await handshake
  assert.equal(info.prompt.raw, '<Huawei>')
  assert.equal(info.prompt.view, 'user')

  // 程序通道：命令被写入 + 回显驱动状态机
  const p = client.exec('display version')
  ch.emit(
    'display version\r\nHuawei Versatile Routing Platform Software\r\nVRP (R) software, Version 5.170\r\n<Huawei>'
  )
  const r = await p
  assert.equal(r.ok, true)
  assert.equal(r.settled, 'prompt')
  assert.ok(r.clean.includes('VRP'))
  assert.ok(!r.clean.includes('display version'), '命令回显应被清洗')
  assert.equal(ch.written.some((b) => b.toString('utf8').startsWith('display version')), true)
  client.close()
})