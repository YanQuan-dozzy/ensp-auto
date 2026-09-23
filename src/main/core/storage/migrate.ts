import fs from 'node:fs'
import path from 'node:path'

/**
 * 数据目录迁移（纯 Node，不依赖 Electron）。
 *
 * 从 bootstrap.ts 里单独拆出来，是为了能在测试里直接验证「不覆盖既有文件 +
 * 回传冲突清单」这条语义 —— bootstrap.ts 顶部 import 了 electron，
 * 一旦被测试 harness 引入就会把 Electron 拖进来。
 *
 * T4.4：改成异步 + 分片。用户数据目录可以是几百 MB，同步递归拷贝会把主进程
 * 冻住几十秒（窗口无响应、进度条不动），所以：
 * - 先异步枚举出待拷贝清单（拿到 total，进度才有分母）；
 * - 逐文件 `await` 拷贝，并且每 N 个让出一次事件循环（主进程还能响应 IPC）；
 * - 通过 onProgress 回报进度，由上层转成界面事件。
 */

/** 迁移时跳过的目录名：Chromium 的缓存/会话存储，迁过去只会白占空间 */
export const EXCLUDED_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GrShaderCache',
  'ShaderCache',
  'blob_storage',
  'Session Storage',
  'Network',
  'storage-bootstrap.json'
])

export interface MigrateResult {
  files: number
  bytes: number
  /**
   * 目标目录里已存在同名文件而**跳过**的项（相对路径）。
   *
   * 决策 D4=B：迁移绝不覆盖目标目录里已有的文件（D4=A 的「直接终止」会把
   * 已经拷了一半的状态留给用户，更难收拾）。跳过项必须回传给界面，
   * 否则「迁完了但少了几个文件」是无声的。
   */
  conflicts: string[]
  /** 因权限 / 文件被占用等原因复制失败的项（相对路径） */
  failed: string[]
}

export interface MigrateProgress {
  /** 已处理（含跳过/失败）的文件数 */
  done: number
  /** 待处理总数（枚举阶段得出） */
  total: number
  /** 已拷贝字节数 */
  bytes: number
  /** 当前处理的相对路径 */
  current: string
}

export interface MigrateOptions {
  onProgress?: (p: MigrateProgress) => void
  /** 每处理多少个文件让出一次事件循环，默认 25 */
  yieldEvery?: number
}

/** 让出一次事件循环，让主进程继续处理 IPC / 界面事件 */
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/** 异步枚举待拷贝文件（相对路径），跳过排除项与目标目录自身 */
async function collectFiles(srcDir: string, destDir: string): Promise<string[]> {
  const out: string[] = []

  const walk = async (current: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (EXCLUDED_NAMES.has(ent.name)) continue
      const full = path.join(current, ent.name)
      if (path.resolve(full) === destDir) continue
      if (ent.isDirectory()) {
        await walk(full)
      } else if (ent.isFile()) {
        out.push(path.relative(srcDir, full))
      }
    }
  }

  await walk(srcDir)
  return out
}

export async function migrateDirectory(
  srcDir: string,
  destDir: string,
  opts: MigrateOptions = {}
): Promise<MigrateResult> {
  const conflicts: string[] = []
  const failed: string[] = []
  let files = 0
  let bytes = 0

  const resolvedSrc = path.resolve(srcDir)
  const resolvedDest = path.resolve(destDir)
  if (resolvedSrc === resolvedDest) return { files: 0, bytes: 0, conflicts, failed }

  await fs.promises.mkdir(resolvedDest, { recursive: true })

  const rels = await collectFiles(resolvedSrc, resolvedDest)
  const total = rels.length
  const yieldEvery = Math.max(1, opts.yieldEvery ?? 25)

  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i]!
    const srcPath = path.join(resolvedSrc, rel)
    const destPath = path.join(resolvedDest, rel)
    try {
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true })
      // COPYFILE_EXCL：目标已存在同名文件时抛 EEXIST，绝不覆盖（决策 D4=B）
      await fs.promises.copyFile(srcPath, destPath, fs.constants.COPYFILE_EXCL)
      const st = await fs.promises.stat(destPath)
      bytes += st.size
      files += 1
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') conflicts.push(rel)
      else failed.push(rel)
    }

    opts.onProgress?.({ done: i + 1, total, bytes, current: rel })
    // 分片：每 yieldEvery 个文件让出一次，避免长时间独占事件循环
    if ((i + 1) % yieldEvery === 0) await yieldToLoop()
  }

  await yieldToLoop()
  return { files, bytes, conflicts, failed }
}
