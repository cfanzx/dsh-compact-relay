# 生态调研：有没有和我们类似的插件（2026-10-19 17:45）

> 调研目的：在继续投入 M2/M3/M5 之前，先看 DSH 生态里已经有哪些「上下文指示灯 / 精压 / 接棒」类插件。
> 数据源：① awesome-dsh-plugin 插件市场目录（npm 包 `dsh-plugin-catalog@2026.1019.8082`，**5,945 个插件**，目录更新 2026-10-18）；② npm registry 搜索；③ GitHub API 仓库搜索（6 组查询，筛出 83 个 DSH 相关仓库）。

**一句话结论：这个方向不空白，而且相当卷。**「上下文可视化」「压缩内核」「/handoff 换会话」三组都有成熟插件，其中至少 4 个和我们的规格大面积重叠。

---

## 一、最像我们的竞品（按接近程度）

### 1. `context-vista` — 环形图指示灯（最像 M5）
- GitHub：https://github.com/GooodWei/context-vista （★11）
- 内容：`/context` 斜杠命令 + 右侧常驻**迷你环形图悬浮卡**，实时显示上下文 token 用量与组成（系统/工具/消息/剩余）、占用进度条、累计与估算费用；悬浮卡底部直接有「压缩上下文」按钮（≡`/compact`）。
- 与我们的差别：是**单环+进度条**，没有「外环占用/内圆接棒」双信号；没有 40 万/60 万的预警阈值；压缩走原生 `/compact`。

### 2. `dsh-session-handoff` — /handoff 换会话（最像 M3，且更完整）
- GitHub：https://github.com/WeiYe6/dsh-session-handoff （★5）
- 内容：`/handoff [N|all]` → LLM 摘要 → **新建同工作区会话+agent** → 注入六段式交接文档 → **自动切过去**；原会话不动。零内核改动、只用一个 bundle patch 行。
- 与我们的差别：它已经把我们 M3 想做的事做完了（含 auto-open、thinking off、max-tokens 处理）。我们唯一多出来的部分是「先精压一次」和六段标题的本地化措辞。

### 3. `dsh-handoff-compaction` — 8k 交接摘要 + 16k 最近上下文（最像 M2）
- GitHub：https://github.com/knighthongyu/dsh-handoff-compaction （★1）
- 内容：把旧对话压成结构化 `# Context Handoff`，最近消息原样保留；**摘要/保留预算可在插件页可视化调**（默认 8k + 16k）；压缩请求回放完整 surface + 相同 system/tools（cache 友好）；旧消息可全文检索回读。
- 与我们的差别：预算算法不同（8k/16k 固定），没有「跳过旧摘要=不二压」和「摘要≥6 份才允许合并」的泄压阀。

### 4. `dsh-smart-compact` — 零模型调用换窗（最像「反 LLM 摘要」路线）
- GitHub：https://github.com/hoyyang/dsh-smart-compact （★7）
- 内容：Codex 式窗口管理——预算可见、快满时提醒交接、工作笔记跨压缩存活、无损归档可逐字回查、**换窗压缩引擎零 LLM 调用**（不生成摘要，机械换窗），附「一键换窗」按钮和 `/smart-compact`。
- 与我们的差别：它根本不用摘要（无损归档），所以不存在「二压」问题，但上下文变小靠换窗而非精压；我们的「摘要型精压 + 不二压」是另一种取舍。

### 5. `dsh-context-compressor` / `dsh-context-manager` — 一键压缩 + 新会话（接棒流程的另一种实现）
- https://github.com/qwert702/dsh-context-compressor （★0）
- https://github.com/SkanderBog/dsh-context-manager （★2，市场里另有 @mzzsfy、Missher 同名系列）
- 内容：会话标题栏「压缩」按钮 → 把整段对话总结成几句 → 新建同工作区会话注入摘要并自动切换；或「预览上下文 → 按组选择保留/摘要/省略 → 持久化压缩」。

---

## 二、其他相关但不算直接竞品

