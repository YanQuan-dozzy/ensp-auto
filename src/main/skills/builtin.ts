/**
 * 内置技能：首次启动预置到用户技能目录（参考 https://github.com/JWM0203/ensp-skills
 * 的 SKILL.md 约定移植，命令路径改写为本工作台的工具流）。
 *
 * 默认全部停用，由用户在「技能」面板勾选启用；内容随时可编辑/删除。
 */

export interface BuiltinSkillDef {
  id: string
  name: string
  description: string
  content: string
}

export const BUILTIN_SKILLS: readonly BuiltinSkillDef[] = [
  {
    id: 'ensp-config',
    name: '华为设备配置',
    description:
      '华为 VRP 设备的配置规范：接口类型/层级判断、Loopback 与 VLANIF 用法、保存与校验纪律。',
    content: `---
name: 华为设备配置
description: 华为 VRP 设备的配置规范：接口类型/层级判断、Loopback 与 VLANIF 用法、保存与校验纪律。
---

# 华为设备配置

配置 eNSP 中的华为 VRP 设备时，遵循以下规范。

## 接口类型判断
- AR201 等低端路由器：Ethernet 接口只有二层（不能配 IP），用 Loopback 或 VLAN + VLANIF 完成三层。
- AR2220 及更高型号：GigabitEthernet 0/0/x 支持三层，可直接配 IP。

## 常用配置模板

### 接口 IP
\`\`\`
interface GigabitEthernet 0/0/0
ip address 192.168.1.1 255.255.255.0
quit
\`\`\`

### Loopback（回环口，路由汇总/测试用）
\`\`\`
interface LoopBack 0
ip address 1.1.1.1 255.255.255.255
quit
\`\`\`

### VLAN + VLANIF
\`\`\`
vlan batch 10 to 20
interface GigabitEthernet 0/0/1
port link-type access
port default vlan 10
quit
interface Vlanif 10
ip address 192.168.10.1 255.255.255.0
quit
\`\`\`

### OSPF
\`\`\`
ospf 1
area 0
network 192.168.1.0 0.0.0.255
network 1.1.1.1 0.0.0.0
quit
quit
\`\`\`

## 执行纪律
1. 修改设备配置前先 save_config_snapshot 建立快照（硬性前提）。
2. 命令通过 apply_config 下发；只读查询用 run_show_command；视图切换（quit / return / 进接口视图）用 change_view。
3. 配置后用 verify_expectation / verify_ping 验证效果，不要只靠肉眼读回显。
4. 完成且确认无误后 save_configuration 保存到设备。
5. 设备回显是 GBK 编码，乱码不代表失败，先确认命令本身是否被设备接受。`
  },
  {
    id: 'ensp-topology',
    name: '拓扑实验流程',
    description:
      '标准实验流程：发现拓扑 → 连接设备 → 下发配置 → 验证 → 导出报告，四段式工作法。',
    content: `---
name: 拓扑实验流程
description: 标准实验流程：发现拓扑 → 连接设备 → 下发配置 → 验证 → 导出报告，四段式工作法。
---

# 拓扑实验流程

拿到一个网络实验目标时，按下面的阶段推进，避免跳跃式操作。

## 阶段 1：拓扑发现（只读）
- 先 list_devices / scan_devices 了解有哪些设备在线。
- 需要设备间关系时用 get_topology；必要时用 refresh_topology 从已连接设备实采；若用户明确要求导入外部工程，方可使用 import_topology_file。
- 这个阶段不改变任何设备状态。

## 阶段 2：设备连接
- 需要操作的目标设备必须已连接；未连接时用 connect_device 接入。
- 每台设备先用 get_device_context 一次拿全（型号/版本/视图/接口），不要逐条 display。

## 阶段 3：配置下发
- 改动前 save_config_snapshot，改动后按需 verify_expectation。
- 一台设备配置完成、验证通过后再动下一台，不要批量盲扫。
- 实验结束统一 save_configuration。

## 阶段 4：验证与报告
- 连通性用 verify_ping，聚合状态用 verify_connectivity，地址池用 verify_dhcp。
- 全部收敛后可 list_sessions / export_session_report 产出实验报告。`
  },
  {
    id: 'ip-planning',
    name: 'IP 地址规划',
    description:
      '实验网常用的地址规划约定：互联链路 10.0.XY.X/24、回环口 X.X.X.X/32，命名与端口对应关系。',
    content: `---
name: IP 地址规划
description: 实验网常用的地址规划约定：互联链路 10.0.XY.X/24、回环口 X.X.X.X/32。
---

# IP 地址规划

为多台设备互连设计地址时，采用以下惯例，保证可读性与可排查性。

## 互联链路
- 段内地址：10.0.AB.x/24，A、B 为相邻两台设备编号。
- 示例：R1–R2 之间用 10.0.12.0/24，R1 侧取 .1、R2 侧取 .2。

## 回环口（Loopback）
- 地址：X.X.X.X/32，X 为设备编号。
- 示例：R1 用 1.1.1.1/32，R2 用 2.2.2.2/32，R3 用 3.3.3.3/32。

## 落地建议
- 先给出地址规划再动手配，一条命令就是一个地址位点。
- OSPF/BGP 通告时用 network 精确宣告规划段，避免引入无关路由。
- 汇总表的展示格式：设备 | 接口 | IP/掩码 | 用途。`
  },
  {
    id: 'ensp-troubleshooting',
    name: 'eNSP 排障经验库',
    description:
      'eNSP 常见故障模式与避坑经验（GBK 乱码、连接被拒、VBox 僵尸进程、AP 慢启动、' +
      'WLAN 握手模拟器 bug、save 确认等），实验失败时先对照排查。',
    content: `---
name: eNSP 排障经验库
description: eNSP 常见故障模式与避坑经验（GBK 乱码、连接被拒、VBox 僵尸、AP 慢启动、WLAN 握手 bug、save 确认）。
---

# eNSP 排障经验库

实验失败时，先按下面的故障模式逐一对照，不要盲目重试同一命令。

## 连接被拒 / 设备连不上
- 先确认设备在 eNSP 中已启动（启动路由器/交换机/PC），未启动的端口无法建连。
- 端口映射从 2000 起，每台设备占一个端口；用 scan_devices 确认设备实际端口，不要凭记忆。
- 检查端口范围：默认只扫 2000-2050，设备超过范围就扫不到。
- 连上后回显乱码是 GBK 编码的正常现象，不代表失败；以命令是否被设备接受为准。

## PC 上的 PING 不通
- PC 的 IP/掩码/网关没配对，或 PC 处于关机状态。
- 网关所在接口没起来：先用 display interface brief 确认接口物理/协议双 up。
- 交换机端口没有配 access/trunk 放行对应 VLAN，VLANIF 三层地址没配。

## OSPF 邻居没起来（display ospf peer 无 Full）
- 只宣告了本端网段，没宣告对端网段或接口所在网段 —— 检查宣告是否覆盖互连链路。
- router-id 冲突或缺失：每台路由器要有唯一 router-id。
- 掩码/反掩码写错（wildcard = 反掩码，不是子网掩码）。

## DHCP 拿不到地址
- 服务器上必须 dhcp enable + ip pool + 网关接口 dhcp select global。
- PC/Access 侧接口要与地址池同网段；跨 VLAN 时做 DHCP Relay 或缺省网关。
- 用 verify_dhcp 核对地址池，用 display ip pool 看已用/冲突地址。

## 常见环境坑
- 保存到 startup 的 save 会停在 [Y/N] 确认上，用 save_configuration 工具获批后代答，不要手动猜。
- eNSP 偶尔会残留 VirtualBox 僵尸进程导致设备起不来：清掉再开机。
- AP 设备启动慢，DHCP 注册可能滞后几分钟；verify 时给足重试次数（times>1）。
- 模拟器对 WLAN 握手存在已知 bug（STA 无法 WPA 握手），数据层验证改用静态 IP + ping。

## 纪律
- 配置失败先看错误回显是「命令被拒」还是「执行超时」，两者处理完全不同。
- 不确定现状就先用只读工具（get_device_context / run_show_command / collect_device_diagnostics）取证，再动手。

## ACL / NAT 排障
- 规则下发顺序即匹配顺序：先显式 deny 再 allow，最后的 rule ... permit ip 兜底。
- ACL 只在「被接口引用后」才生效：nat outbound &lt;acl&gt;、traffic-filter inbound acl &lt;acl&gt; 缺一不可；只建 ACL 不引用等于没配。
- display acl all 看的是命中计数：长时间为 0 说明没流量进来或被前面规则吞掉。
- 内网 PC 上不了网：先查出口接口 display ip interface brief 物理/协议双 up；再看 display nat outbound 里 acl 号与接口是否对上；最后 display acl all 确认源网段被 permit。
- nat server 端口映射不生效：display nat server 查看公网/内网端口与地址；服务器网关要是出口设备；从公网侧 ping 服务器公网 IP（eNSP 用环回模拟公网时确认路由可达）。

## 链路聚合（Eth-Trunk）排障
- 成员接口必须先加进聚合组再谈带宽：interface GigabitEthernet0/0/x 下执行 eth-trunk N；聚合组要两端都建、编号一致。
- 成员口默认物理 down 正常：只有对端配好且线缆/链路 up 后 display eth-trunk 才显示 Up 成员。
- 手工聚合（manual）要求成员接口速率、双工一致且关闭自协商；lacp-static 需两端都配模式才能协商成功。
- 聚合组三层口配 IP 用 interface Eth-Trunk N，不要在每个成员口上配。

## VRRP 排障
- display vrrp 查看虚拟 IP、优先级、状态（Master/Backup/Initialize）；VRID 与接口要两端一致。
- 非抢占模式只有首次启动抢 Master；调试时两端都起后若仍不稳定，检查 priority 是否相差过小或配置了 mvrp 干扰。
- 网关冗余场景 PC 的网关必须填虚拟 IP（如 192.168.10.252），不能填某一台物理 IP。
- 主备各自 vlanif 同网段但 IP 不同是设计（不是冲突），Backup 端的 vlanif IP 只是本机三层地址。

## 静态路由 / RIP 不生效
- 先看 display ip routing-table 目标网段是否真的进表：Static 协议显示代表下发成功但未必可达；看 NextHop 与 Interface。
- Direct 网段缺失 = 接口没配 IP/没 up，先解决接口层，再谈路由。
- RIP 检查顺序：display rip 看版本（v1 不支持无类网段/掩码）→ display rip 1 interface 看宣告口 → display ip routing-table 看是否学到 RIP 路由；相邻路由器之间必须宣告互联网段，否则邻居学不到路由。
- 静态路由最常见错误：漏配回程路由（R2 去往 PC 网段却没配，ping 只能通一半）——排障时两端路由表对着看。`
  },
  {
    id: 'ensp-display-cheatsheet',
    name: 'display 命令速查',
    description:
      '华为 VRP 高频 `display` 命令速查：按场景（设备状态 / 接口 / 路由 / 路由协议 / 交换二层 / 可靠性 / 安全 / 排障顺序）给出排查该场景该先打哪条命令。',
    content: `---
name: display 命令速查
description: 华为 VRP 高频 display 命令速查：按场景选命令、按顺序排障。
---

# display 命令速查

核对设备状态时按下面的「场景 → 命令 → 看什么」查，避免逐条瞎打 display。

## 设备状态（通用）
- display version — 型号/VRP 版本/运行时长
- display cpu-usage / display memory-usage — 负载（长时间 >80% 需关注）
- display logbuffer — 最近日志（排障第一现场）
- display device — 硬件在位状态
- display current-configuration — 全量配置（改前取证用 get_device_context 更省 token）

## 接口
- display ip interface brief — 三层接口 IP/状态（最常用）
- display interface brief — 全接口物理/协议状态
- display interface GigabitEthernet0/0/x — 单口详情（错误计数/速率双工）
- display interface counters — 流量与错误统计

## 路由
- display ip routing-table — 路由表全文（先看目标网段在不在、协议/下一跳）
- display ip routing-table statistics — 路由数量汇总
- display fib — FIB 表（转发用表，与路由表对不上的才是真问题）

## 路由协议
- display ospf peer — OSPF 邻居（期望 Full）
- display ospf brief / display ospf interface — 进程/接口状态
- display rip 1 — RIP 进程与版本
- display rip 1 interface — RIP 宣告了哪些接口
- display bgp peer / display bgp routing-table — BGP 邻居与路由

## 交换二层
- display vlan — VLAN 与接口归属
- display port vlan — 全端口链路类型/VLAN
- display mac-address — MAC 表（查环：看到同一 MAC 在多口漂移即环路）
- display mac-address flapping record — MAC 漂移记录
- display arp — ARP 表（互通不通先看 ARP 学没学到）
- display stp brief — 生成树（端口角色/状态，环路口置 Blocking）
- display eth-trunk — 链路聚合组与成员状态

## 可靠性 / 隧道
- display vrrp — VRRP 主备状态（Master/Backup）
- display interface Eth-Trunk1 — 聚合口三层状态
- display bgp vpnv4 all routing-table / display ip vpn-instance — VPN 场景

## 安全
- display acl all — 全部 ACL 及命中计数（计数为 0 = 没流量命中）
- display nat outbound — Easy IP / 地址池出口映射
- display nat server — 端口映射表
- display nat session all — NAT 会话（有会话=转换生效）
- display firewall-statistics — 域间策略命中（USG 系）
- display current-configuration | include nat — 快速过滤 NAT 配置

## 排障顺序（黄金五连 + 定向）
1. display ip interface brief → 接口起来没有
2. display ip routing-table → 路由在不在
3. display arp → 二层学到没有
4. display logbuffer → 设备自己报了什么
5. display cpu-usage / display memory-usage → 是不是打满
之后按协议定向：OSPF 看 peer、RIP 看 rip 1、STP 看 stp brief、VRRP 看 vrrp、聚合看 eth-trunk。`
  },
  {
    id: 'ensp-lab-authoring',
    name: '实验教学设计',
    description:
      '备课流水线（参照 JWM0203/ensp-skills 的 ensp-lab-authoring）：裸 .topo 也能整场实验' +
      ' —— 纸上设计 → 环境预检 → 部署 → 验证调试 → 产出教程文档。',
    content: `---
name: 实验教学设计
description: 备课流水线（参照 JWM0203/ensp-skills）：裸 .topo 也能整场实验 —— 纸上设计 → 环境预检 → 部署 → 验证调试 → 产出教程。
---

# 实验教学设计（备课流水线）

拿到一个只有 .topo、没有教程的实验环境时，按五阶段推进，先设计后部署，全程可回滚可验证。

## 阶段 1：纸上设计（只读）
- 用 get_topology 查看当前拓扑，必要时用 refresh_topology 还原已连接设备拓扑。
- 按 ip-planning 技能约定设计地址规划（互联 10.0.AB.x/24、loopback X.X.X.X/32）。
- 明确实验目标 → 拆成每台设备要做的配置块，先写规划表，再动任何设备。

## 阶段 2：环境预检
- scan_devices + connect_device 接入全部设备；用 get_device_context 一次拿全现状。
- 用 verify_connectivity 检查接口物理/协议状态，确认链路已拉起再开始配置。

## 阶段 3：部署
- 优先整类任务用 execute_task（ospf / vlan / dhcp）一键下发；跨设备任务用 batch_configure。
- 单点改造用 apply_config；每台设备改动前先 save_config_snapshot，改动后按需 verify_expectation。
- 一台一验：一台收敛后再动下一台，不要整场盲扫。

## 阶段 4：验证与调试
- 路由/协议用 verify_expectation（display ospf peer=Full 等），连通性用 verify_ping。
- 失败先对照 ensp-troubleshooting 排障经验库，再决定修配置还是查环境。

## 阶段 5：产出教程
- 全部收敛后 save_configuration 保存，用 export_lab_guide 生成教学设计文档（目标/拓扑/IP 规划/配置步骤/验证清单）。
- 最后可用 export_session_report 导出本次实验完整过程留档。`
  },
  {
    id: 'ensp-ipv6',
    name: 'IPv6 配置与排障',
    description:
      '华为 VRP 的 IPv6 配置规范：使能层次、静态地址与 SLAAC / DHCPv6 自动配置、' +
      'IPv6 静态路由 / RIPng / OSPFv3、验证命令与 eNSP 常见坑。',
    content: `---
name: IPv6 配置与排障
description: 华为 VRP 的 IPv6 配置规范：使能层次、地址与自动配置、静态路由 / RIPng / OSPFv3、验证与排障。
---

# IPv6 配置与排障

IPv6 实验的失败大多来自「少使能一层」：全局没 \`ipv6\`、接口没 \`ipv6 enable\`、协议没配
router-id。按下面顺序推进，每步验证过再往下走。

## 使能层次（缺一层就全废）
1. 全局 \`ipv6\` —— 使能 IPv6 单播转发；不配则接口的 ipv6 enable / ipv6 address 直接报错。
2. 接口 \`ipv6 enable\` —— 每个要跑 IPv6 的接口（含 Vlanif / LoopBack / Tunnel）都要配。
3. 地址 \`ipv6 address <地址> <前缀长度>\` —— 只配地址不 enable 接口，地址不生效。

## 地址配置

### 静态地址
\`\`\`
interface GigabitEthernet 0/0/1
ipv6 enable
ipv6 address 2001:db8:12::1 64
quit
\`\`\`

### Loopback（路由标识 / 测试用，一般 /128）
\`\`\`
interface LoopBack 0
ipv6 enable
ipv6 address 2001:db8::1 128
quit
\`\`\`

### VLANIF 三层网关
\`\`\`
vlan batch 10
interface Vlanif 10
ipv6 enable
ipv6 address 2001:db8:10::1 64
quit
\`\`\`

- 链路本地地址（fe80::/10）随 ipv6 enable 自动生成，OSPFv3 / RIPng 邻居靠它建立，不用手配。
- 需要由 MAC 扩展生成接口 ID 时：\`ipv6 address 2001:db8:1:: 64 eui-64\`。

## 地址自动配置

### SLAAC（无状态，靠 RA 下发前缀）
华为路由器**缺省抑制 RA**，服务端必须显式打开，否则终端拿不到前缀：
\`\`\`
interface GigabitEthernet 0/0/2
ipv6 enable
ipv6 address 2001:db8:14::1 64
undo ipv6 nd ra halt
quit
\`\`\`
终端侧（用路由器模拟）自动取地址并学默认路由：\`ipv6 address auto global default\`。

### DHCPv6（有状态）
服务器：
\`\`\`
ipv6
dhcp enable
dhcpv6 pool v6pc
address prefix 2001:db8:10::/64
excluded-address 2001:db8:10::1
dns-server 2001:db8:10::1
quit
interface Vlanif 10
ipv6 enable
ipv6 address 2001:db8:10::1 64
dhcpv6 server v6pc
undo ipv6 nd ra halt
ipv6 nd autoconfig managed-address-flag
quit
\`\`\`
managed-address-flag 让终端走 DHCPv6 取地址（只开 RA 会走 SLAAC 拿不到池里的地址）。
跨网段时由网关设备做中继，接口指向服务器全局地址：
\`\`\`
interface Vlanif 20
ipv6 enable
ipv6 address 2001:db8:20::1 64
dhcpv6 relay destination 2001:db8:12::2
quit
\`\`\`
终端侧：\`ipv6 address auto dhcp\`（eNSP 的 PC 则在 IPv6 配置页选 DHCPv6 模式）。

## 路由

### 静态路由
\`\`\`
ipv6 route-static 2001:db8:23:: 64 2001:db8:12::2
ipv6 route-static :: 0 2001:db8:12::2
\`\`\`
第二行是默认路由。目的必须写「前缀 + 前缀长度」，只写地址会被拒。
IPv6 路由表与 IPv4 路由表**互相独立** —— v4 通不代表 v6 通，必须单独查证。

### RIPng
\`\`\`
ripng 1
quit
interface GigabitEthernet 0/0/0
ipv6 enable
ripng 1 enable
quit
\`\`\`
进程与接口两侧都要使能，缺一个就不收 / 不发更新。

### OSPFv3
\`\`\`
ospfv3 1
router-id 1.1.1.1
quit
interface GigabitEthernet 0/0/0
ipv6 enable
ipv6 address 2001:db8:12::1 64
ospfv3 1 area 0
quit
\`\`\`
- OSPFv3 的 router-id **必须手工配置**，不会从接口地址自动选举；每台路由器唯一且非 0。
- 接口用 \`ospfv3 <进程号> area <区域号>\` 使能，没有 OSPFv2 的 network 宣告步骤，宣告范围由接口网段决定。

## 验证命令
- display ipv6 interface brief —— 接口 IPv6 地址与物理 / 协议状态（最常用）
- display ipv6 routing-table —— IPv6 路由表（看 Direct / Static / 协议路由）
- display ipv6 neighbors —— ND 邻居表（二层可达性，对标 display arp）
- display ospfv3 1 peer —— OSPFv3 邻居（期望 Full）
- display ripng 1 neighbor / display ripng 1 route —— RIPng 邻居与学到的路由
- ping ipv6 <目的地址> / ping ipv6 -a <源地址> <目的地址> —— 连通性（PC 上直接 ping 地址）
- tracert ipv6 <目的地址> —— 逐跳定位断点

## eNSP 常见坑
- **本工作台的 verify_ping 只认 IPv4**：目标传 IPv6 地址会被直接拒绝。IPv6 连通性改用
  run_show_command 下发 \`ping ipv6 ...\`，自己读丢包率（0% 即通）。
- **RA 默认不发**：只配了地址、没 \`undo ipv6 nd ra halt\`，终端永远拿不到前缀，表现为「PC 没地址」。
- **OSPFv3 没 router-id 就不运行**：与 OSPFv2 不同，这是启动硬前提。
- **全局 ipv6 忘开**：接口下敲 ipv6 enable / ipv6 address 会报错或不生效，先补全局。
- **设备型号**：低端型号（如 AR201）对 IPv6 支持受限，IPv6 实验建议用 AR2220 及以上。
- **拿到地址但 ping 不通**：先 display ipv6 neighbors 看 ND 有没有学到对端，再查回程路由 ——
  IPv6 静态路由同样要两端都配，只配去程只能通一半。
- 回显乱码是 GBK 编码的正常现象，以命令是否被设备接受为准。

## 地址规划约定（与 ip-planning 技能对齐）
- 互联链路：2001:db8:AB::/64，A / B 为相邻设备编号；A 侧取 ::1、B 侧取 ::2。
- 回环口：2001:db8::X/128，X 为设备编号。
- 业务网段：2001:db8:X::/64（X 为 VLAN 号），网关取 ::1。
- 统一使用文档保留前缀 2001:db8::/32，避免与真实公网地址语义混淆。`
  }
]