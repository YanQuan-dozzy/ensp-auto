# 架构设计：ensp-auto

## 1. 架构总览

系统按「**能力在下，页面在上**」切成两层，中间只留一条 IPC 边界。

```
┌─ 渲染进程（React 19 / 无 Node 权限）──────────────────────────────┐
│  设备树         主舞台（tab）                  AI 面板            │
│  · 扫描/连接    · 拓扑画布 React Flow          · 消息流            │
│  · 别名/状态    · 终端 xterm.js                · 计划卡            │
│                                                · 工具调用卡        │
│                                                · 闸门弹窗          │
└──────────────────────── IPC 边界 ────────────────────────────────┘
        contextBridge 白名单 · 渲染进程不可直接访问 fs / net / db
┌─ 主进程（Node = 特权层）──────────────────────────────────────────┐
│  AgentRuntime 适配层          │  ToolRegistry                    │
│  · react.runtime（自研循环）  │  · 类型化 schema（typebox）       │
│  · mock.runtime（离线/测试）  │  · 风险等级 read/write/danger     │
│  ─────────────────────────────┴────────────────────────────────  │
│  DeviceSession 管理器                                            │
│  · 每设备命令队列（严格串行）  · 快照与回滚  · 期望校验            │
│  ──────────────────────────────────────────────────────────────  │
│  TelnetClient（整体重写）                                        │
│  · net socket  · 提示符状态机  · 分页续读  · 编码自适配            │
│  · 错误结构化  · 双通道（程序 / 交互）                            │
│  ──────────────────────────────────────────────────────────────  │
│  Store：SQLite（设备 / 快照 / 索引） + JSONL（会话树）             │
└──────────────────────────────────────────────────────────────────┘
                             │ TCP
                             ▼
              eNSP 虚拟设备 127.0.0.1:2000–2050
```

要点：

- **渲染层完全没有特权。** 想操作设备，唯一路径是 IPC。
- **AgentRuntime 与 ToolRegistry 平级。** 代理只负责「决定调什么」，工具负责「怎么调」，
  二者靠 schema 契约解耦。这也让「工具既给代理用、也对外暴露 MCP」成为自然结果。
- **DeviceSession 是并发的唯一收敛点。** 终端输入和代理命令都走同一条队列，从根上杜绝串包。
- **TelnetClient 不懂 eNSP 业务。** 它只负责「发一串字节、收回一段干净文本 + 一个提示符」，
  业务语义（视图、快照、校验）全在上一层。

## 2. 技术选型与依据

### 2.1 底座：为什么是 Electron + Node，且 Python 出局

不是偏好，是约束推出来的：

1. **「纯代理」必须先有 agent runtime**（ReAct 循环 + 工具调用 + 流式 + 中断 + 状态）。
   自研约 300 行即可，但必须跑在某个进程里。
2. **调研过的候选方案被逐个淘汰**：
   - `@earendil-works/pi-agent-core` / `pi-ai`：见 2.2，证据不支持。
   - 保留 Python 后端：源项目唯一有价值的 `TelnetConnection` 恰好是最大技术债，
     **本来就要重写**；`app.py` 的 Flask 路由与三个模块级全局字典在桌面化后全部作废。
     因此「复用 Python」的收益 ≈ 0，成本却是双运行时打包 + 双调试链路。
   - Tauri + Rust：无法复用任何既有积累，Telnet 层要从零 Rust 重写。
3. **结论**：`Electron + React + TypeScript`，`Node` 单特权层，无 Python 运行时依赖。

### 2.2 为什么引 pi-ai 而不引 pi-agent-core

对 `@earendil-works/pi-agent-core` 与 `pi-ai` 的实际包元数据取证结果（v0.3 复核，同 0.85.1）：

| 包 | `engines` | 模块格式 | 运行期依赖 |
|---|---|---|---|
| `pi-agent-core@0.85.1` | `node >= 22.19.0` | ESM only | chord、pi-telemetry、typebox、diff、ignore、yaml |
| `pi-ai@0.85.1` | `node >= 22.19.0` | ESM only | `@anthropic-ai/sdk`、`@google/genai`、`openai` 等（**子路径 import + 懒加载**，未用的 provider 不加载） |

