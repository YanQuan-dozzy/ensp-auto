import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchPromptTail,
  splitTrailingPrompt,
  extractView,
  cleanResponse,
  stripIac,
  stripAnsi,
  applyBackspaces,
  removeEchoLine,
  detectError,
  hasWarning,
  decode,
  detectEncoding,
  tailSlice,
  parseInterfaces,
  diffLines,
  parseVersion,
  classifyDanger,
  isReadOnlyCommand
} from '../.build/harness.mjs'

// ————————————————— 提示符解析与视图推断 —————————————————

test('提示符：10 种形态都能解析出正确视图', () => {
  const cases = [
    ['<Huawei>', 'user', 'Huawei'],
    ['[Huawei]', 'system', 'Huawei'],
    ['[Huawei-GigabitEthernet0/0/1]', 'interface', 'Huawei'],
    ['[Huawei-Vlanif10]', 'interface', 'Huawei'],
    ['[Huawei-vlan10]', 'vlan', 'Huawei'],
    ['[Huawei-ospf-1]', 'ospf', 'Huawei'],
    ['[Huawei-ospf-1-area-0.0.0.0]', 'ospf', 'Huawei'],
    ['[Huawei-acl-basic-2000]', 'acl', 'Huawei'],
    ['[Huawei-ui-vty0-4]', 'other', 'Huawei'],
    ['[~Huawei]', 'system', 'Huawei']
  ]
  for (const [prompt, view, host] of cases) {
    const m = matchPromptTail(`some output\r\n${prompt}`)
    assert.ok(m, `未能解析提示符 ${prompt}`)
    assert.equal(m.info.view, view, `${prompt} 视图判定错误`)
    assert.equal(m.info.host, host, `${prompt} 宿主名判定错误`)
  }
})

test('提示符：宿主名含连字符时不会被误切（Core-SW1）', () => {
  const m = matchPromptTail('\n[Core-SW1]')
  assert.ok(m)
  assert.equal(m.info.host, 'Core-SW1')
  assert.equal(m.info.suffix, '')
  assert.equal(m.info.view, 'system')
})

test('提示符：~ 前缀标记未提交状态', () => {
  const split = extractView('~Huawei-ospf-1')
  assert.equal(split.uncommitted, true)
  assert.equal(split.host, 'Huawei')
  assert.equal(split.view, 'ospf')
})

test('提示符防误判：输出正文里的 [OK] 在已知宿主名时被拒绝', () => {
  assert.ok(matchPromptTail('\n[OK]'), '无宿主名约束时 [OK] 会命中（这是已知局限）')
  assert.equal(matchPromptTail('\n[OK]', 'Huawei'), null, '有宿主名约束时必须拒绝')
})

test('提示符防误判：含空白的方括号内容不被当作提示符', () => {
  assert.equal(matchPromptTail('\n[Line protocol is UP]'), null)
})

test('提示符：尾部只允许空白，正文中间的同形串不命中', () => {
  assert.equal(matchPromptTail('\n[Huawei] more text'), null)
})

test('splitTrailingPrompt 能切掉尾部提示符并保留主体', () => {
  const r = splitTrailingPrompt('VLAN 10 exists\r\n<Huawei>', 'Huawei')
  assert.equal(r.body.trim(), 'VLAN 10 exists')
  assert.equal(r.prompt?.raw, '<Huawei>')
})

// ————————————————— 清洗 —————————————————

test('清洗：剥离 Telnet IAC（两字节命令 + 三字节协商 + 子协商）', () => {
  const input = Buffer.concat([
    Buffer.from([0xff, 0xfb, 0x01]), // IAC WILL ECHO
    Buffer.from('hello', 'utf8'),
    Buffer.from([0xff, 0xfa, 0x01, 0x02, 0xff, 0xf0]), // IAC SB ... IAC SE
    Buffer.from(' world', 'utf8')
  ])
  assert.equal(stripIac(input).toString('utf8'), 'hello world')
})

test('清洗：转义的 0xFF 被还原为单个字节', () => {
  const input = Buffer.from([0xff, 0xff])
  assert.deepEqual([...stripIac(input)], [0xff])
})

