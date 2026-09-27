/**
 * VRP 命令知识库（F1，2026-09-26）—— 内置离线命令事实词典。
 *
 * 为什么要有它：VRP 命令幻觉是 agent 类工具最大的失败源 —— 模型靠「记忆」编命令时
 * 会把反掩码写成子网掩码、把 network 写成接口地址。词典把「合法语法 / 参数 / 示例 /
 * 易错点」结构化后供 `lookup_vrp_command` 返回，让模型**先查证再下发**。
 *
 * 与 `run_show_command` 的白名单（shared/risk.ts）正交：这里不碰设备，纯本地数据。
 * 纯数据 + 纯函数，不依赖 Electron，可直接进 harness 测试。
 *
 * 口径与 `skills/builtin.ts` 的 ip-planning / ensp-config / ensp-ipv6 / ensp-troubleshooting 保持一致；
 * 用户可在技能模块导入「企业级命令手册」补充覆盖（F1 的设计：词典可作为技能分发）。
 */

export interface VrpCommandFact {
  /** 合法语法（占位符用 <> 或 [] 标注可选） */
  syntax: string
  description: string
  /** 典型示例（可直接照抄的写法） */
  example?: string
}

export interface VrpTopicEntry {
  /** 主题 id（查询的主键之一） */
  id: string
  title: string
  /** 别名/关键词：中英文都收，匹配时参与模糊命中 */
  aliases: string[]
  summary: string
  commands: VrpCommandFact[]
  /** 易错点 —— 防幻觉的核心：每个都是真实发生过的翻车模式 */
  pitfalls: string[]
}

