import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 把通信层的纯逻辑打成一个可被 node:test 直接导入的包。
 * 这样测试不依赖 Electron、不依赖 eNSP，可进 CI。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const outFile = path.join(root, 'tests/.build/harness.mjs')

fs.mkdirSync(path.dirname(outFile), { recursive: true })

await build({
  entryPoints: [path.join(here, 'entry.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  logLevel: 'warning',
  // MCP SDK 保持外部（node_modules 运行时解析），避免把 express/hono 打进测试包
  // ssh2 同理：CJS + 可选原生 cpu-features，测试进程直接 require node_modules 里的包
  // 与 electron.vite.config.ts 的 external 口径保持一致：
    // 这三者都有 CJS 动态 require，打进 bundle 会在 ESM 里炸
    external: ['@modelcontextprotocol/sdk', 'zod', 'ssh2'],
  alias: {
    '@shared': path.join(root, 'src/shared')
  }
})

console.log(`harness built -> ${path.relative(root, outFile)}`)
