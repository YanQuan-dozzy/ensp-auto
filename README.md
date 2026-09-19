# ensp-auto

把 eNSP 网络实验变成「一句话到结果」的桌面 AI 代理工作台。

用自然语言下达实验目标（例如「在三台路由器上跑通 OSPF，网段 10.0.0.0/24」），代理自己完成：
扫描设备 → 连接 → 读取现状 → 下发配置 → 读回显验证 → 失败修正 → 出报告。
全程每一步都可观测、可中断、可回滚。

> 本仓库从零新建。参考原型为 `ensptomcpfortrae-main`（eNSP MCP Server，Flask + Socket.IO + 原生 JS），
> **仅作行为参考，代码不复用**。

## 当前状态

**v0.1 骨架**（扫描/连接/终端/只读代理/三栏 UI）与 **v0.2 配置变更**（快照→下发→校验→回滚→变更记录）
已完成；**v0.3 拓扑**（LLDP 邻居推导 + React Flow 画布 + 喂给代理）已完成，
LLM 层按 pi 仓库方法论换为 `@earendil-works/pi-ai`（多 provider）；
**v0.4 用得住**已完成（会话树持久化 + 回溯、执行中消息排队、报告导出、MCP 对外接口）；
**v1.0 前置打磨**已完成：一键启动脚本（start.cmd）、工程文件解析（F-5.2，.topo 三层降级第一来源）、
状态栏/历史标题/启动失败不白屏等 UI 与健壮性小项。
类型检查、生产构建、108 项测试全部通过。
尚未在真机 eNSP 上做过端到端联调，也未用真实 API Key 端到端跑过模型调用（原因见「已知限制」）。

## 快速开始

推荐直接用一键启动脚本（自动检测 Node、装依赖、配 Electron 镜像、起开发模式）：

```text
双击 start.cmd        # 或终端里执行 .\start.ps1
```

脚本逻辑：检测 node → 设置 `ELECTRON_MIRROR` 镜像 → 缺依赖/二进制才 `npm install`
→ 再校验 `node_modules/electron/dist/electron.exe`（缺失给手动命令）→ `npm run dev`;

```bash
npm install          # 装依赖
npm run dev          # 开发模式（需要 Electron 二进制，见下）
npm run verify       # 类型检查 + 生产构建
npm test             # 108 项测试（不需要 Electron、不需要 eNSP）
```

也有 `verify.cmd` / `test.cmd` 双击快捷入口。

国内网络下 Electron 的二进制不走 npm registry，需要显式指定镜像：

```bash
# PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install
```

### 已知限制

- **Electron 二进制需自行安装。** 开发沙箱能装 npm 包但下载不了 Electron 的运行时二进制，
  因此 `npm run dev`（拉起窗口）尚未验证过；`npm run build`（产出 bundles）已验证。
  在能访问镜像的机器上执行上面的安装命令即可补齐。
- **eNSP 真机联调待做。** 通信层的行为由 Mock VRP 设备覆盖（分页 / 编码 / 静默兜底 /
  确认提示 / 并发 / 断线 / 截断），但 VRP 提示符与错误文案的具体形态仍需按
  [TELNET-SPEC.md 的要求](docs/TELNET-SPEC.md)用真机实测校准一次，差异回写到 `patterns.ts`。
- **真实模型调用待配 Key 验证。** pi-ai 已接入并通过类型检查/构建/事件翻译单测，
  但 DeepSeek / OpenAI 等 provider 的流式工具调用尚未用真实 API Key 端到端跑过；
  连接失败的行为（认证缺失 / 模型名不在目录）在代码里已有显式错误分支。
