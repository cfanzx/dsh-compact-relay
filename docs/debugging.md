# 排查手册（给会话里的 agent 自己看）

> 0.5.6 Phase A：动作事件流 + 失败留档 + 只读 CLI。
> 面向开发者 / 会话里的 agent；用户文档见 [README.md](../README.md)。
> **本文件里的路径一律用 `$DSH_HOME`（缺省 `~/.dsh`）或脚本相对路径**；事件文件属于本地诊断数据，
> 不要直接贴进公开 issue —— 对外只给 `export` 生成的脱敏包。

## 0. 开场三条命令

```sh
node scripts/dcr-debug.mjs state            # 当时压力/摘要数/原生线（读 state 快照）
node scripts/dcr-debug.mjs events --last 20 # 最近 20 个动作（start/end 已折叠）
node scripts/dcr-debug.mjs failures         # 最近失败/取消（含宿主原始 message）
```

已经装成 npm 包（不在仓库里）时，把 `scripts/dcr-debug.mjs` 换成插件目录下的同一个文件：
`node <插件目录>/scripts/dcr-debug.mjs …`。它随 `lib/cli/` 一起进包，Windows 也能用。

## 1. 命令速查

| 命令 | 作用 | 主要参数 |
|---|---|---|
| `events` | 动作事件表（默认折叠 start/end） | `--last N`(20) `--action X` `--outcome fail` `--session S` `--raw` `--json` `--file P` |
| `failures` | 最近失败/取消（排除 busy/changed 这类正常状态） | `--last N`(10) `--action X` `--json` `--file P` |
| `show <id>` | 一条动作的两阶段 + 完整 context + 文件行号 | id 可用末尾 8 位；`--json` `--file P` |
| `state` | 压力/摘要/原生线；默认读 `$DSH_HOME/compact-relay-state.json` | `--url <本机地址>` `--session S` `--json` `--offline` |
| `logs` | 从已知日志位置捞 `compact-relay` 相关行 | `--tail N`(80) `--grep S` |
| `export` | 自包含诊断包（Markdown + 内嵌 JSON，已脱敏） | `--out FILE` `--last N`(30) `--force` |

退出码：`0` 成功（含 0 条记录）、`2` 用法错误、`3` 宿主不可达、`4` 宿主鉴权失败、`5` 数据文件错误。

真实输出（本机夹具）：

```text
$ node scripts/dcr-debug.mjs events --last 4
时间                         动作               结果    耗时     trigger   code             关联           id                      message
2026-10-30T15:40:02+08:00  handoff-preview  fail  1.8s   external  INVALID_REQUEST  —            evt-20261030T154000-b…  DeepSeek Messages tool calls need immediate results…
2026-10-30T15:30:12+08:00  compact          ok    12.0s  ui-menu   —                comp c-1234  evt-20261030T153000-a…

4 条 / 全部 6 条（fail 2，cancelled 1） · /…/.dsh/compact-relay-events.jsonl · 2.0KB · 最近写入 …
下一步：node scripts/dcr-debug.mjs show evt-20261030T154000-bbbbbbbb
```

## 2. 数据从哪来（三份文件，各管一件事）

| 文件 | 内容 | 隐私口径 |
|---|---|---|
| `$DSH_HOME/compact-relay-events.jsonl` | `dcr-event/v1`：每个 A 级动作 **start + end 两行**（共享 `id`）；B 级只在失败时记一行 end | 本地档：删凭据/邮箱，**保留路径**、`$HOME` 缩成 `~`；800 行上限，失败保护最近 200 条 |
| `$DSH_HOME/compact-relay-state.json` | `state` 快照（白名单投影 + sessionId + 时间/版本） | 仅本机；≤8KB、10s 节流、原子写 |
| `$DSH_HOME/compact-relay-ledger.jsonl` | 成功指标账本（只数值、只成功，0.4 起冻结） | 不参与本手册的失败排查，一行未改 |

失败**没有**独立文件：`outcome:'fail'` 的行就是失败记录，`failures` 命令 / 诊断端点
`events.recentFailures` 都是读侧投影（总计划 D1）。

## 3. 场景

### A「压缩后不对劲 / 压得太狠」

```sh
node scripts/dcr-debug.mjs events --action compact --last 5
node scripts/dcr-debug.mjs show <id>
```

看 `context`：`startSeq`/`endSeq`（压了哪段）、`shadowedTokens`、`pinnedKept`、`phase`。
失败时 `code` 是稳定错误码（`commit` / `persistence` / `shrink` / `summary` / `busy`…），
`message` 是宿主/摘要器的原始报错（≤300 字符）。需要和会话日志 `compaction/start|end` 对号时，
用 `compactionId`（失败也会挂上，0.5.6 起）。

