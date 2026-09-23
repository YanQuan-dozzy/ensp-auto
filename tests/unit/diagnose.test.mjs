import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseExeFromRegOutput,
  locateEnsp,
  resolveEnspExe,
  ENSP_COMMON_PATHS,
  normalizeBaseUrl,
  buildProbePlan,
  extractErrorMessage,
  classifyHttpStatus,
  classifyNetworkError,
  runDiagnostics
} from '../.build/harness.mjs'

/**
 * v1.4：eNSP 定位 + 环境体检。
 *
 * 这两块的共同点是「失败路径比成功路径重要得多」——用户遇到的多半是找不到 eNSP、
 * 密钥错、端点错。所以测试重心放在错误分类的准确性上，而不是顺风路径。
 */

// ————————————————— 注册表输出解析 —————————————————

test('parseExeFromRegOutput：带引号的关联命令', () => {
  const raw = [
    'HKEY_CLASSES_ROOT\\eNSP.topo\\shell\\open\\command',
    '    (默认)    REG_SZ    "E:\\eNSP\\eNSP_Client.exe" "%1"'
  ].join('\r\n')
  assert.equal(parseExeFromRegOutput(raw), 'E:\\eNSP\\eNSP_Client.exe')
})

test('parseExeFromRegOutput：英文 (Default) 与无引号写法同样可解析', () => {
  const en = '    (Default)    REG_SZ    "D:\\Program Files\\Huawei\\eNSP\\eNSP_Client.exe" "%1"'
  assert.equal(parseExeFromRegOutput(en), 'D:\\Program Files\\Huawei\\eNSP\\eNSP_Client.exe')
  const bare = '    (默认)    REG_SZ    E:\\eNSP\\eNSP_Client.exe %1'
  assert.equal(parseExeFromRegOutput(bare), 'E:\\eNSP\\eNSP_Client.exe')
})

test('parseExeFromRegOutput：无 exe 或无盘符路径时返回 null', () => {
  assert.equal(parseExeFromRegOutput(''), null)
  assert.equal(parseExeFromRegOutput('HKEY_CLASSES_ROOT\\.topo\r\n    (默认)    REG_SZ    eNSP.topo'), null)
  // 没有盘符的相对命令不可用（无法直接 spawn），必须判为未找到
  assert.equal(parseExeFromRegOutput('    (默认)    REG_SZ    rundll32.exe shell32.dll'), null)
})

test('parseExeFromRegOutput：命令前置参数时仍能抠出 exe 绝对路径', () => {
  const raw = '    (默认)    REG_SZ    "C:\\Windows\\System32\\cmd.exe" /c "E:\\eNSP\\eNSP_Client.exe" "%1"'
  assert.equal(parseExeFromRegOutput(raw), 'C:\\Windows\\System32\\cmd.exe')
})

// ————————————————— eNSP 定位优先级 —————————————————

test('locateEnsp：设置指定的路径优先于其它候选，且命中即可用', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-locate-'))
  const fake = path.join(tmp, 'eNSP_Client.exe')
  fs.writeFileSync(fake, 'x')

  const r = locateEnsp(fake)
  assert.equal(r.found, fake)
  assert.equal(r.source, 'setting')
  assert.equal(r.candidates[0].path, fake)
  assert.equal(r.candidates[0].exists, true)

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('locateEnsp：配置路径不存在时仍保留为候选并标注 exists=false', () => {
  const missing = path.join(os.tmpdir(), 'definitely-missing-ensp', 'eNSP_Client.exe')
  const r = locateEnsp(missing)
  const entry = r.candidates.find((c) => c.path === missing)
  assert.ok(entry, '不存在的配置路径也应出现在候选里，便于 UI 解释')
  assert.equal(entry.exists, false)
  // 不假设本机是否装了 eNSP：只断言候选集合完整
  assert.ok(r.candidates.length >= ENSP_COMMON_PATHS.length - 1)
})

test('locateEnsp：候选去重（配置路径与常见路径重合时不重复）', () => {
  const common = ENSP_COMMON_PATHS[0]
  const r = locateEnsp(common)
  const hits = r.candidates.filter((c) => c.path.toLowerCase() === common.toLowerCase())
  assert.equal(hits.length, 1)
})

test('resolveEnspExe：找不到时给出可执行的修复指引', () => {
  const r = resolveEnspExe(path.join(os.tmpdir(), 'nope', 'eNSP_Client.exe'))
  if (!r.ok) {
    assert.match(r.error, /设置/)
    assert.match(r.error, /ENSP_EXE_PATH/)
  } else {
    // 本机确实装了 eNSP 时会命中常见路径，这也是正确行为
    assert.ok(r.exe.length > 0)
  }
})

// ————————————————— 端点与请求拼装 —————————————————

test('normalizeBaseUrl：去掉尾部斜杠，避免拼出双斜杠路径', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com')
  assert.equal(normalizeBaseUrl('  https://a.com/v1///  '), 'https://a.com/v1')
  assert.equal(normalizeBaseUrl(''), '')
})

