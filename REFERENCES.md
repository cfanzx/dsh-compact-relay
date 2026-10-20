# 参考实现调研与致谢（REFERENCES）

> 日期：2026-10-19
> 方法：抓取 awesome-dsh-plugin 插件目录（`dsh-plugin-catalog@2026.1019.8082`，5,945 个插件）+ npm 搜索 + GitHub 仓库搜索，挑 10 个最相关的仓库**下载源码逐份读**。
> 用途：① 给我们的设计找已证明可行的路和坑；② **上 GitHub 发布时作为引用与致谢**（最后一节有可直接用的文案模板）。
> 规则：本文件只记录「思路级借鉴」；**目前没有复制任何参考实现的代码**。若以后复制片段，必须按对应许可证保留版权声明（见 §4.3）。

---

## 0. 结论摘要

1. **已有三条路被完整走通**：上下文看板/提醒（context-vista、toolong-warning）、自建事务压缩（clear-mind、compaction-instant）、换会话接棒（session-handoff-weiy、context-compressor）。我们的功能不空白，但「不二压选段政策 + 双信号指示灯」仍没人做。
2. **我们 M1 的技术路线是对的**：`compaction/start → summary → user/message(replace) → end` 的自建事务与 clear-mind 的 `commit.ts` 几乎同构，互相印证。
3. **0.2.x 上「替换压缩引擎」这条路是坑**：`compaction` 引擎挂在 agent preset 的隔离组里，宿主层 patch 打不到；handoff-compaction / smart-compact 靠抢 `compaction` 服务槽的写法在 0.2 上会 slot occupied（smart-compact 自己做了冲突检测降级）。要影响自动压缩，正确姿势是 `ctx.agentPresets.serviceFor(agent,'compaction')` 运行时门控（compaction-policy 的做法）。
4. **我们最该补的三件事**：① 摘要的**结构校验 + 禁止编造**（handoff-compaction 有 `validateHandoffText`，我们 M1 实测出过编造）；② 摘要调用与上次请求的**缓存对齐参数**（reasoningEffort/temperature/stop）；③ 指示灯数据源改用 **session projections 实时订阅**，别再 5 秒轮询 HTTP。
5. **反模式**：smart-compact 的 `scripts/patch-token-meter.mjs` 直接改 `node_modules` 里的 DSH 文件——升级即失效、侵入用户环境。我们不学。

---

## 1. 逐个参考对象（10 个）

### 1.1 `dsh-compaction-policy` — 改自动压缩阈值（MIT）
- 仓库：https://github.com/zyd232/dsh-compaction-policy
- 思路：不抢 `compaction` 槽，而是 `ctx.agentPresets.serviceFor(agent, 'compaction')` 取出 preset 作用域的引擎，包一层门控：只有跨过「我们」的阈值才放行原生自动压缩。纯函数 `computeTriggerTokens()`（与官方同公式、换 headroom），配置支持按 route 过滤。
- 已走通：preset-plane 引擎的运行时门控；确认了 0.2 的阈值真相（`thresholdRatio 0.8 + headroomTokens 65536`，且**任何 patch 层都到不了 preset 里的 compaction-basic**）。
- 更好/我们能做的：我们不需要自建自动压缩；如果以后想让 `/bc` 的手动建议线与自动压缩联动，用它的 `serviceFor` 门控思路即可。
- **借鉴**：`serviceFor` 取引擎；纯函数 policy + 单测；「阈值不可 patch，只能门控」的结论（已写进我们的配置说明）。

### 1.2 `context-vista` — 环形图指示灯（MIT）
- 仓库：https://github.com/GooodWei/context-vista
- 思路：host 注册 `/context` 命令；client 用 `shell.overlay` 槽画常驻悬浮卡 + 环形组成图；数据来自 **session projections**（`contextPressure` / `contextBreakdown` / `tokenUsage`）实时订阅，而不是轮询接口；压缩按钮触发 `/compact`；donut 用 SVG path（`segPath`，支持整环拆两圆 + evenodd 挖洞），拖动位置记忆。
- 已走通：环形图/组成图、实时订阅、悬浮层挂载、压缩按钮、费用估算。
- 更好：它是**单环 + 单按钮**；我们的「外环占用 + 内圆接棒」双信号和点击菜单是差异点。它的 `/compact` 生命周期判定值得学：`command/run` 到达≠完成，要等 `command/done` 的 outcome 或出现 compaction 节点（我们 M1 的 `command/done` 也带 `sourceEventSeq`，可以直接用）。
- **借鉴**：projections 订阅做实时数据；`shell.overlay` 挂载方式；donut 绘制思路；命令生命周期判定。