**结论（v0.3 起成立，替换 v0.1 的旧结论）**：

1. **引 `pi-ai` 统一模型层，不引 `pi-agent-core`。** 原来的「体积不划算」论断被**子路径 provider import**（`@earendil-works/pi-ai/providers/openai` 等）推翻：
   provider 工厂全部动态 `import()`，anthropic/google 的原生 SDK 只在首次使用对应 provider 时才加载，不进首屏主进程包。
   官方三家的原生 API（Anthropic Messages / Google Generative AI / OpenAI Responses）由 pi-ai 统一收敛，
   换来的是多 provider（DeepSeek / OpenAI / Anthropic / Google / 任意 OpenAI 兼容端点）一套代码切换。
2. **端约束不再是障碍。** 主进程已 ESM 化（`"type": "module"`，preload 保持 CJS + `sandbox: true`），
   Electron 44 内置 Node ≥ 22.19 满足包要求。
3. **架构耦合理由仍然成立，且被坚持。** 工具循环是领域强耦合的 —— 权限闸门、配置快照、事务回滚、
   中断恢复、执行轨迹都长在自研循环里；`pi-agent-core` 不认识「设备 / 视图 / 快照」这些概念，
   套上去要一路与它的抽象对抗。所以**只借它的模型层**，循环还是自研的。
4. **TypeBox schema 双出口顺带落地。** 原「手写 JSON Schema 少一个依赖」的取舍不再必要：
   `pi-ai` 直接反出 TypeBox（`Type` / `TSchema`），工具 schema 迁移为 TypeBox 后，一份 schema 喂 LLM 与 MCP
   （TypeBox 对象即 JSON Schema），与 §2.3 选型清单的 typebox 行一致。

**继续采纳 pi 的方法论**（和 LLM 层一起）：

| 借鉴点 | 在本项目的落地 |
|---|---|
| 统一的 Models 集合（provider 工厂 + `models.stream`） | 每任务按设置装配，provider/baseUrl/model 即改即生效 |
| 每请求显式 `apiKey`（优先级最高） | 密钥继续走系统凭据库单槽，不经 IPC 回传 |
| 树状会话（JSONL + `parentId`） | 会话消息树，可回溯到任意节点换路重走（v0.4） |
| 执行中可排队输入 | 代理跑着的时候仍能发纠偏消息 / 后续指令（v0.4） |
| 权限层（所有特权操作过闸门） | 风险分级 + 破坏性命令强制人工确认（已落地） |

### 2.3 选型清单

| 关注点 | 选型 | 理由 |
|---|---|---|
| 壳 | Electron（electron-vite） | 单 exe 打包成熟；开发体验好 |
| 渲染 | React 19 + TypeScript + Vite | 生态与可维护性 |
| 状态 | Zustand | 事件流场景够用，比 Redux 轻 |
| 终端 | **xterm.js** | 关键一招。ANSI / 光标 / 分页 / 清屏天然支持，比手写 `div` 高一个量级 |
| 拓扑图 | React Flow | 交互式网络拓扑的事实标准，自定义节点/连线成熟 |
| Schema | typebox | 与 JSON Schema 同构，可同时喂给 LLM 与 MCP |
| 持久化 | better-sqlite3 + JSONL | SQLite 存结构化数据与索引，JSONL 存追加型会话树 |
| 设备通信 | Node `net` + `iconv-lite` | 纯文本 TCP，标准库足够；编码回退用 iconv-lite |
| 模型层 | `@earendil-works/pi-ai` | 统一多 provider（子路径 import 懒加载）；deepseek/custom 走 OpenAI 兼容线，openai/anthropic/google 走官方原生 API |
| 打包 | electron-builder | 单 exe 便携版 |

## 3. 进程模型与 IPC