test('清洗：剥离 ANSI CSI / OSC / 单字符转义', () => {
  const input = '\u001b[31mRED\u001b[0m normal \u001b]0;title\u0007tail'
  assert.equal(stripAnsi(input), 'RED normal tail')
})

test('清洗：退格删除前一个字符（abcd\\x08\\x08xy → abxy）', () => {
  assert.equal(applyBackspaces('abcd\x08\x08xy'), 'abxy')
})

test('清洗：\\b空格\\b 三元组等价于删一个字符', () => {
  assert.equal(applyBackspaces('abc\x08 \x08d'), 'abd')
})

test('清洗：去除首行命令回显', () => {
  assert.equal(removeEchoLine('display vlan\r\nVLAN 10\r\n', 'display vlan'), 'VLAN 10\r\n')
})

test('清洗：长命令折行回显也能整体去除', () => {
  const text = 'display current-config\nuration\nsysname Huawei\n'
  const out = removeEchoLine(text, 'display current-configuration')
  assert.equal(out.trim(), 'sysname Huawei')
})

test('清洗：非回显首行不被误删', () => {
  const text = 'VLAN 10 exists\ndisplay vlan\n'
  assert.equal(removeEchoLine(text, 'display vlan'), text)
})

test('清洗：完整流程产出干净文本', () => {
  const raw = '\r\ndisplay version\r\n\u001b[42mHuawei VRP\u001b[0m\r\n\r\n\r\n<Huawei>'
  const out = cleanResponse(raw, 'display version')
  assert.ok(!out.includes('display version'), '命令回显应被移除')
  assert.ok(out.includes('Huawei VRP'), '正文应保留')
  assert.ok(!out.includes('\u001b'), 'ANSI 应被清除')
})

// ————————————————— 错误识别 —————————————————

test('错误识别：全部模式映射到正确错误码', () => {
  const cases = [
    ["Error: Unrecognized command found at '^' position.", 'UNRECOGNIZED'],
    ['% Unrecognized command', 'UNRECOGNIZED'],
    ["Error: Incomplete command found at '^' position.", 'INCOMPLETE'],
    ["Error: Ambiguous command found at '^' position.", 'AMBIGUOUS'],
    ["Error: Wrong parameter found at '^' position.", 'BAD_PARAM'],
    ["Error: Too many parameters found at '^' position.", 'TOO_MANY_PARAMS'],
    ['% Invalid input detected at "^" marker.', 'INVALID_INPUT'],
    ['Error: The command is being executed, please wait...', 'BUSY'],
    ['Error: You do not have permission to run this command.', 'NO_PERMISSION'],
    ['Error: Failed to create the VLAN.', 'FAILED']
  ]
  for (const [text, code] of cases) {
    const e = detectError(text)
    assert.ok(e, `未识别：${text}`)
    assert.equal(e.code, code, `${text} → 期望 ${code}，实际 ${e.code}`)
  }
})

test('错误识别：正常回显里的 "Input error: 0" 不被判成失败', () => {
  const out = ['Interface GigabitEthernet0/0/0', 'Input error: 0', 'Output error: 0'].join('\n')
  assert.equal(detectError(out), null, '这是字段名而非错误信息，不能误判')
})

test('错误识别：缩进的 Error 行仍能被识别', () => {
  const e = detectError('    Error: Wrong parameter found at \'^\' position.')
  assert.equal(e?.code, 'BAD_PARAM')
})

test('Warning 不等于失败', () => {
  assert.equal(hasWarning('Warning: The configuration will be saved.'), true)
  assert.equal(detectError('Warning: The configuration will be saved.'), null)
})

// ————————————————— 编码 —————————————————

test('编码：纯 ASCII 判为 UTF-8', () => {
  assert.equal(detectEncoding(Buffer.from('display version', 'utf8')), 'utf8')
})

test('编码：合法 UTF-8 中文判为 UTF-8', () => {
  const buf = Buffer.from('设备正常', 'utf8')
  assert.equal(detectEncoding(buf), 'utf8')
  assert.equal(decode(buf, 'utf8').text, '设备正常')
})

