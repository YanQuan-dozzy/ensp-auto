/**
 * 工程文件解析（F-5.2）测试。
 * 覆盖：明文 XML（含中文名、interfacePair 两端、未知元素忽略、0 设备 warning）、
 * gzip / UTF-16 解码、com_port → 可连接 deviceId。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decodeTopo, parseTopoXml, readTopoFile } from '../.build/harness.mjs'

const XML_PLAIN = `<?xml version="1.0" encoding="UNICODE"?>
<topo version="1.3.00.100">
  <devices>
    <device name="AR1" model="AR2220" x="120" y="80" devid="d-1" com_port="2008"/>
    <device name="核心交换机" model="S5700" x="240" y="180" devid="d-2" com_port="2009"/>
    <device name="PC-1" model="" x="60" y="260" devid="d-3"/>
    <shape type="1" x="0" y="0" width="400" height="300"/>
  </devices>
  <links>
    <interfacePair><fromdevice name="AR1"/><todevice name="核心交换机"/></interfacePair>
    <interfacePair><self name="PC-1"/><other name="核心交换机"/></interfacePair>
  </links>
</topo>`

test('parseTopoXml：明文 XML 解析设备与链路', () => {
  const { topology, report } = parseTopoXml(XML_PLAIN)
  assert.equal(report.devices, 3)
  assert.equal(report.links, 2)
  assert.equal(report.warnings.length, 0)

  const ar1 = topology.nodes.find((n) => n.name === 'AR1')
  assert.equal(ar1.role, 'router')
  assert.equal(ar1.model, 'AR2220')
  assert.equal(ar1.x, 120)
  assert.equal(ar1.deviceId, '127.0.0.1:2008') // com_port → 可连接地址
  assert.equal(topology.nodes.find((n) => n.name === '核心交换机').role, 'switch')
  // 无 com_port 的 PC 不打 deviceId（纯展示）
  assert.equal(topology.nodes.find((n) => n.name === 'PC-1').deviceId, undefined)

  const pair = topology.links.find((l) => l.from === 'AR1')
  assert.equal(pair.to, '核心交换机')
  assert.equal(pair.source, 'file')
})

test('parseTopoXml：0 设备时给 warning 不崩溃', () => {
  const { report } = parseTopoXml('<topo version="9"><unknown/></topo>')
  assert.equal(report.devices, 0)
  assert.equal(report.warnings.length, 1)
  assert.ok(report.warnings[0].includes('校准'))
})

test('parseTopoXml：未知元素（shape/txttips）被忽略', () => {
  const { topology } = parseTopoXml(
    '<topo><devices><device name="R1" model="AR2220"/></devices><txttips text="AS 100"/></topo>'
  )
  assert.equal(topology.nodes.length, 1)
})

test('decodeTopo：gzip 魔数解压', () => {
  const buf = gzipSync(Buffer.from(XML_PLAIN, 'utf8'))
  const d = decodeTopo(buf)
  assert.equal(d.gzipped, true)
  const { topology } = parseTopoXml(d.xml)
  assert.equal(topology.nodes.length, 3)
})

test('decodeTopo：UTF-16LE BOM（encoding=UNICODE 场景）', () => {
  const content = Buffer.from(XML_PLAIN, 'utf16le')
  const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), content])
  const d = decodeTopo(withBom)
  assert.equal(d.gzipped, false)
  assert.ok(d.xml.includes('<device'))
})

test('decodeTopo：普通 UTF-8 直通', () => {
  const d = decodeTopo(Buffer.from(XML_PLAIN, 'utf8'))
  assert.equal(d.gzipped, false)
  assert.ok(d.xml.includes('<topo'))
})

// —— 真机校准（按真实「教学区网络设计拓扑.topo」样例：<dev> 标签 + <line> 链路 + 自闭合 interfacePair + GBK 中文名）——

/** 教学区拓扑的忠实片段：<dev id=…>、<line srcDeviceID/destDeviceID> 包裹自闭合 interfacePair、cx/cy 坐标 */
const XML_REAL = `<?xml version="1.0" encoding="UNICODE"?>
<topo version="1.3.00">
  <devices>
    <dev id="CORE1-0000-000000000001" name="Core1" model="S5700" com_port="2000" cx="217.000000" cy="172.000000" system_mac="4C-1F-CC-15-2B-1B"/>
    <dev id="CORE2-0000-000000000002" name="Core2" model="S5700" com_port="2001" cx="541.000000" cy="173.000000"/>
    <dev id="B3-0000-00000000000003" name="Building3" model="S5700" com_port="2002" cx="146.000000" cy="267.000000"/>
    <dev id="T3-0000-00000000000004" name="3号教学楼接入" model="S3700" com_port="2005" cx="73.000000" cy="373.000000"/>
    <dev id="PC-0000-00000000000005" name="PC1" model="PC" com_port="0"/>
  </devices>
  <lines>
    <line srcDeviceID="CORE1-0000-000000000001" destDeviceID="CORE2-0000-000000000002">
      <interfacePair lineName="Copper" srcIndex="0" srcBoundRectIsMoved="1" tarIndex="0" tarBoundRectIsMoved="1"/>
    </line>
    <line srcDeviceID="CORE1-0000-000000000001" destDeviceID="CORE2-0000-000000000002">
      <interfacePair lineName="Copper" srcIndex="1" srcBoundRectIsMoved="1" tarIndex="1" tarBoundRectIsMoved="1"/>
    </line>
    <line srcDeviceID="CORE1-0000-000000000001" destDeviceID="B3-0000-00000000000003">
      <interfacePair lineName="Copper" srcIndex="9" srcBoundRectIsMoved="1" tarIndex="9" tarBoundRectIsMoved="1"/>
    </line>
    <line srcDeviceID="B3-0000-00000000000003" destDeviceID="T3-0000-00000000000004">
      <interfacePair lineName="Copper" srcIndex="0" srcBoundRectIsMoved="1" tarIndex="0" tarBoundRectIsMoved="1"/>
    </line>
    <line srcDeviceID="B3-0000-00000000000003" destDeviceID="PC-0000-00000000000005">
      <interfacePair lineName="Copper" srcIndex="1" srcBoundRectIsMoved="1" tarIndex="0" tarBoundRectIsMoved="1"/>
    </line>
  </lines>
  <shapes>
    <shape type="1" filloption="1" color="16744448" upleftcorner="58,233" width="220" height="333"/>
  </shapes>
</topo>`

