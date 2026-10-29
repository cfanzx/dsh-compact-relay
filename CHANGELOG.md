# Changelog

## 0.5.5（2026-10-29，0.5.4 的 debug 版）

> 修用户反馈：**收藏后星标「自动消失」**。只改客户端样式注入，收藏数据/后端/0.5.4 建议逻辑零改动。
> 测试 **396 → 398 PASS**（新增 2 条组件契约）。

- **根因**：星标挂在宿主的助手消息 hover 动作行里。宿主 CSS（`MessageIconActions.module.css`）对
  `[data-actions-reveal="hover"]` 的行默认 `opacity:0`，`:hover`/`:focus-within` 才恢复——收藏后星标仍在
  DOM、`aria-pressed=true`，但整行透明，鼠标一移开就看不见。不是收藏丢失、也不是 0.5.4 回归。
- **修法**：注入 CSS `:has()`，只把「含已收藏星标的 hover 动作行」强制 `opacity:1 !important`；非 hover /
  非键盘焦点时，同行其它按钮与同 slot 的其它插件按钮保持视觉隐藏且 `pointer-events:none` → **常亮的只有
  已收藏星标本身**，hover/focus 时完整动作行照常出现。选择器只用两个稳定锚点（`[data-actions-reveal="hover"]`、
  `[data-slot="conversation.chat.assistant-actions"]`），**不依赖宿主哈希类名**；触屏（`hover:none`）不生效；
  不支持 `:has()` 的旧浏览器整段忽略、回退现状不误伤。
- **取消收藏**：立即恢复宿主原来的 hover 隐藏行为；未收藏消息行为不变。

## 0.5.4（2026-10-29，0.5.3 的 debug 版）

> 0.5.3 发布后的针对性修复，只动收藏/推荐两处数据面与预览卡文案，**压缩主流程零改动**。
> 测试 **391 → 396 PASS**。

- **D1 建议候选过滤工具角色**：预览卡「建议先收藏」只保留用户/助手消息；工具结果里的报错堆栈
  不再占名额（`suggestPinCandidates` 的 limit 先于角色过滤，工具占满时会用同一函数对用户/助手
  事件重跑一遍，不新写识别）。`favorited` 列表不过滤（工具输出仍可手动收藏）。
- **D2 无正文标题兜底**：预览收藏条目里「（无文本）」显示为「第 <seq> 条」，可按序号找回；
  `core/favorites.buildFavoriteTitle` 未动（压缩摘要的收藏目录口径不变）。
- **D3 压缩后清理推荐建议**：watcher 收到 `compaction/summary`/`compaction/end` 即清空本会话
  建议、取消待跑去抖、用世代号作废在跑打分结果——被压走的消息不再残留在 `/favorite suggest`
  和星标建议上；`compaction/start` 不清（事务可能失败）。压缩后新回合照常产生建议。

## 0.5.3（2026-10-29，已发布）

> 从 0.5.2 发布点 `e4bd0b2` 拉出的分支 `fix/0.5.3`。主题：**收藏（pin 退役）+ 推荐收藏**，
> 外加 0.5.2 真机验证带出的两个 P2 语义修正。测试 **375 → 385 PASS**（含 build-client --check）。

### 收藏：把「标记」和「落档」彻底分成两步（b72fcdf / 6bec539）

- **收藏 = 纯标记**：项目级 JSONL 只记 `{op, sessionId, seq}`；不复制正文、不改变压缩选段、
  不占预算。**标记层不依赖活 agent**：归档/关闭的会话也能按 `sessionId + seq` 标记
  （`action:'favorite-mark'`），收藏文件按**链根会话 id** 稳定定位，旧「标题-短 id」文件名只读兼容。
- **固定入口**：`/favorite mark [seq]`（不带 seq 标最后一条已完成回复）；助手消息底部星标保留
  （`action:'favorite-toggle'`，按 messageId 反查所属会话，客户端 sessionId 缺失/过期也能落对）。
- **落档只在压缩时**：摘要里追加「收藏（本段）」目录 + `~/.dsh/dcr-favorites/snapshots/<根id>.md`
  快照。压缩后再补标记时**当场写快照**（原文还在日志里才能写；读不到明确报错，不假装成功）。
- **压缩预览卡补收藏区**（0.5.3 收口）：确认卡显示「本段 N 条 · 已收藏 M 条 · 建议补 K 条」，
  列出本段已收藏条目（`[用户]/[助手]` + 标题）与「建议先收藏」候选（复用原 pin 候选识别：
  关键决策/报错堆栈/明确要求别改），每条带「收藏」按钮（`favorite-mark` 按 seq、用户发言也可标）；
  只提示+手动点，绝不自动收藏。preview 响应新增 additive `favoritePreview` 字段。
- **明确局限**：标了不压缩 = 只留一个序号；归档会话能标，但 0.5.3 不读会话档案拿原文（归 0.6）。

### 推荐收藏：打分 → 点亮建议（5ad9b3c / 30709a9）

- `dsh/favorite-scorer.js`：flash 档、关思考、temperature 0，只回 JSON 分数；失败静默降级（不亮）。
- `dsh/favorite-watch.js`：监听 `assistant/message`，去抖 1.2s **只判每轮最后一条**；必亮词/屏蔽词
  先判（屏蔽 > 必亮 > 分数）；已收藏的不再推荐；**绝不自动收藏**。
- `readState.favoriteSuggest`（≤3 条：seq/messageId/分数/原因）→ 星标金色光晕（只点亮）。
- 设置项：推荐收藏开关、三档阈值（宽松 60 / 标准 75 / 严格 85，默认标准）、必亮词、屏蔽词、
  「试算」（真实打分、只读，不改任何状态）。
- 红线测试：不点星时收藏文件不新增记录。

### P2 语义修正（0.5.2 真机验证发现）

- **P2-1 幂等顺序**：`force-archive` 的 already 判断移到 `confirmStop` 之前 —— 已归档的会话不带
  二次确认也回 200 `already`（以前直接 400），`stopActivity` 明确回报 `done/skipped/failed`。
- **P2-2 错误码分档**：`actionError` 带 `statusCode`；未知会话 404、宿主缺归档接缝 503、
  内部失败 500（以前一律 400）。HTTP 只做映射，不重猜。
- **P3-a 响应瘦身**：`force-archive` / `recover` 不再回全量 `archivedSessionIds`（142 条 ≈ 7KB，
  客户端不读），改回 `archivedCount` + `newlyArchived` / `newlyRecovered`。
- **already 防漏杀加固**：已归档 + 用户显式确认时补跑一次 `stopActivity`（幂等），并在 note 里写明
  「本次已补停 / 本次未执行 stopActivity」，不假装停干净。

## 0.5.2（2026-10-28）

> 从 0.5.1 发布点 `e3c5ab3` 拉出的补丁批次（分支 `fix/0.5.2`），npm / GitHub 已发布。
> 按 `dcr-架构梳理与重构方案-2026-10-26.md` 的 0.5.x 窗口推进：**S1 契约快照 → S2 record 构造器 →
> 批 C 强制归档入口 + 文档口径修复**。测试 **347 → 375 PASS**，bundle 重建且 `--check` 通过。
>
> **契约变化（全部 additive）**：`readState` 增 `parentPinned`（旧会话是否在侧栏置顶）与
> `capabilities.forceArchive`（宿主有没有 `archiveSession`）；`/api/compact-relay-action` 增
> `action:'force-archive'`（必须显式 `confirmStop:true`，旧会话置顶时还需 `confirmUnpin:true`）。
> 自动归档的行为一个字节不改：**默认不强制、不 stopActivity**。

### 缓存对齐：侧调用沿用主请求的推理档位（2026-10-27 P1 取证修复）

- **根因（已实验定位）**：摘要/交接单调用的前缀回放逐字节正确（LCP 15 条 vs 主请求 14/14，tools
  与 toolHistory 一致），唯一致命差异是 `reasoningEffort`——旧实现固定传 `'off'`，主循环是 `'max'`；
  宿主把它翻成 wire 的 `thinking: enabled|disabled`，缓存前缀在**第一条 assistant 消息**的渲染处断开。
  隔离 A/B（同一组 prompt、真实模型）：`off` 命中 **74.0%**（复跑 73.8–74.4），改成主循环同值
  **96.9–98.2%**；生产 prompt 20–50 万 token，于是同样的断点表现为 **2–5%** 命中（≈系统提示词 11K）。
- **修法**：`prepareModelCall` 改为优先沿用 `session.requestHeader().config.reasoningEffort`
  （仅当 provider/model 与本次目标一致；否则退回旧的「模型支持 off 就 off」兜底）。
  摘要与交接单共用这条前置，所以两者都吃到缓存；`cacheAlignedControls` 的注释同步纠正。
- **配套**：`summary.maxTokens` 与 `handoff.maxTokens` 默认 8,192 → **16,384**，兜住重新开启的
  思考输出，避免 2026-10-19「思考吃光上限 → 截断」旧 bug 回归；截断重试逻辑不变。
- **测试**：新增「P1 cache 对齐」1 条（header 有档位 → 摘要/交接单同档）；更新旧断言（侧调用不再
  是 off、输出上限 16384）；非推理模型用例补真实 header 形状（无 reasoningEffort）后仍走兜底。
- **生产验证（2026-10-27 16:2x）**：隔离 A/B 两次 96.9%；真机重启后临时会话压缩 38 条/41,149 token，
  摘要 prompt 114,032（未命中 **368**），命中 **99.7%**（修复前生产 2–5%）。素材在
  `dcr-ctx-audit/forensics/findings.md §7`。

### S1 契约快照（生产行为零变化）

- 新增 `test/contract-golden.mjs`：锁 `readState` 帧（6 场景的键集合 + 结构/类型 + 链投影取值）、
  父/子 relay record（**键顺序** + null/省略语义 + 新链/改名失败/老链三条真实流程）、标题格式，
  另有负向自检（改键 / 改值 / 改类型 / 换键序都必须被抓到）。
- 口径修正：record 的**键顺序**是 JSONL 字节契约（顺序敏感，`Object.keys` 深比较）；只有 `readState`
  帧才用「排序后的键集合」。`dcr-架构梳理与重构方案-2026-10-26.md` §S1 已按实际实现同步。

### S2 `core/relay-record.js`：record 形状的唯一构造器（字节级不变）

- 新增 `lib/core/relay-record.js`：`relayRecordOfForm({role,...})` + `parentRelayRecordOf` /
  `childRelayRecordOf`。父/子 record 的键顺序、0.3 旧字段双写（`parentSessionId`/`index`）、
  `planId` 只父、`historyTitle` 条件写、`path` 条件写、`titleSeq` 恒写 null 全部收口到一处；
  `actions/handoff.js` 与 `dsh/sessions.js` 只传语义参数。
- 文档口径：§S2 表与附录 C 的 `atIso` 改为实际口径 —— 父/子**两处都是** `localIso(new Date(at))`
  （原表写成「子 `new Date(at)`、父 `at`」，是评审时的已知漂移）。

### 批 C：强制归档旧会话（0.5.x 计划 P4 / L 项）

- **入口**：接力条菜单「强制归档旧会话（会停止后台任务）」——旧会话还没归档时出现；
  宿主没有 `archiveSession`（`capabilities.forceArchive=false`）时隐藏，不做必然失败的入口。
- **二次确认**：面板明确写「会停止旧会话上正在跑的任务（turn / 子代理 / 后台任务 / 定时任务），
  中断后无法恢复」；旧会话在侧栏置顶时补一行「归档会同时取消置顶（宿主行为）」并带
  `confirmUnpin:true`（与交接前的置顶确认同口径）。
- **服务端**：新增 `lib/actions/force-archive.js`，是生产代码里**唯一**调用
  `workspaceRegistry.archiveSession(id, { stopActivity:true })` 的地方（静态守卫锁死）；
  没有 `confirmStop:true` 一律拒绝；已归档幂等（不再停任务）；置顶未确认返回 `pinned`（不静默
  unpin）；失败抛可读错误（HTTP 400 带具体原因），不静默、不假装成功。
- **告知文案**：归档成功 / 此前已归档 / 置顶未归档三套全部沿用 `handoffArchiveNoteOf`
  （含「归档会取消置顶」与「恢复旧会话」入口）。
- **默认仍不强制**：交接的自动归档照旧不带 `stopActivity`，旧会话有活跃任务时保留可见
  （单测断言 `options.stopActivity === undefined`）。
- **测试**：新增 `test/force-archive.mjs`（18 条：`stopActivity` 透传 / 缺确认拒绝 / 幂等 /
  置顶确认 / 失败可读 / HTTP 不要求活 agent / `readState` 能力位 / 默认不强制 / 静态守卫）；
  `test/relay-bar.mjs` 增 8 条组件级用例（入口 / 二次确认 / 透传 / 失败 / 置顶 / 服务端回报
  pinned 后重发 / 能力缺失隐藏 / 已归档不再显示）。合计 **347 → 375 PASS**。

### UI 修复：交接预览草稿框被 flex 压成 0 高

- **症状**：真机截图确认，交接预览弹窗里九段草稿的只读预览框塌成 14px 一条缝
  （上下边框各 1px + padding 6px×2，内容高度 0），九段草稿完全看不见，只能看到第一行文字被切掉的
  上半截。
- **根因**：弹窗外层是 `display:flex; flex-direction:column; maxHeight:min(72vh, 520px); overflow-y:auto`，
  子项默认 `flex-shrink:1`；草稿预览框是 `overflow:auto` 的滚动容器，自动最小尺寸为 0，
  浏览器于是把它压到 0 高来满足 maxHeight，弹窗自身反而不出现滚动条。内容一变长（就绪警告 +
  两个可编辑 textarea）就必然触发。
