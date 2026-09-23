import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildWiresharkMcpConfig,
  checkWiresharkMcp,
  probeWireshark,
  TOOL_ENV_VAR,
  TOOL_REQUIREMENT,
  wiresharkMcpPaths,
  WS_MCP_SERVER_ID,
  WS_MCP_SERVER_NAME,
  DEFAULT_SETTINGS,
  JsonStore
} from '../.build/harness.mjs'

/**
 * v1.9：Wireshark 抓包分析接入。
 *
 * 全部在「假目录」上做 —— 真机有没有 Wireshark 不该决定测试是否通过。
 * 用 overrideDir 指到一个我们临时造出的目录，里面按需放 tshark.exe 等文件，
 * 这样「探测链」「缺失判断」「配置生成」「幂等键」都能稳定复现。
 */

/** 造一个假的 Wireshark 目录；tools 里列出的工具会创建为空文件 */
function fakeSuite(tools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-suite-'))
  const ext = process.platform === 'win32' ? '.exe' : ''
  for (const t of tools) fs.writeFileSync(path.join(dir, `${t}${ext}`), '')
  return dir
}

function fakeUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ud-'))
}

test('v1.9 探测：目录里有 tshark 时判定可分析', () => {
  const dir = fakeSuite(['tshark'])
  const p = probeWireshark({ overrideDir: dir })
  assert.equal(p.canAnalyze, true)
  assert.equal(p.ready, true)
  assert.equal(p.suiteDir, dir)
  assert.equal(p.source, 'setting')
  // 只有 tshark 时不能实时抓包（缺 dumpcap）
  assert.equal(p.canCapture, false)
  // capinfos/mergecap 是 recommended，缺了要出现在 missing 里
  assert.ok(p.missing.includes('capinfos'))
  assert.ok(p.missing.includes('mergecap'))
  // editcap/dumpcap/text2pcap 是 optional，不该污染 missing
  assert.ok(!p.missing.includes('editcap'))
})

test('v1.9 探测：tshark + dumpcap 齐了才算能实时抓包', () => {
  const dir = fakeSuite(['tshark', 'dumpcap'])
  const p = probeWireshark({ overrideDir: dir })
  assert.equal(p.canAnalyze, true)
  assert.equal(p.canCapture, true)
  assert.ok(!p.missing.includes('dumpcap'))
})

test('v1.9 探测：override 目录不含 tshark 时会继续往后续来源找', () => {
  // 注意这条**不能**断言「结果为 false」：探测链在 override 失败后还会查环境变量、
  // 注册表与常见路径 —— 开发机上真的装了 Wireshark 时，结果本来就是 true。
  // 断言「不再停在 setting 来源」才是这条用例真正要守的行为。
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-empty-'))
  const p = probeWireshark({ overrideDir: empty })
  if (p.canAnalyze) {
    assert.notEqual(p.source, 'setting', 'override 无效时不该声称命中了它')
  } else {
    assert.equal(p.source, 'none')
    assert.equal(p.suiteDir, null)
  }
})

test('v1.9 探测：六个工具的位置都被逐个回报（含用途说明）', () => {
  const dir = fakeSuite(['tshark', 'capinfos', 'mergecap', 'editcap', 'dumpcap', 'text2pcap'])
  const p = probeWireshark({ overrideDir: dir })
  assert.equal(p.tools.length, 6)
  for (const t of p.tools) {
    assert.ok(t.path, `${t.tool} 应该找到`)
    assert.ok(t.purpose.length > 0, `${t.tool} 应该有用途说明`)
  }
  assert.deepEqual(p.missing, [])
})

test('v1.9 环境变量名与上游包约定一致（写错就静默失效）', () => {
  // 上游 wireshark-mcp 读的是 WIRESHARK_MCP_<TOOL>_PATH，不是 WIRESHARK_<TOOL>_PATH
  assert.equal(TOOL_ENV_VAR.tshark, 'WIRESHARK_MCP_TSHARK_PATH')
  assert.equal(TOOL_ENV_VAR.text2pcap, 'WIRESHARK_MCP_TEXT2PCAP_PATH')
  // 只有 tshark 是硬需求 —— 改错这个会让「装了 Wireshark 却判定不可用」
  assert.equal(TOOL_REQUIREMENT.tshark, 'required')
  assert.equal(TOOL_REQUIREMENT.dumpcap, 'optional')
})

test('v1.9 可用性：组件没装时如实报不可用，且给出原因', () => {
  const dir = fakeSuite(['tshark', 'dumpcap'])
  const a = checkWiresharkMcp(fakeUserData(), dir)
  assert.equal(a.installed, false)
  assert.equal(a.usable, false)
  assert.ok(a.reason && a.reason.includes('安装'))
  // tshark 在，但组件没装 —— 这两件事必须分开报，UI 才知道该引导用户做哪一步
  assert.equal(a.probe.canAnalyze, true)
})

test('v1.9 可用性：组件路径不存在时无论如何都不能算 usable', () => {
  // 不看 tshark 了 —— 本机可能真装了 Wireshark，那条分支的结果依赖环境。
  // 「没装组件就不可用」是纯逻辑约束，与环境无关，这才是稳定的断言。
  const a = checkWiresharkMcp(fakeUserData(), fs.mkdtempSync(path.join(os.tmpdir(), 'ws-none-')))
  assert.equal(a.installed, false)
  assert.equal(a.usable, false)
  assert.ok(a.paths.entry === null)
  // 原因文案二选一：要么说组件没装，要么说 tshark 没找到 —— 两者都必须可读
  assert.ok(a.reason && a.reason.length > 0)
})