### 3.1 职责划分

| 进程 | 职责 | 明确不做 |
|---|---|---|
| **主进程** | 设备通信、会话管理、快照、持久化、Agent 循环、模型调用、工具执行 | 不做 UI 渲染 |
| **渲染进程** | 界面渲染、本地 UI 状态、用户交互 | **不碰 `fs` / `net` / `child_process` / 数据库** |
| **preload** | 通过 `contextBridge` 暴露白名单 API，做参数校验与类型收窄 | 不含业务逻辑 |

安全配置：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、
严格 CSP（xterm 与字体必须本地打包，禁止走 CDN）。

### 3.2 IPC 通道

**invoke（渲染 → 主，请求/响应）**

| 通道 | 参数 | 返回 |
|---|---|---|
| `device:scan` | `{ start, end }` | `Device[]` |
| `device:connect` | `{ port, name? }` | `Device` |
| `device:disconnect` | `{ deviceId }` | `void` |
| `device:rename` | `{ deviceId, name }` | `Device` |
| `device:list` | — | `Device[]` |
| `terminal:write` | `{ deviceId, data }` | `void` |
| `terminal:resize` | `{ deviceId, cols, rows }` | `void` |
| `terminal:buffer` | `{ deviceId }` | `string`（历史缓冲，用于恢复） |
| `agent:run` | `{ sessionId, text }` | `void`（结果经事件流回传） |
| `agent:abort` | `{ sessionId }` | `void` |
| `agent:gate` | `{ gateId, decision }` | `void` |
| `snapshot:list` | `{ deviceId }` | `Snapshot[]` |
| `snapshot:save` | `{ deviceId, label }` | `Snapshot` |
| `snapshot:restore` | `{ deviceId, snapshotId }` | `void` |
| `settings:get` | — | `Settings` |
| `settings:set` | `Partial<Settings>` | `Settings` |

**event（主 → 渲染，单向推送）**

| 通道 | 载荷 |
|---|---|
| `device:scan-progress` | `{ scanned, total, found }` |
| `device:state-changed` | `Device` |
| `terminal:data` | `{ deviceId, chunk }` |
| `terminal:closed` | `{ deviceId, reason }` |
| `agent:event` | `AgentEvent` |
| `topology:updated` | `Topology` |

设计约束：**所有 invoke 通道的参数在主进程侧重新校验**，不信任渲染层传入的任何值；
设备 ID、命令字符串、文件路径都做白名单或格式校验。

## 4. 目录结构

