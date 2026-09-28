import fs from 'node:fs'

/**
 * 损坏索引文件留档（N22）。
 *
 * 为什么必须有：各 store 的 `load()` 在解析失败时曾经直接「置空 + 继续」，而**下一次
 * 任意写入就会把空索引落盘** —— 原索引被永久覆盖。可磁盘上的正文文件（快照 .txt /
 * 会话 .jsonl）还在，只是再没人引用它们，表现为「数据假消失且不可恢复」。
 *
 * 口径与 `settings/secrets.ts` 一致：改名成 `<file>.bad-<ts>` 留档（不删除），
 * 让损坏内容仍可人工抢救；随后由调用方决定是「从磁盘实体重建」还是「以空兜底」。
 *
 * 失败不抛错（返回 null）：留档只是尽力而为，绝不能因为留档失败而阻断启动。
 */
export function quarantineFile(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null
    const target = `${file}.bad-${Date.now()}`
    fs.renameSync(file, target)
    return target
  } catch {
    return null
  }
}