import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { CONTENT_SECURITY_POLICY } from './src/shared/csp'

const shared = resolve(import.meta.dirname, 'src/shared')
const renderer = resolve(import.meta.dirname, 'src/renderer')

/**
 * N5：把生产 CSP 以 `<meta>` 注入到构建产物 `out/renderer/index.html`。
 *
 * 为什么只在 `apply: 'build'`：dev 下 `@vitejs/plugin-react` 会注入内联 preamble 脚本，
 * 静态 meta 的 `script-src 'self'` 会把它拦掉、HMR 直接失效。故 dev 不注入。
 * 为什么需要 meta：打包态 `file://` 资源不经 HTTP 响应头，主进程的 onHeadersReceived
 * 对文档不生效 —— 只靠响应头等于生产 CSP 从未下发。策略文本与主进程共用
 * `src/shared/csp.ts`（单一事实源）。
 */
const injectProdCsp = {
  name: 'inject-prod-csp',
  apply: 'build' as const,
  transformIndexHtml(html: string): string {
    return html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`
    )
  }
}

export default defineConfig({
  main: {
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/main/index.ts') },
        // MCP SDK 及其依赖为 CJS 动态 require，打入 ESM bundle 会炸（R1），
        // 一律外部化，运行时从 node_modules 加载
        // ssh2 同理：CJS + 可选原生 cpu-features，打入 ESM bundle 会炸
        // zod 没有在 src 里直接 import，但必须保持 external 且留在 dependencies：
        // 它是 @modelcontextprotocol/sdk 的运行时依赖，SDK 在 external 状态下会
        // 在运行时 require('zod')，靠 node_modules 解析 —— 打进 bundle 反而会炸。
        external: ['@modelcontextprotocol/sdk', 'zod', 'ssh2']
      }
    }
  },
  preload: {
    resolve: {
      alias: { '@shared': shared }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        // 主进程已是 ESM（package.json "type": "module"），
        // 但 sandbox:true 的 preload 必须保持 CJS 才能被 Electron 加载：
        // 强制输出 .cjs 文件（Electron 据扩展名按 CJS 解析）。
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: renderer,
    resolve: {
      alias: { '@shared': shared, '@': renderer }
    },
    plugins: [react(), injectProdCsp],
    build: {
      rollupOptions: {
        input: { index: resolve(renderer, 'index.html') }
      }
    }
  }
})
