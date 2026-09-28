import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

/**
 * 测试临时目录工厂（N80）。
 *
 * 为什么需要：散落的 `mkdtempSync` 从不 `rmSync`，跑一次 `npm test` 就在系统临时目录里
 * 留一堆 `ensp-*` / `ws-*` 目录，越积越多（对照 `write-pipeline.test.mjs` 每次 `finally rmSync`
 * 的正确写法）。这里用 `node:test` 的**文件级** `after()` 钩子统一收口：
 * 只要经过本工厂创建，文件跑完就删。
 *
 * 用法：
 *   const makeTmp = tmpDirFactory('ensp-goals-')
 *   const dir = makeTmp()
 */
export function tmpDirFactory(prefix) {
  const dirs = []
  after(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响测试结论 */
      }
    }
  })
  return () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }
}