test('编码：非法 UTF-8 序列回退 GBK', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // 「中文」的 GBK 字节
  assert.equal(detectEncoding(gbk), 'gbk')
  assert.equal(decode(gbk, 'gbk').text, '中文')
})

test('编码：GBK 解码不产生替换符', () => {
  const r = decode(Buffer.from([0xc9, 0xe8, 0xb1, 0xb8]), 'gbk')
  assert.equal(r.text, '设备')
  assert.equal(r.issues, false)
})

test('编码：tailSlice 从多字节字符中间截断时回退到安全边界', () => {
  const buf = Buffer.from('前缀中文结尾', 'utf8')
  const sliced = tailSlice(buf, 3)
  const text = decode(sliced, 'utf8').text
  assert.ok(!text.startsWith('\uFFFD'), `截断点未对齐会产生替换符：${text}`)
})

// ————————————————— 命令分类与解析 —————————————————

test('危险命令：显式清单全部命中', () => {
  for (const cmd of [
    'reboot',
    'reset saved-configuration',
    'erase startup-config',
    'format',
    'save',
    'rollback configuration'
  ]) {
    assert.equal(classifyDanger(cmd).dangerous, true, `${cmd} 应被判为危险`)
  }
})

test('危险命令：带参数形式也命中', () => {
  assert.equal(classifyDanger('save force').dangerous, true)
  assert.equal(classifyDanger('reboot fast').dangerous, true)
})

test('危险命令：结构规则命中 undo startup / delete /unreserved', () => {
  assert.equal(classifyDanger('undo startup saved-configuration').dangerous, true)
  assert.equal(classifyDanger('delete flash:/vrpcfg.zip /unreserved').dangerous, true)
})

test('危险命令：普通配置命令不误判', () => {
  for (const cmd of ['system-view', 'vlan 10', 'interface GigabitEthernet0/0/1', 'undo shutdown']) {
    assert.equal(classifyDanger(cmd).dangerous, false, `${cmd} 不应被判为危险`)
  }
})

test('只读白名单：display/show 通过，配置命令被拒', () => {
  for (const ok of ['display vlan', 'show version', 'dir', 'ping 10.0.0.1', 'tracert 1.1.1.1']) {
    assert.equal(isReadOnlyCommand(ok), true, `${ok} 应通过白名单`)
  }
  for (const bad of ['system-view', 'vlan 10', 'undo shutdown', 'save']) {
    assert.equal(isReadOnlyCommand(bad), false, `${bad} 不应通过白名单`)
  }
})

test('解析接口表：识别 up/down 与 unassigned', () => {
  const text = [
    'Interface                   IP Address      Physical Status   Protocol Status',
    'GigabitEthernet0/0/0        10.0.0.1/24     up                up',
    'GigabitEthernet0/0/1        unassigned      down              down'
  ].join('\n')
  const rows = parseInterfaces(text)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'GigabitEthernet0/0/0')
  assert.equal(rows[0].ip, '10.0.0.1')
  assert.equal(rows[0].mask, '24')
  assert.equal(rows[0].protocol, 'up')
  assert.equal(rows[1].ip, undefined)
  assert.equal(rows[1].status, 'down')
})

test('解析 display version：抽出型号与 VRP 版本', () => {
  const text = 'Huawei Versatile Routing Platform Software\nVRP (R) software, Version 5.170 (AR2220 V300R003C00SPC200)'
  const info = parseVersion(text)
  assert.equal(info.model, 'AR2220')
  assert.equal(info.vrpVersion, '5.170')
})

test('配置 diff：识别新增与删除行', () => {
  const oldText = 'sysname Huawei\ninterface GE0/0/0\n ip address 10.0.0.1 255.255.255.0'
  const newText = 'sysname Huawei\ninterface GE0/0/0\n ip address 10.0.0.2 255.255.255.0'
  const { added, removed } = diffLines(oldText, newText)
  assert.deepEqual(added, [' ip address 10.0.0.2 255.255.255.0'])
  assert.deepEqual(removed, [' ip address 10.0.0.1 255.255.255.0'])
})