test('buildProbePlan：兼容线补 /chat/completions，与运行时一致', () => {
  const p = buildProbePlan({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: 'sk-test'
  })
  assert.equal(p.ok, true)
  assert.equal(p.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(p.headers.authorization, 'Bearer sk-test')
  assert.equal(JSON.parse(p.body).model, 'deepseek-flash')
})

test('buildProbePlan：端点已带 /chat/completions 时不重复拼接', () => {
  const p = buildProbePlan({
    provider: 'custom',
    baseUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'qwen',
    apiKey: 'k'
  })
  assert.equal(p.url, 'http://localhost:11434/v1/chat/completions')
})

test('buildProbePlan：端点留空时走服务商默认值', () => {
  const p = buildProbePlan({ provider: 'kimi', baseUrl: '', model: 'kimi-k3', apiKey: 'k' })
  assert.equal(p.url, 'https://api.moonshot.cn/v1/chat/completions')
})

test('buildProbePlan：自定义端点留空必须报错而不是猜', () => {
  const p = buildProbePlan({ provider: 'custom', baseUrl: '', model: 'm', apiKey: 'k' })
  assert.equal(p.ok, false)
  assert.match(p.detail, /端点/)
})

test('buildProbePlan：缺密钥或缺模型名时明确拒绝', () => {
  const noKey = buildProbePlan({ provider: 'deepseek', baseUrl: '', model: 'm', apiKey: '' })
  assert.equal(noKey.ok, false)
  assert.match(noKey.detail, /API Key/)
  const noModel = buildProbePlan({ provider: 'deepseek', baseUrl: '', model: '', apiKey: 'k' })
  assert.equal(noModel.ok, false)
  assert.match(noModel.detail, /模型名/)
})

test('buildProbePlan：anthropic / google 走各自原生协议', () => {
  const a = buildProbePlan({ provider: 'anthropic', baseUrl: '', model: 'claude-sonnet-5', apiKey: 'k' })
  assert.equal(a.ok, true)
  assert.equal(a.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(a.headers['x-api-key'], 'k')
  assert.equal(JSON.parse(a.body).max_tokens, 1)

  const g = buildProbePlan({ provider: 'google', baseUrl: '', model: 'gemini-3-pro', apiKey: 'k' })
  assert.equal(g.ok, true)
  assert.match(g.url, /models\/gemini-3-pro:generateContent$/)
  assert.equal(g.headers['x-goog-api-key'], 'k')
})

// ————————————————— 错误信息与状态分类 —————————————————

test('extractErrorMessage：覆盖 OpenAI / Anthropic / Google / 纯文本四种错误体', () => {
  assert.equal(
    extractErrorMessage(JSON.stringify({ error: { message: 'Invalid API key' } })),
    'Invalid API key'
  )
  assert.equal(extractErrorMessage(JSON.stringify({ error: 'bad model' })), 'bad model')
  assert.equal(
    extractErrorMessage(JSON.stringify({ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } })),
    'API key not valid'
  )
  assert.equal(extractErrorMessage('502 Bad Gateway'), '502 Bad Gateway')
  assert.equal(extractErrorMessage(''), '')
})

test('extractErrorMessage：超长信息被压平截断', () => {
  const long = 'x'.repeat(400)
  const out = extractErrorMessage(JSON.stringify({ message: long }))
  assert.ok(out.length <= 161, `实际长度 ${out.length}`)
  assert.ok(out.endsWith('…'))
})

test('classifyHttpStatus：把密钥错、端点错、模型错分开报', () => {
  assert.equal(classifyHttpStatus(200, '').level, 'ok')
  assert.equal(classifyHttpStatus(401, '').level, 'fail')
  assert.match(classifyHttpStatus(401, '').detail, /密钥/)
  assert.match(classifyHttpStatus(403, '').hint, /API Key/)
  assert.match(classifyHttpStatus(404, '').hint, /端点/)
  assert.match(classifyHttpStatus(400, '').hint, /模型名/)
})

test('classifyHttpStatus：限流与服务端错误归为 warn（配置本身是通的）', () => {
  assert.equal(classifyHttpStatus(429, '').level, 'warn')
  assert.equal(classifyHttpStatus(500, '').level, 'warn')
  assert.equal(classifyHttpStatus(503, '').level, 'warn')
})

test('classifyHttpStatus：把服务商原文带进结论', () => {
  const v = classifyHttpStatus(401, JSON.stringify({ error: { message: 'Authentication Fails' } }))
  assert.match(v.detail, /Authentication Fails/)
})

test('classifyNetworkError：DNS / 拒绝 / 超时 / 证书四类各自可识别', () => {
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND api.x.com'), { cause: { code: 'ENOTFOUND' } })
  assert.match(classifyNetworkError(dns).detail, /DNS/)

  const refuse = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  assert.match(classifyNetworkError(refuse).detail, /拒绝/)

  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  assert.match(classifyNetworkError(abort).detail, /超时/)

  const cert = new Error('unable to verify the first certificate')
  assert.match(classifyNetworkError(cert).detail, /证书/)
})

test('classifyNetworkError：未知异常也给出可读结论而不是抛错', () => {
  const v = classifyNetworkError(new Error('something odd'))
  assert.equal(v.level, 'fail')
  assert.ok(v.detail.length > 0)
  assert.ok(v.hint)
})

// ————————————————— 体检编排 —————————————————

function baseDeps(overrides = {}) {
  return {
    settings: {
      theme: 'dark',
      scanStart: 2000,
      scanEnd: 2050,
      deviceEncoding: 'auto',
      terminalEchoAgentCommands: true,
      agent: {
        runtime: 'react',
        // v1.5：模型配置以「档案」为单位，体检探活的对象是活跃档案
        profiles: [
          {
            id: 'p-test',
            label: '测试档案',
            provider: 'deepseek',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            maxRounds: 12,
            temperature: 0.2
          }
        ],
        activeProfileId: 'p-test',
        systemPrompt: ''
      },
      panels: { left: 240, right: 380, leftCollapsed: false, rightCollapsed: false },
      mcp: { enabled: false, port: 49150, servers: [], exposeToAgent: true },
      ensp: { exePath: '' }
    },
    apiKey: null,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'diag-')),
    mcp: { running: false, url: '', error: null },
    ...overrides
  }
}

