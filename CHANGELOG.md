# Changelog

## Unreleased

（暂无新改动）

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
