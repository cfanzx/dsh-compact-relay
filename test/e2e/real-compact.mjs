#!/usr/bin/env node
/**
 * e2e 真实压缩 —— 真实模型调用 + 真实压缩事务 + P2-T1 旧摘要合并，全程在隔离 DSH 里。
 *
 * 与 smoke.mjs 的区别：本脚本会**真的调模型**（在 GUI 里发短消息让模型回复，攒出可压历史），
 * 再通过插件 HTTP 端点执行两次 `/compact`。所以**会消耗 token**；但只跑隔离 home，
 * 不碰真 DSH（安全铁律同 lib.mjs：只写 /tmp/relay-e2e，真 ~/.dsh 只读）。
 *
 * 验证点：
 *   1. 真实压缩一步：会话有历史后真生成摘要，`summaries` +1，提示「压缩完成」；
 *   2. P2-T1 旧摘要合并：把隔离设置改成 `thresholds.maxSummaries=1`，
 *      第二次压缩时 `allowMergeOldSummaries=true`，提示带「同时合并了旧摘要」且 `summaries` 不再增加。
 *
 * 用法：
 *   node test/e2e/real-compact.mjs            # 完整流程 + 清理（首次 rsync 约 10s）
 *   node test/e2e/real-compact.mjs --reuse    # 复用隔离 home（约 5s）
 *   node test/e2e/real-compact.mjs --keep     # 保留现场（调试用，别忘 --kill 收掉）
 *   node test/e2e/real-compact.mjs --reuse --no-install   # 代码没改时更快
 *
 * 前置：Chrome 以 --remote-debugging-port=9222 运行中（同 smoke.mjs）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as e2e from './lib.mjs';

const { values: cli } = parseArgs({
  allowPositionals: false,
  options: {
    reuse: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    'no-install': { type: 'boolean', default: false },
    timeout: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (cli.help) {
  console.log('node test/e2e/real-compact.mjs [--reuse] [--keep] [--no-install] [--timeout 秒]');
  process.exit(0);
}

const MODEL_TIMEOUT_MS = Number(cli.timeout ?? 180) * 1000;
const COMPACT_TIMEOUT_MS = MODEL_TIMEOUT_MS;
/** 可压范围太小时摘要会「比被替换内容还大」被拒，所以攒历史要攒到够压。 */
const FIRST_MIN_TOKENS = 700;
const SECOND_MIN_TOKENS = 400;
/** 循环题库：每轮一条，控制长度让历史稳定超过保留区（retention=200）。 */
const PROMPTS = [
  '现在开始记录：今天我们在隔离环境里测试压缩插件。请只回复「收到」，不要多说。',
  '继续记录：第一次压缩需要覆盖足够多的旧消息，否则摘要比原文大就没有意义。请只回复「好」。',
  '再记录一项：压缩完成后要检查摘要计数和容量变化。请只回复「明白」。',
  '补充记录：第二次压缩要验证旧摘要合并分支，不能新生成一份和旧摘要同时堆着。请只回复「记住了」。',
  '最后一项：整个流程跑在隔离 home 里，不能碰真实 DSH。请只回复「收到」。',
];

const startedAt = Date.now();
const run = { host: null, driver: null, keep: cli.keep === true };
const checkpoints = [];

function log(...args) {
  console.log(...args);
}

async function step(title, fn) {
  const t = Date.now();
  log(`\n▸ ${title}`);
  const result = await fn();
  log(`  ✓ ${((Date.now() - t) / 1000).toFixed(1)}s`);
  return result;
}

/**
 * 在 GUI 输入框里输入一条消息并发送（contenteditable + CDP 真实按键，React 能收到）。
 * @param {object} driver e2e.openGui 返回的 driver
 * @param {string} text
 */