### 1.3 `dsh-handoff-compaction` — 结构化交接摘要（MIT）
- 仓库：https://github.com/knighthongyu/dsh-handoff-compaction
- 思路：`extends BasicCompactionEngine` 只覆写 `summarize()`；压缩预算可在插件页可视化配置（默认 8k 摘要 + 16k 近期原文）；摘要调用**回放完整当前 surface + 追加指令**（cache 友好），并复用上一次请求的 `reasoningEffort/temperature/stop` 做 cache alignment；产出的 Markdown 过 `validateHandoffText` 结构校验，失败重试 2 次并带 recovery 提示；禁用工具调用/图片输出；附 history 查询工具回查原文；带 `THIRD_PARTY_NOTICES.md`。
- 已走通：只换摘要不碰事务；结构校验；缓存对齐；失败重试；原始历史可回查。
- 限制：0.2 上它靠 `disabled: true` 顶层 compaction-basic + 抢引擎槽，和 preset 引擎有冲突风险（见 1.1 的结论）。
- **借鉴**：摘要结构校验、工具调用检测、重试与 recovery 提示、cache 对齐参数、`THIRD_PARTY_NOTICES.md` 模板；**不借**它的引擎注册方式。

### 1.4 `dsh-smart-compact` — 零模型换窗（BSD-3-Clause）
- 仓库：https://github.com/hoyyang/dsh-smart-compact
- 思路：`extends BasicCompactionEngine` 覆写 `summarize()`（固定模板，**零模型调用**）+ `compactIfNeeded()`（三档：安静/收尾宽限/强制换窗）；配套 `new_context` 工具、`ctx_notes` 工作笔记、`ctx_history` 无损回查、预算显示与提醒；`compaction` 槽冲突时**构造期捕获**并降级为只装工具；另有 `scripts/patch-token-meter.mjs` 直接改 `node_modules` 修上游 bug。
- 已走通：零模型换窗、无损归档、交接锚点、笔记新鲜度（STALE 警告）。
- 更好：它的「零模型固定模板」可以作为我们「定型合并泄压阀」的一种实现（定型内容不需要 LLM 重写）；但 `node_modules` 补丁是反模式，我们不做。
- **借鉴**：预算测量方式、槽冲突检测降级、交接锚点/Stale 提示设计。

### 1.5 `dsh-clear-mind` — 模型自选区间压缩（MIT）
- 仓库：https://github.com/john-walks-slow/dsh-clear-mind
- 思路：`mind_map` 工具让模型俯瞰上下文（稳定 seq、角色、token、可清理边界），`clear_mind` 工具选区间 → 替换成模型自写 checkpoint。**事务完全镜像官方引擎**：`compaction/start → compaction/summary → user/message(surfaceOp.replace) → compaction/end`，带 `sourceEventSeqs`、系统提示保护、工具配对边界建议（`nearestBoundaries`）、压缩锁检查（未配对 start）、失败补 end、`compaction/prune` 事件 + 可见 tombstone 文案。
- 已走通：与我们的 M1 事务同构（互相印证）；模型自主选段。
- 更好：模型选段不确定、贵；我们的**确定性阈值政策**更可预测。它的边界建议和 tombstone 展示值得学。
- **借鉴**：`compaction/prune` 事件、tombstone 文案、边界建议、锁检查写法。

### 1.6 `dsh-session-handoff`（WeiYe6）— /handoff 换会话（MIT）
- 仓库：https://github.com/WeiYe6/dsh-session-handoff
- 思路：`/handoff [N|all]` → LLM 摘要 → `ctx.agents.create()` **会话和 agent 一起建**（避免裸 `sessions.create` 让客户端走 agent resume 路径）→ workspace attach → `child.append(注入事件, createUserMessage(...))` 注入六段文档 → client 用 `conversation.chat.commandview` 卡片 + `ctx.sessions.open()` + 轮询 `waitAndOpen`（等 session binding 就绪）自动切换，localStorage 防重复打开。
- 已走通：我们 M3 想做的整条流程，且更成熟（参数 N/all、thinking off、max-token 处理）。
- **借鉴**：M3 直接照这条路线（agents.create + attach + append + waitAndOpen），六段文档模板可对照。

### 1.7 `@snow-the/dsh-session-handoff`（snow-The）— acp_* 工具集（MIT）
- 仓库：https://github.com/snow-The/dsh-session-handoff
- 思路：把官方压缩 API 工具化：`acp_config`/`acp_set_limit`（阈值持久化到 `settings.yaml`）、`acp_compress`（模型写摘要 + 官方压缩 API）、`acp_graph`（会话图/FTS 回查）、cache 统计（跟踪 `surface.replaceGeneration`）、模型路由 failover。
- 已走通：官方压缩 API 的完整工具化封装；阈值持久化；回查索引。
- **借鉴**：阈值/预算持久化到 settings 的做法；`replaceGeneration` 监控缓存影响（每次替换都会推进 generation）。

