# 给 DSH 上游的反馈 / 客制化需求清单

> 用途：把做 dsh-compact-relay 时遇到的「DSH 侧缺口」攒在这里，项目收尾时统一整理成给
> DeepSeek Harness 团队的反馈（功能请求 / 接缝建议 / 文档澄清）。不是在抱怨，每一条都带证据和期望形态。
>
> 观测基线：DeepSeek Harness 桌面版 **0.2.1-rc.2**（macOS）。
> 证据来源：app.asar 内的包源码 / 运行时实测；引用包名 + 文件级位置，不贴大段源码。
>
> 收录规则：一条一个需求；写清「现状 → 我们的需求 → 期望接口形态 → 影响面 → 临时替代方案」。
> 只在**确实影响第三方插件实现**时收录，DSH 内部设计取舍不评。

---

## 1. 上下文占用组件（ContextMeter）没有给第三方动作留插槽

**现状（证据）**
- 输入框右下的「上下文已用 xx%」圆环 + 弹窗由 `@deepseek-ai/dsh-client-ui-conversation` 内部组件 `ContextMeter` 渲染，位置在 composer dock 行（源码里 `renderSlot("conversation.composer.dock", {})` 之后直接挂 `<ContextMeter/>`）。
- `ContextMeter` 的弹窗内容（标题、占用条、系统提示词/工具定义/对话消息三行明细）是写死的；它没有声明任何子插槽，第三方插件无法在它的弹窗里加内容。
- 同一行有公开插槽 `conversation.composer.dock`，但只能在它**左边并排**，无法进入弹窗、也无法替换/扩展它的行为。
- 数据侧是好的：官方已经用 `useProjection("contextPressure")` / `useProjection("contextBreakdown")` 做实时投影，第三方若拿到同一套 projection 也能实时读（这条没问题，只卡 UI 插槽）。
- **实测补充（2026-10-19）**：第三方 slot（`conversation.input.left`）里的组件**拿不到 `useProjection`**（它只对官方会话内的组件注入）。所以数据侧也得自己走宿主推送，没法直接复用官方投影。

**我们的需求（客制化）**
第三方插件希望把自己的动作挂到官方「上下文」组件上，而不是再画一个自己的控件，造成同一个角落两个指示灯。对 dsh-compact-relay 具体是：
- 弹窗里加一行/一个按钮组：「精压」（不二压的压缩）、「接棒」（写交接文档换新会话）、以及「阶段完成」标记的显示；
- 或至少让第三方把自己的小控件注入到 ContextMeter 的弹窗里，复用它的定位/弹层/小时常组件。

**期望接口形态（任一）**
1. `ContextMeter` 弹窗声明一个公开插槽，例如 `conversation.composer.context`（list 或 single），第三方 `ctx.slots.register` 后渲染在弹窗底部分隔线之后；
2. 把 `ContextMeter` 本身改成 slot 组件（默认实现保持现状），第三方可按 priority 覆盖/包一层；
3. 或者给 `conversation.composer.dock` 的条目提供「与 ContextMeter 同一簇」的样式/位置约定（次优，但成本低）。

**影响面**
- 所有「需要在上下文附近放压缩/记忆/会话管理动作」的第三方插件都会撞到同一面墙：要么自绘一个重复控件，要么做 DOM hack（升级即碎）。
- 我们目前的临时替代：自绘指示灯挂在 `conversation.input.left`（输入框左侧），数据走自家 SSE 推送；视觉上和官方「上下文已用 xx%」不在同一处，能力也不互通——同一个角落两个指示灯。

**临时替代方案（已落地）**
- 自绘指示灯（`conversation.input.left`）+ 自家 SSE 实时推送（宿主订阅 `session/event`，客户端 `EventSource`）；
- 不 hack DOM、不改官方包（app.asar 只读，改一次 DSH 升级就重打一次补丁）。

**收尾状态**：条目已定型，可直接作为上游反馈提交（对应实现见本仓库 README / HANDOFF）。
