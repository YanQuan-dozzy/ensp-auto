import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SkillStore,
  buildSkillMarkdown,
  parseSkillContent,
  parseScopeValue,
  formatScopeValue,
  normalizeDir,
  scopeMatches,
  skillsForContext,
  contextDirsOf
} from '../.build/harness.mjs'

/**
 * F12（2026-09-26）：目录级技能 —— 技能可绑定实验/工程目录，只在该上下文激活时注入。
 *
 * 锁三条不变量：
 * 1. 空 scope = 全局技能（与 v1.3 行为完全一致，老技能不受影响）；
 * 2. 绑定判定是**前缀包含**（实验目录常有子目录），且 Windows 下大小写不敏感；
 * 3. 未传 scope 保存技能时**不改动现有绑定**（否则编辑描述会把绑定悄悄抹掉）。
 */

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensp-auto-f12-'))
  return { store: new SkillStore({ dir }), dir }
}

// ———————————————————————— frontmatter 解析 / 序列化 ————————————————————————

test('scope 往返：buildSkillMarkdown → parseSkillContent 不丢目录', () => {
  const md = buildSkillMarkdown('OSPF 排障', '邻居起不来', '正文', ['D:\\Lab\\OSPF', 'D:/Lab/VLAN'])
  const parsed = parseSkillContent(md)
  assert.deepEqual(parsed.scope, ['D:\\Lab\\OSPF', 'D:/Lab/VLAN'])
  assert.equal(parsed.name, 'OSPF 排障')
  assert.match(md, /scope: /, '带绑定时应写 scope 键')
})

test('scope 为空时不写 frontmatter 键（老文件形状不变）', () => {
  const md = buildSkillMarkdown('全局技能', '', '正文')
  assert.ok(!/scope:/.test(md))
  assert.deepEqual(parseSkillContent(md).scope, [])
})

test('parseScopeValue：换行 / 分号 / 中文分号都认，去空去重', () => {
  assert.deepEqual(parseScopeValue('a;b；c\nd'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(parseScopeValue(' x ;; x '), ['x'])
  assert.deepEqual(parseScopeValue(''), [])
  assert.equal(formatScopeValue(['a', ' a ', 'b']), 'a;b')
})

// ———————————————————————— 上下文匹配 ————————————————————————

test('normalizeDir：统一分隔符、去尾斜杠、转小写', () => {
  assert.equal(normalizeDir('D:\\Lab\\OSPF\\'), 'd:/lab/ospf')
  assert.equal(normalizeDir('D:/Lab/OSPF'), 'd:/lab/ospf')
})

test('scopeMatches：空 scope = 全局恒命中', () => {
  assert.equal(scopeMatches([], []), true)
  assert.equal(scopeMatches(undefined, []), true)
})

test('scopeMatches：前缀包含命中，且大小写与分隔符无关', () => {
  assert.equal(scopeMatches(['D:\\Lab\\OSPF'], ['d:/lab/ospf']), true, '相等')
  assert.equal(scopeMatches(['D:/lab/ospf'], ['D:\\Lab\\OSPF\\topo1']), true, '子目录也算命中')
  assert.equal(scopeMatches(['D:/lab/ospf'], ['D:/lab/vlan']), false, '兄弟目录不命中')
  assert.equal(scopeMatches(['D:/lab'], []), false, '没有上下文目录时不命中绑定技能')
})

test('skillsForContext：全局恒在，绑定技能仅命中时在（保序）', () => {
  const skills = [
    { name: 'global', description: '', content: 'g' },
    { name: 'ospf', description: '', content: 'o', scope: ['D:/lab/ospf'] },
    { name: 'vlan', description: '', content: 'v', scope: ['D:/lab/vlan'] }
  ]
  assert.deepEqual(skillsForContext(skills, ['D:/lab/ospf']).map((s) => s.name), ['global', 'ospf'])
  assert.deepEqual(skillsForContext(skills, []).map((s) => s.name), ['global'])
})

test('contextDirsOf：拓扑目录 + 工程文件所在目录（去空去重）', () => {
  assert.deepEqual(contextDirsOf('D:/Lab', 'D:\\Lab\\OSPF\\a.topo'), ['D:/Lab', 'D:\\Lab\\OSPF'])
  assert.deepEqual(contextDirsOf('', null), [])
  assert.deepEqual(contextDirsOf('D:/Lab', null), ['D:/Lab'])
})

// ———————————————————————— SkillStore 落盘 ————————————————————————

test('SkillStore：保存带绑定 → 重开 store 后绑定仍在（落盘不是内存假象）', () => {
  const { store, dir } = tmpStore()
  try {
    const saved = store.save({
      name: 'OSPF 排障',
      description: '邻居',
      content: '正文',
      scope: ['D:/Lab/OSPF']
    })
    assert.deepEqual(saved.scope, ['D:/Lab/OSPF'])
    const reopened = new SkillStore({ dir })
    assert.deepEqual(reopened.get(saved.id).scope, ['D:/Lab/OSPF'])
    assert.deepEqual(reopened.list().find((s) => s.id === saved.id).scope, ['D:/Lab/OSPF'])
    assert.deepEqual(reopened.enabledContents(), [], '未启用的不进注入内容')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('SkillStore：scope 缺省保存不改动现有绑定（编辑描述不会抹掉绑定）', () => {
  const { store, dir } = tmpStore()
  try {
    const created = store.save({ name: 'x', description: 'a', content: 'b', scope: ['D:/L'] })
    const updated = store.save({ id: created.id, description: '改了描述', content: 'b' })
    assert.deepEqual(updated.scope, ['D:/L'], '未传 scope 应保留原绑定')

    const cleared = store.save({ id: created.id, description: 'x', content: 'b', scope: [] })
    assert.deepEqual(cleared.scope, [], '显式传空数组 = 改回全局技能')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('SkillStore：enabledContents 带出 scope，供注入层过滤', () => {
  const { store, dir } = tmpStore()
  try {
    const s = store.save({ name: 'y', description: '', content: 'c', scope: ['D:/A'] })
    store.setEnabled([s.id])
    const contents = store.enabledContents()
    assert.equal(contents.length, 1)
    assert.deepEqual(contents[0].scope, ['D:/A'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})