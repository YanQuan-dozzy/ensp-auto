# Tool Registry 规格

工具定义是**唯一真相源**：同一份 typebox schema 同时喂给进程内代理与对外 MCP 出口。
这从根上避免了源项目「Flask 与 MCP 两份逻辑各写一遍」的问题。

## 1. 设计原则

1. **粒度对代理友好，而不是对人类友好。** 人不介意多点几次，代理介意多轮往返。
   因此提供 `get_device_context` 这类「一次拿全」的聚合工具，而不是让代理用
   `send_command` 反复试探 —— 每一次往返都是 token 与延迟。
2. **读写分离。** 只读命令与配置变更是两类工具，走两套权限路径，不共用一个入口。
   源项目的 `send_command` 把读写混在一起，是它无法做安全控制的结构性原因。
3. **token 预算可控。** 所有工具 schema 序列化后总量控制在约 4000 token 以内（含描述）。
   超出就说明工具切得太碎，应合并。
4. **返回格式统一。** 所有工具返回同一个 envelope，代理不必为每个工具记不同形状。
5. **风险显式声明。** 每个工具带 `risk` 与 `scope`，闸门与快照逻辑据此自动决策，
   不靠硬编码分支。

## 2. 统一返回格式

```ts
interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;        // 机器可判定，如 'UNRECOGNIZED' / 'NOT_ALLOWED_IN_READ_MODE'
    message: string;     // 人类可读说明
    raw?: string;        // 设备原始回显，用于排错
  };
  meta: {
    ms: number;          // 耗时
    deviceId?: string;   // 涉及设备
    settled?: 'prompt' | 'quiet' | 'confirm'; // 回显判定强度（透传自 TelnetClient）
  };
}
```

代理看到的就是这个 JSON。`error.code` 是代理做修正决策的依据，
`error.raw` 让它在必要时读原文自行判断。

## 3. 风险等级与作用域

```ts
type RiskLevel = 'read' | 'write' | 'danger';
type ToolScope = 'device' | 'local';
```

| `risk` | `scope` | 含义 | 策略 |
|---|---|---|---|
| `read` | `device` | 读设备状态，不改配置 | **自动执行**，无闸门 |
| `read` | `local` | 只改本地数据（别名、拓扑手补、报告落盘） | **自动执行**，无闸门 |
| `write` | `device` | 修改设备配置 | **强制先快照** → 事务下发 → 期望校验 → 失败可回滚 |
| `danger` | `device` | 破坏性操作，不可撤销 | **人工闸门**，等待显式批准 |

> `risk` 描述的是**对设备的侵入性**。本地数据操作不影响设备，故归 `read`，
> 靠 `scope: 'local'` 区分。

## 4. 工具清单

### 4.1 设备发现与连接

#### `scan_devices` — 扫描本机 eNSP 设备
```ts
{ start?: number (默认 2000), end?: number (默认 2050) }
→ { devices: { port: number; id: DeviceId; name?: string }[] }
```
`risk: read` · `scope: local`
> 主机地址硬编码 `127.0.0.1`，**schema 不暴露 host 参数**，从接口层面杜绝被改造成网络扫描器。

#### `connect_device` — 连接设备
```ts
{ port: number; name?: string }
→ { id, port, name, model?, vrpVersion?, prompt, view, encoding, banner? }
```
`risk: read` · `scope: device`
> `model` / `vrpVersion` 由 `display version` 解析得到，作为默认别名建议。

#### `list_devices` — 列出已知设备
```ts
{}
→ { devices: { id, port, name, connected, model?, view?, lastSeenAt }[] }
```
`risk: read` · `scope: local`

#### `disconnect_device` — 断开设备
```ts
{ deviceId: string }
→ { ok: true }
```
`risk: read` · `scope: device`
> 仅关闭会话，不改设备任何配置，故不是 `write`。

#### `rename_device` — 设备别名
```ts
{ deviceId: string; name: string }
→ { id, name }
```
`risk: read` · `scope: local`