- **修法**：内容包裹层加 `flexShrink:0` —— 保持自然高度，超出 maxHeight 时由弹窗自己滚动，
  不再压扁子项；草稿预览框同样加 `flexShrink:0`（防御性，任何 flex 上下文都不许压它）。
  两处各带一个测试标记（`data-cr-handoff-body` / `data-cr-handoff-draft`），
  产物 `lib/client.js` 由 `node scripts/build-client.mjs` 重建，`--check` 通过。
- **状态**：已随 0.5.2 发布。

### 文档

- `README.md` / `TUTORIAL.md` 补 0.5.2 用法（强制归档入口、二次确认、置顶提示、默认不强制）。
- `dcr-架构梳理与重构方案-2026-10-26.md`：§S1 的 record 顺序口径、§S2 + 附录 C 的 `atIso` 口径修正。

## 0.5.1（2026-10-26 · 已发布）

> 分支 `fix/0.5.1`（从 `main` = 0.5.0 拉出，只带 0.5.x 需要的改动；0.6 的 timeline/marks/milestone
> 不进来）。**四批功能合并定稿 + 1 条设计修正**：批 1 核心 bug（DCR-01/02/03/04 + D01 + D03）、
> 批 2 交互（pin 失效标注 / 原生压缩保护 / 置顶保护 / 归档开关）、批 3 功能补全（完整交接链 /
> 父→子入口）、批 4 完整链在祖先未加载时只显示 1 层（DCR-05）、**设计定稿：环只表达容量
> （pin 位置标记归 0.6 时间线）**。
> 测试 **257 → 340 PASS**，bundle 重建且 `--check` 通过。
>
> **契约变化（全部 additive，老客户端忽略新字段即可）**：`readState` 增 `chain`（入站投影）/
> `next`（出站投影）/ `nextArchived` / `parentArchived` / `capabilities.unarchive` /
> `sessionPinned` / `pins.stale` / `pins.atRisk`；`handoff` 增 `archive` / `confirmUnpin` 两个
> 入参（默认值保持 0.5.0 行为）；`relay` 旧字段一个字节不改。
>
> **降级说明**：宿主缺 `workspaceRegistry`（归档/置顶/`unarchive` 任一）时对应能力一律降级为
> 「不知道 / 不归档 / 隐藏入口」并只 warn，不阻断交接；老插件（0.5.0）没有 `next` 字段时父→子
> 入口不显示；原生压缩预判依赖宿主 `retainRatio` 默认值，文案统一写「预计」，实际损失由
> `pins.stale` 兜底。

### 批 1：核心 bug 修复（DCR-01 / DCR-02 / DCR-03 / DCR-04 / D01 / D03；测试 257 → 278）

#### DCR-01（P1）祖先会话再次交接后接力条消失

- `dsh/relay.js` 新增 `relayInboundRecordOf` / `relayOutboundRecordOf`（按 `childId` 与 `session.id` 的关系分开找）；`relayRecordOf` 语义**不变**（仍是最近一条记录，`handoffTitlePlanOf` 的链号递增依赖它）。
- `actions/state.js`：`chain` 改为**本会话入站记录**（`childId === session.id`）的只读投影；旧字段 `relay` 一个字节不改；`parentArchived` 用入站 `parentId` 查归档集合（出站记录里的父会话是本会话自己，会查错）；新增 `next`（最近一条出站记录的投影，只加不改，供后续父→子入口与「子会话向父会话补交接单 path」）。
- 客户端 `client/35-relay-bar.js` 的入站判定（`chain.childId === sessionId`）保持不变；`loadParentPath` 改用父会话状态里的 `next`（老插件没有 `next` → 回落 `chain`）。
- 回归：`test/relay-chain.mjs`（中段会话：入站在前、出站在后）、`test/state-passive.mjs`（只有出站记录的会话 + 入站/出站读取器单测）。

#### DCR-02（P1）0.5.0 之前的老链永远没有接力条

- `dsh/relay.js` 新增 `legacyRelayChainOf({session, title})`：没有入站记录时，若 `header.parentSession` 存在、`header.origin !== 'subagent'`、`header.isSeeded !== true`（宿主语义：`isSeeded` = fork 继承前缀，不是交接），且标题能解析出链号（`splitHandoffTitle(...).handedOff > 0`），合成只读 chain（`ordinal` / `baseTitle` / `scheme` / `childId=self` / `parentId=header.parentSession`，多一个 `synthesized:true`）。**不写日志、不改任何记录**；不带 `path`（老链的交接单路径只写在父会话记录里，客户端 `loadParentPath` 只读回查）。
- 回归：`test/relay-chain.mjs`（老链合成 / 「历史 N」标题 / 四种不合成：subagent、fork、无 `parentSession`、干净标题 / 有 record 时 record 优先）。

#### DCR-03（P2）归档状态不刷新 / `parentArchived=null` 死入口

- 客户端 `client/35-relay-bar.js`：
  - 打开接力条菜单时**静默刷新一次 state**（`refreshKey` 触发；只有真的换会话才清链，刷新失败不重排队重试）；
  - `parentArchived === null`（宿主没给状态）时，「回到原会话」也先 `unarchive` 再 `open`（unarchive 幂等）；
  - 恢复失败会**换通道重试一轮**（宿主 `ctx.uiWorkspace.unarchiveSession` ⇄ 插件 HTTP `recover`；只有一条通道时同通道重试），仍失败才提示；
  - 客户端与服务端都没有恢复能力时**隐藏「恢复旧会话」**。
- `actions/state.js` 新增 `capabilities.unarchive`（宿主有没有 `workspaceRegistry.unarchiveSession`）。
- 回归：`test/relay-bar.mjs`（打开菜单刷 state / 未知状态先恢复 / 双通道重试 / 同通道重试 / 无能力隐藏入口 / `next` 补 path）、`test/state-passive.mjs` 与 `test/relay-chain.mjs`（capabilities）。

#### DCR-04（P2）归档提示文案指向不存在的视图

- `dsh/handoff-archive.js`：`「全部会话」` → 宿主真实视图标签 `「全部对话（显示已归档）」` + 真实动作 `「取消归档」`（实测 `dsh-client-ui-workspace` 的 `viewOptions` 三选一与归档行动作）。
- 回归：`test/archive.mjs`（新文案存在、不再出现「全部会话」）。

#### D01（正确性）压缩「已提交」判定两份不一致

- `dsh/compaction-pair.js` 新增唯一判定 `isCommittedCompaction({compactionId, end, replace})`：**没有 `compactionId` 的旧日志也要求 replace**；有 id 时还要求同 id 的 `compaction/end` 存在且没有 `error`。
- `dsh/session-view.js` 的 `countSummaries` 与 `dsh/compaction-log.js` 的 `collectCompactions().committed` 都改为调用它（原来两份实现，在「无 id 且无 replace」的旧日志上给出 `1` / `false` 两个答案）。
- **行为变化**：没有 id、也没有 replace 的 summary 不再算「已压缩」（`readState.summaries` 与 advice 阈值会少算这一条）。`test/smoke.mjs` 两处旧期望随之更新。
- **未随本分支做**：0.6 的 `timeline.summaryCount` 改正向累计 —— 0.5.1 分支没有 `lib/dsh/timeline.js`，随 0.6 分支做。
- 回归：`test/compact-log.mjs`（countSummaries 与 committed 同口径交叉校验）。

#### D03（重复）文本截断 6 处 → 2 个共享函数

- 新增 `lib/core/clip.js`：`clipChars`（按码点，emoji 不切半）与 `clipCodeUnits`（按 UTF-16 码元，0.4/0.5 既有行为逐字节兼容）；省略号预算显式命名（`'inside'` 默认 = 算进上限 / `'append'` = 多 1 字符 / `false` = 不补）。
- 0.5.1 迁移 6 处：`core/pin-anchors.js`（60 字摘要）、`dsh/compaction-log.js`（200 字预览，`'append'` 保留「多 1 字符」既有输出）、`dsh/diagnostics.js`、`dsh/diag-counters.js`、`core/errors.js`（140 字原因）、`actions/handoff.js`（120 字警示）。
- **随 0.6 做**：`core/handoff-facts.js:oneLineNote`、`core/milestone.js:clipText`（0.6 工作树新增的两份逐行相同实现）→ 换 `clipChars`。`core/relay.js:truncateTitleUtf8` 按评审结论**不并进来**（UTF-8 字节预算 = 宿主 `session-title` 契约克隆，0.5.2 S3 再迁 `dsh/title-budget.js`）。
- 回归：新增 `test/clip.mjs`（码点/码元/append/边界 + 三个迁移点逐字节），已加入 `npm test`。

### 批 2：pin 失效标注 + 原生压缩保护 + 归档交互（测试 278 → 311）

#### 1. pin 失效标注（C 方案，DCR 批 2-3）

- `core/pin-health.js`（新增）：`pinHealthOf({pinnedSeqs, surfaceSeqs, log})` 把 pin 快照拆成
  `live`（仍在 surface）与 `stale`（被压缩/历史变化带走），并只读日志归因：
  `compaction/start.turn` 非空 = **native**（原生自动压缩）；`turn:null` = **other**（本插件 /bc、
  宿主 /compact）；找不到覆盖该 seq 的 replace = **unknown**（撤销/分支）。`staleCauseTextOf`
  统一文案口径。
- `actions/state.js`：`pins` 增加 additive 字段
  `stale:{count,seqs,native,other,unknown}`；`pins.count/seqs/marks` 仍是 live 集合（0.5.0
  语义不变，老客户端照用）。失效 pin **不画到环上**（不假装还在），但也不消失。
- 客户端 `client/30-indicator.js`：指示灯悬停卡显示「已失效 N 条（随原生压缩移除）」；菜单的
  锁定项显示「已锁 N 条 · 失效 M」/「解除失效锁定（M 条）」；`data-cr-pins-stale` 取证属性。
- `actions/pin.js` 的 `togglePin` 改为按**快照**判定：全部 pin 已失效时菜单显示「解除失效锁定」，
  点下去必须清空记录，不能因为 live=0 反而新锁一条（P3-03 的旧结论随菜单文案一起更新）。
- 回归：`test/pin-health.mjs`（live/stale/三种原因/混合原因 + state 下发）、`test/relay-bar.mjs`
  （指示灯悬停卡文案）。

#### 2. 原生压缩吃掉 pin 的提前保护（事前，非事后）

- 宿主可用信号：`compaction-basic` 的 `thresholdRatio` / `headroomTokens` / `retainRatio` /
  `retainTokens` 可读；真实触发线（0.4 P2-3）与当前压力每帧都有；选段算法在宿主源码里是
  纯函数（保留尾部 `retainTokens` + 工具配对平衡回退）。
- `dsh/native-compaction.js`：`parseCompactionOverride` / `parseModelPolicies` /
  `resolveNativePolicy` 增加 `retainRatio` / `retainTokens`（只认 config 直属子键；路由级可覆盖）。
- `core/native-pin-risk.js`（新增）：`nativePinnedRiskOf` 按 compaction-basic 的
  `selectCompactableRange` 同口径复刻选段，返回下一次原生压缩会覆盖的 pinned seq。
- `actions/state.js`：只在「原生自动压缩开 + 当前压力 ≥ 真实触发线 + 节点定价与 surface 对齐」
  时下发 `pins.atRisk:{count,seqs}`（否则 null，不制造噪音）。
- 客户端：悬停卡一行「⚠ 原生压缩预计覆盖 N 条锁定消息」+ 菜单交接项提示 + 同一风险签名只弹
  一次 toast，建议「先交接（/handoff）或解锁」。`data-cr-pins-risk` 取证属性。
- **为什么是事前**：触发线、保留预算、当前压力都是可读的，选段是纯函数；无需等压缩事件。
  **限制**：宿主没有「即将压缩」事件，真正执行在 step boundary，且默认 `retainRatio` 随宿主
  版本（0.2.1-rc.3 = 0.16；用户显式配置优先），所以文案写「预计」。真发生后 `pins.stale`
  仍会兜底标出实际损失。
- 回归：`test/pin-health.mjs`（宿主选段同口径：保留尾部/配对平衡回退/system head/未到线不报
  + retainRatio/retainTokens 解析）、`test/relay-bar.mjs`（预警文案与主动提示）。

#### 3. 置顶保护（归档会取消置顶）

- 宿主实证（`@deepseek-ai/dsh-workspace/lib/index.js`）：`WorkspaceRegistry.pinnedSessionIds`
  可读；`archiveSession` 在**同一次 durable write** 里把该 id 从置顶集合移除（置顶与归档互斥）。
- `dsh/handoff-archive.js`：新增 `pinnedSessionIdsOf` / `isSessionPinned`（读不到 → null，不猜
  false）；`handoffArchiveNoteOf` 增加 `skipped` / `pinned` 文案。
- `actions/handoff.js`：`handoff(..., {archive = true, confirmUnpin = false})`。旧会话在侧栏置顶
  且未 `confirmUnpin:true` 时**不归档**（`status:'pinned'`），旧会话与置顶都保留；旧客户端
  （不传 confirmUnpin）自动降级为不归档，不会静默取消置顶。
- 客户端交接预览：`sessionPinned === true` 时弹「旧会话已在侧栏置顶：归档会取消置顶」，提供
  「交接并归档（取消置顶）」与「只交接，保留置顶」两个出口；取消 = 关闭预览、什么都不做。
- `actions/state.js` 新增 `sessionPinned`（true/false/null）。
- 回归：`test/archive.mjs`（置顶未确认不归档 / 确认才归档 / archive:false 优先 / 读不到置顶
  集合 → null / 文案）、`test/relay-bar.mjs`（两个出口的 HTTP body）。

