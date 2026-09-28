import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { detectEnspFromRegistry, probePort } from '../.build/harness.mjs'

/**
 * 工程链守卫（B6：N25 / N31 / N37 / N77 / N78）。
 *
 * 这一批守的都是「不会崩、只会静默失效」的工程问题：用例依赖宿主环境、
 * 两处 external 口径漂移、文档漂移没有红灯。故用**确定性替身 + 源码文本对账**。
 */

const ROOT = path.resolve(import.meta.dirname, '../..')

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ————————————————— N31：eNSP 注册表探测可注入（用例不再依赖宿主 reg.exe） —————————————————

test('N31 detectEnspFromRegistry：注入 fake 注册表输出即可确定性判定（不碰宿主 reg.exe）', () => {
  // 非 Windows 平台下该函数按设计直接返回 null（随后走常见路径候选）
  if (process.platform !== 'win32') {
    assert.equal(detectEnspFromRegistry(() => ''), null)
    return
  }
  const regOutput = (args) => {
    const key = args[1] ?? ''
    if (key === 'HKCR\\.topo') {
      return 'HKEY_CLASSES_ROOT\\.topo\r\n    (默认)    REG_SZ    eNSP.topo\r\n'
    }
    if (key === 'HKCR\\eNSP.topo\\shell\\open\\command') {
      return 'HKEY_CLASSES_ROOT\\eNSP.topo\\shell\\open\\command\r\n    (默认)    REG_SZ    "D:\\tools\\eNSP\\eNSP_Client.exe" "%1"\r\n'
    }
    return ''
  }
  assert.equal(detectEnspFromRegistry(regOutput), 'D:\\tools\\eNSP\\eNSP_Client.exe')

  // 注册表里什么都没有 → null（而不是抛错/挂住）
  assert.equal(detectEnspFromRegistry(() => ''), null)

  // 只有兜底的 Applications 注册：也应能抠出路径
  const viaApplications = (args) =>
    args[1] === 'HKCR\\Applications\\eNSP_Client.exe\\shell\\open\\command'
      ? '    (默认)    REG_SZ    "C:\\eNSP\\eNSP_Client.exe" "%1"\r\n'
      : ''
  assert.equal(detectEnspFromRegistry(viaApplications), 'C:\\eNSP\\eNSP_Client.exe')
})

// ————————————————— N37：端口探测有兜底（正常路径的契约） —————————————————

test('N37 probePort：空闲端口可绑定 / 被占用端口返回不可绑定（不挂死）', async () => {
  // 先拿一个空闲端口
  const free = await new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
  const ok = await probePort(free)
  assert.equal(ok.bindable, true, `空闲端口应可绑定：${JSON.stringify(ok)}`)

  // 占住它，再探一次
  const holder = net.createServer()
  await new Promise((resolve) => holder.listen(free, '127.0.0.1', resolve))
  try {
    const busy = await probePort(free)
    assert.equal(busy.bindable, false)
    assert.equal(busy.code, 'EADDRINUSE')
  } finally {
    await new Promise((resolve) => holder.close(resolve))
  }
})

// ————————————————— N77：harness 与打包的 external 口径必须一致 —————————————————

test('N77 harness bundle 与 electron.vite external 列表一致（漏改一处 = 单测过/打包炸）', () => {
  const extract = (rel) => {
    const src = read(rel)
    const m = /external:\s*\[([^\]]*)\]/.exec(src)
    assert.ok(m, `${rel} 里没找到 external 数组`)
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
  }
  const harness = extract('tests/harness/bundle.mjs')
  const vite = extract('electron.vite.config.ts')
  assert.ok(harness.length > 0, 'external 不应为空')
  assert.deepEqual(harness, vite)
})

// ————————————————— N78 / N25：package.json 的工程链完整性 —————————————————

test('N78 verify 脚本必须包含文档路径守卫（否则文档漂移不会有红灯）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(pkg.scripts.verify, /check-doc-paths\.py/)
})

test('N25 package.json 引用的脚本/配置必须存在（全新 clone 不能 MODULE_NOT_FOUND）', () => {
  const pkg = JSON.parse(read('package.json'))
  const scripts = Object.values(pkg.scripts).join(' ')
  const refs = new Set()
  for (const m of scripts.matchAll(/(?:node|powershell[^&|;]*?-File)\s+([\w./-]+\.(?:cjs|mjs|js|ps1))/g)) {
    refs.add(m[1])
  }
  // dist 走 electron-builder 默认读取它
  refs.add('electron-builder.yml')
  const missing = [...refs].filter((f) => !fs.existsSync(path.join(ROOT, f)))
  assert.deepEqual(missing, [], `package.json 引用了不存在的文件：${missing.join(', ')}`)
})