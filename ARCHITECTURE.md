# 压缩接力 dsh-compact-relay — 代码架构（v1 设计，2026-10-19）

> 目标：让「不同功能分区」，但**每个能力只有一份实现**。
> 所有入口（斜杠命令 / HTTP 端点 / 输入框 UI / M4 工具）都只是薄适配器，
> 业务逻辑集中到 actions 层；能被 DSH 复用的能力，一律 import，不重写。
>
> **参考实现与致谢见 [REFERENCES.md](REFERENCES.md)**（10 个社区插件逐份读源码的结论；
> M2/M3/M5 的若干设计更新来自那里）；生态全景见 [LANDSCAPE.md](LANDSCAPE.md)。

---

## 0. 一句话

**入口多、实现少**：`/bc`、点菜单、未来的工具，调的是同一个 `betterCompact()`；
指示灯、命令 busy 判断、交接文档元信息，读的是同一个 `readState()`。

---

## 1. 分层与依赖方向

```
lib/index.js          装配层：读配置 → 建共享依赖 → 注册入口。无业务逻辑。
   │
lib/adapters/         入口适配层：commands.js / http.js / tool.js
   │                  只做协议转换（参数、命令结果、HTTP JSON），不做判断。
lib/actions/          动作层：state / better-compact / handoff / test-compact / lock /
   │                  inflight（进行中登记，M6 取消）/ pin（M6 钉住）/ compress-hint（压缩判断）
   │                  + 共享执行件：support（信号/inflight/取消收口）、compact-run（压缩执行流程）
   │                  每个动作只写一次，被所有入口共用。
lib/dsh/              能力封装层：pressure / session-view / summarizer / route / prefix /
   │                  stream / handoff-writer / compact-transaction / idle / sessions /
   │                  site-info（M6 现场快照）/ handoff-files（M6 交接文档只读）
   │                  + 共享件：compaction-pair（事件配对扫描）、model-task（模型调用装配/收尾）
   │                  唯一 import @deepseek-ai/* 的地方；未来 DSH 升级只改这里。
lib/core/             纯函数层：policy / ranges / prompts / handoff-doc /
   │                  validate-summary / validate-handoff / placeholders / pins / errors
   │                  + 共享件：object（isPlainObject）、tokens（token 口径/遮罩求和）
   │                  不 import 任何 DSH 包，可单测、可裸跑。
lib/config.js         默认值 + 配置合并（阈值、颜色、保留量、dev 开关、目录）。
lib/client.js         浏览器半的构建产物（DSH 客户端 bundle 契约，见 §5）；不要手改。
lib/client/           浏览器半源码片段（按文件名排序拼接，scripts/build-client.mjs）；
                      15-shared.js 是跨片段共享件（环几何/浮层材质/keyframes）。
```

**硬规矩**：依赖只能往一个方向流（adapters → actions → dsh → core）。
core 里不许出现 `ctx` / `agent` / `session`；dsh 里不许出现 UI 文案；actions 里不许直接碰 `ctx` 服务。
共享件也不能破坏分层：`core/object.js`、`core/tokens.js` 是纯函数；`dsh/compaction-pair.js`、
`dsh/model-task.js` 只消费 dsh/core；`actions/support.js`、`actions/compact-run.js` 只被 actions 调用。

---

## 2. 文件清单与职责

### 装配

| 文件 | 职责 |
|---|---|
| `lib/index.js` | `apply(ctx, config)`：resolve config、建 lock、注册 adapters |
| `lib/config.js` | `DEFAULT_CONFIG` + `resolveConfig(raw)`；阈值/颜色/保留量/dev/目录的唯一来源 |
| `lib/settings-store.js` | A9 兼容 shim（旧导入路径转发到 `dsh/settings-file` + `actions/settings`） |

### client 半（A8：单文件契约不变，源码拆片段）

| 文件 | 职责 |
|---|---|
| `lib/client.js` | 构建产物（DSH `exports["./client"]` 指向它；仓库提交、发布包只带它） |
| `lib/client/{00-header..90-apply}.js` | 有序源码片段（indicator / handoff / settings / apply 等），`scripts/build-client.mjs` 按序拼成 `client.js`；`15-shared.js` 是跨片段共享件（环几何 / 原生线 / 浮层材质 / keyframes） |
| `scripts/build-client.mjs` | 零依赖构建；`npm test` 第一步 `--check`，片段改了没重建直接红 |

### core —— 纯函数（零 DSH 依赖）