#### 4. 归档开关 + 首次引导

- `handoff` 新增可选 `archive`（默认 `true`，0.5.0 行为不变）；HTTP
  `/api/compact-relay-action {action:'handoff', archive:false}` = 只交接、不归档旧会话（返回
  `archive.status='skipped'` + 文案）；`archive` / `confirmUnpin` 类型错 → 400（动历史前拒绝）。
- 交接预览新增勾选框「交接后自动归档旧会话（默认开）」；取消勾选后不弹置顶确认、确认按钮变
  「确认交接（不归档）」。
- 首次引导（onboarding）文案明确写：「交接后会默认自动归档旧会话（侧栏收起，可取消勾选
  『交接后归档』；旧会话在侧栏置顶时会先问你，因为归档会取消置顶）」。
- 回归：`test/archive.mjs`（archive:false / 默认 true / HTTP 透传与 400）、`test/relay-bar.mjs`
  （勾选状态与请求体）、`test/archive.mjs` 产物守卫（onboarding 文案）。

#### 批 2 的宿主限制 / 待真机验证

- 原生压缩预判是「同口径复刻 + 估算」，依赖宿主 0.2.1-rc.3 的默认 `retainRatio=0.16`；宿主升级
  改默认值时预判会偏（用户显式配置 retainRatio/retainTokens 不受影响）。文案已写「预计」，
  实际损失由 `pins.stale` 兜底。
- 置顶状态读的是 workspace registry 的全局置顶集合；老宿主没有该字段 → `sessionPinned=null`，
  客户端不弹确认、服务端也不拦（`isSessionPinned` 返回 null → 按未置顶处理，保持 0.5.0 自动归档）。
- 客户端新增交互（归档勾选 / 置顶确认 / 失效标注 / 预警 toast）需要重启宿主加载新 bundle 后
  真机点一遍；本轮只做了 bundle 重建 + 组件级单测（mini React，不引 jsdom）。

### 批 3：完整交接链 + 父→子入口（测试 311 → 324）

#### 1. 完整交接链列表（接力条下拉「完整交接链」）

- **数据**：当前会话 `readState.chain`（入站；0.5.0 之前的老链走 DCR-02 的 `synthesized` 兜底）→
  逐级向 `chain.parentId` 读父会话 state 的 `chain`，直到没有 `parentId`。
- **频率**：按需——点「完整交接链」之前**不预加载**祖先；展开后**每层一次** state GET（串行、
  不并发、不轮询）。链路读完后不常驻任何定时器。
- **上限/去重**：`MAX_CHAIN_HOPS = 8`；`seen` 按 sessionId 去重 → 自指/成环立刻停；到上限时
  界面明说「只显示最近 8 层」（不假装到头）。
- **每行**：「历史 N：<原名>」（旧链沿用「交接第 N 次：<原名>」，与接力条同一把尺子）+ 行内
  「交接单」入口 + 整行点击跳转。N/原名取「下一层（子）会话的入站 chain」——正好是那一层会话
  改名后的标题。
- **行内交接单**：优先用该层记录里的 `path`；旧记录没写 path 时用该层会话 state 的出站
  `next.path`（`childId` 与链号都对得上才采用）。只认 `handoff-*.md` basename，走已有
  `/api/compact-relay-handoffs?file=`；没有 path 时禁用并标「暂无交接单」。
- **跳转**：`ctx.uiWorkspace.openSession(sessionId)`。祖先会话默认已被交接流程归档，所以与
  「回到原会话」同口径：先 `unarchive`（宿主 API，老宿主退回 HTTP `recover`，幂等）再 open。
- **失败/读不到**：停在断点，已读到的行保留，显示「无法读取更早的链路」+「重试」；重试
  **从断点续读**（已读到的层不重复拉）。「← 返回」回主菜单 —— 链读失败不阻断其他入口。
- **「没加载」不等于「到头」**：宿主返回的 `sessionId` 对不上（重启后祖先会话通常不在内存里）
  按「读不到」处理——停在断点 + 重试，而不是静默少列一层；用户先打开那个会话再重试就能续上。
- 回归：`test/relay-bar.mjs` 新增 8 组（按需/每层一次 GET、8 跳上限、成环去重、失败重试续读、
  未加载也不误判到头、行内交接单 basename、无 path 禁用、行点击先恢复再切）。

#### 2. 父→子入口（TD-01）

- `actions/state.js` 新增 additive 字段 `nextArchived`（`next.childId` 是否在 workspace 归档
  集合里；与 `parentArchived` 完全对称，各查各的 id，读不到 → null）。
- 父会话侧（有出站记录时）**也渲染接力条**：一行「已交接给新会话」+ 菜单「去新会话」；
  中段会话同时有「回到原会话」与「去新会话」两个方向，外加「完整交接链」。
- 点击 → `openSession(next.childId)`；`nextArchived` 为 true 或未知（null）且宿主有恢复能力时
  先 unarchive 再 open（复用批 1 的双通道恢复逻辑）。
- 两个防御：老插件没有 `next` 字段 → 不显示「去新会话」（**不回落** `chain`：老形态的 chain
  是最近一条记录，可能是入站，回落会出现「跳回自己」的死入口）；`next.childId === 本会话`
  的脏记录一律不认。
- 回归：`test/relay-bar.mjs` 新增 4 组（父会话侧渲染与跳转、脏 next 不显示、归档/未知先恢复、
  中段会话两个方向）+ `test/state-passive.mjs`（`nextArchived`：在/不在归档集合、只看出站 id、
  无 registry、无 next → null）。

### 批 4：完整交接链在祖先未加载时只显示 1 层（DCR-05；测试 324 → 339）

- **真机现象**：点接力条「完整交接链」只显示 1 层（当前会话），并提示「无法读取更早的链路」。
- **根因**：客户端逐级 GET `/api/compact-relay-state?sessionId=<parentId>`；宿主对**未加载**的
  会话返回 `sessionId:null`（`readState` 的 `target` 为 null），客户端把它当「读不到」停在断点。
  重启后祖先会话通常都不在内存里，所以这是常态而不是异常。
- **宿主能力实证**（DSH 0.2.1-rc.3 app.asar）：
  - `@deepseek-ai/dsh-session-persistence` 是根服务 `ctx.sessionPersistence`；
  - `stat(id)` → `{header, revision, sizeBytes?}`，**不读事件日志**；
  - `open(id, 'read')` → 只读 `SessionHandle`，`read()` 返回 `{events, eventState}`，`close()`
    释放；**不创建 live Session、不写任何状态、不占写锁**；
  - JSONL 后端对**已归档**会话同样可读（归档只改 Workspace registry 集合，不动持久化文件）。
- **方案**：优先方案成立 —— 新增服务端只读读取器 `dsh/relay-chain.js`：
  - `readRelayChain(ctx, {sessionId})` 从当前会话开始，按「子会话入站 relay 记录」逐层向上
    （与旧客户端同一套语义），最多 8 层、`seen` 去重防成环；
  - 每层优先用 live 会话（内存里最新），未加载则 `stat` 读 header + `open(id,'read')` 读日志；
  - 交接单 path 优先用该跳入站记录，缺了再从父会话日志找 `childId+ordinal` 对得上的出站记录
    （0.3/0.4 老记录只在父会话写 path）；
  - 0.5.0 前没有 relay 记录的老链同样逐层用 `header.parentSession` + `session/title` 兜底合成；
  - 某一层读不到时返回**已读到的行** + `unreadable:{sessionId, reason}`，不整块清空。
- **端点**：`actions/relay-chain.js`（薄包装）+ `GET /api/compact-relay-chain?sessionId=`；
  与其它 GET 端点同一套宿主 `connection.requestRejection` 鉴权/同源口径。一次返回整条链，
  彻底消除逐级 GET 和未加载问题。
- **客户端**：
  - 点「完整交接链」先打整链端点，一次渲染（`test/relay-bar.mjs` 断言祖先 state GET = 0）；
  - 老插件/响应异常 → **回落**原有逐级 state 读法（兼容 + 兜底），行为与 0.5.1 批 3 一致；
  - 兜底断点从「错误提示」改成可操作入口：宿主明确回 `sessionId:null` 时显示
    **「上一层会话未打开」+「打开并继续」**；点击先双通道 `unarchive`（复用 DCR-03，幂等；
    无归档记录也直接继续）→ `openSession(parentId)` → 等宿主加载（≤8 次）→ **自动 `loadChain` 续读**；
    加载不上则提示「已打开上一层会话，再点完整交接链继续」；
  - 整链端点 `unreadable.reason==='not-found'`（持久化里根本没有这一层）**不显示**「打开并继续」
    （打开也救不回来），只保留重试——与 DCR-03「不造必然失败的入口」同口径。
- **保留**：读不到时已读行不丢、返回主菜单不受影响、8 跳上限、sessionId 去重、行内交接单
  basename 校验、每行跳转前先 unarchive。
- **回归**：新增 `test/relay-chain-endpoint.mjs`（12 条：祖先全未加载仍读全 / live 优先 /
  8 跳上限 / 成环去重 / 断点保留 / 无持久化 / 老链 header+标题兜底 / subagent+fork 不合成 /
  HTTP 200+400+405 / 无服务 ok:false / 鉴权 401）；`test/relay-bar.mjs` 新增 3 条（未加载
  入口、点击后 unarchive+openSession+自动续读、整链端点一次读全 + 部分失败入口），共 46 条。

### 设计定稿：环只表达容量（pin 位置标记归 0.6 时间线）

- **决策（用户拍板）**：环管「未来」（容量、阈值、断点、原生线刻度）；pin 的位置是「历史」。
  在环上画锁定消息位置属于复现历史功能，而 0.6 的时间线会承接 pin 历史（`state.pins.marks`
  与 marks/timeline 已备好）。所以 0.5.1 起**环只表达容量，不再画 pin 位置块**；
  「已锁定 N 条 / 已失效 M 条」作为状态保留在悬停卡与菜单。
- **客户端** `lib/client/30-indicator.js`：删除环上的 pin 位置块渲染（`pinBlocks` 那组带
  `data-cr-pin-mark` 的 `circle`，含品红弧段）；环 SVG 只剩分段弧/断点/原生线刻度/交接线警示/
  中心点。**`state.pins.marks` 数据读取保留**（状态归一化照旧，0.6 时间线消费），注释写明
  「位置标记归 0.6 时间线，环不再画」。
- **保留不动**：悬停卡「已锁定 N 条 / 已失效 M 条」、菜单「已锁 N 条 · 失效 M」、
  `data-cr-pins` / `data-cr-pins-stale` / `data-cr-pin-stale` 取证属性；`colors.base.pin`
  （锁定颜色）留在设置与 colors 契约里，作为 0.6 时间线的 pin 标记颜色。
- **清点**：`data-cr-pin-mark` 此前只被指示灯使用（设置页教学图本来就不画 pin，演示段无引用）；
  删除后源码与 bundle 全库无残留。
- **回归**：`test/relay-bar.mjs` 新增「有 pin 也不画位置块」+ 悬停卡/菜单计数仍在；
  `test/archive.mjs` 产物守卫改为「源码/bundle 不得含 `data-cr-pin-mark`，但必须保留 `marks`
  读取与 0.6 时间线注释」。测试 **339 → 340 PASS**。

### 文档

- **ARCHITECTURE**：`readState` 契约补 `chain`（入站）/ `next`（出站）/ `nextArchived` /
  `capabilities.unarchive` / `pins.stale` / `pins.atRisk` / `sessionPinned` / `parentArchived`；
  §8.8 读侧补「两侧都渲染」口径；§8.10（完整交接链的逐级读法、上限/去重/断点重试、
  父→子入口的两个防御）；新增 §8.11（DCR-05：服务端只读持久化日志一次读整链、端点契约、
  客户端回落与「打开并继续」）；新增 §8.12（设计定稿：环只表达容量、`pins.marks` 数据面保留、
  测试/产物守卫）；§5 补**帧体积口径**（实测 ≈ 2.1KB/帧，0.5.1 additive ≈ +300B，
  完整链默认 **1 次** `/api/compact-relay-chain`，老宿主回落 ≤ 8 次 GET）。
- **README / TUTORIAL**：补 0.5.1 用法（接力条「完整交接链」、父→子「去新会话」、pin 失效
  标注、交接时的置顶确认、交接后归档开关）；指示环图例与锁定说明去掉「品红色块」，
  统一成「环只表达容量，pin 位置标记归 0.6 时间线；已锁定/失效条数看悬停卡与菜单」
  （README.en 同步）。
- 口径与已知限制见下节。

### 已知限制与口径（0.5.1 定稿）

- **DL-02（置顶丢失）**：宿主 `archiveSession` 在**同一次 durable write** 里把该会话从置顶
  集合移除（置顶与归档互斥），这是宿主行为、不是插件副作用。0.5.1 起这件事不再静默：交接
  预览在会话置顶时先问一次（「交接并归档（取消置顶）」/「只交接，保留置顶」），服务端在没拿
  到 `confirmUnpin:true` 时**拒绝自动归档**（`status:'pinned'`，旧会话与置顶都保留）；旧客户端
  （不传 confirmUnpin）在置顶会话上自动降级为不归档。**边界**：用户在侧栏手动归档置顶会话时，
  那一步的确认归宿主管辖，本插件不介入。
- **DL-03（分叉未定义）**：fork（宿主 `isSeeded=true`）与 subagent 会话不在接力链语义里，
  老链兜底（DCR-02）明确排除这两类。真正的「分叉 → 各走一条链 → 再合并」**没有定义**：链记录
  只存单亲 `parentId`，没有分支判据，插件按「各聊各的」处理（两条分叉各自成链，互不感知）。
  0.6 再谈（需要宿主的血缘/分支信号）。