export const VRP_TOPICS: readonly VrpTopicEntry[] = [
  {
    id: 'ospf',
    title: 'OSPF 动态路由',
    aliases: ['ospf', '开放式最短路径优先', '动态路由', '路由协议ospf'],
    summary: '链路状态路由协议。流程：起进程（router-id）→ 进区域 → network 宣告网段（反掩码）。',
    commands: [
      {
        syntax: 'ospf <process-id> [router-id <id>]',
        description: '进入 OSPF 进程视图；router-id 缺省自动选举，多进程实验建议显式指定',
        example: 'ospf 1 router-id 1.1.1.1'
      },
      {
        syntax: 'area <area-id>',
        description: '进入区域视图（单区域实验统一 area 0.0.0.0）',
        example: 'area 0.0.0.0'
      },
      {
        syntax: 'network <网段> <反掩码>',
        description: '宣告网段。第二参数是反掩码（wildcard），不是子网掩码；精确宣告接口所在网段',
        example: 'network 10.0.12.0 0.0.0.255'
      },
      {
        syntax: 'silent-interface <接口>',
        description: '抑制该接口收发 Hello（连 PC/终端的口不参与邻居），仍会宣告该网段',
        example: 'silent-interface GigabitEthernet 0/0/2'
      },
      {
        syntax: 'default-route-advertise [always]',
        description: '在 ASBR 上向区域内下发默认路由；always 表示自己没有默认路由也下发',
        example: 'default-route-advertise'
      },
      {
        syntax: 'display ospf peer [brief]',
        description: '查邻居状态；收敛完成的判据是邻居状态 Full',
        example: 'display ospf peer brief'
      },
      {
        syntax: 'display ospf [process-id] routing',
        description: '查 OSPF 学到的路由',
        example: 'display ospf routing'
      }
    ],
    pitfalls: [
      'network 的第二个参数是反掩码 0.0.0.255，写成子网掩码 255.255.255.0 会直接报错',
      '只宣告了本端接口网段、漏了对端方向，邻居起不来 —— 宣告必须覆盖互连链路两侧',
      '两台路由器 router-id 相同会冲突，邻居震荡',
      'wildcard 反推口诀：255.255.255.0 的反掩码是 0.0.0.255（逐字节 255-x）',
      '邻居卡在 ExStart/Exchange 多为 MTU 不匹配或接口两端地址不在同一网段'
    ]
  },
  {
    id: 'vlan',
    title: 'VLAN 与端口划分',
    aliases: ['vlan', '交换', 'access', 'trunk', '端口划分', '虚拟局域网'],
    summary: 'vlan batch 建 VLAN → 端口按 access/trunk 划分 → 三层网关用 vlanif。',
    commands: [
      {
        syntax: 'vlan batch <id> [to <id>]',
        description: '批量创建 VLAN',
        example: 'vlan batch 10 20'
      },
      {
        syntax: 'port link-type access',
        description: '接口划为 access（接 PC / 终端）',
        example: 'port link-type access'
      },
      {
        syntax: 'port default vlan <id>',
        description: 'access 口的 PVID',
        example: 'port default vlan 10'
      },
      {
        syntax: 'port link-type trunk',
        description: '接口划为 trunk（交换机之间的级联口）',
        example: 'port link-type trunk'
      },
      {
        syntax: 'port trunk allow-pass vlan <id列表>',
        description: 'trunk 口放行的 VLAN 列表；不放行等于不通',
        example: 'port trunk allow-pass vlan 10 20'
      },
      {
        syntax: 'interface Vlanif <id> → ip address <ip> <掩码>',
        description: 'VLAN 三层网关接口；先 vlan batch 建了 VLAN 才能配 vlanif',
        example: 'interface Vlanif 10 → ip address 192.168.10.1 24'
      },
      {
        syntax: 'display vlan [简要]',
        description: '查 VLAN 与端口归属',
        example: 'display vlan'
      },
      {
        syntax: 'display port vlan [active]',
        description: '查端口的 VLAN 划分与放行情况',
        example: 'display port vlan active'
      }
    ],
    pitfalls: [
      'trunk 口忘配 allow-pass，对端 VLAN 流量直接不通 —— 这是 VLAN 实验第一大错',
      '两端链路类型不一致（一端 access 一端 trunk）协商失败',
      'VLANIF 配了地址但对应 VLAN 没建、或没有端口划入该 VLAN，接口起不来',
      'access 口接交换机级联会导致跨交换机同 VLAN 不通（级联应 trunk）'
    ]
  },
  {
    id: 'dhcp',
    title: 'DHCP 地址分配',
    aliases: ['dhcp', '地址池', '自动分配地址', '动态主机配置'],
    summary: 'dhcp enable → ip pool（网段/网关/DNS）→ 网关接口 dhcp select global。',
    commands: [
      {
        syntax: 'dhcp enable',
        description: '全局开 DHCP（必须先开，否则后面全报错）',
        example: 'dhcp enable'
      },
      {
        syntax: 'ip pool <名称>',
        description: '创建全局地址池并进入',
        example: 'ip pool vlan10'
      },
      {
        syntax: 'network <网段> mask <掩码>',
        description: '地址池网段（须与网关接口同网段）',
        example: 'network 192.168.10.0 mask 255.255.255.0'
      },
      {
        syntax: 'gateway-list <ip>',
        description: '下发给客户端的网关（通常就是本机 vlanif 地址）',
        example: 'gateway-list 192.168.10.1'
      },
      {
        syntax: 'dns-list <dns>',
        description: '下发 DNS',
        example: 'dns-list 223.5.5.5'
      },
      {
        syntax: 'excluded-ip-address <起> <止>',
        description: '排除不参与分配的地址段',
        example: 'excluded-ip-address 192.168.10.250 192.168.10.254'
      },
      {
        syntax: 'interface 视图：dhcp select global',
        description: '网关接口启用全局地址池模式（漏了这步客户端拿不到地址）',
        example: 'interface Vlanif 10 → dhcp select global'
      },
      {
        syntax: 'display ip pool [name <名称> [used]]',
        description: '查地址池与已分配情况',
        example: 'display ip pool name vlan10 used'
      }
    ],
    pitfalls: [
      '忘 dhcp enable：ip pool 都建不了',
      '地址池网段与网关接口不在同一网段 → 客户端拿不到地址',
      '接口漏 dhcp select global（接口视图下执行，不是全局视图）',
      '跨三层中继要用 dhcp select relay + dhcp relay server-ip，全局池模式不会自动穿网段',
      'PC 验证拿地址前确认已开机、接口已启用'
    ]
  },
  {
    id: 'acl',
    title: 'ACL 访问控制',
    aliases: ['acl', '访问控制', 'traffic-filter', '过滤'],
    summary: 'acl number 定义规则（反掩码）→ 接口 traffic-filter 应用。规则自上而下先命中先生效。',
    commands: [
      {
        syntax: 'acl <2000-2999>',
        description: '基本 ACL（只匹配源地址）',
        example: 'acl 2000'
      },
      {
        syntax: 'acl <3000-3999>',
        description: '高级 ACL（可匹配源/目的/协议/端口）',
        example: 'acl 3000'
      },
      {
        syntax: 'rule [<序号>] permit|deny source <源> <反掩码>',
        description: '基本 ACL 规则；第二参数是反掩码',
        example: 'rule 5 permit source 192.168.1.0 0.0.0.255'
      },
      {
        syntax: 'rule [<序号>] permit|deny <协议> source <源> <反掩码> destination <目的> <反掩码> [destination-port eq <端口>]',
        description: '高级 ACL 规则',
        example: 'rule 5 deny tcp source 192.168.1.0 0.0.0.255 destination 10.0.0.2 0.0.0.0 destination-port eq 80'
      },
      {
        syntax: '接口视图：traffic-filter inbound|outbound acl <编号>',
        description: '在接口应用 ACL（inbound=进入本接口方向的流量）',
        example: 'traffic-filter inbound acl 3000'
      },
      {
        syntax: 'display acl <编号>',
        description: '查 ACL 规则与命中计数',
        example: 'display acl 3000'
      }
    ],
    pitfalls: [
      '规则顺序敏感：自上而下先命中先生效，宽的 permit 放前面会把 deny 全短路',
      '反掩码错写 255.255.255.0（应为 0.0.0.255）是最常见翻车点',
      'traffic-filter 方向想反（本机发起的流量在 inbound 上过滤不到）',
      '基本 ACL 尽量靠近目的应用，避免误伤中间路径流量'
    ]
  },
  {
    id: 'nat',
    title: 'NAT 地址转换',
    aliases: ['nat', '地址转换', 'easy ip', '端口映射', 'nat server'],
    summary: 'Easy IP（nat outbound 引用 ACL）做上网；nat server 做端口映射。都配在**出接口**。',
    commands: [
      {
        syntax: 'acl 编号 → rule permit source <内网网段> <反掩码>',
        description: '先定义「允许转换的内网范围」',
        example: 'acl 2000 → rule 5 permit source 192.168.1.0 0.0.0.255'
      },
      {
        syntax: '出接口视图：nat outbound <acl编号>',
        description: 'Easy IP：转换后地址取接口自身 IP',
        example: 'nat outbound 2000'
      },
      {
        syntax: 'nat outbound <acl编号> address-group <组号>',
        description: 'NAPT：引用地址组（需先 nat address-group）',
        example: 'nat outbound 2000 address-group 1'
      },
      {
        syntax: '出接口视图：nat server protocol tcp global <全局端口> inside <内网ip> <内网端口>',
        description: '端口映射（外网访问全局端口 → 转发到内网服务）',
        example: 'nat server protocol tcp global current-interface 8080 inside 192.168.1.100 80'
      },
      {
        syntax: 'display nat session all',
        description: '查 NAT 会话表',
        example: 'display nat session all'
      }
    ],
    pitfalls: [
      'nat outbound / nat server 必须配在**出接口**（公网方向那个口），配错方向不生效',
      'Easy IP 引用的 ACL 必须先建好且 source 覆盖内网网段',
      'nat server 的全局地址写 current-interface 才跟随接口地址（实验网常用）',
      '验证时从外网侧发起访问，从内网侧 ping 公网侧不代表映射成功'
    ]
  },
  {
    id: 'static_route',
    title: '静态路由',
    aliases: ['static route', '静态路由', 'route-static', '默认路由'],
    summary: 'ip route-static 目的网段 掩码 下一跳。默认路由目的写 0.0.0.0 0。',
    commands: [
      {
        syntax: 'ip route-static <目的网段> <掩码> <下一跳ip>',
        description: '基本静态路由；掩码可写点分十进制或前缀长度',
        example: 'ip route-static 10.0.30.0 255.255.255.0 10.0.12.2'
      },
      {
        syntax: 'ip route-static 0.0.0.0 0 <下一跳ip>',
        description: '默认路由（缺省路由）',
        example: 'ip route-static 0.0.0.0 0 10.0.12.2'
      },
      {
        syntax: 'ip route-static <目的> <掩码> <下一跳> preference <值>',
        description: '浮动静态路由：值越大优先级越低（缺省 60），做备份链路给大值',
        example: 'ip route-static 10.0.30.0 24 10.0.12.2 preference 100'
      },
      {
        syntax: 'display ip routing-table',
        description: '查路由表（确认静态路由是否已生效）',
        example: 'display ip routing-table'
      }
    ],
    pitfalls: [
      '下一跳地址必须**直连可达**，且本机要有到下一跳的路由（互联段要通）',
      '目的网段掩码写错（写了主机位）导致路由不精确或不生效',
      '双向都要有路由：只配去程不配回程，ping 依然不通',
      '浮动路由 priority 值越大越**劣**，别把主用链路写成 100'
    ]
  },
  {
    id: 'rip',
    title: 'RIP 动态路由',
    aliases: ['rip', '路由信息协议'],
    summary: 'rip 进程 → version 2 → network 宣告（**主类网段**，不带掩码）。',
    commands: [
      {
        syntax: 'rip [<进程号>]',
        description: '进入 RIP 进程',
        example: 'rip 1'
      },
      {
        syntax: 'version 2',
        description: '切 v2（v1 是有类协议，实验统一用 2）',
        example: 'version 2'
      },
      {
        syntax: 'network <主类网段>',
        description: '宣告网段。RIP 只认**主类**网络号：10.0.12.0 应写 10.0.0.0',
        example: 'network 10.0.0.0'
      },
      {
        syntax: 'display rip [<进程号>]',
        description: '查 RIP 进程与邻居',
        example: 'display rip 1'
      },
      {
        syntax: 'display ip routing-table protocol rip',
        description: '只看 RIP 学到的路由',
        example: 'display ip routing-table protocol rip'
      }
    ],
    pitfalls: [
      'network 写了带掩码的子网（RIP 按主类收，10.0.12.0 会被解析成 10.0.0.0）',
      '忘 version 2 时 v1 不带掩码，跨网段路由学不出来',
      'RIP 邻居两端版本不一致收不到更新'
    ]
  },
  {
    id: 'eth_trunk',
    title: 'Eth-Trunk 链路聚合',
    aliases: ['eth-trunk', '链路聚合', 'ethtrunk', 'lacp'],
    summary: '建 Eth-Trunk 口 → 选模式（manual / lacp-static）→ 成员口加入。先聚合后物理口配置。',
    commands: [
      {
        syntax: 'interface Eth-Trunk <编号>',
        description: '创建聚合口并进入',
        example: 'interface Eth-Trunk 1'
      },
      {
        syntax: 'mode manual load-balance | mode lacp-static',
        description: '聚合模式；两端必须一致，否则聚合不成立',
        example: 'mode lacp-static'
      },
      {
        syntax: 'trunkport <接口类型> <起始槽位/端口> [to <结束>] 或成员口视图 eth-trunk <编号>',
        description: '把物理口加入聚合组',
        example: 'trunkport gigabitethernet 0/0/9 to 0/0/10'
      },
      {
        syntax: 'display eth-trunk [<编号>]',
        description: '查聚合口状态与成员口',
        example: 'display eth-trunk 1'
      }
    ],
    pitfalls: [
      '成员口必须先清干净配置（地址/类型/放行 VLAN）才能加入聚合组',
      '两端 mode 不一致（一端 manual 一端 lacp-static）聚合不成立',
      '业务配置（trunk 放行 VLAN / IP 地址）应配在 Eth-Trunk 口上，不是成员口',
      '成员口聚合前被 shutdown 会导致成员 down，先 undo shutdown'
    ]
  },
  {
    id: 'interface',
    title: '接口基础配置',
    aliases: ['interface', '接口', 'ip address', '端口配置', 'shutdown'],
    summary: 'interface 进接口 → ip address 配地址（掩码可写 24）→ undo shutdown 恢复关闭的口。',
    commands: [
      {
        syntax: 'interface <接口名>',
        description: '进入接口视图；接口名如 GigabitEthernet 0/0/1（简写 g0/0/1 也可）',
        example: 'interface GigabitEthernet 0/0/1'
      },
      {
        syntax: 'ip address <ip> <掩码或前缀长度>',
        description: '配接口地址；24 与 255.255.255.0 等价',
        example: 'ip address 10.0.12.1 24'
      },
      {
        syntax: 'undo shutdown',
        description: '恢复被手动关闭的接口（eNSP 的以太口默认开启，只有手动 shutdown 过才需要）',
        example: 'undo shutdown'
      },
      {
        syntax: 'description <说明>',
        description: '接口描述（规划表落地，排障时一眼看清对端）',
        example: 'description to-R2_GE0/0/0'
      },
      {
        syntax: 'display interface [<接口名>] brief',
        description: '查接口物理/协议双 up 状态与地址',
        example: 'display interface brief'
      },
      {
        syntax: 'display this',
        description: '看当前视图已配了什么（改错前先看现状）',
        example: 'display this'
      }
    ],
    pitfalls: [
      '接口 down 先查物理连线与对端，再查是否被 shutdown（display interface brief 看 physical/protocol 两列）',
      '掩码写法混用（先 24 后 255.255.255.0）没问题，但同一接口重复配地址会顶掉旧地址',
      'interface 后面接口名写错（拼错槽位）会新建一个不存在的逻辑视图而不报错 —— 配完用 display this 核对'
    ]
  },
  {
    id: 'basics',
    title: '系统基础操作',
    aliases: ['basics', '基础', 'system-view', '保存', 'display current', 'sysname', 'save', '视图'],
    summary: 'system-view 进配置视图 → 配置 → save 落盘。配置不 save 重启即丢。',
    commands: [
      {
        syntax: 'system-view',
        description: '从用户视图进入系统视图（配置命令都在这里）',
        example: 'system-view'
      },
      {
        syntax: 'sysname <名称>',
        description: '改设备名（提示符即时变化）',
        example: 'sysname Core-SW1'
      },
      {
        syntax: 'quit / return',
        description: 'quit 退一层，return 直接回用户视图',
        example: 'return'
      },
      {
        syntax: 'display current-configuration',
        description: '看当前运行配置（缩写 dis cu）',
        example: 'display current-configuration'
      },
      {
        syntax: 'save',
        description: '保存到 startup 配置；会停在 [Y/N]，应用内必须走 save_configuration 工具代答',
        example: 'save'
      },
      {
        syntax: 'display saved-configuration',
        description: '看已保存的 startup 配置（对比 current 判断是否漏 save）',
        example: 'display saved-configuration'
      }
    ],
    pitfalls: [
      '配置改完不 save，设备重启全丢 —— 实验收尾统一 save_configuration',
      'save 停在 [Y/N] 上属于危险提示，不能自动答 y（走 answer_device_prompt）',
      '用户视图敲配置命令会报错（Error: Unrecognized command），先 system-view'
    ]
  },
  {
    id: 'troubleshoot',
    title: '连通性与排障命令',
    aliases: ['troubleshoot', '排障', 'ping', 'tracert', '路由表', 'arp', 'mac'],
    summary: 'ping 通不通 → tracert 卡在哪跳 → 路由表有没有路 → 接口/ARP/MAC 逐层查。',
    commands: [
      {
        syntax: 'ping [-a <源ip>] <目的ip>',
        description: '连通性测试；-a 指定源（多网段实验必带，否则走默认源）',
        example: 'ping -a 1.1.1.1 3.3.3.3'
      },
      {
        syntax: 'tracert <目的ip>',
        description: '逐跳跟踪，定位断在哪一跳',
        example: 'tracert 10.0.30.1'
      },
      {
        syntax: 'display ip routing-table [目的ip]',
        description: '查路由表命中（有无去程/回程路由）',
        example: 'display ip routing-table 10.0.30.0'
      },
      {
        syntax: 'display arp [all | interface <接口>]',
        description: '查 ARP 表（二层可达性）',
        example: 'display arp all'
      },
      {
        syntax: 'display mac-address [dynamic]',
        description: '查 MAC 表（交换网络排障）',
        example: 'display mac-address dynamic'
      }
    ],
    pitfalls: [
      'ping 不通先查两端接口双 up（display interface brief），再查路由表有无去程+回程',
      '多网段场景 ping 不带 -a，源地址可能不是你以为的那个',
      'PC 网关没配 / 掩码错，表现为「同网段通、跨网段断」'
    ]
  },
  {
    id: 'ipv6',
    title: 'IPv6 基础与路由',
    aliases: [
      'ipv6',
      'ipv6地址',
      'ipv6配置',
      'ipv6静态路由',
      'ospfv3',
      'ripng',
      'dhcpv6',
      'slaac',
      '无状态自动配置',
      'nd ra halt'
    ],
    summary:
      '三层使能：全局 ipv6 → 接口 ipv6 enable → 配地址。路由与 IPv4 完全独立：' +
      'ipv6 route-static / RIPng / OSPFv3（router-id 必须手工配置）。',
    commands: [
      {
        syntax: 'ipv6',
        description: '系统视图：使能 IPv6 单播转发（接口所有 IPv6 配置的前提）',
        example: 'ipv6'
      },
      {
        syntax: '接口视图：ipv6 enable',
        description: '接口使能 IPv6（含 Vlanif / LoopBack）；漏配则地址不生效',
        example: 'interface GigabitEthernet 0/0/0 → ipv6 enable'
      },
      {
        syntax: 'ipv6 address <地址> <前缀长度>',
        description: '接口静态 IPv6 地址；接口 ID 由 MAC 扩展时追加 eui-64',
        example: 'ipv6 address 2001:db8:12::1 64'
      },
      {
        syntax: 'ipv6 address auto global [default] | ipv6 address auto dhcp',
        description: '终端侧自动配置：SLAAC 取全局地址（default 同时学默认路由）或 DHCPv6 取地址',
        example: 'ipv6 address auto global default'
      },
      {
        syntax: '接口视图：undo ipv6 nd ra halt',
        description: '打开 RA 通告。华为缺省抑制 RA，不开则终端拿不到前缀',
        example: 'undo ipv6 nd ra halt'
      },
      {
        syntax: 'ipv6 route-static <目的前缀> <前缀长度> <下一跳地址>',
        description: 'IPv6 静态路由；默认路由目的写 :: 0',
        example: 'ipv6 route-static 2001:db8:23:: 64 2001:db8:12::2'
      },
      {
        syntax: 'ospfv3 <进程号> → router-id <a.b.c.d> → 接口视图：ospfv3 <进程号> area <区域号>',
        description: 'OSPFv3：router-id 必须手工配置，接口上使能（无 network 宣告步骤）',
        example: 'ospfv3 1 → router-id 1.1.1.1 → interface g0/0/0 → ospfv3 1 area 0'
      },
      {
        syntax: 'ripng <进程号> → 接口视图：ripng <进程号> enable',
        description: 'RIPng：进程与接口两侧都要 enable，缺一个就不收/不发更新',
        example: 'ripng 1 → interface g0/0/0 → ripng 1 enable'
      },
      {
        syntax: 'dhcpv6 pool <名称> → address prefix <前缀>/<长度> → 接口视图：dhcpv6 server <池名>',
        description: 'DHCPv6 服务器；跨网段时网关接口用 dhcpv6 relay destination <服务器地址>',
        example: 'dhcpv6 pool v6pc → address prefix 2001:db8:10::/64 → dhcpv6 server v6pc'
      },
      {
        syntax: 'display ipv6 interface brief | display ipv6 routing-table | display ipv6 neighbors',
        description: '查接口地址/状态、IPv6 路由表、ND 邻居表（对标 display arp）',
        example: 'display ipv6 interface brief'
      },
      {
        syntax: 'ping ipv6 <目的地址> / ping ipv6 -a <源地址> <目的地址>',
        description: 'IPv6 连通性测试（PC 上直接 ping <地址>）',
        example: 'ping ipv6 -a 2001:db8:12::1 2001:db8:23::3'
      }
    ],
    pitfalls: [
      '全局没敲 ipv6：接口下的 ipv6 enable / ipv6 address 直接报错 —— 三层使能缺一层全废',
      '接口漏 ipv6 enable：地址配上了也不生效，display ipv6 interface brief 看不到',
      'OSPFv3 不配 router-id 进程就不运行（与 OSPFv2 不同，它不会从接口地址自动选）',
      '华为路由器缺省抑制 RA：终端要 SLAAC 就必须在服务端接口 undo ipv6 nd ra halt，否则永远没地址',
      'IPv6 路由表与 IPv4 完全独立：v4 通 ≠ v6 通，排障要看 display ipv6 routing-table',
      '静态路由目的必须写「前缀 + 前缀长度」（2001:db8:23:: 64），只写地址会被拒；且两端都要配回程',
      '拿 fe80:: 链路本地地址做静态路由下一跳时必须同时指定出接口，实验里直接用对端全局地址更省事',
      '本工作台的 verify_ping 只接受 IPv4 目标（IPv6 会被 BAD_PARAM 拒绝），IPv6 连通性改用 run_show_command 下发 ping ipv6'
    ]
  }
]

