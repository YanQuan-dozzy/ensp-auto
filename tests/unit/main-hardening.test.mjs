import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 主进程启动期安全守卫（N4 / N5 / N34-1 引入）。
 *
 * 为什么需要静态对账：这几条守的都是**进程启动期**行为（单实例锁、导航白名单、权限
 * 处理器、生产 CSP 注入），既没有可直接 import 的纯函数（`main/index.ts` 顶层拉
 * electron），也不会被 `tsc` / 单元测试覆盖 —— 回归只会在真机以「数据莫名回退」
 * 「CSP 没生效」的形式暴露。故从源码文本做断言，与 ipc-coverage 同路子。
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const MAIN = path.join(ROOT, 'src/main/index.ts')
const VITE_CONFIG = path.join(ROOT, 'electron.vite.config.ts')
const CSP_MODULE = path.join(ROOT, 'src/shared/csp.ts')

const mainSource = () => codeOnly(fs.readFileSync(MAIN, 'utf8'))

/**
 * 去掉注释行再做断言：注释里可以自由引用旧写法（便于解释「为什么改」），
 * 但不该影响「代码里是否真的还在用旧写法」的判定。
 */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    })
    .join('\n')
}

test('N4 主进程必须请求单实例锁，拿不到就退出（防双开整份覆盖数据）', () => {
  const src = mainSource()
  assert.match(src, /app\.requestSingleInstanceLock\(\)/, '缺少单实例锁')
  assert.match(src, /app\.on\(\s*'second-instance'/, '缺少 second-instance 唤起（第二次启动应聚焦已有窗口）')
  // 拿不到锁必须 quit，且不能继续初始化 Services
  const idx = src.indexOf('requestSingleInstanceLock')
  assert.ok(idx >= 0)
  const tail = src.slice(idx, idx + 600)
  assert.match(tail, /app\.quit\(\)/, '拿不到锁时应 app.quit()')
})

test('N34-1 窗口关闭后必须把 mainWindow 置 null', () => {
  const src = mainSource()
  const start = src.indexOf("win.on('closed'")
  assert.ok(start >= 0, "缺少 win.on('closed') 处理器")
  const block = src.slice(start, start + 300)
  assert.match(block, /mainWindow\s*=\s*null/, 'closed 回调里必须把 mainWindow 置 null')
})

test('N5 导航白名单按精确 URL/origin 判定，不得再用 file:// 协议前缀放行', () => {
  const src = mainSource()
  assert.ok(
    !/url\.startsWith\('file:\/\/'\)/.test(src),
    "不得再用 url.startsWith('file://') —— 会放行任意本地 HTML（preload 对新文档同样生效）"
  )
  assert.match(src, /isAllowedNavigation/, '缺少 isAllowedNavigation 判定')
  assert.match(src, /pathToFileURL/, '打包态应用 pathToFileURL 生成精确的 index.html URL')
})

test('N5 必须一律拒绝权限请求', () => {
  const src = mainSource()
  assert.match(src, /setPermissionRequestHandler\(/, '缺少权限请求处理器')
  assert.match(src, /setPermissionRequestHandler\([\s\S]{0,200}callback\(false\)/, '权限请求必须一律 callback(false)')
})

test('N5 生产 CSP 走单一事实源，且只在构建期注入 <meta>（避免 dev HMR 失效）', () => {
  const csp = fs.readFileSync(CSP_MODULE, 'utf8')
  assert.match(csp, /export const CONTENT_SECURITY_POLICY/)

  const main = mainSource()
  assert.match(main, /from '@shared\/csp'/, '主进程应复用 shared/csp 的策略文本（单一事实源）')
  assert.match(main, /CONTENT_SECURITY_POLICY/, '主进程响应头应使用共享策略')

  const cfg = fs.readFileSync(VITE_CONFIG, 'utf8')
  assert.match(cfg, /from '\.\/src\/shared\/csp'/, '构建配置应复用共享策略')
  assert.match(cfg, /http-equiv="Content-Security-Policy"/, '构建期应注入 meta CSP')
  assert.match(cfg, /apply:\s*'build'/, 'CSP 注入必须限定 build（dev 注入会拦掉 react 内联 preamble）')
})