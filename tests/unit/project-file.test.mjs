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
import { decodeTopo, parseTopoXml, readTopoFile, parseDeviceInterfaces, resolveInterfaceName } from '../.build/harness.mjs'

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

// —— 接口表解析 + 链路端口标注（拓扑展示增强，参照 ensp- 参考实现）——

test('parseDeviceInterfaces：标准 slot/interface（GE count=4）展开为有序接口表', () => {
  const inner = '<slot number="slot0" isMainBoard="1">'
    + '<interface sztype="Ethernet" interfacename="GE" count="4" />'
    + '</slot>'
  assert.deepEqual(parseDeviceInterfaces(inner), ['GE0/0/0', 'GE0/0/1', 'GE0/0/2', 'GE0/0/3'])
})

test('parseDeviceInterfaces：同名类型跨分组连续编号（AR2220 GE×1 + GE×2 → GE0/0/0..2）', () => {
  const inner = '<slot number="slot0">'
    + '<interface sztype="Ethernet" interfacename="GE" count="1" />'
    + '<interface sztype="Ethernet" interfacename="GE" count="2" />'
    + '</slot>'
  assert.deepEqual(parseDeviceInterfaces(inner), ['GE0/0/0', 'GE0/0/1', 'GE0/0/2'])
})

test('parseDeviceInterfaces：防火墙 triplet 格式（type + slotIndex/cardIndex/interfaceIndex）', () => {
  const inner = '<interface category="1" type="GE" slotIndex="0" cardIndex="0" interfaceIndex="1" />'
  assert.deepEqual(parseDeviceInterfaces(inner), ['GE0/0/1'])
})

test('parseDeviceInterfaces：无接口定义返回空数组', () => {
  assert.deepEqual(parseDeviceInterfaces(''), [])
  assert.deepEqual(parseDeviceInterfaces('<slot number="s0"></slot>'), [])
})

test('resolveInterfaceName：表内命中与越界兜底', () => {
  const ifaces = ['GE0/0/0', 'GE0/0/1']
  assert.equal(resolveInterfaceName(ifaces, 0), 'GE0/0/0')
  assert.equal(resolveInterfaceName(ifaces, 1), 'GE0/0/1')
  assert.equal(resolveInterfaceName(ifaces, 9), 'GE0/0/9') // 越界兜底，不抛错
  assert.equal(resolveInterfaceName([], 3), 'GE0/0/3')
})

// —— 接口编号对齐 VRP 真机（参照 ensp-mcp interface_mapping：交换机 GE/Eth 从 1 起，路由器 GE 从 0 起）——

test('parseDeviceInterfaces：交换机 GE 从 GE0/0/1 起（S5700 class 模型）', () => {
  const inner = '<slot number="s0" isMainBoard="1">'
    + '<interface sztype="Ethernet" interfacename="GE" count="24" />'
    + '</slot>'
  const ifaces = parseDeviceInterfaces(inner, { isSwitch: true })
  assert.equal(ifaces.length, 24)
  assert.equal(ifaces[0], 'GE0/0/1')
  assert.equal(ifaces[23], 'GE0/0/24')
  assert.equal(ifaces.includes('GE0/0/0'), false) // 交换机无 GE0/0/0
})

test('parseDeviceInterfaces：路由器 GE 保持从 GE0/0/0 起（isSwitch=false 兜底同旧行为）', () => {
  const inner = '<slot number="s0">'
    + '<interface sztype="Ethernet" interfacename="GE" count="3" />'
    + '</slot>'
  assert.deepEqual(parseDeviceInterfaces(inner, { isSwitch: false }), ['GE0/0/0', 'GE0/0/1', 'GE0/0/2'])
})

test('parseDeviceInterfaces：Ethernet/Eth 一律从 0/0/1 起', () => {
  const eth = '<slot><interface sztype="Ethernet" interfacename="Ethernet" count="24"/></slot>'
  assert.equal(parseDeviceInterfaces(eth)[0], 'Ethernet0/0/1')
  assert.equal(parseDeviceInterfaces(eth)[5], 'Ethernet0/0/6')
  const ethShort = '<slot><interface interfacename="Eth" count="2"/></slot>'
  assert.deepEqual(parseDeviceInterfaces(ethShort), ['Eth0/0/1', 'Eth0/0/2'])
})

