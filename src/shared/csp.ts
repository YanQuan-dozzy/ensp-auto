/**
 * 生产 CSP 的**单一事实源**（N5）。
 *
 * 为什么必须放在 shared：两处消费同一份策略 ——
 *   ① 主进程 `src/main/index.ts` 的响应头（仅非 dev）；
 *   ② 构建期注入到 `out/renderer/index.html` 的 `<meta http-equiv="Content-Security-Policy">`。
 *
 * 为什么必须双通道：Electron 的 `file://` 资源**不经 HTTP 响应头**，打包态
 * `onHeadersReceived` 实际拿不到 —— 只靠响应头等于「生产 CSP 从未下发」，任何将来的
 * 注入点都会直接生效。故打包态必须靠 `<meta>` 兜底。
 *
 * 为什么 `<meta>` 只在**构建期**注入（而不是静态写在 `src/renderer/index.html`）：
 * dev 下 `@vitejs/plugin-react` 会往 HTML 注入内联 preamble 脚本，静态 meta 的
 * `script-src 'self'` 会把它拦掉 → HMR 直接失效。见 `electron.vite.config.ts` 的注入插件。
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')