### 1.8 `dsh-context-compressor` — 一键压缩换会话（MIT，仓库无 LICENSE 文件）
- 仓库：https://github.com/qwert702/dsh-context-compressor
- 思路：HTTP `POST /api/dsh-context-compressor/compress {sessionId}` → 读会话事件重放 surface → 总结 → `ctx.sessions.create(undefined, {meta})` + `append('user/message', checkpoint, {surfaceOp:'append'})` → 返回新会话 id，client 导航过去；源会话不动。
- 已走通：最小换会话路径；HTTP + client 导航协议。
- 更好：裸 `sessions.create` 在部分情况下让客户端走 resume 路径（WeiYe6 注释），M3 用 `agents.create` 更稳。
- **借鉴**：最小实现对照、HTTP 端点 + client 导航的分工。

### 1.9 `@hjdd14/dsh-toolong-warning` — 压缩计数提醒（MIT）
- 仓库：https://github.com/Hjdd14/dsh-toolong-warning
- 思路：从 durable 日志 fold 出每会话的 compaction 次数（含冷会话），GET state 路由给浏览器，浮动 UI 常驻显示次数/提醒。
- 已走通：压缩计数提醒（对应我们「摘要 ≥6 → 接棒」）。
- **借鉴**：从日志 fold 计数（比我们每次扫全表更可缓存/增量）、http state + client 轮询模式。

### 1.10 `dsh-compaction-instant` — 零 LLM 无损压缩（MIT）
- 仓库：https://github.com/TsFreddie/dsh-compaction-instant
- 思路：**contract-exact drop-in replacement** for `compaction-basic`：事务协议、busy/changed/summary/commit/persistence 错误分类全部对齐，只把摘要步骤换成离线 VCC 编译器（移植 lllyasviel/VCC），零模型调用。
- 已走通：完整事务合约的错误分类；零模型摘要。
- **借鉴**：错误分类清单（我们 M1 只做了大类）；VCC 思路可作为「定型合并泄压阀」的实现（压已定型内容时用编译器而非 LLM）。

---

## 2. 「已走通 / 走不通 / 反模式」总表

| 路 | 状态 | 证据 |
|---|---|---|
| 自建 surfaceOp.replace 事务 | ✅ 走通 | clear-mind `commit.ts` 与我们的 M1 同构；compaction-instant 把同一事务做成 drop-in 替换 |
| 只换摘要、不碰事务 | ✅ 走通（但注册方式受限） | handoff-compaction、smart-compact 都 `extends BasicCompactionEngine` 覆写 hook |
| 0.2 上替换/抢占 `compaction` 引擎 | ❌ 不推荐 | preset-plane 隔离 + 单槽；smart-compact 需冲突检测降级；compaction-policy 明确「patch 到不了 preset」 |
| 运行时门控自动压缩 | ✅ 走通 | compaction-policy 用 `agentPresets.serviceFor()` |
| 换会话（/handoff） | ✅ 走通 | WeiYe6（agents.create + attach + waitAndOpen）、context-compressor（最小版） |
| 实时上下文数据 | ✅ 走通 | context-vista 用 session projections 订阅 |
| 压缩计数提醒 | ✅ 走通 | toolong-warning 日志 fold + state 路由 |
| 改 `node_modules` 修上游 | ⚠️ 反模式 | smart-compact 的 patch-token-meter：升级即失效、侵入环境 |
| 零模型摘要/换窗 | ✅ 走通 | smart-compact（模板）、compaction-instant（编译器） |

---

## 3. 对我们设计的具体修改（据此更新 ARCHITECTURE）

> 2026-10-19 18:05：本节 M2 的三项（结构校验、缓存对齐、重试）已落地到 `core/validate-summary.js` + `dsh/summarizer.js`；M3/M5 项待后续里程碑执行。

### M2（精压内核）
1. `dsh/summarizer.js`：优先用 `session.deriveMessages()` 取完整 surface 消息（若存在）来构造前缀；复用上一次请求 `requestHeader().config` 里的 `reasoningEffort/temperature/stop` 做 cache alignment。
2. 新增 `core/validate-summary.js`（纯函数）：必需小节齐全、非空、出现工具调用/图片则拒绝；失败重试最多 2 次，第二次带 recovery 提示（参考 handoff-compaction `validateHandoffText`）。
3. 摘要 prompt 已加「只许原文事实」；校验层再加一道（M1 实测第一次摘要编造了 `indexByKey` 等）。

### M3（接棒）— 2026-10-19 已落地 ✅

