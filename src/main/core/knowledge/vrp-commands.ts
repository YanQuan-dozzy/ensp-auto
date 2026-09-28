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
        description: 'quit 退一层，return 直接回用户视图（应用内用 change_view 工具下发）',
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
      '用户视图敲配置命令会报错（Error: Unrecognized command），先 system-view',
      'quit / return 是视图切换命令，run_show_command 只收只读命令 —— 切视图用 change_view（target: user / system / interface）',
      'return 在用户视图本身不被识别（会报 Unrecognized）；change_view 会先判断当前视图，不必自己探'
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
  },
  {
    id: 'l3_switch',
    title: '三层交换与 VLAN 间路由',
    aliases: [
      '三层交换',
      '三层交换机',
      'vlanif',
      '三层口',
      'undo portswitch',
      'portswitch',
      'vlan间互通',
      '网关接口',
      'svi'
    ],
    summary:
      'VLAN 间互通的两种落地方式：① 三层交换机用 Vlanif（逻辑网关，主流）；' +
      '② 物理口 undo portswitch 变三层口直配 IP（点对点互联）。',
    commands: [
      {
        syntax: 'interface Vlanif <vlan-id> → ip address <ip> <掩码>',
        description:
          'Vlanif 是 VLAN 的三层逻辑接口，作为该网段终端的网关。必须先 vlan batch 建 VLAN、' +
          '该设备上至少有一个端口属于该 VLAN 且处于 up，Vlanif 才会 up',
        example: 'vlan batch 10 → interface Vlanif 10 → ip address 192.168.10.1 24'
      },
      {
        syntax: '接口视图：undo portswitch',
        description:
          '把二层以太口切换成三层路由口（之后才能在该物理口上 ip address）。' +
          '切换要求接口下**只有属性配置**（shutdown / description），有 port link-type 之类业务配置要先清掉',
        example: 'interface GigabitEthernet 0/0/1 → undo portswitch → ip address 10.0.1.1 24'
      },
      {
        syntax: '系统视图：portswitch batch <接口范围>',
        description: '批量二三层模式切换（接口多时用）',
        example: 'portswitch batch GigabitEthernet 0/0/1 to 0/0/4'
      },
      {
        syntax: 'display ip interface brief / display ip routing-table',
        description: '查三层接口的状态与地址、以及直连路由是否生成（Vlanif up 才有直连路由）',
        example: 'display ip interface brief'
      }
    ],
    pitfalls: [
      'Vlanif up 的三个条件：VLAN 已创建 + 该 VLAN 内有端口 up + 接口未被 shutdown —— 少一个就起不来（display ip interface brief 看物理/协议两列）',
      'Vlanif 没配就 ping 不通同网段终端：三层交换机的「网关」就是这个 Vlanif 地址，终端网关要指它',
      'undo portswitch 前接口上有业务配置（port link-type / port default vlan）会切不过去，必须先清配置',
      '三层口与 Vlanif 不要在同一设备同一网段重复配地址（地址冲突）',
      '交换机上配 `ip address` 直接写在二层口上会报错 —— 要么 undo portswitch，要么用 Vlanif'
    ]
  },
  {
    id: 'single_arm',
    title: '单臂路由（子接口 VLAN 间互通）',
    aliases: [
      '单臂路由',
      '子接口',
      'subinterface',
      'dot1q',
      'dot1q termination vid',
      '子接口终结',
      '路由器子接口',
      '802.1q'
    ],
    summary:
      '路由器一个物理口接交换机 trunk，按 VLAN 建子接口：`interface g0/0/1.<vid>` → ' +
      '`dot1q termination vid <vid>` → 配 IP（= 该 VLAN 的网关）→ `arp broadcast enable`。',
    commands: [
      {
        syntax: 'interface <接口类型> <编号>.<子接口号>',
        description: '创建子接口（子接口号习惯与 VLAN ID 一致，便于对照，但两者不必相同）',
        example: 'interface GigabitEthernet 0/0/1.10'
      },
      {
        syntax: 'dot1q termination vid <vlan-id>',
        description:
          '子接口终结指定 VLAN 的 tag（剥掉 tag 后做三层转发）。**一个子接口只能终结一个 VLAN**',
        example: 'dot1q termination vid 10'
      },
      {
        syntax: 'ip address <ip> <掩码>',
        description: '子接口地址 = 对应 VLAN 内终端的默认网关',
        example: 'ip address 192.168.10.1 24'
      },
      {
        syntax: 'arp broadcast enable',
        description:
          '使能子接口的 ARP 广播 —— 华为缺省关闭，不配则子接口不发 ARP 广播，VLAN 间不通（单臂路由第一坑）',
        example: 'arp broadcast enable'
      },
      {
        syntax: 'display interface <子接口> / display ip interface brief',
        description: '查子接口双 up 与地址',
        example: 'display ip interface brief'
      }
    ],
    pitfalls: [
      '漏 arp broadcast enable：配置看起来全对，但 VLAN 间就是不通（华为子接口默认不发 ARP 广播）',
      '漏 dot1q termination vid：子接口没收 tag 的能力，流量全部丢弃',
      '交换机侧的级联口必须是 trunk 且 allow-pass 覆盖这些 VLAN，否则 tag 根本到不了路由器',
      '同一物理口下的不同子接口不能终结同一个 VLAN ID（会报冲突）',
      '子接口本身没有物理状态，父接口 down 时它跟着 down —— 先查父接口',
      '终端网关要写子接口地址，不要写父物理口地址'
    ]
  },
  {
    id: 'stp',
    title: 'STP / RSTP / MSTP 生成树',
    aliases: [
      'stp',
      'rstp',
      'mstp',
      '生成树',
      '生成树协议',
      '环路',
      '网络环路',
      '根桥',
      'region-configuration'
    ],
    summary:
      '防二层环路。VRP 缺省就是 MSTP：可选 `stp mode` → 配 MST 域（域名 + 实例映射 VLAN）→' +
      '`active region-configuration` 激活 → 指定根桥。',
    commands: [
      {
        syntax: 'stp mode stp | rstp | mstp',
        description: '生成树工作模式；设备缺省为 MSTP，实验里通常无需显式配置',
        example: 'stp mode mstp'
      },
      {
        syntax: 'stp enable / 接口视图：stp enable',
        description: '全局/接口使能生成树（缺省全局与端口都使能）',
        example: 'stp enable'
      },
      {
        syntax: 'stp region-configuration → region-name <名> → instance <id> vlan <vlan列表> → active region-configuration',
        description:
          'MST 域：**域名 + VLAN 与实例的映射表 + 修订级别三者全同**才算同一域；' +
          '改完必须 active region-configuration 才生效',
        example: 'stp region-configuration → region-name RG1 → instance 1 vlan 10 to 20 → active region-configuration'
      },
      {
        syntax: 'stp instance <id> root primary | root secondary',
        description: '指定该实例的根桥/备份根桥（primary 把优先级压到 0，secondary 压到 4096）',
        example: 'stp instance 1 root primary'
      },
      {
        syntax: '接口视图：stp cost <值> / stp edged-port',
        description: '改端口路径开销以影响选路；接终端的口设边缘端口（跳过监听学习，秒级收敛）',
        example: 'stp edged-port'
      },
      {
        syntax: 'display stp [instance <id>] [brief] / display stp region-configuration',
        description: '查根桥、各端口角色（Root/Designated/Alternate）与域配置',
        example: 'display stp brief'
      }
    ],
    pitfalls: [
      'MST 域三要素（域名 / VLAN 映射 / 修订级别）任一不同就各自成域、实例计算全乱 —— 全域必须逐字一致',
      '改完 MST 域配置忘敲 active region-configuration，配置在但没生效（display stp region-configuration 里看 Active 状态）',
      '接终端的口没设 stp edged-port，插拔网线会触发一次拓扑变更，全网震荡数秒',
      '根桥要靠手动指定（或优先级），别指望默认选举 —— 默认比的是桥 MAC，结果不可预期',
      'MSTP 下 `stp instance N root primary` 要在系统视图配，不是接口视图'
    ]
  },
  {
    id: 'vrrp',
    title: 'VRRP 网关冗余',
    aliases: [
      'vrrp',
      '虚拟路由冗余协议',
      '网关冗余',
      '双机热备',
      'vrrp vrid',
      'preempt',
      '浮动网关'
    ],
    summary:
      '两台（或多台）设备在同一网段做一台「虚拟路由器」：同一 vrid + 同一 virtual-ip，' +
      '优先级高者为 Master。终端网关指向**虚拟 IP**。',
    commands: [
      {
        syntax: '接口视图：vrrp vrid <1-255> virtual-ip <虚拟ip>',
        description:
          '创建备份组。**同组各设备的 vrid 与 virtual-ip 必须完全一致**；虚拟 IP 不能等于任何成员接口的实际地址',
        example: 'vrrp vrid 1 virtual-ip 192.168.10.254'
      },
      {
        syntax: 'vrrp vrid <id> priority <1-254>',
        description: '优先级，越大越优先（缺省 100）；255 保留给 IP 地址拥有者，0 表示主动放弃 Master',
        example: 'vrrp vrid 1 priority 120'
      },
      {
        syntax: 'vrrp vrid <id> preempt-mode [timer delay <秒>]',
        description: '抢占模式（缺省开启）；delay 用于等上层协议（OSPF 等）收敛后再抢占，避免来回抖动',
        example: 'vrrp vrid 1 preempt-mode timer delay 20'
      },
      {
        syntax: 'vrrp vrid <id> track interface <接口> [reduced <值>]',
        description: '监视上行接口：上行断则自动降优先级（可配降多少），让备机抢占',
        example: 'vrrp vrid 1 track interface GigabitEthernet 0/0/1 reduced 30'
      },
      {
        syntax: 'display vrrp [brief | interface <接口>]',
        description: '查组内状态（Master / Backup）、虚拟 IP、优先级与抢占配置',
        example: 'display vrrp brief'
      }
    ],
    pitfalls: [
      '两台设备 vrid 或 virtual-ip 不一致 → 各自成为 Master，全网 IP 冲突（最典型的翻车）',
      '虚拟 IP 写成某台成员的真实接口地址 → 冲突，直接报错或行为异常',
      '两台优先级都保持默认 100 → 比接口 IP 大小定 Master，主备与预期相反',
      '没配 track interface：上行断了 Master 还占着虚拟 IP，流量黑洞',
      '终端网关必须指向虚拟 IP，指到某台真实地址就失去了冗余意义',
      '备机不转发流量（Backup-forward 默认关闭），验证时要从终端侧断开主用链路看切换，别只看 display vrrp'
    ]
  },
  {
    id: 'dhcp_relay',
    title: 'DHCP 中继（跨网段获取地址）',
    aliases: [
      'dhcp中继',
      'dhcp relay',
      'dhcp select relay',
      '中继',
      'relay',
      'dhcp relay server-ip',
      '跨网段获取ip'
    ],
    summary:
      '客户端与 DHCP 服务器不同网段时，网关设备做中继：`dhcp enable` → 网关接口 ' +
      '`dhcp select relay` → `dhcp relay server-ip <服务器地址>`。',
    commands: [
      {
        syntax: 'dhcp enable',
        description: '全局使能 DHCP（中继与服务器都依赖它，漏了后面全不生效）',
        example: 'dhcp enable'
      },
      {
        syntax: '接口视图（客户端侧网关）：dhcp select relay',
        description: '该接口收到的 DHCP 请求走中继流程（代替 dhcp select global）',
        example: 'interface Vlanif 10 → dhcp select relay'
      },
      {
        syntax: '接口视图：dhcp relay server-ip <服务器ip>',
        description: '指定所代理的 DHCP 服务器地址（可直接在接口上配，也可 dhcp server group 分组引用）',
        example: 'dhcp relay server-ip 10.1.1.100'
      },
      {
        syntax: 'dhcp server group <组名> → dhcp-server <ip>',
        description: '服务器组：多个 DHCP 服务器时用，接口下引用组名（备用服务器场景）',
        example: 'dhcp server group dhcpgroup → dhcp-server 10.1.1.100'
      },
      {
        syntax: 'display dhcp relay interface <接口> / display dhcp relay all',
        description: '查中继配置与已建立的绑定',
        example: 'display dhcp relay interface Vlanif 10'
      }
    ],
    pitfalls: [
      '中继设备到 DHCP 服务器**路由不可达**是最常见的「配了却拿不到地址」——先 ping 通服务器',
      '服务器地址池的 gateway-list 必须写**中继接口的地址**（不是服务器自己的地址），否则终端网关错',
      '中继接口漏 dhcp select relay：报文不会转发，客户端一直等',
      '忘 dhcp enable：接口下的中继命令配了也不生效',
      '服务器侧地址池的 network 必须是客户端所在网段（中继不改网段，只做单播转发）',
      '排障顺序：中继到服务器可达 → 接口 dhcp select relay → 服务器地址池网段/网关 → 客户端 IP/掩码'
    ]
  },
  {
    id: 'route_adv',
    title: '路由引入（多协议互通）',
    aliases: [
      '路由引入',
      '引入外部路由',
      'import-route',
      'importroute',
      '路由重分发',
      '路由重发布',
      '协议互通',
      '双协议'
    ],
    summary:
      '在协议视图里 `import-route <来源协议> [进程号] [cost <值>]`，把别的协议/直连/静态路由灌进本协议。' +
      '**单向引入只解决一个方向，两边都要配**；配 `filter-policy` 才能控制引入范围。',
    commands: [
      {
        syntax: 'OSPF 视图：import-route direct | static | rip <进程号> [cost <值>]',
        description: 'OSPF 里引入直连/静态/RIP 路由（default-route-advertise 单独负责默认路由）',
        example: 'ospf 1 → import-route rip 1 → import-route direct'
      },
      {
        syntax: 'RIP 视图：import-route direct | static | ospf <进程号> [cost <值>]',
        description: 'RIP 引入其它路由；RIP 度量是跳数，cost 不给时用 default-cost（缺省 0）',
        example: 'rip 1 → version 2 → import-route ospf 1'
      },
      {
        syntax: 'RIP 视图：default-route originate',
        description: '向邻居下发默认路由（RIP 的做法；OSPF 用 default-route-advertise）',
        example: 'default-route originate'
      },
      {
        syntax: 'filter-policy <acl号 | ip-prefix 名> export（发布）/ import（接收）',
        description: '对引入/发布的路由做过滤。**ACL 里没被任何规则匹配到的路由不会被引入**（隐式拒绝）',
        example: 'filter-policy 2000 export'
      },
      {
        syntax: 'display ip routing-table protocol ospf | rip',
        description: '按协议查路由，确认引入是否真的生效',
        example: 'display ip routing-table protocol rip'
      }
    ],
    pitfalls: [
      '只在一个方向配了 import-route（单向引入）→ 去程通、回程断；互通必须两端都引入',
      'OSPF 引入直连/静态用 import-route direct / static，不是 network 宣告（network 只宣告接口所在网段）',
      '引入后路由存在但 ping 不通：查对端是否也有回程路由，以及是否被 filter-policy 挡了',
      'filter-policy 引用的 ACL 若只有 permit 规则、没写兜底，未匹配的路由会被隐式拒绝 —— 看起来「引入了却没路由」',
      '引入指标不当会导致次优路径或环路：引入时给 cost/tag 区分内外路由',
      'RIP 引入外部路由的 cost 缺省是 0，容易让外部路由比内部更优，建议显式给 cost'
    ]
  },
  {
    id: 'device_mgmt',
    title: '设备远程登录与用户管理',
    aliases: [
      'telnet',
      'ssh',
      'stelnet',
      '远程登录',
      '登录设备',
      'aaa',
      'local-user',
      'user-interface',
      'vty',
      'privilege level',
      '用户认证'
    ],
    summary:
      'Telnet/SSH 服务器三步：`user-interface vty 0 4` 定协议与认证方式 → `aaa` 建本地用户并给级别 → ' +
      '`telnet server enable` / `stelnet server enable`（SSH 还要生成密钥）。',
    commands: [
      {
        syntax: 'user-interface vty 0 4 → authentication-mode aaa → protocol inbound telnet|ssh → user privilege level <0-15>',
        description:
          'VTY 用户界面：指定接入协议与认证方式。SSH 必须先配 aaa 认证方式；' +
          '把 protocol inbound 设为 ssh 后设备会自动禁用 Telnet',
        example: 'user-interface vty 0 4 → authentication-mode aaa → protocol inbound ssh → user privilege level 15'
      },
      {
        syntax: 'aaa → local-user <用户名> password irreversible-cipher <明文/密文> → local-user <名> privilege level <0-15> → local-user <名> service-type telnet|ssh',
        description:
          '创建本地用户。privilege level 15 才是最高权限（能进 system-view、能 save）；' +
          'service-type 要与接入协议对应（telnet / ssh，可同时给）',
        example: 'aaa → local-user admin password irreversible-cipher Huawei@123 → local-user admin privilege level 15 → local-user admin service-type telnet ssh'
      },
      {
        syntax: 'telnet server enable / stelnet server enable',
        description: '分别使能 Telnet / STelnet(SSH) 服务器功能（缺省都未开启）',
        example: 'stelnet server enable'
      },
      {
        syntax: 'rsa local-key-pair create',
        description: '生成 RSA 主机密钥对（SSH 加密交互的前提，必须在 SSH 用户配置前/中完成）',
        example: 'rsa local-key-pair create'
      },
      {
        syntax: 'ssh user <名> authentication-type password → ssh user <名> service-type stelnet',
        description: '（密码认证方式）声明 SSH 用户的认证方式与可用服务',
        example: 'ssh user admin authentication-type password → ssh user admin service-type stelnet'
      },
      {
        syntax: 'display users / display ssh server status / display telnet server status',
        description: '查在线用户与服务器状态',
        example: 'display users'
      }
    ],
    pitfalls: [
      'privilege level 没给或给得太低（如 3）：能登录但进不了 system-view，表现为「命令都用不了」',
      'service-type 与 protocol inbound 不匹配（用户只给 telnet，界面却限制 ssh）→ 登录被拒',
      'SSH 忘 rsa local-key-pair create：stelnet server enable 后仍连不上',
      'VTY 的 user privilege level 与 local-user 的 privilege level 会共同生效，取较低者；只改一处可能仍不够权限',
      '部分版本要求指定服务器源接口/源地址（ssh server-source / telnet server-source），否则服务起不来',
      '清掉 protocol inbound ssh 之外还要记得 aaa 认证方式 —— 只配一处的现象是「要密码但怎么输都不对」'
    ]
  },
  {
    id: 'error_ref',
    title: 'VRP 报错速查（配置失败的共同根因）',
    aliases: [
      '报错',
      '错误',
      '错误信息',
      '命令报错',
      'unrecognized',
      'wrong parameter',
      'incomplete command',
      'ambiguous',
      'error',
      '配置不生效',
      '命令用不了'
    ],
    summary:
      '设备报错都带 `found at "^" position`，**`^` 指向的就是出错字段**。先按错误码定性，' +
      '再按「视图 → 拼写 → 参数形状（掩码/反掩码）→ 依赖对象是否存在」四步定位。',
    commands: [
      {
        syntax: 'Error: Unrecognized command found at "^" position.',
        description: '命令不存在 / 关键字不存在：视图不对、拼写错、或该版本不支持',
        example: '用户视图敲 interface 会报此错 → 先 system-view 或用 change_view'
      },
      {
        syntax: 'Error: Incomplete command found at "^" position.',
        description: '命令不完整，缺必要参数',
        example: '只写 ip address 就回车'
      },
      {
        syntax: 'Error: Wrong parameter found at "^" position.',
        description: '参数类型错或取值越界：掩码/反掩码写反、VLAN ID 越界、引用不存在的对象',
        example: 'network 10.0.0.0 255.255.255.0（第二参数应为反掩码 0.0.0.255）'
      },
      {
        syntax: 'Error: Too many parameters found at "^" position.',
        description: '参数过多：两条命令写成一行',
        example: 'vlan batch 10 vlan batch 20'
      },
      {
        syntax: 'Error: Ambiguous command found at "^" position.',
        description: '缩写有歧义，补全到唯一即可',
        example: 'dis → display'
      },
      {
        syntax: 'Info: The configuration is not saved.',
        description: '配置没保存（不是失败）：收尾记得 save',
        example: 'save（会停在 [Y/N]，应用内走 save_configuration）'
      }
    ],
    pitfalls: [
      '第一件事看 `^` 指的字段位置，它比整句报错信息有用得多',
      '反向掩码/掩码写反是最高频的 Wrong parameter：OSPF/ACL 用反掩码，IP/静态路由/DHCP 用掩码',
      '从 Word / 网页复制粘贴最容易带全角空格（U+3000），肉眼几乎看不出，设备必报错',
      '「命令都对但就是不生效」多半是依赖没满足：VLAN 没建、接口 shutdown、只配了单向路由、漏 dhcp enable',
      '别照着原样重试同一条命令 —— 先改一个变量（视图 / 参数形状 / 拼写）再试，否则只是浪费一次往返',
      '拿不准语法时先 lookup_vrp_command 查证，再用 change_view 摆正视图，最后才下发'
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

/** 正文检索的最小查询长度：太短的词（如 "ip"）会命中一大片，噪声大于价值 */
const MIN_CONTENT_QUERY_LEN = 3

/** 正文检索用的字段分隔符：不参与归一化，避免「跨字段拼出的假命中」 */
const FIELD_SEP = '|'

/** 归一化后的别名集（含 id）+ 正文索引，预计算避免每次查询重复正则 */
const INDEXED_TOPICS: Array<{ entry: VrpTopicEntry; keys: string[]; haystack: string }> = VRP_TOPICS.map(
  (entry) => ({
    entry,
    keys: [normalizeTopic(entry.id), ...entry.aliases.map(normalizeTopic)],
    // 正文索引：标题/摘要/命令语法/说明/示例/易错点 —— 让「按命令关键字或报错现象」也能查到主题
    // （例如 "allow-pass"、"反掩码"、"arp broadcast enable"）。
    // 各字段先用 | 分隔再逐字段归一化，防止「上一个字段的尾 + 下一个字段的头」拼出假命中。
    haystack: [
      entry.title,
      entry.summary,
      ...entry.commands.flatMap((c) => [c.syntax, c.description, c.example ?? '']),
      ...entry.pitfalls
    ]
      .map(normalizeTopic)
      .join(FIELD_SEP)
  })
)

/** 命中方式：精确（id/别名）> 子串别名 > 正文检索 */
export type VrpMatchKind = 'exact' | 'alias' | 'content'

export interface LookupOutcome {
  matched: boolean
  /** 命中的主题（matched=false 时为 undefined） */
  entry?: VrpTopicEntry
  /**
   * 命中方式。`content` 表示「按正文关键字命中」—— 主题不一定完全对题，
   * 提示模型核对 summary 后再照抄命令（调用方据此加一句提醒）。
   */
  matchedBy?: VrpMatchKind
  /** 未命中时给模型看可用主题清单 */
  available?: Array<{ id: string; title: string; aliases: string[] }>
}

/**
 * 主题查询，三级降级：
 * 1. **精确**：id 或别名归一化后全等（`stp` / `Static-Route` / `静态路由`）。
 * 2. **子串 / 正文**（合并取最优）：查询词与别名互为子串，**或**查询词出现在标题/摘要/
 *    命令语法/示例/易错点正文里。两者按「匹配到的文本长度」比大小，长者为胜 ——
 *    这一步同时治两个病：
 *      - 「三层交换」同时包含 vlan 的别名「交换」和 l3_switch 的别名「三层交换」，
 *        按数组顺序会命中 vlan（错的那一个），按长度才能命中更具体的 l3_switch；
 *      - 「arp broadcast enable」这种**整句命令**，只在 single_arm 的正文里出现，
 *        却会被 troubleshoot 的短别名「arp」抢先 —— 正文命中得分是整句长度，自然胜出。
 *    同分时保留更靠前的主题（既有主题优先级不被新主题抢走）、别名命中优先于正文命中
 *    （别名是人工维护的强信号，正文命中只是线索）。
 *
 * 三级都失败时返回可用清单，让模型换个词重查，而不是空手而归。
 */
export function lookupVrpTopic(rawTopic: string): LookupOutcome {
  const q = normalizeTopic(rawTopic)
  if (!q) return { matched: false, available: listTopics() }

  // 1) 精确
  for (const { entry, keys } of INDEXED_TOPICS) {
    if (keys.includes(q)) return { matched: true, entry, matchedBy: 'exact' }
  }

  // 2) 别名子串 + 正文检索，取匹配长度最大者
  const candidates: Array<{ entry: VrpTopicEntry; score: number; kind: VrpMatchKind }> = []
  for (const { entry, keys } of INDEXED_TOPICS) {
    for (const k of keys) {
      if (!k) continue
      // 查询词包含更长的别名 = 命中更具体（「三层交换」命中「三层交换」而非「交换」）
      // 反之别名比查询词长时，能确定的信息量就是查询词本身（「dhcp」命中「dhcp中继」）
      const score = q.includes(k) ? k.length : k.includes(q) ? q.length : 0
      if (score > 0) candidates.push({ entry, score, kind: 'alias' })
    }
  }
  if (q.length >= MIN_CONTENT_QUERY_LEN) {
    for (const { entry, haystack } of INDEXED_TOPICS) {
      if (haystack.includes(q)) candidates.push({ entry, score: q.length, kind: 'content' })
    }
  }
  // 数组顺序 = 主题顺序，别名候选在前；`>` 保证同分时保留先入者（既有主题优先、别名优先）
  let best: (typeof candidates)[number] | undefined
  for (const c of candidates) {
    if (!best || c.score > best.score) best = c
  }
  if (best) return { matched: true, entry: best.entry, matchedBy: best.kind }

  return { matched: false, available: listTopics() }
}

export function listTopics(): Array<{ id: string; title: string; aliases: string[] }> {
  return VRP_TOPICS.map(({ id, title, aliases }) => ({ id, title, aliases }))
}
