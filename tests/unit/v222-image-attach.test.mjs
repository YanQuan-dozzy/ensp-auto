/**
 * v2.22（F17）单测：图片读取（嗅探 / 尺寸 / 闸门 / 读取 / read_image / 多模态用户消息）。
 *
 * 覆盖口径：
 * - 纯函数：头部嗅探与尺寸解析（五种格式，零依赖）、闸门分码、能力判定、提示词分流；
 * - 落盘读取：真实临时文件走一遍 `encodeImageFile` / `readImageForModel`（含沙箱越界）；
 * - 工具层：`read_image` 的 handler 分码（能力闸门 / 参数 / 受管目录 / 超限）；
 * - 端到端：用桩 LLM 跑一轮，断言**真正发给模型的那条用户消息**里带上了图片块
 *   （这是「设置项/能力开关到底有没有生效」那一类回归的守门用例 —— 只测拼串函数
 *   抓不到「装配层把开关丢了」这种缺陷）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

import {
  // shared/image-attach
  MODEL_IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  sniffImageMime,
  parseImageSize,
  checkImageLimits,
  modelImageGate,
  imageAttachmentsOf,
  imageMimeOfExt,
  unsupportedFormatHint,
  planUserImages,
  blockedImagesForSend,
  // 主进程读取 + 工具
  encodeImageFile,
  readImageForModel,
  readImage,
  toolImageRef,
  // 附件装配
  composeUserContent,
  composeUserMessage,
  buildAttachmentBlock,
  // 运行时端到端
  ReactRuntime,
  DEFAULT_SETTINGS,
  Type,
  AttachmentStore,
  // MCP 出口过滤（第二道：server.ts 与外露集合必须一致）
  createMcpServer,
  McpClientManager,
  namespaceToolName,
  toMcpTools,
  messageChars,
  IMAGE_PART_CHARS,
  renderSummaryBody,
  buildSummaryUserMessage
} from '../.build/harness.mjs'

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-v222-'))

// ———————————————————————— 测试用图片字节（只造头部，不解码） ————————————————————————

function pngBytes(w, h) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

function gifBytes(w, h) {
  const b = Buffer.alloc(10)
  b.write('GIF89a', 0, 'ascii')
  b.writeUInt16LE(w, 6)
  b.writeUInt16LE(h, 8)
  return b
}

function jpegBytes(w, h) {
  const b = Buffer.alloc(30)
  b[0] = 0xff
  b[1] = 0xd8
  // APP0 段（长度 16 → 扫描器应整段跳过）
  b[2] = 0xff
  b[3] = 0xe0
  b.writeUInt16BE(16, 4)
  // SOF0：FF C0 | len | 精度 | 高 | 宽
  b[20] = 0xff
  b[21] = 0xc0
  b.writeUInt16BE(0x11, 22)
  b[24] = 0x08
  b.writeUInt16BE(h, 25)
  b.writeUInt16BE(w, 27)
  return b
}

function webpVp8xBytes(w, h) {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(22, 4)
  b.write('WEBP', 8, 'ascii')
  b.write('VP8X', 12, 'ascii')
  b.writeUInt32LE(10, 16)
  const w1 = w - 1
  const h1 = h - 1
  b[24] = w1 & 0xff
  b[25] = (w1 >> 8) & 0xff
  b[26] = (w1 >> 16) & 0xff
  b[27] = h1 & 0xff
  b[28] = (h1 >> 8) & 0xff
  b[29] = (h1 >> 16) & 0xff
  return b
}

function webpVp8lBytes(w, h) {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(22, 4)
  b.write('WEBP', 8, 'ascii')
  b.write('VP8L', 12, 'ascii')
  b.writeUInt32LE(10, 16)
  b[20] = 0x2f
  // 位布局：bit0 签名字节已在 20；width-1 占 bit1..14，height-1 占 bit15..28
  const v = (((w - 1) & 0x3fff) << 1) | (((h - 1) & 0x3fff) << 15)
  b.writeUInt32LE(v >>> 0, 21)
  return b
}

function bmpBytes(w, h) {
  const b = Buffer.alloc(30)
  b.write('BM', 0, 'ascii')
  b.writeUInt32LE(30, 2)
  b.writeUInt32LE(40, 14) // DIB 头大小
  b.writeUInt32LE(w, 18)
  b.writeUInt32LE(h, 22)
  return b
}

/** 造一个合法的附件元数据（够 planUserImages / 提示词用） */
function att(over = {}) {
  return {
    id: 'a-1',
    name: 'shot.png',
    path: 'C:\\d\\a-1-shot.png',
    size: 1234,
    kind: 'image',
    ext: 'png',
    addedAt: 1,
    ...over
  }
}

