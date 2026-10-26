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
lib/adapters/         入口适配层：commands.js / http.js / tool.js / prompt.js（systemPrompt 动态提示）
   │                  只做协议转换（参数、命令结果、HTTP JSON、提示文本），不做判断。
lib/actions/          动作层：state / better-compact / handoff / recover（0.5 恢复归档）/
   │                  test-compact / lock / inflight（进行中登记，M6 取消）/ pin（M6 钉住）/
   │                  compress-hint（压缩判断）
   │                  + 共享执行件：support（信号/inflight/取消收口）、compact-run（压缩执行流程）
   │                  + diagnostics（0.4 P0-2 诊断组装：取数并裁白名单，交给 dsh 层构造）
   │                  每个动作只写一次，被所有入口共用。
lib/dsh/              能力封装层：pressure / session-view / summarizer / route / prefix /
   │                  stream / handoff-writer / compact-transaction / idle / sessions /
   │                  handoff-archive（0.5 旧会话归档/恢复接缝）/
   │                  site-info（M6 现场快照）/ handoff-files（M6 交接文档只读）
   │                  + 共享件：compaction-pair（事件配对扫描）、model-task（模型调用装配/收尾）
   │                  + 诊断（0.4 P0-2）：diag-counters（进程内计数/耗时/错误码）/
   │                    diagnostics（诊断包构造：白名单 + 脱敏 + 尺寸上限；零 IO 零网络）
   │                  唯一 import @deepseek-ai/* 的地方；未来 DSH 升级只改这里。
lib/core/             纯函数层：policy / ranges / prompts / handoff-doc /
   │                  validate-summary / validate-handoff / placeholders / pins / errors /
   │                  compress-cue（0.3.4 可压缩区间提示）/ markdown-lite（0.3.4 交接单轻量渲染）
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
| `core/compress-cue.js` | `compressCueText`, `inCompressCueBand`, `bucketRatio`, `formatPercent`, `COMPRESS_CUE_NAME`, `COMPRESS_CUE_ORDER` | **0.3.4（BUG-010）可压缩区间提示的纯逻辑**：区间 `minRatio ≤ ratio < compactRatio`、容量 5% 桶取整、已记 hint 10pp 内抑制、文案（点名 `mark_compress_point`） |
| `core/markdown-lite.js` | `parseMarkdownLite`, `parseInlineLite` | **0.3.4（BUG-005）交接单轻量 markdown 解析**：标题/段落/有序无序列表/粗体/行内代码/代码块/分隔线；输出结构化 blocks+segments，不生成 HTML（XSS 内容原样当文本）；client 片段 `16-markdown.js` 构建时内联同一源码 |
| `core/placeholders.js` | `isPlaceholderLine`, `isPlaceholderText` | 识别 `(none)`/无/N/A 等占位，防空壳文档/摘要 |
| `core/pins.js` | `PIN_RECORD_TYPE`, `latestPinnedSeqs`, `clipRangeByPins` | 锁定：plugin record 快照、按锁定裁剪精压范围 |
| `core/pin-health.js` | `pinHealthOf`, `staleCauseTextOf`, `PIN_STALE_CAUSES` | **0.5.1 批 2（C 方案）pin 失效判定**：pin 快照 vs 当前 surface → `{live, stale, cause, causes}`；失效原因只读日志（replace 覆盖的 seq → compaction/start：`turn` 非空 = 原生自动压缩 native；turn=null = 其它压缩 other；无 replace 证据 = unknown），不猜 |
| `core/native-pin-risk.js` | `nativePinnedRiskOf` | **0.5.1 批 2 原生压缩预判**：逐字复刻 compaction-basic 的 `selectCompactableRange`（保留尾部 retainTokens + 工具配对平衡回退），返回下一次原生压缩会覆盖的 pinned seq；只读、不触发压缩 |
| `core/relay.js` | `RELAY_RECORD_TYPE`, `HISTORY_PREFIX`, `MAX_TITLE_BYTES`, `relayTitleOf`, `historyTitleOf`, `truncateTitleUtf8`, `splitHandoffTitle` | **接力链命名/解析纯函数**：交接标题「交接第 N 次：<原名>」、历史标题「历史 N：<原名>」生成；`splitHandoffTitle` 解析出 `baseTitle` / `handedOff` / `scheme`（`handoff-n` / `history-n` / `legacy`），旧链字段名与文案不变；`truncateTitleUtf8` + `MAX_TITLE_BYTES=80` 给标题做 UTF-8 预算（前缀先计入、只缩 base），与宿主 `session-title` 同口径 |
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
| `dsh/sessions.js` | `createHandoffSession`, `handoffTitlePlanOf`, `childTitleOf`, `renameHistoryOf`, `presetIdOf`, `sourceTitleOf` | 交接内核：建会话+agent、挂工作区、改标题、followup 注入；**followup 后往子会话写 relay record**（ordinal/baseTitle/scheme/titleSeq，走 plugin record 通道）；链号优先读 record，旧会话才回退标题解析；`handoffTitlePlanOf` 决定本次链的 scheme（干净标题/历史 N → 新链 `history-n`；交接第 N 次/旧前缀/0.3 旧记录 → 旧链 `handoff-n`）；`renameHistoryOf` 在子会话建好后把旧会话改名「历史 N：<原名>」（幂等 guard + flush，失败只 warn） |
| `dsh/handoff-archive.js` | `archiveHandoffSource`, `handoffArchiveNoteOf`, `isSessionArchived`, `isSessionPinned`, `pinnedSessionIdsOf`, `workspaceRegistryOf` | 0.5.0 旧会话归档/恢复接缝：`ctx.get('workspaceRegistry')` → `archiveSession(id)`（**绝不传 stopActivity**）、`unarchiveSession(id)`、`archivedSessionIds`；**0.5.1 批 2** 另读 `pinnedSessionIds`（宿主置顶集合；归档会在同一次写盘里取消置顶）→ `isSessionPinned`；活跃会话有限重试后降级 `active`，失败/缺接口一律不抛错；`handoffArchiveNoteOf` 统一用户文案（含 `skipped`/`pinned`） |
| `dsh/state-hub.js` | `createStateHub` | 订阅 `session/event`：对 SSE 订阅者去抖推送 `readState`；0.3.4 起**无论有无订阅者都维护最新状态缓存**（`latestState(sessionId)` → `{ratio, window, compressHint}`），供 systemPrompt 同步读取 |
| `dsh/site-info.js` | `buildSiteSnapshot`, `gitInfo`, `pendingJobs` | 交接单现场快照（启动时长、git、后台任务、模型），只读 |
| `dsh/handoff-files.js` | `listHandoffFiles`, `countHandoffFiles`, `readHandoffFile` | 交接单目录只读访问（白名单、防穿越、512KB 上限）；`countHandoffFiles` 供列表 `total`（0.3.4 BUG-006） |
| `dsh/session-files.js` | `changedFilesOf` | 从会话日志收集写/改过的文件（交接单程序段） |
| `dsh/compaction-log.js` | `recentCompactions` | 压缩历史读侧（A6：配对 summary/end/replace） |
| `dsh/compaction-pair.js` | `scanCompactionLog` | **压缩事件配对扫描唯一来源**：一次扫描日志返回 summaries / ends(compactionId→end.data) / replaceByCoveredSeq；`session-view.countSummaries` 与 `compaction-log` 共用 |
| `dsh/model-task.js` | `prepareModelCall`, `cacheAlignedControls`, `callModelAttempt`, `modelAttemptResult` | **模型任务公共装配/收尾**：会话→路由→预算→推理档、cache 对齐参数（不继承 reasoningEffort）、单次 callStream+finishProblem、结果元信息；`summarizer` 与 `handoff-writer` 共用（各自保留校验/重试策略） |
| `dsh/settings-file.js` | `readSettingsFile`, `writeSettingsFile` | 设置文件读写（`$DSH_HOME/compact-relay.json`，`{v:1,config}` 信封、原子写） |
| `dsh/relay.js` | `normalizeRelayRecord`, `relayRecordOf`, `relayInboundRecordOf`, `relayOutboundRecordOf`, `legacyRelayChainOf`, `relayChainOf`, `writeRelayRecord` | **relay record 读/写/投影唯一实现**：白名单归一化（含 `scheme`/`titleSeq`/`historyTitle`，缺为 null）；`relayRecordOf` 取会话最近一条（语义不变）；`relayInboundRecordOf` = `childId === session.id` 的入站记录（0.5.1 DCR-01），`relayOutboundRecordOf` = 出站记录（`readState.next` 的数据源）；`legacyRelayChainOf` 给 0.5.0 前无记录的老链按 `header.parentSession` + 标题兜底合成只读链（DCR-02）；`relayChainOf` 投影只读链节点（`ordinal`/`baseTitle`/`parentId`/`childId`/`scheme`，`path` 有才带）；写失败只返回 false，不阻断交接 |
| `dsh/relay-chain.js` | `readRelayChain`, `MAX_CHAIN_HOPS` | **0.5.1 DCR-05 完整链服务端读取**：从当前会话起按「子会话入站 relay 记录」逐层向上（最多 8 跳、`seen` 去重）；每层优先 live 日志，未加载则 `ctx.sessionPersistence.stat(id)` 读 header + `open(id,'read').read()` 读事件（**不加载会话、不写状态**）；path 优先本跳记录、缺了用父会话 `childId+ordinal` 对得上的出站记录；老链无记录时用 header+`session/title` 逐层兜底；某层读不到返回已读行 + `unreadable` |
| `dsh/diag-counters.js` | `createDiagCounters`, `errorCodeOf`, `localIso` | **0.4 P0-2 进程内诊断计数**：压缩/交接成功失败、最近 20 个耗时样本的 p50/p95、按 `(code, phase)` 聚合的最近 20 条错误码（只收 code/phase/at/count，**不收 message**）、锁定次数；纯内存零 IO，重启清零 |
| `dsh/diagnostics.js` | `buildDiagnostics`, `renderIssueUrl`, `assertNoLeak`, `DIAG_SCHEMA` | **0.4 P0-2 诊断包构造**：逐字段 allowlist + 正则脱敏（命中替换为 `[REDACTED]`，只记数量）+ 尺寸上限（JSON ≤64KB / errors ≤20 条 / 单条 ≤200 字符），输出 `dcr-diagnostics/v1` JSON 与同源 Markdown；issue URL 只预填短字段（<7500）；零 IO 零网络 |

### actions —— 动作层（每个动作唯一实现）

| 文件 | 导出 | 职责 |
|---|---|---|
| `actions/state.js` | `readState`, `resolveTarget` | 指示灯/菜单/命令/文档元信息共用的状态快照（含单调 `revision`）；0.5.0 F4 起下发只读 `chain` 与旧字段 `relay`；0.5.1 DCR-01 起 `chain` = **本会话入站记录**投影、另加 `next`（最近出站投影），`relay` 仍是最近一条记录；0.5.0 起下发 `parentArchived`（入站父会话是否在 registry 归档集合，true/false/null）；0.5.1 DCR-03 起下发 `capabilities.unarchive`（宿主有没有恢复归档会话的接缝）；**0.5.1 批 2**：`pins.stale`（失效 pin）/`pins.atRisk`（原生压缩预判覆盖）/`sessionPinned`（本会话是否侧栏置顶）；**0.5.1 批 3**：`nextArchived`（出站目标 next.childId 是否已归档；父→子入口据此先恢复再切） |
| `actions/better-compact.js` | `betterCompact`, `betterCompactLocked`, `previewBetterCompact`, `cancelBetterCompact` | 精压：锁 → 读压力 → 选段（避开锁定）→ idle 事务 → 结果 |
| `actions/test-compact.js` | `testCompact` | `/bctest`：默认 dry-run，`confirm` 才真跑 |
| `actions/handoff.js` | `handoff`, `previewHandoff` | 交接：预览（九段草稿+就绪清单）/ 执行（压缩→写盘→建会话→切换）；**成功后自动归档旧会话**（0.5.0，见 `dsh/handoff-archive`），归档失败不阻断；**0.5.1 批 2**：`archive:false` 只交接不归档；旧会话在侧栏置顶时必须 `confirmUnpin:true` 才归档（否则 `status:'pinned'`，不静默取消置顶） |
| `actions/recover.js` | `recoverArchivedSession` | 0.5.0 恢复入口：调 `workspaceRegistry.unarchiveSession(id)`（幂等），供 HTTP `action:'recover'` 与老客户端兜底 |
| `actions/relay-chain.js` | `readCompactRelayChain` | **0.5.1 DCR-05**：HTTP `/api/compact-relay-chain` 与 `dsh/relay-chain.readRelayChain` 之间的薄包装（adapters 不直接碰 dsh/） |
| `actions/handoff-docs.js` | `listDocs`, `readDoc` | 交接单列表/全文（HTTP 适配层调用） |
| `actions/compact-diff.js` | `readCompactDiff` | 压缩历史（A6）：最近 N 次范围/摘要预览/容量/是否提交 |
| `actions/settings.js` | `loadSettings`, `saveSettings`, `resetSettings` | 设置合并/校验/热替换；坏文件回落默认 + `settingsError` |
| `actions/lock.js` | `withLock`, `isBusy` | 每会话单飞锁 |
| `actions/inflight.js` | `createInflight` | 进行中动作的 AbortController 登记（取消用） |
| `actions/pin.js` | `pinLastTurn`, `pinByIndex`, `unpinAll`, `listPins`, `togglePin` | 锁定/解锁（写 plugin record、候选列表） |
| `actions/compress-hint.js` | `markCompressHint` | 记录模型「这里适合压缩」的判断（最小线/压缩线之间才允许） |
| `actions/native-compaction.js` | `nativeCompactionInfo`, `setNativeAutoCompactionEnabled` | DSH 原生自动压缩：读配置/开关包装（写 profile 前备份） |
| `dsh/native-compaction.js` | `readNativeCompaction`, `parseCompactionOverride`, `parseModelPolicies`, `resolveNativePolicy`, `applyAutoOverride`, `setNativeAutoCompaction` | 读/写 compaction-basic 配置（cordis.patch.yml + 默认值）：`auto` / `thresholdRatio` / `headroomTokens` / **0.5.1 批 2 新增 `retainRatio` / `retainTokens`**（仅供原生压缩覆盖预判；只认 config 直属子键，modelPolicies 可按 provider+model 覆盖） |
| `actions/compact-run.js` | `runCompaction` | **压缩执行流程唯一来源**：flush/estimateMessage 装配 → runIdle（用户取消⊕idle 信号）→ replaceRangeWithSummary + summarize；`better-compact` 与 `test-compact` 共用（差异只在选段/指令/校验参数/超时来源：正式精压传 `cfg.timeouts.llmMs`，`/bctest` 不传=180s 默认） |
| `actions/support.js` | `combinedSignal`, `beginInflight`, `finishInflight`, `cancelErrorOf` | **动作层胶水**：AbortSignal 组合、inflight 登记/注销、取消收口（cancelled 与 commit/persistence 不混淆） |
| `actions/diagnostics.js` | `readDiagnostics` | **0.4 P0-2 诊断组装**：从 cfg / `settings.view()` / `readState` / `deps.diag.snapshot()` 取数并裁成白名单输入，交给 `dsh/diagnostics` 构造（A9：adapters 不直接碰 dsh 细节） |

### adapters —— 入口适配（只做协议转换）

| 文件 | 职责 |
|---|---|
| `adapters/commands.js` | 注册 `/bc`（预览/confirm）`/handoff` `/pin` `/unpin` `/bctest`(dev) |
| `adapters/http.js` | `GET /api/compact-relay-state`、`-chain`（0.5.1 DCR-05 整链只读）、`-stream`（SSE）、`-handoffs`、`-diff`、`-settings`、`-diagnostics`（0.4 P0-2 只读诊断）；`POST /api/compact-relay-action`（preview/compact/cancel/pin-toggle/handoff/handoff-preview/native-auto） |
| `adapters/tool.js` | `mark_compress_point` 工具（0.3.4 改名，旧名 `mark_stage`）：模型判断「压缩节点」→ `actions/compress-hint.js` → plugin record |
| `adapters/prompt.js` | `registerCompressCue` / `compressCueFor`：注册 systemPrompt 动态 context（order 300），同步读状态缓存给出「可压缩区间」提示；异常/缺服务返回 ''，不影响宿主 |

## 3. 接口契约（关键签名）

```js
// actions/state.js —— 唯一状态快照
readState(deps, {sessionId}) -> {
  sessionId, pressure, window, ratio,
  summaries, advice,               // 'none' | 'compact' | 'handoff'
  compressHint, busy,              // compressHint: null | {ratio, at, seq}（模型判断点）
  native,                          // DSH 原生自动压缩：{autoEnabled, thresholdRatio}
  relay, chain, next,              // 接力链：relay = 最近一条 record 原样（出站/入站都可能）
                                   //   chain = 本会话**入站**记录（childId===self）的只读投影
                                   //   {ordinal, baseTitle, parentId, childId, scheme, path?}
                                   //   老链无记录 → header 兜底合成（多一个 synthesized:true，无 path）
                                   //   next = 最近一条**出站**记录的投影（父→子入口用；0.5.1 只下发）
                                   //   没有链信息 → chain/next 为 null；记录没写的字段 → null
  parentArchived,                  // 入站父会话在 registry 归档集合里？true/false/null（不知道）
  nextArchived,                    // 0.5.1 批 3：出站目标 next.childId 是否在归档集合里
                                   //   true/false/null（没有 next 或读不到）；与 parentArchived 对称
  capabilities,                    // {unarchive:boolean} —— 宿主有没有恢复归档会话的接缝
  pins: {                          // 0.5.1 批 2：锁定消息的三层视图（只加不改）
    count, seqs, marks,            //   live：仍在当前 surface（0.5.0 语义，老客户端照用）
                                   //   marks 是位置标记（0–1），0.5.1 起环上不画；数据面照常
                                   //   下发，归 0.6 时间线（timeline）消费
    stale: {count, seqs, native, other, unknown},
                                   //   失效：快照里有、surface 上已被压缩/历史变化带走
                                   //   原因计数只读日志判定（native=原生自动压缩）
    atRisk,                        //   null | {count, seqs}：下一次原生自动压缩会覆盖的 pin
  },
  sessionPinned,                   // 本会话是否在侧栏置顶（true/false/null=宿主读不到）
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

// actions/handoff.js（M3；0.5.1 批 2 扩展）
handoff(deps, {agent, signal, commandId, edits, archive = true, confirmUnpin = false}) -> {
  ok, childId, path, started, message,   // childId 给客户端自动切换；started=文档是否已起第一轮
  archive: {status, archived},           // archived|already|skipped|pinned|active|unavailable|unknown|failed
}
// HTTP /api/compact-relay-action {action:'handoff', archive?:boolean, confirmUnpin?:boolean}
//   archive 缺省 true（0.5.0 行为）；false = 只交接不归档
//   confirmUnpin 缺省 false：旧会话置顶时服务端拒绝自动归档（status='pinned'），
//   只有客户端在「归档会取消置顶」确认后显式传 true 才归档

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
                          ├─ dsh/handoff-writer（完整 surface + 九段指令 → 模型写文档）
                          ├─ core/handoff-doc（元信息头 + 写盘）
                          └─ dsh/sessions.createHandoffSession
                               ├─ ctx.agents.create（会话+agent，同 cwd/preset/模型）
                               ├─ workspaceRegistry.attachSession（同工作区）
                               ├─ sessionTitle.rename（交接第 N 次：<原标题>）
                               ├─ childAgent.followup（文档成为首条消息并起第一轮）
                               └─ relay record 双写（0.5.0 地基，详见 §8.8）
                                    ├─ 父会话 ← actions/handoff 写（含 path/旧字段；形状不变）
                                    └─ 子会话 ← createHandoffSession 写（ordinal/baseTitle/scheme/titleSeq）
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
15-shared / 16-markdown / 20-format / 30-indicator / 40-handoff / 50-settings / 90-apply），由
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

**帧体积口径**（0.5.1 定稿，实测：中段会话 + 200K 窗口 + 4 节点，`JSON.stringify(readState)`）：
整帧 ≈ 2.1KB，其中 `chain` ≈ 215B、`next` ≈ 215B、`nextArchived`/`parentArchived` 各 4–5B、
`pins` ≈ 110B（`stale` 为空时 ≈ 54B，`atRisk` 为 null）、`capabilities` ≈ 18B、`sessionPinned` 4–5B。
0.5.1 相对 0.5.0 的 additive 增量 ≈ 300B/帧（`next` + `nextArchived` + `pins.stale/atRisk` +
`sessionPinned` + `capabilities`），与 0.5.0 的 `chain`（215B）同一量级；**没有**把标题正文、
日志、交接单内容搬进帧里（`test/state-passive.mjs` 锁 `chain` < 512B）。
完整交接链是**按需**的：默认一次 `GET /api/compact-relay-chain` 由服务端只读持久化日志
（≈ 每层几十字节的 header/记录摘要，不加载会话）；老宿主没有该端点时回落逐级 state GET
（每层 ≈ 2KB、最多 8 层）。两者都不参与 SSE 帧、不轮询；不展开时零额外请求。

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
| `defineTool` | `@deepseek-ai/dsh-tools` | M4 注册 `mark_compress_point` 工具（参数/输出 schema、render） |

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
| 可压缩区间提示文案 / 桶 / 抑制 | `core/compress-cue.js` | systemPrompt、工具、客户端各写一套容量判断 |
| 状态缓存（提示同步读） | `dsh/state-hub.js` `latestState` | 提示回调里自己 measure / 各存一份 ratio |
| 普通对象判定（`isPlainObject`） | `core/object.js` | config/设置文件/actions 各写一份 |
| token 口径 / 遮罩 token 求和 | `core/tokens.js` | 选段、state、预览、执行各写一遍 `heuristicTokens ?? tokens` |
| summary/end/replace 配对扫描 | `dsh/compaction-pair.js` | countSummaries 与压缩历史各扫一遍日志 |
| 模型调用前置 / cache 对齐 / callStream+finish 装配 | `dsh/model-task.js` | summarizer 与 handoff-writer 各写一份 |
| 压缩执行流程（idle→信号→事务→摘要） | `actions/compact-run.js` | 正式精压与 `/bctest` 各写一遍事务参数 |
| AbortSignal 组合 / inflight 登记 / 取消收口 | `actions/support.js` | 每个动作自己 `inflight.begin/finish` + 判 commit/persistence |
| client 环几何 / 原生线 / 浮层材质 | `lib/client/15-shared.js` | 指示灯与设置页教学图各画一遍、7 处浮层各抄 5 行样式 |
| 交接单 markdown 解析 | `core/markdown-lite.js`（client 内联） | 面板/其它入口各写一份解析/渲染 |
| 诊断计数 / p50-p95 / 错误码聚合 | `dsh/diag-counters.js` | actions 各自维护计数器、各自算分位数 |
| 诊断产物构造 / 脱敏 / 尺寸上限 | `dsh/diagnostics.js` | HTTP、客户端各拼一份诊断 JSON/Markdown 或各写一套脱敏 |
| 诊断取数 / 白名单裁剪 | `actions/diagnostics.js` | adapters 直接读 cfg/readState 拼诊断 |

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

- 根级插件只能 inject **根服务**：`commands` / `agents` / `tokenMeter` / `llm` / `sessions` / `tools` / `systemPrompt`；
  `webServer` 用 `ctx.inject(['webServer'], cb)` 单独要。0.3.4 起 `systemPrompt` 用于注入「可压缩区间」
  动态提示；它是 DSH 0.2.x 核心根服务，**缺失时插件会 pending、apply 不会执行**（cordis inject 语义）；
  apply 里的 `typeof ctx.systemPrompt?.context === 'function'` 守卫只针对「服务在但形状不对」的异常环境。
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

---

## 8.8 0.5.0 relay record 双写与 `readState.chain`（命名反转已实现）

**为什么双写**：接力链的事实既要让「下一次从父会话交接」读到（父会话日志），也要让
「子会话自己」知道「我是第几次、原名是什么」（子会话日志）。命名反转后，子会话
标题继承干净原名（`历史 N` 在旧会话那边），标题里不再有「交接第 N 次」——链号必须自带。
同一跳交接因此写两条 `plugin:compact-relay/relay`（都是 `ignorable`，不进模型上下文、
不算 token、压缩碰不到）：

| 写在哪 | 谁写 | 字段 | 用途 |
|---|---|---|---|
| **父会话**日志 | `actions/handoff.js`（子会话建好、旧会话改名之后） | `parentId`/`childId`/`ordinal`/`at`/`atIso` + 0.3 旧名 `parentSessionId`/`index` + `path`/`planId`/`title`/`baseTitle` + `scheme`/`titleSeq`；新链再带 `historyTitle` | 父会话的下一次交接读它续号；带交接单路径；`titleSeq` 是旧会话 rename 的 eventSeq，`historyTitle` 是旧会话改名后的「历史 N」 |
| **子会话**日志 | `dsh/sessions.js` `createHandoffSession`（`followup` 后、`flush` 前） | `parentId`/`childId`/`ordinal`/`baseTitle`/`title`/`scheme`（本次链的 `history-n`/`handoff-n`）/`titleSeq`（子会话 rename 的 eventSeq）/`at`/`atIso`/`path`（交接单文件；0.5.0 起子记录也写，接力条在子会话可直接打开交接单） | 子会话自带链号；新标题不带序号后仍能算出「下次第 N+1 次」 |

同一跳的两条记录，`ordinal`/`childId`/`baseTitle`/`scheme` 必须相同（`test/relay-chain.mjs` 锁住）。
0.5.0 命名反转**有意改变**了父记录写出形状：F2/F3 当时的「父记录不写 scheme/titleSeq」是
地基期约束，本功能起父/子记录都写 `scheme` + `titleSeq`（F5 期望已随之更新）。

**命名反转落点**（`dsh/sessions.js` + `actions/handoff.js`）：

1. `handoffTitlePlanOf` 先看会话自己的 relay record：`scheme='history-n'` 才走新链；0.3/0.4
   旧记录（scheme 为 null）→ 旧链（链级 cutover，不迁移）。没有记录才回退标题解析：干净
   标题/「历史 N」→ 新链；「交接第 N 次」/旧「交接」「接棒」堆叠 → 旧链；读不到标题 →
   保守按旧链。
2. 新链：子会话标题 = 干净原名；子会话建好后 `renameHistoryOf` 把旧会话改名
   「历史 N：<原名>」并 flush。改名失败只 warn、不阻断交接；当前标题已是本次目标时跳过
   （重复执行不叠前缀）。旧链：完全不碰旧会话标题。
3. 80 字节预算：`historyTitleOf(..., MAX_TITLE_BYTES)` 先算前缀、只缩 base；子会话原名同样
   按 `MAX_TITLE_BYTES` 截断，避免宿主 `session-title` 把「历史 N：」前缀截掉。
4. `handoff.js` 在父记录写完后 flush 旧会话，保证「历史 N」标题和父记录一起落盘。

**读侧**（`dsh/relay.js`）：

- `relayRecordOf(session)`：从日志尾部找**最近一条**合法 record（父/子记录都算）；交接时
  用它算下一跳标题，坏记录跳过。**0.5.1 语义不变**（`readState.relay` 仍用它）。
- `relayInboundRecordOf(session)` / `relayOutboundRecordOf(session)`（0.5.1 DCR-01）：
  按 `childId` 与 `session.id` 的关系分开找 —— 入站记录是「我是被谁交接出来的」，
  出站记录是「我把接力棒交给谁」。接力条只认入站（`readState.chain`），出站走
  `readState.next`。同一跳记录在父、子两侧各写一条，所以同一条会话日志里可能两种都有。
- `legacyRelayChainOf({session, title})`（0.5.1 DCR-02）：0.5.0 之前的老链子会话没有
  record → 用 `header.parentSession` + 「交接第 N 次：」标题合成只读链；排除
  `origin='subagent'` 与 `isSeeded=true`（fork 继承前缀不是交接），读不到标题不猜。
- `normalizeRelayRecord(data)`：白名单 + 旧字段补齐（`parentId`↔`parentSessionId`、
  `ordinal`↔`index`）；`scheme`/`titleSeq`/`historyTitle` 缺失或非法 → `null`（不猜）。
- `relayChainOf(record)`：给 `readState` 的只读投影，**不是解析**——只取
  `ordinal`/`baseTitle`/`parentId`/`childId`/`scheme`，`path` 有才带（没有就不出现这个键）；
  不读标题、不补默认序号、不从其它字段反推 scheme。
- `readState` 同时下发旧字段 `relay`（原样，含 0.3 旧名）与新字段 `chain`（**入站**投影）
  与 `next`（出站投影）；没有链信息时 `chain` 为 `null`。additive 变更，老客户端忽略新字段即可。
  `parentArchived` 由 `chain.parentId`（入站父会话）查 registry；老链兜底链也能查。
  0.5.1 批 3 起再加 `nextArchived`（`next.childId` 的归档状态）——两者各查各的 id，互不代偿：
  父会话侧可能「自己已归档、下一代没归档」，反过来也一样。
  0.5.1 批 3 起接力条**两侧都渲染**：子会话侧看 `chain`（已接力自），父会话侧看 `next`
  （已交接给新会话），中段会话两个都显示（见 §8.10）。

**兼容边界**：0.4 及更早的 record 没有 `scheme`/`baseTitle`/`path` → `chain` 对应字段为
`null`，链号仍可从 `ordinal`/`index` 读出；子会话没有 record 的旧历史 → 下一次交接回退
标题解析（「交接第 N 次：」仍按旧规则递增，旧标题一个字符不改）。

**测试**：`test/relay-chain.mjs`（三跳链序号、双写形状、scheme 不混、旧链逐字节、
`relayChainOf` 投影、`readState.chain`=入站/`next`=出站、DCR-02 老链兜底）+
`test/relay-title-scheme.mjs`（纯函数）+ `test/handoff.mjs`（子会话 record）+
`test/state-passive.mjs`（chain/next/capabilities 下发）。

---

## 8.9 0.5.1 批 2：pin 失效标注 / 原生压缩预警 / 置顶保护 / 归档开关

**pin 失效（C 方案）**：`latestPinnedSeqs(日志)` 是「用户最后一次锁定」的快照；原生自动压缩不认
pin，按自己的保留尾部选段把锁定消息压走后，这些 seq 就不在 `session.surface.nodes` 里了。
旧实现 `livePinnedSeqs` 直接过滤掉它们 → 界面上凭空消失。现在 `core/pin-health.pinHealthOf`
把快照拆成 `live` / `stale`，`readState.pins.stale` 下发（`count/seqs` + 原因计数），客户端在
悬停卡与菜单显示「已失效 N 条（随原生压缩移除）」。`pins.count` 仍是 live 计数（老客户端语义
不变）。**0.5.1 设计定稿：环只表达容量，所有 pin（含失效）都不画到环上**——位置标记归 0.6
时间线，`pins.marks` 数据面照常下发；界面只在悬停卡/菜单显示「已锁定 N 条 / 已失效 M 条」
（见 §8.12）。

菜单的 `pin-toggle` 与展示同口径：快照非空（含全部失效）→ 清空记录；只有完全没有 pin 快照时
才锁最近一轮（0.5.1 批 2 把 P3-03 的「live=0 就锁」改成快照判定，因为菜单现在会显示
「解除失效锁定」）。

**失效原因**只读日志：被 replace 覆盖的 seq → `compaction/start`；`turn` 非空 = 原生自动压缩
（宿主 compaction-basic 的 automatic pressure 路径把事件包在 open turn 里）；`turn:null` = 其它
压缩（本插件 /bc、宿主 /compact）；找不到 replace = 历史变化（unknown）。不把 unknown 冒充成
原生压缩。

**原生压缩吃掉 pin 的提前保护 = 事前**（不是只能事后）：
- 宿主信号：① `compaction-basic` 的 `thresholdRatio` / `headroomTokens` / `retainRatio` /
  `retainTokens` 可从 profile 读到；② 真实触发线 `native.thresholdTokens` 已由 0.4 P2-3 算出；
  ③ 当前压力每帧都有（`measurePressure`）；④ 选段算法在宿主源码里是纯函数（保留尾部 +
  工具配对平衡）。
- `core/native-pin-risk.nativePinnedRiskOf` 用同口径复刻选段，state 只在「auto 开 + 压力 ≥
  真实触发线 + 节点定价与 surface 对齐」时预判，得到 `pins.atRisk`；客户端悬停卡/菜单/一次
  toast 提示「原生压缩预计覆盖 N 条锁定消息 → 先交接或解锁」。
- 限制：宿主没有「即将压缩」事件，真正执行在 step boundary；预判用的是当前 surface 与
  retainTokens（0.2.1-rc.3 默认 0.16，用户配置优先），所以文案写「预计」。压缩真发生后，
  `pins.stale` 仍会兜底标出实际损失（事后口径不丢）。

**置顶保护**：宿主 `@deepseek-ai/dsh-workspace` 的 `WorkspaceRegistry.pinnedSessionIds` 可读；
`archiveSession` 在**同一次 durable write** 里把该 id 从置顶集合移除（置顶与归档互斥）。所以
「归档会取消置顶」是宿主真实行为。handoff 默认 `archive:true`，但若 `isSessionPinned` 为 true
且未显式 `confirmUnpin:true`，服务端**不归档**（`status:'pinned'` + 文案），旧会话与置顶都保留；
客户端交接预览在 `sessionPinned===true` 时弹确认，给「交接并归档（取消置顶）」与「只交接，
保留置顶」两个出口。旧客户端（不传 confirmUnpin）在置顶会话上自动降级为不归档，不会静默取消
置顶。

**归档开关**：`handoff` 的 `archive` 默认 true（0.5.0 行为）；HTTP `{action:'handoff', archive:false}`
= 只交接不归档。首次引导（onboarding）明确写「交接后默认自动归档旧会话，可取消勾选」。

**与批 3 的边界**：以上全是「归档集合 / 置顶集合 / pin 健康」的**判断**，不涉及跨会话导航。
批 3 的完整交接链与父→子入口（§8.10）只读 state、只调宿主公开的 `openSession` /
`unarchiveSession`：不改归档集合、不改 pin 记录、不写日志；新的入口延续同一口径——先把归档
恢复再切，不在 UI 层吞掉错误（失败就提示并保持菜单可用）。

## 8.10 0.5.1 批 3：完整交接链与父→子入口

**为什么客户端自己逐级读（批 3 的历史决策，现为老宿主兜底）**：接力链的权威数据在服务端
每个会话的日志里（relay record），`readState` 只回答「我这一个会话」。要「回看前几次」有
两条路：① 服务端加一个跨会话链接口；② 客户端拿 `chain.parentId` 逐级去读各会话的 `readState`。
批 3 先选 ②（零新增端点、面板通常 1–3 跳）；**批 4 发现宿主对未加载会话返回 `sessionId:null`
后改选 ①**，见 §8.11。本节描述仍保留，作为老插件/老宿主没有整链端点时的回落路径。

**读法（`client/35-relay-bar.js` 的 `loadChain`）**：

1. 起点 = 本会话的 `chain`（入站；老链无记录时是 DCR-02 合成的 `synthesized` 投影）；
2. 每一跳：取 `cursor.parentId` → GET `/api/compact-relay-state?sessionId=<parentId>` → 用
   它的 `chain`（**父会话自己的入站**）作为下一层 cursor，`parentId` 为空即到头；
3. **每层一次 GET**，顺序串行（不并发、不预加载：点「完整交接链」之前不发任何祖先请求）；
4. 上限 `MAX_CHAIN_HOPS = 8`；`seen` 按 sessionId 去重（自指/成环立刻停）；
5. 失败（HTTP 4xx/5xx、`ok:false`、JSON 坏，或**宿主还没加载那一层** —— 响应的 `sessionId`
   对不上，重启后祖先会话通常如此）→ 停在断点：已读到的行保留 + 「无法读取更早的链路」+
   「重试」；「没加载」不能当成「没有父会话」（否则会静默少列一层）。重试**从断点续读**
   （已读到的层不重复拉）；用户先把那个会话打开（侧栏，或主菜单「回到原会话」）再重试即可续上。
   关菜单/换会话/跳转成功都会把请求序号 +1，晚到的响应直接丢弃。

**每一行怎么来**：行 = 「下一层（子）会话的入站 chain」，所以 `ordinal`/`baseTitle` 正好是那
一层会话改名后的标题 —— 文案复用 `relayBarLabelOf`：新链「历史 N：<原名>」，旧链「交接第 N
次：<原名>」（与接力条同一把尺子，不另造一套）。交接单路径优先取该层记录里的 `path`；旧记录
没写 path 时，用该层会话 state 的出站 `next.path`（要求 `childId` 与链号都对得上，与接力条
补 path 同口径）。行内「交接单」只在能取到 `handoff-*.md` basename 时可点（接口只收 basename）。

**跳转与归档**：行点击 → `ctx.uiWorkspace.openSession(sessionId)`。祖先会话在默认流程里已被
交接归档，直接 open 会被宿主拒绝（DCR-03 的死入口），所以先 `unarchive`（宿主 API，老宿主
退回 HTTP `action:'recover'`，幂等）再 open，失败换通道重试一轮。

**父→子（TD-01）**：`readState.next` 是出站投影，父会话侧据此渲染「已交接给新会话」+ 菜单
「去新会话」→ `openSession(next.childId)`；`nextArchived` 为 true 或 null 且有恢复能力时同样
先 unarchive 再 open。两个防御：老插件没有 `next` 字段时不显示（**不回落** `chain`：老形态的
chain 是最近一条记录，可能是入站，回落会出现「跳回自己」）；`next.childId === 本会话` 的脏
记录一律不认。**限制**：`next` 只取**最近一条**出站记录 —— 同一条会话交接过两次时，更早的那个
下一代会从「去新会话」里消失（仍可在侧栏找到）；跨会话全时间线属于 0.6 的「路线图」面板。

**测试**：`test/relay-bar.mjs` §8（按需/每层一次 GET、8 跳上限、成环去重、失败重试续读、
未加载也不误判到头、行内交接单 basename、无 path 禁用、行点击先恢复再切、父会话侧「去新会话」
与归档先恢复、中段会话两个方向）+ `test/state-passive.mjs`（`nextArchived` 三类取值与「各查各的 id」）。

## 8.11 0.5.1 批 4：完整链未加载修复（DCR-05）

**真机 bug**：点「完整交接链」只显示 1 层（当前会话）+「无法读取更早的链路」。根因是批 3 的
逐级 `readState` 口径：宿主对**没加载进内存**的会话返回 `sessionId:null`（`readState` 的
`target` 为 null），客户端把它当「读不到」停在断点；重启后祖先会话通常都没加载，所以这是
常态。**不能**靠「先打开每个祖先再读」修：那是把一次查看变成 N 次会话切换。

**宿主能力实证**（DSH 0.2.1-rc.3 `app.asar`）：

- `@deepseek-ai/dsh-session-persistence` 是根服务 `ctx.sessionPersistence`；
- `stat(id)` → `{header, revision, sizeBytes?}`，**不读事件日志**；
- `open(id, 'read')` → 只读 `SessionHandle`（不创建 live Session、不写任何状态、不占写锁），
  `handle.read()` → `{events, eventState}`，`close()` 释放；
- `dsh-session-persistence-jsonl` 对**已归档**会话同样可读：归档只改 Workspace registry 的
  集合，不改持久化文件。

**服务端读取（`dsh/relay-chain.js`）**：

1. `sessionPersistenceOf(ctx)`：`ctx.get('sessionPersistence')`；没有该服务 → `ok:false`
   `unsupported`（客户端回落 §8.10 的逐级读法）；
2. 当前会话优先 live 日志（刚写入未落盘的 relay 记录也在），否则 `stat` + `open('read')`；
3. 循环：`cursor = 子会话的入站 relay 记录`；每层父会话读 header/events → 行
   `{sessionId, ordinal, baseTitle, scheme, path}`；`path` 先用本跳记录，缺了再找父日志里
   `childId+ordinal` 对得上的出站记录；`cursor` 换成父会话自己的入站记录（或 DCR-02
   header+标题合成）；`parentId === null` 到头；
4. 上限 `MAX_CHAIN_HOPS = 8`；`seen` 去重（成环立刻停）；某层读不到 → 返回已读行 +
   `unreadable:{sessionId, reason:'not-found'|'error'}`，不整块清空；
5. 全程只读：不 append、不 open 写句柄、不改归档/置顶/标题。

**端点契约**：`GET /api/compact-relay-chain?sessionId=`（与其它 GET 端点同一套
`connection.requestRejection` 鉴权/同源校验；只支持 GET；缺 sessionId → 400）。

```json
{ "ok": true, "sessionId": "session-x",
  "rows": [ { "sessionId": "session-parent", "ordinal": 2, "baseTitle": "原题",
              "scheme": "history-n", "path": "/Users/.../handoff-....md" } ],
  "done": true, "capped": false, "unreadable": null }
```

失败：`{ok:false, code:'unsupported'|'not-found'|'read-failed', message}`（客户端据此回落）。

**客户端（`client/35-relay-bar.js`）**：

- `loadChain` 先打整链端点：`ok:true` 直接渲染（不再逐级 GET；测试断言祖先 state GET = 0）；
  非 2xx/`ok:false`/形状不对 → 回落 §8.10 的逐级读法；
- 逐级兜底断点：宿主明确回 `sessionId:null` → 显示「上一层会话未打开」+
  **「打开并继续」**；点击先双通道 `unarchive`（复用 DCR-03，幂等；无归档记录也继续）→
  `openSession(parentId)` → 轮询 `/api/compact-relay-state` 等宿主加载（≤8 次）→
  `loadChain(resume)` 自动续读；加载不上 → 提示「已打开上一层会话，再点完整交接链继续」；
- 整链端点 `unreadable.reason==='not-found'`（持久化里根本没有该层）**不显示**「打开并继续」，
  只保留「重试」——打开也救不回来，不造必然失败的入口（与 DCR-03 同口径）；
- 保留：已读行不丢、返回主菜单不受影响、8 跳上限、去重、行内交接单 basename 校验。

**测试**：`test/relay-chain-endpoint.mjs`（12 条：祖先全未加载仍读全、live 优先、8 跳上限、
成环去重、断点保留、无持久化、老链 header+标题兜底、subagent/fork 不合成、HTTP 200/400/405、
无服务 ok:false、鉴权 401）+ `test/relay-bar.mjs`（未加载入口、点击 unarchive+openSession+
自动续读、整链端点一次读全、部分失败入口）。

## 8.12 0.5.1 设计定稿：环只表达容量（pin 位置标记归 0.6 时间线）

**决策（2026-10-26 用户拍板）**：环管「未来」——容量、阈值、断点、原生线刻度；pin 的位置是
「历史」——在环上画锁定消息的位置属于复现历史功能。0.6 的时间线会承接 pin 历史（数据面
`state.pins.marks` 与 marks/timeline 已备好），所以 0.5.1 起**环只表达容量，不画 pin 位置**。
「已锁定 N 条 / 已失效 M 条」作为状态保留在悬停卡与菜单。

**实现**：
- `client/30-indicator.js` 删除环上 pin 位置块的渲染（`pinBlocks` / `data-cr-pin-mark` 的
  `circle` 节点）；环的 SVG 只剩分段弧、断点、原生线刻度、交接线警示与中心点。
- **数据面不动**：状态归一化仍读取 `state.pins.marks`（0.3.1 起下发，0.5.0 语义不变），
  0.6 时间线直接消费；注释写明「位置标记归 0.6 时间线，环不再画」。
- 悬停卡与菜单的 pin 计数/失效文案保持不变（`data-cr-pins` / `data-cr-pins-stale` /
  `data-cr-pin-stale` 取证属性照旧）。
- `colors.base.pin`（锁定颜色）保留在设置与 colors 契约里——它是 0.6 时间线的 pin 标记颜色，
  0.5.1 环上不再使用。
- 教学图（设置页示意环）本来就不画 pin；`data-cr-pin-mark` 此前只被指示灯使用，删除后全库无残留。

**为什么不在环上留任何 pin 标记**：环的语义是「还剩多少容量、什么时候压/交接」；把历史位置
叠上去会让「未来」和「历史」两种信息抢同一个视觉通道。状态的表达交给悬停卡/菜单（纯文本计数），
历史位置交给 0.6 时间线（独立视图，不挤占环）。

**测试**：
- `test/relay-bar.mjs`：有 pin（marks 非空）时环上 `data-cr-pin-mark` 为 `null`；
  `data-cr-pins` / `data-cr-pins-stale` 与悬停卡「已锁定 N 条 / 已失效 M 条」、菜单
  「已锁 N 条 · 失效 M」仍在。
- `test/archive.mjs` 产物守卫：源码与 bundle 都不得再含 `data-cr-pin-mark`；源码必须保留
  `marks: Array.isArray(data.pins.marks)` 与「位置标记归 0.6 时间线」注释。

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
│  │  ├─ 16-markdown.js（内联 core/markdown-lite.js + React 渲染）
│  │  ├─ 20-format.js / 30-indicator.js / 40-handoff.js / 50-settings.js / 90-apply.js
│  ├─ core/                     # 纯函数
│  │  ├─ config-schema.js colors.js errors.js policy.js ranges.js prompts.js
│  │  ├─ handoff-spec.js handoff-doc.js handoff-facts.js readiness.js
│  │  ├─ validate-summary.js validate-handoff.js placeholders.js
│  │  ├─ compress-hint.js compress-cue.js markdown-lite.js ring.js pins.js relay.js
│  │  ├─ object.js（isPlainObject）/ tokens.js（token 口径）
│  ├─ dsh/                      # 能力封装（唯一 import @deepseek-ai/* 的地方）
│  │  ├─ engine.js pressure.js session-view.js select-range.js route.js prefix.js
│  │  ├─ stream.js llm-call.js summarizer.js handoff-writer.js
│  │  ├─ compact-transaction.js idle.js sessions.js
│  │  ├─ state-hub.js site-info.js handoff-files.js session-files.js
│  │  ├─ compaction-log.js compaction-pair.js settings-file.js relay.js native-compaction.js
│  │  ├─ model-task.js（模型任务公共装配/收尾）
│  │  ├─ diag-counters.js / diagnostics.js（0.4 P0-2 诊断计数 + 诊断包构造）
│  ├─ actions/                  # 动作层
│  │  ├─ state.js better-compact.js test-compact.js handoff.js
│  │  ├─ handoff-docs.js compact-diff.js settings.js
│  │  ├─ lock.js inflight.js pin.js compress-hint.js native-compaction.js
│  │  ├─ compact-run.js（压缩执行流程）/ support.js（信号/inflight/取消收口）
│  │  ├─ diagnostics.js（0.4 P0-2 诊断组装：取数 + 白名单裁剪）
│  └─ adapters/                 # 入口适配
│     ├─ commands.js / http.js / tool.js / prompt.js
└─ test/
   ├─ smoke.mjs / handoff.mjs / plugin-load.mjs / contract.mjs / compact-log.mjs
   ├─ diagnostics.mjs（0.4 P0-2：T1–T9 诊断包单测）
   ├─ harness/                  # A7：统一 mock（host / session / llm / dsh-stubs）
   └─ e2e/                      # 隔离 DSH 端到端（smoke / settings-ui / real-compact / action）
```

> `lib/client/` 片段与 `scripts/build-client.mjs` 留在仓库（保证可重建），但**不进 npm 发布包**（`files` 里的 `"!lib/client"`；发布只带构建产物 `lib/client.js`）。
