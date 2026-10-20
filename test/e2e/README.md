# test/e2e —— M3 接棒验证用端到端测试台

一条命令把「真实 DSH 的隔离复刻 + Chrome 驱动 GUI 新建 live 会话 + 插件 host 侧取证」跑通，
额外能力：`--keep` 保留现场，供 M3 接棒（`/handoff` / HTTP action）做端到端验证。

**不跑模型、不花钱、不碰真 DSH**：点「新建会话」只会创建一个 blank session + live agent
（`session/list` 里 `blank:true, agentAvailable:true`），不会触发任何 LLM 调用。

---

## 1. 前置条件

| 依赖 | 说明 |
|---|---|
| macOS + DSH 桌面版 | 本机 `/Applications/DeepSeek Harness.app`，实测 0.2.1-rc.2 |
| node >= 22 | 需要原生 `fetch` / `WebSocket`。本机用 `~/.local/node/bin/node`（v24） |
| login-web 专用 Chrome | 带 `--remote-debugging-port=9222` 运行中（只借它开新 tab，不动用户已有 tab） |
| pnpm | 通过 `corepack pnpm`（node 自带）或 app 内 `pnpm.mjs`；首次跑会复用本机 pnpm store |

`~/.dsh` 只读；rsync 到 `/tmp/relay-e2e/home/.dsh`（排除 `login-browser-profile`、
`dsh_wechat`、`homeassistant`、`qwen-chat`、`wb-market`，约 780MB）。

---

## 2. 快速开始

```bash
cd ~/.dsh/vendor/dsh-compact-relay

# 全流程 + 清理，退出码 0/1（当前 M2 代码实测 PASS，约 15s）
~/.local/node/bin/node test/e2e/smoke.mjs

# 保留现场（给 M3 用）：host 和 tab 都不关，打印机器可读 E2E_RESULT
~/.local/node/bin/node test/e2e/smoke.mjs --keep

# 代码改过、想快速重跑：复用隔离 home（仍会 pnpm install 同步 vendor 最新代码，约 5s）
~/.local/node/bin/node test/e2e/smoke.mjs --reuse --keep

# 收掉 --keep 留下的现场（只杀命令行带隔离 profile 路径的 host、只关自己的 tab）
~/.local/node/bin/node test/e2e/smoke.mjs --kill
# 连 /tmp/relay-e2e/home 一起删
~/.local/node/bin/node test/e2e/smoke.mjs --kill --purge
```

实测耗时（本机 M2）：首次 rsync 8–10s、boot 1–2s、GUI 1s、新建会话 0.2–3s，整轮约 15s
（`--reuse` 约 5s，`--keep` 不清理）。

### 成功输出长这样

```
PASS  e2e smoke：隔离 DSH + GUI 新建 live 会话 + 插件 state/action 联通
  host      : http://127.0.0.1:50545/?token=...
  session   : session-79383ac4-...
  cwd       : <你的工作区绝对路径>
  blank     : true   agentAvailable: true
  state     : sessionId=session-79383ac4-... pressure=0 advice=none
  action    : HTTP 400（未知动作；说明端点可达、pickAgent 找得到 agent）
```

---

## 2.5 真实压缩 e2e（会花钱，按需跑）

`real-compact.mjs` 验证「真实模型调用 + 真实压缩事务 + P2-T1 旧摘要合并」：

```bash
# 首次约 20s；用隔离 home 里的凭据真调模型（4 轮短消息 + 2 次压缩摘要，几分钱量级）
~/.local/node/bin/node test/e2e/real-compact.mjs

# 复用隔离 home / 代码没改（更快）
~/.local/node/bin/node test/e2e/real-compact.mjs --reuse --no-install
```

流程与判据：
1. 隔离 `compact-relay.json`（只写隔离 home）：`retention.recentTailTokens=120`、`thresholds.maxSummaries=1`；
2. GUI 发消息攒历史，直到 `state.compactRange.tokens ≥ 700`（等每条回复真正生成完）；
3. 第一次 `/compact`：断言「压缩完成」、`summaries` 0→1、pressure 下降、可压范围被替换；
4. 再攒 ≥400 tokens → 第二次 `/compact`：`maxSummaries=1` 让 `allowMergeOldSummaries=true`，断言提示带「同时合并了旧摘要」、`summaries` 记 +1（它是历史压缩次数口径，合并不减少）。