### 4.2 只读交互

#### `get_device_context` — 一次拿全设备上下文 ★ 重点工具
```ts
{ deviceId: string }
→ {
    id, name, model, vrpVersion, prompt, view, encoding,
    uptime?: string,
    interfaces?: { name, ip?, mask?, status, protocol }[]
  }
```
`risk: read` · `scope: device`
**内部**并行执行 `display version` 与 `display ip interface brief` 并解析为结构化数据。
> 这是为代理专门设计的聚合工具。替代方案是让代理连发两条命令再自己解析文本 ——
> 既多一轮往返，又让模型做它不擅长的文本解析。**解析放在工具里做，结果喂给模型。**

#### `run_show_command` — 执行只读命令
```ts
{ deviceId: string; command: string }
→ { clean, prompt, view, settled, hasWarning?, truncated?, decodeIssues? }
```
`risk: read` · `scope: device`

**白名单前缀约束**：命令必须匹配 `^\s*(display|show|dir|more|ping|tracert)\b`。
不匹配则直接拒绝：

```json
{ "ok": false, "error": { "code": "NOT_ALLOWED_IN_READ_MODE",
  "message": "只读模式不允许该命令，如需修改配置请使用 apply_config" } }
```
> 这是在工具层的硬约束，不依赖提示词约束模型 —— 提示词会被绕过，代码不会。

#### `save_config_snapshot` — 采集配置快照
```ts
{ deviceId: string; label?: string }
→ { snapshotId, deviceId, label, sizeBytes, createdAt, hashShort }
```
`risk: read` · `scope: local`
> 读设备配置（只读），写本地库。内部执行 `display current-configuration`。

#### `list_snapshots` — 快照列表
```ts
{ deviceId: string }
→ { snapshots: { id, label, createdAt, sizeBytes }[] }
```
`risk: read` · `scope: local`

#### `diff_with_snapshot` — 与快照比对
```ts
{ deviceId: string; snapshotId: string }
→ { changed: boolean; diff: string }
```
`risk: read` · `scope: device`
> 采集当前配置与指定快照做行级 diff，用于「这个设备被人改过什么」。

### 4.3 配置变更（v0.2）

#### `apply_config` — 下发配置变更集 ★ 核心写工具
```ts
{
  deviceId: string;
  commands: string[];          // 按顺序下发的配置命令
  description: string;         // 变更意图，用于 UI 展示与变更记录
  expectation?: {              // 期望校验，用于自动判定成败
    command: string;
    expect: string;
    mode: 'contains' | 'notContains' | 'regex';
  };
  snapshotId?: string;         // 不传则自动采集
}
→ {
    ok, applied: string[],
    failed?: { index: number; command: string; errorCode: string; error: string },
    snapshotId, verified?: boolean, diff?: string
  }
```
`risk: write` · `scope: device`

**内部硬流程（不可跳过）**：
1. 断言该设备存在配置快照；无则先自动采集（采集失败 → 直接拒绝执行，返回 `NO_SNAPSHOT`）。
2. 逐条 scan 命令，命中危险清单 → 中止，返回 `DANGER_COMMAND_BLOCKED`。
3. 进入系统视图，**逐条下发**，每条都读回显判定成败。
4. 任一失败 → 立即停止后续下发，返回失败点索引与原始错误；**不自动回滚**，交由代理判断
   （可能只需补一条命令，盲目回滚反而更糟）。
5. 全部成功 → 若有 `expectation` 则执行校验。
6. 校验不达期望 → 返回 `verified: false` 并附实际回显，代理据此决定修正或回滚。

#### `verify_expectation` — 单独校验
```ts
{ deviceId: string; command: string; expect: string;
  mode: 'contains' | 'notContains' | 'regex'; times?: number }
→ { pass: boolean; actual: string }
```
`risk: read` · `scope: device`