### B「交接失败 / 没进新会话」

```sh
node scripts/dcr-debug.mjs failures --last 5
node scripts/dcr-debug.mjs show <失败 id>
```

四段定位：压制前置（`action=compact`）、写九段（`handoff-preview`/`handoff` 的 `attempts`、`ready`）、
写盘（`message` 里带目录错误）、建会话（`childId` 是否有值）。`pairing-tail` = 会话尾部还有未完成的
工具调用：等这一轮跑完，或在输入框发一条消息让它收尾，再预览/交接（0.5.6 起返回 409 而不是 500）。

### C「接力条不显示」

> 0.5.6-C 起，完整取证表达式 + 判读表（A1 / A2 / B3 / C 四种成因）见
> **[relay-bar-debug.md](relay-bar-debug.md)**。下面是命令行侧的排查顺序。

1. 数据在不在：`events --action handoff`；`handoff` 的 `childId` 是否有值；
2. 投影对不对：`GET /api/compact-relay-chain?sessionId=…`（顺带看 `state` 的
   `chain` / `hasParent` / `sessionId`）；
3. 渲染对不对：浏览器 Console 一条表达式读
   `document.documentElement.dataset.crRelay{Dock,Chain,State}` 与
   `[data-cr-level]` 的 `data-cr-chain`；`crRelayDock` 缺失 = 组件没挂载或崩过被宿主下线。

0.5.6-C 已给 A1（有父无链）/A2（宿主没加载会话）加磁盘兜底，并修掉 0.5.2–0.5.5 的
hooks 顺序崩溃；真机仍要一次输出才能确认 Win 上命中的是哪一条。

### D「弹了个红 toast / 报错」

```sh
node scripts/dcr-debug.mjs failures --last 5
```

没有记录时先判断「版本/埋点」：`events` 一条都没有 → 插件 < 0.5.6 或刚装还没动作；
有 `v` 字段可排除「旧版没埋点」。`busy`/`changed` 不写失败投影（双击/范围变化是正常状态）。

### E「长动作一直转 / 202 pending / job 查不到」

0.5.7 起压缩、交接、交接预览都是「起 job → 轮询」；先分清卡在哪一层：

| 现象 | 含义 | 下一步 |
|---|---|---|
| `job-start` 200，`status:'running'` | 任务已进内存表，模型调用在后台跑 | 用返回的 `jobId` 轮询 `job-status`；不要重发动作 |
| 旧动作（`compact`/`handoff`/`handoff-preview`）返回 **HTTP 202** | 15s 兼容预算内没跑完，body 是 `{ok:false, code:'pending', pending:true, jobId, kind, message}` | **job 没有失败也没有中止**；拿 `jobId` 接着轮询，不要重试旧动作 |
| `job-status` 200，`status:'running'` | 还在跑；`elapsedMs` 是已耗时 | 500ms 一次轮询即可（客户端上限 5 分钟） |
| `job-status` 200，`status:'done'` | 完成，`result` 与旧同步响应同形 | 直接用 `result` |
| `job-status` 200，`status:'error'/'cancelled'` | 失败/取消；`error:{code,message}`，取消不是 fail | 失败走事件流看 `code`；取消是中性结果 |
| `job-status`/`job-cancel` **404 `code:'nojob'`** | 任务不存在、已过 TTL，或**宿主重启清空了内存表** | 提示用户「任务已中断，请重试」；事件流仍可能留下 start 行 |

`job-cancel` 返回 `{ok:true, cancelled, jobId, status}`；任务已结束时 `cancelled:false`、状态不变（幂等）。
jobs 表是**内存表**：TTL 10 分钟（settle 后）、上限 50 条、running 不淘汰、**宿主重启即丢**。
`job-start` 的幂等键是 `sessionId + kind + 参数`：同 key running 复用；同会话同 kind 不同参数 → 409 `busy`。

**用 dcr-debug 找 jobId**：`jobId` 在动作事件的 `context` 里（`compact` / `handoff-preview` / `handoff`
的 start 与 end 两行同值）：

```sh
node scripts/dcr-debug.mjs events --action handoff --last 5
node scripts/dcr-debug.mjs show <id>          # context: jobId=dcrjob-…
node scripts/dcr-debug.mjs events --raw --last 10   # 想看两行原始记录时
```

**stalled 怎么读**：进程被杀/卡死时只剩 start 行、没有 end 行。读侧在 start 超过 **10 分钟**后把它折叠成
`outcome:'stalled'`；`show <id>` 的表头直接打印 `stalled/running`（end 缺失），`events` 表的结果列显示
`stalled`。它不是 `fail`、没有 code，含义是「这次动作没有正常收尾」；若同时 `job-status` 404，
基本可判定宿主重启/崩溃。10 分钟内只显示进行中，不要过早下结论。

