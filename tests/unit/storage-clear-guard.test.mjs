import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { checkClearTarget } from '../.build/harness.mjs'

/**
 * D4（2026-09-23）：清理守护的判据。
 *
 * 反例来源：R17 用 `assertInside(userDataDir, target)` 当清理判据 ——
 * 「是否在 userData 之下」被当成了「是否归我们管」。而 attachments / exports
 * 支持在设置里指到任意自定义目录，于是「用了自定义目录」的用户清一次数据必然抛
 * 「拒绝操作数据目录之外的路径」，且报的是安全告警式文案。
 * 正确判据是**受管根白名单**（数据根 / 附件目录 / 导出目录，含其子目录）。
 */

function roots({ customAttachments = '', customExports = '' } = {}) {
  // 造一个「数据根」独立于真实的 tmpdir，这样 tmpdir 下的其它目录才是真正的「外部」
  const userDataDir = path.join(
    os.tmpdir(),
    `ensp-root-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  )
  return {
    userDataDir,
    attachmentsDir: customAttachments || path.join(userDataDir, 'attachments'),
    exportsDir: customExports || path.join(userDataDir, 'exports')
  }
}

test('D4：默认目录与受管根子目录均可清理', () => {
  const r = roots()
  // ① 默认目录
  assert.doesNotThrow(() => checkClearTarget(r, path.join(r.userDataDir, 'attachments')))
  assert.doesNotThrow(() => checkClearTarget(r, path.join(r.userDataDir, 'exports')))
  // sessions 固定落在 userData 下
  assert.doesNotThrow(() => checkClearTarget(r, path.join(r.userDataDir, 'sessions')))
  // P3：受管根的**子目录**也允许（比如用户把附件目录指到 D:\ensp-att 后清其子目录）
  assert.doesNotThrow(() => checkClearTarget(r, path.join(r.attachmentsDir, 'sub')))
})

test('D4：自定义附件 / 导出目录（userData 之外）可以清理 —— 本缺陷的核心回归', () => {
  // 用 tmpdir 下的一个独立目录模拟「指到 userData 之外的任意目录」（跨盘盘符不便移植）
  const custom = path.join(os.tmpdir(), `ensp-clear-custom-${Date.now()}`)
  const r = roots({ customAttachments: custom, customExports: custom })
  // 旧实现在这里必抛「拒绝操作数据目录之外的路径」
  assert.doesNotThrow(() => checkClearTarget(r, custom))
  assert.doesNotThrow(() => checkClearTarget(r, path.join(custom, '2026-09')))
})

test('D4：数据根本身 / 盘根 / 无关目录一律拒绝', () => {
  const r = roots()
  // 数据根自身：一清就把设置、技能、快照全带走
  assert.throws(() => checkClearTarget(r, r.userDataDir), /数据根目录本身/)
  // 无关目录（既非数据根也非自定义附件 / 导出）
  assert.throws(() => checkClearTarget(r, path.join(os.tmpdir(), 'not-managed-dir')), /未受管目录/)
  // userData 的兄弟目录也不行
  assert.throws(() => checkClearTarget(r, path.dirname(r.userDataDir)), /未受管目录/)
  // 盘根：白名单不拦它当「受管根」，但清理分支必须拦 ——
  // 构造「附件目录被指到盘根」的最坏设置来触达该分支
  const driveRoot = path.parse(r.userDataDir).root
  const worst = roots({ customAttachments: driveRoot })
  assert.throws(() => checkClearTarget(worst, driveRoot), /磁盘根目录/)
})

test('D4：`..` 归一化后仍按语义判定，不放过回退到数据根的写法', () => {
  const r = roots()
  assert.throws(
    () => checkClearTarget(r, path.join(r.userDataDir, 'attachments', '..')),
    /数据根目录本身/
  )
  const got = checkClearTarget(r, path.join(r.userDataDir, 'attachments', 'x', '..', 'y'))
  assert.equal(got, path.resolve(path.join(r.userDataDir, 'attachments', 'y')))
})