// ———————————————————————— 头部嗅探与尺寸解析 ————————————————————————

test('sniffImageMime：按文件签名识别五种格式，命名无关', () => {
  assert.equal(sniffImageMime(pngBytes(10, 10)), 'image/png')
  assert.equal(sniffImageMime(jpegBytes(10, 10)), 'image/jpeg')
  assert.equal(sniffImageMime(gifBytes(10, 10)), 'image/gif')
  assert.equal(sniffImageMime(webpVp8xBytes(10, 10)), 'image/webp')
  assert.equal(sniffImageMime(webpVp8lBytes(10, 10)), 'image/webp')
  assert.equal(sniffImageMime(bmpBytes(10, 10)), 'image/bmp')
  assert.equal(sniffImageMime(Buffer.from('这不是图片，只是一段文字')), undefined)
  assert.equal(sniffImageMime(Buffer.alloc(0)), undefined)
})

test('parseImageSize：五种格式都能从头解析宽高（零依赖）', () => {
  assert.deepEqual(parseImageSize(pngBytes(1920, 1080)), { width: 1920, height: 1080 })
  assert.deepEqual(parseImageSize(gifBytes(640, 480)), { width: 640, height: 480 })
  assert.deepEqual(parseImageSize(jpegBytes(1024, 768)), { width: 1024, height: 768 })
  assert.deepEqual(parseImageSize(webpVp8xBytes(800, 600)), { width: 800, height: 600 })
  assert.deepEqual(parseImageSize(webpVp8lBytes(333, 222)), { width: 333, height: 222 })
  assert.deepEqual(parseImageSize(bmpBytes(200, 100)), { width: 200, height: 100 })
  // 头部残缺 → undefined（调用方据此跳过尺寸检查，只按字节判）
  assert.equal(parseImageSize(Buffer.alloc(4)), undefined)
})

test('parseImageSize：EXIF 无关，但 BMP 负数高度（自上而下）取绝对值', () => {
  const b = bmpBytes(120, 80)
  b.writeInt32LE(-80, 22)
  assert.deepEqual(parseImageSize(b), { width: 120, height: 80 })
})

// ———————————————————————— 闸门 ————————————————————————

test('checkImageLimits：格式 / 字节 / 单边 / 总像素各自分码', () => {
  const okCase = checkImageLimits({ mime: 'image/png', bytes: 1024, width: 800, height: 600 })
  assert.equal(okCase.ok, true)
  assert.equal(okCase.width, 800)

  const fmt = checkImageLimits({ mime: 'image/bmp', bytes: 1024, width: 10, height: 10 })
  assert.equal(fmt.ok, false)
  assert.equal(fmt.code, 'IMAGE_UNSUPPORTED_FORMAT')
  assert.match(fmt.message, /BMP/)
  assert.match(fmt.message, /PNG \/ JPEG/)

  const big = checkImageLimits({ mime: 'image/png', bytes: MAX_IMAGE_BYTES + 1 })
  assert.equal(big.code, 'IMAGE_TOO_LARGE')
  assert.match(big.message, /压缩/)

  const wide = checkImageLimits({
    mime: 'image/png',
    bytes: 1024,
    width: MAX_IMAGE_DIMENSION + 1,
    height: 10
  })
  assert.equal(wide.code, 'IMAGE_DIMENSION_TOO_LARGE')

  const many = checkImageLimits({ mime: 'image/png', bytes: 1024, width: 7000, height: 7000 })
  assert.equal(many.code, 'IMAGE_TOO_MANY_PIXELS')

  // 尺寸未知（头部残缺）：跳过尺寸检查，只按字节判 —— 本地解析能力不足不该拦下正常图片
  assert.equal(checkImageLimits({ mime: 'image/png', bytes: 1024 }).ok, true)
})