```
ensp-auto/
├─ package.json
├─ electron.vite.config.ts
├─ tsconfig.json
├─ src/
│  ├─ main/                          # 主进程 = 特权层
│  │  ├─ index.ts                    # 窗口 / 生命周期 / 安全配置
│  │  ├─ ipc/
│  │  │  ├─ index.ts                 # 通道注册与统一校验
│  │  │  ├─ device.ts
│  │  │  ├─ terminal.ts
│  │  │  ├─ agent.ts
│  │  │  └─ settings.ts
│  │  ├─ core/
│  │  │  ├─ telnet/
│  │  │  │  ├─ TelnetClient.ts       # socket + 状态机 + 编码 + 分页
│  │  │  │  ├─ prompt.ts             # 提示符解析与视图判定
│  │  │  │  ├─ cleaner.ts            # ANSI / 退格 / 回显行清洗
│  │  │  │  ├─ errors.ts             # VRP 错误识别
│  │  │  │  └─ encoding.ts           # UTF-8 / GBK 探测与切换
│  │  │  ├─ session/
│  │  │  │  ├─ DeviceSession.ts      # 单设备会话：队列 + 双通道
│  │  │  │  ├─ SessionManager.ts     # 会话注册表与生命周期
│  │  │  │  ├─ snapshot.ts           # 配置快照采集与回滚
│  │  │  │  └─ expectation.ts        # 期望校验（回显断言）
│  │  │  ├─ topology/
│  │  │  │  ├─ model.ts              # 拓扑领域类型
│  │  │  │  ├─ fromProjectFile.ts    # 来源一：eNSP 工程文件
│  │  │  │  ├─ fromNeighbors.ts      # 来源二：lldp / 接口实采
│  │  │  │  └─ merge.ts              # 三层降级合并策略
│  │  │  └─ store/
│  │  │     ├─ db.ts                 # SQLite 连接与迁移
│  │  │     ├─ devices.ts
│  │  │     ├─ snapshots.ts
│  │  │     └─ sessionLog.ts         # JSONL 会话树读写
│  │  ├─ agent/
│  │  │  ├─ runtime.iface.ts         # AgentRuntime 接口（抽象）
│  │  │  ├─ react.runtime.ts         # 自研 ReAct 循环实现
│  │  │  ├─ mock.runtime.ts          # mock 实现（测试 / 离线）
│  │  │  ├─ loop.ts                  # 循环、中断、检查点
│  │  │  ├─ planner.ts               # 计划生成与提示词
│  │  │  └─ gate.ts                  # 闸门：请求、挂起、裁决
│  │  ├─ tools/
│  │  │  ├─ registry.ts              # 工具注册表（单一真相源）
│  │  │  ├─ device.ts                # 发现与连接类工具
│  │  │  ├─ command.ts               # 只读命令类工具
│  │  │  ├─ config.ts                # 配置变更类工具（v0.2）
│  │  │  ├─ topology.ts              # 拓扑类工具（v0.3）
│  │  │  ├─ report.ts                # 报告导出类工具
│  │  │  └─ mcp.adapter.ts           # 对外 MCP 出口（v0.4）
│  │  └─ settings/
│  │     ├─ store.ts                 # 配置读写
│  │     └─ secrets.ts               # 系统凭据库封装
│  ├─ preload/
│  │  └─ index.ts                    # contextBridge 白名单 API
│  ├─ shared/                        # 主/渲染共享的类型与常量
│  │  ├─ types.ts
│  │  ├─ channels.ts
│  │  └─ risk.ts                     # 风险等级与危险命令清单
│  └─ renderer/
│     ├─ index.html
│     ├─ main.tsx
│     ├─ App.tsx                     # 三栏布局骨架
│     ├─ features/
│     │  ├─ devices/                 # 左栏设备树
│     │  ├─ topology/                # React Flow 画布
│     │  ├─ terminal/                # xterm.js 终端
│     │  ├─ agent/                   # AI 面板：消息流 / 计划卡 / 工具卡 / 闸门
│     │  └─ settings/                # 设置面板
│     ├─ components/ui/              # 设计系统原子组件
│     ├─ stores/                     # Zustand
│     └─ styles/
│        ├─ theme.css                # 双主题 CSS 变量
│        └─ global.css
├─ tests/
│  ├─ unit/                          # 状态机 / 清洗 / 错误识别
│  ├─ mock-device/                   # 模拟 VRP 设备（用于无 eNSP 环境测试）
│  └─ e2e/
└─ resources/                        # 图标、字体（本地打包，禁 CDN）
```

## 5. 核心模块

### 5.1 TelnetClient

只做一件事：**发一串字节，收回一段干净文本 + 当前提示符 + 视图**。
详细规格见 [TELNET-SPEC.md](TELNET-SPEC.md)。

对外接口（双通道）：

```ts
interface TelnetClient {
  connect(host: string, port: number): Promise<{ banner: string }>;
  close(): void;

  // 程序通道：给代理用，返回清洗后的结构化结果
  exec(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult>;

  // 交互通道：给 xterm 用，透传原始字节流
  rawWrite(data: string): void;
  onRawData(cb: (chunk: Buffer) => void): () => void;

  onClose(cb: (reason: string) => void): () => void;
}

interface CommandResult {
  ok: boolean;
  clean: string;          // 清洗后回显（去 ANSI / 去回显行 / 去提示符）
  raw: string;            // 原始回显，供可观测与排错
  prompt: string;         // 结束时的提示符，如 "[Core-SW1]"
  view: ViewKind;         // 由提示符推断的当前视图
  error?: string;         // 识别到的 VRP 错误原文
  ms: number;             // 耗时
  truncated?: boolean;    // 是否因超过 512KB 上限被截断
}
```