| 类别 | 插件 | 关系 |
|---|---|---|
| 上下文看板/建议 | `dsh-context-governor`（mpinaev，★2；档位、按窗口推算压缩阈值、缓存费率、**一键交接**）、`dsh-token-attention`（Young4ever33；换对话/写 hand-off/压缩建议）、`@hjdd14/dsh-toolong-warning`（统计压缩次数+浮动提醒）、`guoliyuan97-png/dsh-game-hud`（HP/MP 条 + 自动压缩 + 记忆换会话）、`lssyd20070106/dsh-ui-preset-enhance`（token/context 可见 + 手动 compact） | 覆盖「指示灯/提醒/建议」的部分职责 |
| 压缩内核替代 | `dsh-argp`（守卫式压缩）、`TsFreddie/dsh-compaction-instant`（零 LLM 无损压缩）、`@zoria-lind/dsh-token-optimizer`（压力分层）、`dsh-context-zip`（五段式交接摘要+分段回查）、`dsh-clear-mind`（模型自选区间→checkpoint，走平台 API）、`dsh-dcp`、`dsh-notes-context`、`dsh-block-ptc`、`dsh-quilt-compact`、`dsh-context-guardian`、`dsh-jev-prune`、`smart-compaction`（JoblessJoe）等 | 都是「换掉 compaction-basic」的思路，和 M2 同赛道 |
| 阈值控制 | `dsh-compaction-policy`（zyd232，★2）：把自动压缩从过早触发改到设定比例（默认 80%） | 正好对应我们发现的「阈值配置落在 preset 作用域、patch 打不进去」问题；**值得读它的实现** |
| 接棒/续接 | `dsh-session-continuity`（新会话首条接续指针）、`S3K926/dsh-auto-handoff`（**已弃用**，作者结论：换会话退役、交给官方压缩）、`dsh-budget-handoff`、`dsh-session-fork`（git 式分支）、`dsh-task-relay`、`task-passport`、`dsh-companion` | 我们 M3 的同类，思路各异 |

---

## 三、和我们原始规格的对照

| 我们的设计 | 生态现状 | 是否还有差异 |
|---|---|---|
| 环+圆双信号指示灯（外环=占用、内圆=接棒） | 最接近 context-vista（环形图+悬浮卡）与 context-governor（档位+阈值） | **有**：没人做「环与圆分离、内圆专表示接棒信号」的双信号语言 |
| 压缩线 40 万 / 接棒线 60 万（1M 窗口） | governor 按窗口推算阈值；compaction-policy 调原生阈值 | 部分重合；我们的双阈值+菜单动作组合没看到同款 |
| 不二压 + 定型合并泄压阀（摘要≥6 才合并） | smart-compact 换窗无损、handoff-compaction 固定预算、rollover 类跳过摘要 | 没有找到完全同规格策略；但「跳过旧摘要」思路已有多个先例 |
| 精压（自建 surfaceOp 事务） | clear-mind / context-manager / session-handoff（acp_*）已走官方 compaction API；M1 结论被生态印证 | 技术路线不新，但可复用他们的坑经验 |
| /handoff 六段文档 + 建新会话 + 自动切换 | WeiYe6/dsh-session-handoff 已完整实现，且更成熟 | **基本无差异**（除了「先精压一次」的顺序） |
| 指示灯点击菜单（精压/接棒两个动作） | context-vista 悬浮卡只有「压缩」一个按钮 | 有差异：双动作菜单 + 忙碌态 |

---

## 四、建议（按目标选路）

**路线 A：目标是「马上好用」**
装 2–3 个现成插件组合，我们的插件停在 M1（代码保留，不继续投）：
- 看板/提醒：`context-vista`（环形图+悬浮卡）或 `dsh-context-governor`（档位+阈值+一键交接）
- 接棒：`dsh-session-handoff`（WeiYe6，最完整）
- 调阈值：`dsh-compaction-policy`（如果还想改原生压缩线）

**路线 B：目标是「自己的工具、按自己的政策」**
继续自研，但**缩范围**：
- M2 保留（不二压+泄压阀是唯一真正的策略差异）；
- M3 直接照 WeiYe6 的做法（甚至把它的 auto-open 思路抄过来），不重复踩坑；
- M5 指示灯是唯一真差异化 UI，继续做；
- 其余（压缩内核细节、换会话流程、提醒）优先参考现成实现，不重造。

**路线 C：混合（不推荐）**
保留我们的环+圆 UI，动作层去调现成插件的命令——插件间耦合和调试成本高，不如 A 或 B。

**不管选哪条，先做的一件事**：实际装 `context-vista` + `dsh-session-handoff` 试 10 分钟，用体感判断「自研 UI 是否值得」。这比继续写几百行代码便宜得多。

---

## 五、值得读源码的 5 个

1. `zyd232/dsh-compaction-policy` —— 它怎么把阈值改到 preset 作用域的 compaction-basic 上（解决我们「patch 打不进 preset」的问题）。
2. `GooodWei/context-vista` —— 环形图 + 悬浮卡 + 拖动/记忆位置的 client 实现（M5 可直接借鉴）。
3. `WeiYe6/dsh-session-handoff` —— `/handoff` 建新会话 + auto-open 的客户端半逻辑（M3）。
4. `knighthongyu/dsh-handoff-compaction` —— 预算可视化配置 + cache 友好的完整 surface 回放实现（M2 对比）。
5. `@hjdd14/dsh-toolong-warning` —— 压缩计数与浮动提醒（M5 内圆提醒的另一种做法）。
