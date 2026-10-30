# 接力条不显示 —— 真机取证与判读（0.5.6-C）

> 面向：在 Win（或任何机器）上复现「交接完成自动进入新会话，输入卡上方应有
> 一行『已接力自 历史 N：原名 ▾』，实际没有」的人。
> 本文给出**一次采集定因**的表达式 + 判读表，以及 0.5.6-C 已落地/仍未落地的部分。
>
> 结论先行：0.5.6-C 修掉了一条**可复现的渲染崩溃**（下面成因 C），并给 A1/A2 类
> 加了磁盘兜底与诊断位；但 Win 上实际命中的是哪一条，仍要真机跑一次 §2 的表达式回填。
> **本轮不假装根治。**

## 0. 0.5.6-C 改了什么（读这段就够判断）

数据流（0.5.5 → 0.5.6-C）：

```
state（readState，只认内存）→ chain=null
   ├─ 0.5.6-C：state.hasParent === true（有父会话但没链）→ GET /api/compact-relay-chain（读磁盘）
   │              → rows[0] 合成入站 chain → 接力条
   ├─ 0.5.6-C：state 连续 12 次认不出本会话（sessionId≠自己）→ 同样走一次整链端点
   └─ hasParent === false 的普通会话 → 零额外请求（不读整份日志）
```

- **服务端**：`readState` 新增只读布尔 `hasParent`（`true` / `false` / `null`）。
  `null` = 没有 target（宿主没加载本会话，不知道）；口径与 `legacyChainParentIdOf`
  完全一致（`header.parentSession` 非空，且不是 subagent、不是 fork）。**零 IO**。
- **客户端兜底**：只在上面两条路径调用 0.5.1 已有的 `/api/compact-relay-chain`
  （读持久化、不要求会话 live），用 `rows[0]` 合成入站 chain；
  **每个会话只读一次盘**（换会话重置），静默刷新/重试不会重复读。
- **诊断位**（零布局影响、零请求，挂在 `<html>` 上）：
  - `document.documentElement.dataset.crRelayDock` → `'1'` = 接力条组件真的挂载并跑过 effect；
  - `...crRelayChain` → `'<ordinal>'` 或 `'none'`（当前有没有链）；
  - `...crRelayState` → 服务端 `readState` 认的 sessionId，或 `'null'`（没加载）。
- **指示灯**：`[data-cr-level]` 新增 `data-cr-chain`（服务端链号或空串），
  与 `crRelayChain` 同口径 —— 一眼看出「指示灯和接力条是不是同一份判断」。
- **修掉成因 C（可复现的渲染崩溃）**：0.5.2 起，接力条组件把 3 个 `useCallback`
  写在「两个方向都没有 → `return null`」**之后**。首帧没有链时少调用 3 个 hook，
  链路到达的下一帧却多调用 3 个 → React 抛
  `Rendered more hooks than during the previous render.` → 宿主 `SlotErrorBoundary`
  捕获并 **abdicate** 这个 dock 条目 → 该会话里接力条**永久**不显示（刷新也不回来）。
  0.5.6-C 已把 hook 调用全部提到提前 return 之前；测试里加了静态回归锁
  （`test/relay-bar.mjs` 的 C10：提前 return 之后不得再出现 hook 调用）。

## 1. 三种尚未排除的成因（判读表就是用来分开它们）

| 编号 | 成因 | 表现 | 诊断位特征 |
| --- | --- | --- | --- |
| **A1** | 服务端认为没有链（`target` 有、`chain=null`） | 无条 | `crRelayDock=1`、`crRelayChain=none`、`crRelayState=自己` |
| **A2** | `readState` 拿不到 target（宿主没把会话装进内存）→ `sessionId:null`、`chain:null` | 无条，0.5.6-C 前重试 12 次后静默放弃 | `crRelayDock=1`、`crRelayChain=none`、`crRelayState=null` |
| **B3** | dock 整块没渲染（宿主 `zone===undefined` / 宿主版本没有这个 slot） | 无条，组件连 effect 都没跑 | `crRelayDock` **缺失**（undefined） |
| **C** | 组件渲染崩过 → 宿主 abdicate（0.5.2–0.5.5 的 hooks 顺序违约就是这一条） | 无条，刷新依旧 | `crRelayDock` **缺失**，且 DOM 里有 `<div data-slot-error="conversation.input.dock">` |

> 0.5.6-C 之后，A1/A2 应被磁盘兜底救回（只要 `/api/compact-relay-chain` 能读到）；
> 所以「`crRelayDock=1` 但 `crRelayChain=none`」的下一步是看 §2 步骤 2 的
> `chain.ok / chain.rows / chain.unreadable` —— 那说明**磁盘上也读不到**（父会话已删除 /
> 日志没落盘 / 宿主没有 sessionPersistence）。

