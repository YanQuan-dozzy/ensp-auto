/**
 * 一句话实验目标的内置预设与纯逻辑（主进程与渲染层共用）。
 *
 * 背景：输入框空态展示的「快速目标」内置丰富的网络工程实验场景，
 * 涵盖设备发现、端口状态、VLAN、路由协议、ACL/NAT、配置备份等。
 * 每次打开软件或用户点击「换一批」时，在庞大预设库中随机挑选展示三条。
 * 取消 AI 自动续写，使用高质量、贴合真实实训场景的内置预设库。
 */

/** 每次启动或刷新展示的目标条数 */
export const QUICK_PROMPT_COUNT = 3

/** 预设/存档上限 */
export const MAX_GOALS = 100

/** 单条目标长度上限（一条实验目标不该是段落） */
export const MAX_GOAL_LENGTH = 120

/** 内置预设实验目标，覆盖常见网络实训、排错与运维场景 */
export const PRESET_GOALS: readonly string[] = [
  // 基础设备巡检与状态收集
  '扫描本机网络设备，连上第一台，告诉我它的型号和端口状态',
  '巡检所有已连接设备，输出设备名称、系统版本与当前运行时间',
  '查看所有设备的接口状态，找出 down 的接口并汇总原因',
  '检查所有设备的 CPU 与内存利用率，标出是否存在负载过高设备',
  '检查所有物理接口的错包与丢包统计，找出存在 CRC 错误的异常链路',
  '检查所有已连接设备的电源、风扇及单板运行状态，输出硬件健康报告',

  // 配置备份与比对
  '帮我备份所有已连接设备的当前运行配置（display current-configuration）',
  '比对各设备当前运行配置与已保存配置，列出未保存的配置差异',
  '检查全网设备配置保存状态，并在所有已连接设备上执行配置保存（save）',

  // 接口、链路与二层交换
  '批量查看所有交换机端口的链路类型（Access/Trunk/Hybrid）及所属 VLAN',
  '检查全网 VLAN 划分情况，统计各设备已创建的 VLAN 及端口透传列表',
  '检查各交换机的链路聚合（Eth-Trunk）配置，验证成员端口与 LACP 协议协商',
  '排查二层环路与生成树状态，输出 STP/RSTP/MSTP 根桥与阻塞端口',
  '查看各交换机的 MAC 地址表，排查是否存在 MAC 漂移或广播风暴迹象',
  '检查交换机端口安全（Port Security）配置，查看安全 MAC 与保护动作',

  // IP 编址与连通性
  '检查所有接口的 IP 地址与子网掩码，排查是否存在网段冲突或重叠',
  '测试全网设备间 Loopback 环回接口的连通性，输出端到端 Ping 汇总表',
  '对核心节点到各终端网段执行路由追踪（tracert），验证转发路径是否合理',
  '检查各网关设备上的 ARP 表项，找出 IP 与 MAC 绑定的异常记录',

  // 路由协议（静态/OSPF/RIP/BGP）
  '检查所有已连接设备，输出当前的路由表与默认路由配置',
  '检查所有设备的 OSPF 邻居关系，确认状态是否达到 Full 并定位异常邻居',
  '查看各路由器的 OSPF 链路状态数据库（LSDB）与区域规划',
  '检查所有静态路由配置，排查是否存在下一跳不可达或潜在路由环路',
  '检查 BGP 邻居连接状态（IBGP/EBGP），输出已学到的 BGP 路由条目',
  '检查 RIP 路由协议的通告网段与各接口收发报文版本（V1/V2）',

  // 网关冗余与高可用
  '检查 VRRP 备份组状态，确认各网关的主备（Master/Backup）角色与虚拟 IP',
  '测试核心网关的冗余切换能力，验证当下行链路中断时备用网关能否接管',

  // 安全策略与访问控制
  '检查所有已应用的 ACL 规则列表，分析各接口出入方向的流量过滤策略',
  '查看出口路由器的 NAT 转换表项与 Easy IP 配置，验证公网地址映射',
  '检查各设备的 AAA 认证、Console 与 VTY 远程管理配置与密码策略',

  // 网络服务（DHCP/NTP）
  '检查各网关的 DHCP 地址池状态，统计已分配 IP 数量、租期及排除范围',
  '检查所有设备的系统时间与 NTP 同步状态，确保全网设备日志时间戳一致',

  // 故障排错与诊断
  '诊断某网段无法访问外网的问题，依次排查接口、IP、默认路由及 NAT',
  '排查两台直连交换机 Trunk 端口不通的问题，核对允许放行的 VLAN',
  '检查各路由器接口的 MTU 设置，排查大包传输分片与丢包问题',
  '统计核心链路的接口带宽与实时收发速率，定位当前网络流量瓶颈'
]

/**
 * 清洗一批目标：只留非空、去重（保序）、收敛长度与总数。
 * 逐条不达标就丢弃。
 */
export function sanitizeGoals(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_GOALS) break
    // 只收字符串：数字/对象/null 一律丢弃
    if (typeof item !== 'string') continue
    const line = item
      // 剥掉编号/列表前缀：1. / 1) / - / * / 1、 等
      .replace(/^\s*(?:\d+[.)、]|[-*])\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!line) continue
    if (line.length > MAX_GOAL_LENGTH) continue
    const norm = line.toLowerCase()
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(line)
  }
  return out
}

/**
 * 随机抽 n 条（不重复）。池子不足 n 时返回全部（顺序也打乱），
 * 池子为空返回空数组 —— 调用方决定怎么展示，这里不造默认值。
 */
export function pickRandomGoals(goals: readonly string[], n: number): string[] {
  const pool = goals.filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
  const count = Math.min(n, pool.length)
  const out: string[] = []
  const used = new Set<number>()
  while (out.length < count && used.size < pool.length) {
    const i = Math.floor(Math.random() * pool.length)
    if (used.has(i)) continue
    used.add(i)
    out.push(pool[i]!)
  }
  return out
}