- **拓扑三层降级已齐（file 为第一来源）。** LLDP 实采（F-5.3）、画布手补（F-5.4）、
  工程文件解析（F-5.2）都已实现；`.topo` 解析器已用一份**真实教学区校园网 .topo 实测校准**：
  真机格式差异（`<dev>` 标签、`<line srcDeviceID/destDeviceID>` 链路端点、自闭合
  interfacePair、GBK 中文设备名、cx/cy 坐标）均已容错支持，29 设备 / 32 链路一次解析成功，
  解析器仍带结构报告与 warning，解析 0 设备不崩溃。实时链路状态（F-5.6）按 P2 顺延。
- **MCP 客户端接法有平台差异。** 服务端是标准 Streamable HTTP；Trae 等支持本地 http URL 的客户端直填即可，
  Claude Desktop 本地配置仅认 stdio，需用 `npx mcp-remote http://127.0.0.1:<port>/mcp` 桥
  （无 HTTPS 端点的本地服务都是这个待遇）。同一会话树/报告数据同时喂内置代理与 MCP。
- **检查点恢复（F-3.9）仍在 P2。** 崩溃/退出后任务本身不续跑，但会话树已全量落盘，可「从这里继续」重放。

## 与设计文档的偏差

实现时对选型做了调整，都是为了减少依赖与风险：