- **DL-04（有 pin 时程序段变化）**：九段交接单里「当前进度」「改过的文件」两段由**程序收集**
  （`core/handoff-facts.js`）；有 pin 时「当前进度」会多出「锁定消息 N 条」+ 最多 10 条锚点
  （seq + 角色 + ≤60 字摘要）。所以同一会话在不同 pin 状态下重新生成交接单，**程序段内容会变**，
  不保证与上一次逐字节相同（模型段本来也不保证）。这是有意的：交接单要反映交接那一刻的事实。
  0.5.1 批 2 起只统计**还活着**的 pin（被压缩带走的失效 pin 不进交接单，改在指示灯界面标注）。
- **「去新会话」只指向最近一次出站**：`readState.next` 是**最近一条**出站记录，所以同一条会话
  交接过两次时，更早的那个下一代会从「去新会话」里消失（会话本身还在，侧栏能找到）；这是
  `next` 的语义决定的，跨会话全时间线留到 0.6 的「路线图」面板。
- **旧链兜底无 path**：0.5.0 之前的老链（子会话没有 relay record）由 `legacyRelayChainOf` 用
  会话头 + 标题合成**只读**链，**不带 path**（老链的交接单路径只写在父会话记录里）。客户端缺
  path 时会向父会话只读回查一次，仍拿不到就显示「暂无交接单」并禁用入口——不伪造、不猜路径。
  完整交接链同理：某一层没有记录路径时，那一行的「交接单」禁用，但跳转照常可用。
- **整链端点依赖 `ctx.sessionPersistence`**：没有该服务的宿主（老版本/裁剪构建）回落旧的逐级
  state 读法；此时祖先未加载会停在断点并显示「上一层会话未打开」+「打开并继续」，不再只给
  错误提示。

### 验证

- `npm test` 全绿：**339 PASS / 0 FAIL**（历史基线：0.5.0 收尾 257 → 批 1 278 → 批 2 311 →
  批 3 324 → 批 4 **339**；批 4 新增 15 条：12 条整链服务端/端点测试 + 3 组接力条组件测试）；
  `node scripts/build-client.mjs --check` 通过（bundle 279147 字节）。
- 四批合计新增回归：DCR-01/02/03/04、D01、D03（批 1）、pin 失效/原生压缩预判/置顶/归档开关
  （批 2）、完整交接链/父→子（批 3）、整链端点/未加载「打开并继续」（批 4），以及
  `test/clip.mjs`、`test/pin-health.mjs`、`test/relay-chain-endpoint.mjs` 三个新文件。
- **未 commit、未发布、未打 tag**（按范围定稿：发布前须 Lead 验收）。
- **待真机验证**：① 旧链会话（b3ae4bac 等 4 个）打开后有接力条；② 祖先会话再次交接后接力条
  不消失；③ 置顶会话交接时的确认弹层；④ 完整交接链：重启后祖先**未加载**时也能一次列全（新
  `/api/compact-relay-chain`），以及老宿主断点「打开并继续」→ 自动续读；⑤ 父会话侧「去新会话」。
  本轮只做组件级单测（mini React）+ 服务端单测，没有真机截图。

## 0.5.0（2026-10-26）

> 0.5.0 功能批次：地基 F1–F6 + **命名反转 + 接力条 + 交接后自动归档旧会话/恢复入口**。双向跳转的「父会话 → 子会话」入口与里程碑面板尚未实现；其余已提交并发布（2026-10-26）。

### F1+F2：历史前缀纯函数 + relay record 白名单（commit `5397863`）

- **F1（`lib/core/relay.js`）**：新增 `HISTORY_PREFIX='历史'`、`historyTitleOf(n, base)`（生成「历史 N：<原名>」，空格/全角冒号/序号写法与 `relayTitleOf` 同一套规则，原名先 trim，空题回落「会话」）；`splitHandoffTitle` 返回值新增 `scheme`——`handoff-n`（交接第 N 次）/ `history-n`（历史 N）/ `legacy`（旧「交接：」「接棒：」堆叠、无前缀、空/脏输入）。`baseTitle` / `handedOff` 的字段名与语义不变，旧标题解析结果逐字节不变。
- **F2（`lib/dsh/relay.js`）**：`normalizeRelayRecord` 白名单放行可选 `scheme` / `titleSeq` / `historyTitle`；旧记录缺失/非法一律读成 `null`（不猜、不补默认值），其余字段与旧记录读取语义不变。父会话写出的 relay record 形状不变（不写这三个字段）。
- **测试**：新增 `test/relay-title-scheme.mjs`（生成/解析/往返/scheme 不混用/空题与脏输入/>80 字节不截断）。

### F3：子会话自带 relay record（commit `b4878b8`）

- **`lib/dsh/sessions.js`**：`createHandoffSession` 在 `followup` 之后、`flush` 之前，向**子会话**写一条 `plugin:compact-relay/relay`：`parentId` / `childId` / `ordinal` / `baseTitle` / `title` / `scheme='handoff-n'` / `titleSeq` / `at` / `atIso`。走 plugin record 通道（`ignorable`，不进模型上下文、不算 token、压缩碰不到）。
- **为什么**：0.5.0 把旧会话改名「历史 N：<原名>」、新会话继承原名后，子会话标题里不再有「交接第 N 次」；链号若仍靠标题解析会算成 0，第 2 次交接会重复「第 1 次」。record 让链号自带。
- **父记录不动**：父会话的 relay record 仍由 `actions/handoff.js` 写 0.3/0.4 的现场形状（canonical + 旧字段 + `path`/`title`/`baseTitle`），0.5.0 起父/子记录都带 `path`（交接单路径）；本次只在子会话多一条记录，标题/文档/交接流程不变。
- **测试**：`test/handoff.mjs` 增子会话 record 字段、`titleSeq`、两跳链式（第 1 次 → 第 2 次不重号）断言。

### F4：`readState` 增只读 `chain` 投影（commit `cc6f86d`）

- **`lib/dsh/relay.js`**：新增 `relayChainOf(record)`，把最近一条 relay record 投影成 `{ordinal, baseTitle, parentId, childId, scheme, path?}`——字段全部取自记录本身，不解析标题、不补默认序号；记录里没有的字段给 `null`，没有 `path` 就不出现这个键；不是对象返回 `null`。
- **`lib/actions/state.js`**：`readState` 新增 `chain`（没有记录为 `null`），旧字段 `relay` 原样保留（0.3 旧名 `parentSessionId`/`index` 仍可读）。纯 additive：老客户端忽略新字段；SSE 帧 +~110B。
- **测试**：`test/state-passive.mjs` 增「新记录全字段 / 0.3 旧记录缺字段 null / 无记录 chain=null / 旧字段不变」四组断言。

### 命名反转（第一个用户可见功能，commit d340dff）

- **行为**：新链交接后，旧会话改名「历史 N：<原名>」，新会话继承干净原名（不带序号）；第 2 次交接为「历史 2：X / 历史 1：X / X」，列表读起来是一条对话。旧链（已存在的「交接第 N 次：」链、0.3 旧 record、旧「交接：/接棒：」堆叠）继续旧命名，旧会话标题一个字符不改（链级 cutover，不迁移、不混用）。
- **`lib/core/relay.js`**：新增 `MAX_TITLE_BYTES=80` 与 `truncateTitleUtf8`（与宿主 `session-title` 同口径的 UTF-8 安全截断）；`historyTitleOf(index, base, maxBytes?)` 支持预算——前缀先计入、超长只缩 base，不传时保持 0.4.3 纯函数行为。
- **`lib/dsh/sessions.js`**：
  - `handoffTitlePlanOf` 返回新增 `scheme`（`history-n`/`handoff-n`）与 `historyTitle`；有 record 时方案以 record 为准（旧记录 scheme=null → 旧链），无 record 时干净标题/「历史 N」→ 新链，「交接第 N 次」/旧前缀 → 旧链，读不到标题 → 保守旧链。
  - `createHandoffSession` 接受可选 `plan`（文档/双写同一份）；子会话 record 的 `scheme` 改为本次链实际方案（新链 `history-n`）。
  - 新增 `renameHistoryOf`：子会话建好后把旧会话改名「历史 N：<原名>」，成功后 `await sessions.flush`；改名失败只 warn 不阻断；当前标题已是目标（含宿主按更小预算截断）时跳过，同一链重复执行不重复加前缀。scheme=`handoff-n` 时不读标题服务、不改名。
- **`lib/actions/handoff.js`**：交接编排在 `createHandoffSession` 之后调用 `renameHistoryOf`；父 record 写出新增 `scheme` + `titleSeq`（旧会话 rename 的 eventSeq），新链再写 `historyTitle`；父记录写完后再次 flush 旧会话，保证标题与 record 一起落盘。
- **有意行为变化**：F2/F3 时期「父记录不写 scheme/titleSeq/historyTitle」的约束随本功能更新——父/子记录现在都写 `scheme` + `titleSeq`；F5 链不变量测试已改为断言新形状。
- **测试**：新增 `test/handoff-naming.mjs`（第 1/2 次新链标题与序号、父/子 titleSeq 各取自己 rename、旧链 cutover 不改旧标题、0.3 旧记录不迁移、80 字节预算、幂等 guard、rename 失败降级含端到端不阻断）；更新 `test/handoff.mjs` 与 `test/relay-chain.mjs` 的父记录/标题期望；`test/harness/host.mjs` 支持 `sessionTitleText` 与函数式 `renameEventSeq`。

### 交接后自动归档旧会话 + 恢复入口（commit 369a235）

- **宿主接缝（0.2.1-rc.3 app.asar 实测）**：
  - 服务端 `@deepseek-ai/dsh-workspace/lib/index.js` 的 `WorkspaceRegistry.archiveSession(sessionId, { stopActivity })`；插件通过 `ctx.get('workspaceRegistry')` 调用（建子会话已在用同一服务）。
  - 不带 `stopActivity` 时先跑 `workspace/session-activity` waterfall，任何 provider（运行中的 turn / subagent / job / schedule）报活都会在写盘前抛 `WorkspaceActiveSessionError`；带 `stopActivity: true` 会先写归档集合、再停旧会话的工作。**自动交接不传 stopActivity**——静默取消用户后台任务比多留一行破坏性大。
  - `unarchiveSession(id)` 幂等且不做存在性探测；归档集合是 registry 全局状态，不改变 workspace 成员/排序，恢复后旧会话回到原位。
  - 客户端 `ctx.uiWorkspace.unarchiveSession(id)` 与侧栏「取消归档」是同一接缝（`dsh-client-ui-workspace` 的 `UiWorkspaceService`）。
- **`lib/dsh/handoff-archive.js`**：自动归档只传 `sessionId`；已归档 → `already` 幂等；旧会话有活 → 等 150ms 重试一次后降级 `active`，保留旧会话可见并只 warn；无 registry / 找不到会话 / 写盘失败分别降级 `unavailable` / `unknown` / `failed`；任何分支都不抛错。`handoffArchiveNoteOf` 统一生成用户文案（失败固定含「归档失败，不影响交接」）。
- **`lib/actions/handoff.js`**：归档顺序在**子会话建好、旧会话改名、父 record flush**之后；成功 message 追加「旧会话已归档（可在新会话输入框上方「已接力自 …」→「恢复旧会话」找回；侧栏「全部会话」也能取消归档）」，失败追加原因且不影响 `ok/childId/path`。
- **恢复入口**：
  - 服务端 `lib/actions/recover.js` + HTTP `action: 'recover'`：直接调 `workspaceRegistry.unarchiveSession`，跳过 `resolveTarget`（归档会话通常没有活 agent），幂等并回报剩余归档集合。
  - `readState` 新增 additive 字段 `parentArchived`（true/false；没有父会话或宿主不给归档状态为 null），`chain` 仍是 relay record 的纯投影。
  - 客户端接力条下拉新增「恢复旧会话」：已归档或宿主未给状态时显示；优先 `ctx.uiWorkspace.unarchiveSession`，老宿主回退 HTTP recover；成功后更新本地归档状态并自动切回旧会话。「回到原会话」在已归档时也先恢复，避免用户撞「归档会话不可打开」。
- **兼容/边界**：旧链（`handoff-n`）与 0.3/0.4 旧 record 同样归档，命名逻辑一个字符不改；宿主接缝缺失/失败一律降级为「不归档」并 warn；不改交接单正文、压缩行为、命名反转逻辑。
- **测试**：新增 `test/archive.mjs` 16 组（归档参数/幂等/活跃重试/失败降级/旧链/恢复动作/HTTP 路由/产物静态断言）；`test/relay-bar.mjs` 新增 5 组恢复交互；`test/state-passive.mjs` 增 `parentArchived` 断言。`npm test` **257 PASS / 0 FAIL**。
- **未真机验证**：本环境未启动真实 DSH 会话点验「交接 → 自动归档 → 接力条恢复」全链路；宿主证据来自 app.asar 源码与同形 fake ctx。真机需确认：①交接完成后侧栏旧会话消失、新会话自动打开；②「恢复旧会话」后旧会话回原位且可打开；③旧会话有后台任务时保留可见并提示任务族。

### 验证

- `npm test` 全绿：**257 PASS / 0 FAIL**（历史基线：F1+F2 后 204 → F3 后 206 → F4 后 207 → F5 后 213 → 命名反转后 220 → 接力条后 236；本次自动归档 + 恢复入口新增 21）。
- 未 commit、未发布、未打 tag；0.5.0 剩余：双向跳转的父会话→子会话入口、里程碑面板。

## 0.4.2（2026-10-26 · 交接线保命补丁）

### 修复：交接提醒可能晚于 DSH 原生压缩（0.4.1 的三个洞）

