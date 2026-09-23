/**
 * 工程文件写回（F-5.7）测试。
 * 覆盖：round-trip（Topology → .topo → 解析回读一致）、UTF-16LE BOM、stableGuid 确定性、
 * com_port 分配（沿用已有 / 从 startPort 递增）、网格坐标兜底、特殊字符转义、墓碑过滤。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { topologyToXml, writeTopoFile, stableGuid, readTopoFile, decodeTopo } from '../.build/harness.mjs'

/** 构造一份典型拓扑：路由 + 交换机 + PC，部分带坐标/端口，部分缺省 */
function sampleTopology() {
  return {
    nodes: [
      { id: 'R1', name: 'AR1', role: 'router', model: 'AR2220', deviceId: '127.0.0.1:2000', x: 120, y: 80 },
      { id: 'SW1', name: '核心交换机', role: 'switch', model: 'S5700', x: 240, y: 180 },
      { id: 'PC1', name: 'PC-1', role: 'pc', model: 'PC' },
      { id: 'R2', name: 'Router&"2"', role: 'router', model: 'AR1220', deviceId: '127.0.0.1:2005', x: 400, y: 300 }
    ],
    links: [
      { id: 'l1', from: 'R1', to: 'SW1', source: 'file' },
      { id: 'l2', from: 'SW1', to: 'PC1', source: 'file' },
      { id: 'l3', from: 'R1', to: 'R2', source: 'file' }
    ],
    updatedAt: Date.now()
  }
}

test('round-trip：写出的 .topo 能被解析器原样读回', () => {
  const file = path.join(os.tmpdir(), `ensp-write-${Date.now()}.topo`)
  try {
    const { report } = writeTopoFile(file, sampleTopology(), { encoding: 'utf8' })
    assert.equal(report.devices, 4)
    assert.equal(report.links, 3)
    assert.equal(report.encoding, 'utf8')

    // 端口分配：R1 沿用 2000、R2 沿用 2005；SW1 从 startPort=2000 递增跳过已用 → 2001；PC 无 deviceId → 2002
    assert.equal(report.ports['AR1'], 2000)
    assert.equal(report.ports['Router&"2"'], 2005)
    assert.equal(report.ports['核心交换机'], 2001)
    assert.equal(report.ports['PC-1'], 2002)

    const { topology } = readTopoFile(file)
    assert.equal(topology.nodes.length, 4)
    assert.equal(topology.links.length, 3)

    const ar1 = topology.nodes.find((n) => n.name === 'AR1')
    assert.equal(ar1.deviceId, '127.0.0.1:2000')
    assert.equal(ar1.x, 120)
    assert.equal(ar1.y, 80)
    assert.equal(ar1.model, 'AR2220')

    // 特殊字符名转义后仍能读回
    assert.ok(topology.nodes.some((n) => n.name === 'Router&"2"'))

    // 链路两两端点都在
    assert.ok(topology.links.some((l) => l.from === 'AR1' && l.to === '核心交换机'))
    assert.ok(topology.links.some((l) => l.from === '核心交换机' && l.to === 'PC-1'))
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('UTF-16LE 输出（默认）：带 BOM，decodeTopo 可识别', () => {
  const file = path.join(os.tmpdir(), `ensp-write-u16-${Date.now()}.topo`)
  try {
    const { report } = writeTopoFile(file, sampleTopology()) // 默认 utf16le
    assert.equal(report.encoding, 'utf16le')
    const buf = fs.readFileSync(file)
    assert.equal(buf[0], 0xff) // BOM
    assert.equal(buf[1], 0xfe)
    const d = decodeTopo(buf)
    assert.equal(d.encoding, 'utf16le')
    assert.ok(d.xml.includes('<dev '))
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('stableGuid：确定性（同 seed 同值，不同 seed 不同值）', () => {
  const a = stableGuid('R1')
  const b = stableGuid('R1')
  const c = stableGuid('SW1')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
})

test('无坐标节点走网格布局；链路端点索引各自独立递增', () => {
  const { xml, report } = topologyToXml(
    {
      nodes: [
        { id: 'A', name: 'A', role: 'router', model: 'AR2220' },
        { id: 'B', name: 'B', role: 'router', model: 'AR2220' },
        { id: 'C', name: 'C', role: 'router', model: 'AR2220' }
      ],
      links: [
        { id: 'a', from: 'A', to: 'B', source: 'file' },
        { id: 'b', from: 'B', to: 'C', source: 'file' }
      ],
      updatedAt: 0
    },
    { encoding: 'utf8', startPort: 2000, gridSpacing: 100 }
  )
  assert.equal(report.devices, 3)
  assert.equal(report.links, 2)
  // 全部无坐标 → 网格：A(100,100) B(250,100) C(400,100)
  assert.match(xml, /name="A"[^>]*cx="100\.000000" cy="100\.000000"/)
  assert.match(xml, /name="B"[^>]*cx="250\.000000" cy="100\.000000"/)
  assert.match(xml, /name="C"[^>]*cx="400\.000000" cy="100\.000000"/)
  // A→B 的 line 使用 A 的 0 号接口与 B 的 0 号接口；B→C 使用 B 的 1 号接口与 C 的 0 号接口
  const lines = [...xml.matchAll(/<line srcDeviceID="([^"]+)" destDeviceID="([^"]+)"[\s\S]*?srcIndex="(\d+)"[\s\S]*?tarIndex="(\d+)"/g)]
  const linkList = lines.map((m) => ({ src: m[1], dst: m[2], si: Number(m[3]), ti: Number(m[4]) }))
  assert.equal(linkList.length, 2)
  // 按 GUID 无法直接判断 A/B/C，改为按索引语义断言
  assert.equal(linkList[0].si, 0)
  assert.equal(linkList[0].ti, 0)
  // 两条 line 的端点 GUID：A、B、C 三个设备
  const allGuids = linkList.flatMap((l) => [l.src, l.dst])
  assert.equal(new Set(allGuids).size, 3)
  // 设备 B 在第一条里是 tar(0)，在第二条里是 src(1)：与 A 相连的 B 接口 0 与 C 相连的 B 接口 1 不重复
  assert.equal(linkList[1].si, 1)
  assert.equal(linkList[1].ti, 0)
})

test('墓碑节点/链路被过滤，不落入文件', () => {
  const { report } = topologyToXml(
    {
      nodes: [
        { id: 'keep', name: 'keep', role: 'router', model: 'AR2220' },
        { id: 'gone', name: 'gone', role: 'router', model: 'AR2220', deleted: true }
      ],
      links: [
        { id: 'l', from: 'keep', to: 'gone', source: 'manual' },
        { id: 'x', from: 'keep', to: 'gone', source: 'manual', deleted: true }
      ],
      updatedAt: 0
    },
    { encoding: 'utf8' }
  )
  assert.equal(report.devices, 1)
  assert.equal(report.links, 0) // 端点 gone 已墓碑，不可达链路也被过滤
})

test('端口冲突：拓扑内两台设备指向同一端口时后者重新分配并告警', () => {
  const { report } = topologyToXml(
    {
      nodes: [
        { id: 'A', name: 'A', role: 'router', model: 'AR2220', deviceId: '127.0.0.1:2000' },
        { id: 'B', name: 'B', role: 'router', model: 'AR2220', deviceId: '127.0.0.1:2000' }
      ],
      links: [],
      updatedAt: 0
    },
    { encoding: 'utf8', startPort: 2000 }
  )
  assert.equal(report.ports['A'], 2000)
  assert.equal(report.ports['B'], 2001) // B 冲突 → 重分配 2001
  assert.ok(report.warnings.some((w) => w.includes('冲突')))
})