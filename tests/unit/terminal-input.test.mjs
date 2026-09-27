import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TelnetClient } from '../.build/harness.mjs'

/**
 * 终端交互通道语义（2026-09-25）。
 *
 * 用户报的三个症状里有两个落在这里：
 * - 「用户不能在终端自行输入内容」：设备被代理占用时按键只落在主进程缓冲、不回显；
 * - 「回车键也不能正常发送出去」：直写分支把字符也累加进 interactiveLine，
 *   回车时整行又入队发一遍 → 设备收到 `disp` + `disp\r\n`。
 *
 * 修订后的语义：
 * - 空闲：逐字符直写，interactiveLine 保持为空（它只登记「设备还没收到的字符」）；
 * - 占用（[Y/N] 挂起 / 程序命令在跑 / 队列非空）：只缓冲，一个字节都不发；
 * - 回车：入队整行；若设备行缓冲已有用户直写的内容，只补一个回车，绝不重发整行。
 */

function fakeChannel() {
  const writtenBufs = []
  const subs = {}
  return {
    writtenBufs,
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
  chan.emit('<Huawei>')
  await p
  return { client, chan }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 取第 base 条之后写出的全部字节（拼成字符串），避开握手/代理命令自身的写出 */
const sentSince = (chan, base) => chan.writtenBufs.slice(base).map((b) => b.toString()).join('')

test('空闲时逐字符直写，回车只补一个回车（不得把整行重复发一遍）', async () => {
  const { client, chan } = await connectFake()
  try {
    const base = chan.writtenBufs.length
    for (const ch of 'disp') {
      assert.equal(client.writeInteractive(ch).queued, false, '空闲时应直写而非入队')
    }
    assert.equal(sentSince(chan, base), 'disp')

    client.writeInteractive('\r')
    await sleep(10)
    // 旧实现这里是 'disp' + 'disp\r\n'（命令被发两遍）
    assert.equal(sentSince(chan, base), 'disp\r\n', '已直写的整行不得再次下发')
  } finally {
    client.close()
  }
})

test('空闲回车也会走一次队列判定（writeCommand 写出回车，设备弹 [Y/N] 才能被挂起）', async () => {
  const { client, chan } = await connectFake()
  try {
    const base = chan.writtenBufs.length
    client.writeInteractive('\r')
    await sleep(10)
    assert.equal(sentSince(chan, base), '\r\n')
    assert.equal(client.queueLength <= 1, true, '回车作为一条队列项出现（已开始执行）')
  } finally {
    client.close()
  }
})

test('空闲粘贴多行：逐行入队且顺序保持（不得整段直写）', async () => {
  const { client, chan } = await connectFake()
  try {
    const r = client.writeInteractive('a\r\nb\r\n')
    assert.equal(r.queued, false)
    assert.equal(client.active?.item?.command, 'a')
    assert.deepEqual(
      client.queue.map((i) => i.command),
      ['b']
    )
  } finally {
    client.close()
  }
})

test('占用期按键只缓冲：不向设备直写任何字节，回车把整行作为一条命令入队', async () => {
  const { client, chan } = await connectFake()
  try {
    const p = client.exec('display current-configuration')
    p.catch(() => {})
    const base = chan.writtenBufs.length

    for (const ch of 'sys') {
      assert.equal(client.writeInteractive(ch).queued, true, '占用期按键应为「已暂存」')
    }
    assert.equal(sentSince(chan, base), '', '占用期不得向设备直写任何字节')

    assert.equal(client.writeInteractive('\r').queued, true)
    assert.equal(sentSince(chan, base), '', '整行应排队，而不是立即下发')
    assert.equal(client.queue.length, 1)
    assert.equal(client.queue[0].command, 'sys', '缓存内容应作为一条命令入队，且不得重复整行')
  } finally {
    client.close()
  }
})

test('占用结束、队列跑空后补发积压字符（不得压死在本地）', async () => {
  const { client, chan } = await connectFake()
  try {
    const p = client.exec('display clock')
    p.catch(() => {})
    const base = chan.writtenBufs.length

    client.writeInteractive('d')
    client.writeInteractive('i')
    assert.equal(sentSince(chan, base), '', '占用期不得直写')

    chan.emit('\r\n12:00:00\r\n<Huawei>') // 设备执行完，回到提示符
    await p
    assert.equal(sentSince(chan, base), 'di', '占用结束后应补发积压字符')
  } finally {
    client.close()
  }
})

test('积压字符在下次直写前先补发（顺序：缓冲内容 → 本次按键）', async () => {
  const { client, chan } = await connectFake()
  try {
    const p = client.exec('display clock')
    p.catch(() => {})
    client.writeInteractive('a') // 占用期 → 进缓冲
    const base = chan.writtenBufs.length

    // 模拟「占用已解除但没经过 resolveActive」的边界（挂起被 abort 解除、队列已清空）
    client.active = null
    client.queue = []
    client.writeInteractive('b')

    assert.equal(sentSince(chan, base), 'ab', '必须先补发 a 再写 b，否则设备上的顺序错乱')
  } finally {
    client.close()
  }
})

test('占用期空行回车放回缓冲，占用结束后补发', async () => {
  const { client, chan } = await connectFake()
  try {
    const p = client.exec('display clock')
    p.catch(() => {})
    const base = chan.writtenBufs.length

    assert.equal(client.writeInteractive('\r').queued, true)
    assert.equal(sentSince(chan, base), '', '占用期不得直写回车')

    chan.emit('12:00:00\r\n<Huawei>')
    await p
    assert.equal(sentSince(chan, base), '\r', '占用结束后补发这次回车')
  } finally {
    client.close()
  }
})

test('设备行缓冲已有直写内容时：回车只补回车，占用期补打的后半段拼成一整行', async () => {
  const { client, chan } = await connectFake()
  try {
    client.writeInteractive('disp') // 空闲直写：设备行缓冲里已有 'disp'
    const p = client.exec('display clock') // 代理开始占用
    p.catch(() => {})
    client.writeInteractive('lay ip int') // 占用期缓冲后半段
    const base = chan.writtenBufs.length

    client.writeInteractive('\r')
    assert.equal(sentSince(chan, base), '', '不得立即下发')
    assert.equal(
      client.queue[0]?.command,
      'lay ip int',
      '只入队后半段，设备会把它接在行缓冲后面拼成完整一行'
    )
  } finally {
    client.close()
  }
})

test('停 [Y/N] 时空行回车仍走队列插队应答（D12 回归）', async () => {
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