排错经验：**别用 `pressure` 增长当「模型回复结束」的判据**——用户消息一进 surface，pressure 就已经涨了；此时发起压缩会 409「正在回复中」。要等 GUI 页面文本连续稳定（脚本里的 `waitReplyDone`）。

## 3. 它到底做了什么（6 步）

1. **准备隔离 home**：`rsync -a` 真 `~/.dsh` → `/tmp/relay-e2e/home/.dsh`（排除大目录）。
2. **裁剪 profile + 同步代码**：把隔离 profile 的 `dsh.profile.bundles` 改成只有
   `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-compact-relay`（避开
   wechat/mizar/whale 等插件副作用）；然后 `pnpm install` 把
   `file:~/.dsh/vendor/dsh-compact-relay` 的最新代码拷进隔离 `node_modules`。
3. **boot host**：用与真 host **逐字相同**的 desktop-host 命令行启动（`ELECTRON_RUN_AS_NODE=1`、
   `DSH_HOME=<隔离 home>`、`--expose-internals` + 5 个位置参数），从 stderr 解析
   `dsh web: http://127.0.0.1:PORT/?token=...`，再等 `GET /api/compact-relay-state` 返回 200
   （= 插件真的激活了，命令/路由都注册了）。
4. **开 GUI**：Chrome CDP `PUT /json/new?<url>` 新建**自己的 tab**，连 page WebSocket，
   开 Page/Runtime/Network 域，等侧栏「新会话」出现。
5. **新建 live 会话**：点 aria-label 为 `在“<工作区标题>”中新建会话` 的按钮（默认
   `默认工作区`，可用 `--workspace` 改）。点击会发 `POST /api/session/create`；
   harness 从 CDP Network 里抓这个**不带 sessionId 的 create 请求**的响应，取
   `result.value.sessionId`——这就是本次新建的 live session id（比解析 DOM 稳）。
6. **host 侧取证**：
   - `GET /api/compact-relay-state?sessionId=<id>` 返回同一 id（插件 `agents.get` 看得到 agent）；
   - `POST /api/compact-relay-action {"action":"e2e-probe","sessionId":...}` 预期 HTTP 400
     「未知动作」——说明动作端点可达、`pickAgent` 找得到 agent，且**没有任何副作用**。

清理（默认）：杀隔离 host 进程组 → 关自己的 tab → 删隔离 home；日志保留在
`/tmp/relay-e2e/logs/`。

---

## 4. 选项

| 选项 | 作用 |
|---|---|
| `--keep` | 成功后保留 host + tab（失败也保留现场），打印 `E2E_RESULT` 一行 JSON，写 `/tmp/relay-e2e/keep.json` |
| `--reuse` | 复用已有隔离 home（跳过 rsync），仍会 `pnpm install` 同步 vendor 最新代码 |
| `--no-install` | 跳过 `pnpm install`（仅供调试；可能测到旧代码） |
| `--workspace <标题>` | 在哪个工作区新建会话，默认「默认工作区」（也可 `E2E_WORKSPACE_TITLE` 环境变量）；标题不存在时自动退回任意可用工作区并告警 |
| `--timeout <秒>` | boot 等 `dsh web:` 的超时，默认 120 |
| `--kill [--purge]` | 收掉 `--keep` 现场；`--purge` 连隔离 home 一起删 |
| `--help` | 帮助 |

---

## 5. --keep 交接：给 M3 用

`--keep` 成功后在 stdout 末尾打印**一行**机器可读 JSON（同时落盘 `keep.json`）：

```
E2E_RESULT {"ok":true,"sessionId":"session-...","sessionCwd":"/Users/.../default-workspace",
  "sessionBlank":true,"sessionAgentAvailable":true,"workspaceTitle":"默认工作区",
  "clickedAriaLabel":"在“默认工作区”中新建会话","tabId":"...","state":{...},
  "actionProbe":{"status":400,...},"baseUrl":"http://127.0.0.1:PORT","url":"http://127.0.0.1:PORT/?token=...",
  "port":PORT,"token":"...","chromePort":9222,"hostPid":12345,
  "hostLog":"/tmp/relay-e2e/logs/host.log","home":"/tmp/relay-e2e/home/.dsh",
  "keepJson":"/tmp/relay-e2e/keep.json","elapsedMs":9595}
```