| 文件 | 导出 | 职责 |
|---|---|---|
| `core/config-schema.js` | `CONFIG_FIELDS`, `resolveConfig` 辅助 | **配置项唯一清单**：默认值/校验/中文文案/设置页白名单/公开视图 |
| `core/policy.js` | `adviceFor`, `ratioOf`, `ringLevel`, `compactionPolicy` | 阈值判定：`none / compact / handoff`；外环/内圆四状态优先级；旧摘要合并策略 |
| `core/ranges.js` | `selectFullRange`, `selectTestRange` | 选段：跳过旧摘要、留活跃尾部、配对平衡；M1 实验版（最近 N 条） |
| `core/prompts.js` | `SUMMARY_INSTRUCTION`, `TEST_INSTRUCTION`, `HANDOFF_INSTRUCTION` 等 | **所有提示词唯一来源** |
| `core/handoff-spec.js` | `HANDOFF_SPEC`, `HANDOFF_SECTIONS` | **九段规格表**：提示词/校验/渲染/客户端文案全部由它派生 |
| `core/handoff-doc.js` | `renderHandoffDoc`, `handoffFileName` | 交接单元信息头 + 渲染、文件名（纯数据 → markdown） |
| `core/handoff-facts.js` | `buildHandoffFactsSections` | 程序收集「当前进度 / 改过的文件」两段（模型编不了） |
| `core/readiness.js` | `checkHandoffReadiness` | 交接就绪检查：缺段/占位阻断，路径核对只警告 |
| `core/validate-handoff.js` | `validateHandoff`, `describeHandoffProblems` | 交接单结构校验（九段、非空、无前言/多余小节） |
| `core/validate-summary.js` | `validateSummary`, `describeProblems` | 摘要六段结构校验 + 指令复述识别 |
| `core/ring.js` | `ringSegments`, `trimSegment` | 指示灯环的分段/断点纯数学（正常区灰/蓝 → 压缩区琥珀 → 交接区红；断点缺口裁切） |
| `core/compress-hint.js` | `COMPRESS_HINT_RECORD_TYPE`, `latestCompressHint`, `compressHintIsActive` | 模型「这里适合压缩」判断：plugin record 判定、精压/交接后自动失效 |
| `core/placeholders.js` | `isPlaceholderLine`, `isPlaceholderText` | 识别 `(none)`/无/N/A 等占位，防空壳文档/摘要 |
| `core/pins.js` | `PIN_RECORD_TYPE`, `latestPinnedSeqs`, `clipRangeByPins` | 锁定：plugin record 快照、按锁定裁剪精压范围 |
| `core/relay.js` | `RELAY_RECORD_TYPE`, `latestRelayRecord` | 接力链记录（parent/child/index/path） |
| `core/colors.js` | `DEFAULT_BASE`, `paletteForScheme` | 颜色纯数学：HSL 明度派生 + WCAG 对比度 ≥3:1、归一化、旧结构兼容 |
| `core/errors.js` | `actionError`, `errorText`, `toActionResult` | 错误 → 用户可读文案的唯一映射（含原因附带与截断） |
| `core/object.js` | `isPlainObject` | **普通对象判定的唯一来源**（config 合并 / 设置文件信封 / actions 深合并共用；非 null、typeof object、非数组） |
| `core/tokens.js` | `tokenOf`, `sumShadowedTokens` | **token 口径唯一来源**：节点取 `heuristicTokens ?? tokens`；一段被遮罩 seq 的 token 总和（选段尾部预算、state 可压范围、压缩预览/执行共用） |

### dsh —— 能力封装

