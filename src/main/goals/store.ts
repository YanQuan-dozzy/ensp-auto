import fs from 'node:fs'
import type { GoalArchivePayload } from '@shared/api'
import { MAX_GOALS, PRESET_GOALS, sanitizeGoals } from '@shared/goals'
import { atomicWriteJsonSync } from '../core/fs/atomic'
import { quarantineFile } from '../core/fs/quarantine'
import { structuredCloneSafe } from '@shared/clone'

/**
 * 一句话实验目标存档（userData/goals.json）。
 *
 * 内置预设实验目标，渲染层在输入框空态时随机抽选展示。
 * 取消 AI 自动续写，使用更丰富的内置场景目标库。
 */

interface PersistedGoalArchive {
  version: 1
  updatedAt: number
  goals: string[]
}

const EMPTY: PersistedGoalArchive = {
  version: 1,
  updatedAt: 0,
  goals: [...PRESET_GOALS]
}

export class GoalArchiveStore {
  private data: PersistedGoalArchive = structuredCloneSafe(EMPTY)

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) {
        this.data = structuredCloneSafe(EMPTY)
        return
      }
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PersistedGoalArchive>
      const goals = sanitizeGoals(parsed.goals)
      this.data = {
        version: 1,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        goals: goals.length > 0 ? goals : [...PRESET_GOALS]
      }
    } catch {
      // N22：留档 + 告警（存档无独立实体文件，无法从磁盘重建），再以预设兜底
      const archived = quarantineFile(this.file)
      this.data = structuredCloneSafe(EMPTY)
      console.warn(
        `[goals] 目标存档无法解析（文件损坏）${archived ? `，原文件已留档为 ${archived}` : ''}，已回退预设：${this.file}`
      )
    }
  }

  /** 原子写（统一口径：唯一临时名 + rename + 失败清理） */
  private persist(): void {
    // D4：关掉 fsync —— 这份存档是**派生数据**（用户在界面随手存的一句话目标），
    // 没有别处依赖它；而写盘频率跟着会话数增长，是长期跑着的那条路径。
    atomicWriteJsonSync(this.file, this.data, { fsync: false })
  }

  list(): GoalArchivePayload {
    return { goals: [...this.data.goals], updatedAt: this.data.updatedAt }
  }

  /** 整表替换。空内容不写，避免把存档洗空 */
  replace(goals: string[]): void {
    const cleaned = sanitizeGoals(goals).slice(0, MAX_GOALS)
    if (cleaned.length === 0) return
    const before = this.data
    this.data = { version: 1, updatedAt: Date.now(), goals: cleaned }
    // R21：写盘失败就回滚内存，别让「界面已换一批、磁盘还是旧的」这种不一致挂到重启
    try {
      this.persist()
    } catch (e) {
      this.data = before
      throw e
    }
  }
}
