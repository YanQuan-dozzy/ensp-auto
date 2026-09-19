# 设备通信层规格：TelnetClient

> 这是本项目技术含量最高、也最容易做错的一层。源项目的核心缺陷全部集中在这里。

## 1. 目标

对上层提供一件事：**发一串字节，收回一段可信的文本 + 当前提示符 + 当前视图 + 明确的成败判定**。

关键词是**可信**。整个「纯代理」架构成立的前提是：代理拿到的回显是干净的、完整的、
并且失败会被明确标注。源项目在这三点上全部不达标。

## 2. 源实现缺陷逐条对照

| 源实现 | 后果 | 本规格的处理 |
|---|---|---|
| `sock.settimeout(1)` + 连接后 `sleep(0.1)` | 握手时机不可靠 | 连接后读至首个提示符，丢弃 banner（§7） |
| `sock.send(cmd + '\r\n')` + 固定 `sleep(1.5)` | 快命令白等 1.5s，慢命令直接读不到 | 提示符状态机 + 静默兜底（§4） |
| 单次 `recv(8192)` | 超过 8KB 的输出必然截断 | 累积缓冲循环读，上限 512KB（§4、§9） |
| 无 `---- More ----` 处理 | 长输出（如 `display current-configuration`）直接卡住 | 主动关分页 + 自动续读双保险（§6） |
| `decode('gbk', errors='ignore')` | 无法解码的字符被静默丢弃，输出失真 | UTF-8 优先 + GBK 回退，禁止 `ignore`（§7） |
| 无并发保护，`devices[path]` 共享 | 两个来源同时写同一 socket 会串包 | 每设备严格串行队列（§10） |
| **错误文本被当成功返回** | 代理带着错误结果继续推理，越走越偏 | 错误结构化识别（§8） |
| 未处理 Telnet IAC 协商字节 | 输出头部混入不可见控制字节 | 剥离 IAC 序列（§9.1） |
| 无视图感知 | 代理不知道自己在哪个视图下 | 由提示符推断视图（§5） |

## 3. 协议事实

eNSP 虚拟设备在 `127.0.0.1:2000–2050` 上暴露 Telnet 服务，背后是华为 VRP 命令行。

### 3.1 提示符谱系

提示符直接暴露当前视图，这是本层最有价值的信息源。

| 提示符 | 视图 | 说明 |
|---|---|---|
| `<Huawei>` | `user` | 用户视图（尖括号） |
| `[Huawei]` | `system` | 系统视图 |
| `[Huawei-GigabitEthernet0/0/1]` | `interface` | 物理接口视图 |
| `[Huawei-Vlanif10]` | `interface` | VLANIF 接口视图 |
| `[Huawei-vlan10]` | `vlan` | VLAN 视图 |
| `[Huawei-ospf-1]` | `ospf` | OSPF 进程视图 |
| `[Huawei-ospf-1-area-0.0.0.0]` | `ospf` | OSPF 区域视图 |
| `[Huawei-acl-basic-2000]` | `acl` | ACL 视图 |
| `[Huawei-ui-vty0-4]` | `other` | VTY 用户界面视图 |
| `[~Huawei]` | `system` | 两阶段提交模式下未提交状态（部分版本） |

通用形式：`^([<\[~])([A-Za-z0-9_.\-]+)([^\n<>\[\]]*)([>\]])$`
组 1 是前括号，组 2 是主机名，组 3 是视图后缀，组 4 是后括号。

视图后缀 → 视图类型的映射规则（按后缀首段判定）：

| 后缀特征 | 视图 |
|---|---|
| 无后缀且前括号为 `<` | `user` |
| 无后缀且前括号为 `[` | `system` |
| 以 `GigabitEthernet` / `Ethernet` / `Vlanif` / `Serial` / `LoopBack` 开头 | `interface` |
| 以 `vlan` 开头 | `vlan` |
| 以 `ospf` 开头 | `ospf` |
| 以 `acl` 开头 | `acl` |
| 其他 | `other` |

### 3.2 分页

长输出会触发分页标记，典型形态 `---- More ----`。设备在等你按键，不会自行继续。

### 3.3 交互确认提示

部分命令会停下来等 `[Y/N]` 确认，例如 `reboot`、`reset saved-configuration`、`save`。
**这类提示绝不能被自动应答** —— 这是破坏性操作的最后一道人工防线。

典型形态：

```
Warning: All the configuration will be saved to the configuration file...
Are you sure to continue? [Y/N]:
```

### 3.4 首次连接握手

连接后设备可能先输出 banner（VTY 用户数提示、登录时间等），然后才出现第一个提示符。
若设备启用了认证，会先出现 `Username:` 或 `Password:` 提示。

## 4. 状态机

