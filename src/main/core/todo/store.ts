import fs from 'node:fs'
import { sanitizeTodos, type TodoItem } from '@shared/interaction'
import { atomicWriteJsonSync } from '../fs/atomic'

/**
 * 任务清单存储（userData/todos.json），v2.7。
 *
 * 按**会话根 ID** 分桶，不是按运行时会话 ID（那个恒为 `'main'`）——
 * 否则用户切到另一个历史会话继续干活时，会看到上一段对话残留的清单，
 * 而模型也会把别人的任务当成自己的（这种错在界面上完全看不出来）。
 */
interface PersistedTodos {
  version: 1
  updatedAt: number
  /** ownerId（会话根 ID）→ 清单 */
  lists: Record<string, TodoItem[]>
}

/** 只保留最近这么多会话的清单：清单是过程数据，不该无限增长 */
const MAX_OWNERS = 50
const emptyData = (): PersistedTodos => ({ version: 1, updatedAt: 0, lists: {} })

export class TodoStore {
  private data: PersistedTodos = emptyData()

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PersistedTodos>
      const lists: Record<string, TodoItem[]> = {}
      for (const [owner, todos] of Object.entries(parsed.lists ?? {})) {
        if (typeof owner !== 'string' || !owner) continue
        const clean = sanitizeTodos(todos)
        if (clean.length > 0) lists[owner] = clean
      }
      this.data = {
        version: 1,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        lists
      }
    } catch {
      // 读坏就用空表，不阻塞启动（下一次写入覆盖）
      this.data = emptyData()
    }
  }

  private persist(): void {
    atomicWriteJsonSync(this.file, this.data)
  }

  get(ownerId: string): TodoItem[] {
    if (!ownerId) return []
    return (this.data.lists[ownerId] ?? []).map((t) => ({ ...t }))
  }

  /** 整表替换（`todo_write` 的语义）。空数组 = 清空该会话的清单 */
  set(ownerId: string, raw: unknown): TodoItem[] {
    if (!ownerId) return []
    const todos = sanitizeTodos(raw)
    if (todos.length === 0) delete this.data.lists[ownerId]
    else this.data.lists[ownerId] = todos
    this.evictOldOwners()
    this.data.updatedAt = Date.now()
    this.persist()
    return todos.map((t) => ({ ...t }))
  }

  /** 会话被删除/清理时连带清掉清单，避免索引里留孤儿 */
  remove(ownerId: string): void {
    if (!ownerId || !this.data.lists[ownerId]) return
    delete this.data.lists[ownerId]
    this.data.updatedAt = Date.now()
    this.persist()
  }

  /**
   * 超量淘汰。JSON 对象的键序在反序列化后是插入序，所以「保留前 MAX_OWNERS 个键」
   * 等价于「丢掉最早创建的那批清单」—— 唯一的问题是它不看活跃度。
   * 清单是过程数据，丢掉的代价是用户重开会话时看到空清单，可以接受；
   * 为此引入时间戳逐键排序不值得（每写一次都要全表排序）。
   */
  private evictOldOwners(): void {
    const keys = Object.keys(this.data.lists)
    if (keys.length <= MAX_OWNERS) return
    for (const key of keys.slice(0, keys.length - MAX_OWNERS)) delete this.data.lists[key]
  }
}
