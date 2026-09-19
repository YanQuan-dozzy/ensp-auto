import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(import.meta.dirname, 'src/shared')
const renderer = resolve(import.meta.dirname, 'src/renderer')

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
        external: ['@modelcontextprotocol/sdk', 'zod']
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
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(renderer, 'index.html') }
      }
    }
  }
})
