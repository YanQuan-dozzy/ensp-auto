import { INVOKE } from '@shared/channels'
import { activeProfile, sanitizeProfiles } from '@shared/profiles'
import { ipcMain } from 'electron'
import { sanitizeCompaction, sanitizeRetry } from '@shared/runtime-policy'
import { sanitizeStorageSettings } from '../core/storage/usage'
import { setApiKey } from '../settings/secrets'
import type { AgentSettings, Settings } from '@shared/types'
import { MAX_SYSTEM_PROMPT, sanitizeMcpServers, settingsPayload, toInt, toStr } from './helpers'
import type { Services } from '../services'
import type {} from 'electron'

/**
 * 设置与密钥：settings 读写、密钥存删、一句话目标存档读取。
 *
 * 本模块只做「校验 → 调服务 → 回传」，业务逻辑在 services / core。
 */
export function registerSettingsIpc(services: Services): void {
  ipcMain.handle(INVOKE.settingsGet, async () => settingsPayload(services))

  ipcMain.handle(INVOKE.settingsSet, async (_e, patch: Partial<Settings>) => {
    // 只接受已知字段，避免渲染层塞入任意键污染持久化文件
    const safe: Partial<Settings> = {}
    if (patch?.theme === 'dark' || patch?.theme === 'light') safe.theme = patch.theme
    if (typeof patch?.deviceEncoding === 'string') safe.deviceEncoding = patch.deviceEncoding
    if (typeof patch?.terminalEchoAgentCommands === 'boolean') {
      safe.terminalEchoAgentCommands = patch.terminalEchoAgentCommands
    }
    if (Number.isFinite(patch?.scanStart)) safe.scanStart = toInt(patch?.scanStart, 2000)
    if (Number.isFinite(patch?.scanEnd)) safe.scanEnd = toInt(patch?.scanEnd, 2050)
    if (patch?.agent && typeof patch.agent === 'object') {
      // v1.5：agent 分区以「模型档案」为单位落盘。
      // 走 sanitizeProfiles 复用与读取侧同一套清洗口径（provider 白名单、id 去重、数值收敛），
      // 避免「写进来的档案」和「读出来的档案」两套规则。
      const cur = services.getSettings().agent
      const a = patch.agent as Partial<AgentSettings>
      const incoming = a.profiles === undefined ? cur.profiles : sanitizeProfiles(a.profiles)
      const nextProfiles = incoming.length > 0 ? incoming : cur.profiles
      const wanted = toStr(a.activeProfileId)
      safe.agent = {
        runtime: a.runtime === 'mock' ? 'mock' : a.runtime === 'react' ? 'react' : cur.runtime,
        profiles: nextProfiles,
        activeProfileId: nextProfiles.some((p) => p.id === wanted)
          ? wanted
          : nextProfiles[0]!.id,
        systemPrompt:
          typeof a.systemPrompt === 'string'
            ? a.systemPrompt.slice(0, MAX_SYSTEM_PROMPT)
            : cur.systemPrompt
      }
    }
    if (patch?.panels && typeof patch.panels === 'object') {
      const p = patch.panels
      safe.panels = {
        left: Math.max(180, Math.min(420, toInt(p.left, 240))),
        right: Math.max(320, Math.min(640, toInt(p.right, 380))),
        leftCollapsed: !!p.leftCollapsed,
        rightCollapsed: !!p.rightCollapsed
      }
    }
    if (patch?.mcp && typeof patch.mcp === 'object') {
      const cur = services.getSettings().mcp
      safe.mcp = {
        enabled: !!patch.mcp.enabled,
        port: Math.max(1024, Math.min(65535, toInt(patch.mcp.port, 49150))),
        // v1.5：外部服务器列表整表替换；undefined 表示本次不动它
        servers: sanitizeMcpServers((patch.mcp as { servers?: unknown }).servers, cur.servers),
        exposeToAgent:
          typeof patch.mcp.exposeToAgent === 'boolean' ? patch.mcp.exposeToAgent : cur.exposeToAgent
      }
    }
    if (patch?.ensp && typeof patch.ensp === 'object') {
      // 路径只做长度与字符集约束，存在性交给 locate 探测（用户可能填错后还要能改回来）
      const exePath = toStr(patch.ensp.exePath).trim()
      safe.ensp = { exePath: exePath.length > 512 ? exePath.slice(0, 512) : exePath }
    }
    if (patch?.storage && typeof patch.storage === 'object') {
      // R16：exports / attachments / snapshots 三个目录支持自定义且标称「即时生效」，
      // 但白名单里从来没有 storage 分支 —— 界面上改完、提示也说改了，实际根本没落盘，
      // 重启回到默认目录。用户只会以为是自己记错了。
      // 清洗逻辑放在 core/storage/usage.ts，与 isDriveRoot 同处一地且可被测试直接覆盖。
      safe.storage = sanitizeStorageSettings(patch.storage, services.getSettings().storage)
    }
    if (patch?.notify && typeof patch.notify === 'object') {
      // v1.6：通知偏好（布尔与枚举逐项收敛，不接受渲染层塞别的字符串）
      const cur = services.getSettings().notify
      const n = patch.notify as Partial<Settings['notify']>
      safe.notify = {
        onTaskEnd: typeof n.onTaskEnd === 'boolean' ? n.onTaskEnd : cur.onTaskEnd,
        onGate: typeof n.onGate === 'boolean' ? n.onGate : cur.onGate,
        sound: n.sound === 'none' || n.sound === 'default' ? n.sound : cur.sound
      }
    }
    if (patch?.permission && typeof patch.permission === 'object') {
      // v1.6：权限开关。刻意不做「缺省即开」的兜底 —— 安全项宁可沿用当前值也不擅自打开
      const cur = services.getSettings().permission
      const p = patch.permission as Partial<Settings['permission']>
      safe.permission = {
        confirmDanger: typeof p.confirmDanger === 'boolean' ? p.confirmDanger : cur.confirmDanger,
        externalToolConfirm:
          typeof p.externalToolConfirm === 'boolean'
            ? p.externalToolConfirm
            : cur.externalToolConfirm
      }
    }
    if (patch?.retry && typeof patch.retry === 'object') {
      // v1.7：重试策略。数值一律走 sanitizeRetry 收敛 —— 渲染层可以是个坏掉的数字输入框
      safe.retry = sanitizeRetry(patch.retry, services.getSettings().retry)
    }
    if (patch?.compaction && typeof patch.compaction === 'object') {
      safe.compaction = sanitizeCompaction(patch.compaction, services.getSettings().compaction)
    }
    if (patch?.wireshark && typeof patch.wireshark === 'object') {
      // v1.9：Wireshark 安装目录与持久化探测结果。
      const cur = services.getSettings().wireshark
      const dir = patch.wireshark.dir !== undefined ? toStr(patch.wireshark.dir).trim() : cur.dir
      const cachedProbe =
        patch.wireshark.cachedProbe !== undefined ? patch.wireshark.cachedProbe : cur.cachedProbe
      safe.wireshark = {
        dir: dir.length > 512 ? dir.slice(0, 512) : dir,
        cachedProbe: cachedProbe ?? null
      }
    }
    if (patch?.shortcuts !== undefined && typeof patch.shortcuts === 'object') {
      const sanitized: Record<string, string[]> = {}
      if (patch.shortcuts !== null) {
        for (const [k, v] of Object.entries(patch.shortcuts)) {
          if (typeof k === 'string' && Array.isArray(v) && v.every((x) => typeof x === 'string')) {
            sanitized[k] = (v as string[]).slice(0, 5)
          }
        }
      }
      safe.shortcuts = sanitized
    }
    services.updateSettings(safe)
    return settingsPayload(services)
  })

  ipcMain.handle(INVOKE.secretHas, async (_e, args?: { profileId?: string }) => {
    const pid = toStr(args?.profileId) || activeProfile(services.getSettings().agent).id
    return { has: services.hasApiKey(pid) }
  })

  ipcMain.handle(INVOKE.secretSet, async (_e, args: { profileId?: string; key?: string }) => {
    // 不传 profileId 时落在当前活跃档案（兼容旧调用点）；key 传空串 = 删除该档密钥
    const pid = toStr(args?.profileId) || activeProfile(services.getSettings().agent).id
    setApiKey(pid, toStr(args?.key))
    return settingsPayload(services)
  })

  // ————————————————— v1.10：一句话实验目标存档 —————————————————
  // 存档在 userData/goals.json，内容来自内置预设库（AI 每日续写已取消）；
  // 这里只读回传，随机抽三条的展示逻辑在渲染层做。

  ipcMain.handle(INVOKE.goalsGet, async () => services.getGoalsPayload())

  // ————————————————— v1.5：外部 MCP 服务器（本应用作为客户端） —————————————————
}

