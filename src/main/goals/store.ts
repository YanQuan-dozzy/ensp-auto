import fs from 'node:fs'
import type { GoalArchivePayload } from '@shared/api'
import { MAX_GOALS, PRESET_GOALS, sanitizeGoals } from '@shared/goals'
import { atomicWriteJsonSync } from '../core/fs/atomic'
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
      // 读坏/格式不对就用预设，不阻塞启动
      this.data = structuredCloneSafe(EMPTY)
    }
  }

  /** 原子写（统一口径：唯一临时名 + rename + 失败清理） */
  private persist(): void {
    atomicWriteJsonSync(this.file, this.data)
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