test('modelImageGate：只有显式声明 supportsImage 才放行（不猜型号）', () => {
  const off = modelImageGate({ label: '本地档', model: 'deepseek-flash', supportsImage: false })
  assert.equal(off.ok, false)
  assert.equal(off.code, 'MODEL_NO_IMAGE')
  assert.match(off.message, /本地档 · deepseek-flash/)
  assert.match(off.message, /设置 → 模型/)

  assert.equal(modelImageGate({ supportsImage: true }).ok, true)
  // 缺省 / undefined 一律按「不支持」处理 —— 判错方向取保守
  assert.equal(modelImageGate(undefined).ok, false)
  assert.equal(modelImageGate({}).ok, false)
})

test('planUserImages：模型不支持时全部标为未附上，混入的非图片附件不参与', () => {
  const list = [
    att({ id: 'a-1', name: 'shot.png', ext: 'png' }),
    att({ id: 'a-2', name: 'conf.txt', ext: 'txt', kind: 'text' }),
    att({ id: 'a-3', name: 'scan.bmp', ext: 'bmp' })
  ]
  assert.equal(imageAttachmentsOf(list).length, 2)

  const off = planUserImages(list, { supportsImage: false })
  assert.equal(off.modelCanSee, false)
  assert.equal(off.images.length, 0)
  assert.equal(off.blocked.length, 2)
  assert.match(off.blocked[0].reason, /未声明图片输入能力/)

  const on = planUserImages(list, { supportsImage: true })
  assert.equal(on.modelCanSee, true)
  assert.deepEqual(
    on.images.map((a) => a.id),
    ['a-1'],
    'PNG 通过；BMP 属于模型不接受的格式，应进 blocked'
  )
  assert.deepEqual(
    on.blocked.map((b) => b.attachment.id),
    ['a-3']
  )
  assert.match(on.blocked[0].reason, /\.bmp/)
})

test('blockedImagesForSend：界面判定与主进程同一份（无图 / 支持时返回 null）', () => {
  assert.equal(blockedImagesForSend([], { supportsImage: false }), null)
  assert.equal(blockedImagesForSend([att()], { supportsImage: true }), null)
  const blocked = blockedImagesForSend([att({ name: 'e.png' })], { supportsImage: false })
  assert.ok(blocked)
  assert.deepEqual(blocked.names, ['e.png'])
  assert.equal(blocked.code, 'MODEL_NO_IMAGE')
  assert.match(blocked.message, /e\.png/)
  assert.match(blocked.message, /移除后即可发送/)
})