| 文件 | 导出 | 职责 |
|---|---|---|
| `dsh/engine.js` | `createEngine` | **全插件唯一 import `@deepseek-ai/*` 的地方**；宿主能力接缝 |
| `dsh/pressure.js` | `measurePressure` | `tokenMeter.measure()` + `resolveModelInfo()` → `{tokens,window,ratio,nodes}`；route 级 window 缓存 |
| `dsh/session-view.js` | `surfaceSeqs`, `sessionLog`, `countSummaries`, `livePinnedSeqs`, `lastCheckpointSurfaceSeq`, `compressHint`, `pickAgent` | 只读 session 视图（全部访问面收在一处） |
| `dsh/select-range.js` | `selectCompactableRange` | 选段（压缩动作与 state 端点共用） |
| `dsh/route.js` | `routeOf`, `cacheControls` | 模型路由与 cache 对齐参数 |
| `dsh/prefix.js` | `buildPrefix`, `surfaceMessages` | 构造「模型上次看到的真前缀」 |
| `dsh/stream.js` | `finishProblem` | LLM 流终止原因 → 可读错误 |
| `dsh/llm-call.js` | `callStream`, `assertBudget`, `reasoningEffortFor` | **唯一模型调用入口**：预算预检、超时、重试一次、可取消 |
| `dsh/summarizer.js` | `summarize` | 压缩摘要（复用前缀回放保 KV cache；截断/工具调用重试） |
| `dsh/handoff-writer.js` | `generateHandoffDoc` | 让模型写九段交接单；结构校验失败重试一次 |
| `dsh/compact-transaction.js` | `replaceRangeWithSummary` | **唯一替换事务**：start → summary → replace → end |
| `dsh/idle.js` | `runIdle` | `runMaintenance()` 封装 + busy/abort 映射 |
| `dsh/sessions.js` | `createHandoffSession`, `childTitleOf` | 交接内核：建会话+agent、挂工作区、改标题、followup 注入 |
| `dsh/state-hub.js` | `createStateHub` | 订阅 `session/event`，对 SSE 订阅者去抖推送 `readState` |
| `dsh/site-info.js` | `buildSiteSnapshot`, `gitInfo`, `pendingJobs` | 交接单现场快照（启动时长、git、后台任务、模型），只读 |
| `dsh/handoff-files.js` | `listHandoffFiles`, `readHandoffFile` | 交接单目录只读访问（白名单、防穿越、512KB 上限） |
| `dsh/session-files.js` | `changedFilesOf` | 从会话日志收集写/改过的文件（交接单程序段） |
| `dsh/compaction-log.js` | `recentCompactions` | 压缩历史读侧（A6：配对 summary/end/replace） |
| `dsh/compaction-pair.js` | `scanCompactionLog` | **压缩事件配对扫描唯一来源**：一次扫描日志返回 summaries / ends(compactionId→end.data) / replaceByCoveredSeq；`session-view.countSummaries` 与 `compaction-log` 共用 |
| `dsh/model-task.js` | `prepareModelCall`, `cacheAlignedControls`, `callModelAttempt`, `modelAttemptResult` | **模型任务公共装配/收尾**：会话→路由→预算→推理档、cache 对齐参数（不继承 reasoningEffort）、单次 callStream+finishProblem、结果元信息；`summarizer` 与 `handoff-writer` 共用（各自保留校验/重试策略） |
| `dsh/settings-file.js` | `readSettingsFile`, `writeSettingsFile` | 设置文件读写（`$DSH_HOME/compact-relay.json`，`{v:1,config}` 信封、原子写） |
| `dsh/relay.js` | `readRelayRecord`, `writeRelayRecord` | 接力链读写接缝 |

### actions —— 动作层（每个动作唯一实现）

| 文件 | 导出 | 职责 |
|---|---|---|
| `actions/state.js` | `readState`, `resolveTarget` | 指示灯/菜单/命令/文档元信息共用的状态快照（含单调 `revision`） |
| `actions/better-compact.js` | `betterCompact`, `betterCompactLocked`, `previewBetterCompact`, `cancelBetterCompact` | 精压：锁 → 读压力 → 选段（避开锁定）→ idle 事务 → 结果 |
| `actions/test-compact.js` | `testCompact` | `/bctest`：默认 dry-run，`confirm` 才真跑 |
| `actions/handoff.js` | `handoff`, `previewHandoff` | 交接：预览（九段草稿+就绪清单）/ 执行（压缩→写盘→建会话→切换） |
| `actions/handoff-docs.js` | `listDocs`, `readDoc` | 交接单列表/全文（HTTP 适配层调用） |
| `actions/compact-diff.js` | `readCompactDiff` | 压缩历史（A6）：最近 N 次范围/摘要预览/容量/是否提交 |
| `actions/settings.js` | `loadSettings`, `saveSettings`, `resetSettings` | 设置合并/校验/热替换；坏文件回落默认 + `settingsError` |
| `actions/lock.js` | `withLock`, `isBusy` | 每会话单飞锁 |
| `actions/inflight.js` | `createInflight` | 进行中动作的 AbortController 登记（取消用） |
| `actions/pin.js` | `pinLastTurn`, `pinByIndex`, `unpinAll`, `listPins`, `togglePin` | 锁定/解锁（写 plugin record、候选列表） |
| `actions/compress-hint.js` | `markCompressHint` | 记录模型「这里适合压缩」的判断（最小线/压缩线之间才允许） |
| `actions/native-compaction.js` | `nativeCompactionInfo`, `setNativeAutoCompactionEnabled` | DSH 原生自动压缩：读配置/开关包装（写 profile 前备份） |
| `actions/compact-run.js` | `runCompaction` | **压缩执行流程唯一来源**：flush/estimateMessage 装配 → runIdle（用户取消⊕idle 信号）→ replaceRangeWithSummary + summarize；`better-compact` 与 `test-compact` 共用（差异只在选段/指令/校验参数） |
| `actions/support.js` | `combinedSignal`, `beginInflight`, `finishInflight`, `cancelErrorOf` | **动作层胶水**：AbortSignal 组合、inflight 登记/注销、取消收口（cancelled 与 commit/persistence 不混淆） |

