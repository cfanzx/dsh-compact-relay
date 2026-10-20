#!/usr/bin/env node
/**
 * dsh-compact-relay e2e smoke —— 一条命令跑完整流程：
 *
 *   复制隔离 home → 裁剪 profile bundles → pnpm install（同步 vendor 最新代码）
 *   → boot 隔离 DSH desktop-host → Chrome CDP 开新 tab 打开 GUI
 *   → 点「新建会话」建 blank live session（网络取证 sessionId）
 *   → host 侧 GET /api/compact-relay-state?sessionId= 确认插件看得见 live agent
 *   → POST /api/compact-relay-action 确认动作端点可达（无副作用）
 *   → PASS/FAIL → 清理（杀 host、关自己的 tab、删隔离 home）
 *
 * 用法（用 node >= 22，本机是 ~/.local/node/bin/node）：
 *
 *   node test/e2e/smoke.mjs                 # 全流程 + 清理，退出码 0/1
 *   node test/e2e/smoke.mjs --keep          # 成功后保留 host + tab，打印 E2E_RESULT
 *   node test/e2e/smoke.mjs --reuse         # 复用上次的隔离 home（仍会 pnpm install 同步代码）
 *   node test/e2e/smoke.mjs --no-install    # 跳过 pnpm install（调试用）
 *   node test/e2e/smoke.mjs --workspace 默认工作区
 *   node test/e2e/smoke.mjs --kill [--purge] # 收掉 --keep 留下的 host + tab（--purge 连 home 一起删）
 *
 * --keep 成功后会单独打印一行机器可读 JSON：
 *   E2E_RESULT {"ok":true,"baseUrl":"http://127.0.0.1:49628",...}
 * 同时写 /tmp/relay-e2e/keep.json，供 action.mjs / 后续 M3 端到端使用。
 */

import { parseArgs } from 'node:util';
import * as e2e from './lib.mjs';

const HELP = `dsh-compact-relay e2e smoke

用法：
  node test/e2e/smoke.mjs [选项]

选项：
  --keep                 成功后保留隔离 host 和 Chrome tab，打印 E2E_RESULT 机器可读 JSON
  --reuse                复用已有隔离 home（跳过 rsync；仍会跑 pnpm install 同步 vendor 最新代码）
  --no-install           跳过 pnpm install（调试用，代码可能与 vendor 不同步）
  --workspace <标题>     在哪个工作区新建会话（默认「默认工作区」，可用 E2E_WORKSPACE_TITLE 覆盖）
  --timeout <秒>         boot 等 "dsh web:" 的超时（默认 120 秒）
  --kill                 停掉 --keep 留下的隔离 host + tab
  --purge                配合 --kill：连 /tmp/relay-e2e/home 一起删
  --help                 显示本帮助

说明：
  * 需要 login-web 专用 Chrome 以 --remote-debugging-port=9222 运行；只新建/关闭自己的 tab。
  * 只读写 /tmp/relay-e2e 与 test/e2e；真 DSH 和真 ~/.dsh 不会被改动。
  * 产物：隔离 home=/tmp/relay-e2e/home/.dsh，host 日志=/tmp/relay-e2e/logs/host.log。
`;

function checkRuntime() {
  const major = Number(process.versions.node.split('.')[0]);
  if (typeof WebSocket !== 'function' || typeof fetch !== 'function' || major < 22) {
    console.error(`需要 node >= 22（当前 ${process.version}，缺少原生 WebSocket/fetch）。`);
    console.error('请用：~/.local/node/bin/node test/e2e/smoke.mjs');
    process.exit(2);
  }
}

function parseCli() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      keep: { type: 'boolean', default: false },
      reuse: { type: 'boolean', default: false },
      'no-install': { type: 'boolean', default: false },
      kill: { type: 'boolean', default: false },
      purge: { type: 'boolean', default: false },
      workspace: { type: 'string' },
      timeout: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  return values;
}

const cli = parseCli();
if (cli.help) {
  console.log(HELP);
  process.exit(0);
}

/* ---------------- --kill：收掉 --keep 留下的现场 ---------------- */
if (cli.kill) {
  const result = await e2e.killKept({ purge: cli.purge === true });
  if (!result.keep) {
    console.log(`没有找到 --keep 现场记录：${e2e.KEEP_JSON}`);
  } else {
    console.log(`已停止隔离 host：${result.killed.term.length + result.killed.kill.length} 个进程（${[...result.killed.term, ...result.killed.kill].join(', ') || '无'}）`);
    console.log(`已关闭自己的 tab：${result.tabClosed ? '是' : '否（可能已关）'}`);
  }
  if (result.purged.purged) console.log(`已删除隔离 home：${e2e.HOME_ROOT}`);
  console.log('剩余隔离 host：', e2e.findStrayHosts().length === 0 ? '无 ✓' : JSON.stringify(e2e.findStrayHosts()));
  process.exit(0);
}

checkRuntime();

/* ---------------- 主流程 ---------------- */

