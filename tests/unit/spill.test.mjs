import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AttachmentStore,
  DEFAULT_SETTINGS,
  ReactRuntime,
  SPILL_HEADER_TITLE,
  SPILL_MAX_LINE_CHARS,
  Type,
  renderSpillDump,
  spillLocatorNotice,
  truncateToolResult
} from '../.build/harness.mjs'

/**
 * v2.14：工具结果溢出落盘。
 *
 * 这一层最容易出的错**不是崩溃，而是「看起来能用」**：
 * 归档写成了 JSON，于是回显里的换行全被转义、整份配置压成一整行，
 * 而 read_attachment 是按行分页的 —— 模型翻到第 2 页就再也没有内容了，
 * 却不会报任何错。所以下面最关键的两条断言是：
 *   ① 归档正文里的换行是**真实换行**（行数随内容行数增长）；
 *   ② 用 read_attachment 分页**真的能读到中段**（不是只有第一页）。
 */

let seq = 0
function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), `ensp-spill-${++seq}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 造一段多行回显（VRP 配置的典型形态：行短、行多） */
function echoLines(n, prefix = 'interface GigabitEthernet0/0/') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n')
}

const meta = { toolName: 'run_show_command', callId: 'c1', at: Date.UTC(2026, 8, 26, 12, 0, 0) }

// ————————————————————— 纯函数：归档正文 —————————————————————

test('v2.14 renderSpillDump：字符串里的换行按原文落行（不能压成一整行）', () => {
  const clean = echoLines(120)
  const dump = renderSpillDump({ ok: true, data: { clean }, meta: { ms: 12 } }, meta)
  assert.equal(
    dump.includes('{"ok":true'),
    false,
    '归档不能是 JSON —— JSON 会把换行转义掉，整份回显压成一行'
  )
  const lines = dump.split('\n')
  assert.ok(lines.length >= 120, `行数应随内容行数增长，实际 ${lines.length}`)
  assert.ok(dump.includes('interface GigabitEthernet0/0/119'), '最后一行的内容必须原样在文件里')
  // 每行都在 read_attachment 的单行上限（2000）之内，否则那一行读回来是残的
  for (const line of lines) {
    assert.ok(line.length <= SPILL_MAX_LINE_CHARS, `单行超长（${line.length}）：${line.slice(0, 40)}…`)
  }
})

test('v2.14 renderSpillDump：字段路径可辨认，数组用下标，空容器内联', () => {
  const dump = renderSpillDump(
    { ok: true, data: { items: ['a', 'b'], none: [], obj: {}, nested: { deep: 1 } }, error: null },
    meta
  )
  assert.ok(dump.includes('result.ok: true'))
  assert.ok(dump.includes('result.data.items:'))
  assert.ok(dump.includes('result.data.items[0]: a'))
  assert.ok(dump.includes('result.data.items[1]: b'))
  assert.ok(dump.includes('result.data.none: []'))
  assert.ok(dump.includes('result.data.obj: {}'))
  assert.ok(dump.includes('result.data.nested.deep: 1'))
  assert.ok(dump.includes('result.error: null'))
})

test('v2.14 renderSpillDump：文件头写清来源与格式约定', () => {
  const dump = renderSpillDump({ ok: true }, meta)
  assert.ok(dump.startsWith(SPILL_HEADER_TITLE), '首行是归档标题')
  assert.ok(dump.includes('run_show_command'), '文件头点名工具')
  assert.ok(dump.includes('c1'), '文件头带调用 id')
  assert.ok(dump.includes('2026-09-26'), '文件头带归档时间')
  assert.ok(dump.includes('字段路径'), '文件头说明字段格式')
  assert.ok(dump.includes('硬折行'), '文件头说明折行约定（否则读回时会把折行当成新行）')
})

test('v2.14 renderSpillDump：超长单行被硬折行，拼接即原行', () => {
  const oneLine = 'X'.repeat(SPILL_MAX_LINE_CHARS * 3 + 7)
  const dump = renderSpillDump({ ok: true, data: { clean: oneLine } }, meta)
  const body = dump.split('\n')
  for (const line of body) {
    assert.ok(line.length <= SPILL_MAX_LINE_CHARS, `折行后仍有超长行：${line.length}`)
  }
  // 折行不能丢字符：全部 X 的总数应与原始内容一致（拼接即原行）
  assert.equal((dump.match(/X/g) ?? []).length, oneLine.length)
})

test('v2.14 spillLocatorNotice：给路径与读法，且不说「重新获取」', () => {
  const notice = spillLocatorNotice('/data/attachments/spills/s-x/c1.txt', 200000, 188000)
  assert.ok(notice.includes('/data/attachments/spills/s-x/c1.txt'), '必须给出可读回的真实路径')
  assert.ok(notice.includes('read_attachment'), '必须告诉模型用哪个工具读')
  assert.ok(notice.includes('200000') && notice.includes('188000'), '必须说明总量与省略量')
  assert.equal(
    notice.includes('重新获取'),
    false,
    '归档里就是完整输出，让模型重跑一遍既可能是另一种结果，也可能是不能重取的操作'
  )
})

test('v2.14 truncateToolResult：marker 可注入，不传时文案与旧版一致', () => {
  const text = 'A'.repeat(1000)
  const custom = truncateToolResult(text, 100, () => '【自定义】')
  assert.ok(custom.text.includes('【自定义】'), '注入的 marker 必须生效')
  assert.equal(custom.truncated, true)
  const dflt = truncateToolResult(text, 100)
  assert.ok(dflt.text.includes('请用更精确的命令重新获取'), '默认文案不能被改掉（无回归）')
  // 未超预算时两个分支都不动原文
  assert.equal(truncateToolResult(text, 5000).text, text)
  assert.equal(truncateToolResult(text, 5000).truncated, false)
})

// ————————————————————— 归档 → 读回（端到端） —————————————————————

test('v2.14 saveSpill → readText：分页真的能读到中段，且单行不残', async (t) => {
  const store = new AttachmentStore(tempDir(t))
  const clean = echoLines(300)
  const dump = renderSpillDump({ ok: true, data: { clean }, meta: { ms: 1 } }, meta)
  const file = await store.saveSpill('s-root', 'c1', dump)
  assert.equal(typeof file, 'string', '归档应返回路径')

  // 第 0 页
  const p0 = await store.readText(file, 0, 10)
  assert.equal(p0.ok, true)
  assert.ok(p0.text.includes(SPILL_HEADER_TITLE), '第一页能看到文件头')
  // 中段（模拟模型发现首尾都对不上、去翻中间）
  const mid = await store.readText(file, 150, 10)
  assert.equal(mid.ok, true)
  assert.ok(
    mid.text.includes('interface GigabitEthernet0/0/'),
    '中段必须真的能读回来 —— 这正是落盘存在的理由'
  )
  assert.ok(!mid.truncatedByBytes, '普通行不该被字节上限截断')
  // 末页
  const last = await store.readText(file, dump.split('\n').length - 12, 20)
  assert.equal(last.ok, true)
  assert.ok(last.text.includes('interface GigabitEthernet0/0/299'), '末尾内容原样在文件里')
})

test('v2.14 saveSpill：超长单行折行后仍可逐页读回（不会第二页就断）', async (t) => {
  const store = new AttachmentStore(tempDir(t))
  const oneLine = 'Y'.repeat(SPILL_MAX_LINE_CHARS * 8)
  const dump = renderSpillDump({ ok: true, data: { clean: oneLine } }, meta)
  const file = await store.saveSpill('s-root', 'c1', dump)

  // 逐页读完，拼起来必须覆盖全部内容 —— 若归档是「一整行」，第 2 页就会是空/越界
  let offset = 0
  let seen = 0
  for (let guard = 0; guard < 40; guard++) {
    const page = await store.readText(file, offset, 200)
    assert.equal(page.ok, true, `第 ${offset} 行起应可读`)
    seen += (page.text.match(/Y/g) ?? []).length
    if (page.atEnd) break
    offset = page.nextOffset
  }
  assert.equal(seen, oneLine.length, '所有内容都应能被逐页读到（证明折行可寻址）')
})

test('v2.14 saveSpill：文件名需要清洗时补随机后缀，两次调用不互相覆盖', async (t) => {
  const store = new AttachmentStore(tempDir(t))
  // 两个不同 callId 清洗后同名（`a/b` 与 `a_b` 都会变成 `a_b`）——
  // 不补后缀就会让后一次静默覆盖前一次，模型读回的是**另一次**的结果
  const f1 = await store.saveSpill('s-root', 'a/b', 'first')
  const f2 = await store.saveSpill('s-root', 'a_b', 'second')
  assert.notEqual(f1, f2, '清洗后同名的调用必须落到不同文件')
  const r1 = await store.readText(f1, 0, 10)
  assert.ok(r1.text.includes('first'))
})

test('v2.14 saveSpill：超过附件读取上限直接放弃（不给读不回来的路径）', async (t) => {
  const store = new AttachmentStore(tempDir(t))
  const huge = 'Z'.repeat(20 * 1024 * 1024 + 1)
  assert.equal(await store.saveSpill('s-root', 'c1', huge), null)
  assert.equal(await store.saveSpill('s-root', 'c2', ''), null)
})

test('v2.14 saveSpill：归档落在附件根下（清理附件即清归档）', async (t) => {
  const dir = tempDir(t)
  const store = new AttachmentStore(dir)
  const file = await store.saveSpill('s-root', 'c1', 'hello')
  assert.equal(path.resolve(file).startsWith(path.resolve(dir)), true, '必须落在附件根之内')
  assert.ok(file.includes(`spills`), '落在 spills 子目录')
  // 附件根本身就是 read_attachment 的可读根 —— 归档因此天然可读
  assert.notEqual(store.resolveReadable(file), null, '归档必须能通过 read_attachment 的路径校验')
})

// ————————————————————— 运行时接线 —————————————————————

/** 返回超大结果的工具（模拟一条 display current-configuration） */
function bigEchoTool(lines) {
  return {
    name: 'run_show_command',
    description: 'stub',
    risk: 'read',
    scope: 'device',
    concurrencySafe: true,
    schema: Type.Object({ deviceId: Type.String() }, { additionalProperties: false }),
    summarize: () => '读取大回显',
    handler: async () => ({
      ok: true,
      data: { clean: echoLines(lines) },
      meta: { ms: 3, deviceId: 'd1' }
    })
  }
}

/** 桩 LLM：先回一次工具调用，再回纯 done；同时快照每次请求的 messages */
function scriptedOneTool(requests) {
  let n = 0
  const sink = () => (model, ctx) => {
    n += 1
    const idx = n
    requests.push({ messages: [...ctx.messages] })
    const call = { id: `c${idx}`, name: 'run_show_command', arguments: { deviceId: 'd1' } }
    const queue =
      idx === 1 ? [{ type: 'toolcall_end', toolCall: call }, { type: 'done' }] : [{ type: 'done' }]
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const ev = queue.shift()
            return ev ? { done: false, value: ev } : { done: true, value: undefined }
          }
        }
      },
      async result() {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: '' }, ...(idx === 1 ? [{ type: 'toolCall', ...call }] : [])],
          api: 'openai-completions',
          provider: 'compat',
          model: 'stub',
          usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: Date.now()
        }
      }
    }
  }
  return async (cfg) => ({
    provider: 'compat',
    modelId: cfg.model,
    models: {
      getModel: () => ({ id: cfg.model, contextWindow: 100000, maxTokens: 4096 }),
      stream: sink(),
      streamSimple: sink()
    }
  })
}

async function driveWith(settings, tools, buildLlm, deps = {}) {
  const runtime = new ReactRuntime(
    {
      tools,
      getSettings: () => settings,
      getSkills: () => [],
      getCustomInstructions: () => '',
      buildContext: () => ({}),
      ...deps
    },
    { apiKey: 'stub-key', buildLlm }
  )
  const events = []
  for await (const ev of runtime.run({
    sessionId: 's-1',
    rootId: 's-root',
    text: '开始配置',
    signal: new AbortController().signal
  })) {
    events.push(ev)
  }
  return events
}

test('v2.14 运行时：超预算结果先归档，再给「head + 定位符 + tail」', async () => {
  const requests = []
  const spillCalls = []
  const settings = structuredClone(DEFAULT_SETTINGS)
  // 预算压低到 400 字符，保证 300 行回显必然超预算
  settings.compaction = { ...settings.compaction, toolResultMaxChars: 400 }

  await driveWith(settings, [bigEchoTool(300)], scriptedOneTool(requests), {
    spill: async (input) => {
      spillCalls.push(input)
      return '/fake/attachments/spills/s-root/c1.txt'
    }
  })

  assert.equal(spillCalls.length, 1, '超预算应归档一次')
  assert.equal(spillCalls[0].rootId, 's-root')
  assert.equal(spillCalls[0].toolName, 'run_show_command')
  assert.ok(
    spillCalls[0].text.includes('interface GigabitEthernet0/0/299'),
    '归档的必须是**完整**内容（不是截断后的那一段）'
  )
  assert.ok(spillCalls[0].text.includes('\n'), '归档正文必须是行可寻址文本')

  const second = requests[1]
  const toolResult = second.messages.find((m) => m.role === 'toolResult')
  const text = toolResult.content.map((c) => c.text ?? '').join('')
  assert.ok(text.includes('/fake/attachments/spills/s-root/c1.txt'), '定位符必须进模型上下文')
  assert.ok(text.includes('read_attachment'), '必须告诉模型怎么读回来')
  assert.equal(text.includes('重新获取'), false, '既然归档了就不该再让它重跑命令')
})

test('v2.14 运行时：归档失败退回纯截断，且不给出读不回来的路径', async () => {
  const requests = []
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.compaction = { ...settings.compaction, toolResultMaxChars: 400 }

  await driveWith(settings, [bigEchoTool(300)], scriptedOneTool(requests), {
    spill: async () => null
  })

  const text = requests[1].messages
    .find((m) => m.role === 'toolResult')
    .content.map((c) => c.text ?? '')
    .join('')
  assert.ok(text.includes('请用更精确的命令重新获取'), '退回旧文案')
  assert.equal(text.includes('spills'), false, '绝不出现一个读不回来的归档路径')
})

test('v2.14 运行时：未超预算时逐字节保持旧行为，且不触发归档', async () => {
  const requests = []
  const spillCalls = []
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.compaction = { ...settings.compaction, toolResultMaxChars: 200000 }

  await driveWith(settings, [bigEchoTool(3)], scriptedOneTool(requests), {
    spill: async (input) => {
      spillCalls.push(input)
      return '/fake/x.txt'
    }
  })

  assert.equal(spillCalls.length, 0, '没超预算不该写盘')
  const text = requests[1].messages
    .find((m) => m.role === 'toolResult')
    .content.map((c) => c.text ?? '')
    .join('')
  assert.equal(text.startsWith('{"ok":true'), true, '未超预算仍是紧凑 JSON（与 v2.13 一致）')
})

test('v2.14 运行时：没有 spill 出口（如外部 MCP）时行为与旧版一致', async () => {
  const requests = []
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.compaction = { ...settings.compaction, toolResultMaxChars: 400 }
  await driveWith(settings, [bigEchoTool(300)], scriptedOneTool(requests))
  const text = requests[1].messages
    .find((m) => m.role === 'toolResult')
    .content.map((c) => c.text ?? '')
    .join('')
  assert.ok(text.includes('请用更精确的命令重新获取'), '缺省走纯截断')
  assert.equal(text.includes('read_attachment'), false)
})
