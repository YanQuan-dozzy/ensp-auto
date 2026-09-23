import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { DiagCheck, DiagReport, Settings } from '@shared/types'
import { ENSP_SOURCE_LABEL } from '@shared/types'
import { activeProfile } from '@shared/profiles'
import { locateEnsp } from '../ensp/launcher'
import { buildProbePlan, classifyHttpStatus, classifyNetworkError } from './probe'

/**
 * 环境体检。
 *
 * 存在的理由：这个应用依赖三件外部事物——eNSP 装没装对、模型端点通不通、
 * MCP 端口占没被占。而原来的反馈闭环是「等第一次跑任务炸掉才知道」。
 * 设置页是唯一天然的体检入口，所以把判断前置到这里。
 *
 * 设计约束：
 * - 检查项之间互不阻塞，任一项抛错只影响它自己（整体永远返回报告，不返回异常）。
 * - 前置条件不满足时用 skipped 而不是 fail——「没配密钥所以没探活」不等于「配置错了」。
 */

const PROBE_TIMEOUT_MS = 8000

export interface DiagDeps {
  settings: Settings
  /** 由主进程读出后传入：密钥不到渲染层，但体检需要它来判断「配置了没」和做探活 */
  apiKey: string | null
  userDataDir: string
  mcp: { running: boolean; url: string; error: string | null }
  /** 便于测试注入；默认用全局 fetch */
  fetchImpl?: typeof fetch
}

/** 探测 127.0.0.1:port 是否可绑定。已运行的服务会占住端口，因此只在未运行时用 */
function probePort(port: number): Promise<{ bindable: boolean; code: string }> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    const done = (bindable: boolean, code: string): void => {
      try {
        srv.close()
      } catch {
        /* 未监听时 close 会报错，忽略 */
      }
      resolve({ bindable, code })
    }
    srv.once('error', (e: NodeJS.ErrnoException) => done(false, e.code ?? 'UNKNOWN'))
    srv.once('listening', () => done(true, ''))
    try {
      srv.listen(port, '127.0.0.1')
    } catch (e) {
      done(false, (e as NodeJS.ErrnoException).code ?? 'UNKNOWN')
    }
  })
}

async function checkApiKey(deps: DiagDeps): Promise<DiagCheck> {
  const key = deps.apiKey
  if (!key) {
    return {
      id: 'api-key',
      label: 'API Key',
      level: 'fail',
      detail: '未配置',
      hint: '在「模型」分区填入密钥。未配置时代理会自动回退到 mock 运行时，不会报错但也无法真实执行。'
    }
  }
  // 只显示末 4 位：既能确认「用的是不是我以为的那把」，又不完整暴露
  const tail = key.length >= 8 ? key.slice(-4) : ''
  return {
    id: 'api-key',
    label: 'API Key',
    level: 'ok',
    detail: tail ? `已配置 · 末尾 ${tail}` : '已配置'
  }
}

async function checkLlmEndpoint(deps: DiagDeps): Promise<DiagCheck> {
  const base = { id: 'llm-endpoint' as const, label: '模型端点' }
  if (!deps.apiKey) {
    return { ...base, level: 'skipped', detail: '未配置密钥，跳过网络探活', hint: '填入 API Key 后可自动验证端点与模型名。' }
  }

  // v1.5：探活的对象是「当前活跃档案」，与代理实际发请求用的一致
  const a = activeProfile(deps.settings.agent)
  const plan = buildProbePlan({
    provider: a.provider,
    baseUrl: a.baseUrl,
    model: a.model,
    apiKey: deps.apiKey
  })
  if (!plan.ok) {
    return { ...base, level: 'fail', detail: plan.detail, hint: plan.hint }
  }

  const doFetch = deps.fetchImpl ?? fetch
  const t0 = Date.now()
  try {
    const res = await doFetch(plan.url, {
      method: 'POST',
      headers: plan.headers,
      body: plan.body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    const ms = Date.now() - t0
    const body = await res.text().catch(() => '')
    const verdict = classifyHttpStatus(res.status, body)
    return {
      ...base,
      level: verdict.level,
      detail: verdict.level === 'ok' ? `通过 ${ms}ms · ${a.model}` : verdict.detail,
      ...(verdict.hint ? { hint: verdict.hint } : {}),
      ms
    }
  } catch (e) {
    return { ...base, ...classifyNetworkError(e), ms: Date.now() - t0 }
  }
}

async function checkEnsp(deps: DiagDeps): Promise<DiagCheck> {
  const base = { id: 'ensp-client' as const, label: 'eNSP 客户端' }
  try {
    const r = locateEnsp(deps.settings.ensp.exePath)
    if (r.found) {
      return {
        ...base,
        level: 'ok',
        detail: `${r.found}（来源：${ENSP_SOURCE_LABEL[r.source]}）`
      }
    }
    return {
      ...base,
      level: 'fail',
      detail: `未找到 eNSP_Client.exe（已探测 ${r.candidates.length} 个候选路径）`,
      hint: '在「集成 → eNSP 客户端」指定安装路径。未指定时无法把 AI 生成或修改的拓扑交给 eNSP 打开。',
      action: 'pick-ensp'
    }
  } catch (e) {
    return { ...base, level: 'fail', detail: `探测失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

async function checkMcpPort(deps: DiagDeps): Promise<DiagCheck> {
  const base = { id: 'mcp-port' as const, label: 'MCP 对外服务' }
  const mcp = deps.settings.mcp

  if (!mcp.enabled) {
    return { ...base, level: 'skipped', detail: '未开启，无需检查端口' }
  }
  if (deps.mcp.running) {
    return { ...base, level: 'ok', detail: `运行中 · ${deps.mcp.url}` }
  }
  if (deps.mcp.error) {
    return {
      ...base,
      level: 'fail',
      detail: `启动失败：${deps.mcp.error}`,
      hint: `若为端口占用，换一个端口（当前 ${mcp.port}）后保存即可即时重启。`
    }
  }

  const { bindable, code } = await probePort(mcp.port)
  if (bindable) return { ...base, level: 'ok', detail: `端口 ${mcp.port} 可用` }
  return {
    ...base,
    level: 'warn',
    detail: `端口 ${mcp.port} 已被占用（${code}）`,
    hint: '换一个端口再保存，MCP 服务会即时重启。'
  }
}

async function checkDataDir(deps: DiagDeps): Promise<DiagCheck> {
  const base = { id: 'data-dir' as const, label: '数据目录' }
  const dir = deps.userDataDir
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.write-probe')
    fs.writeFileSync(probe, String(Date.now()), 'utf8')
    fs.rmSync(probe, { force: true })
    return { ...base, level: 'ok', detail: dir }
  } catch (e) {
    return {
      ...base,
      level: 'fail',
      detail: `不可写：${e instanceof Error ? e.message : String(e)}`,
      hint: '设置、快照与会话历史都写在这里。检查目录权限或磁盘空间。'
    }
  }
}

export async function runDiagnostics(deps: DiagDeps): Promise<DiagReport> {
  const checks = await Promise.all([
    checkApiKey(deps),
    checkLlmEndpoint(deps),
    checkEnsp(deps),
    checkMcpPort(deps),
    checkDataDir(deps)
  ])
  return { ranAt: Date.now(), checks }
}