### adapters —— 入口适配（只做协议转换）

| 文件 | 职责 |
|---|---|
| `adapters/commands.js` | 注册 `/bc`（预览/confirm）`/handoff` `/pin` `/unpin` `/bctest`(dev) |
| `adapters/http.js` | `GET /api/compact-relay-state`、`-stream`（SSE）、`-handoffs`、`-diff`、`-settings`；`POST /api/compact-relay-action`（preview/compact/cancel/pin-toggle/handoff/handoff-preview/native-auto） |
| `adapters/tool.js` | `mark_stage` 工具：模型判断「这里适合压缩」→ `actions/compress-hint.js` → plugin record |

## 3. 接口契约（关键签名）

```js
// actions/state.js —— 唯一状态快照
readState(deps, {sessionId}) -> {
  sessionId, pressure, window, ratio,
  summaries, advice,               // 'none' | 'compact' | 'handoff'
  compressHint, busy,              // compressHint: null | {ratio, at, seq}（模型判断点）
  native,                          // DSH 原生自动压缩：{autoEnabled, thresholdRatio}
  thresholds, colors,              // 由 host 下发，客户端不自己算
}

// actions/better-compact.js
betterCompact(deps, {agent, signal, commandId}) -> {
  ok, startSeq, endSeq, shadowedSeqs, shadowedTokens,
  summarySeq, summaryTokens, message,
}

// actions/test-compact.js
testCompact(deps, {agent, signal, confirm}) -> {
  dryRun, range, shadowedTokens,                     // confirm=false
  ok, summarySeq, message,                           // confirm=true
}

// actions/handoff.js（M3）
handoff(deps, {agent, signal, commandId}) -> {
  ok, childId, path, started, message,   // childId 给客户端自动切换；started=文档是否已起第一轮
}

// dsh/sessions.js（M3 内核）
createHandoffSession({ctx, engine, session, agent, doc, title, log}) -> {
  childId, title, workspaceAttached, started, docSeq?,
}

// dsh/compact-transaction.js —— M1 的「钥匙」
replaceRangeWithSummary(deps, {
  agent, range, signal, sourceCommandId,
}) -> { compactionId, startSeq, summarySeq, endSeq, shadowedSeqs, shadowedTokenCount }
```

---

## 4. 数据流

```
指示灯：
  client --GET /api/compact-relay-state--> adapters/http
        --> actions/state --> dsh/pressure (+core/policy)
        <-- {pressure, ratio, advice, summaries, compressHint, native, busy, colors}

点击「精压」/ 富命令 /bc：
  client POST action ─┐
  adapters/commands ──┴--> actions/better-compact
                            ├─ actions/lock（同会话互斥）
                            ├─ dsh/pressure + dsh/session-view
                            ├─ core/ranges（选段）
                            └─ dsh/idle ─→ dsh/compact-transaction
                                             ├─ dsh/summarizer（core/prompts）
                                             └─ session.append(compaction/start → summary → replace → end)

接棒 /handoff（M3）：
  adapters/commands --> actions/handoff
                          ├─ actions/better-compact.betterCompactLocked（先精压，best effort）
                          ├─ dsh/handoff-writer（完整 surface + 六段指令 → 模型写文档）
                          ├─ core/handoff-doc（元信息头 + 写盘）
                          └─ dsh/sessions.createHandoffSession
                               ├─ ctx.agents.create（会话+agent，同 cwd/preset/模型）
                               ├─ workspaceRegistry.attachSession（同工作区）
                               ├─ sessionTitle.rename（接棒：<原标题>）
                               └─ childAgent.followup（文档成为首条消息并起第一轮）
  <- {childId, path, started, message}
  client: /handoff 命令卡（conversation.chat.commandview key=handoff）
          或指示灯菜单 HTTP 响应里的 childId
          → 等 sessions.list 出现新会话（必要时 sessions.refresh()）
          → ctx.uiWorkspace.openSession(childId) 自动切换

M1 /bctest：
  adapters/commands --> actions/test-compact（默认 dry-run）
                          └─ 与正式精压同一条 dsh/compact-transaction，只是范围小
```

---

## 5. client 半的约束与分区

DSH 客户端加载器要求 `package.json exports["./client"]` 指向**已构建好的单文件 bundle**
（运行时没有打包器；缺文件会报 `client-modules: client bundle not found`）。

