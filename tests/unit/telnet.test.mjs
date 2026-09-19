import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TelnetClient } from '../.build/harness.mjs'
import { MockVrp } from '../mock-device/MockVrp.mjs'

/**
 * 通信层集成测试。全部跑在 Mock VRP 设备上，不依赖 eNSP 与 Electron。
 * 对应 docs/TELNET-SPEC.md §14.2 的清单。
 */

async function setup(mockOpts = {}, clientOpts = {}) {
  const mock = new MockVrp(mockOpts)
  const port = await mock.listen()
  const client = new TelnetClient(clientOpts)
  const info = await client.connect(port)
  return { mock, client, port, info }
}

async function teardown(ctx) {
  ctx.client.close()
  await ctx.mock.close()
}

test('握手：读到首个提示符、丢弃 banner、视图为 user', async () => {
  const ctx = await setup()
  try {
    assert.equal(ctx.info.prompt.raw, '<Huawei>')
    assert.equal(ctx.info.prompt.view, 'user')
    assert.equal(ctx.info.encoding, 'utf8')
    assert.ok(ctx.info.banner.includes('VTY'), 'banner 应被保留在返回值里供展示')
    assert.ok(
      ctx.mock.receivedCommands.some((c) => /screen-length 0 temporary/.test(c)),
      '连接后应主动尝试关闭分页'
    )
    assert.equal(ctx.info.pagingDisabled, true)
  } finally {
    await teardown(ctx)
  }
})

test('普通命令：强判定命中提示符，回显被清洗，正文完整', async () => {
  const ctx = await setup()
  try {
    const r = await ctx.client.exec('display version')
    assert.equal(r.ok, true)
    assert.equal(r.settled, 'prompt')
    assert.equal(r.prompt, '<Huawei>')
    assert.equal(r.view, 'user')
    assert.ok(r.clean.includes('AR2220'), '应保留型号')
    assert.ok(!r.clean.includes('display version'), '命令回显应被清除')
    assert.ok(!r.clean.includes('<Huawei>'), '尾部提示符应被移出 clean')
    assert.equal(r.awaitingConfirm, false)
  } finally {
    await teardown(ctx)
  }
})

test('分页：长输出自动续读空格直到提示符，内容不缺失', async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `config line ${i + 1}`)
  const ctx = await setup(
    {
      pageSize: 3,
      handlers: [{ match: /^display long$/i, respond: () => ({ text: lines.join('\r\n') }) }]
    },
    { disablePagingOnConnect: false }
  )
  try {
    const r = await ctx.client.exec('display long')
    assert.equal(r.ok, true)
    assert.equal(r.settled, 'prompt')
    for (const line of lines) {
      assert.ok(r.clean.includes(line), `分页续读后仍应包含：${line}`)
    }
    assert.ok(!r.clean.includes('More'), '分页标记不应残留在 clean 中')
  } finally {
    await teardown(ctx)
  }
})

test('错误命令：ok=false 且带结构化错误码（源项目最致命缺陷的回归测试）', async () => {
  const ctx = await setup()
  try {
    const r = await ctx.client.exec('displa')
    assert.equal(r.ok, false, '设备报错绝不能被当作成功返回')
    assert.equal(r.errorCode, 'UNRECOGNIZED')
    assert.ok(r.error?.includes('Unrecognized'))
  } finally {
    await teardown(ctx)
  }
})

test('参数错误：映射为 BAD_PARAM', async () => {
  const ctx = await setup()
  try {
    const r = await ctx.client.exec('bad param test')
    assert.equal(r.ok, false)
    assert.equal(r.errorCode, 'BAD_PARAM')
  } finally {
    await teardown(ctx)
  }
})

test('GBK 输出：编码自动判定为 gbk 且中文正确', async () => {
  const ctx = await setup()
  try {
    const r = await ctx.client.exec('display chinese')
    assert.equal(r.ok, true)
    assert.equal(ctx.client.encoding, 'gbk', '应识别出 GBK 而非把 D6D0 当合法 UTF-8')
    assert.equal(r.clean.trim(), '中文')
    assert.ok(!r.decodeIssues, '不应出现替换符')
  } finally {
    await teardown(ctx)
  }
})

test('慢响应：不被静默兜底提前收尾（回显后停顿的回归测试）', async () => {
  const ctx = await setup(
    {
      handlers: [{ match: /^slow$/i, respond: () => ({ text: 'the answer is 42', delayMs: 500 }) }]
    },
    { quietMs: 200, stallMs: 3000, timeoutMs: 8000 }
  )
  try {
    const r = await ctx.client.exec('slow')
    assert.equal(r.ok, true)
    assert.equal(r.settled, 'prompt', '必须等到提示符，而不是在 300ms 静默时提前收尾')
    assert.ok(r.clean.includes('the answer is 42'), '不能丢失输出内容')
  } finally {
    await teardown(ctx)
  }
})