| 文档原本写的 | 实际实现 | 原因 |
|---|---|---|
| better-sqlite3 + JSONL | JSON KV 文件（`JsonStore`）+ JSONL 快照目录 | better-sqlite3 是原生模块，需 electron-rebuild 与本机编译工具链，是 Windows 上的明确安装风险点。当前持久化需求只是设置、别名、快照、变更记录、拓扑，KV 文件足够 |
| typebox | **曾经**手写 JSON Schema 字面量；**v0.3 起改回 TypeBox** | v0.1 手写是为少一个依赖；v0.3 引 `pi-ai` 后 TypeBox 由包直接反出（零新增依赖），一份 schema 喂 LLM 与 MCP，且获得静态类型 |
| iconv-lite | Node/Electron 内置 `TextDecoder` | Node 22+ 与 Electron 均自带完整 ICU，`gbk` 可直接用。启动时做一次探针，不可用时降级并标记，不静默出错 |
| `openai` SDK（模型层） | `@earendil-works/pi-ai` | 详见 [ARCHITECTURE.md §2.2](docs/ARCHITECTURE.md#22-为什么引-pi-ai-而不引-pi-agent-core)：子路径 provider import + 懒加载解决体积争议，换来多 provider 一套代码；主进程同步 ESM 化（preload 保持 CJS + sandbox），仍不引 `pi-agent-core` |

## 验证结果

| 命令 | 结论 |
|---|---|
| `npm run typecheck` | 通过。node 侧与 web 侧两个 tsconfig 均无错误 |
| `npm run build` | 通过。main 136 kB（ESM）/ preload 4 kB（CJS）/ renderer 1.49 MB + 42 kB CSS |
| `npm test` | **108 项全绿**。33 项单元 + 14 项通信层集成 + 26 项配置链路 + 12 项 v0.3 + 10 项 v0.4 + 13 项 v1.0 前置（.topo 解析/真机校准/三层合并） |

## v0.2：配置变更（F-4.x）

按 [TOOLS.md §4.3](docs/TOOLS.md) 落地 4 个工具并注册进代理：

| 工具 | risk | 要点 |
|---|---|---|
| `apply_config` | write | 自动采集快照 → 危险命令拦截 → 进系统视图 → 逐条下发读回显判定 → 失败即停 → 期望校验 |
| `verify_expectation` | read | contains / notContains / regex 三模式，可重试等待协议收敛 |
| `restore_snapshot` | write | 配置分段 diff 生成撤销命令（新增段 `undo 段头`、段内新增逐条 undo、被删行补回）；主动回滚弹闸门 |
| `save_configuration` | danger | 人工闸门批准后代答 `[Y/N]` 并记录 |

配套：`ChangeStore` 变更记录（谁/何时/改了什么/依据哪次快照，落盘 JSON）；
`core/rollback.ts` 是纯函数，撤销命令的视图上下文由「分段解析」（header + 缩进子行）保证，
段内 diff 时先 undo 新增行、再补回被删行（同参覆盖场景顺序正确）。

**发现并修复 1 个 v0.1 遗留缺陷**：`SnapshotStore` 用设备 ID（含冒号 `127.0.0.1:2008`）当目录名，
Windows 建目录会失败 —— 冒号已转义。所以 v0.1 的快照存留在 Windows 上修好前其实是不可用的（测试此前未覆盖 Windows 路径）。

**关键风险点的验证结论**（动工前列的 R1–R3）：

| 风险 | 结论 |
|---|---|
| R1 主进程能否用 ESM-only 依赖 | **不存在该问题。** `openai@7.18.0` 是双格式包（`type: commonjs`，`exports.require` → `index.js`），主进程 `require("openai")` 正常解析。这反过来验证了「用 openai SDK 而不引 pi-ai」的选型是对的 |
| R2 openai SDK 的可用性与中断 | 模块加载、客户端构造、流式接口、`AbortSignal` 传递全部可用。真实流式请求待配好 Key 后验证 |
| R3 严格 CSP 下的资源加载 | 通过。渲染产物只引用本地 `./assets/*`，无任何 CDN 外链（CSS 里仅有的两个 URL 是 xterm 的注释文本） |

**测试过程中发现并修复的 5 个真实缺陷**（都由集成测试暴露，不是构造出来的）：

1. **慢响应被提前收尾。** 设备回显命令后停顿 400ms 才吐输出时，300ms 的静默兜底会把命令判成已结束，代理拿到残缺回显却以为完整。改为弱判定必须满足「已有内容且以换行收尾」，否则等到 `stallMs`。
2. **命令回显折行识别失败。** VRP 的折行点是词中截断（`display current-config` / `uration`），累积比对时插空格反而对不上。改为两侧去空白比对。
3. **编码在握手阶段被错误锁定。** 握手内容通常全是 ASCII，此时锁定 UTF-8 会让后续出现的 GBK 中文描述被误解。改为只在出现非 ASCII 证据时才锁定。
4. **编码判定倾向 GBK。** 尝试用「哪种解码汉字更多」打分，但 GBK 几乎把任意字节对都映射成汉字，绝对数量反而更多，会系统性把 UTF-8 误判成 GBK。改回「严格 UTF-8 校验」为主判据，只对「合法但内容荒谬」（成片希伯来/阿拉伯文）的情况再兜底。
5. **确认提示原文丢失。** 设备在提示行后还带一个换行，直接取最后一行得到空串。改为先剥尾部空白再取行。

## v0.3：拓扑 + 多 provider（F-5.x）

两个并行增量，都按 pi 仓库（`earendil-works/pi`）的方法论落地：

**LLM 层换 `@earendil-works/pi-ai`**（决策过程见 [ARCHITECTURE.md §2.2](docs/ARCHITECTURE.md#22-为什么引-pi-ai-而不引-pi-agent-core)）：
- 主进程 ESM 化（`"type": "module"`），preload 保持 CJS + `sandbox: true`；
- `src/main/agent/llm/models.ts` 按设置装配：deepseek/custom 走 OpenAI Chat Completions 兼容线
  （`createProvider` + `openAICompletionsApi`，baseUrl/model 透传），openai/anthropic/google 走官方原生 API；
  provider 工厂全部**动态 import**（懒加载，不进首屏主进程包）；
- `llm/translate.ts` 把 pi-ai 事件流翻译成 AgentEvent（`text_delta→text`、`toolcall_end→工具调用`、
  thinking 跳过），tool-call 参数已是解析好的对象（干掉手写 partial-JSON 累积）；
- 工具 schema 全部迁移 **TypeBox**（由 pi-ai 反出），一份 schema 双出口，为 v0.4 MCP 铺路；
- 设置面板新增 provider 下拉（DeepSeek / OpenAI / Anthropic / Google / 自定义端点）。

**拓扑（F-5.1/5.3/5.4/5.5）**：
- `core/topology/`：领域模型（节点/链路/角色）+ LLDP 邻居推导（`parseLldpNeighbors` / `deriveTopology`）
  + `TopologyStore`（JSON 持久化，变更推 `topology:updated`）+ `mergeTopology`（手工优先合并）；
- 工具：`get_topology`（读合并结果）、`refresh_topology`（实采 LLDP 重推）；
- 画布：`features/topology/TopologyCanvas.tsx`（React Flow），支持拖动落位即保存、手动加节点、拖线连边，
  深浅主题走 CSS 变量；
- 顺延（P2）：工程文件解析（F-5.2）、实时链路状态（F-5.6）。

**测试增量 12 项**：事件翻译层（text/toolcall/thinking 映射）+ 拓扑核心（LLDP 解析、推导去重、
占位节点、跳过失败设备、手工合并）+ TypeBox 双出口回归（`required`/`properties`/枚举、danger 不外露）。

## v0.4：用得住（会话树 / 排队 / 报告 / MCP 出口）

- **会话树持久化 + 回溯（F-6.2）**：`core/session-tree/store.ts` 每个会话一个 JSONL
  （一行一节点，`parentId` 成树，pi 方法论）+ 索引原子写；AI 面板加「当前 / 历史」tab，
  历史是会话树浏览器，任一节点可「从这里继续」换路重走 — 历史先注入对话（`historyToMessages`），
  再跑新支链，增量落盘。
- **消息排队（执行中插话）**：`AgentRuntime.enqueue` 进队列，ReAct 每轮取模型前 drain 成 user 消息；
  UI 显示「已排队 ×N」，任务收尾未消费的输入会明示不丢。
- **报告导出（TOOLS §4.5）**：`list_sessions` / `export_session_report`（md / json），
  写 `userData/exports` 返回路径；历史 tab 可直接导出。
- **MCP 出口**：主进程内嵌 **Streamable HTTP**（`@modelcontextprotocol/sdk` + `node:http`，仅 127.0.0.1），
  设置里开关 + 端口，工具与内置代理共用一份 TypeBox schema（danger 不外露，MCP 调用不过闸门直接拒绝）。
  接 Trae / Claude：客户端支持本地 http URL 则直填 `http://127.0.0.1:<port>/mcp`；
  Claude Desktop 本地配置仅 stdio，可用 `npx mcp-remote http://127.0.0.1:<port>/mcp` 桥接。
- **顺延（P2）**：检查点恢复（F-3.9）。

**测试增量 10 项**：会话树（建根/追加/重载/路径/坏行容忍）、报告生成、队列注入、历史映射、
MCP 真实 transport 端到端（Initialize→ListTools→CallTool，临时端口裸 fetch）。

## v1.0 前置打磨（一键启动 + 工程文件解析）

- **一键启动**：`start.cmd`（双击）→ `start.ps1` 自动检测 Node、配 `ELECTRON_MIRROR` 镜像、
  缺依赖/二进制才 `npm install`、缺失给出手动兜底命令，再 `npm run dev`；附 `verify.cmd` / `test.cmd`。
- **工程文件解析 F-5.2**：画布「导入工程文件」按钮 → 系统文件框选 `.topo` →
  `core/topology/fromProjectFile.ts` 容错解析（明文 XML / gzip / UTF-16 / **真机 GBK 中文版**，
  无 XML 依赖），兼容真机 `<dev>` + `<line>` 结构、自闭合 interfacePair 与 cx/cy 坐标；
  有 `com_port` 的设备 `deviceId = 127.0.0.1:<port>`（与实采同形、可直接连接）；
  `mergeLayers` 三层合并（file 最权威、实采补缺、手动画覆盖），持久化旧数据兼容。
  工具 `import_topology_file` 同步注册进代理（白名单校验路径）。
- **UI/健壮性**：状态栏显示 provider · model；历史会话标题超长省略；启动失败显示错误 +
  重试（不再永远「正在启动…」）。

**测试增量 13 项**：.topo 解析（明文/gzip/UTF-16/中文名/interfacePair/0 设备 warning）+
真机格式校准（`<dev>`/`<line>` 链路/自闭合 interfacePair/cx/cy/GBK 解码/端到端 GBK 文件）+
三层合并（file 优先/deviceId 认亲/补缺/手动画覆盖/链路去重）。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 产品定位、用户场景、功能需求、v0.1 范围、验收标准、路线图 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层架构、进程模型、目录结构、数据模型、一次任务的完整时序 |
| [docs/TELNET-SPEC.md](docs/TELNET-SPEC.md) | 设备通信层重写规格：提示符状态机、分页、编码、错误识别、测试点 |
| [docs/TOOLS.md](docs/TOOLS.md) | Tool Registry 定义：工具分层、schema、风险等级与闸门规则 |
| [docs/UI-SPEC.md](docs/UI-SPEC.md) | 三栏布局、设计令牌、组件清单、双主题实现 |

## 核心决策速览

| 决策点 | 结论 |
|---|---|
| 产品形态 | Electron 桌面应用，单 exe 便携分发 |
| 技术栈 | Electron + React 19 + TypeScript，**无 Python 运行时依赖** |
| AI 角色 | 纯代理（一句话到结果），非副驾 |
| Agent 内核 | **自研精简 ReAct 循环** + `@earendil-works/pi-ai`（统一多 provider），不引 `pi-agent-core` |
| 通信层 | Node `net` + 提示符状态机整体重写 |
| 拓扑 | 结构化领域模型：LLDP 实采推导 + 画布手补（工程文件解析 P2） |
| 执行边界 | 只读自由 / 配置走快照事务校验回滚 / 破坏性命令人工闸门 |
| 界面 | 三栏（设备树 / 主舞台 tab / AI 常驻），深色为主可切浅色 |
| MCP | 已落地 v0.4：主进程内嵌 Streamable HTTP（127.0.0.1，设置开关），一份 TypeBox schema 双出口 |

决策依据与推导过程见 [ARCHITECTURE.md 的技术选型章节](docs/ARCHITECTURE.md#技术选型与依据)。

## 技术栈

| 关注点 | 选型 |
|---|---|
| 壳 | Electron（electron-vite） |
| 渲染 | React 19 + TypeScript + Vite |
| Agent 内核 | 自研 ReAct loop（`AgentRuntime` 接口 + real/mock 双实现）+ `@earendil-works/pi-ai` |
| 终端 | xterm.js |
| 拓扑图 | React Flow（`@xyflow/react`） |
| 状态 | Zustand |
| 持久化 | JSON KV + JSONL 快照目录（同 v0.2） |
| 设备通信 | Node `net` + 内置 `TextDecoder`（gbk） |
| Schema | TypeBox（由 pi-ai 反出，一份 schema 双出口） |
| 打包 | electron-builder → 单 exe 便携版 |

## 开发约定

- 所有源文件使用 **UTF-8** 编码（Linux/macOS 无 BOM；Windows 下若由脚本生成 `.cmd` 需转 GBK + CRLF）。
- 命令执行环境为 Windows 11 + PowerShell。
- 分层的硬边界：**渲染进程不持有任何 Node 权限**，所有特权操作经 preload 白名单 + IPC 进入主进程。
- 交付节奏：抽象接口 → real/mock 双实现 → bridge/preload 封装 → 测试 → 文档更新。

## 安全红线

本项目**只**操作本机 eNSP 虚拟设备，明确不做以下事情：

- 不扫描本机 `127.0.0.1` 以外的任何地址（不做局域网/公网探测）。
- 不绕过、不猜测、不爆破设备认证。
- 不在未经确认的情况下批量下发配置。
- 不在未做快照的情况下修改设备配置。
- 不持久化明文设备密码。
