/**
 * v2.11：工具调用归类汇总（「已读取 15 个文件，搜索 14 次文件，执行 11 条命令」）。
 *
 * 守的是一条「静默出丑」的线：工具数是**新增**的（v2.11 起 44 个 + 后续），
 * 新工具若没登记类别会落到 `other`，界面上显示成「调用了 N 次工具」——
 * 不报错、不崩溃，只是那句话变得没有信息量。这里用「全量工具名必须已登记」
 * 这条断言把漏登记变成测试失败（新增工具时会立刻看到）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  categoryOf,
  isRegisteredTool,
  summarizeTools,
  describeCategory,
  describeToolSummary,
  TOOLS
} from '../.build/harness.mjs'

const t = (name) => ({ name })

test('归类：读 / 搜 / 执行 / 修改 / 连接 / 验证 各自命中', () => {
  assert.equal(categoryOf('read_attachment'), 'read')
  assert.equal(categoryOf('scan_devices'), 'search')
  assert.equal(categoryOf('run_show_command'), 'exec')
  assert.equal(categoryOf('apply_config'), 'edit')
  assert.equal(categoryOf('connect_device'), 'connect')
  assert.equal(categoryOf('verify_ping'), 'verify')
})

test('归类：未登记的工具落到 other（不丢，只是文案中性）', () => {
  assert.equal(categoryOf('some_brand_new_tool'), 'other')
  // 但「登记过的 other」与「没登记」必须能区分（见覆盖面守卫）
  assert.equal(isRegisteredTool('ask_user_question'), true)
  assert.equal(isRegisteredTool('some_brand_new_tool'), false)
})

test('语义反例：get_topology 是读、save_topo_file 是写（不能按 _topo 前缀猜）', () => {
  assert.equal(categoryOf('get_topology'), 'read')
  assert.notEqual(categoryOf('save_topo_file'), 'read')
})

test('汇总：按类别计数', () => {
  const items = [
    t('read_attachment'),
    t('read_attachment'),
    t('list_devices'),
    t('scan_devices'),
    t('run_show_command'),
    t('run_show_command'),
    t('run_show_command')
  ]
  const s = summarizeTools(items)
  const read = s.find((x) => x.category === 'read')
  const search = s.find((x) => x.category === 'search')
  const exec = s.find((x) => x.category === 'exec')
  assert.equal(read.count, 3)
  assert.equal(search.count, 1)
  assert.equal(exec.count, 3)
})

test('汇总：类别顺序固定（读→搜→执行→…），与出现先后无关', () => {
  const s = summarizeTools([t('run_show_command'), t('read_attachment'), t('scan_devices')])
  assert.deepEqual(s.map((x) => x.category), ['read', 'search', 'exec'])
})

test('汇总：同类去重后的工具名（用于 title 展示）', () => {
  const s = summarizeTools([t('read_attachment'), t('read_attachment'), t('list_devices')])
  const read = s.find((x) => x.category === 'read')
  assert.deepEqual(read.names.sort(), ['list_devices', 'read_attachment'])
})

test('汇总：空输入 → 空数组 / 空串（调用方据此不渲染）', () => {
  assert.deepEqual(summarizeTools([]), [])
  assert.equal(describeToolSummary([]), '')
})

test('文案：单个类别', () => {
  const s = summarizeTools([t('read_attachment'), t('read_attachment')])
  assert.equal(describeCategory(s[0]), '已读取 2 个文件')
})

test('文案：多类别用中文顿号连接（对齐参考图句式）', () => {
  const items = []
  for (let i = 0; i < 15; i++) items.push(t('read_attachment'))
  for (let i = 0; i < 14; i++) items.push(t('scan_devices'))
  for (let i = 0; i < 11; i++) items.push(t('run_show_command'))
  const line = describeToolSummary(items)
  assert.equal(line, '已读取 15 个文件，搜索 14 次文件，执行 11 条命令')
})

test('文案：other 类别有兜底量词（不出现空单位）', () => {
  const s = summarizeTools([t('mystery_tool')])
  assert.equal(describeCategory(s[0]), '调用了 1 次工具')
})

// —— 覆盖面守卫：全量工具名必须已登记 ——
//
// 这里是「新工具漏登记」的唯一防线。清单与 `src/main/tools/*.ts` 的 `name:` 一一对应，
// 新增工具时同步加进这个数组与 `TOOL_CATEGORY`，否则测试会失败提醒。
//
// 2026-09-27 修正：原先这份清单只有 46 条、且只做「清单 → 注册表」单向校验，
// 于是 `check_experiment` / `rollback_task` 漏在清单外却静默通过（实际 TOOLS 有 48 个）。
// 现在补上双向对账（见下方 `与 TOOLS 注册表双向对账`），清单再漏就会直接失败。
const ALL_TOOL_NAMES = [
  'analyze_reference_configs', 'answer_device_prompt', 'apply_config', 'ask_user_question',
  'auto_discover_devices', 'batch_configure', 'change_view', 'check_experiment', 'collect_device_diagnostics',
  'connect_device', 'diff_with_snapshot', 'disconnect_device', 'execute_task',
  'export_change_report', 'export_lab_guide', 'export_session_report', 'find_topology_files',
  'get_device_context', 'get_topology', 'import_topology_file', 'list_devices',
  'list_lab_templates', 'list_sessions', 'list_snapshots', 'lookup_vrp_command',
  'plan_experiment', 'read_attachment', 'read_image', 'refresh_topology', 'register_device',
  'rename_device', 'restore_snapshot', 'rollback_task', 'run_lab_template',
  'run_show_command', 'save_config_snapshot', 'save_configuration', 'save_topo_file',
  'scan_devices', 'ssh_connect', 'ssh_list', 'todo_write',
  'unregister_device', 'verify_arp', 'verify_connectivity', 'verify_dhcp',
  'verify_eth_trunk', 'verify_expectation', 'verify_nat', 'verify_ping',
  'verify_route'
]

test('覆盖面：全部 51 个工具都已登记类别（无漏网）', () => {
  const unregistered = ALL_TOOL_NAMES.filter((n) => !isRegisteredTool(n))
  assert.deepEqual(unregistered, [], `以下工具未登记类别：${unregistered.join(', ')}`)
})

test('覆盖面：清单本身无重复且数量为 51', () => {
  assert.equal(ALL_TOOL_NAMES.length, 51)
  assert.equal(new Set(ALL_TOOL_NAMES).size, 51)
})

test('覆盖面：清单与 TOOLS 注册表双向对账（防清单自身漏登记）', () => {
  const registered = TOOLS.map((t) => t.name).sort()
  const listed = [...ALL_TOOL_NAMES].sort()
  assert.deepEqual(
    listed,
    registered,
    `清单与 TOOLS 不一致：缺少 [${registered.filter((n) => !listed.includes(n)).join(', ')}]，` +
      `多余 [${listed.filter((n) => !registered.includes(n)).join(', ')}]`
  )
})
