<div align="center">

# dsh-compact-relay · 压缩接力

**DeepSeek Harness 输入框上下文状态指示与会话管理插件。**

简体中文 · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-compact-relay?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-compact-relay)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-4d6bfe)](https://www.deepseek.com/harness/)
[![license](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![version](https://img.shields.io/badge/version-0.4.1-blue)](CHANGELOG.md)

</div>

![指示环与悬停数据](assets/hero-ring.jpg)

## 概述

本插件在输入框旁提供一个 28px 的环形状态指示器，用于实时展示上下文窗口占用率与压缩评估状态，帮助用户在触发自动压缩前主动管理上下文：

- **灰色**：低于最小压缩阈值，暂无需执行压缩。
- **蓝色**：常规容量区间已满，可执行手动压缩以释放空间。
- **琥珀色（带缺口）**：达到建议压缩点（由缺口标识），点击可预览压缩估算数据并决定是否执行。
- **红色**：达到交接阈值，建议生成九段式交接文档并切换至新会话。

插件直接挂载于现有输入框旁，默认参数已针对 DSH 0.2.x 完成适配，无需改变既有操作流程。

## 核心功能

### 1. 状态可视化监控

指示环按压缩评估逻辑分段显色，分别标识模型或阈值判定的建议压缩点、已锁定消息位置，以及 DSH 原生自动压缩线（按宿主实际 token 预算算出的触发点：deepseek-flash 约 67.8%，配置阈值默认 80%）。当上下文占用越过原生自动压缩线时，整环呈红色闪烁告警。交接提醒线晚于当前模型的实际触发线（−5pp）时，环上交接刻度旁会出现红色小警示，悬停卡与 `/handoff` 菜单也会同步标出「交接线已晚」。

上下文进入「可压缩区间」（最小压缩线到压缩线之间）时，插件会在系统提示里主动告诉模型当前容量与区间，模型据此判断「刚完成一个自然节点」时是否记录压缩节点（0.3.4 起；此前模型看不到容量，判断条件不可执行）。

鼠标悬停可查看详细数值：已用容量、累计压缩次数、当前操作建议、压缩判断点、原生自动压缩线及已锁定消息数量。

### 2. 预览与确认压缩

执行 `/bc` 命令（或通过指示环菜单触发）可预先查看待压缩范围、消息条数及预计释放的容量空间，需经用户二次确认后方才执行。确认前可随时取消，未提交前不会修改任何历史记录；已锁定的消息在压缩时自动跳过。

![压缩预览与确认](assets/compact-preview.jpg)

### 3. 结构化会话交接

执行 `/handoff` 命令可生成包含九个标准部分的交接文档（总体目标、约束条件、已完成项、当前进度、涉及文件、关键决策、已知问题、未完成项、下一步计划），并在当前工作区自动创建新会话、注入该文档并完成切换，原会话完整保留。

### 4. 关键消息锁定

执行 `/pin` 命令可标记压缩时必须保留的消息。被锁定的消息在指示环上显示为品红色块，在菜单列表中显示为锁定行。

![指示环菜单](assets/menu.jpg)

## 指示环图例说明

| 指示环视觉元素 | 状态含义 |
| --- | --- |
| 灰色弧 | 低于最小压缩阈值，不建议压缩 |
| 蓝色弧 | 常规容量区间已满 |
| 琥珀色弧 | 已越过压缩判断点，适合执行压缩 |
| 红色弧 | 已越过交接阈值，建议切换新会话 |
| 环形缺口 | 建议压缩点（系统在可压缩区间主动提示模型判断；模型记录或到达压缩线时自动出现） |
| 紫色刻度 | DSH 原生自动压缩线：按 `min(窗口 × thresholdRatio, 窗口 − 输出预留 − headroomTokens)` 算出的**实际触发点**（deepseek-flash 约 67.8%；`thresholdRatio` 配置默认 80%，只是理论上限） |
| 品红色块 | 已锁定消息在历史记录中的分布位置 |
| 整环红色闪烁 | 已越过原生自动压缩线，即将触发 DSH 原生自动压缩 |

![越过原生自动压缩线](assets/native-alert.jpg)

## 三条线（deepseek-flash 1M 默认）

| 线 | 默认值 | 含义 | 怎么调 |
| --- | --- | --- | --- |
| 压缩提醒线 | 40% | 到线变琥珀色，菜单建议「压缩旧会话」 | 设置 → 压缩接力 |
| 交接提醒线 | 60% | 到线内圆亮红点，菜单建议「交接新会话」 | 设置 → 压缩接力；**硬上限 = 实际触发线 −5pp**（deepseek-flash 下 62%） |
| 原生自动压缩线 | 67.8% | DSH 按 token 预算真正触发自动压缩的点（配置阈值 80% 只是理论上限，deepseek-flash 的输出预留 + DSH 余量把它压到 67.8%） | profile 里 `compaction-basic` 的 `thresholdRatio`（默认 80%） |

**交接线为什么要留 5 个百分点**：交接提醒必须早于 DSH 自己压历史，才有时间生成交接单、开新会话。所以 0.4.2 起交接线有硬上限 **实际触发线 −5pp**（取整到整数百分位；deepseek-flash 1M 窗口下是 62%）：超过时**拒绝保存并提示目标值**，不静默夹紧；已存的高值不会被偷偷改写，但设置页会常驻告警，并可点「按实际线重算」一键改成上限。实际触发线算不出（无会话 / 宿主没给）时不告警、不阻断，保存校验退回配置阈值防呆（与 0.4.1 一致）。

## 安装

**环境要求**：DSH 桌面版或 `dsh web` 0.2.x（已于 0.2.1-rc.2 测试通过），Node.js 22+（插件跟随 DSH 自带运行时）。若要在源码里跑测试，需要 Node **22.15+**（测试脚手架用到 `node:module.registerHooks`）。测试已在 macOS 与 Windows 11（Node 24.22）实测全部通过。

```sh
dsh plugin --profile desktop add dsh-compact-relay
```

桌面版亦可打开 **插件 → 添加插件** 输入包名安装，或直接从 GitHub 安装：

```sh
dsh plugin --profile desktop add github:cfanzx/dsh-compact-relay
```

安装完成后需重启 DSH。插件内部配置项保存后立即生效，无需重启。

## 设置项说明

配置入口位于 **设置 → 压缩接力**（DSH 0.2.1+ 位于账号菜单内）：

- **压缩提示**：配置最小压缩线、压缩提醒线与交接提醒线，控制告警触发时机。
- **压缩行为**：配置摘要保留份数上限、近期原文保留 Token 数及交接文档存储目录。
- **DSH 原生自动压缩**：读取宿主阈值并换算实际触发线，支持开启或关闭 DSH 原生自动压缩（修改 profile 配置前自动生成备份，重启后生效）。
- **颜色与外观**：配置五项基准色，系统将根据浅色/深色主题自动派生适配色阶。
- **帮助**：提供指示环图例、使用说明、问题反馈入口、「再看一次初次引导」按钮，以及「诊断信息」（只在本机生成、可预览/复制，见下节）。
- **关于与危险操作**：查看版本号、配置文件路径，支持恢复出厂默认设置。

![设置页](assets/settings.jpg)

每项配置均附带功能定义与参数修改影响说明；帮助区内置五个动态示例环图例，随当前配色与阈值实时更新。

![指示环图例教学卡片](assets/teaching-card.jpg)

首次打开会话时，指示环将触发动态高亮与简要功能说明（仅自动触发一次，可通过设置页按钮重新调用）。

![首次引导](assets/onboarding.jpg)

## 诊断信息与隐私

设置 → 压缩接力 → **帮助** →「诊断信息」：

- 点【生成并预览】：**只在本机**生成一份 Markdown + JSON 诊断信息，先弹层预览；再点【复制 Markdown】/【复制 JSON】复制，自己决定粘贴到哪（例如 GitHub issue）。
- 点【打开问题报告页】：打开预填了版本/平台短字段的 GitHub issue 页，**不会**把诊断信息直接贴进去——是否粘贴、粘贴什么由你决定。

**诊断包里有什么**：插件版本、DSH 版本（拿不到就留空）、Node / 操作系统 / 架构 / 语言环境；配置的阈值、保留量、超时与颜色模式；当前状态的数值摘要（窗口、已用、摘要数、锁定数等）；本次加载后的压缩/交接/锁定计数、耗时 p50/p95，以及最近 20 条错误码。

**绝不包含**：聊天内容、摘要、交接单正文、工具参数/结果、文件路径、用户名、hostname、会话 id、密钥/token/cookie、其他插件清单或自定义链接。产物在宿主进程内按白名单逐字段构造，并额外做一遍正则脱敏（命中只替换为 `[REDACTED]`、只记数量，不保留原文）。

**三条隐私说明**：

1. 诊断信息**只在本机生成**：插件没有任何自动上传、遥测或外发网络请求；诊断端点只提供只读 GET，没有上传通道。
2. **不碰对话内容**：只采集数值、枚举、布尔与错误码，不读取消息、摘要或交接单正文。
3. 打开 issue 页只是打开浏览器；issue 默认公开，是否粘贴、粘贴到哪由你决定。插件不加网络能力，也不会上报任何数据。

## 命令列表

| 命令 | 功能说明 |
| --- | --- |
| `/bc` | 预览压缩：显示目标范围、消息条数及预计释放容量 |
| `/bc confirm` | 执行已预览的压缩操作 |
| `/handoff` | 生成九段式交接文档并创建、切换至新会话 |
| `/pin` / `/unpin` | 锁定或解锁指定消息，锁定后跳过压缩 |
| `/bctest` | 小范围空跑测试（仅供开发调试） |

## 功能边界与限制

- **不替代 DSH 原生压缩机制**：原生压缩仍由 DSH 宿主控制；本插件仅负责读取阈值、显示告警并在设置页提供开关选项。
- **不篡改提示词与模型回复**：插件仅在用户明确确认压缩或执行交接时替换对应历史记录。
- **摘要质量取决于底层模型**：摘要生成采用九段式结构化模板并包含格式校验与单次重试机制，但最终产出质量仍受限于所选模型的能力。
- **纯本地存储**：插件状态保存于 `~/.dsh/compact-relay.json`，交接文档保存于 `~/.dsh/handoffs/`，无任何外部数据同步。
- **依附桌面输入框**：环形指示器、`/bc`、`/handoff` 依附 DSH 的输入框与斜杠命令；headless 会话或 QQ / 微信等桥接链路不会加载它们，在这些链路里发 `/bc` 会被当成普通消息——这是桥接链路的能力边界，不是插件故障。
- **界面语言限制**：当前版本用户界面仅提供简体中文，英文界面已列入后续计划（排期未定）。
- **模型判断提示的前置**：可压缩区间的动态提示依赖 DSH 0.2.x 的根服务 `systemPrompt`（与 memory 等插件同款）；它是启发式提示，不保证模型每次都会记录压缩节点，但条件从「不可判断」变成「可判断」。

## 版本状态与开源许可

- **当前版本**：0.4.2（0.3.1 为首个公开版本；0.3.2 修正设置页链接与联系方式；0.3.3 完成 Windows 适配；0.3.4 修复判断机制并补交接单渲染；0.3.5 修无活 agent 时压缩按钮误禁；0.3.6 修原生压缩线解析作用域（BUG-012）；**0.4.0** 判断机制加强（cue 文案 v2 + 注入门控 + 计量）、诊断包（脱敏诊断信息，一键复制/预览）、压缩预览建议锁定、pin 保留契约、轻账本累计、交接预览两段可编辑、接力链元数据、原生自动压缩真实触发线；**0.4.1** 统一原生压缩线显示口径：指示灯 / 设置页 / 教学卡都显示实际触发点，并注明配置阈值与输出预留；**0.4.2** 交接线保命补丁：硬上限 = 实际触发线 −5pp（UI 与后台同口径，超限拒绝保存并给目标值）、三处告警 + 一键重算、换模型后一次性提示，文档写清 40/60/67.8 三条线）。已在 macOS（DSH 0.2.1-rc.2）与 Windows 11（Node 24.22）完成测试，仅调用 DSH 公开导出接口。变更记录详见 [CHANGELOG.md](CHANGELOG.md)，后续规划与已知限制详见 [ROADMAP.md](ROADMAP.md)，构建与发布流程详见 [DEVELOPMENT.md](https://github.com/cfanzx/dsh-compact-relay/blob/main/DEVELOPMENT.md)。
- **开源许可**：采用 [MIT](LICENSE) 许可证，欢迎通过 [GitHub Issues](https://github.com/cfanzx/dsh-compact-relay/issues) 与 Pull Requests 提交反馈。

## 参考与致谢

本插件的设计参考了以下 DSH 社区插件与项目的公开实现（仅借鉴思路，未复制代码）：

- [DeepSeek Harness](https://www.deepseek.com/harness/) — 插件运行的宿主平台；本插件的全部宿主能力均来自其公开导出接口。
- [dsh-clear-mind](https://github.com/john-walks-slow/dsh-clear-mind) (MIT) — 自建替换事务与边界/锁检查的写法参照。
- [dsh-handoff-compaction](https://github.com/knighthongyu/dsh-handoff-compaction) (MIT) — 摘要结构校验、重试与缓存对齐。
- [dsh-compaction-policy](https://github.com/zyd232/dsh-compaction-policy) (MIT) — preset 作用域引擎的运行时门控思路。
- [context-vista](https://github.com/GooodWei/context-vista) (MIT) — 环形图绘制与 session projections 实时订阅。
- [dsh-session-handoff](https://github.com/WeiYe6/dsh-session-handoff) (MIT) — `/handoff` 建会话与自动切换流程。
- [dsh-smart-compact](https://github.com/hoyyang/dsh-smart-compact) (BSD-3-Clause) — 预算测量与交接锚点设计。
- [dsh-toolong-warning](https://github.com/Hjdd14/dsh-toolong-warning) (MIT) — 压缩计数与提醒。
- [dsh-compaction-instant](https://github.com/TsFreddie/dsh-compaction-instant) (MIT) — 事务错误分类契约。
- [dsh-plugin-memory](https://github.com/LittleBlackTong/dsh-plugin-memory) — 设置栏在 DSH 中的注册与渲染方式参考。
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) / [dsh-market](https://github.com/dsh-market/dsh-market) — 社区插件目录与可视化市场。

感谢以上作者公开实现；也感谢所有帮忙测试、提反馈的朋友。

## 联系方式

- **官方渠道**：GitHub 仓库 <https://github.com/cfanzx/dsh-compact-relay> 与 [Issues](https://github.com/cfanzx/dsh-compact-relay/issues)（问题反馈、功能建议、发布公告）。
- **开发者邮箱**：cfanzx@136.com（合作、安全问题，以及其他不便公开讨论的事项）。
