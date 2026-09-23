import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GoalArchiveStore,
  sanitizeGoals,
  pickRandomGoals,
  PRESET_GOALS,
  QUICK_PROMPT_COUNT,
  MAX_GOALS
} from '../.build/harness.mjs'

// ———————————————————— sanitizeGoals：清洗与收敛 ————————————————————

test('sanitizeGoals：剥编号/破折号前缀、去空白、非字符串与空行丢弃', () => {
  const out = sanitizeGoals([
    '  备份所有设备配置  ',
    '1. 备份所有设备配置', // 剥掉 "1. " 后与首条重复 → 只保留首条
    '- 查 OSPF 邻居',
    '1) 查 OSPF 邻居',
    '',
    null,
    42,
    '检查路由表'
  ])
  assert.deepEqual(out, ['备份所有设备配置', '查 OSPF 邻居', '检查路由表'])
})

test('sanitizeGoals：内容不同（含大小写差异）都保留', () => {
  const out = sanitizeGoals(['扫描设备', 'SCAN DEVICE', '扫描设备', '扫描 设备'])
  assert.deepEqual(out, ['扫描设备', 'SCAN DEVICE', '扫描 设备'])
})

test('sanitizeGoals：超长条目被丢弃；总数收敛到上限', () => {
  const long = 'x'.repeat(121)
  const out = sanitizeGoals([long, '短目标'])
  assert.deepEqual(out, ['短目标'])

  const many = Array.from({ length: 50 }, (_, i) => `目标-${i}`)
  assert.ok(sanitizeGoals(many).length <= MAX_GOALS)
})

test('sanitizeGoals：非数组输入返回空数组', () => {
  assert.deepEqual(sanitizeGoals(undefined), [])
  assert.deepEqual(sanitizeGoals('字符串'), [])
  assert.deepEqual(sanitizeGoals({ goals: ['x'] }), [])
})

// ———————————————————— pickRandomGoals：随机抽样 ————————————————————

test('pickRandomGoals：抽 n 条不重复，且是原池子元素', () => {
  const pool = ['a', 'b', 'c', 'd', 'e']
  for (let round = 0; round < 30; round++) {
    const picked = pickRandomGoals(pool, 3)
    assert.equal(picked.length, 3)
    assert.equal(new Set(picked).size, 3)
    for (const g of picked) assert.ok(pool.includes(g))
  }
})

test('pickRandomGoals：池子不足 n 时返回全部（顺序打乱）', () => {
  const picked = pickRandomGoals(['a', 'b'], 3)
  assert.equal(picked.length, 2)
  assert.equal(new Set(picked).size, 2)
})

test('pickRandomGoals：空池 / n=0 返回空数组', () => {
  assert.deepEqual(pickRandomGoals([], 3), [])
  assert.deepEqual(pickRandomGoals(['a'], 0), [])
  assert.deepEqual(pickRandomGoals(['', '  '], 3), [])
})

test('预设存档含示例目标，且抽样条数与 QUICK_PROMPT_COUNT 一致', () => {
  assert.ok(PRESET_GOALS.includes('扫描本机网络设备，连上第一台，告诉我它的型号和端口状态'))
  assert.equal(pickRandomGoals(PRESET_GOALS, QUICK_PROMPT_COUNT).length, QUICK_PROMPT_COUNT)
})

// ———————————————————— GoalArchiveStore：持久化 ————————————————————

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-goals-'))
}

test('GoalArchiveStore：首次创建（无文件）返回预设，不落盘', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'goals.json')
  const store = new GoalArchiveStore(file)
  const p = store.list()
  assert.deepEqual(p.goals, PRESET_GOALS)
  assert.equal(p.updatedAt, 0)
  assert.equal(fs.existsSync(file), false)
})

test('GoalArchiveStore：replace 落盘并可重新读回，updatedAt 记录为最近一次替换', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'goals.json')
  const store = new GoalArchiveStore(file)
  store.replace(['新目标一', ' 重复 ', '新目标一'])
  const reloaded = new GoalArchiveStore(file)
  const p = reloaded.list()
  assert.deepEqual(p.goals, ['新目标一', '重复'])
  assert.ok(p.updatedAt > 0)
  assert.ok(p.updatedAt <= Date.now())
})

test('GoalArchiveStore：replace 空内容不写（防把存档洗空）', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'goals.json')
  const store = new GoalArchiveStore(file)
  store.replace([])
  store.replace(['   '])
  assert.deepEqual(store.list().goals, PRESET_GOALS)
  assert.equal(fs.existsSync(file), false)
})

test('GoalArchiveStore：文件读坏用预设兜底，不抛异常', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'goals.json')
  fs.writeFileSync(file, '{broken json', 'utf8')
  const store = new GoalArchiveStore(file)
  assert.deepEqual(store.list().goals, PRESET_GOALS)
})