A8（2026-10-20）之后单文件契约不变，但**源码不再是单文件**：`lib/client/*.js` 是按文件名
排序的片段（00-header / 01-shell-open / 10-runtime / 12-colors / 13-ring / 14-theme-hook /
15-shared / 20-format / 30-indicator / 40-handoff / 50-settings / 90-apply），由
`scripts/build-client.mjs`（零依赖）拼成 `lib/client.js`。改 client 只改片段，改完运行
`node scripts/build-client.mjs`；`npm test` 第一步是 `node scripts/build-client.mjs --check`，
改了片段没重建会直接红。

`15-shared.js` 是跨片段共享件：环上点坐标/弧线 path（`ringPoint` / `ringArcPath`）、
DSH 原生自动压缩线刻度（`nativeTickAt`）、越过原生线整环闪烁 keyframes
（`NATIVE_ALERT_CSS`）、浮层材质（`panelChrome`，BUG-001 的主题 token 口径）。片段按
文件名排序拼接，函数声明提升 → 后面的 `30-indicator` / `50-settings` 可直接调用；
常量在组件渲染（工厂体执行完之后）才被使用，不存在 TDZ 问题。

颜色纯数学（HSL 派生 + WCAG 对比度）已上移到 `core/colors.js`：host 在 state/settings view
里下发浅/深两套派生结果（`colors.palette`），浏览器半只按界面明暗挑一套；设置页「改了还没
保存」的即时预览仍用同一份纯函数（构建时内联，单一来源）。片段里写一行
`/* @inline core/colors.js */` 就会在构建时把该模块去 `export` 后内联进来。

浏览器半的分区：

1. **数据** —— 优先 `EventSource` 订阅 `/api/compact-relay-stream`（host 在每条会话事件后去抖推送），连不上时退回 5 秒轮询、失败静默、卸载清理；
2. **渲染** —— 指示灯 / 悬停卡 / 菜单 / 确认卡 / 交接单面板 / 压缩历史面板 / toast，颜色/阈值全部来自 state payload；
3. **注册** —— `apply(ctx)` 挂 `conversation.input.left`、`conversation.chat.commandview`、`settings.section`。

**红线**：客户端不重复实现阈值/建议判断，只显示 host 给的结果。
**性能**（A10 实测，2026-10-20）：真实大会话（405 节点 / 35 万 token 压力）单帧 readState
分解 ≈ measure 0.45ms + 计数/选段各 0.12ms，真机端点端到端 p50≈1.8ms，远低于「p95>8ms 或
节点>1500」的优化触发线，暂不做 detail 拆分/WeakMap 缓存；面板 React.memo 等浏览器端渲染
基线出来再谈。

---

## 6. 与 DSH 的接缝（复用清单）

`package.json` 增加 `peerDependencies`（写法参照 dsh-ticktick-bridge）：

```json
"peerDependencies": {
  "react": "^18.2.0",
  "@deepseek-ai/dsh-compaction": ">=0.2.0-0 <0.3.0",
  "@deepseek-ai/dsh-llm": ">=0.2.0-0 <0.3.0",
  "@deepseek-ai/dsh-session": ">=0.2.0-0 <0.3.0",
  "@deepseek-ai/dsh-tools": ">=0.2.0-0 <0.3.0"
}
```

只 import 这些（全部集中在 `lib/dsh/`）：

| 符号 | 来源 | 为什么复用 |
|---|---|---|
| `toolPairingBalancedBefore` / `toolPairingBalancedAfter` | `@deepseek-ai/dsh-compaction` | 工具调用配对平衡——自己重写必出 bug |
| `compactCheckpointSource` / `isCompactCheckpointSource` | `@deepseek-ai/dsh-compaction` | checkpoint 标记，DSH 各处靠它识别「这是压缩摘要」 |
| `createUserMessage` | `@deepseek-ai/dsh-llm` | 构造合法的 checkpoint user message |
| `appendPluginRecord` | `@deepseek-ai/dsh-session` | 压缩判断记录/锁定/接力链的持久化（写 `plugin:` 事件，不进模型 surface） |
| `defineTool` | `@deepseek-ai/dsh-tools` | M4 注册 `mark_stage` 工具（参数/输出 schema、render） |

**不复制** `@deepseek-ai/dsh-compaction-basic` 的整段事务代码——只用它的公共 API（上表），
选段策略和摘要 prompt 用我们自己的。

---

## 7. 复用红线（“不许一个轮子写两次”的落地）

