import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packSecret, unpackSecret, normalizeKeyEntries, normalizeSshMeta } from '../.build/harness.mjs'

/**
 * 凭据加解密的核心逻辑（B6 / N23）。
 *
 * 为什么值得单测：这是**安全关键路径** —— 明文降级、换机器解不开、坏条目丢弃，
 * 每一条写错都不会崩，只会静默降级（最坏是「以为加密了其实明文」）。
 * 生产侧的 safeStorage 适配器在 secrets.ts（顶层拉 electron，进不了测试包），
 * 这里用假适配器覆盖 codec 本身。
 */

/** 假适配器：'safe' 模式做可逆的 ROT13 式变换，模拟 DPAPI；可切换「换机器后解不开」 */
function fakeCrypto({ available = true, canDecrypt = true } = {}) {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from(`ENC:${plain}`, 'utf8').toString('base64'),
    decrypt: (b64) => {
      if (!canDecrypt) throw new Error('DPAPI 解不开（换机器/换用户）')
      const s = Buffer.from(b64, 'base64').toString('utf8')
      if (!s.startsWith('ENC:')) throw new Error('坏密文')
      return s.slice(4)
    }
  }
}

test('N23 packSecret：safeStorage 可用 → enc=safe 且可解回原文', () => {
  const c = fakeCrypto()
  const entry = packSecret('sk-secret-123', c)
  assert.equal(entry.enc, 'safe')
  assert.equal(unpackSecret(entry, c), 'sk-secret-123')
})

test('N23 packSecret：safeStorage 不可用 → 降级 base64 且如实标 plain（不伪装成已加密）', () => {
  const c = fakeCrypto({ available: false })
  const entry = packSecret('sk-secret-123', c)
  assert.equal(entry.enc, 'plain', '降级必须标出来 —— 否则用户以为密钥受 DPAPI 保护')
  assert.equal(Buffer.from(entry.data, 'base64').toString('utf8'), 'sk-secret-123')
  assert.equal(unpackSecret(entry, c), 'sk-secret-123')
})

test('N23 unpackSecret：换机器/换用户后旧密文解不开 → null（不崩溃）', () => {
  const c = fakeCrypto()
  const entry = packSecret('sk-secret-123', c)
  assert.equal(unpackSecret(entry, fakeCrypto({ canDecrypt: false })), null)
})

test('N23 unpackSecret：坏 data（非 base64 round-trip）也返回 null，不抛', () => {
  const c = fakeCrypto()
  assert.equal(unpackSecret({ enc: 'safe', data: 'not-a-cipher' }, c), null)
})

test('N23 normalizeKeyEntries：丢掉坏条目，保留好条目并归一化 enc', () => {
  const out = normalizeKeyEntries({
    good: { enc: 'safe', data: 'AAAA' },
    legacyPlain: { enc: 'plain', data: 'BBBB' },
    unknownEnc: { enc: 'weird', data: 'CCCC' },
    emptyData: { enc: 'safe', data: '' },
    notObject: 'x',
    missingData: { enc: 'safe' }
  })
  assert.deepEqual(Object.keys(out).sort(), ['good', 'legacyPlain', 'unknownEnc'])
  assert.equal(out.good.enc, 'safe')
  assert.equal(out.legacyPlain.enc, 'plain')
  assert.equal(out.unknownEnc.enc, 'safe', '未知 enc 一律按 safe 处理（不降级成明文语义）')
})

test('N23 normalizeKeyEntries：非对象输入返回空表（不抛）', () => {
  for (const raw of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(normalizeKeyEntries(raw), {})
  }
})

test('N23 normalizeSshMeta：缺 host/username 的条目丢弃，port 缺省 22', () => {
  const out = normalizeSshMeta({
    a: { name: '核心交换机', host: '192.168.1.1', port: 22, username: 'admin' },
    b: { name: '缺 host', username: 'admin' },
    c: { name: '缺 username', host: '10.0.0.1' },
    d: { host: '10.0.0.2', username: 'root' }
  })
  assert.deepEqual(Object.keys(out).sort(), ['a', 'd'])
  assert.equal(out.a.name, '核心交换机')
  assert.equal(out.d.port, 22, '缺 port 应按 22 归一化')
  assert.equal(out.d.name, '', '缺 name 给空串而不是 undefined')
  assert.equal(out.d.id, 'd', 'id 取自键名')
})