test('IMAGE_MIME_BY_EXT / unsupportedFormatHint：只认四种，其余给转存建议', () => {
  assert.equal(imageMimeOfExt('JPG'), 'image/jpeg')
  assert.equal(imageMimeOfExt('png'), 'image/png')
  assert.equal(imageMimeOfExt('bmp'), undefined)
  assert.deepEqual([...MODEL_IMAGE_MIMES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  assert.match(unsupportedFormatHint('tiff'), /转存为 PNG 或 JPEG/)
  assert.equal(unsupportedFormatHint('png'), '')
})

// ———————————————————————— 消息装配（纯函数） ————————————————————————

test('composeUserContent：无图返回字符串（前缀不变），有图返回 parts 数组', () => {
  const text = '看看拓扑'
  assert.equal(composeUserContent(text, []), text, '无图必须逐字保持旧行为（prompt cache 依赖它）')
  const parts = composeUserContent(text, [{ mimeType: 'image/png', data: 'AAA' }])
  assert.ok(Array.isArray(parts))
  assert.deepEqual(parts[0], { type: 'text', text })
  assert.deepEqual(parts[1], { type: 'image', mimeType: 'image/png', data: 'AAA' })
})

test('buildAttachmentBlock：图片那一行按真实结果分流（附上 / 没附上 / 未知能力）', () => {
  const base = att({ id: 'a-9', name: 'topo.png' })
  const attached = buildAttachmentBlock([base], { images: { modelCanSee: true } })
  assert.match(attached, /已随本条消息\*\*直接附给你\*\*/)
  assert.match(attached, /不需要为了“看一眼”再调 read_image/)

  const blocked = buildAttachmentBlock([base], {
    images: { modelCanSee: false, blocked: new Map([['a-9', '图片 6.0 MB 超过 5.0 MB 上限']]) }
  })
  assert.match(blocked, /\*\*没有\*\*附给你/)
  assert.match(blocked, /超过 5\.0 MB 上限/)

  const unknown = buildAttachmentBlock([base])
  assert.match(unknown, /当前模型无法读取像素内容/)
})

test('composeUserMessage：能力上下文透传给块（不是只改文本）', () => {
  const full = composeUserMessage('干活', [att({ id: 'a-1' })], {
    images: { modelCanSee: true }
  })
  assert.match(full, /直接附给你/)
  assert.match(full, /# 本次附加文件/)
})

// ———————————————————————— 真实文件读取 ————————————————————————

test('encodeImageFile：以内容判格式（扩展名骗人时按内容），base64 可还原', () => {
  const dir = tmpRoot()
  const p = path.join(dir, 'lied.jpg')
  const bytes = pngBytes(320, 240)
  fs.writeFileSync(p, bytes)

  const r = encodeImageFile(p)
  assert.equal(r.ok, true)
  assert.equal(r.mimeType, 'image/png', '扩展名是 .jpg，内容是 PNG —— 以内容为准')
  assert.equal(r.width, 320)
  assert.equal(r.height, 240)
  assert.equal(r.bytes, bytes.length)
  assert.deepEqual(Buffer.from(r.data, 'base64'), bytes)
})

test('encodeImageFile：超限 / 非图片 / 空文件 / 不支持格式各自分码', () => {
  const dir = tmpRoot()

  // 超过字节上限：stat 阶段就该拒（不必读进内存）
  const huge = path.join(dir, 'huge.png')
  fs.writeFileSync(huge, Buffer.concat([pngBytes(10, 10), Buffer.alloc(MAX_IMAGE_BYTES)]))
  const big = encodeImageFile(huge)
  assert.equal(big.ok, false)
  assert.equal(big.code, 'IMAGE_TOO_LARGE')
  assert.match(big.error, /压缩/)

  const notImage = path.join(dir, 'fake.png')
  fs.writeFileSync(notImage, '这只是一段文本，虽然叫 .png')
  const bad = encodeImageFile(notImage)
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'IMAGE_UNREADABLE')

  const empty = path.join(dir, 'empty.png')
  fs.writeFileSync(empty, Buffer.alloc(0))
  assert.equal(encodeImageFile(empty).code, 'IMAGE_UNREADABLE')

  const bmp = path.join(dir, 'pic.bmp')
  fs.writeFileSync(bmp, bmpBytes(100, 100))
  const unsupported = encodeImageFile(bmp)
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.code, 'IMAGE_UNSUPPORTED_FORMAT')

  const wide = path.join(dir, 'wide.png')
  fs.writeFileSync(wide, pngBytes(MAX_IMAGE_DIMENSION + 10, 20))
  assert.equal(encodeImageFile(wide).code, 'IMAGE_DIMENSION_TOO_LARGE')

  assert.equal(encodeImageFile(path.join(dir, 'nope.png')).code, 'IMAGE_NOT_FOUND')
})

test('readImageForModel：沙箱与 read_attachment 同界（越界路径一律拒绝）', () => {
  const root = path.join(tmpRoot(), 'att')
  fs.mkdirSync(root, { recursive: true })
  const store = new AttachmentStore(root)
  const inside = path.join(root, 'pic.png')
  fs.writeFileSync(inside, pngBytes(64, 64))
  const outside = path.join(tmpRoot(), 'outside.png')
  fs.writeFileSync(outside, pngBytes(64, 64))

  const okInner = readImageForModel(store, inside)
  assert.equal(okInner.ok, true)
  assert.equal(okInner.path, fs.realpathSync(inside))

  const denied = readImageForModel(store, outside)
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'IMAGE_NOT_FOUND')
  assert.match(denied.error, /只能读附件归档目录/)
})

// ———————————————————————— read_image 工具 ————————————————————————