#### `restore_snapshot` — 回滚到快照
```ts
{ deviceId: string; snapshotId: string; reason: string }
→ { ok, appliedCommands: number, diff?: string }
```
`risk: write` · `scope: device`

**闸门策略分两种情形**（这是刻意的区别对待）：
- **失败自动回滚**（同一任务内、由 `apply_config` 失败触发）：**不弹闸门**。
  回滚是安全网，如果回滚本身还要人批准，自动回滚就形同虚设。
- **用户/代理主动发起的回滚**：**弹闸门**。因为当前配置里可能有人手工做的改动，
  回滚会一并覆盖掉。

#### `save_configuration` — 保存配置到启动配置
```ts
{ deviceId: string }
→ { ok: true }
```
`risk: danger` · `scope: device`
> VRP 的 `save` 会触发 `[Y/N]` 确认。本工具在获批后代为应答，并记录到变更记录。

### 4.4 拓扑（v0.3）

MVP 三个只读工具；手动补画走画布直落库（`topology:save-manual`），不进工具集：

| 工具 | 参数 | 返回 | risk / scope |
|---|---|---|---|
| `get_topology` | `{}` | `Topology`（三层合并：工程文件 + 实采 + 手动补画） | `read` / `device` |
| `refresh_topology` | `{}` | `Topology`（对已连接设备实采 `display lldp neighbor` 重推 discovered 层） | `read` / `device` |
| `import_topology_file` | `{ path }` | `{ topology, report }`（.topo 解析为 file 层，最权威；含设备/链路数与 warning） | `read` / `local` |

三层降级合并（`mergeLayers`）：file 最权威（同设备按 deviceId 认亲，实采补缺、手动画覆盖坐标），
discovered 补 file 缺失的端点，manual 的坐标/链路 label 始终覆盖。
`.topo` 解析（`core/topology/fromProjectFile.ts`）无 XML 依赖、容错字段变体、兼容 gzip/UTF-16，
**真机版本差异待一份真实 .topo 校准**（解析 0 设备时给 warning 不崩溃）。

推导规则：每台已连接设备执行 `display lldp neighbor`，解析「本地接口 → 邻居名/邻居接口」；
按设备名匹配已知会话，未匹配的生成 `neighbor:<name>` 占位节点；两端互报的链路去重。
LLDP 未开启或命令失败则跳过该设备（best-effort，不阻塞）。

