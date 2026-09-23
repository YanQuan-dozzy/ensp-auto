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
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(renderer, 'index.html') }
      }
    }
  }
})