test('parseTopoXml：真机新版格式（<dev> + <line> + 自闭合 interfacePair + cx/cy）', () => {
  const { topology, report } = parseTopoXml(XML_REAL)
  assert.equal(report.devices, 5)
  // Core1↔Core2 两条 interfacePair 去重为 1 条链路
  assert.equal(report.links, 4)
  assert.equal(report.warnings.length, 0)

  const core1 = topology.nodes.find((n) => n.name === 'Core1')
  assert.equal(core1.deviceId, '127.0.0.1:2000')
  assert.equal(core1.x, 217) // cx/cy → x/y
  assert.equal(core1.y, 172)
  assert.equal(topology.nodes.find((n) => n.name === '3号教学楼接入').role, 'switch')
  // 无 com_port（=0）的 PC 不打 deviceId
  assert.equal(topology.nodes.find((n) => n.name === 'PC1').deviceId, undefined)

  assert.ok(topology.links.some((l) => l.from === 'Core1' && l.to === 'Core2'))
  assert.equal(topology.links.filter((l) => l.from === 'Core1' && l.to === 'Core2').length, 1)
  // interfacePair 只有 lineName，绝不能把它当端点
  assert.ok(!topology.links.some((l) => l.from === 'Copper' || l.to === 'Copper'))
})

test('decodeTopo：真机中文版为 GBK（头部谎称 UNICODE），严格 UTF-8 校验失败时回退 GBK', () => {
  // "外部服务器1" 的 GBK 字节（0xCD 0xE2 0xB2 0xBF 0xB7 0xFE 0xCE 0xF1 0xC6 0xF7 0x31），整体字节不是合法 UTF-8
  const ascii = Buffer.from('<topo><devices><dev name="', 'utf8')
  const gbkName = Buffer.from([0xcd, 0xe2, 0xb2, 0xbf, 0xb7, 0xfe, 0xce, 0xf1, 0xc6, 0xf7, 0x31])
  const tail = Buffer.from('" model="S3700" com_port="2003"/></devices></topo>', 'utf8')
  const d = decodeTopo(Buffer.concat([ascii, gbkName, tail]))
  assert.equal(d.gzipped, false)
  assert.equal(d.encoding, 'gbk')
  assert.ok(d.xml.includes('外部服务器1'))
  const { topology } = parseTopoXml(d.xml)
  assert.equal(topology.nodes[0].name, '外部服务器1')
})

test('readTopoFile：真机 GBK .topo 端到端（字节 → 解码 → 设备/链路，report.encoding=gbk）', () => {
  const part1 = Buffer.from('<?xml version="1.0" encoding="UNICODE"?><topo version="1.3.00"><devices>'
    + '<dev id="D1" name="', 'utf8')
  const gbkName = Buffer.from([0xcd, 0xe2, 0xb2, 0xbf, 0xb7, 0xfe, 0xce, 0xf1, 0xc6, 0xf7, 0x31]) // 外部服务器1
  const part2 = Buffer.from('" model="S3700" com_port="2003" cx="638.0" cy="21.0"/>'
    + '<dev id="D2" name="SW2" model="S5700" com_port="2000"/>'
    + '</devices><lines>'
    + '<line srcDeviceID="D1" destDeviceID="D2">'
    + '<interfacePair lineName="Copper" srcIndex="0" tarIndex="0"/>'
    + '</line></lines></topo>', 'utf8')
  const file = path.join(os.tmpdir(), `ensp-topo-gbk-${Date.now()}.topo`)
  try {
    fs.writeFileSync(file, Buffer.concat([part1, gbkName, part2]))
    const { topology, report } = readTopoFile(file)
    assert.equal(report.devices, 2)
    assert.equal(report.links, 1)
    assert.equal(report.encoding, 'gbk')
    assert.equal(report.gzipped, false)
    const d1 = topology.nodes.find((n) => n.name === '外部服务器1')
    assert.equal(d1.deviceId, '127.0.0.1:2003')
    assert.equal(d1.x, 638)
    assert.equal(topology.links[0].from, '外部服务器1')
    assert.equal(topology.links[0].to, 'SW2')
  } finally {
    fs.rmSync(file, { force: true })
  }
})