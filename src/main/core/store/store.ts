import fs from 'node:fs'
import type { DeviceId, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { normalizeAgentSettings, type RawAgentSettings } from '@shared/profiles'
import { atomicWriteJsonSync } from '../fs/atomic'
import { structuredCloneSafe } from '@shared/clone'

/**
 * 轻量持久化。
 *
 * v0.1 的持久化需求只有三类：设置、设备别名、最近用过的端口。
 * 这三类都是小体量 KV，用一个 JSON 文件就够，且**不需要原生模块**。
 *
 * 刻意推迟 SQLite（better-sqlite3）：它是原生模块，需要 electron-rebuild + 本机
 * 编译工具链，在 Windows 上是明确的安装风险点。而真正需要 SQLite 的是配置快照
 * 与变更记录（v0.2），那时再引入，收益才配得上成本。
 * 接口按 KV 抽象，v0.2 换 SQLite 时上层不用改。
 */

interface Persisted {
  version: 1
  settings: Settings
  aliases: Record<DeviceId, string>
  recentPorts: number[]
}

const EMPTY: Persisted = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  aliases: {},
  recentPorts: []
}

function deepMergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    agent: { ...base.agent, ...(patch.agent ?? {}) },
    panels: { ...base.panels, ...(patch.panels ?? {}) },
    mcp: { ...base.mcp, ...(patch.mcp ?? {}) },
    ensp: { ...base.ensp, ...(patch.ensp ?? {}) },
    // v1.6：通知 / 权限同样是「子对象」，必须逐个合并 ——
    // 漏一行就会出现「补丁只关了一个开关，整块被默认值顶回去」的幽灵回归
    notify: { ...base.notify, ...(patch.notify ?? {}) },
    permission: { ...base.permission, ...(patch.permission ?? {}) },
    // v1.7：重试 / 压缩同样是子对象
    retry: { ...base.retry, ...(patch.retry ?? {}) },
    compaction: { ...base.compaction, ...(patch.compaction ?? {}) },
    // v1.9：Wireshark 安装目录
    wireshark: { ...base.wireshark, ...(patch.wireshark ?? {}) },
    // 存储目录自定义设置
    storage: { ...base.storage, ...(patch.storage ?? {}) },
    shortcuts:
      patch.shortcuts !== undefined
        ? { ...(patch.shortcuts ?? {}) }
        : { ...(base.shortcuts ?? {}) }
  }
}

/**
 * v1.5：agent 分区要走一次规整。
 *
 * 顺序很关键 —— 必须在**与默认值合并之前**规整：老配置里是
 * `{ provider, baseUrl, model }` 而没有 profiles，若先跟默认值合并，
 * 默认值会先把 profiles 填满，扁平字段就被覆盖掉了，用户的模型配置凭空消失。
 */
function withNormalizedAgent(s: Settings): Settings {
  return { ...s, agent: normalizeAgentSettings(s.agent as RawAgentSettings) }
}

export class JsonStore {
  private data: Persisted = structuredCloneSafe(EMPTY)

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Persisted>
      const rawSettings = (parsed.settings ?? {}) as Partial<Settings>
      this.data = {
        version: 1,
        settings: withNormalizedAgent(
          deepMergeSettings(DEFAULT_SETTINGS, {
            ...rawSettings,
            // 先把持久化里的 agent 规整（含 v1.4 扁平字段迁移），再与默认值合并
            ...(rawSettings.agent
              ? { agent: normalizeAgentSettings(rawSettings.agent as RawAgentSettings) }
              : {})
          })
        ),
        aliases: parsed.aliases ?? {},
        recentPorts: parsed.recentPorts ?? []
      }
    } catch {
      // 读坏了就用默认值，不阻塞启动；下一次写入会覆盖
      this.data = structuredCloneSafe(EMPTY)
    }
  }

  /**
   * 原子写：先写临时文件再 rename，避免断电/崩溃留下半个文件。
   * v1.5：临时名带 pid + uuid —— 多个实例（或并发写入）撞到同一个 `.tmp` 时，
   * rename 会把对方的半成品顶上，是典型的「偶发丢配置」根因。
   */
  private persist(): void {
    // v1.8 / T2.5：统一走 core/fs/atomic（唯一临时名 + 原子 rename + 失败清理 +
    // Windows EPERM/EBUSY 退避重试），全仓 13 处写盘从此只有一套口径。
    atomicWriteJsonSync(this.file, this.data)
  }

  /**
   * 先改内存、写盘成功后认账；写盘失败回滚内存快照。
   *
   * R21：旧实现是「改内存 → persist() 抛错 → 内存留着新值」，
   * 结果是设置页显示已生效、磁盘上其实没变，重启后「自己变回去了」。
   */
  private commit<T>(mutate: () => T): T {
    const before = structuredCloneSafe(this.data)
    const result = mutate()
    try {
      this.persist()
    } catch (e) {
      this.data = before
      throw e
    }
    return result
  }

  getSettings(): Settings {
    return structuredCloneSafe(this.data.settings)
  }

  updateSettings(patch: Partial<Settings>): Settings {
    return this.commit(() => {
      this.data.settings = withNormalizedAgent(deepMergeSettings(this.data.settings, patch))
      return this.getSettings()
    })
  }

  getAliases(): Record<DeviceId, string> {
    return { ...this.data.aliases }
  }

  getAlias(deviceId: DeviceId): string | undefined {
    return this.data.aliases[deviceId]
  }

  setAlias(deviceId: DeviceId, name: string): void {
    this.commit(() => {
      this.data.aliases[deviceId] = name
    })
  }

  removeAlias(deviceId: DeviceId): void {
    if (!(deviceId in this.data.aliases)) return
    this.commit(() => {
      delete this.data.aliases[deviceId]
    })
  }

  getRecentPorts(): number[] {
    return [...this.data.recentPorts]
  }

  rememberPort(port: number): void {
    this.commit(() => {
      const list = this.data.recentPorts.filter((p) => p !== port)
      list.unshift(port)
      this.data.recentPorts = list.slice(0, 20)
    })
  }
}