test('runDiagnostics：永远返回完整报告，缺密钥时端点检查标记为 skipped 而非 fail', async () => {
  const report = await runDiagnostics(baseDeps())
  assert.equal(report.checks.length, 5)
  assert.ok(report.ranAt > 0)

  const byId = new Map(report.checks.map((c) => [c.id, c]))
  assert.equal(byId.get('api-key').level, 'fail')
  assert.equal(byId.get('llm-endpoint').level, 'skipped')
  assert.equal(byId.get('mcp-port').level, 'skipped')
  assert.equal(byId.get('data-dir').level, 'ok')
  assert.ok(byId.has('ensp-client'))
})

test('runDiagnostics：探活成功时报告「通过 + 耗时 + 模型名」', async () => {
  const fakeFetch = async (_url, init) => {
    assert.equal(init.method, 'POST')
    assert.match(init.headers.authorization, /^Bearer /)
    return { status: 200, text: async () => '{}' }
  }
  const report = await runDiagnostics(baseDeps({ apiKey: 'sk-abcdef123456', fetchImpl: fakeFetch }))
  const llm = report.checks.find((c) => c.id === 'llm-endpoint')
  assert.equal(llm.level, 'ok')
  assert.match(llm.detail, /通过 \d+ms/)
  assert.match(llm.detail, /deepseek-flash/)
  // 密钥只回末 4 位，不泄露完整值
  const key = report.checks.find((c) => c.id === 'api-key')
  assert.match(key.detail, /3456/)
  assert.ok(!key.detail.includes('sk-abcdef'))
})

