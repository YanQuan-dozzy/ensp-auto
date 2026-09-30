/**
 * eNSP 实验包 .paper 解析测试（来源一第二入口）。
 * 覆盖：定长目录解析（名称/归属 GUID/长度/内容）、GBK 文件名、包内 .topo 成员 → 拓扑、
 * 内容 GBK 回退解码、缺 .topo 成员、伪造/截断容器、导入工具 .paper 白名单与体积守卫。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parsePaper,
  readPaperFile,
  findPaperMember,
  importTopologyFile,
  MAX_TOPO_FILE_BYTES,
  PAPER_HEADER_BYTES,
  PAPER_ENTRY_BYTES
} from '../.build/harness.mjs'

const TOPO_XML = `<?xml version="1.0" encoding="UNICODE"?>
<topo version="1.3.00">
  <devices>
    <dev id="D1" name="R1" model="AR2220" com_port="2000" cx="10" cy="20">
      <slot number="s0"><interface sztype="Ethernet" interfacename="GE" count="2"/></slot>
    </dev>
    <dev id="D2" name="SW1" model="S5700" com_port="2001" cx="200" cy="20">
      <slot number="s0"><interface sztype="Ethernet" interfacename="GE" count="24"/></slot>
    </dev>
  </devices>
  <lines>
    <line srcDeviceID="D1" destDeviceID="D2">
      <interfacePair lineName="Copper" srcIndex="1" tarIndex="9"/>
    </line>
  </lines>
</topo>`

/** 真机 .paper 中「实验六VRRP配置.topo」的 GBK 字节（对照附件样本） */
const GBK_TOPO_NAME = Buffer.from([
  0xca, 0xb5, 0xd1, 0xe9, 0xc1, 0xf9, 0x56, 0x52, 0x52, 0x50, 0xc5, 0xe4, 0xd6, 0xc3,
  0x2e, 0x74, 0x6f, 0x70, 0x6f
])