- **现象**：① 服务端保存校验只看配置阈值（80%），手改设置文件能把交接线设到 70%，而 UI 按实际触发线只允许 66%；② 交接线 60% 是死值——换到实际触发线更低的模型（如 55%）时，指示灯/菜单照旧按 60% 提醒，DSH 会先自己压历史；③ 已保存的交接线高于当前模型实际线时，除设置页一行 warning 外没有可见提示。
- **修复（P0-1 运行时判定）**：新增共享纯函数 `lib/core/handoff-guard.js`（`HANDOFF_MARGIN_PP=5`、`handoffCapOf()`、`handoffGuard()`）：**交接线硬上限 = 实际触发线 −5pp，向下取整到整数百分位**（deepseek-flash 1M：67.8% → 62%）。违规时**只告警、不静默改**：指示灯悬停卡 + 环上交接刻度旁小警示、`/handoff` 菜单项、设置页三处；设置页提供「按实际线重算」一键（二次确认，目标 = 实际线 −5pp），目标 ≤ 压缩线时拒绝并提示先降压缩线。
- **修复（P0-2 服务端同口径）**：`save(patch, { nativeRatio })` 接受客户端传入的当前模型实际触发线，按实际线 −5pp 校验；未带（旧客户端 / 无会话）退回配置阈值 −1pp 防呆，行为同 0.4.1。超限一律 400 + `field=thresholds.handoffRatio` + 「最高可设 X%」，不夹紧、不落盘。实际触发线算不出（`native.unavailable`）时不告警、不阻断，保存退回配置阈值；DSH 原生自动压缩关闭时不校验。
- **修复（P1 换模型跟随）**：客户端状态刷新即重新判定；观察到路由模型变化且首次发现违规时弹一次 toast（localStorage 记上次路由，同路由不重复打扰）。指示灯环上只加警示节点，不改分段/断点逻辑。
- **兼容性**：`nativeRatio` 为可选参数，旧客户端不带 → 0.4.1 行为；旧设置文件原样加载，不静默改写。兜底上限从「< 配置阈值」明确为「≤ 配置阈值 −1pp」（与 0.4.1 提示文案「最高 79%」一致；0.4.1 代码实际接受 79.5%，0.4.2 起按文案执行，仅影响亚百分点手改值）。
- **文档（P2）**：README / README.en / TUTORIAL 写清三条线 **40% 压缩线 / 60% 交接线 / 67.8% 原生实际触发线**，删掉「原生线 −1%」旧口径；CHANGELOG / ROADMAP 同步。
- **测试**：新增 `test/handoff-guard.mjs`（纯函数 12 组边界 + 服务端保存校验 8 组：带/不带 nativeRatio、0.62/0.63 边界、非法参数、旧设置文件、压缩线冲突、原生关闭；客户端产物接线断言）；`test/plugin-load.mjs` 增加 HTTP 集成（临时 profile：`nativeRatio=0.678` 保存 65% → 400 含「最高可设 62%」、62% → 200、不带 → 200 兼容、85% → 400 仍按 62% 而非 79%）。`npm test` 全绿。
- **验证边界**：设置页/悬停卡/菜单/换模型 toast 的真机点验需在真实 DSH 会话里确认（本仓库测试环境无 Chrome 自动化）；服务端与纯函数、构建一致性已自动化覆盖。

### 修复：设置页保存条 + 交接线输入被静默改写（真机反馈）

- **保存条（上一提交）**：设置页很长，保存按钮原在最底部；改成粘性底部工具条（`position:sticky; bottom:0`），含保存 / 恢复默认 / 未保存指示 / 保存结果，保存失败文案同时出现在条内与交接线行内。
- **现象（真机）**：「输入 80 他直接改成 99 然后报错」。交接线输入框里打 80，输入框自己变成 99（=0.99），点保存再报错。
- **根因（客户端三处叠加，`main@2b4d10b` 的 `lib/client/50-settings.js`）**：① `:549` 每次按键都 `Math.min(0.99, Math.max(0.05, value))`——夹紧上限写死 99%，和真实上限 62% 无关；② `:542`/`:408` 输入框 value 是派生值 `Math.round(ratio*100)`、**没有本地草稿**，所以中间态（60 后面打 8 → 608）当场被夹成 0.99 并渲染成「99」，用户输入消失；③ `:540` `max` 是 62 只作浏览器提示，`type=number` 打字不受约束，代码却按 99 夹。同族问题：最小线/压缩线也是「按键即夹紧」，清空输入框会被 `Number('')=0` 夹成 5%，无法清空重打。
- **修复**：百分比输入加本地草稿（按键只记草稿 + 原样写入 `value/100`，空串/非数字不改表单；失焦/加载/保存成功后回落表单派生值）；`max` 用当前 cap（62%，算不出时 100）并新增「最高 62%」行内徽标；三个百分比输入聚焦/点击即全选（避免在旧值后面追加）；超限仍由服务端 400 +「最高可设 X%」拒绝，**不夹紧、不落盘**。
- **视觉打磨**：交接线行重排（控制行 / 体量估算 / 上限说明 / amber 告警 / 红色失败 / 右对齐「按实际线重算」动作行）；告警与失败块改淡色底（7–8%）+ 同色描边；保存条按钮与状态文字对齐、状态独立一行胶囊（红/绿）、高度 47px，深浅主题都用现有 token（探针：条底 rgb(35,35,36)/rgb(255,255,255)，错误文字均为红色主导）。
- **测试**：`test/settings-ux.mjs` 新增「输入 80 输入框仍是 80（不是 99）→ 保存 400 → 条内+行内双处报错 → 改 62 保存成功」；`npm test` **197 PASS / 0 FAIL**；`test/e2e/settings-ux.mjs`（隔离 home + 无头 Chrome）真键盘输入 80/62 全流程 PASS，截图见 `default-workspace/2026-10-25-收尾/`。

## 0.4.1（2026-10-25）

### 修复：原生压缩线显示口径不一致（设置页仍写 80%，指示灯写实际触发 67.8%）

- **现象**：0.4.0 把指示灯/悬停卡改为「实际触发线」（DSH 按 `min(窗口×thresholdRatio, 窗口−输出预留−headroomTokens)` 触发），但设置页的「作用 / 调整后 / 原生阈值」三处和「指示灯怎么看」教学卡仍按 `thresholdRatio` 显示 80% —— 同一插件两处数字互相矛盾，而且设置页那句「80%：DSH 会自己压历史」本身是错的（实际 67.8% 就压）。
- **修复**：客户端抽出纯函数 `nativeLineInfo()`（实际线优先；给出配置阈值、实际触发点与差异原因）；设置页三处 + 教学卡刻度/文案 + 指示灯悬停卡统一为「实际触发 X%（配置阈值 Y%）」，并说明「模型输出预留 + DSH 自身余量」使实际触发更早；交接提醒线上限也改用实际触发线（原按配置 80% 算，允许把交接线设在实际触发点之后、永远走不到）。
- **不改**：宿主计算、触发条件、压缩/交接行为；纯显示文案与校验上限。
- **验证**：Mac 真机（0.4.1 客户端）：设置页与悬停卡同显 **67.8%**（678.5K / 1.00M，deepseek-flash），配置阈值 80% 作为注释保留；交接线上限随实际线收紧。

### 显示层补强（dev-god 独立审查后，同属 0.4.1）

- **关闭态空数字**：`autoEnabled=false` 时原生线信息原本连「实际会触发多少」一起丢，设置页会出现「原生阈值 %」、确认弹层出现「容量到 %」。现在关闭态显示「配置 80%（已关闭；开启后实际触发 67.8%）」，恢复确认也用实际值。
- **差异归因**：`why` 只在「预算分支确实更小」时才归因为输出预留/余量；`modelPolicies` 路由覆盖改说「该模型单独配了阈值」；实际触发晚于配置阈值时不再套用「理论上限」说法（原实现会自相矛盾）。
- **交接线遗留值**：设置页对「已保存交接线 > 实际触发线」给出显式提示（不静默改写）；交接线输入上限与保存口径统一（按实际触发线向下取整）。服务端保存校验仍以配置阈值做上限（防呆不阻断），本版仅在 UI 收紧并提示如何调整。
- **文档口径**：README badge / README.en 同步到 0.4.1 与实际触发线说明；ROADMAP 标注已失效参考仓库。
- 测试：`test/native-line.mjs` 新增 `nativeLineInfo` 行为回归（正常/关闭/算不出/路由覆盖/实际晚于配置五组输入，从客户端源码切出函数真跑）。

## 0.4.0（2026-10-24）

### 修复：压缩/交接后「压缩判断记录」从未失效（BUG-013，0.3.1 起存在）

- **问题（真机发现，2026-10-24）**：压缩/交接后旧的 `compressHint` 本该自动失效（环上断点消失、不再抑制 cue），实际一直判定「有效」。P0-1 上线后真机诊断包里 `counters.cueInjected=0` 的直接原因就是它——旧 hint 的 ratio（26.4%）高于当前 ratio（18.5%），`ratio - hint.ratio < 10%` 的 hint 抑制规则把 cue 全部挡掉；指示灯环上也残留旧断点（26%）。
- **根因**：`lib/actions/state.js` 调 `lastCheckpointSurfaceSeq(session)` 时**漏传第二个参数** `isCheckpointSource`；`lib/dsh/session-view.js` 里对 `undefined` 调用判定函数抛 TypeError，又被事件循环里的 try/catch 吞成「不是 checkpoint」→ 永远返回 -1 → `checkpointSeq = undefined` → `compressHintIsActive(hint, undefined)` 恒为 true。（对照：`lib/dsh/select-range.js` 传参正确，所以选段/不二压一直正常。）
- **修复**：① `state.js` 显式传 `deps.engine?.isCompactCheckpointSource`；② `session-view.js` 的 `lastCheckpointSurfaceIdx` / `lastCheckpointSurfaceSeq` 给 `isCheckpointSource` 加默认值 `engine.isCompactCheckpointSource`（dsh→dsh 同层、显式传参优先；纯 node 单测不注册 DSH 包解析钩子时安全降级为「无 checkpoint」，不抛）；③ 回归测试加进 `test/state-passive.mjs`（旧 hint + 更新的 checkpoint → `compressHint: null`；hint 比 checkpoint 新 → 保留）。
- **影响面**：只影响「判断记录新鲜度」的显示与 cue 抑制；不改压缩/交接行为、不改拒绝条件、不动 client。此 bug 自 0.3.1 起存在，随 0.4.0 修复（不回溯 0.3.6）。

### P2-3 原生自动压缩「真实触发线」（按路由容量算，不再只显示窗口比例）

- **问题**：指示灯一直把 `compaction-basic` 的 `thresholdRatio`（默认 80%）当触发线显示，但 DSH 实际按 token 数触发：`thresholdTokens = floor(min(W × rate, W − 输出预留 − headroom))`，触发点 = `thresholdTokens / W`。当路由请求给输出预留较多或 `headroomTokens` 被改过时，真实触发点会明显低于 80%（作者在 Windows 真实会话里问过「原生压缩线为什么降到了 50」）。
- **修复**：新增 `lib/core/native-line.js`（纯函数，公式与 dsh-compaction-basic 源码一致）；`lib/dsh/native-compaction.js` 增读 `config.headroomTokens`（默认 65536）与嵌套 `modelPolicies`（按 provider+model 精确覆盖 `thresholdRatio`/`headroomTokens`，支持列表与映射两种 YAML 写法；**BUG-012 保持**：嵌套值不会变成全局线）；`lib/dsh/pressure.js` 新增 `routeBudgetOf()`：输出预留 = `session.requestHeader().config.maxTokens ?? 适配器 defaultMaxTokens ?? 0`，窗口复用 `llm.resolveModelInfo` 缓存；`readState` 的 `native` 新增 `ratio/thresholdTokens/contextWindow/reservedCompletionTokens/headroomTokens/overridden/route/unavailable`（`thresholdRatio` 仍下发生效比例，老客户端可回落；算不出时 `ratio=null + unavailable=原因`）。
- 客户端：环上原生刻度/越线闪烁改用真实线；悬停标题显示 `原生自动压缩线 X%（thresholdTokens / 窗口，provider/model，按路由覆盖）`；首次引导文案同步。
- 测试：`test/native-line.mjs`（公式 80% vs 67.8%、边界/无预算、解析与 BUG-012 回归、路由覆盖匹配、readState 下发与老字段兼容）；并入 `npm test`。
- 不改任何触发/拒绝条件，只改「显示与数据」；版本仍 0.3.6，未发布。

### P2-1 交接预览「两段可编辑」（只允许 约束 / 下一步）

- 预览接口新增 `editable: { titles: ['约束','下一步'], maxChars: 4000, note, sections }` 与 `ordinal`（第 N 次交接）；客户端交接预览卡只给这两段 textarea（`data-cr-handoff-edit`），其余段只读并显示「程序生成段不可改」。
- 确认时客户端只提交「用户真的改过且非空」的段；宿主在压缩/写盘前校验：非法字段（程序生成段 / 拼错段名 / 非对象）→ `code='edits'`（HTTP 400，消息点名不能改的段）；单段 >4000 字符拒绝（不静默截断）；空值/未改回落重新生成的原文。应用方式：生成九段后覆盖这两段再渲染（`composeHandoffText` 仍按九段固定顺序），程序段永远来自程序/模型。
- 九段结构不变；必须用户点「确认交接」才写盘（预览/校验过程不写盘）。action 路由 body 上限从 8KB 放宽到 48KB（容纳两段编辑）。
- 测试：`test/handoff-p2.mjs`（白名单/空值/超长/非法字段/九段顺序/客户端入口静态守卫）+ `test/handoff.mjs` 集成（编辑后交接单落盘内容生效、程序段被拒且零副作用、空编辑回落）。