三层降级中**来源一（eNSP 工程/拓扑文件解析）与实时链路状态映射按 P2 顺延**，
合并规则 `mergeTopology`（手工优先、按 id 覆盖、链路按端点去重）见 [ARCHITECTURE.md §5.3](ARCHITECTURE.md#53-topologyservice)。

> 原计划的 `discover_topology` / `import_topology_file` / `upsert_topology_*` / `remove_topology_item`
> 在 v0.3 收敛为上面的最小集：`discover_topology` 即 `refresh_topology`，
> 单节点/边操作由画布工具直接调 `topology:save-manual` IPC（主进程白名单校验），不再另开工具。
> `import_topology_file` 随 F-5.2（P2）一起，防目录穿越校验届时落地。

### 4.5 报告（v0.4）

| 工具 | 参数 | 返回 | risk / scope |
|---|---|---|---|
| `list_sessions` | `{}` | `{ sessions: SessionNodeMeta[] }`（标题/创建/最近/消息数，按最近降序） | `read` / `local` |
| `export_session_report` | `{ rootId, format?: 'md' \| 'json' }` | `{ path }`（写入 `userData/exports/<标题>-<时间>.<ext>`） | `read` / `local` |

报告内容由 `core/session-tree/report.ts` 的纯函数生成（Markdown 按树序渲染 user/assistant/tool，
tool 带参数与成败；JSON 导出 `{ root, nodes }` 全文）；写盘由 `tools/sessions.ts` 的
`collectSessionReport` 承担，工具与 IPC（`session:export`）共用，避免两处实现。

> 会话树本身（`core/session-tree/store.ts`）是 v0.4 的报告数据源：每个会话一个 JSONL，
> 一行一节点、`parentId` 成树；列表页与代理共用同一份数据。

## 5. 危险命令清单

命中清单或结构规则的命令一律拦截，进入人工闸门。

**显式清单**（不区分大小写，忽略首尾空白）：

| 命令 | 后果 |
|---|---|
| `reboot` | 设备重启，实验中断 |
| `reset saved-configuration` | 清空启动配置 |
| `reset current-configuration` | 清空当前配置 |
| `erase startup-config` | 清空启动配置 |
| `delete /unreserved` | 永久删除文件，不可恢复 |
| `format` | 格式化存储 |
| `startup saved-configuration` | 篡改启动配置指向 |
| `undo startup saved-configuration` | 移除启动配置指向 |
| `rollback configuration` | 整机配置回退 |
| `save` | 把当前（可能错误的）配置固化为启动配置 |
| `factory-configuration` | 恢复出厂 |

**结构规则**（正则匹配即拦截）：

1. `^\s*undo\s+startup\b` —— 任何涉及启动配置的 undo。
2. `^\s*(clear|reset)\s+configuration\b` —— 任何清空性 configuration 操作。
3. `^\s*delete\s+.*\s/unreserved\b` —— 永久删除的任意写法。
4. `^\s*stop\s+` 类强制终止命令（部分版本存在）。

**闸门交互**：命中后代理的调用被挂起，UI 弹出确认框，展示设备、命令全文、
后果说明与当前是否有可用快照。用户批准后继续执行；拒绝则工具返回
`{ ok: false, error: { code: 'GATE_REJECTED' } }`，代理据此改道。

**闸门不可被代理绕过**：闸门的判定在 `ToolRegistry` 执行前，
不在提示词层。代理无法通过「换个措辞」或「声称已获批准」跳过它。

## 6. 单一真相源 → 双出口

```ts
// registry.ts
export const registry: ToolSpec[] = [
  scanDevices, connectDevice, listDevices, disconnectDevice, renameDevice,
  getDeviceContext, runShowCommand, saveConfigSnapshot, listSnapshots, diffWithSnapshot,
  applyConfig, verifyExpectation, restoreSnapshot, saveConfiguration,
  // v0.3+ ：topology.* / report.*
];

// 出口一：给进程内代理（function calling schema）
export function toLLMTools(): LLMFunction[] { ... }

// 出口二：给对外 MCP 服务（v0.4）
export function toMcpTools(): McpTool[] { ... }
```

两个出口都从同一份 `ToolSpec[]` 生成。MCP 出口默认**只暴露 `risk !== 'danger'` 的工具**，
破坏性工具需在设置里显式开启 —— 外部客户端不应拥有比应用内更强的权限。

## 7. token 预算

| 分组 | 工具数 | 预估 schema token |
|---|---|---|
| 发现与连接 | 5 | ~700 |
| 只读交互 | 5 | ~800 |
| 配置变更 | 4 | ~900 |
| 拓扑（v0.3+） | 3 | ~420 |
| 报告（v0.4） | 2 | ~250 |
| **合计** | **19** | **~3300** |

已注册 19 个（v0.1 10 个 + v0.2 4 个 + v0.3/前置拓扑 3 个 + v0.4 会话报告 2 个），保持上下文精简。
工具按版本分期注册，不一次性全塞给模型。

## 8. 待决事项

- `get_device_context` 是否应缓存结果（同任务内复用），避免代理反复调用。
  倾向加一个短 TTL 缓存（如 10s）并在返回里标注 `cached: true`，但需评估
  「代理以为在改已变更的状态」的风险。
- `apply_config` 的 `expectation` 是否允许传多条（多断言）。倾向允许数组，
  但要求全部通过才算 `verified: true`。
- 是否需要 `batch_apply_config`（跨设备一次下发）。倾向**不做**独立工具，
  而是让代理循环调用 `apply_config`，这样每一步都有独立的快照与失败点，
  出问题时定位成本低得多。
