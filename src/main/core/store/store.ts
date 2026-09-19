import fs from 'node:fs'
import path from 'node:path'
import type { DeviceId, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

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
    mcp: { ...base.mcp, ...(patch.mcp ?? {}) }
  }
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
      this.data = {
        version: 1,
        settings: deepMergeSettings(DEFAULT_SETTINGS, parsed.settings ?? {}),
        aliases: parsed.aliases ?? {},
        recentPorts: parsed.recentPorts ?? []
      }
    } catch {
      // 读坏了就用默认值，不阻塞启动；下一次写入会覆盖
      this.data = structuredCloneSafe(EMPTY)
    }
  }

  /** 原子写：先写临时文件再 rename，避免断电/崩溃留下半个文件 */
  private persist(): void {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }

  getSettings(): Settings {
    return structuredCloneSafe(this.data.settings)
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.data.settings = deepMergeSettings(this.data.settings, patch)
    this.persist()
    return this.getSettings()
  }

  getAliases(): Record<DeviceId, string> {
    return { ...this.data.aliases }
  }

  getAlias(deviceId: DeviceId): string | undefined {
    return this.data.aliases[deviceId]
  }

  setAlias(deviceId: DeviceId, name: string): void {
    this.data.aliases[deviceId] = name
    this.persist()
  }

  getRecentPorts(): number[] {
    return [...this.data.recentPorts]
  }

  rememberPort(port: number): void {
    const list = this.data.recentPorts.filter((p) => p !== port)
    list.unshift(port)
    this.data.recentPorts = list.slice(0, 20)
    this.persist()
  }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
