import { COMPAT_PROVIDERS, isCompatProvider, type LlmProvider } from '@shared/providers'
import type { DiagLevel } from '@shared/types'

/**
 * 模型端点探活的纯逻辑层（无 IO，可单测）。
 *
 * 为什么探活要发一次真实的对话请求，而不是 GET /models：
 * /models 只能验证「端点可达 + 密钥有效」，验证不了「模型名是否正确」——
 * 而模型名写错恰恰是这个应用里最常见的配置事故。发一条 `ping` 能一次验完全部三件事。
 *
 * 为什么故意不带 max_tokens：OpenAI 新代模型（gpt-5 系）只接受
 * max_completion_tokens，Anthropic 又强制要求 max_tokens。省略它两边都成立，
 * 代价只是多花几个 token——探活本身就必须证明「真能跑通」，不能用兼容性换。
 */

export interface ProbeInput {
  provider: LlmProvider
  baseUrl: string
  model: string
  apiKey: string
}

export type ProbePlan =
  | { ok: true; url: string; headers: Record<string, string>; body: string }
  | { ok: false; detail: string; hint: string }

export interface ProbeVerdict {
  level: DiagLevel
  detail: string
  hint?: string
}

const OPENAI_BASE = 'https://api.openai.com/v1'
const ANTHROPIC_BASE = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com'

/** 去掉尾部斜杠，避免拼出 `//chat/completions` 这种被部分网关拒绝的路径 */
export function normalizeBaseUrl(raw: string): string {
  return (raw ?? '').trim().replace(/\/+$/, '')
}

/**
 * 拼出与运行时一致的请求地址。
 *
 * 一致性依据：运行时走 pi-ai 的 openAICompletionsApi，内部是
 * `new OpenAI({ baseURL: model.baseUrl })`，SDK 会自补 `/chat/completions`。
 * 所以这里也必须拼 `/chat/completions`，否则体检通过而实跑失败。
 */
export function buildProbePlan(input: ProbeInput): ProbePlan {
  const model = (input.model ?? '').trim()
  const apiKey = (input.apiKey ?? '').trim()

  if (!apiKey) {
    return { ok: false, detail: '未配置 API Key', hint: '先在「模型」分区填入密钥。' }
  }

  if (!model) {
    return { ok: false, detail: '未填写模型名', hint: '先在「模型」分区填入服务商支持的模型名。' }
  }

  if (isCompatProvider(input.provider) || input.provider === 'openai') {
    const fallback = isCompatProvider(input.provider)
      ? COMPAT_PROVIDERS[input.provider].defaultBaseUrl
      : OPENAI_BASE
    const base = normalizeBaseUrl(input.baseUrl) || normalizeBaseUrl(fallback)
    if (!base) {
      return {
        ok: false,
        detail: '未填写 API 端点',
        hint: '「自定义 OpenAI 兼容端点」必须显式填写端点地址，例如 http://localhost:11434/v1。'
      }
    }
    const url = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
    return {
      ok: true,
      url,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }] })
    }
  }

  if (input.provider === 'anthropic') {
    return {
      ok: true,
      url: `${ANTHROPIC_BASE}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
    }
  }

  if (input.provider === 'google') {
    return {
      ok: true,
      url: `${GOOGLE_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 }
      })
    }
  }

  // 类型上不可达；保留兜底以免新增 provider 时静默走错分支
  return { ok: false, detail: `不支持的 provider：${String(input.provider)}`, hint: '请检查服务商设置。' }
}

/** 截断 + 压平，用于把服务商返回的长错误塞进一行 UI */
export function clip(s: string, max = 160): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 从各家五花八门的错误体里抠出可读信息（OpenAI / Anthropic / Google / 纯文本都覆盖） */
export function extractErrorMessage(body: string): string {
  const raw = (body ?? '').trim()
  if (!raw) return ''
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    const err = j['error']
    if (typeof err === 'string') return clip(err)
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>)['message']
      if (typeof m === 'string') return clip(m)
    }
    for (const k of ['message', 'msg', 'error_msg', 'detail', 'error_description']) {
      const v = j[k]
      if (typeof v === 'string' && v.trim()) return clip(v)
    }
  } catch {
    // 非 JSON（网关返回 HTML、纯文本等）：直接用原文
  }
  return clip(raw)
}