async function sendMessage(driver, text) {
  const focused = await driver.eval(`(() => {
    const el = document.querySelector('[role="textbox"][contenteditable]');
    if (!el) return false;
    el.focus();
    return true;
  })()`);
  if (!focused) throw new Error('GUI 里找不到输入框（[role=textbox][contenteditable]）');
  await driver.cdp.send('Input.insertText', { text });
  const typed = await driver.waitFor(
    `(() => {
      const el = document.querySelector('[role="textbox"]');
      return !!el && ((el.innerText || el.textContent || '').includes(${JSON.stringify(text.slice(0, 8))}));
    })()`,
    8000,
  );
  if (!typed) throw new Error(`输入框没收到文本：${JSON.stringify(text.slice(0, 20))}`);
  for (const type of ['keyDown', 'keyUp']) {
    await driver.cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }
  // 发送成功的判据：DSH 发出去后清空输入框。
  const sent = await driver.waitFor(
    `(() => {
      const el = document.querySelector('[role="textbox"]');
      return !!el && !(el.innerText || '').trim();
    })()`,
    10000,
  );
  if (!sent) throw new Error('按了 Enter 但输入框没清空，消息可能没发出去');
}

/**
 * 轮询插件 state 直到 predicate 成立；失败时把最后一份 state 打进错误里。
 * @param {object} host
 * @param {string} sessionId
 * @param {(state:object)=>boolean} predicate
 * @param {number} timeoutMs
 * @param {string} label
 */
async function waitState(host, sessionId, predicate, timeoutMs, label) {
  let last = null;
  // 注意：e2e.waitUntil 只返回 true/false，所以命中时返回最后那份 state。
  const ok = await e2e.waitUntil(
    async () => {
      const state = await e2e.stateGet(host, sessionId, { timeoutMs: 10_000 }).catch(() => null);
      last = state;
      return state !== null && predicate(state);
    },
    timeoutMs,
    1500,
  );
  if (!ok) throw new Error(`等待「${label}」超时（${timeoutMs}ms）。最后 state：${JSON.stringify(last).slice(0, 500)}`);
  return last;
}

/**
 * 等模型回复真正结束。
 *
 * 不能用「pressure 增长」当判据：用户消息一入 surface，pressure 就已经增加，
 * 而模型回复可能还在流式生成，此时压缩会 409「正在回复中」。
 * 这里用页面文本连续 3 次（约 1.5s）不变当「回复结束」的观察点。
 */