关键字段：`sessionId`（M3 用）、`baseUrl`/`port`/`token`（host 地址）、`hostPid`、
`tabId`（收尾用）、`home`（隔离 `~/.dsh`）。

> ⚠ **再跑一次 smoke（带不带 `--keep`）会先清理上一次同路径的残留 host**（含上一个
> `--keep` 的 host，`startHost` 启动前会扫描并杀掉命令行带
> `/tmp/relay-e2e/home/.dsh/profiles/desktop` 的进程），然后按本次结果重写 `keep.json`。
> 也就是说「同一时间只有一个隔离测试台」；要保留旧现场先别跑新 smoke。真 DSH（pid 24386）
> 与其它路径的 host 不受影响。

### 5.1 调插件动作（M3 端到端）

```bash
# 查状态（pressure / advice / busy / stage / sessionId）
~/.local/node/bin/node test/e2e/action.mjs state --session <id>

# 触发接棒（M3 实现好之后）；会 POST /api/compact-relay-action
~/.local/node/bin/node test/e2e/action.mjs handoff --session <id>

# 触发精压（空会话安全，返回「没有可安全压缩的范围」）
~/.local/node/bin/node test/e2e/action.mjs compact --session <id>

# 等价 curl（2026-10-20 起插件端点与宿主 /api 同鉴权：先 /connect 换 cookie）
# COOKIE=$(curl -si "http://127.0.0.1:<PORT>/connect?token=<TOKEN>&interactions=none" | sed -n 's/^set-cookie: \([^;]*\).*/\1/ip')
curl -s -X POST "http://127.0.0.1:<PORT>/api/compact-relay-action" \
  -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d '{"action":"handoff","sessionId":"<id>"}'
```

> ⚠ 建议**显式传 `sessionId`**（`action.mjs` 默认从 `keep.json` 取）：M2 版 `pickAgent`
> 枚举不到 agents，不传 sessionId 时 HTTP 409；M3 修复后可不传，但显式传不依赖版本、更稳。

### 5.2 检查 M3 结果

隔离 home 的落盘位置（按 M3 实现来查）：

```bash
# 新建出来的会话目录（子会话、新 session 都会出现在这里）
ls -lt /tmp/relay-e2e/home/.dsh/sessions/*/ | head
cat /tmp/relay-e2e/home/.dsh/sessions/*/<sessionId>/...

# 接棒文件（具体位置看 M3 实现，通常在会话 cwd 或隔离 home 下）
find /tmp/relay-e2e/home/.dsh -name 'handoff-*.md' -newermt '-10 minutes'
```

也可以在 Node 里直接复用库：

```js
import * as e2e from './test/e2e/lib.mjs';
const host = await e2e.startHost({ timeoutMs: 120_000 });     // 假定 prepareEnv 已跑过
const driver = await e2e.openGui(host.url, { host });
const { sessionId } = await e2e.newSession(driver);
await e2e.stateGet(host, sessionId);
const res = await e2e.actionPost(host, 'handoff', { sessionId });
await e2e.listSessions(driver);                                // 页面内带鉴权调 session/list
await e2e.stop(host, driver);
```

---

## 6. 坑（都是实测踩出来的）

1. **不带 `sessionId` 的 state/action 端点：版本相关。**
   M2 版的 `pickAgent` 用 `agents.values()`，而 DSH 0.2 的 `ctx.agents` 只有 `get(id)` / `list()` →
   枚举为空，`GET /api/compact-relay-state` 恒返回 `sessionId:null`、action 恒 409，
   客户端指示灯也一直显示「上下文压力未知」。M3 已改成兼容 `agents.list()`（本机 18:31 后版本可枚举）。
   harness 不依赖这个行为：host 侧取证和 M3 的 HTTP action **都显式传 sessionId**，新旧版都稳。
2. **sessionId 不要从 DOM 猜**：从 CDP 抓 `POST /api/session/create`（请求体**不带** sessionId 的那次）
   的响应最稳。页面加载时还会自动「恢复上次会话」——那是一次带 sessionId 的 create，harness 会忽略；
   如果 WebSocket 掉了，还有 `session/list` 前后对比兜底。