test('v1.9 组件路径：解析到 userData 下的独立目录，不碰系统 Python', () => {
  const ud = fakeUserData()
  const p = wiresharkMcpPaths(ud)
  assert.ok(p.python.startsWith(ud), 'python 应落在 userData 内')
  assert.ok(p.python.includes('wireshark-mcp'))
  // 没装时 entry 为 null（不能给出一个不存在的路径让调用方误判已就绪）
  assert.equal(p.entry, null)
})

test('v1.9 配置生成：未就绪时拒绝产出配置（避免挂上一个必然失败的服务器）', () => {
  const dir = fakeSuite(['tshark'])
  const notInstalled = checkWiresharkMcp(fakeUserData(), dir)
  assert.equal(buildWiresharkMcpConfig(notInstalled), null)

  const noTshark = checkWiresharkMcp(
    fakeUserData(),
    fs.mkdtempSync(path.join(os.tmpdir(), 'ws-none2-'))
  )
  assert.equal(buildWiresharkMcpConfig(noTshark), null)
})

test('v1.9 配置生成：stdio 传输 + 幂等 id + 默认不信任', () => {
  const ud = fakeUserData()
  const dir = fakeSuite(['tshark', 'dumpcap'])
  // 伪造「组件已装」：建出 venv 结构与入口脚本
  const paths = wiresharkMcpPaths(ud)
  fs.mkdirSync(path.dirname(paths.python), { recursive: true })
  fs.writeFileSync(paths.python, '')
  const entry = process.platform === 'win32'
    ? path.join(path.dirname(paths.python), 'wireshark-mcp.exe')
    : path.join(path.dirname(paths.python), 'wireshark-mcp')
  fs.writeFileSync(entry, '')

  const a = checkWiresharkMcp(ud, dir)
  assert.equal(a.installed, true)
  assert.equal(a.usable, true)

  const cfg = buildWiresharkMcpConfig(a)
  assert.ok(cfg)
  assert.equal(cfg.transport, 'stdio')
  // 固定的 id 是幂等 upsert 的基础：换 id 会攒出一堆重复服务器
  assert.equal(cfg.id, WS_MCP_SERVER_ID)
  assert.equal(cfg.name, WS_MCP_SERVER_NAME)
  assert.equal(cfg.command, entry)
  // 外部工具默认走人工闸门 —— 不信任是安全的默认值
  assert.equal(cfg.trusted, false)
  assert.equal(cfg.enabled, true)
})

test('v1.9 配置生成：默认分析档，显式请求才给完整档', () => {
  const ud = fakeUserData()
  const dir = fakeSuite(['tshark'])
  const paths = wiresharkMcpPaths(ud)
  fs.mkdirSync(path.dirname(paths.python), { recursive: true })
  fs.writeFileSync(paths.python, '')
  const entry = process.platform === 'win32'
    ? path.join(path.dirname(paths.python), 'wireshark-mcp.exe')
    : path.join(path.dirname(paths.python), 'wireshark-mcp')
  fs.writeFileSync(entry, '')
  const a = checkWiresharkMcp(ud, dir)

  assert.deepEqual(buildWiresharkMcpConfig(a)?.args, ['serve', '--profile', 'analysis'])
  assert.deepEqual(buildWiresharkMcpConfig(a, { profile: 'full' })?.args, [
    'serve',
    '--profile',
    'full'
  ])
  // 非法档位收敛回 analysis，不能把用户手填的字符串透传给子进程
  assert.deepEqual(
    buildWiresharkMcpConfig(a, { profile: 'weird' })?.args,
    ['serve', '--profile', 'analysis']
  )
})

test('v1.9 探测持久化：默认配置包含 cachedProbe 为 null', () => {
  assert.equal(DEFAULT_SETTINGS.wireshark.dir, '')
  assert.equal(DEFAULT_SETTINGS.wireshark.cachedProbe, null)
})

test('v1.9 探测持久化：JsonStore 可持久化并读取 cachedProbe', () => {
  const tmpFile = path.join(fakeUserData(), 'store.json')
  const store = new JsonStore(tmpFile)
  assert.equal(store.getSettings().wireshark.cachedProbe, null)

  const fakeProbe = {
    installed: true,
    usable: true,
    attached: false,
    probe: {
      ready: true,
      canAnalyze: true,
      canCapture: false,
      tools: [],
      suiteDir: 'C:\\Program Files\\Wireshark',
      source: 'setting',
      version: '4.2.0',
      missing: []
    },
    reason: null,
    tsharkDir: 'C:\\Program Files\\Wireshark'
  }

  store.updateSettings({
    wireshark: {
      dir: 'C:\\Program Files\\Wireshark',
      cachedProbe: fakeProbe
    }
  })

  // 内存读取验证
  assert.deepEqual(store.getSettings().wireshark.cachedProbe, fakeProbe)

  // 跨进程 / 实例重新加载验证（从文件重读）
  const store2 = new JsonStore(tmpFile)
  assert.deepEqual(store2.getSettings().wireshark.cachedProbe, fakeProbe)
  assert.equal(store2.getSettings().wireshark.dir, 'C:\\Program Files\\Wireshark')
})