```
                  ┌──────────────────────────────────────────┐
                  ▼                                          │
   ┌───────┐  exec()  ┌─────────┐  有数据  ┌─────────┐        │
   │ IDLE  │─────────▶│ SENDING │─────────▶│ READING │        │
   └───────┘          └─────────┘          └────┬────┘        │
        ▲                                       │             │
        │                       ┌───────────────┼──────────────┐
        │                       │               │              │
        │              检测到分页标记      检测到确认提示   命中提示符
        │                       │               │       或静默兜底
        │                       ▼               ▼              │
        │                 ┌─────────┐    ┌──────────────┐       │
        │                 │ PAGING  │    │ AWAIT_CONFIRM│       │
        │                 └────┬────┘    └──────┬───────┘       │
        │                      │ 发空格          │ 交由上层裁决  │
        │                      └───────▶ READING │              │
        │                                       ▼              │
        │                                  ┌─────────┐         │
        └──────────────────────────────────│  DONE   │◀────────┘
                                           └─────────┘
                       超时或超上限 → TIMEOUT / TRUNCATED
                       socket 关闭 → CLOSED（队列剩余项全部 reject）
```

### 4.1 终止判定的双条件

难点在于「怎么知道输出结束了」。**只用提示符会漏（某些输出末尾无提示符或提示符被 ANSI 包裹），
只用静默期会误判（慢响应的命令会被提前截断）。** 因此两个条件并行，取先满足者：

| 条件 | 判定强度 | 说明 |
|---|---|---|
| 缓冲区尾部匹配提示符正则 | **强**（`settled: 'prompt'`） | 允许尾随空白与 ANSI 残留 |
| 距上次收到数据静默 ≥ `quietMs`（默认 300ms）且缓冲区非空 | **弱**（`settled: 'quiet'`） | 标记为弱判定，上层可据此判断是否可疑 |

强判定优先。若强判定与弱判定同时满足，取强。
`CommandResult` 中的 `settled` 字段会把判定强度透传给代理 —— 这对代理很重要：
弱判定的输出可能不完整，代理可以决定是否重读一次。

### 4.2 超时与上限

| 参数 | 默认 | 行为 |
|---|---|---|
| `timeoutMs` | 15000 | 整个命令（含分页续读）的总时限，超时返回 `TIMEOUT`，保留已读内容 |
| `quietMs` | 300 | 静默兜底窗口 |
| `maxBytes` | 512 × 1024 | 超出则截断，返回 `truncated: true` 并保留头尾各一半 |
| `charDelayMs` | 0 | > 0 时逐字符发送并延迟，用于兼容个别对输入速率敏感的设备 |

## 5. 提示符解析与视图推断

```ts
interface PromptInfo {
  raw: string;       // 完整提示符原文
  host: string;      // 主机名，如 "Huawei"
  suffix: string;    // 视图后缀，如 "GigabitEthernet0/0/1"
  view: ViewKind;    // 推断结果
  uncommitted: boolean; // 是否带 ~ 前缀
}
```

解析在**清洗之后**进行（先剥离 ANSI 与退格，否则括号可能被转义序列打断）。
匹配策略：从缓冲区末尾向前扫描，取最后一个「行首开始、行尾结束」的匹配，
避免把输出正文里的 `[xxx]` 误判为提示符。

## 6. 分页处理

**双保险**：

1. **主动关闭**（首选）：连接建立后立即执行 `screen-length 0 temporary`。
   这是 VRP 用户视图下的合法命令，作用范围仅当前会话，不改变设备持久配置。
   执行失败不致命（部分模拟设备可能不支持），降级到方案 2。
2. **自动续读**（兜底）：状态机在 `READING` 中持续检测分页标记（正则 `/-{2,}\s*More\s*-{2,}/i`，
   允许被 ANSI 包裹）。检测到即写一个空格继续读，循环直到提示符出现或超时。

续读次数计入日志，若单条命令续读超过 200 次则判定异常并终止，避免无限循环。

## 7. 编码处理

| 阶段 | 做法 |
|---|---|
| 默认 | 按 UTF-8 宽松解码，检测是否出现替换符 `U+FFFD` |
| 出现替换符 | 改用 GBK 解码同一段字节，比较「替换符数量」，取更少者 |
| 首个提示符后 | 用已确定结果锁定该会话编码，后续一致使用 |
| 手动覆盖 | 设置项 `device.encoding = 'auto' \| 'utf8' \| 'gbk'`，`auto` 为默认 |

**硬性要求：不使用 `errors='ignore'`。** 无法解码的字节保留为替换符，
并在 `CommandResult` 上置 `decodeIssues: true`，让代理知道这段文本可能有损。

解码在**字节层**累积后再做：因为多字节字符可能跨越两次 `recv` 的边界，
必须先在 Buffer 层拼接到完整行再解码，否则会出现「半个汉字」的乱码。

## 8. 错误识别

