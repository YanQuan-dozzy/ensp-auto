/**
 * Skill 模块测试（v1.3）。
 * 覆盖：frontmatter 解析/回退、slug 与唯一 id、buildSkillMarkdown 往返、
 * buildSkillPrompt 注入模板、SkillStore（内置预置/新建/更新/启用/删除/导入/目录收集/持久化）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BUILTIN_SKILLS,
  SkillStore,
  buildAgentSystemPrompt,
  buildSkillMarkdown,
  buildSkillPrompt,
  deriveSkillMeta,
  fileNameToSkillName,
  isValidSkillId,
  skillIdBase,
  parseSkillContent,
  slugify,
  stripFrontmatter,
  uniqueSkillId,
  walkMarkdown
} from '../.build/harness.mjs'

function tmpDir(t, prefix = 'ensp-skills') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ———————————————— parse ————————————————

test('parseSkillContent：读取 frontmatter 的 name/description 并剥离正文', () => {
  const raw = `---
name: 华为设备配置
description: "配置规范：A、B 点"
---

# 正文
内容。`
  const p = parseSkillContent(raw)
  assert.equal(p.name, '华为设备配置')
  assert.equal(p.description, '配置规范：A、B 点')
  assert.ok(p.body.startsWith('# 正文'))
  assert.ok(!p.body.includes('name:'))
})

test('parseSkillContent：无 frontmatter 时退化为空名 + 原文', () => {
  const raw = '# 只有标题\n\n内容'
  const p = parseSkillContent(raw)
  assert.equal(p.name, '')
  assert.equal(p.body, raw)
})

test('deriveSkillMeta：名称/描述按 frontmatter → 标题 → 首行回退', () => {
  const byTitle = deriveSkillMeta('# OSPF 配置\n\n第一步……', 'ensp-config')
  assert.equal(byTitle.name, 'ensp-config')
  assert.equal(byTitle.description, 'OSPF 配置')

  const noHeading = deriveSkillMeta('直接是正文第一句，没有标题。', 'no-heading')
  assert.equal(noHeading.description, '直接是正文第一句，没有标题。')
})

test('slugify / uniqueSkillId / isValidSkillId', () => {
  assert.equal(slugify('华为设备配置'), 'skill')
  assert.equal(slugify('Ensp Config Skill'), 'ensp-config-skill')
  assert.equal(slugify('  --OSPF-- '), 'ospf')
  assert.ok(isValidSkillId('ensp-config'))
  assert.ok(!isValidSkillId('中文名'))
  assert.ok(!isValidSkillId('-lead'))
  const existing = new Set(['a', 'a-2'])
  assert.equal(uniqueSkillId('a', existing), 'a-3')
  assert.equal(uniqueSkillId('b', existing), 'b')
})

test('buildSkillMarkdown：往返一致，name 自动兜底，特殊字符被引号包住', () => {
  const md = buildSkillMarkdown('OSPF: 动态路由', '作用：全网互通', '# 正文\n\nhello')
  const parsed = parseSkillContent(md)
  assert.equal(parsed.name, 'OSPF: 动态路由')
  assert.equal(parsed.description, '作用：全网互通')
  assert.ok(parsed.body.startsWith('# 正文'))
  const empty = buildSkillMarkdown('', '', '内容')
  assert.equal(parseSkillContent(empty).name, '未命名技能')
})

test('stripFrontmatter：两种形态', () => {
  assert.equal(stripFrontmatter('---\nname: x\n---\n\n正文'), '正文')
  assert.equal(stripFrontmatter('没有 frontmatter'), '没有 frontmatter')
})

// ———————————————— prompt ————————————————

test('buildSkillPrompt：无技能返回空串；有技能按模板拼接；空名/空内容被过滤', () => {
  assert.equal(buildSkillPrompt([]), '')
  assert.equal(buildSkillPrompt([{ name: '  ', description: '', content: 'x' }]), '')

  const p = buildSkillPrompt([
    { name: 'A', description: 'A 描述', content: 'A 正文' },
    { name: 'B', description: '', content: 'B 正文' }
  ])
  assert.ok(p.includes('# 已启用技能'))
  assert.ok(p.includes('## 技能：A'))
  assert.ok(p.includes('A 描述'))
  assert.ok(p.includes('## 技能：B'))
  assert.ok(!p.includes('} A 正文')) // 不应有对象序列化
})

test('buildAgentSystemPrompt：基础提示词 + 技能片段', () => {
  const base = buildAgentSystemPrompt()
  assert.ok(base.includes('你是 eNSP 网络实验代理'))
  const withSkill = buildAgentSystemPrompt([{ name: 'S', description: 'D', content: 'C' }])
  assert.ok(withSkill.includes('# 已启用技能'))
  assert.ok(withSkill.startsWith(base))
})

// ———————————————— SkillStore ————————————————

test('首次初始化：预置内置技能且默认全部停用', (t) => {
  const store = new SkillStore({ dir: tmpDir(t) })
  const list = store.list()
  assert.equal(list.length, BUILTIN_SKILLS.length)
  assert.ok(list.every((s) => s.enabled === false))
  assert.ok(list.every((s) => s.builtin === true))
})

test('内置技能只预置一次：删除后重建 store 不会复活', (t) => {
  const dir = tmpDir(t)
  const s1 = new SkillStore({ dir })
  const first = s1.list()[0]
  assert.ok(s1.remove(first.id))
  const s2 = new SkillStore({ dir })
  assert.equal(s2.list().length, BUILTIN_SKILLS.length - 1)
})

test('save：新建技能自动生成 id 并规范化 frontmatter；同名去重', (t) => {
  const store = new SkillStore({ dir: tmpDir(t) })
  const a = store.save({ name: '我的技能', description: '描述', content: '# 正文' })
  assert.ok(isValidSkillId(a.id))
  assert.equal(a.name, '我的技能')
  assert.equal(store.get(a.id).content, buildSkillMarkdown('我的技能', '描述', '# 正文'))

  const b = store.save({ name: '我的技能', description: '', content: '# 另一个' })
  assert.notEqual(b.id, a.id)
  assert.equal(b.id, `${a.id}-2`)
})

test('save：更新已有技能（保留 id、覆盖 name/description/正文）', (t) => {
  const store = new SkillStore({ dir: tmpDir(t) })
  const a = store.save({ name: 'A', description: '旧', content: '# 旧内容' })
  const b = store.save({ id: a.id, name: 'B', description: '新', content: '# 新内容' })
  assert.equal(b.id, a.id)
  assert.equal(b.name, 'B')
  assert.equal(b.description, '新')
  const again = store.get(a.id)
  assert.ok(!again.content.includes('旧内容'))
  assert.ok(again.content.includes('# 新内容'))
})

test('save：内容为空抛错；body 里带的 frontmatter 会被剥离再组装', (t) => {
  const store = new SkillStore({ dir: tmpDir(t) })
  assert.throws(() => store.save({ name: 'x', content: '   ' }), /不能为空/)
  const s = store.save({
    name: 'X',
    description: '',
    content: '---\nname: 旧名\n---\n# 真正文'
  })
  assert.equal(s.name, 'X')
  assert.ok(store.get(s.id).content.includes('# 真正文'))
})

test('setEnabled：整体替换启用集合并持久化到新实例', (t) => {
  const dir = tmpDir(t)
  const store = new SkillStore({ dir })
  const ids = store.list().map((s) => s.id)
  const enabled = ids.slice(0, 2)
  store.setEnabled(enabled)
  assert.deepEqual(
    store.list().filter((s) => s.enabled).map((s) => s.id).sort(),
    [...enabled].sort()
  )
  // 持久化：新实例仍记住启用状态
  const store2 = new SkillStore({ dir })
  assert.deepEqual(
    store2.enabledContents().map((s) => s.content.length > 0),
    Array.from({ length: 2 }, () => true)
  )
  assert.equal(store2.list().filter((s) => s.enabled).length, 2)
})

test('remove：删除文件并从启用集合摘除', (t) => {
  const store = new SkillStore({ dir: tmpDir(t) })
  const s = store.save({ name: '临时', description: '', content: '# x' })
  store.setEnabled([s.id])
  assert.equal(store.list().find((x) => x.id === s.id).enabled, true)
  assert.equal(store.remove(s.id), true)
  assert.equal(store.remove(s.id), false)
  assert.equal(store.get(s.id), null)
})

test('importFromPaths：导入 .md、跳过 readme 与重复 id，返回 created/skipped', (t) => {
  const dir = tmpDir(t)
  const srcDir = tmpDir(t, 'ensp-skills-src')
  const f1 = path.join(srcDir, 'good.skill.md')
  const f2 = path.join(srcDir, 'README.md')
  const f3 = path.join(srcDir, 'nested', 'SKILL.md')
  fs.mkdirSync(path.dirname(f3), { recursive: true })
  fs.writeFileSync(f1, '---\nname: 导入技能A\n---\n# A\n', 'utf8')
  fs.writeFileSync(f2, '# readme 不该被导入\n', 'utf8')
  fs.writeFileSync(f3, '# Nested Skill\n', 'utf8')

  const store = new SkillStore({ dir })
  const r1 = store.importFromPaths([f1, f2, f3])
  assert.equal(r1.created.length, 2)
  assert.equal(r1.skipped.length, 1)
  assert.ok(r1.created.some((s) => s.name === '导入技能A'))
  assert.ok(r1.created.some((s) => s.name === 'SKILL'))

  // 重复导入：同 id 跳过
  const r2 = store.importFromPaths([f1])
  assert.equal(r2.created.length, 0)
  assert.equal(r2.skipped.length, 1)
})

test('R46 导入：目录里三个中文名 .md 全部导入且 id 各不相同', (t) => {
  const dir = tmpDir(t)
  const srcDir = tmpDir(t, 'ensp-skills-cn')
  const names = ['巡检流程.md', '排错手册.md', '备份规范.md']
  for (const n of names) {
    fs.writeFileSync(path.join(srcDir, n), `# ${n.replace(/\.md$/, '')}\n\n正文\n`, 'utf8')
  }

  const store = new SkillStore({ dir })
  const r = store.importFromPaths([srcDir])

  assert.equal(r.created.length, 3, `三个中文名文件都要导入，实际 ${JSON.stringify(r.skipped)}`)
  assert.equal(new Set(r.created.map((s) => s.id)).size, 3, 'id 必须各不相同')
  for (const s of r.created) assert.ok(isValidSkillId(s.id), `${s.id} 必须是合法 id`)

  // 重复导入同一目录：内容一致 → 明确报「已存在」，不产生副本
  const again = store.importFromPaths([srcDir])
  assert.equal(again.created.length, 0)
  assert.equal(again.skipped.length, 3)
  for (const line of again.skipped) assert.match(line, /已存在/)
  assert.equal(store.list().filter((s) => names.some((n) => n.includes(s.name))).length, 3)
})

test('R46 skillIdBase：中文名回退到英文文件名，两者都不可读时给出合法基名', () => {
  assert.equal(skillIdBase('巡检流程', 'daily-check'), 'daily-check')
  assert.equal(skillIdBase('Ensp Config', 'whatever'), 'ensp-config')
  const bare = skillIdBase('巡检流程', '排错手册')
  assert.equal(bare, 'skill', '都回退不了时给固定基名，绝不返回空串')
  assert.ok(isValidSkillId(bare))
})

test('walkMarkdown：递归收集 .md，忽略子目录异常', (t) => {
  const dir = tmpDir(t)
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'root.md'), 'x')
  fs.writeFileSync(path.join(dir, 'a', 'one.md'), 'x')
  fs.writeFileSync(path.join(dir, 'a', 'b', 'two.skill.md'), 'x')
  fs.writeFileSync(path.join(dir, 'a', 'notes.txt'), 'x')
  const files = walkMarkdown(dir)
  assert.equal(files.length, 3)
  assert.ok(files.every((f) => f.endsWith('.md')))
})

test('enabledContents：只返回已启用的完整内容（不含重复）', (t) => {
  const store = new SkillStore({ dir: tmpDir(t) })
  const list = store.list()
  const one = list[0]
  const other = list[1]
  store.setEnabled([one.id, other.id, one.id])
  const contents = store.enabledContents()
  assert.equal(contents.length, 2)
  assert.ok(contents.every((c) => c.name && c.content.length > 0))
})

test('T4.7 list() 走进程内缓存：返回副本，外部改动不会污染缓存', (t) => {
  const dir = tmpDir(t)
  const store = new SkillStore({ dir })
  const first = store.list()
  assert.ok(first.length > 0)

  // 调用方就地改返回值（旧实现会把缓存/内部对象一起改掉）
  first[0].name = '被外部改过的名字'
  first.pop()

  const second = store.list()
  assert.ok(second.length > 0)
  assert.notEqual(second[0].name, '被外部改过的名字', 'list() 必须返回副本')
  assert.equal(second.length, new SkillStore({ dir }).list().length)
})

test('T4.7 写操作后缓存失效：save / remove / setEnabled 立刻反映到 list()', (t) => {
  const dir = tmpDir(t)
  const store = new SkillStore({ dir })
  const before = store.list().length

  const saved = store.save({ name: '缓存失效验证', description: '', content: '# x' })
  assert.equal(store.list().length, before + 1, 'save 后必须重新读盘')

  store.setEnabled([saved.id])
  assert.equal(store.list().find((s) => s.id === saved.id).enabled, true)

  assert.equal(store.remove(saved.id), true)
  assert.equal(store.list().length, before, 'remove 后必须同步')
})