const KEEP = cli.keep === true;
const run = { host: null, driver: null, keep: KEEP, ok: false };
let totalStartedAt = Date.now();
let stepIndex = 0;

function step(title) {
  stepIndex += 1;
  console.log(`\n[${stepIndex}/6] ${title}`);
  return Date.now();
}

function stepDone(startedAt) {
  console.log(`        （${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
}

async function emergencyCleanup({ purgeHome }) {
  const host = run.host;
  const driver = run.driver;
  run.host = null;
  run.driver = null;
  try {
    await e2e.stop(host, driver);
  } catch {
    /* 尽力而为 */
  }
  await e2e.killStrayHosts().catch(() => ({}));
  e2e.cleanupTemp({ purgeHome });
}

let signalled = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (signalled) return;
    signalled = true;
    console.error(`\n收到 ${signal}，清理现场…`);
    emergencyCleanup({ purgeHome: !run.keep }).finally(() => process.exit(130));
  });
}

async function diagnostics(error) {
  console.error('\nFAIL  e2e smoke');
  console.error(`  错误：${error?.message ?? error}`);
  const messageLines = String(error?.message ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (error?.stack) {
    const stackLines = String(error.stack)
      .split('\n')
      .slice(1)
      .filter((line) => !messageLines.some((messageLine) => line.trim() === messageLine || line.trim().startsWith(messageLine)))
      .slice(0, 6);
    if (stackLines.length > 0) console.error(`  stack：\n${stackLines.join('\n')}`);
  }
  if (run.host?.logPath) {
    try {
      const log = e2e.readTextFile(run.host.logPath);
      console.error(`\n  --- host 日志尾部（${run.host.logPath}）---`);
      console.error(e2e.tail(log, 40));
    } catch {
      /* ignore */
    }
  }
  if (run.driver) {
    try {
      const text = await run.driver.eval(`document.body ? document.body.innerText : ''`);
      console.error('\n  --- 页面文本片段 ---');
      console.error(String(text ?? '').slice(0, 800));
      if (run.driver.pageErrors.length > 0) {
        console.error('\n  --- 页面 JS 异常（末 5 条）---');
        console.error(run.driver.pageErrors.slice(-5).join('\n'));
      }
    } catch {
      /* ignore */
    }
  }
}

/* 给 M3 用的摘要（--keep 时落盘 + 打印一行 JSON）。 */
function buildSummary(extra = {}) {
  return {
    ok: run.ok,
    ...(run.ok ? {} : { error: extra.error ?? null }),
    ...extra,
    baseUrl: run.host?.baseUrl ?? null,
    url: run.host?.url ?? null,
    port: run.host?.port ?? null,
    token: run.host?.token ?? null,
    chromePort: e2e.CHROME_PORT,
    hostPid: run.host?.pid ?? null,
    hostLog: e2e.HOST_LOG,
    home: run.keep ? e2e.ISOLATED_HOME : null,
    keepJson: run.keep ? e2e.KEEP_JSON : null,
    elapsedMs: Date.now() - totalStartedAt,
  };
}

let failure = null;
let sessionInfo = null;
let stateInfo = null;
let actionProbe = null;
const timings = {};

try {
  const t1 = step('准备隔离 home / 裁剪 profile / pnpm install');
  await e2e.prepareEnv({
    reuse: cli.reuse === true,
    skipInstall: cli['no-install'] === true,
    installTimeoutMs: 180_000,
  });
  timings.prepareMs = Date.now() - t1;
  stepDone(t1);

  const t2 = step('boot 隔离 DSH host（从 stderr 解析 dsh web URL）');
  run.host = await e2e.startHost({ timeoutMs: Number(cli.timeout ?? 120) * 1000 });
  timings.bootMs = Date.now() - t2;
  stepDone(t2);

  const t3 = step('Chrome CDP 9222 开自己的 tab，打开隔离 GUI');
  run.driver = await e2e.openGui(run.host.url, { host: run.host });
  timings.guiMs = Date.now() - t3;
  stepDone(t3);

  const t4 = step('点「新建会话」创建 blank live session（抓 session/create 响应）');
  sessionInfo = await e2e.newSession(run.driver, { workspaceTitle: cli.workspace });
  timings.newSessionMs = Date.now() - t4;
  stepDone(t4);
  // P2-6：交接目录/设置已隔离；工作区 cwd 仍是真实路径（GUI 打开会话依赖），
  // 但本 e2e 不执行写工作区的工具/命令，所以只记录、不当作失败。
  if (typeof sessionInfo.cwd === 'string' && !sessionInfo.cwd.startsWith(e2e.ROOT + '/')) {
    console.log(`  ⚠ cwd 为真实工作区（P2-6 部分隔离）：${sessionInfo.cwd}`);
  }

  const t5 = step('host 侧确认插件看得见 live agent（GET state?sessionId=）');
  stateInfo = await e2e.stateGet(run.host, sessionInfo.sessionId);
  if (stateInfo?.sessionId !== sessionInfo.sessionId) {
    throw new Error(`state 端点返回的 sessionId=${JSON.stringify(stateInfo?.sessionId)} ≠ 新建的 ${sessionInfo.sessionId}`);
  }
  // 备注：不带 sessionId 时插件返回 null（agents 服务不可枚举），这是已知事实，不是本次失败。
  const stateNoId = await e2e.stateGet(run.host).catch(() => null);
  timings.stateMs = Date.now() - t5;
  stepDone(t5);

  const t6 = step('action 端点连通性（POST 未知动作，只验证路由 + pickAgent，无副作用）');
  actionProbe = await e2e.actionPost(run.host, 'e2e-probe', { sessionId: sessionInfo.sessionId });
  if (actionProbe.status === 409) {
    throw new Error('action 端点返回 409「没有活动会话」：插件 pickAgent 看不到这个 session');
  }
  if (actionProbe.status !== 400) {
    throw new Error(`action 端点预期 400（未知动作），实际 HTTP ${actionProbe.status}：${JSON.stringify(actionProbe.body)}`);
  }
  timings.actionMs = Date.now() - t6;
  stepDone(t6);

  run.ok = true;

  const summary = buildSummary({
    sessionId: sessionInfo.sessionId,
    sessionCwd: sessionInfo.cwd,
    sessionBlank: sessionInfo.blank,
    sessionAgentAvailable: sessionInfo.agentAvailable,
    workspaceTitle: sessionInfo.workspaceTitle,
    clickedAriaLabel: sessionInfo.clicked,
    tabId: run.driver?.targetId ?? null,
    state: { sessionId: stateInfo.sessionId, pressure: stateInfo.pressure, advice: stateInfo.advice, level: stateInfo.level },
    stateWithoutSessionId: stateNoId?.sessionId ?? null,
    actionProbe: { status: actionProbe.status, body: actionProbe.body },
    timingsMs: timings,
  });

  console.log('\nPASS  e2e smoke：隔离 DSH + GUI 新建 live 会话 + 插件 state/action 联通');
  console.log(`  host      : ${run.host.url}`);
  console.log(`  session   : ${sessionInfo.sessionId}`);
  console.log(`  cwd       : ${sessionInfo.cwd}`);
  console.log(`  blank     : ${sessionInfo.blank}   agentAvailable: ${sessionInfo.agentAvailable}`);
  console.log(`  state     : sessionId=${stateInfo.sessionId} pressure=${stateInfo.pressure} advice=${stateInfo.advice}`);
  console.log(`  兼容      : 不带 sessionId 的 state 返回 ${JSON.stringify(stateNoId?.sessionId ?? null)}（M2 版恒 null，M3 的 agents.list() 修复后可枚举；harness 两种情况都 PASS）`);
  console.log(`  action    : HTTP ${actionProbe.status}（未知动作；说明端点可达、pickAgent 找得到 agent）`);
  console.log(`  总耗时    : ${((Date.now() - totalStartedAt) / 1000).toFixed(1)}s`);

  if (KEEP) {
    e2e.writeKeepResult(summary);
    run.driver?.detach(); // 断开 CDP，但保留 tab
    run.driver = null;
    console.log('\n保留现场（--keep）：host 与 tab 都还在。');
    console.log('  调插件动作 : node test/e2e/action.mjs handoff --session ' + sessionInfo.sessionId);
    console.log('  查插件状态 : node test/e2e/action.mjs state --session ' + sessionInfo.sessionId);
    console.log('  收掉现场   : node test/e2e/smoke.mjs --kill');
    console.log('  连 home 删 : node test/e2e/smoke.mjs --kill --purge');
    console.log(`  keep 记录  : ${e2e.KEEP_JSON}`);
    console.log(`\nE2E_RESULT ${JSON.stringify(summary)}`);
  }
} catch (error) {
  failure = error;
  run.ok = false;
  await diagnostics(error);
  if (KEEP) {
    console.error('\n保留失败现场（--keep）：host/tab 未清理，便于排查；用 --kill 收尾。');
    const summary = buildSummary({
      error: String(error?.message ?? error),
      sessionId: sessionInfo?.sessionId ?? null,
      sessionCwd: sessionInfo?.cwd ?? null,
      tabId: run.driver?.targetId ?? null,
      timingsMs: timings,
    });
    e2e.writeKeepResult(summary);
    try {
      run.driver?.detach();
    } catch {
      /* ignore */
    }
    run.driver = null;
    console.error(`\nE2E_RESULT ${JSON.stringify(summary)}`);
  }
} finally {
  if (!KEEP) {
    // 默认清理：host（整组）+ 我自己的 tab + 隔离 home（保持 /tmp 干净，只留日志）。
    await emergencyCleanup({ purgeHome: true });
    console.log(`\n清理完成：host 已停、tab 已关、隔离 home 已删（日志保留：${e2e.LOG_DIR}）`);
    console.log(`总耗时 ${((Date.now() - totalStartedAt) / 1000).toFixed(1)}s`);
  }
}

process.exit(run.ok ? 0 : 1);