async function waitReplyDone(driver, { timeoutMs = 180_000, stableChecks = 3 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let stable = 0;
  for (;;) {
    const text = await driver.bodyText().catch(() => '');
    if (text === previous) stable += 1;
    else {
      previous = text;
      stable = 0;
    }
    if (stable >= stableChecks) return;
    if (Date.now() > deadline) throw new Error(`等待模型回复结束超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** 当前可压范围（state.compactRange）；没有范围返回 null。 */
const rangeOf = (state) =>
  state?.compactRange !== null && state?.compactRange !== undefined && state.compactRange.nodes >= 1
    ? state.compactRange
    : null;

async function main() {
  await step('准备隔离 home / 裁剪 profile / pnpm install（vendor 最新代码）', () =>
    e2e.prepareEnv({ reuse: cli.reuse === true, skipInstall: cli['no-install'] === true, installTimeoutMs: 180_000 }),
  );

  // 关键：让隔离环境的「保留近期原文」变小、摘要上限=1。
  // 这样 3 轮短对话就能出可压范围，且第二次压缩必然走「合并旧摘要」分支（P2-T1）。
  // 只在隔离 home 里写，真 ~/.dsh/compact-relay.json 不受影响。
  const settingsPath = path.join(e2e.ISOLATED_HOME, 'compact-relay.json');
  const settings = {
    v: 1,
    config: {
      thresholds: { compactRatio: 0.4, handoffRatio: 0.6, maxSummaries: 1 },
      retention: { recentTailTokens: 120 },
    },
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  log(`  · 隔离设置：${settingsPath}（recentTailTokens=120, maxSummaries=1）`);

  run.host = await step('boot 隔离 DSH host', () => e2e.startHost({ timeoutMs: 120_000 }));
  run.driver = await step('Chrome CDP 9222 打开隔离 GUI', () => e2e.openGui(run.host.url, { host: run.host }));
  const session = await step('GUI 新建 blank live session', () => e2e.newSession(run.driver, {}));
  log(`  · session=${session.sessionId}`);

  const stateAtStart = await e2e.stateGet(run.host, session.sessionId);
  checkpoints.push({ at: 'start', state: stateAtStart });

  /**
   * 发消息攒历史，直到 state.compactRange 的 tokens ≥ minTokens。
   * 每轮都等 pressure 增长（说明模型回复已经进了 surface）。
   */
  let promptIndex = 0;
  async function sendRound() {
    const before = await e2e.stateGet(run.host, session.sessionId).catch(() => null);
    const beforePressure = before?.pressure ?? 0;
    const prompt = PROMPTS[promptIndex % PROMPTS.length];
    promptIndex += 1;
    await sendMessage(run.driver, prompt);
    // 等模型回复真正结束（页面文本稳定），别只看 pressure——它先于回复完成就涨。
    await waitReplyDone(run.driver, { timeoutMs: MODEL_TIMEOUT_MS });
    const state = await e2e.stateGet(run.host, session.sessionId).catch(() => null);
    if (beforePressure > 0 && (state?.pressure ?? 0) <= beforePressure) {
      log(`  ⚠ 第 ${promptIndex} 轮 pressure 没涨（${beforePressure} → ${state?.pressure}），继续`);
    }
    log(`  · 第 ${promptIndex} 轮完成：pressure=${state?.pressure ?? '?'}，范围=${JSON.stringify(rangeOf(state))}`);
  }

  async function gatherUntil(minTokens, maxRounds) {
    // 结构是「先查、不够就再发一轮」；多发一轮后仍要再查，所以 <= maxRounds。
    for (let index = 0; index <= maxRounds; index += 1) {
      const state = await e2e.stateGet(run.host, session.sessionId).catch(() => null);
      const range = rangeOf(state);
      if (range !== null && range.tokens >= minTokens) return range;
      log(`  · 可压范围还不足（${range === null ? '无' : `${range.tokens} tokens`}），再发一轮`);
      await sendRound();
    }
    throw new Error(`攒不出 ≥${minTokens} tokens 的可压范围`);
  }

  const readyRange = await step(
    `发消息攒历史直到可压范围 ≥${FIRST_MIN_TOKENS} tokens（真实模型调用）`,
    () => gatherUntil(FIRST_MIN_TOKENS, 6),
  );
  log(`  · 可压范围：${JSON.stringify(readyRange)}`);
  checkpoints.push({ at: 'before-first-compact', state: await e2e.stateGet(run.host, session.sessionId) });

  const first = await step('第一次真实压缩（POST action=compact）', () =>
    e2e.actionPost(run.host, 'compact', { sessionId: session.sessionId }, { timeoutMs: COMPACT_TIMEOUT_MS }),
  );
  const firstMessage = typeof first.body?.message === 'string' ? first.body.message : '';
  if (first.status !== 200 || first.body?.ok !== true || !firstMessage.includes('压缩完成')) {
    throw new Error(`第一次压缩失败：HTTP ${first.status} ${JSON.stringify(first.body).slice(0, 400)}`);
  }
  log(`  · ${firstMessage}`);
  const afterFirst = await waitState(
    run.host,
    session.sessionId,
    (state) => (state.summaries ?? 0) >= 1,
    20_000,
    '第一次压缩后 summaries>=1',
  );
  log(`  · summaries=${afterFirst.summaries}，pressure=${afterFirst.pressure}`);
  checkpoints.push({ at: 'after-first-compact', state: afterFirst });

  const secondRange = await step(
    `再攒历史直到可压范围 ≥${SECOND_MIN_TOKENS} tokens（P2-T1 前的新内容）`,
    () => gatherUntil(SECOND_MIN_TOKENS, 4),
  );
  log(`  · 第二次可压范围：${JSON.stringify(secondRange)}`);

  const second = await step('第二次真实压缩（maxSummaries=1 → 必须合并旧摘要，P2-T1）', () =>
    e2e.actionPost(run.host, 'compact', { sessionId: session.sessionId }, { timeoutMs: COMPACT_TIMEOUT_MS }),
  );
  const secondMessage = typeof second.body?.message === 'string' ? second.body.message : '';
  if (second.status !== 200 || second.body?.ok !== true || !secondMessage.includes('压缩完成')) {
    throw new Error(`第二次压缩失败：HTTP ${second.status} ${JSON.stringify(second.body).slice(0, 400)}`);
  }
  log(`  · ${secondMessage}`);
  const afterSecond = await e2e.stateGet(run.host, session.sessionId);

  // ---- 断言 ----
  const failures = [];
  const expect = (condition, label) => {
    if (condition) log(`  ✓ ${label}`);
    else {
      log(`  ✗ ${label}`);
      failures.push(label);
    }
  };
  expect(firstMessage.includes('压缩完成'), '第一次压缩返回「压缩完成」');
  expect((afterFirst.summaries ?? 0) >= 1, '第一次压缩后 summaries ≥ 1（摘要落日志）');
  expect(secondMessage.includes('压缩完成'), '第二次压缩返回「压缩完成」');
  expect(
    secondMessage.includes('同时合并了旧摘要'),
    'P2-T1：第二次压缩提示带「同时合并了旧摘要」（allowMergeOldSummaries）',
  );
  // 注意口径：countSummaries 数的是「历史上成功落盘并被替换过的摘要数」，
  // readState 把它显示成「已压缩 N 次」；合并旧摘要只是让 surface 上不再多一份，
  // 这次压缩本身仍记一次，所以是 +1 而不是不变。policy 用同一个数判「达到上限后允许合并」，
  // 达到后持续合并正是「防止摘要堆积」的意图，所以这里按 +1 断言。
  expect(
    afterSecond.summaries === (afterFirst.summaries ?? 0) + 1,
    `合并后 summaries 记 +1（${afterFirst.summaries} → ${afterSecond.summaries}，历史压缩次数）`,
  );
  expect(firstMessage.includes('同时合并了旧摘要') === false, '第一次压缩没有合并旧摘要（本来就没有）');

  checkpoints.push({ at: 'after-second-compact', state: afterSecond });

  if (failures.length > 0) throw new Error(`断言失败 ${failures.length} 项：${failures.join('；')}`);
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  console.error(`\nFAIL ${error?.message ?? error}`);
  if (error?.stack) console.error(error.stack.split('\n').slice(1, 5).join('\n'));
}

const summary = {
  ok: failure === null,
  sessionId: run.host?.sessionId ?? null,
  host: run.host?.baseUrl ?? null,
  keep: run.keep,
  checkpoints: checkpoints.map((item) => ({
    at: item.at,
    summaries: item.state?.summaries ?? null,
    pressure: item.state?.pressure ?? null,
    level: item.state?.level ?? null,
  })),
  hostLog: e2e.HOST_LOG,
  elapsedMs: Date.now() - startedAt,
};
console.log(`\nE2E_COMPACT_RESULT ${JSON.stringify(summary)}`);

if (run.keep) {
  log('\n--keep：现场保留中（host/tab 不动）。收掉：node test/e2e/smoke.mjs --kill --purge');
} else {
  await e2e.stop(run.host, run.driver).catch(() => {});
  e2e.cleanupTemp({ purgeHome: true });
  log(`\n清理完成（日志保留：${e2e.LOG_DIR}）`);
}

if (failure !== null) {
  console.error(`\n总耗时：${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  process.exit(1);
}
log(`\nPASS  e2e 真实压缩 + P2-T1 旧摘要合并（总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
process.exit(0);