function toolCtx(store, supportsImage, extra = {}) {
  const profile = {
    id: 'p-1',
    label: '测试档',
    provider: 'deepseek',
    model: 'test-model',
    supportsImage,
    ...extra
  }
  return {
    attachments: store,
    settings: {
      ...structuredClone(DEFAULT_SETTINGS),
      agent: { ...structuredClone(DEFAULT_SETTINGS.agent), profiles: [profile], activeProfileId: 'p-1' }
    },
    exportsDir: ''
  }
}

test('read_image：模型不支持图片 → 在读盘之前就拒绝（MODEL_NO_IMAGE）', async () => {
  const root = path.join(tmpRoot(), 'att')
  fs.mkdirSync(root, { recursive: true })
  const store = new AttachmentStore(root)

  const res = await readImage.handler({ path: 'C:\\whatever\\a.png' }, toolCtx(store, false))
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'MODEL_NO_IMAGE')
  assert.match(res.error.message, /未声明图片输入能力/)
  assert.match(res.error.message, /本次未读取任何文件/)
  assert.equal(readImage.risk, 'read')
  assert.equal(readImage.concurrencySafe, true)
  assert.equal(readImage.mcpExposed, false, '结果只有本进程内的模型能消费 → 不外露给外部 MCP')
})

test('read_image：参数 / 沙箱 / 成功路径返回可直接附图的约定载荷', async () => {
  const root = path.join(tmpRoot(), 'att')
  fs.mkdirSync(root, { recursive: true })
  const store = new AttachmentStore(root)
  const pic = path.join(root, 'a-1-shot.png')
  fs.writeFileSync(pic, pngBytes(1280, 720))
  const ctx = toolCtx(store, true)

  const empty = await readImage.handler({ path: '   ' }, ctx)
  assert.equal(empty.error.code, 'BAD_PARAM')

  const denied = await readImage.handler({ path: 'C:\\Windows\\win.ini' }, ctx)
  assert.equal(denied.error.code, 'IMAGE_NOT_FOUND')

  const okRes = await readImage.handler({ path: pic }, ctx)
  assert.equal(okRes.ok, true)
  assert.equal(okRes.data.width, 1280)
  assert.equal(okRes.data.height, 720)
  assert.equal(okRes.data.mimeType, 'image/png')
  assert.equal(okRes.data.path, fs.realpathSync(pic))
  // 关键：data 里**没有** base64（运行时另取一次；塞进来会跟着进 jsonl 与溢出归档）
  assert.equal(okRes.data.data, undefined)
  assert.equal(typeof okRes.data.image.path, 'string')

  const ref = toolImageRef(okRes)
  assert.ok(ref, '运行时靠这个约定载荷识别「要附图」')
  assert.equal(ref.path, fs.realpathSync(pic))

  // 汇总行与回放卡片数据
  assert.match(readImage.summarize({ path: pic }, okRes), /读取图片 a-1-shot\.png（1280×720px/)
  assert.equal(readImage.presentationMeta({ path: pic }, okRes).width, 1280)

  const failed = await readImage.handler({ path: pic }, toolCtx(store, true))
  assert.equal(failed.ok, true)
  assert.equal(readImage.summarize({ path: pic }, failed).includes('失败'), false)
})

test('toolImageRef：结构非法一律不放行（宁可不附图，也不能让整轮请求挂掉）', () => {
  assert.equal(toolImageRef({ ok: false, data: { image: { path: 'x' } } }), undefined)
  assert.equal(toolImageRef({ ok: true, data: undefined }), undefined)
  assert.equal(toolImageRef({ ok: true, data: { image: { path: '   ' } } }), undefined)
  assert.equal(toolImageRef({ ok: true, data: { image: null } }), undefined)
  assert.equal(toolImageRef({ ok: true, data: { other: 1 } }), undefined)
  const ref = toolImageRef({
    ok: true,
    data: { image: { path: 'C:\\a\\b.png', name: 'b.png', width: 10, height: 'x', bytes: 3 } }
  })
  assert.equal(ref.path, 'C:\\a\\b.png')
  assert.equal(ref.width, 10)
  assert.equal(ref.height, undefined, '非数字的字段一律丢弃')
})