### 5.2 DeviceSession

**并发的唯一收敛点。** 每个已连接设备持有一个 `DeviceSession`，内含：

- **命令队列**：Promise 链实现的严格串行队列。终端输入与代理命令共用同一条队列，
  从根本上杜绝两个来源同时写同一 socket 导致的串包与回显错位。
- **双通道**：程序通道的读操作用「拦截器」模式 —— 在读取窗口内同时把原始字节
  转发给交互通道（终端仍能看到代理在做什么），但只有程序通道的调用者拿到结构化结果。
- **快照与回滚**：`snapshot()` 采集 `display current-configuration` 全文入库；
  `restore(snapshotId)` 生成回退变更集并下发。
- **期望校验**：`expect(check)` 对回显做断言（正则 / 包含 / 不包含），
  供配置变更后自动判定成败。

### 5.3 TopologyService

拓扑是**结构化数据**，不是图片。三类来源按优先级降级合并（v0.3 落地为前两类中的两个）：

| 优先级 | 来源 | 状态 |
|---|---|---|
| 1 | `fromProjectFile` | 解析 eNSP 工程/拓扑文件，最权威。**P2 顺延**（格式需先采样真机 `.topo` 验证） |
| 2 | `fromNeighbors` | 从设备实采推导：`display lldp neighbor`（链路）。已落地（`core/topology/fromNeighbors.ts`） |
| 3 | 手动 | 用户在 React Flow 画布补画，权级最低。已落地（`topology:save-manual` IPC → `TopologyStore.applyManual`） |

合并规则（`core/topology/model.ts` 的 `mergeTopology`）：节点按 `id`（设备节点即 `deviceId`）归并，
手动节点覆盖坐标/名称并在结果上标记 `source: manual`（缺 `deviceId`/`model` 时从发现结果补齐），
链路按端点对去重、手动链路的 label 优先；`source` 字段标注来源供 UI 区分。

### 5.4 Store

| 存储 | 内容 | 形态 |
|---|---|---|
| SQLite | 设备别名与偏好、配置快照、快照索引、变更记录 | `better-sqlite3`，启动时执行迁移 |
| JSONL | 会话消息树 | **v0.4 已落地**：每会话一个 `sessions/tree-<rootId>.jsonl`，一行一节点含 `parentId`，追加写；root 摘要走 `sessions-index.json` 原子索引 |
| 系统凭据库 | 模型 API 密钥、设备凭据 | Electron `safeStorage` |

会话树用 JSONL 的理由：**分支不需要多文件**。整个会话历史在一个文件里，
靠 `parentId` 构成树，任意节点可回溯重走 —— 这是从 pi 借来的设计。
（实现见 `core/session-tree/store.ts`，报告生成见 `core/session-tree/report.ts`）

### 5.5 AgentRuntime

抽象接口 + 双实现，符合「抽象接口 + real/mock」的交付习惯：

```ts
export type RiskLevel = 'read' | 'write' | 'danger';

export interface AgentRuntime {
  /** 跑一轮任务，返回事件流；调用方通过 signal 中断 */
  run(input: RunInput): AsyncIterable<AgentEvent>;

  /** 人工闸门裁决 */
  resolveGate(gateId: string, decision: 'approve' | 'reject'): void;
}

export interface RunInput {
  sessionId: string;
  text: string;
  signal: AbortSignal;
}

export type AgentEvent =
  | { type: 'plan'; steps: string[] }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; callId: string; name: string; args: unknown; risk: RiskLevel }
  | { type: 'tool_end'; callId: string; ok: boolean; ms: number; summary: string; raw?: string }
  | { type: 'gate_request'; gateId: string; name: string; args: unknown; reason: string }
  | { type: 'gate_resolved'; gateId: string; decision: 'approve' | 'reject' }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'done'; reason: 'completed' | 'aborted' | 'failed' };
```

