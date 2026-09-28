/**
 * 工具调用的「人话」归类与汇总（v2.11）—— 纯函数，供界面与单测共用。
 *
 * 为什么需要它：一屏工具卡平铺出来（`read_attachment` / `get_topology` / `run_show_command`…）
 * 对用户来说是一堆英文名字，看不出「这一轮到底干了什么」。参考图里那行
 * 「已读取 15 个文件，搜索 14 次文件，执行 11 条命令 ›」才是用户想要的粒度 ——
 * 一句话说清**动作类型 × 次数**，需要细节再点开。
 *
 * 归类是**按工具名的语义**手工映射的（不靠前缀猜）：
 * 前缀猜会把 `get_topology`（读）和 `save_topo_file`（写）都归到 `_topo`，
 * 而这两者的语义完全相反。所以这里用显式表单，新增工具时必须同步登记
 * （`TOOL_CATEGORY` 里没有的会落到 `other`，不会丢，只是文案偏中性）。
 */

/** 只取名字字段即可 —— 刻意不 import 渲染层的 `ToolMsg`：
 *  本模块要能被主进程 tsconfig 编译（node 工程的 include 不含 renderer），
 *  结构化的入参形状（`{ name: string }`）足以表达依赖，也不必把两层绑死。 */
export interface NamedTool {
  name: string
}

/** 动作类别 —— 每类有自己的中文量词与动词 */
export type ToolCategory = 'read' | 'search' | 'exec' | 'edit' | 'create' | 'connect' | 'verify' | 'other'

interface CategorySpec {
  /** 汇总行里的动作短语，如「已读取」 */
  verb: string
  /** 量词单位，如「个文件」；空串表示用「次」 */
  unit: string
}

const CATEGORY_SPEC: Record<ToolCategory, CategorySpec> = {
  read: { verb: '已读取', unit: '个文件' },
  search: { verb: '搜索', unit: '次文件' },
  exec: { verb: '执行', unit: '条命令' },
  edit: { verb: '已修改', unit: '个文件' },
  create: { verb: '已创建', unit: '个文件' },
  connect: { verb: '已连接', unit: '台设备' },
  verify: { verb: '已验证', unit: '项' },
  other: { verb: '调用了', unit: '次工具' }
}

/**
 * 工具名 → 类别。
 *
 * 登记原则：按**语义**而不是名字长相。特别注意几个反例：
 * - `get_topology` / `list_*` / `read_attachment` / `diff_with_snapshot` 是「读」
 * - `save_topo_file` / `import_topology_file` / `save_config_snapshot` 是「写」→ edit/create
 * - `run_show_command` 是「执行命令」（设备回显），`apply_config` 是「改配置」→ edit
 */