### P2-2 接力链元数据补全

- relay 记录 canonical 字段补齐：`parentId` / `childId` / `ordinal` / `at`（ms）/ `atIso`（本地 ISO）；0.3 旧字段 `parentSessionId` / `index` 继续写入，读侧兼容旧记录并补齐 canonical 字段。
- 链式序号：首次交接 `ordinal=1`；从子会话继续交接 `ordinal=2` 且 `parentId` 指向真正父会话；下一次交接标题序号改用 `ordinal` 推导。
- 交接单头新增 `- 交接序号：第 N 次交接`（预览草稿里也能看到）；接力链视图留 0.5，不做。
- 测试：`test/handoff-p2.mjs`（canonical/旧记录兼容）+ `test/handoff.mjs`（首次 ordinal=1 + 文档头、链式第 2 次 ordinal=2 / parent 正确）。

### P1-3 压缩/交接可审计流水（轻账本）+ 设置页累计数字

- 新增轻账本 `~/.dsh/compact-relay-ledger.jsonl`（JSONL，一行一条，schema `dcr-ledger/v1`）：每次**压缩/交接成功**后追加一条——`kind`、本地时间、耗时 ms、压前/压后 tokens + ratio、腾出 tokens、pin 命中（`inRange/total`）、交接单落盘路径（仅路径）与 `childId`；交接内部那次压缩不重复记账（一次 `/handoff` 一条）。
- 隐私：allowlist 构造，只记数值/枚举/时间/路径，**不含消息原文、摘要、交接单正文、sessionId、cwd/用户名**；测试用敏感 fixture 断言产物中不存在。
- 有界与降级：只保留最近 200 条（超限整文件重写为最近 200 条，tmp+rename 原子替换）；文件损坏按行跳过；任何读写失败静默返回 `{ok:false}`，**绝不影响压缩/交接本体**（测试覆盖：账本 record 抛错时交接仍成功；账本路径不可写时动作照常、文件损坏仍可读可写）。
- 设置页：`GET /api/compact-relay-settings`（含保存/恢复默认响应）新增 `ledger` 累计字段（`count/compactCount/handoffCount/freedTokens/avgDurationMs/lastAt`），设置页「关于与危险操作」显示一行 `累计：已压缩 X 次 · 交接 Y 次 · 腾出约 Z tokens · 平均耗时 W`；无记录时显示引导文案。数字与账本文件同源（测试断言相等），不做大盘。
- 新增 `test/ledger.mjs`（字段完整 / allowlist + 敏感 fixture / JSONL 容错 / 上限裁剪 / 不可写降级 / 设置数字一致 / 客户端累计行静态守卫）+ `test/handoff.mjs` 压缩与交接成功后的账本落盘断言 + `test/plugin-load.mjs` 设置端点累计断言；并入 `npm test`。
- 不改压缩引擎/拒绝条件/阈值；版本仍 0.3.6，未发布。

### P1-1 压缩预览「建议锁定」提示（只提示、不自动锁）

- 预览接口新增 `preview.pinSuggest = { count, items: [{seq, role, reason, snippet}] }`：宿主侧纯本地启发式（`lib/core/pin-suggest.js`）对「本次将被压掉的历史」识别三类信号——`明确要求别改`（用户消息里「不要改 / 别动 / 保持原样 / 必须保留」等）、`报错堆栈`（异常类名 / 堆栈帧 / 堆栈 / 报错等）、`关键决策`（决定 / 拍板 / 采用 / 改用 / 结论等）；最多 5 条、每条一句摘要 ≤60 字符、不贴全文；短句、系统消息、运行时合成的 user/message（checkpoint 等）、普通工具输出不进入候选。
- 客户端预览卡只渲染「建议锁定 N 条（先 /pin 再压）」+ 每条理由/摘要；**绝不自动锁定**（预览不写任何会话事件，测试断言 `session.log` 不变）。`/bc` 预览 message 里也带一句建议。
- 收敛实现：消息角色/摘要抽取挪到 `lib/core/pin-anchors.js`，`/pin list`、建议锁定、交接单锚点共用一份（删除 `actions/pin.js` 内私有 `previewOf`）。

### P1-2 pin 作为「保留契约」（声明与展示，不承诺第三方引擎）

- 交接单九段结构不变：锚点写进程序段「当前进度」——`- 锁定锚点（保留契约，接手者请原样保留这些消息）` + 每条 `seq N · 角色 · 「一句摘要（≤60 字符）」`（最多列 10 条，其余提示 `/pin list` 看全）+ 一行「跨引擎压缩器是否遵守取决于其实现」。
- 压缩预览新增 `preview.pinHits = { inRange, total }`：`inRange` = 本次候选范围里被锁定保护而跳过的条数，`total` = 会话仍活着的锁定总数；客户端预览卡显示「pin 命中 N 条」并区分范围外锁定。
- 不回归：锁定消息仍在压缩范围之前截断（`clipRangeByPins` 既有逻辑），压缩后原样保留在 surface。
- 测试：新增 `test/pin-contract.mjs`（候选识别含反例、建议条数/上限、交接单锚点、pin 命中数、预览只读不自动锁）+ `test/handoff.mjs` A1b 预览断言补锚点；并入 `npm test`。
- 边界：只做「声明与展示」，不承诺其他压缩器遵守 pin；不改压缩引擎/拒绝条件/阈值；版本仍 0.3.6，未发布。

### P0-1 判断机制加强（未发布，代码已落地，待 3 次真实任务验收）

- **背景（BUG-010 后续）**：Windows 173 个真实会话里 cue 注入 18 次、`mark_compress_point` 调用 **0 次**；Mac 仅在「脚本写完 + 真机验证通过」这种明确节点自发调用过。归因：旧 cue 的「不确定就不用调」让模型倾向保守跳过、工具描述强调拒绝风险、每轮注入变成背景噪声。
- **cue 文案 v2**（`lib/core/compress-cue.js`）：把抽象「自然节点」换成 4 个可自检的完成信号——功能已实现并验证 / 文档已交付 / 问题已定位并修复 / 准备交接；明确「不确定也建议调一次让工具判断：被拒绝不会改动历史、不影响会话」；保留「不处于阶段收尾就不用管」边界，删除「不确定就不用调」。
- **注入门控**（`lib/adapters/prompt.js` + `lib/core/policy.js` 常量 `CUE_MIN_RATIO=0.10` / `CUE_MAX_RATIO=0.40` / `CUE_MIN_TURNS=3`）：只有全满足才注入——① 容量落在 `[max(10%, 动态最小线), min(40%, 压缩线))`（到压缩线不注入，避免诱导注定被拒的调用）；② 距上次注入 ≥3 轮（按 text 回调调用次数计，进程内 Map、不新增持久状态、不落盘）；③ 一轮内最多一次。异常/无 agent/无缓存行为不变（返回空串）。
- **工具描述 v2**（`lib/adapters/tool.js`）：明确「用户和模型都可以调用」；「被拒不需要致歉、不会改动历史、也不影响会话，不需要重试」；补充典型调用时机（阶段完成 / 准备交接前 / 长任务中途确认可回退点）；把「不需要每个小步骤都调用」弱化为句尾的「小步骤不用调用」。
- **计量接入**（`lib/dsh/diag-counters.js`、`lib/actions/compress-hint.js`、`lib/adapters/prompt.js`）：新增 `cueInjected` / `markCalls` / `markAccepted` / `markRejected` 四个计数（被拒也算调用）。只记次数与结果、不记 cue 原文/任务内容（隐私口径与 P0-2 一致）；P0-2 诊断包的 `counters` 与 Markdown 直接带出这四个数 → 真实使用后看数字即可判断「标准 B：3 次真实任务 ≥2 次模型自发调用」，不用翻会话日志。
- **测试**：`test/compress-cue.mjs` 重写覆盖 U1（文案 v2：4 信号 + 被拒无副作用 + 不含旧措辞）、U2（区间 0.08 不注入 / 0.12 注入 / 0.40、0.45 不注入 + 第 4 轮再注入）、U3（无 agent 不注入 / 同轮不重复 / 异常降级）、U6（5% 桶 / 动态最小线 / hint 抑制 / state-hub 原有断言随 v2 同步）；`test/smoke.mjs` 增 U4（markCompressHint 成功/被拒计数 + 不变式）；`test/plugin-load.mjs` 增 U5（工具描述关键词）+ cue 门控下的 20% 注入断言；`test/diagnostics.mjs` 同步 counters 白名单/渲染。
- **范围红线（未违反）**：不改压缩/交接行为、不改拒绝条件（最小线 5% / 压缩线 40% 不动）、不自动动作、不动指示灯客户端、零新依赖零网络、版本号仍 **0.3.6**。
- **未完成（发布前）**：需 3 次真实长任务验证标准 B；soak 记录模板已补「判断机制读数方法」。

### P0-2 诊断包最小版（已完成）

- **新增「诊断信息」入口**（设置 → 压缩接力 → 帮助）：【生成并预览】在本机生成一份 Markdown + JSON 诊断信息，弹层里先预览，再【复制 Markdown】/【复制 JSON】；【打开问题报告页】打开预填版本/平台短字段的 GitHub issue 页。**不做任何自动上传、遥测或后台外发，也不加网络能力。**
- **新增只读端点** `GET /api/compact-relay-diagnostics?sessionId=`：沿用宿主 `connection.requestRejection` 鉴权（401/403）；只支持 GET（非 GET 405）；无活动会话时 `state: null`；返回 `{ok, schema, version, generatedAt, markdown, json, issueUrl}`，响应不含正文/堆栈（失败只回短文案）。
- **新增 `lib/dsh/diag-counters.js`**：进程内计数/耗时/错误码（重启清零）。压缩/交接成功失败计数、最近 20 个耗时样本的 p50/p95、按 `(code, phase)` 聚合的最近 20 条错误码（只收 code/phase/at/count，**不收 message**），锁定动作计数。
- **新增 `lib/dsh/diagnostics.js`**：`dcr-diagnostics/v1` 产物构造。allowlist 逐字段取值（禁止整对象透传），产物只含数值/枚举/布尔/错误码；JSON ≤ 64KB、errors ≤ 20 条且单条 ≤ 200 字符；额外正则脱敏（GitHub token / `sk-` / Bearer / cookie / 邮箱 / 绝对路径 / 内网 IP / session id 等命中替换为 `[REDACTED]`，只记数量不保留原文）；issue URL 只预填短字段、长度 < 7500。
- **埋点（不改行为与文案）**：`actions/compact-run.js` 与 `actions/handoff.js` 记成功/失败/耗时/错误码；`actions/pin.js` 只在成功锁定时计数（解锁不计）。
- **新增 `lib/actions/diagnostics.js`**：诊断组装的动作层入口（仓库 A9 架构守卫要求 adapters 不直接 import `dsh/`，故组装落在 actions，HTTP 适配层只做协议转换）。
- **文档/模板**：README（中英）新增「诊断信息与隐私 / Diagnostics and privacy」节；`.github/ISSUE_TEMPLATE/bug_report.yml` 文案对齐「生成 → 预览 → 复制」；设置页按钮只用「生成 / 预览 / 复制」，不出现「发送 / 上传 / 上报」。
- **测试**：新增 `test/diagnostics.mjs`（T1–T9：形状白名单、敏感 fixture 脱敏、禁止字段、零网络（fetch 抛错 + 源码扫描）、URL < 7500、64KB/20 条/200 字符上限、p50/p95、计数器、文案），并入 `npm test`；`test/plugin-load.mjs` 增加只读端点用例（鉴权 / 405 / 白名单产物 / 无会话 `state=null`）；`test/e2e/settings-ui.mjs` 增加诊断信息真机检查（帮助区入口按钮、点【生成并预览】后的弹层内容含 `dcr-diagnostics/v1` 与「脱敏」、不含 sessionId/绝对路径、点【复制 Markdown】必须有成功或失败反馈）。
- 版本号仍保持 **0.3.6**（0.4.0 未发布、不 bump）；`package.json` 无新增依赖，`capabilities` 未新增 network。

## 0.3.6（2026-10-24，原生压缩线解析作用域修复）

- **问题（BUG-012，外部用户报告，Windows / DSH 0.2.1-rc.2，真实会话 `session-1f90f5ee`，2026-10-23）**：指示灯「原生自动压缩线」（紫色刻度）从默认 80% 误显示成 **50%**。用户配置的 `compaction-basic` 块里只有 `config.modelPolicies`（`mac-unc` / `qwen35-unc-64k`）写了 `thresholdRatio: 0.5`，并没有改全局线。
- **根因**：`lib/dsh/native-compaction.js` 的 `parseCompactionOverride` 只按「下一个顶层 `-` 条目」截断，不区分 YAML 缩进层级 —— `config.modelPolicies[*].thresholdRatio` 被当成整个插件的全局线。
- **修复**：按**缩进**定位 `compaction-basic` 条目 → 它的 `config:` 直接子键，只认这一层的 `auto` / `thresholdRatio`；更深嵌套层（`modelPolicies[*]`、多层 map/list）一律忽略。`applyAutoOverride` 写入口径同步（只写 config 直接子键，不写进 `modelPolicies`）。
- **边界**：没有 `config:` / config 为空 → `found=true` 但无覆盖，读侧回落默认值（80%）；多个 `compaction-basic` 条目取第一个；CRLF 文件解析与 apply 后都保持 CRLF；`#` 注释与引号值兼容现有写法。
- **范围**：本次只修解析作用域；「按当前模型 route 算真实触发线（deepseek-flash 67.8% / mac-unc 75%，而非窗口比例 80%）」留 0.4。
- **测试**：新增 `test/native-compaction.mjs`（① config 直属阈值生效 ② 嵌套 modelPolicies 被忽略并回落 0.8 ③ 嵌套+直属取直属 ④ 多层嵌套 ⑤ 无 config / 无条目 ⑥ CRLF ⑦ apply 后回读且不破坏 modelPolicies ⑧ 引号/注释），并入 `npm test`；修复前该测试在嵌套用例上失败（把 0.6 误读成全局线）。
- 测试基线：smoke 53/53、handoff 35/35、plugin-load 14/14、contract 17/17、compact-log PASS、compress-cue PASS、state-passive PASS、native-compaction PASS、markdown-lite PASS；client bundle `--check` 通过（148857 字符，本补丁不改 client）。