/**
 * 归一化查询词：小写、去空格/下划线/连字符。
 * 让 "Static-Route" / "static_route" / "静态路由" 命中同一主题。
 */
function normalizeTopic(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]+/g, '')
}

/** 归一化后的别名集（含 id），预计算避免每次查询重复正则 */
const INDEXED_TOPICS: Array<{ entry: VrpTopicEntry; keys: string[] }> = VRP_TOPICS.map((entry) => ({
  entry,
  keys: [normalizeTopic(entry.id), ...entry.aliases.map(normalizeTopic)]
}))

export interface LookupOutcome {
  matched: boolean
  /** 命中的主题（matched=false 时为 undefined） */
  entry?: VrpTopicEntry
  /** 未命中时给模型看可用主题清单 */
  available?: Array<{ id: string; title: string; aliases: string[] }>
}

/**
 * 主题查询：精确命中（id/别名）→ 关键词包含（查询词是别名的子串，或别名是查询词的子串）。
 * 两级都失败时返回可用清单，让模型换个词重查，而不是空手而归。
 */
export function lookupVrpTopic(rawTopic: string): LookupOutcome {
  const q = normalizeTopic(rawTopic)
  if (!q) return { matched: false, available: listTopics() }
  // 1) 精确
  for (const { entry, keys } of INDEXED_TOPICS) {
    if (keys.includes(q)) return { matched: true, entry }
  }
  // 2) 包含（查询词较长时匹配别名子串；别名较长时匹配查询词子串）
  for (const { entry, keys } of INDEXED_TOPICS) {
    if (keys.some((k) => k.length > 0 && (q.includes(k) || k.includes(q)))) {
      return { matched: true, entry }
    }
  }
  return { matched: false, available: listTopics() }
}

export function listTopics(): Array<{ id: string; title: string; aliases: string[] }> {
  return VRP_TOPICS.map(({ id, title, aliases }) => ({ id, title, aliases }))
}