test('确认提示：[Y/N] 被识别为等待确认，且绝不被自动应答', async () => {
  const ctx = await setup()
  try {
    const r = await ctx.client.exec('reboot')
    assert.equal(r.awaitingConfirm, true, '应标记为等待人工确认')
    assert.equal(r.settled, 'quiet')
    assert.ok(r.confirmText?.includes('[Y/N]'))
    await new Promise((r2) => setTimeout(r2, 120))
    assert.ok(
      !ctx.mock.receivedCommands.some((c) => /^[yYnN]$/.test(c.trim())),
      '绝不能代替用户回答确认提示'
    )
  } finally {
    await teardown(ctx)
  }
})

test('静默兜底：设备只回显不给提示符时，最终以弱判定收尾', async () => {
  const ctx = await setup(
    {
      handlers: [{ match: /^silent$/i, respond: () => ({ text: '', noPrompt: true }) }]
    },
    { quietMs: 150, stallMs: 700, timeoutMs: 5000 }
  )
  try {
    const r = await ctx.client.exec('silent')
    assert.equal(r.settled, 'quiet', '应标记为弱判定，让代理知道回显可能不完整')
    assert.equal(r.ok, true)
  } finally {
    await teardown(ctx)
  }
})

test('并发：同一设备 15 条命令严格串行，顺序与回显均不错乱', async () => {
  const ctx = await setup({
    handlers: [{ match: /^echo \d+$/i, respond: (cmd) => ({ text: `ack ${cmd}` }) }]
  })
  try {
    const order = Array.from({ length: 15 }, (_, i) => `echo ${i + 1}`)
    const results = await Promise.all(order.map((c) => ctx.client.exec(c)))

    for (let i = 0; i < order.length; i++) {
      assert.equal(results[i].ok, true, `第 ${i + 1} 条应成功`)
      assert.ok(results[i].clean.includes(`ack ${order[i]}`), `第 ${i + 1} 条回显错位`)
    }

    const seen = ctx.mock.receivedCommands.filter((c) => /^echo \d+$/.test(c))
    assert.deepEqual(seen, order, '设备实际收到的命令顺序必须与提交顺序一致')
  } finally {
    await teardown(ctx)
  }
})

test('中断：AbortSignal 生效且队列不被阻塞', async () => {
  const ctx = await setup(
    {
      handlers: [{ match: /^hang$/i, respond: () => ({ text: 'partial', noPrompt: true }) }]
    },
    { quietMs: 300, stallMs: 5000, timeoutMs: 10000 }
  )
  try {
    const ac = new AbortController()
    const p = ctx.client.exec('hang', { signal: ac.signal })
    setTimeout(() => ac.abort(), 200)
    const r = await p
    assert.equal(r.ok, false)
    assert.equal(r.errorCode, 'ABORTED')

    // 队列必须继续可用
    const after = await ctx.client.exec('display version')
    assert.equal(after.ok, true)
  } finally {
    await teardown(ctx)
  }
})

test('中途断线：当前命令返回 CLOSED，队列剩余项全部被拒绝，不留悬挂 Promise', async () => {
  const ctx = await setup(
    {
      handlers: [{ match: /^boom$/i, respond: () => ({ closeNow: true, text: '' }) }]
    },
    { timeoutMs: 4000 }
  )
  try {
    const results = await Promise.all([
      ctx.client.exec('boom'),
      ctx.client.exec('display version'),
      ctx.client.exec('display version')
    ])
    for (const r of results) {
      assert.equal(r.ok, false, '断线后的命令都不应报成功')
      assert.equal(r.errorCode, 'CLOSED')
    }

    // 连接已关闭，后续 exec 直接返回 CLOSED，不挂起
    const later = await ctx.client.exec('display version')
    assert.equal(later.errorCode, 'CLOSED')
  } finally {
    ctx.client.close()
    await ctx.mock.close()
  }
})

test('超长输出：截断并标记，不撑爆内存也不伪装成功', async () => {
  const big = Array.from({ length: 400 }, (_, i) => `line-${i}-${'x'.repeat(80)}`).join('\r\n')
  const ctx = await setup(
    { handlers: [{ match: /^display huge$/i, respond: () => ({ text: big }) }] },
    { maxBytes: 8192 }
  )
  try {
    const r = await ctx.client.exec('display huge')
    assert.equal(r.truncated, true, '应标记为被截断')
    assert.equal(r.errorCode, 'TRUNCATED')
    assert.ok(r.clean.length > 0, '截断后仍应保留可用内容')
  } finally {
    await teardown(ctx)
  }
})

test('命令回显含 ANSI 时不影响判定', async () => {
  const ctx = await setup({
    handlers: [
      {
        match: /^display color$/i,
        respond: () => ({ text: '\u001b[1;32mgreen text\u001b[0m' })
      }
    ]
  })
  try {
    const r = await ctx.client.exec('display color')
    assert.equal(r.ok, true)
    assert.ok(r.clean.includes('green text'))
    assert.ok(!r.clean.includes('\u001b'), 'ANSI 序列应被清除')
  } finally {
    await teardown(ctx)
  }
})
