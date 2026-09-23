import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitPortLabel, shortIf } from '../.build/harness.mjs'

// —— 接口标注拆分（每端独立显示，参照 ensp- 参考实现的 srcIf / dstIf 分端展示）——

test('splitPortLabel：单对 GE0/0/10 ↔ GE0/0/1 完整保留（接口名自带 / 不打散）', () => {
  assert.deepEqual(splitPortLabel('GE0/0/10 ↔ GE0/0/1'), { from: ['GE0/0/10'], to: ['GE0/0/1'] })
})

test('splitPortLabel：多对由「 / 」分隔，分别归到两端', () => {
  assert.deepEqual(splitPortLabel('GE0/0/1 ↔ GE0/0/9 / GE0/0/2 ↔ GE0/0/10'), {
    from: ['GE0/0/1', 'GE0/0/2'],
    to: ['GE0/0/9', 'GE0/0/10']
  })
})

test('splitPortLabel：三对并联链路全部保留（不截断）', () => {
  assert.deepEqual(splitPortLabel('GE0/0/1 ↔ GE0/0/1 / GE0/0/2 ↔ GE0/0/2 / GE0/0/3 ↔ GE0/0/3'), {
    from: ['GE0/0/1', 'GE0/0/2', 'GE0/0/3'],
    to: ['GE0/0/1', 'GE0/0/2', 'GE0/0/3']
  })
})

test('splitPortLabel：紧凑格式（无空格 ↔）也可解析', () => {
  assert.deepEqual(splitPortLabel('GE0/0/1↔GE0/0/1'), { from: ['GE0/0/1'], to: ['GE0/0/1'] })
})

test('splitPortLabel：无 ↔ 或空 label 返回 null（连线中点兜底）', () => {
  assert.equal(splitPortLabel(undefined), null)
  assert.equal(splitPortLabel(''), null)
  assert.equal(splitPortLabel('手动连线'), null)
})

// —— 接口名简写（与 ensp- 参考实现 TopoView.shortIf 同构）——

test('shortIf：GigabitEthernet → GE，Ethernet → Eth', () => {
  assert.equal(shortIf('GigabitEthernet0/0/1'), 'GE0/0/1')
  assert.equal(shortIf('Ethernet0/0/1'), 'Eth0/0/1')
})

test('shortIf：已是短名的 GE / 其他类型原样保留', () => {
  assert.equal(shortIf('GE0/0/10'), 'GE0/0/10')
  assert.equal(shortIf('Serial0/0/1'), 'Serial0/0/1')
})

test('shortIf：多对合并 label 中的每个接口名都会被简写', () => {
  const label = 'GigabitEthernet0/0/1 ↔ Ethernet0/0/2 / GigabitEthernet0/0/3 ↔ Ethernet0/0/4'
  const ports = splitPortLabel(label)
  assert.deepEqual(
    { from: ports.from.map(shortIf), to: ports.to.map(shortIf) },
    { from: ['GE0/0/1', 'GE0/0/3'], to: ['Eth0/0/2', 'Eth0/0/4'] }
  )
})