## 0.3.5（2026-10-24，压缩按钮误禁修复）

- **问题（外部用户报告，0.3.3 / Windows；0.3.4 源码同样存在）**：会话用量 53.5%、插件建议压缩，但指示灯菜单「压缩旧会话」灰置，提示「暂无可压缩内容（会话太短，或近期会话需保留原文）」——把「没有活的 agent」误当成「没有可压缩内容」。
- **根因**：`readState` 的 target 允许退化成「有内容、但还没有活 agent」的 passivized live session（压力/比例能测出来），但 `compactRange` 只在有活 agent 时计算 → 客户端收到 `null` 后禁用按钮并显示通用「暂无可压内容」文案。
- **修复（additive，HTTP 契约不破坏）**：`lib/actions/state.js` 对 target（含 passivized live session）也计算 `compactRange`（纯显示信息；真正执行/preview 仍要求活 agent）；新增字段 `compactRangeReason`，仅当范围存在且无活 agent 时为 `'no_agent'`。
- **客户端**：菜单「压缩旧会话」在 `reason === 'no_agent'` 时仍禁用（预览需要活 agent），但文案改为「**会话未激活：发一条消息唤醒 agent 后可压 N 条 · 约 X tokens**」（含实际数字；禁用态悬停 `title` 可读）；`rangeInfo === null` 与正常可压的既有文案不变。
- **测试**：新增 `test/state-passive.mjs`（无活 agent 的 live session 仍算出范围 + `reason='no_agent'`；有活 agent `reason=null`；空会话/无会话不误报；既有 state 字段不丢），并入 `npm test`。
- 测试基线：smoke 53/53、handoff 35/35、plugin-load 14/14、contract 17/17、compact-log PASS、compress-cue PASS、state-passive PASS、markdown-lite PASS；client bundle `--check` 通过（148857 字符）。

## 0.3.4（2026-10-24，判断机制修复 + 小 bug）

### 判断机制（BUG-010：适合压缩的节点几乎不触发）

- **问题与证据**：扫了 427 个真实会话（36,813 次工具调用）——0.3.1 上线后 `mark_stage` 工具调用 **0 次**，`plugin:compact-relay/compress-hint` 记录全库仅 **1 条**（0.3.0 开发期测试）；而工具 schema 在当前会话日志出现 43 次，说明工具确实进了模型上下文，只是模型从不调用。
- **根因**：工具描述写「系统会告诉你当前容量」，但系统从未告诉模型任何容量 → 「超过最小线 / 还没到压缩线」两条条件无法判断；描述末尾「不要凑数触发」进一步抑制调用。
- **修复**：新增 `systemPrompt` 动态 context（`core/compress-cue.js` + `adapters/prompt.js`）——容量进入可压缩区间时主动告诉模型当前容量与区间（5% 桶取整并在显示时 clamp 到区间下限，避免「约 30%（区间 33.6%–40%）」自相矛盾；刚记过 hint 且差 <10 个百分点时抑制；异常静默跳过——`systemPrompt` 是 DSH 0.2.x 核心根服务，缺服务时插件不激活）；`dsh/state-hub.js` 无论有无 SSE 订阅者都维护最新状态缓存（`latestState`）供同步读取。
- **工具**：`mark_stage` 改名 `mark_compress_point`，重写描述（完成明确任务/阶段且认为可安全压旧历史时调用；工具自己返回容量并判断；太低/到线拒绝且不改历史；不确定可调用）；记录/拒绝文案同步，不再有「系统会告诉你」的假承诺。
- **清理**：删除 0.3.1 遗留死代码 `lib/core/stage.js` + `lib/actions/stage.js`（无任何引用）。
- **测试**：新增 `test/compress-cue.mjs`（区间边界/5% 桶/动态最小线/hint 抑制 + 状态缓存无订阅者更新/防抖/卸载清理/异常安全 + prompt 适配降级）；`test/plugin-load.mjs` 的 fake host 增加 `systemPrompt` 替身并断言 context 注册、区间内文案、区间外空串、异常安全。

### 小 bug

- **BUG-005 交接单详情纯文本**：新增 `core/markdown-lite.js` 轻量 Markdown 解析（标题/段落/有序无序列表/粗体/行内代码/代码块/分隔线；零依赖、**不生成 HTML**、无 XSS 面），client `16-markdown.js` 构建时内联同一源码并在交接单详情面板渲染；512KB/白名单/只读约束不变。新增 `test/markdown-lite.mjs`。
- **BUG-006 交接单列表只显示最近 20 份**：列表端点返回 `total`；客户端底部显示「共 N 份（显示最近 20）」并提供「加载更多」（limit 提到 50），无更多时隐藏按钮。
- **BUG-004**：交接失败提示带原因保持已修状态，真机抽查待一次真实 `/handoff`（本次未动真实历史）。
- 测试基线：smoke 53/53、handoff 35/35、plugin-load 14/14、contract 17/17、compact-log PASS、compress-cue PASS、markdown-lite PASS。

## 0.3.3（2026-10-20，跨平台补丁版）

- **Windows 适配**：完整的测试套件（smoke 53 / handoff 35 / plugin-load 13 / contract 17 / compact-log）已在 Windows 11 + Node 24.22 实测全部通过。
- **测试跨平台修复**：`handoff` 的「目录不可写」用例改用「普通文件当父目录」制造 ENOTDIR（Windows 没有 `/dev/null` 语义）；`contract` 的交接目录断言按 `path.resolve` 比较（Windows 上 `/tmp` 会被解析为 `C:\tmp`）。
- **构建脚本**：`scripts/build-client.mjs` 忽略隐藏文件与 macOS 资源分叉（`._*`），拷贝/打包后的源码在 Windows 上也能通过 `--check`。
- **文档**：README（中英）与 DEVELOPMENT 注明测试需要 Node 22.15+（`node:module.registerHooks`）；TUTORIAL 常见问题补充「headless / QQ 桥接链路不加载指示灯与命令」；ROADMAP 明确不做桥接链路接管。
- 运行时功能与 0.3.2 一致。

## 0.3.2（2026-10-20，补丁版，行为无变化，仅设置页文案与链接）

- 设置页「帮助」区新增 npm 包页面外链（https://www.npmjs.com/package/dsh-compact-relay）；「使用教程」「反馈 / 提 bug」两条外链指向的 GitHub 地址已确认可用。
- 设置页「关于与危险操作」新增联系方式 `cfanzx@136.com` 与 npm 包页面入口。
- 链接未配置时的占位文案由「准备中」改为「未配置链接」（仅在用户手动清空 `links.tutorial` / `links.feedback` 时出现）。
- 其余功能与 0.3.1 一致。

## 0.3.1 — 2026-10-20（首个公开版：安全修复 + 架构调整 + M4/M5 体验 + 测试台 + UX 修复）

> 0.3.1 是首个公开版本（0.3.0 只用于内部发布准备、从未公开发布），汇总 0.2.x 以来的全部实现与真机验证。分四块：**安全与正确性修复**（M1/M2 安全修复、P3-01～14、BUG-001/004/007/008、P2-3/4）、**功能**（A1 九段交接单/预览卡、A4 配置 schema、A5 接力链、A6 压缩历史、A8 client 可维护性、A9 边界回正）、**体验**（M4 浮层材质/焦点/取消、菜单瘦身、设置页两行说明与三级颜色）、**测试与工程**（A7 mock/契约测试台、P2-T3/T4、e2e 真实压缩 + P2-T1 旧摘要合并、A10 状态帧成本基线）。

- **P3-01～14 清理（14 条：13 修 / 1 确认无需修）**：摘要失败文案带具体原因（不再「详见日志」却没日志）、`maxSummaries` 改正整数（0 会同时触发恒交接+恒合并，已拒绝）、`pin` 的 toggle 与写入统一按「当前 surface 仍有效」口径（快照过期时不再把「锁定」执行成「解锁」）、`gitInfo` 的 `.git/HEAD` ref 只认 `refs/` 白名单（堵住 `../` 读任意文件）、state 帧加单调 `revision`（浏览器丢弃晚到的旧帧）、交接成功文案不再谎称「旧会话原样保留」、`changed` 错误文案带「请重新预览」。P3-08（交接注入消息 `form` 字段）确认运行时合法（v4 只要求 producer-owned `kind`），不改。
- **BUG-004 交接前置压缩静默跳过**：摘要模型返回工具调用时也带「只输出正文」提示重试一次；仍失败时交接完成提示写清具体原因并建议「可先手动 /bc 再交接」（以前只有「日志有记录」）。
- **0.3.1 UX 修复（P0/P1，来自用户视角审查）**：
  - **锁定消息可视化（权重最高）**：锁定的消息在指示灯环上按「消息在历史里的相对位置」画**锁定块**（默认品红、外侧比环粗；多条锁定显示多个块，支持设置「锁定颜色」）。`state` 的 `pins` 新增 `marks: [{seq, ratio}]`；菜单顺序改为「压缩 → **锁定** → 交接 → 标记」，首次引导文案点名「锁定重要消息」并解释「重要的结论/路径先锁定，压缩时才不会被压掉」。
  - **标记进度已删除（作者拍板）**：用户手动入口（`/stage` 命令、菜单项、「保留阶段标记数」设置项、HTTP action）全部移除；判断改由两条自动路径完成——**模型判断**「这里适合压缩」（`mark_stage` 工具：最小线 < 当前 < 压缩线时记录断点）与**阈值**（到压缩线自动出断点）。
  - **环按「压缩判断」分段 + 断点**：正常区（0→断点1）未走满灰、走满蓝；断点1→交接线琥珀（压缩区）；交接线→当前红（交接区）；断点=小缺口（模型判断位置或压缩线），交接线断点固定；压缩后环变短、断点自然消失；断点位置随阈值设置实时变化。视觉规则抽成纯函数 `core/ring.js`（可单测）。
  - **最小压缩线**：新增 `thresholds.minRatio`（默认 5%，随「保留近期原文」和窗口自动抬高——小窗口下 5% 压不出净收益），低于它模型不判断压缩、环上不出断点；后端校验必须小于压缩线。
  - **DSH 原生自动压缩线**：读 profile 配置（`compaction-basic.thresholdRatio`，默认 80%）随状态下发；环上 80% 处画粗刻度，越过交接线后 80%→100% 亮半透明警告区、越过 80% 后已走段实色提醒；首次引导会告诉你当前原生线；设置页可一键关闭/恢复原生自动压缩（写 profile 配置前备份、需重启生效、带确认环节），原生开启时交接线上限自动压到「原生阈值 −1%」并由后端强校验。
  - **设置页教学卡片**：新增「指示灯怎么看」示意（5 个示例环：未满灰/走满蓝/压缩区琥珀/交接区红/原生线），随用户配色与阈值实时变。
  - **转交后收尾（2026-10-20 晚，BUG-009 / UI-003 / UI-002）**：
    - **BUG-009 教学卡片图例修正**：5 个示例环按各自语义单独构造参数（以前共用同一个假断点，5 个环的断点全挤在 ≈17%、颜色与说明不符）；「走满正常区」在压缩线上补断点示意，原生线示例画 80% 原生刻度。
    - **UI-003 原生自动压缩开关**：根因是设置页请求缺 `sessionId`，被动作接口 400 拒绝（所以永远写不进 profile、也没有可见反馈）。`native-auto` 改成不要求会话（它是 profile 级开关）；控件改成 `role=switch` 的开关 + 状态常显 + 结果就地显示在开关旁 + 确认块自动滚入视野。
    - **UI-002 设置页信息架构**：按权重分区块（压缩提示 → 压缩行为 → DSH 原生自动压缩 → 颜色与外观 → 帮助 → 关于与危险操作）；教学卡片与教程/反馈移入「帮助」；颜色行按环的阅读顺序重排（默认→填满→调整→上限→锁定，编号 ①–⑤）；「关于」区补版本与设置文件路径，恢复默认归入「危险操作」。
    - **原生线视觉（作者 2026-10-20 反馈）**：原生自动压缩线标记从「同色短弧」改成**紫色径向刻度 + 底色描边**（不再和红色分段糊在一起，任何配色下都看得清）；越过原生线后**整环红色闪烁**（1s 呼吸；`prefers-reduced-motion` 下改为常亮红色）；教学卡片同步：「还没到最小线」的灰弧加长到 ≈5% 可见，原生示例演示整环闪烁。

    - **设置页层级（作者 2026-10-20 反馈：首行缩进 / 区分菜单等级）**：每个区块的内容统一缩进 16px + 左侧 1px 层级引导线，区块标题保持一级不缩进，条目与标题的主次一眼可分。

    - **设置页标题说明（作者 2026-10-20 反馈）**：「压缩接力」标题下加一句话把「功能 + 边界」说清——看容量、到线提醒并帮你压缩旧会话 / 交接新会话、锁定重要消息；只动本插件的压缩与交接历史，不改模型回复，也不接管 DSH 原生自动压缩（只在本页开关、改了要重启）。
    - **初次引导可重播**：「帮助」区新增「再看一次初次引导」按钮，通过 window 事件触发（组件解耦）；手动重播给更长时长（光晕 9s / 提示 20s），首次仍只在第一次打开会话时自动弹一次（localStorage 记住）。
    - **初次引导回归**：隔离 DSH 全新 Chrome profile 实测——首次自动弹（呼吸光晕 4.8s + 提示 15s）→ 光晕停、提示还在 → 刷新不再弹 → 设置页按钮重播生效；按步骤截图存档。
    - **首次使用引导**：第一次打开会话时指示灯做几次呼吸光晕 + 一条提示（「点它能压缩旧会话 / 交接新会话 / 锁定重要消息」），localStorage 只出现一次；空闲态中心点也从「完全透明」改成可见的灰点（以前新用户根本看不出这里有个按钮）。
  - **小范围压缩预警**：预览阶段就判定（<800 tokens）并提示「这段偏小，压了可能反而更大」，确认按钮直接禁用，不再让用户白点一次、白等一次模型调用；`/bc` 预览文案同步。
  - **失败提示带下一步**：「摘要比被替换的内容还大」改为「先继续聊几轮，或把『保留近期原文』调小一点，再来压缩」。
  - **短会话交接提醒**：就绪检查新增「会话内容很少（少于 8 条消息）」警告；交接提示词补「不要把系统指令/输出格式要求当成会话内容」。
  - **交接预览可读性**：`## 标题` 渲染成加粗行（不再直接显示 markdown 源码），就绪警告在卡片里可见。
  - **菜单**：容量数字带单位（`约 1.4K tokens`）；压缩/交接/标记项补命令名（`/bc`、`/handoff`、`/stage`）。
