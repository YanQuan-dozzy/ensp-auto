# ensp-auto

把 eNSP 网络实验变成「一句话到结果」的桌面 AI 代理工作台。

用自然语言下达实验目标（例如「在三台路由器上跑通 OSPF，网段 10.0.0.0/24」），代理自主完成：
**扫描设备 → 连接 → 读取现状 → 下发配置 → 读回显验证 → 失败修正 → 出报告**。
全程每一步都可观测、可中断、可回滚。

## 功能特性

- **自然语言驱动**：纯代理角色，一句话到结果；执行过程流式可见，可随时打断插话
- **多 LLM Provider**：内置 DeepSeek / OpenAI / Anthropic / Google 及自定义 OpenAI 兼容端点（基于 `@earendil-works/pi-ai`，动态懒加载）
- **自研 ReAct 内核**：精简 ReAct 循环 + 领域闸门，不依赖通用 Agent 框架
- **安全的配置变更**：只读命令自由执行；配置走「快照 → 下发 → 期望校验 → 失败回滚」；破坏性命令需人工闸门批准
- **设备通信层重写**：Node `net` + 提示符状态机，支持 VRP 分页（`---- More ----`）、GBK 编码、错误识别、并发与断线保护
- **拓扑三层降级**：工程文件解析（`.topo`，兼容真机格式）→ LLDP 邻居实采推导 → React Flow 画布手补，三层自动合并；导入的拓扑可直接喂给代理
- **任务级一键封装**：execute_task 支持 pc_connectivity / ospf / vlan / dhcp / static_route / rip / acl_nat / eth_trunk，结构化生成配置并逐台走安全管道
- **结构化验证**：verify_ping / route / arp / nat / eth_trunk 只读判定 + collect_device_diagnostics 一键病灶采集
- **实验模板一键搭建**：内置静态路由互通 / RIP 三路由 / NAT Easy IP / 双链路聚合模板，list_lab_templates + run_lab_template 一句话起整场实验
- **会话树持久化**：全量落盘 + 历史回溯，任一节点可「从这里继续」换路重走
- **数据可控**：报告导出（md / json）；可选内置 MCP 出口（Streamable HTTP，仅绑定 127.0.0.1），供 Trae / Claude 等客户端接入

## 快速开始

推荐直接使用一键启动脚本（自动检测 Node、配置 Electron 镜像、缺依赖才安装、起开发模式）：

```text
双击 start.cmd        # 或终端执行 .\start.ps1
```

手动方式：

```bash
npm install          # 安装依赖
npm run dev          # 开发模式
npm run verify       # 类型检查 + 生产构建
npm test             # 全部测试（不需要 Electron、不需要 eNSP）
```

国内网络下 Electron 二进制需显式指定镜像：

```bash
# PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install
```

## 使用示例

1. 启动应用后，扫描本机 eNSP 模拟器虚拟设备（`127.0.0.1:2000-2050`）
2. 在右侧 AI 面板直接下达任务，例如：
   > 连接 Router1，跑通 OSPF，宣告网段 10.0.0.0/24 和 20.0.0.0/24
3. 代理自动连接、下发配置、读回显验证并修正；涉及 `undo` / `reboot` / `save` 等危险操作时弹人工闸门确认
4. 拓扑画布可从工程文件导入或实采推导，任务完成后可在历史 tab 回溯整棵会话树并导出报告

## 架构与核心决策

| 决策点 | 结论 |
|---|---|
| 产品形态 | Electron 桌面应用，单 exe 便携分发 |
| 技术栈 | Electron + React 19 + TypeScript，无 Python 运行时依赖 |
| AI 角色 | 纯代理（一句话到结果），非副驾 |
| Agent 内核 | 自研精简 ReAct 循环 + `@earendil-works/pi-ai`，不引 `pi-agent-core` |
| 通信层 | Node `net` + 提示符状态机整体重写 |
| 拓扑 | 结构化领域模型：工程文件 / LLDP 实采 / 画布手补三层降级合并 |
| 执行边界 | 只读自由 / 配置走快照事务校验回滚 / 破坏性命令人工闸门 |
| 界面 | 三栏布局（设备树 / 主舞台 tab / AI 常驻），深色为主可切浅色 |
| 持久化 | JSON KV + JSONL 快照目录，无需原生模块 |
| MCP | 内置 Streamable HTTP（127.0.0.1，设置开关），一份 TypeBox schema 双出口 |

分层硬边界：渲染进程不持有任何 Node 权限，所有特权操作经 preload 白名单 + IPC 进入主进程。

## 技术栈

| 关注点 | 选型 |
|---|---|
| 壳 | Electron（electron-vite） |
| 渲染 | React 19 + TypeScript + Vite |
| Agent 内核 | 自研 ReAct loop（`AgentRuntime` 接口 + real/mock 双实现）+ `@earendil-works/pi-ai` |
| 终端 | xterm.js |
| 拓扑图 | React Flow（`@xyflow/react`） |
| 状态 | Zustand |
| 设备通信 | Node `net` + 内置 `TextDecoder`（GBK） |
| Schema | TypeBox（一份 schema 同时喂 LLM 与 MCP） |
| 打包 | electron-builder → 单 exe 便携版 |

## 测试与验证

| 命令 | 结论 |
|---|---|
| `npm run typecheck` | 通过（node / web / tests 三套 tsconfig 均无错误） |
| `npm run build` | 通过 |
| `npm test` | 全绿：单元、通信层集成（Mock VRP / Mock SSH）、配置链路、拓扑解析、会话树、MCP 端到端、工程文件解析、任务计划、验证解析、实验模板、落盘与安全管道 |

用例数不写死在这里（历史上写死过一次，很快就过期了）：跑 `npm test` 看末尾的 `# pass`，
或 `ls tests/unit/*.test.mjs | wc -l` 看用例文件数。
注意 `tsconfig.tests.json` 也是门禁的一部分 —— 它专门覆盖 `tests/harness/**`，
否则「删了源码模块却漏改 harness」这类问题只能等 `npm test` 才炸。

## 已知限制

- **eNSP 真机联调待做**：通信层行为由 Mock VRP 设备覆盖（分页 / 编码 / 兜底 / 并发 / 断线），但真机提示符与错误文案的形态仍需按真机实测校准一次，差异回写 `patterns.ts`
- **真实模型调用待配 Key 验证**：各 provider 已接入并通过类型检查 / 构建 / 事件翻译单测，流式工具调用尚未用真实 API Key 端到端跑过；认证缺失、模型名不在目录等失败分支已在代码中显式处理
- **检查点恢复（P2）**：崩溃 / 退出后任务不自动续跑，但会话树已全量落盘，可通过「从这里继续」重放

## 安全红线

本项目**只**操作本机 eNSP 虚拟设备，明确不做以下事情：

- 不扫描本机 `127.0.0.1` 以外的任何地址（不做局域网 / 公网探测）
- 不绕过、不猜测、不爆破设备认证
- 不在未经确认的情况下批量下发配置
- 不在未做快照的情况下修改设备配置
- 不持久化明文设备密码

## 开发约定

- 所有源文件使用 UTF-8 编码
- 交付节奏：抽象接口 → real/mock 双实现 → bridge/preload 封装 → 测试 → 文档更新
- LLM 解密与设备密码等敏感信息仅存于本机 `userData` 下（`secrets.ts`），不入库、不上传