// ———————————————————————— 端到端：图片真的进到模型请求里 ————————————————————————

function stubLlm(requests) {
  const sink = (via) => (model, ctx, opts) => {
    requests.push({ model, ctx, opts, via })
    let finished = false
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (finished) return { done: true, value: undefined }
            finished = true
            return { done: false, value: { type: 'done' } }
          }
        }
      },
      async result() {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          api: 'openai-completions',
          provider: 'compat',
          model: 'stub-model',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
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
      stream: sink('stream'),
      streamSimple: sink('streamSimple')
    }
  })
}

/** 跑一轮，返回该轮真正下发的请求记录 */
async function runOnce({ supportsImage, attachments, readImageParts }) {
  const profile = {
    ...structuredClone(DEFAULT_SETTINGS.agent.profiles[0]),
    id: 'p-img',
    label: '视觉档',
    model: 'vision-model',
    supportsImage
  }
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    agent: { ...structuredClone(DEFAULT_SETTINGS.agent), profiles: [profile], activeProfileId: 'p-img' }
  }
  const requests = []
  const runtime = new ReactRuntime(
    {
      tools: [],
      getSettings: () => settings,
      getSkills: () => [],
      getCustomInstructions: () => '',
      buildContext: () => ({}),
      ...(readImageParts ? { readImageParts } : {})
    },
    { apiKey: 'stub-key', buildLlm: stubLlm(requests) }
  )
  for await (const _ of runtime.run({
    sessionId: 's-1',
    text: '看看这张截图',
    signal: new AbortController().signal,
    attachments
  })) {
    /* 事件内容不在本用例的断言范围内 */
  }
  return requests[0]
}

test('端到端：模型支持图片时，用户消息带 image 块（文本在前、图片在后）', async () => {
  const calls = []
  const req = await runOnce({
    supportsImage: true,
    attachments: [att({ id: 'a-7', name: 'shot.png', path: 'C:\\att\\a-7-shot.png' })],
    readImageParts: async (images) => {
      calls.push(images)
      return images.map((i) => ({ id: i.id, ok: true, mimeType: 'image/png', data: 'QkFTRTY0' }))
    }
  })
  const first = req.ctx.messages[0]
  assert.equal(first.role, 'user')
  assert.ok(Array.isArray(first.content), '有图时必须是 parts 数组')
  assert.equal(first.content[0].type, 'text')
  assert.match(first.content[0].text, /已随本条消息\*\*直接附给你\*\*/)
  assert.deepEqual(first.content[1], { type: 'image', mimeType: 'image/png', data: 'QkFTRTY0' })
  assert.deepEqual(calls, [[{ id: 'a-7', path: 'C:\\att\\a-7-shot.png' }]])
})

test('端到端：模型不支持图片时**不读文件、也不发图片块**，只写明原因', async () => {
  let called = false
  const req = await runOnce({
    supportsImage: false,
    attachments: [att({ id: 'a-7', name: 'shot.png' })],
    readImageParts: async () => {
      called = true
      return []
    }
  })
  assert.equal(called, false, '能力闸门在前：不支持时连文件都不该去读')
  const first = req.ctx.messages[0]
  assert.equal(typeof first.content, 'string', '没有图片时退回字符串（前缀与旧行为一致）')
  assert.match(first.content, /\*\*没有\*\*附给你/)
  assert.match(first.content, /未声明图片输入能力/)
})

test('端到端：读取失败时降级为文字说明，绝不静默丢掉这张图', async () => {
  const req = await runOnce({
    supportsImage: true,
    attachments: [att({ id: 'a-7', name: 'shot.png' })],
    readImageParts: async () => [
      { id: 'a-7', ok: false, error: '图片 8.0 MB 超过 5.0 MB 上限' }
    ]
  })
  const first = req.ctx.messages[0]
  assert.equal(typeof first.content, 'string')
  assert.match(first.content, /\*\*没有\*\*附给你/)
  assert.match(first.content, /超过 5\.0 MB 上限/)
})

