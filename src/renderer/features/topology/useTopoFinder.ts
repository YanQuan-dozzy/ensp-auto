/**
 * 拓扑导入/发现 hook（T5.8 从 TopologyCanvas.tsx 外提）：
 * eNSP 工程文件导入（F-5.2，来源一，最权威）与本地拓扑发现
 * （参照 ensp-mcp find_topology_files，扫描桌面/文档/下载）。
 * 纯状态 + 主进程动作调用，无画布依赖。
 */
import { useCallback, useState } from 'react'
import type { TopoFindPayload, TopoImportPayload } from '@shared/api'

export interface UseTopoFinderArgs {
  importTopology: () => Promise<TopoImportPayload | null>
  discoverTopoFiles: (directory?: string) => Promise<TopoFindPayload | null>
  importTopoPath: (filePath: string) => Promise<TopoImportPayload | null>
}

export interface TopoFinderApi {
  importNotice: string
  setImportNotice: (msg: string) => void
  finderOpen: boolean
  setFinderOpen: (open: boolean) => void
  finder: TopoFindPayload | null
  finderLoading: boolean
  onImportFile: () => Promise<void>
  openFinder: () => Promise<void>
  refreshFinder: () => Promise<void>
  importFromFinder: (filePath: string) => Promise<void>
}

export function useTopoFinder(args: UseTopoFinderArgs): TopoFinderApi {
  const { importTopology, discoverTopoFiles, importTopoPath } = args
  const [importNotice, setImportNotice] = useState('')
  const [finderOpen, setFinderOpen] = useState(false)
  const [finder, setFinder] = useState<TopoFindPayload | null>(null)
  const [finderLoading, setFinderLoading] = useState(false)

  const onImportFile = useCallback(async () => {
    setImportNotice('')
    const r = await importTopology()
    if (!r) {
      setImportNotice('已取消或导入失败')
      return
    }
    const w = r.report.warnings.length ? `（${r.report.warnings.length} 条警告）` : ''
    setImportNotice(`已导入 ${r.report.devices} 设备 / ${r.report.links} 链路${w}；文件层在其他来源之上优先。`)
  }, [importTopology])

  const openFinder = useCallback(async () => {
    setFinderOpen(true)
    setFinderLoading(true)
    const r = await discoverTopoFiles()
    setFinder(r)
    setFinderLoading(false)
  }, [discoverTopoFiles])

  const refreshFinder = useCallback(async () => {
    setFinderLoading(true)
    const r = await discoverTopoFiles()
    setFinder(r)
    setFinderLoading(false)
  }, [discoverTopoFiles])

  const importFromFinder = useCallback(
    async (filePath: string) => {
      setImportNotice('')
      const r = await importTopoPath(filePath)
      setFinderOpen(false)
      if (!r) {
        setImportNotice(`导入失败或文件无法解析：${filePath}`)
        return
      }
      const w = r.report.warnings.length ? `（${r.report.warnings.length} 条警告）` : ''
      setImportNotice(`已导入 ${filePath}（${r.report.devices} 设备 / ${r.report.links} 链路${w}）。`)
    },
    [importTopoPath]
  )

  return {
    importNotice,
    setImportNotice,
    finderOpen,
    setFinderOpen,
    finder,
    finderLoading,
    onImportFile,
    openFinder,
    refreshFinder,
    importFromFinder
  }
}