| 事实 / 能力 | 唯一实现 | 禁止 |
|---|---|---|
| 建议判定（压缩线/接棒线） | `core/policy.js` | 客户端、命令、HTTP 各写一遍阈值比较 |
| 上下文测量 | `dsh/pressure.js` | 到处各自调 `tokenMeter.measure` |
| 摘要提示词 | `core/prompts.js` | summarizer 与 handoff 各写一份 |
| 替换事务 | `dsh/compact-transaction.js` | `/bctest` 和精压各写一遍 append |
| 接棒六段 | `core/handoff-doc.js` | 命令和 HTTP 各拼一遍 markdown |
| 错误文案 | `core/errors.js` | 三个入口各写一套 |
| 单飞锁 | `actions/lock.js` | 每个入口自己 `if (busy)` |
| 配对平衡 / checkpoint 判定 | DSH 包（import） | 自己复写 |
| client 的阈值/颜色 | host `readState` | client 自己拿 token 算 |
| 压缩判断记录类型 / 新鲜度判定 | `core/compress-hint.js` | state、工具、测试各写一份 plugin record 判定 |
| 普通对象判定（`isPlainObject`） | `core/object.js` | config/设置文件/actions 各写一份 |
| token 口径 / 遮罩 token 求和 | `core/tokens.js` | 选段、state、预览、执行各写一遍 `heuristicTokens ?? tokens` |
| summary/end/replace 配对扫描 | `dsh/compaction-pair.js` | countSummaries 与压缩历史各扫一遍日志 |
| 模型调用前置 / cache 对齐 / callStream+finish 装配 | `dsh/model-task.js` | summarizer 与 handoff-writer 各写一份 |
| 压缩执行流程（idle→信号→事务→摘要） | `actions/compact-run.js` | 正式精压与 `/bctest` 各写一遍事务参数 |
| AbortSignal 组合 / inflight 登记 / 取消收口 | `actions/support.js` | 每个动作自己 `inflight.begin/finish` + 判 commit/persistence |
| client 环几何 / 原生线 / 浮层材质 | `lib/client/15-shared.js` | 指示灯与设置页教学图各画一遍、7 处浮层各抄 5 行样式 |

---

## 8. M1 的三个新发现（交接文档没写，直接决定实现）

1. **`sourceEventSeqs` 是必须的。**
   `session.append(type, data, { surfaceOp: {op:'replace',startSeq,endSeq}, sourceEventSeqs })`
   其中 `sourceEventSeqs` **必须包含所有被遮罩的 surface 节点 seq**
   （DSH 校验原文：`surface replace: sourceEventSeqs must include every shadowed surface node`）。
   交接文档里的示例缺这一项，照抄会直接抛错。
   引擎的完整写法还会把 `compaction/start`、`compaction/summary` 的事件 seq 也带上。
2. **事务要包在 `agent.runMaintenance()` 里。**
   手动压缩的 idle 准入 / 与自动压缩互斥都用它；不然会和 DSH 的 compaction 锁语义打架。
3. **摘要必须回放前缀再追加指令。**
   即 `[system, ...被遮罩消息] + 指令` 一起喂给 `ctx.llm.stream()`，
   否则 KV cache 全不命中（上次实测一次压缩烧 165,673 token 就是这个原因）。
   → 这是 `dsh/summarizer.js` 存在的意义，不能图省事只把段落贴成一段 prompt。

另外：事务必须**成对**写 `compaction/start` + `compaction/end`（失败也要补 end），
否则会话里留下「未完成的压缩锁」，之后原生 `/compact` 和自动压缩都会报 busy。

---

## 8.5 作用域铁律（2026-10-19 第一次重启踩的坑）

- 根级插件只能 inject **根服务**：`commands` / `agents` / `tokenMeter` / `llm` / `sessions`；
  `webServer` 用 `ctx.inject(['webServer'], cb)` 单独要。
- **`compaction` 是 agent 作用域**：它挂在每个 agent preset 的隔离组里
  （`@deepseek-ai/dsh-web-app/presets/*.patch.yml` 的 `isolate: {compaction:true}`）。
  根插件把 `'compaction'` 写进 `inject` 会永远 `pending (waiting for service: compaction)`，
  `apply()` 根本不执行 → 命令/HTTP 全不注册，但 **client 半照常加载、指示灯照显**，极具欺骗性。
  要用就 `agent.ctx.compaction` 动态取（M2 自建事务后不需要）。
- 同理，preset 里其它隔离服务（`toolResultPruner`、`planMode` 等）根插件也 inject 不到。

### 诊断法：隔离复刻桌面 boot 拿 stderr

桌面版 host 的 stderr 被 GUI 进程接走后丢进 `/dev/null`，看不到激活失败原因。做法：