回显中的错误文本被结构化为 `{ ok: false, error, errorCode }`，这是本层最重要的产出。

| 匹配模式 | `errorCode` | 含义 | 建议动作 |
|---|---|---|---|
| `Error: Unrecognized command` / `% Unrecognized command` | `UNRECOGNIZED` | 命令不存在 | 修正命令拼写 |
| `Error: Incomplete command` / `% Incomplete command` | `INCOMPLETE` | 命令不完整 | 补参数 |
| `Error: Ambiguous command` / `% Ambiguous command` | `AMBIGUOUS` | 命令有歧义 | 补全唯一前缀 |
| `Error: Wrong parameter` / `% Wrong parameter` | `BAD_PARAM` | 参数非法 | 检查参数取值 |
| `Error: Too many parameters` | `TOO_MANY_PARAMS` | 参数过多 | 减少参数 |
| `% Invalid input detected` | `INVALID_INPUT` | 输入非法 | 修正命令 |
| `Error: The command is being executed, please wait` | `BUSY` | 上一条未执行完 | 短暂等待后重试 |
| `Error: You do not have permission` | `NO_PERMISSION` | 权限不足 | 先切换视图 |
| `Error: Failed to .*` | `FAILED` | 操作失败 | 读原文与 `^` 定位判断 |
| `^` 单独成行（前有 `Error:`） | — | 错误定位标记 | 与上一条错误组合使用，指认出错位置 |

不判为失败的模式：

| 模式 | 处理 |
|---|---|
| `Info: ...` | 保留在 `clean` 中，`ok` 不受影响 |
| `Warning: ...` | 保留在 `clean` 中，`ok` 不受影响，但在结果上置 `hasWarning: true` |
| `---- More ----` | 属于分页标记，已在 §6 处理，不进 clean |

判定顺序：先查错误表，命中则 `ok = false`；否则查确认提示；
否则若命中提示符则 `ok = true`。

## 9. 输出清洗

`cleaner.ts` 按固定顺序执行，顺序不可调换：

1. **剥离 Telnet IAC 序列**：`0xFF` 后跟命令字节，含 `IAC SB ... IAC SE` 子协商段。
   对 `IAC WILL/DO` 不回应（eNSP 场景下简单忽略即可，避免协商状态机复杂度）。
2. **剥离 ANSI 转义序列**：CSI（`\x1b\[[0-9;?]*[ -/]*[@-~]`）、OSC（`\x1b\][^\x07]*\x07`）、
   单字符转义（`\x1b[@-Z\\-_]`）。
3. **处理退格**：`\x08` 删除前一个字符；`\x08 \x08` 三元组同样处理（覆盖式重绘）。
4. **归一化换行**：`\r\n` → `\n`，孤立的 `\r` → `\n`。
5. **去除命令回显行**：首行若与发送的命令匹配（忽略首尾空白与大小写），整行删除。
   设备可能把长命令折行回显，因此比较时先拼接连续的回显片段。
6. **去除尾部提示符**：末尾的提示符从 `clean` 移除，单独放在 `prompt` 字段。
7. **清理分页残留**：残留的 `---- More ----` 行与用于推进的空格回显。
8. **压缩空行**：首尾空行删除，连续空行压缩为一个。

`raw` 字段保留未清洗的原始文本（仅剥离 IAC，因为它是协议层字节而非内容），
用于可观测与排错。UI 上「查看原始回显」显示的就是它。

## 10. 并发与队列

**每设备一条严格串行队列**，终端输入与代理命令共用：

```ts
interface QueueItem {
  id: string;
  kind: 'program' | 'interactive';
  command?: string;
  enqueuedAt: number;
  resolve: (r: CommandResult) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
}
```

规则：

- 队列长度上限 100，超限直接拒绝并入队失败（防止代理失控堆积）。
- `AbortSignal` 支持：中断时若该命令正在执行，其已读内容仍返回（`ok: false, error: 'ABORTED'`）；
  若尚未执行，从队列移除并 reject。
- 队列项执行前再次校验会话存活，已关闭则直接 reject。
- **交互通道的输入同样入队**，不享有插队特权。若用户觉得「我敲了没反应」，
  是因为代理正在执行长命令 —— UI 需在终端上明确提示「队列中 3 条，等待中」。

## 11. 双通道

| 通道 | 使用者 | 行为 |
|---|---|---|
| **程序通道** `exec()` | 代理 / 工具 | 入队执行，返回清洗后的 `CommandResult` |
| **交互通道** `rawWrite()` / `onRawData()` | xterm 终端 | 入队执行；原始字节实时转发给订阅者 |

关键点：**同一时刻只有一个通道在向 socket 写入**（队列保证），
但程序通道执行期间，读取到的原始字节会同时转发给交互通道 ——
这样用户能实时看到代理在设备上做了什么。设置项 `terminal.echoAgentCommands`
（默认开）控制是否在终端里以区分色标注代理下发的命令。