### F「客户端自己报的错（client-error）」

0.5.7 新增 B 级动作 `client-error`：浏览器侧遇到 **fetch 抛错 / 非 2xx / 空 body / 404 nojob / 超时**
时上报一次（同一次失败只报一次，`busy`/`changed`/`cancelled` 属业务语义不报）。事件 `context` 固定三个字段：

| 字段 | 内容 | 上限 |
|---|---|---|
| `status` | HTTP 状态码；网络错误为 `0`（缺省不写） | 数字 |
| `bodyHead` | 响应体开头，用来判断是不是网关/宿主返回的 HTML 或错误 JSON | **80 码点**（客户端按码点裁，不切坏 emoji） |
| `kind` | 失败类型短串：`network` / `http` / `empty` / `pending`（202 但没 jobId）/ `nojob` / `timeout` / 轮询错误码 | 80 字符 |

```sh
node scripts/dcr-debug.mjs failures --action client-error --last 5
node scripts/dcr-debug.mjs show <id>
```

`code` 取客户端带的错误码（没有则 `client`），`statusCode` 是 HTTP 状态；`message` 是客户端文案。
如果 `bodyHead` 是 HTML（`<!doctype` / `<html`），通常是宿主/反代在模型跑完前断了响应；
如果 `kind=nojob`，按上一节的「宿主重启清空任务表」处理。

## 4. 导出给用户

```sh
node scripts/dcr-debug.mjs export --out ~/Desktop/dcr-diag.md
```

包里有：概览、最近动作、最近失败（message 已脱敏、sessionId 只留尾 8 位）、state 快照、
账本累计、文件大小、内嵌 ` ```json ` 机读块。默认不覆盖已有文件（`--force` 才覆盖）。
导出前会跑一次 `assertNoLeak` 自检；命中只打印**类别**，不打印原文。
让用户回传这个 `.md`，**不要**回传 `compact-relay-events.jsonl` 原文。

## 5. 已知盲区

- **DSH 原生自动压缩（native-auto）没有归属记录**：事件流只记本插件动作；`trigger` 缺省 `unknown`，不猜。
- **宿主内核内部实现**（Messages 转换器等）只有一层 `message` 文本，没有调用栈 —— `show` 里的 message 就是全部。
- **模型侧「为什么摘要不合格」**：只有校验原因（`ready`/`attempts`/`summary` 文案），没有模型自述。
- **跨会话因果**：事件只记本插件动作；跨会话要读 `$DSH_HOME/sessions/**` 日志。
- **`state --url` 需要 token**：宿主要浏览器 cookie，裸 curl 必 401。默认走快照；`--url` 支持把带
  `?token=` 的地址直接粘进来（只允许 127.0.0.1 / localhost / ::1，只发 GET）。
- macOS 桌面宿主的 stdout 不进常规日志文件：`logs` 常常是空，失败以事件流为准。

## 6. 给后续 Phase 的接口

- **事件 schema**：`lib/core/events.js` 是唯一 schema 定义点。`context` 按 action 白名单 pick
  （`EVENT_CONTEXT_KEYS`）；加字段只改那张表 —— 旧行没有该键照样能读，不需要迁移。
  Phase B/C/D 需要的 `compaction range` / 归属字段直接加到 `compact` 白名单即可。
- **CLI 加命令**：在 `lib/cli/main.js` 的 `COMMANDS` 加一行（handler + 允许 flags + 用法），
  在 `lib/cli/commands.js` 实现 handler（返回退出码），测试放 `test/events-cli.mjs`。
  新命令必须保持「只读本机 / GET only」。
- **诊断端点 events 块**：`GET /api/compact-relay-diagnostics` 的顶层 additive 字段：

  ```jsonc
  "events": {
    "writeable": true,
    "file": "compact-relay-events.jsonl",
    "rows": 41, "total": 41,
    "lastAt": "2026-10-30T15:37:16+08:00",
    "recentFailures": [ /* eventRowOf()，≤10 条，已脱敏 */ ],
    "recentActions":  [ /* eventRowOf()，≤20 条，已脱敏 */ ]
  }
  ```

  它**不在** `dcr-diagnostics/v1` 的 `json` 里（`checkShape` 会拒未知 key，`message` 在 FORBIDDEN_KEYS）。
- **失败响应**：任何 4xx/5xx 的 body 恒有 `ok:false` + `code` + `message`；真写了记录时还有
  `failureId` 和脱敏后的 `failure`（`exportRowOf` 形状：id/at/action/trigger/outcome/durationMs/
  code/message/sessionId/compactionId/context）。