test('runDiagnostics：探活失败时把状态码判定原样带进结论', async () => {
  const fakeFetch = async () => ({
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'Invalid token' } })
  })
  const report = await runDiagnostics(baseDeps({ apiKey: 'sk-x1234567', fetchImpl: fakeFetch }))
  const llm = report.checks.find((c) => c.id === 'llm-endpoint')
  assert.equal(llm.level, 'fail')
  assert.match(llm.detail, /401/)
  assert.ok(llm.hint)
})

test('runDiagnostics：探活抛异常不冒泡，转为该检查项的 fail', async () => {
  const fakeFetch = async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND nope'), { cause: { code: 'ENOTFOUND' } })
  }
  const report = await runDiagnostics(baseDeps({ apiKey: 'sk-x1234567', fetchImpl: fakeFetch }))
  const llm = report.checks.find((c) => c.id === 'llm-endpoint')
  assert.equal(llm.level, 'fail')
  assert.match(llm.detail, /DNS/)
  // 单个检查失败不影响其它检查照常完成
  assert.equal(report.checks.find((c) => c.id === 'data-dir').level, 'ok')
})

test('runDiagnostics：MCP 开启且已在运行时直接报运行中，不做端口探测', async () => {
  const deps = baseDeps({ mcp: { running: true, url: 'http://127.0.0.1:49150/mcp', error: null } })
  deps.settings.mcp = { enabled: true, port: 49150 }
  const report = await runDiagnostics(deps)
  const mcp = report.checks.find((c) => c.id === 'mcp-port')
  assert.equal(mcp.level, 'ok')
  assert.match(mcp.detail, /运行中/)
})

test('runDiagnostics：MCP 启动失败时结论里带上错误原文与换端口建议', async () => {
  const deps = baseDeps({ mcp: { running: false, url: '', error: 'listen EADDRINUSE' } })
  deps.settings.mcp = { enabled: true, port: 49150 }
  const report = await runDiagnostics(deps)
  const mcp = report.checks.find((c) => c.id === 'mcp-port')
  assert.equal(mcp.level, 'fail')
  assert.match(mcp.detail, /EADDRINUSE/)
  assert.match(mcp.hint, /端口/)
})

test('runDiagnostics：数据目录不可写时给出明确失败', async () => {
  const deps = baseDeps({ userDataDir: path.join(os.tmpdir(), 'diag-file-not-dir', 'x') })
  // 用「文件当目录」制造必然失败的写入
  const blocker = path.join(os.tmpdir(), 'diag-file-not-dir')
  fs.mkdirSync(path.dirname(blocker), { recursive: true })
  fs.writeFileSync(blocker, 'blocked')
  const report = await runDiagnostics(deps)
  const dir = report.checks.find((c) => c.id === 'data-dir')
  assert.equal(dir.level, 'fail')
  assert.ok(dir.hint)
  fs.rmSync(blocker, { force: true })
})