- **e2e 真实压缩 + P2-T1 旧摘要合并**：新增 `test/e2e/real-compact.mjs`（`npm run test:e2e:compact`）——隔离 DSH 里用真实模型调用攒历史（GUI 发消息），第一次真实压缩把 3 条旧会话压成 1 条摘要（`summaries` 0→1、pressure 下降），第二次在 `maxSummaries=1` 下走「合并旧摘要」分支（提示「同时合并了旧摘要」，`summaries` 记 +1），6 项断言全过、约 20s。踩坑记录：`pressure` 在用户消息入 surface 时就涨，不能当「模型回复结束」判据（此时压缩会 409 正在回复中），要用 GUI 页面文本稳定（`waitReplyDone`）。
- 测试：smoke **53/53**、handoff **35/35**、plugin-load **13/13**、contract **17/17**、compact-log PASS；新增回归覆盖环分段/断点/最小线/压缩判断记录/原生配置读写、P3-01/02/03/07/12/14 与 BUG-004。
- **A8 client 可维护性**：单文件契约不变，但源码拆成 `lib/client/*.js` 十个有序片段，新增零依赖 `scripts/build-client.mjs` 拼成 `lib/client.js`；`npm test` 第一步 `build-client --check`（改了片段没重建直接红）。颜色纯数学上移 `core/colors.js`（首次可单测：HSL 派生 + WCAG 3:1、归一化、旧扁平结构兼容），host 在 state（`colors.palette`）/settings（`palettes`）一次性下发浅/深两套派生结果，浏览器半只按界面明暗挑一套，设置页未保存编辑仍走同一份纯函数（构建时内联，单一来源）。真机验证：client bundle 热加载已含新代码、菜单/指示灯正常、零 console 错误。`scripts/` 与 `lib/client/` 不进 npm 发布包（发布只带构建产物）。
- **A10 状态帧成本基线（只测量不优化）**：用真实大会话日志（某 6000+ 事件 / 400+ surface 节点 / 35 万 token 压力的大会话）+ 从 app.asar 解包的真实 DSH tokenMeter/compaction 代码重放：稳态 measure 0.45ms（p95 0.49）、countSummaries 0.12ms、selectCompactableRange 0.12ms、整帧 readState 0.64ms（p95 0.94）；首次全量 fold 21.7ms（一次性）。真机端点 `/api/compact-relay-state?sessionId=<大会话>` 端到端 p50≈1.8ms、max 2.5ms。离「p95>8ms 或节点>1500」触发线很远 → 不做 detail 拆分/WeakMap 缓存，只留基线备 0.4 用。
- **A6 压缩历史**：新增 `lib/dsh/compaction-log.js`（只读配对 summary/end/replace，输出最近 N 次压缩的范围、摘要预览 ≤200 字、容量、已提交/失败/未闭合）与 `GET /api/compact-relay-diff`；菜单「查看上次压缩」打开只读面板。已提交口径与 `countSummaries` 一致；兼容真实 DSH 的块数组摘要（`[{type:'text',text}]` 归一为预览）。
- **菜单瘦身（B 方案）**：压缩/交接保留两行说明，锁定/查看交接单/查看上次压缩改为单行 + 右侧状态（未标记/未锁定/›），菜单高度 342→288px、6 项不再滚动；说明原文保留在悬停 title。
- **A1 九段交接单**：交接单从六段升级为九段（总体目标/约束/已完成/当前进度/改过的文件/关键决策/已知问题/未完成/下一步）；标题唯一来源 `core/handoff-spec.js`，提示词/校验/渲染/客户端文案全部由规格表派生。新增 `core/handoff-facts.js`（程序收集「当前进度」「改过的文件」）与 `core/readiness.js`（就绪检查：缺段/占位阻断，路径核对只警告）；`dsh/session-files.js` 从会话日志的写文件工具调用收集改过的路径（不跑 git status）。模型只写 7 段，程序段不可编造。新增 `handoff-preview` action 与菜单「交接预览卡」：九段草稿 + 就绪清单，确认后才压缩/写盘/建会话。浮层定位改为按估计高度判断翻转并夹在视口内（矮视口不再顶出屏幕）；就绪检查的路径告警会去掉尾部反引号/标点。
- **A7 测试台**：新增 `test/harness/{host,session,llm,dsh-stubs}.mjs` 统一 mock；smoke/handoff/plugin-load 的重复手搓 mock 迁入（当时：smoke 1108→1041、handoff 1044→783、plugin-load 648→515 行）；新增 `test/contract.mjs`（17 条契约：fake replace/故障注入语义 + 用真实替换事务跑成功/失败路径 + 冻结 engine 9 个符号）。（最终计数见本节开头基线。）
- **P2-3 幽灵摘要**：`countSummaries` 改为「summary + 无 error end + 覆盖它的 replace」配对计数，失败事务不再算已压缩。
- **P2-4 模型路由**：`routeOf(ctx, session, agent)` 优先 DSH `modelSelection` 投影（pending→lastUsed），切模型后摘要/交接/子会话不再沿用旧 requestHeader。
- **M4 client 修复**：交接卡区分 opening/opened/failed（刷新后不再误报成功、失败可重试打开）；toast 单 timer（新提示清旧 timer，4/5/6/8s）；交接单详情请求带序号 + AbortController（防乱序/关闭后重新撑开）；浮层定位滚动/缩放重算复核通过。
- **BUG-001 浮层底色**：悬停卡/菜单/确认卡/交接单/toast 改用 DSH 官方弹层材质 token（`--dsw-menu-surface-fill` + `--dsw-menu-backdrop-filter`，实测与官方账号菜单完全一致：浅 `rgba(248,249,250,.58)`、深 `rgba(67,69,74,.45)`，`blur(40px) saturate(150%)`），文字/边框用 `label-*`/`border-l3`；theme observer 监听 `data-ds-theme-source` / `data-ds-dark-theme`。
- **P2-A1～A3**：小字对比度交给 DSH 次级文字 token；菜单/确认卡/交接单加 role+aria-label、打开进焦点、Esc 关闭后焦点回指示灯；悬停卡允许换行、窄窗收边（320px）。
- **BUG-007/008 命名**：入口改「压缩预估」、确认卡「确认压缩」+「只估算范围和容量，摘要确认后才生成」；`/bc` 输出、命令描述、README/TUTORIAL 统一。
- **P2-T3/T4**：`npm test` 先 `node --check lib/client.js`；`test/e2e/action.mjs` 按动作判成功（compact 需「压缩完成」、handoff 需 childId+path，`compacted:false` 标 noop）。
- 测试（当时）：`smoke 42/42`、`handoff 31/31`、`plugin-load 13/13`；隔离 e2e `settings-ui`/`smoke` 均 PASS（最终基线见本节开头）。

- **A4 配置 schema**：新增 `core/config-schema.js` 单表派生默认值/校验/中文文案/设置页白名单/公开视图；用户设置文件「合法 JSON + 非法值」不再让插件整体不激活（回落默认 + 设置页显示 `settingsError`）；设置文件升级为 `{v:1,config}` 信封（旧扁平兼容）；设置页「恢复默认」加二次确认、未保存修改提示。
- **A5 接力链**：交接成功时在父会话写 `plugin:compact-relay/relay` 结构化记录（parent/child/index/path/planId），下一次交接标题/序号优先读记录，标题解析只做旧数据兜底；`readState` 下发 `relay`；命令卡优先用结构化 `childId`（文本 `#child=` 兜底）。
- **A9 边界回正**：`dsh/state-hub` 的 `readState` 由装配层注入（dsh 不再反向 import actions）；`adapters/http` 的交接单读取与 `pickAgent` 改走 `actions/handoff-docs` / `actions/state.resolveTarget`；设置拆成 `dsh/settings-file`（读写）+ `actions/settings`（合并/校验/热替换），旧 `settings-store.js` 保留兼容 shim。
- **P2-6 e2e 隔离**：隔离 home 不再复用真实 `compact-relay.json`/交接目录，写入最小设置（`handoffDir=/tmp/relay-e2e/handoffs`）并清空复制来的交接单；启动时断言 `handoffDir` 在隔离目录下。工作区 cwd 暂保持真实（改 workspace path 会让 GUI 停在「选择工作区」，e2e 拿不到指示灯）；e2e 只建会话 + 调插件 HTTP 动作，不执行写工作区的工具/命令，M5 用工作区副本收紧。

### 安全修复（M1/M2）

- **P0**：`/api/compact-relay-*` 五个端点接上宿主 `connection.requestRejection`，不再绕过宿主 `/api` 的 Host/Origin 校验与浏览器 token 认证（此前无 cookie 的 GET 能读设置/状态/交接单，伪造 Host 也放行）。HTTP 端点现在 `inject` 宿主 `connection` 服务。
- **P1**：修复 `Origin: null` 的跨站 POST 被当同源（sandbox iframe / no-cors 可绕过 CSRF）；`sameOrigin` 现在先拒 `null`、cross-site 一律拒绝（仅自定义协议白名单）。
- **P1-2**：占位判定由枚举白名单改为「句式 + 整篇内容量」——「无明确未决问题」「No open questions.」这类自然语言空话不再能绕过；空壳摘要/交接单仍会被拒。
- **P1-3（架构 A3）**：预览返回 `planId`；确认带 `expected`，重算范围不一致以 `changed` 拒绝并让客户端重开确认卡；`/bc confirm` 从 5 分钟预览缓存取范围。
- **P1-4（架构 A2）**：新增 `lib/dsh/llm-call.js`——预算预检 + 默认 180s 超时（可配置 `timeouts.llmMs`）+ 网络/5xx/限流重试一次 + 可取消；`/handoff` 登记 inflight，UI 交接中也能取消；交接先做目录可写 preflight，建会话失败会清掉刚写的交接单。
- **P2-1/P2-2/P2-5**：取消不再谎报「历史没改」（commit/persistence 原样上报）；`reasoningEffort` 按模型目录能力决定，不再硬编码 `off`。
- 测试（当时）：`smoke 37/37`（新增占位句/内容量回归）、`handoff 30/30`（新增 A2/A3、交接取消、preflight、非推理模型）、`plugin-load 13/13`。

## 0.2.5 — 2026-10-20

发布准备与产品化收尾（功能与 0.2.4 之后累积的改动一致）：

- 设置栏：DSH「设置 → 压缩接力」，可调压缩线/交接线（窗口比例）、摘要份数上限、保留近期原文、交接单目录、颜色模式与颜色。
- 三级颜色：默认/调整/上限 + 可选阶段色；只选基准色，浅色/深色两套自动派生（HSL 明度钳制 + WCAG 对比度 ≥3:1），保存即时生效。
- 阈值改为窗口比例（`compactRatio=0.4` / `handoffRatio=0.6`），换小窗口模型自动缩放；兼容旧绝对阈值写法。
- 设置页每个设置两行小字：「作用」+「调整后」；顶部预留 GitHub 教程/反馈入口，底部「关于」含简介、版本、致谢。
- 新增 `TUTORIAL.md`（3 分钟教程草稿）；`links.tutorial` / `links.feedback` 填 URL 后设置页自动变可点链接。
- 修复：空壳摘要覆盖历史、长会话交接单回放截断、合并模式钉住失效、确认卡容量字段错位等（详见仓库提交记录与 BUG 台账）。
- 工程：补 `LICENSE`（MIT）、`CHANGELOG.md`、`ROADMAP.md`、设置页 UI e2e 脚本 `test/e2e/settings-ui.mjs`、npm scripts。

## 0.2.4 — 2026-10-19

- 交接会话标题改为「交接第 N 次：<原题>」，不再叠前缀。
- 注释整理、界面文案统一白话。

## 0.2.3 — 2026-10-18

- 修确认卡「undefined 条 / — 容量」字段错位。

## 0.2.0–0.2.2

- M6：压缩预览/确认/取消、交接单入口 + 现场快照、手动阶段标记、锁定重要消息。
- 界面命名统一：压缩旧会话 / 交接新会话 / 标记进度 / 锁定重要消息 / 查看交接单。
