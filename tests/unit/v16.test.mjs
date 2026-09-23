/**
 * v1.6 单测：通用设置（数据占用与清理）、权限口径、手动配置（粘贴 JSON 导入）。
 *
 * 覆盖口径：
 * - 纯函数：JSON 注释/尾逗号的容错、三种顶层写法、字段归一与「不支持就明说」、
 *   名字收敛与去重、连接去重；
 * - 落盘相关：数据目录统计与清理的**越界防护**（这条是安全红线，必须有测试盯着）；
 * - 与新设置项有关的契约：默认值、以及「危险操作闸门」两个开关的语义。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  // 命名约束
  MCP_SERVER_SEGMENT_MAX,
  MCP_TOOL_SEGMENT_MAX,
  sanitizeNameSegment,
  namespaceToolName,
  // 手动配置
  MCP_IMPORT_EXAMPLE,
  relaxJson,
  parseMcpServersJson,
  // 数据占用与清理
  SCOPE_DIR,
  scopeDir,
  dirUsage,
  measureStorage,
  assertInside,
  assertInsideOrEqual,
  emptyDir,
  // 设置契约
  DEFAULT_SETTINGS,
  DEFAULT_STORAGE
} from '../.build/harness.mjs'

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-v16-'))

function withTmp(fn) {
  const dir = tmpRoot()
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ————————————————————— 命名约束 —————————————————————

test('命名约束：字符集与长度预算就是命名空间的预算', () => {
  assert.equal(sanitizeNameSegment('filesystem', 16), 'filesystem')
  assert.equal(sanitizeNameSegment('my server!', 16), 'my_server')
  // D8：全非法字符不再统一塌缩成 'x' —— 按原始串短哈希兜底，且不同名可区分
  const cnA = sanitizeNameSegment('我的服务器', 16)
  const cnB = sanitizeNameSegment('数据库工具', 16)
  assert.match(cnA, /^h[A-Za-z0-9]{6}$/, '中文名兜底为短哈希')
  assert.notEqual(cnA, cnB, '两台中文名服务器不得塌缩成同名')
  assert.notEqual(cnA, 'x')
  assert.match(sanitizeNameSegment('', 16), /^h/, '空串也兜底为短哈希，保持非空')

  // 预算：mcp__(5) + 16 + __(2) + 41 = 64
  const name = namespaceToolName('a'.repeat(40), 'b'.repeat(80))
  assert.equal(name.length, 5 + MCP_SERVER_SEGMENT_MAX + 2 + MCP_TOOL_SEGMENT_MAX)
  assert.equal(name, 'mcp__' + 'a'.repeat(16) + '__' + 'b'.repeat(41))
})

// ————————————————————— 手动配置：JSON 容错 —————————————————————

test('relaxJson：注释与尾逗号被吃掉，字符串里的 // 不动', () => {
  const src = `{
    // 行注释
    "url": "http://10.0.0.8:3000/mcp", /* 块注释 */
    "args": ["a", "b",],
  }`
  const out = relaxJson(src)
  assert.equal(out.includes('行注释'), false)
  assert.equal(out.includes('块注释'), false)
  assert.equal(out.includes('http://10.0.0.8:3000/mcp'), true) // 关键：URL 里的 // 必须留
  assert.equal(out.includes('"b",]'), false) // 数组尾逗号也被去掉
  assert.doesNotThrow(() => JSON.parse(out))
})

test('relaxJson：转义引号不会把状态机带偏', () => {
  const src = '{"a": "he said \\"// not a comment\\"", "b": 1}'
  const out = relaxJson(src)
  assert.doesNotThrow(() => JSON.parse(out))
  assert.equal(JSON.parse(out).a, 'he said "// not a comment"')
})

// ————————————————————— 手动配置：识别多种写法 —————————————————————

test('导入：标准的 mcpServers 包裹 + stdio/HTTP 两种传输', () => {
  const r = parseMcpServersJson(
    `{
      "mcpServers": {
        "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "F:/lab"] },
        "internal": { "type": "http", "url": "http://10.0.0.8:3000/mcp" }
      }
    }`
  )
  assert.equal(r.ok, true)
  assert.equal(r.servers.length, 2)
  const [fs_, http] = r.servers
  assert.equal(fs_.name, 'filesystem')
  assert.equal(fs_.transport, 'stdio')
  assert.equal(fs_.command, 'npx')
  assert.deepEqual(fs_.args, ['-y', '@modelcontextprotocol/server-filesystem', 'F:/lab'])
  assert.equal(fs_.url, '')
  assert.equal(http.transport, 'http')
  assert.equal(http.url, 'http://10.0.0.8:3000/mcp')
  assert.equal(http.command, '')
  // 安全默认：导入的一律不信任，且必须有 id
  assert.equal(r.servers.every((s) => s.trusted === false), true)
  assert.equal(r.servers.every((s) => s.enabled === true), true)
  assert.equal(r.servers.every((s) => typeof s.id === 'string' && s.id.length > 0), true)
})

test('导入：VS Code 的 servers 写法、裸映射、以及带 name 的数组', () => {
  const vscode = parseMcpServersJson(`{"servers": {"a": {"command": "node", "args": ["x.js"]}}}`)
  assert.equal(vscode.ok, true)
  assert.equal(vscode.servers[0].name, 'a')

  const bare = parseMcpServersJson(`{"a": {"url": "http://127.0.0.1:1/mcp"}}`)
  assert.equal(bare.ok, true)
  assert.equal(bare.servers[0].transport, 'http')

  const arr = parseMcpServersJson(
    `[{"name": "b", "command": "uvx", "args": ["mcp-server-git"]}]`
  )
  assert.equal(arr.ok, true)
  assert.equal(arr.servers[0].name, 'b')
  assert.equal(arr.servers[0].command, 'uvx')
})

test('导入：示例文本本身必须能被解析（界面里展示的就是它）', () => {
  const r = parseMcpServersJson(MCP_IMPORT_EXAMPLE)
  assert.equal(r.ok, true)
  assert.deepEqual(
    r.servers.map((s) => s.name),
    ['filesystem', 'internal-api']
  )
})

// ————————————————————— 手动配置：明说「不支持什么」 —————————————————————

test('导入：env / headers 被忽略，并且明确写进说明里', () => {
  const r = parseMcpServersJson(
    JSON.stringify({
      mcpServers: {
        git: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-git'],
          env: { GITHUB_TOKEN: 'x' },
          headers: { Authorization: 'Bearer y' }
        }
      }
    })
  )
  assert.equal(r.ok, true)
  const all = r.warnings.join('\n')
  assert.match(all, /env/)
  assert.match(all, /headers/)
  assert.match(all, /不注入/)
})

test('导入：缺 command 与 url 的条目被跳过，但同批次的其它条目照常导入', () => {
  const r = parseMcpServersJson(
    `{
      "mcpServers": {
        "good": { "url": "http://127.0.0.1:9/mcp" },
        "broken": { "description": "只有一段说明" }
      }
    }`
  )
  assert.equal(r.ok, true)
  assert.equal(r.servers.length, 1)
  assert.equal(r.servers[0].name, 'good')
  assert.match(r.warnings.join('\n'), /跳过「broken」/)
})

test('导入：全是坏条目时 ok=false，但仍给出逐条原因', () => {
  const r = parseMcpServersJson(`{"mcpServers": {"broken": {"args": ["x"]}}}`)
  assert.equal(r.ok, false)
  assert.match(r.error, /没能导入/)
  assert.match(r.warnings.join('\n'), /跳过「broken」/)
})

test('导入：非法 JSON / 空输入 / 认不出的结构各有明确错误', () => {
  const bad = parseMcpServersJson('{ this is not json }')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /JSON 解析失败/)

  const empty = parseMcpServersJson('   \n  ')
  assert.equal(empty.ok, false)
  assert.match(empty.error, /空/)

  const unknown = parseMcpServersJson('{"foo": "bar"}')
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /没认出/)
})

// ————————————————————— 手动配置：名字与连接去重 —————————————————————

test('导入：名字按模型命名约束收敛，重名自动加序号', () => {
  const r = parseMcpServersJson(
    `{
      "mcpServers": {
        "我的 服务器": { "url": "http://127.0.0.1:11/mcp" },
        "a": { "url": "http://127.0.0.1:12/mcp" },
        "a2": { "url": "http://127.0.0.1:13/mcp" }
      }
    }`,
    [{ id: 'm-1', name: 'a', transport: 'http', url: 'http://127.0.0.1:99/mcp', command: '', args: [], enabled: true, trusted: false }]
  )
  assert.equal(r.ok, true)
  const names = r.servers.map((s) => s.name)
  assert.equal(names.includes('a-2'), true) // 与已有服务器重名 → 加序号
  assert.equal(new Set(names).size, names.length) // 批次内也不允许重名
  assert.match(r.warnings.join('\n'), /收敛为/)
})

test('导入：同一段 JSON 粘第二遍会被识别为重复配置并跳过', () => {
  const json = `{"mcpServers": {"fs": {"command": "npx", "args": ["-y", "server-fs"]}}}`
  const first = parseMcpServersJson(json)
  assert.equal(first.ok, true)
  const second = parseMcpServersJson(json, first.servers)
  assert.equal(second.ok, false)
  assert.match(second.warnings.join('\n'), /同样的连接配置/)
})

test('导入：disabled 条目保持停用，而 autoApprove 之类的字段不能换来免确认', () => {
  const r = parseMcpServersJson(
    `{"mcpServers": {"off": {"url": "http://127.0.0.1:18/mcp", "disabled": true, "autoApprove": ["*"]}}}`
  )
  assert.equal(r.ok, true)
  assert.equal(r.servers[0].enabled, false)
  assert.equal(r.servers[0].trusted, false)
  assert.match(r.warnings.join('\n'), /停用/)
  assert.match(r.warnings.join('\n'), /autoApprove/)
})

// ————————————————————— 数据目录统计与清理 —————————————————————

test('dirUsage：递归统计文件数与字节数，目录不存在记 0', () => {
  withTmp((dir) => {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(10))
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'y'.repeat(5))
    assert.deepEqual(dirUsage(dir), { bytes: 15, files: 2 })
    assert.deepEqual(dirUsage(path.join(dir, 'nope')), { bytes: 0, files: 0 })
  })
})

test('measureStorage：条目顺序稳定，合计等于各项之和', () => {
  withTmp((dir) => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sessions', 's1.jsonl'), 'z'.repeat(100))
    fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'attachments', 'a-1-x.bin'), 'z'.repeat(50))
    fs.writeFileSync(path.join(dir, 'ensp-auto.json'), 'z'.repeat(7))

    const r = measureStorage(dir)
    assert.deepEqual(
      r.entries.map((e) => e.key),
      ['sessions', 'attachments', 'snapshots', 'exports', 'config']
    )
    assert.equal(r.entries[0].bytes, 100)
    assert.equal(r.entries[1].bytes, 50)
    assert.equal(r.entries[2].bytes, 0)
    assert.equal(r.entries[4].bytes, 7)
    assert.equal(r.totalBytes, 157)
    assert.equal(r.userDataDir, dir)
    // 磁盘容量：statfs 拿不到时应当是 0，而不是 NaN
    assert.equal(Number.isFinite(r.diskFreeBytes), true)
    assert.equal(Number.isFinite(r.diskTotalBytes), true)
  })
})

test('assertInside：数据目录之外的路径一律拒绝（安全红线）', () => {
  withTmp((dir) => {
    const inside = path.join(dir, SCOPE_DIR.sessions)
    assert.doesNotThrow(() => assertInside(dir, inside))
    assert.doesNotThrow(() => assertInside(dir, path.join(dir, 'a', 'b')))

    assert.throws(() => assertInside(dir, path.join(dir, '..')), /拒绝/)
    assert.throws(() => assertInside(dir, path.dirname(dir)), /拒绝/)
    assert.throws(() => assertInside(dir, dir), /拒绝/) // 目录自身也不许当目标
    assert.throws(() => assertInside(dir, path.resolve(dir, '..', 'evil')), /拒绝/)
  })
})

test('emptyDir：清空内容但保留目录本身，缺失目录返回 0', () => {
  withTmp((dir) => {
    const target = scopeDir(dir, 'attachments')
    fs.mkdirSync(path.join(target, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(target, 'a.txt'), '1')
    fs.writeFileSync(path.join(target, 'nested', 'b.txt'), '2')

    assert.equal(emptyDir(target), 2) // 只删两层顶层项，不递归计数
    assert.equal(fs.existsSync(target), true)
    assert.deepEqual(fs.readdirSync(target), [])
    assert.equal(emptyDir(path.join(dir, 'missing')), 0)
  })
})

// ————————————————————— 新设置项的契约 —————————————————————

test('measureStorage：支持自定义外部目录并准确统计', () => {
  withTmp((dir) => {
    withTmp((customExportDir) => {
      fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'sessions', 's1.jsonl'), 'a'.repeat(40))
      fs.writeFileSync(path.join(customExportDir, 'report.md'), 'b'.repeat(80))

      const r = measureStorage({
        userDataDir: dir,
        exportsDir: customExportDir
      })
      const exp = r.entries.find((e) => e.key === 'exports')
      assert.equal(exp?.bytes, 80)
      assert.equal(exp?.files, 1)
      assert.equal(r.totalBytes, 120)
    })
  })
})

test('assertInsideOrEqual：允许自身与子路径，拒绝越界路径', () => {
  withTmp((dir) => {
    assert.doesNotThrow(() => assertInsideOrEqual(dir, dir))
    assert.doesNotThrow(() => assertInsideOrEqual(dir, path.join(dir, 'a', 'b')))
    assert.throws(() => assertInsideOrEqual(dir, path.join(dir, '..')), /拒绝/)
  })
})

test('默认设置：通知默认开、危险确认默认开、外部工具默认不免确认、存储目录默认空（继承系统）', () => {
  assert.equal(DEFAULT_SETTINGS.notify.onTaskEnd, true)
  assert.equal(DEFAULT_SETTINGS.notify.onGate, true)
  assert.equal(DEFAULT_SETTINGS.notify.sound, 'default')
  assert.equal(DEFAULT_SETTINGS.permission.confirmDanger, true)
  assert.equal(DEFAULT_SETTINGS.permission.externalToolConfirm, false)
  assert.deepEqual(DEFAULT_SETTINGS.storage, DEFAULT_STORAGE)
  assert.equal(DEFAULT_SETTINGS.storage.userDataDir, '')
  assert.equal(DEFAULT_SETTINGS.storage.exportsDir, '')
  assert.equal(DEFAULT_SETTINGS.storage.attachmentsDir, '')
  assert.equal(DEFAULT_SETTINGS.storage.snapshotsDir, '')
})