3. **app.asar 里的路径是虚拟路径**：`/Applications/.../app.asar/dsh/...` 用 shell/普通 node
   `ls`/`existsSync` 会报 `Not a directory`，只有 Electron 的 asar 补丁能解析。所以脚本不检查
   `HOST_ENTRY` 是否存在；报「找不到」时先怀疑 app 路径变了。
4. **boot 日志是唯一端口来源**：端口随机，`dsh web: http://127.0.0.1:PORT/?token=...` 打在 stderr。
   日志在 `/tmp/relay-e2e/logs/host.log`；插件没激活时会在这里看到
   `pending (waiting for service: ...)` / `N entries did not activate`。
5. **rsync 可能报 23/24**：真 `~/.dsh` 正被当前会话写入，复制中源文件消失属正常竞态；
   脚本已容忍这两个退出码。要干净复制就先别在 DSH 里说话（不现实，忽略即可）。
6. **`--reuse` 能同步最新代码**：pnpm 对 `file:` 目录依赖会在 install 时自动重拷（实测），
   所以 Lead 改完 `lib/` 后 `--reuse --keep` 就是新代码，不用删 lockfile/`--force`。
7. **Chrome 里可能有别人的 tab**：`/json/list` 里除我们的 tab 外，可能有 Lead 开的页面或
   Chrome 内部的 `chrome://omnibox-popup` target。harness 只新建自己的 tab、只关
   `keep.json` 里记录的 `targetId`，不要手动去关别的。
8. **不要动真 DSH**：绝不要 kill pid 24386 / GUI；`--kill` 与 cleanup 只匹配命令行里带
   `/tmp/relay-e2e/home/.dsh/profiles/desktop` 的进程，真 host 是 `~/.dsh/profiles/desktop`，不会误杀。
9. **隔离 home 里会看到真会话列表**：`sessions/`、`storages/` 是复制来的，GUI 侧栏显示的
   历史会话只是只读副本；新建的 live agent 属于隔离 host，和真 DSH 互不影响。
10. **macOS 权限/弹窗**：从终端 spawn `DeepSeek Harness` 可执行文件一般无需授权；Chrome CDP 是
    纯 HTTP/WS，不会弹权限。若公司管控拦了 9222，会直接报「连不上 Chrome CDP」。
11. **别拿它验证 `--keep` 之外的清理**：默认跑完会删掉隔离 home（~800MB），只留日志；
    想保留现场务必 `--keep`。
12. **M3 handoff 可能真调 LLM**：`POST handoff` 是否花钱取决于 M3 实现；在隔离 home 里跑，
    历史/文件都是副本，但**模型调用是真实的**。compact 在空会话上不会调 LLM（已实测返回范围错误）。

---

## 7. 安全边界（实现保证）

- 只写：`/tmp/relay-e2e/**`、仓库 `test/e2e/**`（`assertSafeIsolatedPath()` 会拒绝其它路径）。
- 真 `~/.dsh` 只通过 `rsync` 读取；真 profile 的 `package.json` 不改。
- host 进程 `detached: true` 独立进程组；停止时先 `SIGTERM` 整组、5s 后 `SIGKILL`，并扫一遍隔离残留。
- Chrome tab 记录 `targetId`，close 只关它；CDP 连接 5s 超时，失败不阻塞。
- 所有等待都有超时（boot 120s / GUI 45s / 新会话 30s / 状态 10s / action 180s），失败打印诊断后退出码 1。

---

## 8. 文件

| 文件 | 作用 |
|---|---|
| `lib.mjs` | 核心库：`prepareEnv` / `startHost` / `openGui` / `newSession` / `stateGet` / `actionPost` / `listSessions` / `stop` / `killKept` |
| `smoke.mjs` | 一条命令跑完整 e2e（默认清理），`--keep` 交接，`--kill` 收尾 |
| `action.mjs` | 对 `--keep` 的 host 手动调 `state` / `handoff` / `compact` |
| `README.md` | 本文件 |

临时产物：

```
/tmp/relay-e2e/
├─ home/.dsh/          # 隔离 home（默认跑完删除，--keep 保留）
├─ logs/host.log       # 隔离 host 的 stdout+stderr（boot 失败先看它）
├─ logs/pnpm-install.log
└─ keep.json           # --keep 的交接信息（--kill 后删除）
```