/**
 * HTTP 状态码 → 结论。
 * 关键取舍：401 与 404 必须分开报（密钥错 vs 端点错），修复动作完全不同；
 * 429 与 5xx 归为 warn —— 配置本身是通的，只是当下不可用。
 */
export function classifyHttpStatus(status: number, body: string): ProbeVerdict {
  const msg = extractErrorMessage(body)
  const suffix = msg ? `：${msg}` : ''

  if (status >= 200 && status < 300) return { level: 'ok', detail: '通过' }
  if (status === 401 || status === 403) {
    return {
      level: 'fail',
      detail: `密钥被拒绝（${status}）${suffix}`,
      hint: '确认 API Key 属于当前服务商、未过期且账户有余额。切换服务商后忘记换 Key 是最常见原因。'
    }
  }
  if (status === 404) {
    return {
      level: 'fail',
      detail: `端点不存在（404）${suffix}`,
      hint: 'API 端点可能填错：常见是漏写或多写了 /v1，或把 chat 路径重复拼进了端点。'
    }
  }
  if (status === 400 || status === 422) {
    return {
      level: 'fail',
      detail: `请求被拒绝（${status}）${suffix}`,
      hint: '最常见原因是模型名不被该服务商接受。请对照服务商文档核对「模型名」。'
    }
  }
  if (status === 429) {
    return {
      level: 'warn',
      detail: `限流或额度不足（429）${suffix}`,
      hint: '密钥有效、端点是通的，但当前不可用。稍后重试或检查账户余额。'
    }
  }
  if (status >= 500) {
    return {
      level: 'warn',
      detail: `服务商侧错误（${status}）${suffix}`,
      hint: '本地配置看起来是通的，问题在服务商。可稍后重试或换一个模型。'
    }
  }
  return { level: 'warn', detail: `未预期的状态码 ${status}${suffix}` }
}

/** 网络层异常 → 结论。把「连不上」拆成 DNS / 拒绝 / 超时 / 证书四类，各自的修法完全不同 */
export function classifyNetworkError(e: unknown): ProbeVerdict {
  const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string } }
  const code = err?.cause?.code ?? err?.code ?? ''
  const msg = err?.message ?? String(e)

  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /abort/i.test(msg)) {
    return {
      level: 'fail',
      detail: '连接超时（8 秒无响应）',
      hint: '端点不可达或被网络策略拦截。若走中转/代理，确认该地址本机可访问。'
    }
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|ENOTFOUND/i.test(msg)) {
    return {
      level: 'fail',
      detail: '域名无法解析（DNS 失败）',
      hint: '检查 API 端点域名是否拼写正确，以及本机 DNS 与外网连通性。'
    }
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED|ECONNRESET|socket hang up/i.test(msg)) {
    return {
      level: 'fail',
      detail: '连接被拒绝或中断',
      hint: '对端没有服务在监听。本地模型（Ollama / vLLM）常见于服务未启动或端口写错。'
    }
  }
  if (/certificate|CERT_|self.signed|\bSSL\b|\bTLS\b/i.test(msg)) {
    return {
      level: 'fail',
      detail: 'TLS 证书校验失败',
      hint: '若使用自建中转，确认其证书被系统信任，或改用标准端口的正常证书。'
    }
  }
  if (code === 'ETIMEDOUT' || /ETIMEDOUT|network|fetch failed/i.test(msg)) {
    return {
      level: 'fail',
      detail: `网络不可达（${clip(msg, 80)}）`,
      hint: '检查本机网络、代理设置与防火墙。'
    }
  }
  return { level: 'fail', detail: `请求失败：${clip(msg, 120)}`, hint: '检查网络连通性与 API 端点。' }
}
