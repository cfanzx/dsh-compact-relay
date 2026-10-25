# Changelog

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
