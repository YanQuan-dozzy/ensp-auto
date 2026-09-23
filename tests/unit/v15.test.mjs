/**
 * v1.5 单测：模型档案 / 附件 / 提示词增强 / 外部 MCP。
 *
 * 覆盖口径：
 * - 纯函数（档案清洗与迁移、附件分类与提示词块、增强输出清洗、MCP 命名空间）
 * - 落盘行为（附件归档的并发与越界防护、设置迁移与原子写）
 * - 一条真实的 HTTP 往返（内置 MCP 服务 ↔ 外部 MCP 客户端），不 mock 传输层
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

import {
  // profiles
  LEGACY_PROFILE_ID,
  PROFILE_ID_RE,
  MCP_SERVER_ID_RE,
  newProfileId,
  newMcpServerId,
  isProfileId,
  isMcpServerId,
  labelFor,
  sanitizeProfile,
  sanitizeProfiles,
  normalizeAgentSettings,
  activeProfile,
  activeProfileOf,
  withActiveProfile,
  removeProfile,
  // attachments（纯函数）
  MAX_ATTACHMENT_BYTES,
  MAX_INLINE_CHARS,
  extOf,
  classifyAttachment,
  kindLabel,
  formatBytes,
  truncatePreview,
  sanitizeFileName,
  archivedFileName,
  attachmentNoteLine,
  buildAttachmentBlock,
  composeUserMessage,
  // 落盘
  AttachmentStore,
  JsonStore,
  // 提示词
  BASE_SYSTEM_PROMPT,
  CUSTOM_PROMPT_HEADING,
  buildAgentSystemPrompt,
  buildEnhanceUserPrompt,
  cleanEnhanced,
  // MCP
  MCP_TOOL_PREFIX,
  sanitizeNameSegment,
  namespaceToolName,
  isExternalToolName,
  splitExternalToolName,
  signatureOf,
  McpClientManager,
  externalToolSpecs,
  // 工具
  readAttachment,
  TOOLS,
  createMcpServer,
  DEFAULT_SETTINGS
} from '../.build/harness.mjs'

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-v15-'))

function writeTmp(dir, name, content) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

// ————————————————————— 模型档案 —————————————————————

test('档案 id 生成与校验：格式可解析，非法值被拒', () => {
  const pid = newProfileId()
  const sid = newMcpServerId()
  assert.match(pid, PROFILE_ID_RE)
  assert.match(sid, MCP_SERVER_ID_RE)
  assert.equal(isProfileId(pid), true)
  assert.equal(isProfileId('p-'), false)
  assert.equal(isProfileId('x-abc'), false)
  assert.equal(isMcpServerId(sid), true)
  assert.equal(isMcpServerId('m-ABC'), false) // 大写不在白名单字符集内
})

test('sanitizeProfile：provider 白名单、模型名必填、数值收敛、label 兜底', () => {
  assert.equal(sanitizeProfile({ provider: '不存在的平台', model: 'x' }), null)
  assert.equal(sanitizeProfile({ provider: 'deepseek', model: '  ' }), null)

  const p = sanitizeProfile({
    provider: 'deepseek',
    model: 'deepseek-flash',
    maxRounds: 999,
    temperature: -5,
    baseUrl: '  https://api.deepseek.com  '
  })
  assert.equal(p.maxRounds, 50)
  assert.equal(p.temperature, 0)
  assert.equal(p.baseUrl, 'https://api.deepseek.com')
  assert.equal(p.label, labelFor('deepseek', 'deepseek-flash'))
  assert.match(p.label, /deepseek-flash/)
})

test('sanitizeProfiles：丢弃非法项、重复 id 重新发号', () => {
  const list = sanitizeProfiles([
    { id: 'p-one', provider: 'deepseek', model: 'a' },
    { id: 'p-one', provider: 'deepseek', model: 'b' },
    { id: 'p-bad', provider: 'nope', model: 'c' },
    { provider: 'qwen', model: 'qwen3.7-max' }
  ])
  assert.equal(list.length, 3)
  assert.equal(list[0].id, 'p-one')
  assert.notEqual(list[1].id, 'p-one')
  assert.equal(isProfileId(list[1].id), true)
})

test('normalizeAgentSettings：v1.4 扁平设置迁移成单档档案（p-legacy）', () => {
  const a = normalizeAgentSettings({
    runtime: 'react',
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
    maxRounds: 8,
    temperature: 0.5
  })
  assert.equal(a.profiles.length, 1)
  assert.equal(a.profiles[0].id, LEGACY_PROFILE_ID)
  assert.equal(a.profiles[0].provider, 'zhipu')
  assert.equal(a.profiles[0].model, 'glm-5.3')
  assert.equal(a.profiles[0].maxRounds, 8)
  assert.equal(a.activeProfileId, LEGACY_PROFILE_ID)
  assert.equal(a.systemPrompt, '')
})

test('normalizeAgentSettings：已有档案优先于遗留扁平字段；活跃 id 失效时回落到第一档', () => {
  const a = normalizeAgentSettings({
    provider: 'deepseek',
    model: '旧模型',
    profiles: [{ id: 'p-keep', provider: 'qwen', model: 'qwen3.7-max' }],
    activeProfileId: 'p-不存在'
  })
  assert.equal(a.profiles.length, 1)
  assert.equal(a.profiles[0].id, 'p-keep')
  assert.equal(a.activeProfileId, 'p-keep')
})

test('normalizeAgentSettings：完全缺失时给预置档且不共享 DEFAULT 引用', () => {
  const a = normalizeAgentSettings(undefined)
  assert.ok(a.profiles.length > 0)
  assert.equal(a.activeProfileId, a.profiles[0].id)
  a.profiles[0].model = '被改坏'
  assert.notEqual(DEFAULT_SETTINGS.agent.profiles[0].model, '被改坏')
})

test('activeProfile / withActiveProfile / removeProfile', () => {
  const agent = {
    runtime: 'react',
    profiles: [
      { id: 'p-a', label: 'A', provider: 'deepseek', baseUrl: '', model: 'a', maxRounds: 12, temperature: 0.2 },
      { id: 'p-b', label: 'B', provider: 'qwen', baseUrl: '', model: 'b', maxRounds: 12, temperature: 0.2 }
    ],
    activeProfileId: 'p-b',
    systemPrompt: ''
  }
  assert.equal(activeProfile(agent).id, 'p-b')
  assert.equal(activeProfile({ ...agent, activeProfileId: 'p-zzz' }).id, 'p-a')
  assert.equal(activeProfileOf({ agent }).id, 'p-b')

  // 未知 id 不生效：返回原对象（引用相等）
  assert.equal(withActiveProfile(agent, 'p-zzz'), agent)
  assert.equal(withActiveProfile(agent, 'p-a').activeProfileId, 'p-a')

  // 删掉活跃档 → 顺位切到第一档
  const removed = removeProfile(agent, 'p-b')
  assert.equal(removed.profiles.length, 1)
  assert.equal(removed.activeProfileId, 'p-a')
  // 只剩一档时不允许再删
  assert.equal(removeProfile(removed, 'p-a'), removed)
})

// ————————————————————— 附件纯逻辑 —————————————————————

test('extOf / classifyAttachment：文本、图片、二进制与其他', () => {
  assert.equal(extOf('C:\\logs\\a.TXT'), 'txt')
  assert.equal(extOf('config'), '')
  assert.equal(extOf('.env'), 'env')
  assert.equal(extOf('..'), '')
  assert.equal(extOf('noext.'), '')
  assert.equal(extOf('C:////a////.gitignore'), 'gitignore')
  assert.equal(classifyAttachment('run.log'), 'text')
  assert.equal(classifyAttachment('topo.topo'), 'text')
  assert.equal(classifyAttachment('shot.PNG'), 'image')
  assert.equal(classifyAttachment('pkg.zip'), 'binary')
  assert.equal(kindLabel('image'), '图片')
})

test('formatBytes：按档位切换单位', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
})

test('truncatePreview：边界处不截断，超出标注 truncated', () => {
  assert.deepEqual(truncatePreview('abc', 3), { text: 'abc', truncated: false })
  const r = truncatePreview('abcdef', 3)
  assert.deepEqual(r, { text: 'abc', truncated: true })
})

test('sanitizeFileName / archivedFileName：去路径与非法字符，id 前缀保证唯一', () => {
  assert.equal(sanitizeFileName('C:\\a\\b\\conf:ig?.txt'), 'conf_ig_.txt')
  assert.equal(sanitizeFileName('...hidden'), 'hidden')
  const n = archivedFileName('a-1234', 'conf.txt')
  assert.equal(n, 'a-1234-conf.txt')
})

test('buildAttachmentBlock：文本内联 + 图片/二进制给出提示 + 超长标注翻页', () => {
  const base = {
    id: 'a-1',
    name: 'conf.txt',
    path: 'C:\\d\\a-1-conf.txt',
    size: 10,
    ext: 'txt',
    addedAt: 1
  }
  const text = buildAttachmentBlock([
    { ...base, kind: 'text', preview: 'sysname SW1', encoding: 'utf8' }
  ])
  assert.match(text, /# 本次附加文件/)
  assert.match(text, /sysname SW1/)
  assert.match(text, /路径：C:\\d\\a-1-conf\.txt/)

  const long = buildAttachmentBlock(
    [{ ...base, kind: 'text', preview: 'x'.repeat(500), truncated: true }],
    { perFileChars: 200, totalChars: 200 }
  )
  assert.match(long, /read_attachment/)
  // 单文件预算有 200 字符的下限保护，200 以内不截，201 一定截
  assert.ok(!long.includes('x'.repeat(201)))

  const img = buildAttachmentBlock([{ ...base, name: 'a.png', kind: 'image' }])
  assert.match(img, /无法直接读取像素/)

  const bin = buildAttachmentBlock([{ ...base, name: 'a.zip', kind: 'binary' }])
  assert.match(bin, /二进制/)

  assert.equal(buildAttachmentBlock([]), '')
  assert.equal(composeUserMessage('干活', []), '干活')
  assert.match(composeUserMessage('干活', [{ ...base, kind: 'text', preview: 'p' }]), /^干活\n\n# 本次附加文件/)
})

test('attachmentNoteLine：会话树里只留清单（含体积与类型）', () => {
  const line = attachmentNoteLine([
    { id: 'a-1', name: 'a.txt', path: 'p', size: 2048, kind: 'text', ext: 'txt', addedAt: 1 },
    { id: 'a-2', name: 'b.png', path: 'p', size: 5, kind: 'image', ext: 'png', addedAt: 1 }
  ])
  assert.match(line, /📎 a\.txt（2\.0 KB · 文本）/)
  assert.match(line, /📎 b\.png（5 B · 图片）/)
  assert.equal(attachmentNoteLine([]), '')
})

// ————————————————————— 提示词与增强 —————————————————————

test('buildAgentSystemPrompt：基础 + 自定义指令 + 技能，顺序固定', () => {
  const base = buildAgentSystemPrompt()
  assert.ok(base.startsWith(BASE_SYSTEM_PROMPT.slice(0, 20)))
  assert.match(BASE_SYSTEM_PROMPT, /read_attachment/)
  assert.match(BASE_SYSTEM_PROMPT, /mcp__/)

  const withCustom = buildAgentSystemPrompt(undefined, '  只允许读操作  ')
  assert.ok(withCustom.includes(CUSTOM_PROMPT_HEADING))
  assert.ok(withCustom.includes('只允许读操作'))

  const withBoth = buildAgentSystemPrompt([{ name: 'S', description: 'D', content: 'C' }], 'X')
  assert.ok(withBoth.indexOf(CUSTOM_PROMPT_HEADING) < withBoth.indexOf('## 技能：S'))
  assert.ok(withBoth.indexOf('## 技能：S') > withBoth.indexOf(CUSTOM_PROMPT_HEADING))
  assert.ok(withBoth.trimEnd().endsWith('C'))

  // 空白自定义指令不产生空标题块
  assert.equal(buildAgentSystemPrompt([], '   '), BASE_SYSTEM_PROMPT)
})

test('cleanEnhanced：剥围栏/引导语/引号，超长截断，空串返回空', () => {
  assert.equal(cleanEnhanced(''), '')
  assert.equal(cleanEnhanced('```\n改写内容\n```'), '改写内容')
  assert.equal(cleanEnhanced('改写后：执行 ping 验证'), '执行 ping 验证')
  assert.equal(cleanEnhanced('「一段指令」'), '一段指令')
  assert.equal(cleanEnhanced('x'.repeat(10), 4), 'xxxx')
  assert.equal(cleanEnhanced('  \n '), '')
})

test('buildEnhanceUserPrompt：草稿被原样带入', () => {
  assert.match(buildEnhanceUserPrompt('  配一下 vlan  '), /配一下 vlan/)
})

// ————————————————————— MCP 命名空间与签名 —————————————————————

test('namespaceToolName：非法字符清洗、总长 ≤ 64、可反解', () => {
  const n = namespaceToolName('文件 系统.v2', 'read file/xx')
  assert.ok(n.startsWith(MCP_TOOL_PREFIX))
  assert.ok(n.length <= 64)
  assert.equal(/^[A-Za-z0-9_-]+$/.test(n), true)
  assert.equal(isExternalToolName(n), true)
  const back = splitExternalToolName(n)
  assert.equal(back.tool, 'read_file_xx')

  const long = namespaceToolName('x'.repeat(80), 'y'.repeat(120))
  assert.ok(long.length <= 64)
  assert.equal(splitExternalToolName(long).tool.length, 41)

  assert.equal(isExternalToolName('list_devices'), false)
  assert.equal(splitExternalToolName('list_devices'), null)
  // D8：全非法字符（含空白）改为短哈希兜底，不再回落成 'x'
  const blank = sanitizeNameSegment('  ', 8)
  assert.match(blank, /^h[A-Za-z0-9]{6}$/)
  assert.notEqual(blank, 'x')
})

test('signatureOf：传输方式/地址/参数任一变化都产生新签名', () => {
  const base = { id: 'm-1', name: 's', transport: 'http', url: 'http://a/mcp', command: '', args: [], enabled: true, trusted: false }
  assert.equal(signatureOf(base), signatureOf({ ...base }))
  assert.notEqual(signatureOf(base), signatureOf({ ...base, url: 'http://b/mcp' }))
  assert.notEqual(signatureOf({ ...base, transport: 'stdio', command: 'npx' }), signatureOf({ ...base, transport: 'stdio', command: 'node' }))
})

// ————————————————————— 附件归档：落盘与并发 —————————————————————

test('AttachmentStore：导入文本附件（UTF-8 / GBK）、按内容识破伪文本、路径越界拒绝', async () => {
  const src = tmpRoot()
  const storeRoot = path.join(tmpRoot(), 'attachments')
  const store = new AttachmentStore(storeRoot)
  fs.mkdirSync(storeRoot, { recursive: true })

  const utf8File = writeTmp(src, 'conf.txt', 'sysname SW1\ndisplay clock\n')
  const gbkFile = path.join(src, 'gbk.log')
  fs.writeFileSync(gbkFile, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])) // 「中文」的 GBK 字节

  const { attachments, rejected } = await store.import('main', [utf8File, gbkFile])
  assert.equal(rejected.length, 0)
  assert.equal(attachments.length, 2)

  const conf = attachments.find((a) => a.name === 'conf.txt')
  assert.equal(conf.kind, 'text')
  assert.equal(conf.ext, 'txt')
  assert.equal(conf.truncated, false)
  assert.match(conf.preview, /sysname SW1/)
  assert.ok(conf.path.startsWith(storeRoot))

  const gbk = attachments.find((a) => a.name === 'gbk.log')
  assert.equal(gbk.encoding, 'gbk')
  assert.match(gbk.preview, /中文/)

  // 含 NUL 的 .txt：扩展名说文本，内容说是二进制 → 不给预览
  const fake = path.join(src, 'fake.txt')
  fs.writeFileSync(fake, Buffer.from([0x00, 0x01, 0x02, 0x61]))
  const r2 = await store.import('main', [fake])
  assert.equal(r2.attachments[0].preview, undefined)

  // 越界：源文件在归档目录之外，resolve 与 readText 都必须拒绝
  assert.equal(store.resolve(utf8File), null)
  const outside = await store.readText(utf8File)
  assert.equal(outside.ok, false)

  // 目录与不存在路径被拒（不抛异常）
  const r3 = await store.import('main', [src, path.join(src, 'nope.txt'), ''])
  assert.equal(r3.attachments.length, 0)
  assert.equal(r3.rejected.length, 3)
})

test('AttachmentStore：超大文件被拒；并发导入同名文件互不覆盖', async () => {
  const src = tmpRoot()
  const store = new AttachmentStore(path.join(tmpRoot(), 'att'))
  const big = path.join(src, 'big.log')
  fs.writeFileSync(big, '')
  fs.truncateSync(big, MAX_ATTACHMENT_BYTES + 1)

  const r = await store.import('main', [big])
  assert.equal(r.attachments.length, 0)
  assert.match(r.rejected[0].reason, /上限/)

  const same = writeTmp(src, 'same.txt', 'hello')
  const [a, b] = await Promise.all([
    store.import('main', [same]),
    store.import('main', [same])
  ])
  const pa = a.attachments[0].path
  const pb = b.attachments[0].path
  assert.notEqual(pa, pb)
  assert.equal(fs.readFileSync(pa, 'utf8'), 'hello')
  assert.equal(fs.readFileSync(pb, 'utf8'), 'hello')
  assert.notEqual(a.attachments[0].id, b.attachments[0].id)
})

test('AttachmentStore：describe 以磁盘为准重建元数据，readText 支持分行翻页', async () => {
  const src = tmpRoot()
  const store = new AttachmentStore(path.join(tmpRoot(), 'att2'))
  const file = writeTmp(src, 'lines.txt', Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n'))

  const { attachments } = await store.import('main', [file])
  const a = attachments[0]

  // describe：拿归档路径重新描述，名字还原（去掉 a-uuid- 前缀）
  const desc = store.describe(a.path)
  assert.equal(desc.name, 'lines.txt')
  assert.equal(desc.size, a.size)
  assert.equal(desc.id, a.id)

  // 伪造路径（不在归档内）→ null，渲染层也就无法借路径拿到别处文件
  assert.equal(store.describe(file), null)

  const page1 = await store.readText(a.path, 0, 10)
  assert.equal(page1.ok, true)
  assert.equal(page1.totalLines, 30)
  assert.equal(page1.from, 0)
  assert.equal(page1.to, 10)
  assert.equal(page1.truncated, true)
  assert.match(page1.text, /^line-0\n/)

  const page3 = await store.readText(a.path, 25, 10)
  assert.equal(page3.to, 30)
  assert.equal(page3.truncated, false)
  assert.match(page3.text, /line-29$/)
})

test('read_attachment 工具：越界路径返回失败结果而不是抛异常', async () => {
  const store = new AttachmentStore(path.join(tmpRoot(), 'att3'))
  const ctx = { attachments: store }
  const res = await readAttachment.handler({ path: 'C:\\Windows\\win.ini' }, ctx)
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'BAD_PARAM')
  assert.equal(readAttachment.risk, 'read')
  assert.equal(readAttachment.scope, 'local')
  assert.ok(TOOLS.some((t) => t.name === 'read_attachment'))
})

// ————————————————————— 设置迁移与原子写 —————————————————————

test('JsonStore：v1.4 扁平 agent 设置被迁移成档案，且局部更新不丢档案', () => {
  const dir = tmpRoot()
  const file = path.join(dir, 'ensp-auto.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      settings: {
        theme: 'light',
        agent: { runtime: 'react', provider: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3', maxRounds: 6, temperature: 0.7 }
      },
      aliases: {},
      recentPorts: []
    }),
    'utf8'
  )

  const store = new JsonStore(file)
  const s1 = store.getSettings()
  assert.equal(s1.theme, 'light')
  assert.equal(s1.agent.profiles.length, 1)
  assert.equal(s1.agent.profiles[0].provider, 'kimi')
  assert.equal(s1.agent.profiles[0].model, 'kimi-k3')
  assert.equal(s1.agent.profiles[0].maxRounds, 6)
  assert.equal(s1.agent.activeProfileId, s1.agent.profiles[0].id)
  // mcp 的新字段也要有默认值（老配置文件里没有 servers）
  assert.deepEqual(s1.mcp.servers, [])
  assert.equal(s1.mcp.exposeToAgent, true)

  // 只改自定义指令：档案必须原样保留
  const s2 = store.updateSettings({ agent: { ...s1.agent, systemPrompt: '只读' } })
  assert.equal(s2.agent.systemPrompt, '只读')
  assert.equal(s2.agent.profiles[0].model, 'kimi-k3')

  // 重新读盘（模拟重启）：迁移与更新都已落盘，且没有残留临时文件
  const reopened = new JsonStore(file).getSettings()
  assert.equal(reopened.agent.systemPrompt, '只读')
  assert.equal(reopened.agent.profiles[0].provider, 'kimi')
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), [])
})

test('JsonStore：读坏的文件不抛异常，回落到默认值并可正常写入', () => {
  const dir = tmpRoot()
  const file = path.join(dir, 'bad.json')
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8')
  const store = new JsonStore(file)
  assert.equal(store.getSettings().theme, DEFAULT_SETTINGS.theme)

  // 坏文件不该把应用卡死：随后的写入必须成功且可读回
  store.updateSettings({ theme: 'light' })
  assert.equal(new JsonStore(file).getSettings().theme, 'light')
})

// ————————————————————— MCP 客户端 ↔ 服务端（真实 HTTP） —————————————————————

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

test('McpClientManager：连上自建 MCP 服务、列出并调用工具、停用后断开', async () => {
  const port = await freePort()
  const echoTool = {
    name: 'echo',
    description: '回显传入的文本',
    risk: 'read',
    scope: 'local',
    schema: { type: 'object', properties: { msg: { type: 'string' } }, additionalProperties: false },
    handler: async (args) => ({ ok: true, data: { echo: args.msg }, meta: { ms: 1 } })
  }

  const server = await createMcpServer({
    deps: {
      tools: [echoTool],
      buildContext: () => ({ requestGate: async () => false })
    },
    port
  })

  const mgr = new McpClientManager()
  const cfg = {
    id: 'm-test',
    name: '自测服务',
    transport: 'http',
    url: server.url,
    command: '',
    args: [],
    enabled: true,
    trusted: false
  }

  try {
    const [status] = await mgr.sync([cfg])
    assert.equal(status.connected, true, status.error ?? '')
    assert.equal(status.toolCount, 1)
    assert.equal(status.tools[0].name, 'echo')

    const namespaced = namespaceToolName(cfg.name, 'echo')
    const call = await mgr.callTool(namespaced, { msg: 'hello-mcp' })
    assert.equal(call.ok, true, call.error ?? '')
    assert.match(call.text, /hello-mcp/)

    // 未连接的服务器 / 不存在的工具
    const bad = await mgr.callTool('mcp__nope__echo', {})
    assert.equal(bad.ok, false)

    // 注入内置代理时的风险等级：未信任 → danger（走人工闸门）
    const specs = externalToolSpecs(mgr)
    const spec = specs.find((s) => s.name === namespaced)
    assert.ok(spec)
    assert.equal(spec.risk, 'danger')
    assert.ok(spec.description.includes(cfg.name))

    // 信任后降级为 write
    await mgr.sync([{ ...cfg, trusted: true }])
    assert.equal(externalToolSpecs(mgr).find((s) => s.name === namespaced).risk, 'write')

    // 停用 → 连接释放、工具消失
    const [off] = await mgr.sync([{ ...cfg, enabled: false }])
    assert.equal(off.connected, false)
    assert.equal(mgr.externalTools().length, 0)

    // 连不上的服务器：记为 error 而不是抛出去
    const [badStatus] = await mgr.sync([
      { ...cfg, id: 'm-dead', url: 'http://127.0.0.1:1/mcp' }
    ])
    assert.equal(badStatus.connected, false)
    assert.ok(badStatus.error)
  } finally {
    await mgr.closeAll()
    await server.close()
  }
})
