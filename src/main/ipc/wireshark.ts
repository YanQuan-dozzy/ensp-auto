import { EVENT, INVOKE } from '@shared/channels'
import { WS_MCP_SERVER_ID, buildWiresharkMcpConfig, checkWiresharkMcp, checkWiresharkMcpAsync, invalidateWiresharkProbeCache, probeWireshark } from '../core/wireshark/provision'
import { app, ipcMain } from 'electron'
import { installWiresharkMcp } from '../core/wireshark/install'
import { showOpenDialogSafe } from './dialogs'
import { toWiresharkAvailability } from './wireshark-payload'
import { wiresharkDirFromSettings, wsVenvRoot } from './helpers'
import type { Services } from '../services'
import type { BrowserWindow } from 'electron'

/**
 * Wireshark：环境探测、组件安装、挂载 / 卸载、目录选择。
 *
 * 本模块只做「校验 → 调服务 → 回传」，业务逻辑在 services / core。
 */
export function registerWiresharkIpc(services: Services, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(INVOKE.wiresharkProbe, async (_e, args?: { force?: boolean }) => {
    const curSettings = services.getSettings()
    const cfgDir = wiresharkDirFromSettings(services)
    const attached = curSettings.mcp.servers.some((s) => s.id === WS_MCP_SERVER_ID)

    // 若非强制重新探测，且已有持久化结果，检查配置目录是否匹配；匹配则直接复用
    const cached = curSettings.wireshark.cachedProbe
    if (!args?.force && cached) {
      const dirMismatch = Boolean(cfgDir && cached.probe.suiteDir !== cfgDir)
      if (!dirMismatch) {
        return {
          ...cached,
          attached
        }
      }
    }

    // T4.4：强制刷新时先失效 TTL 缓存；探测本身走异步版，避免 reg query / tshark -v 阻塞主进程
    if (args?.force) invalidateWiresharkProbeCache()
    const avail = await checkWiresharkMcpAsync(app.getPath('userData'), cfgDir)
    const result = toWiresharkAvailability(avail, attached)

    // 持久化探测结果，避免后续频繁切换面板重复耗时探测
    services.updateSettings({
      wireshark: {
        ...curSettings.wireshark,
        cachedProbe: result
      }
    })

    return result
  })

  ipcMain.handle(INVOKE.wiresharkInstall, async () => {
    const win = getWindow()
    const res = await installWiresharkMcp({
      venvRoot: wsVenvRoot(),
      onProgress: (step) => {
        win?.webContents.send(EVENT.wiresharkInstallProgress, step)
      }
    })
    if (res.ok) {
      const curSettings = services.getSettings()
      const cfgDir = wiresharkDirFromSettings(services)
      // 刚装完组件，缓存的探测结果必然过期
      invalidateWiresharkProbeCache()
      const avail = await checkWiresharkMcpAsync(app.getPath('userData'), cfgDir)
      const attached = curSettings.mcp.servers.some((s) => s.id === WS_MCP_SERVER_ID)
      services.updateSettings({
        wireshark: {
          ...curSettings.wireshark,
          cachedProbe: toWiresharkAvailability(avail, attached)
        }
      })
    }
    return res.ok ? { ok: true } : { ok: false, error: res.error ?? '安装失败' }
  })

  ipcMain.handle(INVOKE.wiresharkAttach, async (_e, args: { profile?: string }) => {
    const cfgDir = wiresharkDirFromSettings(services)
    // T4.4：挂载按钮也会走探测，同样不能同步阻塞
    const avail = await checkWiresharkMcpAsync(app.getPath('userData'), cfgDir)
    if (!avail.installed) {
      return { ok: false, error: '尚未安装 Wireshark 分析组件，请先点「安装分析组件」', server: null }
    }
    if (!avail.probe.canAnalyze) {
      return {
        ok: false,
        error: '未找到 tshark，请先安装 Wireshark（安装时勾选 TShark / Npcap）',
        server: null
      }
    }

    const profile = args?.profile === 'full' ? 'full' : 'analysis'
    const cfg = buildWiresharkMcpConfig(avail, { profile, enabled: true })
    if (!cfg) return { ok: false, error: '组件路径不完整，无法挂载', server: null }

    // 幂等 upsert：已有同 id 条目就替换（改档位/路径都走这条），否则追加
    const cur = services.getSettings()
    const next = [...cur.mcp.servers]
    const i = next.findIndex((s) => s.id === WS_MCP_SERVER_ID)
    if (i >= 0) next[i] = cfg
    else next.push(cfg)

    // 挂载必然要暴露给代理，否则「挂上了但代理用不到」是最典型的半成品状态
    services.updateSettings({
      mcp: { ...cur.mcp, servers: next, exposeToAgent: true },
      wireshark: cur.wireshark.cachedProbe
        ? {
            ...cur.wireshark,
            cachedProbe: { ...cur.wireshark.cachedProbe, attached: true }
          }
        : cur.wireshark
    })
    const statuses = await services.syncMcpClients()
    const server = statuses.find((s) => s.id === WS_MCP_SERVER_ID) ?? null
    if (server && !server.connected) {
      return { ok: false, error: server.error ?? '组件启动失败', server }
    }
    return { ok: true, server }
  })

  ipcMain.handle(INVOKE.wiresharkDetach, async () => {
    // T3.4（决策 D7=A）：真的卸载。旧前端的「停用」其实是又挂了一次 —— 按钮永远是个假动作。
    // 这里把 m-wireshark 条目置为 disabled 并重新 sync，让客户端真的断开、工具真的消失；
    // 配置本身保留（路径/档位还在），下次「挂载」不需要重新装配。
    const cur = services.getSettings()
    const target = cur.mcp.servers.find((s) => s.id === WS_MCP_SERVER_ID)
    if (!target) {
      return { ok: false, error: '当前没有挂载 Wireshark 分析组件', server: null }
    }
    const next = cur.mcp.servers.map((s) =>
      s.id === WS_MCP_SERVER_ID ? { ...s, enabled: false } : s
    )
    services.updateSettings({
      mcp: { ...cur.mcp, servers: next },
      wireshark: cur.wireshark.cachedProbe
        ? {
            ...cur.wireshark,
            cachedProbe: { ...cur.wireshark.cachedProbe, attached: false }
          }
        : cur.wireshark
    })
    const statuses = await services.syncMcpClients()
    return { ok: true, server: statuses.find((s) => s.id === WS_MCP_SERVER_ID) ?? null }
  })

  ipcMain.handle(INVOKE.wiresharkPickDir, async () => {
    const win = getWindow()
    const result = await showOpenDialogSafe(win, {
          title: '选择 Wireshark 安装目录（含 tshark.exe）',
          properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]!
    // 只认真正含 tshark 的目录，避免用户随手选一个后被后续步骤以晦涩错误拒绝
    // 用户手选目录后缓存必然过期；这里只需快速判定，用同步版（有缓存兜底）
    invalidateWiresharkProbeCache()
    if (!probeWireshark({ overrideDir: dir }).canAnalyze) return null
    const cur = services.getSettings()
    const avail = checkWiresharkMcp(app.getPath('userData'), dir)
    const attached = cur.mcp.servers.some((s) => s.id === WS_MCP_SERVER_ID)
    const cachedProbe = toWiresharkAvailability(avail, attached)
    services.updateSettings({ ...cur, wireshark: { dir, cachedProbe } })
    return dir
  })

  // ————————————————— v1.4：eNSP 定位 —————————————————

  // 自动探测：设置指定 → 环境变量 → 注册表 .topo 关联 → 常见安装路径
}