断线时：`onClose` 回调触发 → 会话标记 `CLOSED` → 队列剩余项全部 reject →
UI 上该设备条目变灰并提供一键重连。**v0.1 不做自动重连** —— 静默重连会掩盖问题，
让代理在不知情的情况下对着新连接继续执行旧计划，风险大于便利。

## 12. 连接建立流程

```
1. socket.connect('127.0.0.1', port)   // 主机地址硬编码，不接受外部传入
2. 启动 IAC 剥离
3. 读至首个提示符，超时 10s
   ├─ 命中 Username:/Password: → 返回 needsAuth，交由上层处理（v0.1 仅提示）
   └─ 命中提示符 → banner = 提示符之前的全部内容
4. 尝试 exec('screen-length 0 temporary')
   ├─ 成功 → pagingDisabled = true
   └─ 失败 → 记录并降级为自动续读
5. 锁定会话编码
6. 注册到 SessionManager，返回 { banner, prompt, view, encoding }
```

## 13. 可配置项

集中在 `src/main/core/telnet/patterns.ts` 与设置项中，便于按真实设备调整：

```ts
interface TelnetOptions {
  timeoutMs: number;        // 15000
  quietMs: number;          // 300
  maxBytes: number;         // 524288
  charDelayMs: number;      // 0
  maxPagingHops: number;    // 200
  encoding: 'auto' | 'utf8' | 'gbk';  // 'auto'
  disablePagingOnConnect: boolean;    // true
  host: '127.0.0.1';        // 固定
}
```

> **诚实声明**：本文档中关于 VRP 提示符形态、错误文案、分页标记、确认提示的描述，
> 基于 VRP 的通用行为。eNSP 各版本模拟出的行为可能存在差异。
> 因此**所有正则与文案表必须集中在一处**（`patterns.ts`），
> 实现完成后必须用真实设备实测校准一次，并把实测差异补回本文档。

## 14. 测试点清单

### 14.1 单元测试

| 用例 | 输入 | 期望 |
|---|---|---|
| 提示符解析 | §3.1 全部 10 种形态 | 视图与主机名解析正确 |
| 提示符误判防护 | 输出正文含 `[OK]` 行 | 不被当作提示符 |
| 清洗 · ANSI | 含 CSI / OSC / 单字符转义 | 全部剥离，文本完整 |
| 清洗 · IAC | 含 `IAC WILL ECHO` 与子协商 | 全部剥离，不回应 |
| 清洗 · 退格 | `abcd\x08\x08xy` | 结果为 `abxy` |
| 清洗 · 回显行 | 首行为发送的命令 | 首行被删除 |
| 清洗 · 中文 | UTF-8 与 GBK 两种字节 | 解码正确，无替换符 |
| 错误识别 | §8 表中全部模式 | `errorCode` 与 `ok` 正确 |
| 非错误模式 | `Info:` / `Warning:` / `^` 行 | `ok` 为 true，`hasWarning` 正确 |

### 14.2 集成测试（对 Mock 设备）

需要一个**可编程的 Mock VRP 设备**（本地 TCP 服务），模拟：回显、分页、错误、
确认提示、慢响应、中途断线、GBK 输出。这让测试完全不依赖 eNSP，可进 CI。

| 用例 | 场景 | 期望 |
|---|---|---|
| 普通命令 | 回显 + 输出 + 提示符 | `ok=true`，`clean` 正确，`settled='prompt'` |
| 长输出分页 | 注入 3 页，每页等空格 | 自动推进，输出完整无缺失 |
| 错误命令 | 返回 `% Unrecognized command` | `ok=false`，`errorCode='UNRECOGNIZED'` |
| 确认提示 | 返回 `[Y/N]:` | `settled='confirm'`，**不被自动应答** |
| GBK 输出 | 返回 GBK 编码中文 | 解码正确，编码被锁定为 gbk |
| 慢响应 | 首字节延迟 400ms | 静默兜底不提前结束，`settled='prompt'` |
| 静默超时 | 设备只回显不回提示符 | `settled='quiet'` 且透传该标记 |
| 并发 20 条 | 交替发 20 条命令 | 顺序正确，无交叉，无回显错位 |
| 中断 | 执行中 abort | 及时返回，队列不阻塞 |
| 中途断线 | 读到一半关 socket | 剩余队列项全部 reject，`CLOSED` 事件触发 |
| 超大输出 | 注入 > 512KB | `truncated=true`，头尾保留 |

### 14.3 真实设备验证（必须手工执行一次）

用真实 eNSP 设备跑：`display version`、`display current-configuration`、
`display ospf peer`、一条错误命令、一条中文描述配置，逐项核对并回写本文档的实测差异。