1. 走 WeiYe6 路线，但按 DSH 0.2 API 重写（0.1 的 `ctx.sessions.open()` / `conversationEvents`
   在 0.2 都不存在，详见 ARCHITECTURE §8.7）：
   `ctx.agents.create()`（会话+agent，setup 里 mount 原 preset）→ `workspaceRegistry.create(cwd).attachSession()`
   → `sessionTitle.rename()` → `childAgent.followup(六段文档)`（文档落盘 + 起第一轮，避开 0.2 空白 Hero）
   → client 用 `conversation.chat.commandview`(key=handoff) 卡 + `ctx.uiWorkspace.openSession(id)` 自动切。
2. 交接文档六段沿用我们的 `core/handoff-doc.js`；内容改由**独立 handoff prompt** 让模型写
   （不走压缩摘要器），并加 `core/validate-handoff.js` 结构校验 + 重试。
3. 0.2 实测踩到的两个硬坑（已修）：
   - **v4 消息 source 只认 producer-owned kind**：`{kind:'plugin'}` 会被拒
     （`format v4 message requires a producer-owned source kind`），插件来源要写 `kind:'plugin:<插件名>'`；
   - **`ctx.agents` 在 0.2 只有 `get/list`（没有 `values()`）**：枚举 agent 要按 `list()`，否则 HTTP
     action / 指示灯永远拿不到活动会话（静默 null）。

### M5（指示灯）
1. client 改 **session projections 订阅**（`contextPressure`/`contextBreakdown`/`tokenUsage`），HTTP state 端点保留给「无 client 场景/调试」。
2. 悬浮卡挂 `shell.overlay`，`/context` 详情挂 `conversation.chat.commandview`（参考 context-vista）。
3. 命令生命周期：`command/run` ≠ 完成，等 `command/done` 的 outcome 或 compaction 节点（我们已有 `sourceEventSeq` 可关联）。

### 明确不做
- 不抢 `compaction` 服务槽、不 patch `node_modules`、不复制参考实现代码（只借思路）。

---

## 4. 引用与致谢（上 GitHub 时用）

### 4.1 README 致谢段草案

```markdown
## 参考与致谢 / Credits

本插件的设计参考了以下 DSH 社区插件的公开实现（仅借鉴思路，未复制代码）：

- [dsh-clear-mind](https://github.com/john-walks-slow/dsh-clear-mind) (MIT) — 自建替换事务与边界/锁检查的写法参照
- [dsh-handoff-compaction](https://github.com/knighthongyu/dsh-handoff-compaction) (MIT) — 摘要结构校验、重试与缓存对齐
- [dsh-compaction-policy](https://github.com/zyd232/dsh-compaction-policy) (MIT) — preset 作用域引擎的运行时门控思路
- [context-vista](https://github.com/GooodWei/context-vista) (MIT) — 环形图与 session projections 实时订阅
- [dsh-session-handoff](https://github.com/WeiYe6/dsh-session-handoff) (MIT) — /handoff 建会话 + auto-open 流程
- [dsh-smart-compact](https://github.com/hoyyang/dsh-smart-compact) (BSD-3-Clause) — 预算测量与交接锚点设计
- [dsh-toolong-warning](https://github.com/Hjdd14/dsh-toolong-warning) (MIT) — 压缩计数与提醒
- [dsh-compaction-instant](https://github.com/TsFreddie/dsh-compaction-instant) (MIT) — 事务错误分类契约

感谢以上作者把实现公开，本项目的很多「少走弯路」来自他们踩过的坑。
```

### 4.2 THIRD_PARTY_NOTICES 规则
- 若**复制**了任一处代码（哪怕函数级）：在我们的仓库根目录建 `THIRD_PARTY_NOTICES.md`，逐条写明「文件 → 来源 → 版本 → 许可证全文」（格式照抄 handoff-compaction 的同名文件）。
- 若**只借鉴思路/接口设计**：README 致谢 + 本文件即可，不需要第三方许可证全文。

### 4.3 许可证约束（当前 10 个参考）
- MIT（9 个）：保留版权声明与许可声明即可；我们自己的插件也是 MIT。
- BSD-3-Clause（smart-compact）：保留版权声明 + 三条款 + **不得用作者名背书**（若未来复制其代码，不能暗示作者认可本项目）。
- `dsh-context-compressor` 仓库无 LICENSE 文件（package.json 标 MIT）；**只借鉴思路、不复制代码**，避免许可证边界不清。

---

## 5. 维护

- 新增参考对象时：补 §1 条目 + §4.1 致谢行 + §4.3 许可证记录。
- 发布前检查一遍所有 URL 与许可证是否失效（社区插件改名/归档常见）。
- 若某个参考实现的许可证缺失或不明确：只借思路，不复制代码。