| 实现 | 用途 |
|---|---|
| `react.runtime.ts` | 生产实现。ReAct 循环 + `openai` SDK 流式 + 工具调度 + 闸门挂起 + 中断 |
| `mock.runtime.ts` | 测试与离线开发。按预设脚本回放事件流，不依赖网络与设备 |

路由开关：设置项 `agent.runtime = 'react' | 'mock'`，默认 `react`。

### 5.6 ToolRegistry

工具定义的**单一真相源**。每个工具声明 name / description / risk / typebox schema / handler。
`registry.ts` 同时提供两个导出：

- `toLLMTools()` —— 转成模型需要的 function-calling schema（进程内给代理）
- `toMcpTools()` —— 转成 MCP 工具描述（对外出口，v0.4）

一份定义两处出口，避免源项目「Flask 与 MCP 两份逻辑」的问题重演。
工具清单与 schema 见 [TOOLS.md](TOOLS.md)。

## 6. 数据模型

```ts
// 设备
type DeviceId = string;            // "127.0.0.1:2008"
type ViewKind = 'user' | 'system' | 'interface' | 'vlan' | 'ospf' | 'acl' | 'other';

interface Device {
  id: DeviceId;
  port: number;
  name: string;                    // 用户别名，默认取设备型号或端口
  connected: boolean;
  model?: string;                  // 由 display version 解析
  vrpVersion?: string;
  view?: ViewKind;
  encoding: 'utf8' | 'gbk';
  lastSeenAt: number;
}

// 会话消息树（JSONL 每行一个）
interface SessionNode {
  id: string;
  parentId: string | null;         // null = 根
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCall?: {
    callId: string;
    name: string;
    args: unknown;
    result?: unknown;
    ok?: boolean;
    ms?: number;
  };
  createdAt: number;
}

// 配置快照
interface Snapshot {
  id: string;
  deviceId: DeviceId;
  label: string;
  config: string;                  // display current-configuration 全文
  sizeBytes: number;
  createdAt: number;
}

// 拓扑
interface TopologyNode {
  id: DeviceId;
  label: string;
  deviceType: 'router' | 'switch' | 'firewall' | 'host' | 'unknown';
  source: 'project-file' | 'lldp' | 'manual';
  position: { x: number; y: number };
}

interface TopologyEdge {
  id: string;
  from: { deviceId: DeviceId; iface: string };
  to: { deviceId: DeviceId; iface: string };
  source: 'project-file' | 'lldp' | 'manual';
  status?: 'up' | 'down';
}

interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  updatedAt: number;
}
```

## 7. 一次任务的完整时序

以 S1「在三台设备上跑通 OSPF」为例：

```
渲染进程          主进程                                     eNSP 设备
   │                │                                            │
   │ agent:run ────▶│                                            │
   │                │ AgentRuntime.run()                         │
   │                │   ├─ 组装上下文（设备列表 + 拓扑 + 会话历史） │
   │                │   └─ 调模型，流式拿回计划                    │
   │ ◀── plan ──────│                                            │
   │                │                                            │
   │                │ tool: scan_devices           ──────────────▶ 端口探测
   │ ◀─ tool_start ──│                                            │
   │ ◀─ tool_end ────│                                            │
   │                │                                            │
   │                │ tool: connect_device(2008)                 │
   │                │   └─ TelnetClient.connect ─────────────────▶ 读 banner 到首个提示符
   │                │   └─ 主动关分页 screen-length 0 temporary ─▶
   │                │                                            │
   │                │ tool: get_device_context(2008)             │
   │                │   └─ exec("display version") ─────────────▶
   │                │   └─ 状态机读至提示符 → 清洗 → 解析型号     │
   │ ◀─ tool_end ────│                                            │
   │                │                                            │
   │                │ tool: save_config_snapshot(2008)   ← 写操作前置条件
   │                │   └─ exec("display current-configuration") ▶
   │                │   └─ 落库 snapshots                       │
   │                │                                            │
   │                │ tool: apply_config(...)  risk=write        │
   │                │   └─ 闸门判定 → 自动快照已就绪 → 下发       ▶
   │                │   └─ 逐条读回显，识别 % Unrecognized / Error:│
   │                │   └─ 全部成功 → 进入校验                    │
   │                │                                            │
   │                │ tool: verify_expectation("display ospf peer")
   │                │   └─ 断言 "Full" 出现 ──────────────────▶
   │                │   └─ 不达期望 → 回到模型请求修正（最多 N 轮） │
   │                │                                            │
   │                │ tool: export_session_report               │
   │ ◀── text ───────│  最终结论 + 变更摘要 + 快照 ID            │
   │ ◀── done ───────│                                            │
```

