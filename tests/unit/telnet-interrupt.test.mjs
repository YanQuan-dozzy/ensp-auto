import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TelnetClient } from '../.build/harness.mjs'

/**
 * D11 / D12 / D13（2026-09-23，B4）：TelnetClient 交互及时序缺陷。
 *
 * - D11（STILL-OPEN R13）：中止命令后从不发中断序列（全仓无 Ctrl+C），
 *   设备的迟到输出会污染下一条命令的缓冲区。修复：abort 时发 \x03 并留 draining 窗口。
 * - D12（STILL-OPEN R42）：程序命令执行中的空行回车仍直写 socket（且不解除 confirmPaused）。
 *   修复：按「程序执行中 / 停 [Y/N] / 平时」三种情况分流。
 * - D13：多行粘贴只有第一行插队，后续行排到队尾 → 顺序反转。
 *   修复：批量整体前插/追加。
 *
 * 全部用 fake ByteChannel 驱动（握手回 '<Huawei>'，无需真设备 / Mock）。
 */

function fakeChannel() {
  const writtenBufs = []
  const subs = {}
  return {
    writtenBufs,
    hex() {
      return writtenBufs.map((b) => Buffer.from(b).toString('hex')).join('|')
    },
    writable: true,
    write(b) {
      writtenBufs.push(Buffer.from(b))
      return true
    },
    destroy() {},
    onData(cb) {
      subs.data = cb
      return () => {
        subs.data = null
      }
    },
    onClose(cb) {
      subs.close = cb
      return () => {
        subs.close = null
      }
    },
    onError(cb) {
      subs.error = cb
      return () => {
        subs.error = null
      }
    },
    emit(chunk) {
      subs.data?.(Buffer.from(chunk))
    }
  }
}

async function connectFake(opts = {}) {
  const chan = fakeChannel()
  const client = new TelnetClient({
    disablePagingOnConnect: false,
    connectNudgeMs: 5,
    quietMs: 40,
    stallMs: 200,
    ...opts
  })
  const p = client.connectChannel(chan)
  // 与真实设备一致：提示符单独成帧（无尾随换行）—— MockVrp 也是直接 write 提示符
  chan.emit('<Huawei>')
  await p
  return { client, chan }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ———————————————————————— D11：abort 发中断序列 ————————————————————————

test('D11：abort 向设备发 Ctrl+C（\\x03），并留排空窗口延迟后续命令', async () => {
  const { client, chan } = await connectFake()
  try {
    const ac = new AbortController()
    const p = client.exec('display long', { signal: ac.signal })
    const before = chan.writtenBufs.length
    assert.ok(before >= 1, '命令应已被写出')
    ac.abort()
    const r = await p
    assert.equal(r.errorCode, 'ABORTED')

    const last = chan.writtenBufs[chan.writtenBufs.length - 1]
    assert.equal(last[0], 3, '中止后应发出中断序列 \\x03（旧实现全仓任何地方都不发）')

    // 排空窗口（quietMs=40）内：下一条命令不得被写出
    const p2 = client.exec('second')
    p2.catch(() => {})
    await sleep(20)
    const sawSecond = chan.writtenBufs.some((b) => b.includes('second'))
    assert.equal(sawSecond, false, 'draining 窗口内不得推进队列')

    // 超过 quietMs 后：队列应继续推进
    await sleep(80)
    assert.ok(
      chan.writtenBufs.some((b) => b.includes('second')),
      '排空后应写出后续命令'
    )
  } finally {
    client.close()
  }
})

test('D11：abort 时应同时解除 confirmPaused（设备若停在 [Y/N] 不留死局）', async () => {
  const { client } = await connectFake()
  try {
    const ac = new AbortController()
    const p = client.exec('delete x', { signal: ac.signal })
    p.catch(() => {})
    client.confirmPaused = true // 模拟设备此刻弹出 [Y/N] 把队列挂起
    ac.abort()
    await p
    assert.equal(client.isAwaitingConfirm, false, 'abort 必须解除挂起')
  } finally {
    client.close()
  }
})

// ———————————————————————— D12：空行回车分流 ————————————————————————

test('D12：程序命令执行中的空行回车只缓冲不直写 socket', async () => {
  const { client, chan } = await connectFake()
  try {
    const p = client.exec('display running')
    p.catch(() => {})
    const before = chan.writtenBufs.length
    const r = client.writeInteractive('\r')
    assert.equal(r.queued, true)
    assert.equal(chan.writtenBufs.length, before, '空行回车不得直写 socket（旧实现会写）')
  } finally {
    client.close()
  }
})

test('D12：停在 [Y/N] 时的空行回车走队列插队应答（解除挂起、写入回车）', async () => {
  const { client, chan } = await connectFake()
  try {
    client.confirmPaused = true
    const r = client.writeInteractive('\r')
    assert.equal(r.accepted, true)
    assert.equal(client.isAwaitingConfirm, false, '回车应解除挂起')
    const last = chan.writtenBufs[chan.writtenBufs.length - 1].toString()
    assert.ok(last.includes('\r\n'), '应答项应经 writeCommand 写出回车（而不是绕过队列直写）')
  } finally {
    client.close()
  }
})

// ———————————————————————— D13：多行粘贴顺序 ————————————————————————

test('D13：confirm 场景多行粘贴整体前插，粘贴顺序与执行顺序一致', async () => {
  const { client } = await connectFake()
  try {
    // 制造「队列里有待执行命令、active 为空」的状态（confirmPaused 挂起泵）
    client.confirmPaused = true
    const mk = () => {
      let res, rej
      const p = new Promise((r, j) => {
        res = r
        rej = j
      })
      p.catch(() => {})
      return { p, res, rej }
    }
    const x = mk()
    const y = mk()
    client.queue.push({
      id: 'x',
      kind: 'program',
      command: 'x',
      enqueuedAt: 0,
      timeoutMs: 1000,
      resolve: x.res,
      reject: x.rej
    })
    client.queue.push({
      id: 'y',
      kind: 'program',
      command: 'y',
      enqueuedAt: 0,
      timeoutMs: 1000,
      resolve: y.res,
      reject: y.rej
    })

    const r = client.writeInteractive('a\nb\n')
    assert.equal(r.accepted, true)
    // 旧的逐行 enqueue：'a' unshift 后 pump 立即置 active，'b' 排到队尾 → a,x,y,b 错序。
    // 修复后整体前插：a,b,x,y，且 'a' 被 pump 拉起为 active。
    assert.equal(client.active?.item?.command, 'a', '第一行应最先执行')
    assert.deepEqual(
      client.queue.map((i) => i.command),
      ['b', 'x', 'y'],
      '其余行应按粘贴顺序跟在后面'
    )
  } finally {
    client.close()
  }
})

test('D13：平时粘贴（非 confirm）追加到队尾，行序保持', async () => {
  const { client } = await connectFake()
  try {
    client.queue = []
    client.writeInteractive('a\nb\n')
    assert.equal(client.active?.item?.command, 'a')
    assert.deepEqual(client.queue.map((i) => i.command), ['b'])
  } finally {
    client.close()
  }
})