test('parseDeviceInterfaces：其他类型（Serial/POS）保持 0/0/{n}', () => {
  const serial = '<slot><interface interfacename="Serial" count="2"/></slot>'
  assert.deepEqual(parseDeviceInterfaces(serial), ['Serial0/0/0', 'Serial0/0/1'])
})

test('resolveInterfaceName：越界兜底按 isSwitch 加 1', () => {
  assert.equal(resolveInterfaceName([], 3, true), 'GE0/0/4')
  assert.equal(resolveInterfaceName([], 3, false), 'GE0/0/3')
})

test('parseTopoXml：成对 <dev> 内部接口表 + line srcIndex/tarIndex → 链路端口标注', () => {
  const xml = `<topo version="1.3.00">
  <devices>
    <dev id="R1-1" name="R1" model="AR2220" com_port="2000" cx="10" cy="10">
      <slot number="slot0" isMainBoard="1">
        <interface sztype="Ethernet" interfacename="GE" count="3" />
      </slot>
    </dev>
    <dev id="SW1-2" name="SW1" model="S5700" com_port="2001" cx="200" cy="10">
      <slot number="slot0" isMainBoard="1">
        <interface sztype="Ethernet" interfacename="GE" count="24" />
      </slot>
    </dev>
  </devices>
  <lines>
    <line srcDeviceID="R1-1" destDeviceID="SW1-2">
      <interfacePair lineName="Copper" srcIndex="1" srcBoundRectIsMoved="1" tarIndex="9" tarBoundRectIsMoved="1"/>
    </line>
  </lines>
</topo>`
  const { topology } = parseTopoXml(xml)
  const r1 = topology.nodes.find((n) => n.name === 'R1')
  assert.deepEqual(r1.interfaces, ['GE0/0/0', 'GE0/0/1', 'GE0/0/2']) // 路由器 0-based
  const sw1 = topology.nodes.find((n) => n.name === 'SW1')
  assert.equal(sw1.interfaces.length, 24)
  assert.equal(sw1.interfaces[0], 'GE0/0/1') // 交换机 1-based
  assert.equal(sw1.interfaces[9], 'GE0/0/10')

  const link = topology.links.find((l) => l.from === 'R1' && l.to === 'SW1')
  assert.equal(link.label, 'GE0/0/1 ↔ GE0/0/10') // R1 srcIndex=1 → GE0/0/1；SW1 tarIndex=9 → GE0/0/10
})

test('parseTopoXml：同端点对多条 interfacePair → label 全部合并不截断（并联链路标注）', () => {
  const xml = `<topo>
  <devices>
    <dev name="C1" model="S5700"><slot number="s"><interface interfacename="GE" count="24"/></slot></dev>
    <dev name="C2" model="S5700"><slot number="s"><interface interfacename="GE" count="24"/></slot></dev>
  </devices>
  <lines>
    <line srcDeviceID="C1" destDeviceID="C2">
      <interfacePair lineName="Copper" srcIndex="0" tarIndex="0"/>
      <interfacePair lineName="Copper" srcIndex="1" tarIndex="1"/>
      <interfacePair lineName="Copper" srcIndex="2" tarIndex="2"/>
    </line>
  </lines>
</topo>`
  const { topology, report } = parseTopoXml(xml)
  assert.equal(report.links, 1) // 同端点对去重为 1 条
  const link = topology.links[0]
  assert.equal(link.label, 'GE0/0/1 ↔ GE0/0/1 / GE0/0/2 ↔ GE0/0/2 / GE0/0/3 ↔ GE0/0/3') // 三对全保留，交换机从 1 起
})

test('parseTopoXml：旧版 interfacePair 自带 name 端点 + srcIndex/tarIndex → label', () => {
  const xml = `<topo>
  <devices>
    <dev name="AR1" model="AR2220"><slot><interface interfacename="GE" count="4"/></slot></dev>
    <dev name="SW1" model="S5700"><slot><interface interfacename="GE" count="24"/></slot></dev>
  </devices>
  <links>
    <interfacePair srcIndex="2" tarIndex="3"><fromdevice name="AR1"/><todevice name="SW1"/></interfacePair>
  </links>
</topo>`
  const { topology } = parseTopoXml(xml)
  const link = topology.links.find((l) => l.from === 'AR1' && l.to === 'SW1')
  assert.equal(link.label, 'GE0/0/2 ↔ GE0/0/4') // AR1 路由器 0-based；SW1 交换机 tarIndex=3 → GE0/0/4
})