test('端到端：出口不支持读图（外部 MCP）时写明原因，不谎称已附上', async () => {
  const req = await runOnce({
    supportsImage: true,
    attachments: [att({ id: 'a-7', name: 'shot.png' })]
  })
  const first = req.ctx.messages[0]
  assert.equal(typeof first.content, 'string')
  assert.match(first.content, /当前出口不支持读取图片/)
})

// ———————————————————————— 端到端：工具结果里的图片（read_image 的附图约定） ————————————————————————

/** 桩工具：返回带 `data.image` 的结果（与 read_image 的约定载荷一致） */
function imageToolRef(pathStr) {
  return {
    name: 'read_image',
    description: 'stub',
    risk: 'read',
    scope: 'local',
    concurrencySafe: true,
    schema: Type.Object({ path: Type.String() }, { additionalProperties: false }),
    summarize: () => '读取图片',
    handler: async () => ({
      ok: true,
      data: {
        path: pathStr,
        name: 'a.png',
        width: 10,
        height: 10,
        bytes: 3,
        image: { path: pathStr, name: 'a.png', mimeType: 'image/png', width: 10, height: 10, bytes: 3 }
      },
      meta: { ms: 1 }
    })
  }
}

/** 桩 LLM：第一次回一个 read_image 调用，第二次回纯 done；快照每次请求的 messages */
function scriptedToolCall(requests) {
  let n = 0
  const sink = () => (_model, ctx) => {
    n += 1
    const idx = n
    requests.push({ messages: [...ctx.messages] })
    const call = { id: `c${idx}`, name: 'read_image', arguments: { path: 'C:\\att\\a.png' } }
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
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
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

async function driveToolCall({ supportsImage, readImageParts, pathStr = 'C:\\att\\a.png' }) {
  const profile = {
    ...structuredClone(DEFAULT_SETTINGS.agent.profiles[0]),
    id: 'p-img',
    label: '视觉档',
    supportsImage
  }
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    agent: { ...structuredClone(DEFAULT_SETTINGS.agent), profiles: [profile], activeProfileId: 'p-img' }
  }
  const requests = []
  const runtime = new ReactRuntime(
    {
      tools: [imageToolRef(pathStr)],
      getSettings: () => settings,
      getSkills: () => [],
      getCustomInstructions: () => '',
      buildContext: () => ({}),
      ...(readImageParts ? { readImageParts } : {})
    },
    { apiKey: 'stub-key', buildLlm: scriptedToolCall(requests) }
  )
  for await (const _ of runtime.run({
    sessionId: 's-1',
    rootId: 's-root',
    text: '看看这张图',
    signal: new AbortController().signal
  })) {
    /* 事件不在断言范围内 */
  }
  return requests
}

test('★ 端到端：工具结果带 data.image → toolResult 里附上图片块（文本在前）', async () => {
  const calls = []
  const requests = await driveToolCall({
    supportsImage: true,
    readImageParts: async (images) => {
      calls.push(images)
      return images.map((i) => ({ id: i.id, ok: true, mimeType: 'image/png', data: 'SU1H' }))
    }
  })
  const second = requests[1]
  const tail = second.messages[second.messages.length - 1]
  assert.equal(tail.role, 'toolResult')
  assert.equal(tail.content[0].type, 'text')
  assert.deepEqual(tail.content[1], { type: 'image', mimeType: 'image/png', data: 'SU1H' })
  assert.deepEqual(calls, [[{ id: 'c1', path: 'C:\\att\\a.png' }]], '按调用 id 与路径去读')
  // base64 绝不能进 payload（它会跟着进 jsonl、压缩与溢出归档）
  assert.equal(tail.content[0].text.includes('SU1H'), false)
})

test('★ 端到端：工具结果附图读取失败 → 补一条文字说明（不省略，免得模型反复重试）', async () => {
  const requests = await driveToolCall({
    supportsImage: true,
    readImageParts: async () => [{ id: 'c1', ok: false, error: '图片 6.0 MB 超过 5.0 MB 上限' }]
  })
  const tail = requests[1].messages[requests[1].messages.length - 1]
  assert.equal(tail.content.length, 2)
  assert.equal(tail.content[1].type, 'text')
  assert.match(tail.content[1].text, /没有附上/)
  assert.match(tail.content[1].text, /超过 5\.0 MB 上限/)
})

test('★ 端到端：模型不支持图片 → 工具结果只留文本（pi 本来也会静默丢弃）', async () => {
  let called = false
  const requests = await driveToolCall({
    supportsImage: false,
    readImageParts: async () => {
      called = true
      return []
    }
  })
  assert.equal(called, false, '模型看不到图时不该白读一次 base64')
  const tail = requests[1].messages[requests[1].messages.length - 1]
  assert.equal(tail.content.length, 1)
  assert.equal(tail.content[0].type, 'text')
})


// ———————————————————————— MCP 出口：read_image 不外露（两处过滤必须一致） ————————————————————————

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

test('★ MCP 出口：read_image 既不列出也调不动（与 toMcpTools 的口径一致，R31）', async () => {
  // 静态出口：外露集合 = 内置工具 − danger − mcpExposed === false
  const exposed = toMcpTools([readImage]).map((t) => t.name)
  assert.deepEqual(exposed, [], 'read_image 声明了 mcpExposed: false，不该出现在外露集合里')

  const port = await freePort()
  const echoTool = {
    name: 'echo',
    description: '回显',
    risk: 'read',
    scope: 'local',
    schema: { type: 'object', properties: { msg: { type: 'string' } }, additionalProperties: false },
    handler: async (args) => ({ ok: true, data: { echo: args.msg }, meta: { ms: 1 } })
  }
  const server = await createMcpServer({
    deps: {
      tools: [echoTool, readImage],
      buildContext: () => ({ requestGate: async () => false })
    },
    port
  })
  const mgr = new McpClientManager()
  const cfg = {
    id: 'm-img',
    name: '图片出口自测',
    transport: 'http',
    url: server.url,
    command: '',
    args: [],
    enabled: true,
    trusted: true
  }
  try {
    const [status] = await mgr.sync([cfg])
    assert.equal(status.connected, true, status.error ?? '')
    assert.equal(status.toolCount, 1, '服务端只应露出 echo')
    assert.equal(status.tools[0].name, 'echo')
    // 列表里看不到，也不能照着名字调得动（R31 最坏组合）。
    // 客户端在工具表里查不到就直接拒（"未连接的工具"）；若哪天真调到了服务端，
    // server.ts 的同一份过滤会给"未知工具" —— 两种都算被挡住。
    const call = await mgr.callTool(namespaceToolName(cfg.name, 'read_image'), { path: 'C:/a.png' })
    assert.equal(call.ok, false)
    assert.match(call.error ?? call.text ?? '', /未知工具|未连接的工具/)
  } finally {
    await mgr.closeAll()
    await server.close()
  }
})

// ———————————————————————— 上下文计费：图片不能按 base64 长度折算 ————————————————————————

test('★ messageChars：图片块按固定代价计，不按 base64 长度（否则一上图就开始压缩）', () => {
  const textPart = { type: 'text', text: 'x'.repeat(100) }
  const imagePart = { type: 'image', mimeType: 'image/png', data: 'A'.repeat(2_000_000) }
  const withImage = messageChars({ role: 'toolResult', toolCallId: 'c1', toolName: 'read_image', content: [textPart, imagePart], isError: false })
  const without = messageChars({ role: 'toolResult', toolCallId: 'c1', toolName: 'read_image', content: [textPart], isError: false })

  assert.ok(withImage < 10000, `2 MB 的 base64 不该折算成 2.7 M 字符，实际 ${withImage}`)
  assert.equal(withImage - without, IMAGE_PART_CHARS + 16, '差值恰好是一个图片块的固定代价')
})

test('摘要输入里图片留占位标记（不静默丢掉「用户给过图」这件事）', () => {
  // 直接验证 textOfMessage 的口径：图片 → 占位、思考 → 丢弃
  const msgs = [
    { role: 'assistant', content: [{ type: 'thinking', thinking: '内部推理' }, { type: 'text', text: '正文' }, { type: 'image', mimeType: 'image/png', data: 'AA' }] }
  ]
  const rendered = renderSummaryBody(msgs, 4000)
  assert.match(rendered, /正文/)
  assert.match(rendered, /图片，内容未纳入摘要/)
  assert.equal(rendered.includes('内部推理'), false)
})