1. `cp -cR ~/.dsh/profiles/desktop /tmp/dshrepro/home/.dsh/profiles/desktop`
2. `ELECTRON_RUN_AS_NODE=1 DSH_HOME=/tmp/dshrepro/home/.dsh "DeepSeek Harness" --expose-internals \
   <app.asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js \
   <dshRoot> <profileDir> <runtimeDir> <pnpm.mjs> <runtime/bin>`
3. stderr 里会打出 `dsh: warning: N entries did not activate` + 每条的 pending/失败原因；
   还会打印带 token 的 `dsh web: http://127.0.0.1:PORT/?token=...`，可 curl 插件端点验证。

---

## 8.6 命令注册铁律：带参数的命令必须声明 input

DSH 客户端（`dsh-client-ui-commands` 的 `matchEnter`）**只让声明了 `input` 的命令接受带参数的行**：

- `desc.input === undefined` + 行里有参数（`bare=false`）→ `return void 0` → 整行被当普通消息发给模型，handler 收不到；
- 只有裸命令才走 `runDetached` 执行。

所以：
- 命令需要参数/子命令 → 必须 `input: { hint: '...' }`（hint 是非空字符串，可选 `attachments: true`）；`/bctest` 就是吃了这个亏。
- 无参命令不写 `input`（带参数的行会当普通消息，也算保护）。

---

## 8.7 M3 接棒的 0.2 接缝（WeiYe6 路线按 0.2 API 重写后确认的事实）

REFERENCES §1.6 的 WeiYe6 实现是针对 0.1.x 写的；0.2.1-rc.2 上这几处 API 已经变了，
M3 按下面的「0.2 等价物」落地（全部在 `lib/dsh/sessions.js` 与 `lib/client.js` 收口）：

| WeiYe6（0.1） | 0.2 的正确做法 | 说明 |
|---|---|---|
| `ctx.sessions.create()` | `ctx.agents.create({sessionId, agentOptions, meta, setup})` | 会话与 agent 一起建；`meta` 只接受 cwd/parentSession/agentPreset 等固定字段 |
| 手拼 preset | `ctx.get('agentPresets').resolve(id)` + `mount(agentCtx, id)` 放进 `setup` | 照 `dsh-api-session-controller` 的 `composeAgent`；不挂 preset 的子会话没有系统提示/工具 |
| `ctx.workspaceRegistry.attachSession(id)` | 先 `registry.create(cwd)` 拿 entity，再 `workspace.attachSession(id)` | `create` 要求 cwd 是已存在目录并做 realpath 规范化 |
| `session.title = ...` / `sessionTitle.rename` | `ctx.get('sessionTitle').rename(session, title)`（同步） | 会话必须已在 store 里（agents.create 返回后满足） |
| 注入后客户端打开 | **没有** `ctx.sessions.open()`；改 `ctx.uiWorkspace.openSession(id)` | 由 `dsh-client-ui-workspace` 提供；只能打开已进会话列表的 id |
| client `conversationEvents` + 自建节点 | **没有** `conversationEvents`；用 `uiConversation.events.register` 或（更薄）`conversation.chat.commandview` 槽 | M3 选后者：`key='handoff'` 直接替换 /handoff 命令卡，组件里做自动切换 |
| 轮询 `ctx.sessions.binding(id)` | 轮询 `ctx.sessions.list.getSnapshot().byId[id]`，必要时 `ctx.sessions.refresh()` | `binding()` 只对已 retain 的会话有值；catalog 才是「客户端认识它」的判据 |

**新会话必须是「非空白」**：0.2 里 `blank`（还没 `turn/start`）的会话在界面上渲染成
Hero 新会话页，**不显示历史消息**。所以 M3 不用裸 `append` 注入文档，而是
`childAgent.followup(交接文档消息)`：消息落盘 + 开第一轮，客户端切过去就能看到
「交接文档（context 卡）+ 模型确认」，而不是一个空的 Hero。fallback 才是 `append`。

## 9. 落地顺序（每步只动 1–2 个文件）