const TOOL_CATEGORY: Record<string, ToolCategory> = {
  // —— 读取 ——
  read_attachment: 'read',
  // v2.22（F17）：读图片本身也是「读」（不改状态、不下发命令）
  read_image: 'read',
  list_devices: 'read',
  list_sessions: 'read',
  list_snapshots: 'read',
  list_lab_templates: 'read',
  get_device_context: 'read',
  get_topology: 'read',
  analyze_reference_configs: 'read',
  // v2.12（F1/F4）：查本地命令词典 / 读拓扑做规划 —— 都不下发配置、不改状态
  lookup_vrp_command: 'read',
  plan_experiment: 'read',

  // —— 搜索 ——
  scan_devices: 'search',
  auto_discover_devices: 'search',
  find_topology_files: 'search',
  ssh_list: 'search',

  // —— 执行命令（只读回显）——
  run_show_command: 'exec',
  collect_device_diagnostics: 'exec',
  // v2.24：视图切换也是「往设备上发命令」（quit / return / system-view / interface），
  // 只是它不改配置 —— 归到 exec 比归到 read 更贴近用户看到的动作
  change_view: 'exec',

  // —— 修改 / 落盘 ——
  apply_config: 'edit',
  batch_configure: 'edit',
  execute_task: 'edit',
  restore_snapshot: 'edit',
  // v2.12（F5）：任务级整体回滚，语义上仍是「改配置」
  rollback_task: 'edit',
  save_config_snapshot: 'edit',
  save_topo_file: 'edit',
  save_configuration: 'edit',
  rename_device: 'edit',
  refresh_topology: 'edit',
  answer_device_prompt: 'edit',
  todo_write: 'edit',

  // —— 创建 / 导入 ——
  export_session_report: 'create',
  export_lab_guide: 'create',
  // v2.20：配置命令报告导出（写一份 markdown 到导出目录）
  export_change_report: 'create',
  import_topology_file: 'create',
  run_lab_template: 'create',

  // —— 连接 ——
  connect_device: 'connect',
  disconnect_device: 'connect',
  ssh_connect: 'connect',
  register_device: 'connect',
  unregister_device: 'connect',

  // —— 交互（ask_user_question：向用户提问，不属于读/写/执行任何一类）——
  ask_user_question: 'other',

  // —— 验证 ——
  verify_ping: 'verify',
  verify_route: 'verify',
  verify_arp: 'verify',
  verify_dhcp: 'verify',
  verify_nat: 'verify',
  verify_eth_trunk: 'verify',
  verify_expectation: 'verify',
  verify_connectivity: 'verify',
  diff_with_snapshot: 'verify',
  // v2.12（F7）：一次跑完整张验收清单，归类到「验证」
  check_experiment: 'verify'
}

/** 某个工具属于哪一类（未登记 → other，不丢信息） */
export function categoryOf(name: string): ToolCategory {
  return TOOL_CATEGORY[name] ?? 'other'
}

/**
 * 该工具名是否**显式登记**过类别。
 *
 * 与 `categoryOf` 的区别很关键：`other` 既是「登记过的其它类」，
 * 也是「没登记」的兜底值 —— 单看 `categoryOf(x) === 'other'` 分不出这两种情况。
 * 覆盖面测试要的正是「有没有漏登记」，所以必须用这个谓词。
 */
export function isRegisteredTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_CATEGORY, name)
}

export interface CategorySummary {
  category: ToolCategory
  count: number
  /** 该类涉及的（去重后的）工具名，便于 hover 展示与点开明细 */
  names: string[]
}

/**
 * 把一组工具调用归成「动作类型 × 次数」。
 *
 * 顺序固定（不按出现先后）：读 → 搜 → 执行 → 改 → 建 → 连 → 验 —— 这也是
 * 用户理解一轮任务的自然顺序（先看有什么 → 再动手 → 最后验证）。
 */
const ORDER: ToolCategory[] = ['read', 'search', 'exec', 'edit', 'create', 'connect', 'verify', 'other']

export function summarizeTools(items: NamedTool[]): CategorySummary[] {
  const byCat = new Map<ToolCategory, CategorySummary>()
  for (const it of items) {
    const c = categoryOf(it.name)
    const cur = byCat.get(c)
    if (cur) {
      cur.count += 1
      if (!cur.names.includes(it.name)) cur.names.push(it.name)
    } else {
      byCat.set(c, { category: c, count: 1, names: [it.name] })
    }
  }
  return ORDER.filter((c) => byCat.has(c)).map((c) => byCat.get(c)!)
}

/** 单条类别短语，如「已读取 15 个文件」 */
export function describeCategory(s: CategorySummary): string {
  const spec = CATEGORY_SPEC[s.category]
  return `${spec.verb} ${s.count} ${spec.unit}`
}

/**
 * 汇总行文案：`已读取 15 个文件，搜索 14 次文件，执行 11 条命令`。
 * 空输入返回空串（调用方据此不渲染汇总行）。
 */
export function describeToolSummary(items: NamedTool[]): string {
  return summarizeTools(items).map(describeCategory).join('，')
}