关键设计点：

- **写操作的前置条件是快照已就绪。** 快照失败则拒绝执行变更，这是硬约束而非提示。
- **每一步都先发 `tool_start` 再发 `tool_end`**，UI 因此能实时显示「正在做什么」。
- **校验失败不停机。** 回退给模型请求修正，循环上限后终止并保留全部现场。
- **闸门在循环内挂起**，不是执行后再问。等待期间任务状态为 `awaiting_gate`。

## 8. 安全边界的实现落点

| 边界 | 实现位置 |
|---|---|
| 渲染层无特权 | `BrowserWindow` 安全配置 + `contextIsolation` + 严格 CSP |
| 参数不被信任 | `ipc/index.ts` 统一校验，每个通道有独立校验器 |
| 只访问本机 | `TelnetClient.connect` 硬编码 `127.0.0.1`，扫描不接收主机参数 |
| 危险命令拦截 | `shared/risk.ts` 维护危险命令清单，`ToolRegistry` 与循环双重校验 |
| 写操作必先快照 | `DeviceSession.applyConfig` 内部断言快照存在，无则抛错 |
| 密钥不落明文 | `settings/secrets.ts` 封装 `safeStorage` |
| 输出不污染上下文 | `cleaner.ts` + `errors.ts`，代理只拿到 `CommandResult` 而非裸字节 |

## 9. 风险与动工前的 spike 计划

编码开始前必须先验证以下三项，任一项不通过都要调整方案：

| # | 风险 | 验证方式 | 不通过时的退路 |
|---|---|---|---|
| R1 | Electron 主进程加载 ESM-only 依赖（`openai` SDK）的打包可行性 | 建最小 electron-vite 工程，主进程 import 并调用一次 | 改用动态 `import()` 或降级依赖版本 |
| R2 | `openai` SDK 在 Electron 主进程的流式行为与超时控制 | 跑一次真实流式请求，验证可中断 | 退回手写 `fetch` + SSE 解析（约 80 行） |
| R3 | xterm.js 在严格 CSP 下的加载（含 CJK 等宽字体） | 本地打包后在渲染进程渲染中文回显 | 放宽 font-src，或改用自绘等宽方案 |

此外两个待验证的行为假设：

- **eNSP 工程/拓扑文件格式**（F-5.2 依赖）。在 v0.3 前不阻塞，届时先取样分析；
  若不可解析，三层降级会自动落到第二层，产品能力不受影响。
- **eNSP 设备回显的编码实际形态**（UTF-8 还是 GBK）。用真实设备实测，
  探测逻辑本身按「UTF-8 优先、失败回退 GBK」实现，两种都能覆盖。

## 10. 待决事项

以下在 v0.1 不阻塞，但需在对应版本前明确：

- 模型默认参数（温度、最大轮次、单次任务 token 预算上限）。
- 计划（plan）是否强制展示后再执行，还是默认直接执行 —— 倾向后者，
  但保留「大改动先出计划」的启发式（改动涉及设备数 ≥ 3 或命令数 ≥ 20 时）。
- 会话树的 UI 呈现方式（分支可视化在窄栏里怎么放）。