| 步 | 内容 | 动到的文件 |
|---|---|---|
| 0 | 拆分重构（行为不变，`/bc` `/handoff` 照旧）+ 冒烟测试 | index.js + adapters/actions/dsh/core 全量 |
| 1 | **M1**：替换事务 + 摘要 + `/bctest`（默认 dry-run） | `dsh/compact-transaction.js`、`dsh/summarizer.js`、`dsh/idle.js`、`actions/test-compact.js`、`adapters/commands.js` |
| 2 | **M2**：正式精压（跳过旧摘要、活跃保护、定型泄压阀） | `core/ranges.js`、`core/prompts.js`、`actions/better-compact.js` |
| 3 | **M3**：接棒（六段文档 + 建新会话 + 自动切换）✅ | `actions/handoff.js`、`dsh/handoff-writer.js`、`dsh/sessions.js`、`core/handoff-doc.js`、`core/validate-handoff.js`、`lib/client.js` |
| 4 | **M4**：压缩判断（工具 + plugin record 持久化；0.3.1 起用户手动入口已删除）✅ | `actions/compress-hint.js`、`adapters/tool.js`、`core/compress-hint.js`、`dsh/session-view.js`、`actions/state.js`、`lib/client.js` |
| 5 | **M5**：指示灯升级 ✅（四状态颜色/环圆分离/悬停数字/点击菜单/颜色配置化/busy） | `lib/client.js` + `actions/state.js` |
| 5a | **M5 实时数据** ✅：SSE 推送替代轮询 | `dsh/state-hub.js`、`adapters/http.js`、`lib/index.js`、`lib/client.js` |

---

## 10. 目录树（0.3 现状）

```
~/.dsh/vendor/dsh-compact-relay/
├─ package.json                 # exports "." + "./client"；dsh.bundle.patch + dsh.client
├─ cordis.patch.yml             # 只 insert 一行 {id: compact-relay, name: dsh-compact-relay}
├─ README.md / TUTORIAL.md / CHANGELOG.md / ROADMAP.md / LICENSE
├─ ARCHITECTURE.md / REQUIREMENTS.md / HANDOFF.md / REFERENCES.md / LANDSCAPE.md / DSH-FEEDBACK.md
├─ scripts/
│  └─ build-client.mjs          # 零依赖构建：lib/client/*.js → lib/client.js（npm test --check）
├─ lib/
│  ├─ index.js                  # 装配
│  ├─ config.js                 # DEFAULT_CONFIG + resolveConfig
│  ├─ settings-store.js         # A9 兼容 shim
│  ├─ client.js                 # 构建产物（禁止手改；源码见 lib/client/）
│  ├─ client/                   # 浏览器半源码片段（按文件名排序拼接）
│  │  ├─ 00-header.js / 01-shell-open.js / 10-runtime.js / 12-colors.js / 13-ring.js
│  │  ├─ 14-theme-hook.js / 15-shared.js（跨片段共享：环几何/浮层材质/keyframes）
│  │  ├─ 20-format.js / 30-indicator.js / 40-handoff.js / 50-settings.js / 90-apply.js
│  ├─ core/                     # 纯函数
│  │  ├─ config-schema.js colors.js errors.js policy.js ranges.js prompts.js
│  │  ├─ handoff-spec.js handoff-doc.js handoff-facts.js readiness.js
│  │  ├─ validate-summary.js validate-handoff.js placeholders.js
│  │  ├─ compress-hint.js ring.js pins.js relay.js
│  │  ├─ object.js（isPlainObject）/ tokens.js（token 口径）
│  ├─ dsh/                      # 能力封装（唯一 import @deepseek-ai/* 的地方）
│  │  ├─ engine.js pressure.js session-view.js select-range.js route.js prefix.js
│  │  ├─ stream.js llm-call.js summarizer.js handoff-writer.js
│  │  ├─ compact-transaction.js idle.js sessions.js
│  │  ├─ state-hub.js site-info.js handoff-files.js session-files.js
│  │  ├─ compaction-log.js compaction-pair.js settings-file.js relay.js native-compaction.js
│  │  ├─ model-task.js（模型任务公共装配/收尾）
│  ├─ actions/                  # 动作层
│  │  ├─ state.js better-compact.js test-compact.js handoff.js
│  │  ├─ handoff-docs.js compact-diff.js settings.js
│  │  ├─ lock.js inflight.js pin.js compress-hint.js native-compaction.js
│  │  ├─ compact-run.js（压缩执行流程）/ support.js（信号/inflight/取消收口）
│  └─ adapters/                 # 入口适配
│     ├─ commands.js / http.js / tool.js
└─ test/
   ├─ smoke.mjs / handoff.mjs / plugin-load.mjs / contract.mjs / compact-log.mjs
   ├─ harness/                  # A7：统一 mock（host / session / llm / dsh-stubs）
   └─ e2e/                      # 隔离 DSH 端到端（smoke / settings-ui / real-compact / action）
```

> `lib/client/` 片段与 `scripts/build-client.mjs` 留在仓库（保证可重建），但**不进 npm 发布包**（`files` 里的 `"!lib/client"`；发布只带构建产物 `lib/client.js`）。