/** 依 .paper 定长目录格式打包（对照 core/topology/fromPaper.ts 的常量与偏移） */
function buildPaper(members) {
  const dir = Buffer.alloc(PAPER_HEADER_BYTES + members.length * PAPER_ENTRY_BYTES)
  dir.writeUInt32LE(members.length, 0)
  dir.writeUInt32LE(1, 4)
  members.forEach((m, i) => {
    const base = PAPER_HEADER_BYTES + i * PAPER_ENTRY_BYTES
    dir.writeUInt32LE(m.data.length, base)
    const owner = Buffer.from(m.owner ?? '', 'ascii')
    owner.copy(dir, base + 4, 0, Math.min(owner.length, 36))
    const name = m.nameBytes ?? Buffer.from(m.name ?? '', 'utf8')
    name.copy(dir, base + 44, 0, Math.min(name.length, 64))
  })
  return Buffer.concat([dir, ...members.map((m) => m.data)])
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `ensp-paper-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
}

test('parsePaper：定长目录 → 成员（名称/归属 GUID/长度/内容，GBK 名解码）', () => {
  const buf = buildPaper([
    { name: 'instruction.txt', data: Buffer.from('step1 VLAN 11 to 30', 'utf8') },
    { nameBytes: GBK_TOPO_NAME, data: Buffer.from(TOPO_XML, 'utf8') },
    { name: 'vrpcfg.cfg', owner: '398C7CFC-53C3-40b2-9214-BD8329B51AEE', data: Buffer.from('sysname SW1\n', 'utf8') }
  ])
  const a = parsePaper(buf)
  assert.equal(a.version, 1)
  assert.equal(a.warnings.length, 0)
  assert.equal(a.members.length, 3)
  assert.deepEqual(a.members.map((m) => m.name), ['instruction.txt', '实验六VRRP配置.topo', 'vrpcfg.cfg'])
  assert.equal(a.members[0].data.toString('utf8'), 'step1 VLAN 11 to 30')
  assert.equal(a.members[2].owner, '398C7CFC-53C3-40b2-9214-BD8329B51AEE')
  assert.equal(a.members[2].size, 12)
  // 数据区在目录之后连续排布：第 3 个成员偏移 = 包头 + 3×304 + 前两段长度
  assert.equal(a.members[2].offset, PAPER_HEADER_BYTES + 3 * PAPER_ENTRY_BYTES + a.members[0].size + a.members[1].size)
  assert.equal(findPaperMember(a, '.topo').name, '实验六VRRP配置.topo')
  assert.equal(findPaperMember(a, '.paper'), undefined)
})

test('parsePaper：成员数据越界 → 停止解析并记 warning（不越界读）', () => {
  const buf = buildPaper([
    { name: 'a.txt', data: Buffer.from('12345', 'utf8') },
    { name: 'b.txt', data: Buffer.from('67890', 'utf8') }
  ])
  buf.writeUInt32LE(9999, PAPER_HEADER_BYTES) // 把首个成员长度改成越过文件尾
  const a = parsePaper(buf)
  assert.equal(a.members.length, 0)
  assert.equal(a.warnings.length, 1)
})

test('parsePaper：非法容器（过小 / 成员数异常 / 目录区越界）直接抛错', () => {
  assert.throws(() => parsePaper(Buffer.alloc(4)), /过小/)
  const zero = Buffer.alloc(PAPER_HEADER_BYTES)
  zero.writeUInt32LE(0, 0)
  assert.throws(() => parsePaper(zero), /成员数量异常/)
  const huge = Buffer.alloc(PAPER_HEADER_BYTES)
  huge.writeUInt32LE(1000, 0)
  assert.throws(() => parsePaper(huge), /目录区超出/)
})

test('readPaperFile：包内 .topo 成员 → 设备/链路/端口标注（与非压缩 .topo 同形）', () => {
  const file = tmpFile('.paper')
  try {
    fs.writeFileSync(file, buildPaper([
      { name: 'instruction.txt', data: Buffer.from('do it', 'utf8') },
      { nameBytes: GBK_TOPO_NAME, data: Buffer.from(TOPO_XML, 'utf8') },
      { name: 'vrpcfg.cfg', owner: 'D1', data: Buffer.from('sysname R1', 'utf8') }
    ]))
    const { topology, report } = readPaperFile(file)
    assert.equal(report.devices, 2)
    assert.equal(report.links, 1)
    assert.equal(report.encoding, 'utf8')
    assert.equal(report.gzipped, false)
    assert.equal(topology.nodes.find((n) => n.name === 'R1').deviceId, '127.0.0.1:2000')
    const link = topology.links[0]
    assert.equal(link.from, 'R1')
    assert.equal(link.to, 'SW1')
    assert.equal(link.label, 'GE0/0/1 ↔ GE0/0/10') // R1 路由器 0-based；SW1 交换机 tarIndex=9 → 0/0/10
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('readPaperFile：成员内容为 GBK 时回退解码（report.encoding=gbk）', () => {
  const head = Buffer.from(
    '<?xml version="1.0" encoding="UNICODE"?><topo><devices><dev id="D1" name="', 'utf8'
  )
  const gbkName = Buffer.from([0xcd, 0xe2, 0xb2, 0xbf, 0xb7, 0xfe, 0xce, 0xf1, 0xc6, 0xf7, 0x31]) // 外部服务器1
  const tail = Buffer.from('" model="S3700" com_port="2003" cx="1" cy="2"/></devices></topo>', 'utf8')
  const file = tmpFile('.paper')
  try {
    fs.writeFileSync(file, buildPaper([
      { name: 'x.topo', data: Buffer.concat([head, gbkName, tail]) }
    ]))
    const { topology, report } = readPaperFile(file)
    assert.equal(report.encoding, 'gbk')
    assert.equal(report.devices, 1)
    assert.equal(topology.nodes[0].name, '外部服务器1')
    assert.equal(topology.nodes[0].deviceId, '127.0.0.1:2003')
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('readPaperFile：包内无 .topo 成员 → 抛错（不静默返回空拓扑）', () => {
  const file = tmpFile('.paper')
  try {
    fs.writeFileSync(file, buildPaper([{ name: 'instruction.txt', data: Buffer.from('only text', 'utf8') }]))
    assert.throws(() => readPaperFile(file), /\.topo/)
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('import_topology_file：接受 .paper 并解析出设备（走 ctx.topology.setFile）', async () => {
  const file = tmpFile('.paper')
  try {
    fs.writeFileSync(file, buildPaper([{ nameBytes: GBK_TOPO_NAME, data: Buffer.from(TOPO_XML, 'utf8') }]))
    let saved = null
    const res = await importTopologyFile.handler(
      { path: file },
      { topology: { setFile: (t, p) => { saved = { t, p } } } }
    )
    assert.equal(res.ok, true)
    assert.equal(res.data.report.devices, 2)
    assert.equal(saved.t.nodes.length, 2)
    assert.equal(saved.p, file)
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('import_topology_file：非 .topo/.paper 扩展名被拒绝', async () => {
  const res = await importTopologyFile.handler({ path: path.join(os.tmpdir(), 'x.paperx') }, {})
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'BAD_PARAM')
  assert.match(res.error.message, /只支持 \.topo \/ \.paper/)
})

test('import_topology_file：超过体积上限的 .paper 被拒绝（不整份读入）', async () => {
  const file = tmpFile('.paper')
  try {
    fs.writeFileSync(file, 'x')
    fs.truncateSync(file, MAX_TOPO_FILE_BYTES + 1)
    const res = await importTopologyFile.handler({ path: file }, {})
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'BAD_PARAM')
    assert.match(res.error.message, /MB 上限/)
  } finally {
    fs.rmSync(file, { force: true })
  }
})