## 2. 真机取证步骤（Win，一次采集把成因分开）

> 前提：0.5.6-C dev 包已装到 Win，且**至少复现过一次**「交接后无条」。
> 以下都在那个会话里执行（F12 → Console）。

### 步骤 1（一条表达式，先定性）

```js
(() => {
  const ds = document.documentElement.dataset;
  const ind = document.querySelector('[data-cr-level]')?.dataset ?? {};
  return {
    dockMounted: ds.crRelayDock ?? null,        // '1' = 接力条组件确实挂载并跑过 effect
    chainAttr: ds.crRelayChain ?? null,         // '<ordinal>' 或 'none'
    stateSession: ds.crRelayState ?? null,      // 服务端 readState 认的会话 id（或 'null'）
    barInDom: !!document.querySelector('[data-cr-relay-root]'),
    entryCrashed: !!document.querySelector('[data-slot-error="conversation.input.dock"]'),
    indicator: { injected: ind.crSession, state: ind.crStateSession, source: ind.crSource, chain: ind.crChain },
    hostUrl: location.origin,
  };
})()
```

### 步骤 2（服务端投影原文）

```js
const id = (document.querySelector('[data-cr-level]')?.dataset.crSession) || location.pathname.split('/').filter(Boolean).pop();
const state = await (await fetch(`/api/compact-relay-state?sessionId=${encodeURIComponent(id)}`)).json();
const chain = await (await fetch(`/api/compact-relay-chain?sessionId=${encodeURIComponent(id)}`)).json();
({ id, stateSession: state.sessionId, chain: state.chain, next: state.next, hasParent: state.hasParent,
   serverRows: chain.ok ? chain.rows : chain, chainOk: chain.ok, unreadable: chain.unreadable });
```

### 步骤 3（若 `entryCrashed:true`）

Console 里搜 `slot entry crashed in 'conversation.input.dock'`，把紧随其后的
error 文本/堆栈整段贴回（崩溃点只能按堆栈修，不能靠猜）。

### 判读表（拿到步骤 1 就能定因）

| dockMounted | chainAttr | stateSession | barInDom | entryCrashed | 结论 | 下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| `1` | `1` | 自己 | true | false | 其实是渲染了的（观感/布局问题） | 截图看宽度/高度，另开 UI 项 |
| `1` | `none` | 自己 | false | false | **A1**：服务端认为无链；兜底也没拿到 | 看步骤 2 的 `chain/rows/unreadable`（磁盘也读不到） |
| `1` | `none` | `null` | false | false | **A2**：宿主没加载该会话；兜底也没拿到 | 看步骤 2 的 `chain/rows`；若 `unsupported` = 宿主没有 sessionPersistence |
| 缺失（undefined） | — | — | false | **true** | **C**：组件崩过被宿主下线 | 要步骤 3 的 error 文本；0.5.6-C 已修已知的一条（hooks 顺序），若仍崩是新崩溃点 |
| 缺失（undefined） | — | — | false | false | **B3**：dock 没挂载（`zone===undefined` 或宿主版本没有这个 slot） | 记录 Win 的 DSH 版本 + 该会话是否 hero/输入态就绪 |

## 3. 已排除的假设（别再重复查）

- **记录形状 / 服务端投影 / 客户端判据**：Mac 侧用真实会话日志重放
  `readState` → `chain` 六字段，再按客户端判据复算，通过（见任务 2 计划 §2.4）。
- **0.5.5 的 CSS**：只改了助手动作行（`[data-actions-reveal="hover"]` 根）的星标
  常亮规则，不可能命中输入卡上方的 dock 行。
- **dock 的 sessionId 作用域**：宿主契约表写明 dock 是 session 作用域，`inject` 拿的就是
  binding.key；作用域缺失会直接抛 `SlotAssemblyError`，不会静默无条。

## 4. 本地（Mac/CI）能复现的部分

```sh
node test/relay-bar.mjs        # C5–C10：兜底/不读盘/老宿主/诊断位/hooks 顺序回归锁
node test/state-passive.mjs    # 4b：hasParent 的 header 口径（true/false/null）
node test/contract-golden.mjs  # 6 场景键集合 + 结构快照（含 hasParent）
```

真机仍缺的只有一件事：**Win 上命中的是 A1 / A2 / B3 / C 里的哪一条**。
拿到 §2 步骤 1（必要时 + 步骤 2/3）即可回填判读表，再决定是否追加修复。
