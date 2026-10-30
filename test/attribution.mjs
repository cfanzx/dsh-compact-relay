/**
 * 0.5.6 Phase D1：压缩归属（服务端一半）。
 *
 *   node test/attribution.mjs
 *
 * 覆盖（总计划 D2 / task-3 §4.2）：
 *   - 分类判据：turn 数字 → native-auto；turn null + sourceCommandId → command；
 *     都没有 → unknown —— **turn:null 永远不等于 native-auto**；
 *   - 五种 trigger 各一条：ui-menu / command / handoff / native-auto / unknown
 *     （另测外部命令 command/run 反查与显式 external 的 actor 口径）；
 *   - 提前 mint compactionId：事件行、事务 start 事件、失败错误对象同源；
 *   - 归属事件行/投影形状（ATTRIBUTION_ROW_KEYS）、去重、limit；
 *   - readState.lastCompaction；GET /api/compact-relay-attribution 形状。
 *
 * 全部写临时目录，不碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { betterCompact } from '../lib/actions/better-compact.js';
import { handoff } from '../lib/actions/handoff.js';
import { readState } from '../lib/actions/state.js';
import { createLock } from '../lib/actions/lock.js';
import { resolveConfig } from '../lib/config.js';
import {
  ATTRIBUTION_LIMIT_MAX,
  ATTRIBUTION_ROW_KEYS,
  actorOfTrigger,
  attributionOfEvents,
  classifyForeignCompaction,
  collectAttributions,
} from '../lib/core/attribution.js';
import { HANDOFF_SECTIONS } from '../lib/core/handoff-doc.js';
import { REQUIRED_SECTIONS } from '../lib/core/validate-summary.js';
import { createEventStore } from '../lib/dsh/events.js';
import {
  claimCompactionId,
  createAttributionWatcher,
  releaseCompactionId,
} from '../lib/dsh/attribution-watch.js';
import {
  callRouteAsync,
  createAgent,
  createFakeEngine,
  createFakeHost,
  createHandoffHost,
  createPluginDeps,
  createTmpDir,
} from './harness/host.mjs';
import { createFakeLlm } from './harness/llm.mjs';
import { MockSession, baseSourceSession } from './harness/session.mjs';

/* ================================================================== *
 * 夹具
 * ================================================================== */

function summaryReply() {
  return REQUIRED_SECTIONS.map((section) => `${section}\n- ${section}：归属测试用摘要`).join('\n');
}

function handoffReply() {
  return HANDOFF_SECTIONS.map((section) => `## ${section}\n- ${section}的内容：归属测试`).join('\n');
}

function makeLlm() {
  return createFakeLlm({
    routes: [
      { kind: 'handoff', match: ({ instruction }) => instruction.includes('交接文档'), replies: [handoffReply()] },
      { kind: 'summary', match: () => true, replies: [summaryReply()] },
    ],
  });
}

function homeOf(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dcr-attribution-${name}-`));
  return { dir, file: path.join(dir, 'compact-relay-events.jsonl') };
}

function storeOf(file) {
  return createEventStore({ file, version: '0.5.6', home: os.homedir() });
}

function makeCompactDeps({ store, llm = makeLlm(), ledgerRows = [] } = {}) {
  const host = createHandoffHost({ llm });
  const deps = createPluginDeps({
    ctx: host.ctx,
    engine: host.engine,
    handoffDir: createTmpDir(`dcr-attribution-handoff-`),
  });
  deps.events = store;
  deps.ledger = { record: (row) => ledgerRows.push(row) };
  return { deps, host, engine: host.engine };
}

/** 手工喂一条旁路压缩（走 watcher 的事件状态机）。 */
function feedForeign(watcher, session, {
  compactionId,
  turn = null,
  sourceCommandId,
  count = 3,
  tokens = 900,
  startSeq = 5,
  endSeq = 9,
  model = 'deepseek-flash',
  at = Date.now(),
  failed = false,
} = {}) {
  watcher.onEvent(session, {
    type: 'compaction/start',
    seq: 1,
    time: at,
    data: { compactionId, turn, ...(sourceCommandId === undefined ? {} : { sourceCommandId }) },
  });
  watcher.onEvent(session, {
    type: 'compaction/summary',
    seq: 2,
    time: at + 20,
    data: {
      compactionId,
      shadowedRange: { start: startSeq, end: endSeq },
      shadowedSeqs: Array.from({ length: count }, (_, index) => startSeq + index),
      shadowedTokenCount: tokens,
      provider: 'mock',
      model,
    },
  });
  watcher.onEvent(session, {
    type: 'compaction/end',
    seq: 3,
    time: at + 100,
    data: { compactionId, ...(failed ? { error: { name: 'Error', message: 'boom' } } : {}) },
  });
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* ================================================================== *
 * ① 分类判据（不猜）
 * ================================================================== */

test('A1 classifyForeignCompaction：数字 turn / commandId / 都没有', () => {
  const native = classifyForeignCompaction({ turn: 42 });
  assert.equal(native.trigger, 'native-auto');
  assert.equal(native.actor, 'system');
  assert.equal(native.evidence.turn, 42);

  const command = classifyForeignCompaction({ turn: null, sourceCommandId: 'cmd-9' });
  assert.equal(command.trigger, 'command');
  assert.equal(command.actor, 'user');

  // 10-29 两次判错的形状：turn=null 且没有 commandId → 只能是 unknown。
  const unknown = classifyForeignCompaction({ turn: null, sourceCommandId: null });
  assert.equal(unknown.trigger, 'unknown');
  assert.equal(unknown.actor, 'unknown');
  assert.notEqual(unknown.trigger, 'native-auto');

  // turn=0 也是数字（不要求 >0）。
  assert.equal(classifyForeignCompaction({ turn: 0 }).trigger, 'native-auto');
  // actor 口径固定。
  assert.equal(actorOfTrigger('ui-menu'), 'user');
  assert.equal(actorOfTrigger('ui-ring'), 'user');
  assert.equal(actorOfTrigger('command'), 'user');
  assert.equal(actorOfTrigger('handoff'), 'user');
  assert.equal(actorOfTrigger('external'), 'user');
  assert.equal(actorOfTrigger('native-auto'), 'system');
  assert.equal(actorOfTrigger('nonsense'), 'unknown');
});

test('A2 投影：坏行/无 compactionId 跳过、同 id 折叠、最新在前、limit 生效', () => {
  const records = [
    { action: 'compact', at: '2026-10-30T10:00:00+08:00', trigger: 'ui-menu', compactionId: 'a', outcome: 'ok', context: { nodes: 2, shadowedTokens: 10, startSeq: 1, endSeq: 2, model: 'm1', merged: false } },
    { action: 'preview', at: '2026-10-30T10:01:00+08:00', trigger: 'ui-menu', compactionId: 'ignored', outcome: 'ok' },
    { action: 'compact', at: '2026-10-30T10:02:00+08:00', trigger: 'command', compactionId: null, outcome: 'ok' },
    { action: 'compact', at: '2026-10-30T10:03:00+08:00', trigger: 'native-auto', compactionId: 'b', outcome: 'ok', context: { nodes: 4 } },
    { action: 'compact', at: '2026-10-30T10:04:00+08:00', trigger: 'unknown', compactionId: 'b', outcome: 'fail', code: 'x', context: { nodes: 4 } },
  ];
  const all = collectAttributions(records);
  assert.equal(all.length, 2, '同 id 只算一条');
  assert.deepEqual(all.map((row) => row.compactionId), ['b', 'a'], '最新在前');
  assert.equal(all[0].outcome, 'fail', '同 id 取后写的一条');
  const limited = attributionOfEvents(records, { limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].compactionId, 'b');
  assert.deepEqual(
    Object.keys(all[1]).sort(),
    [...ATTRIBUTION_ROW_KEYS].sort(),
    '归属行键集合冻结',
  );
  assert.equal(ATTRIBUTION_LIMIT_MAX, 100);
});

/* ================================================================== *
 * ② 五种 trigger（真实压缩 3 种 + 旁路 2 种）
 * ================================================================== */

test('T1 ui-menu：提前 mint id 与事务 start 同源，投影范围/模型/合并齐全', async () => {
  const { file, dir } = homeOf('t1');
  const store = storeOf(file);
  const { deps } = makeCompactDeps({ store });
  const session = baseSourceSession();
  const outcome = await betterCompact(deps, { agent: createAgent(session), trigger: 'ui-menu' });
  assert.equal(outcome.compacted, true);

  const startEvent = session.log.find((event) => event.type === 'compaction/start');
  assert.equal(typeof outcome.compactionId, 'string');
  assert.equal(startEvent.data.compactionId, outcome.compactionId, '事务与返回值同源');
  const endEvent = session.log.find((event) => event.type === 'compaction/end');
  assert.equal(endEvent.data.compactionId, outcome.compactionId);

  const rows = store.compactions({ limit: 10 });
  assert.equal(rows.length, 1, '一次压缩只记一条归属行');
  const row = rows[0];
  assert.deepEqual(Object.keys(row).sort(), [...ATTRIBUTION_ROW_KEYS].sort());
  assert.equal(row.compactionId, outcome.compactionId);
  assert.equal(row.trigger, 'ui-menu');
  assert.equal(row.actor, 'user');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.code, null);
  assert.deepEqual(row.range, {
    count: outcome.shadowedSeqs.length,
    tokens: outcome.shadowedTokenCount,
    startSeq: outcome.startSeq,
    endSeq: outcome.endSeq,
  });
  assert.equal(typeof row.model, 'string', '摘要模型要从事件 context 投影出来');
  assert.equal(row.merged, false, '本次未合并旧摘要');
  assert.equal(typeof row.durationMs, 'number');

  // 回放同一份会话日志给旁路监听器：文件里已有同 id 行 → 不重复记。
  const watcher = createAttributionWatcher({ events: store });
  for (const event of session.log) watcher.onEvent(session, event);
  watcher.close();
  assert.equal(store.compactions({ limit: 10 }).length, 1, '旁路去重：我们的压缩不重复记账');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T2 command：trigger + sourceCommandId 写进会话事件', async () => {
  const { file, dir } = homeOf('t2');
  const store = storeOf(file);
  const { deps } = makeCompactDeps({ store });
  const session = baseSourceSession();
  const outcome = await betterCompact(deps, { agent: createAgent(session), trigger: 'command', commandId: 'cmd-1' });
  assert.equal(outcome.compacted, true);
  const startEvent = session.log.find((event) => event.type === 'compaction/start');
  assert.equal(startEvent.data.sourceCommandId, 'cmd-1', '外部命令的直接证据');
  const [row] = store.compactions({ limit: 5 });
  assert.equal(row.trigger, 'command');
  assert.equal(row.actor, 'user');
  assert.equal(row.compactionId, startEvent.data.compactionId);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T2b 缺省 trigger：不传 → unknown（不猜成 ui-menu/command）', async () => {
  const { file, dir } = homeOf('t2b');
  const store = storeOf(file);
  const { deps } = makeCompactDeps({ store });
  const session = baseSourceSession();
  await betterCompact(deps, { agent: createAgent(session) });
  const [row] = store.compactions({ limit: 5 });
  assert.equal(row.trigger, 'unknown');
  assert.equal(row.actor, 'unknown');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T3 handoff：交接前置压缩记 trigger=handoff，且轻账本没有 compact 行', async () => {
  const { file, dir } = homeOf('t3');
  const store = storeOf(file);
  const ledgerRows = [];
  const { deps, host } = makeCompactDeps({ store, ledgerRows });
  const session = baseSourceSession();
  await handoff(deps, { agent: createAgent(session), commandId: 'cmd-h' });
  assert.notEqual(host.record.child, null, '交接应创建新会话');
  const rows = store.compactions({ limit: 5 });
  assert.equal(rows.length, 1, '交接前置压缩只记一条归属行');
  assert.equal(rows[0].trigger, 'handoff');
  assert.equal(rows[0].actor, 'user');
  assert.equal(ledgerRows.filter((row) => row.kind === 'compact').length, 0, 'ledgerRecord:false 未被破坏');
  assert.equal(ledgerRows.filter((row) => row.kind === 'handoff').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T4 native-auto：turn 是数字才归 system（范围取自 summary 数据）', () => {
  const { file, dir } = homeOf('t4');
  const store = storeOf(file);
  const watcher = createAttributionWatcher({ events: store });
  const session = new MockSession({ id: 'session-native' });
  feedForeign(watcher, session, { compactionId: 'cid-native', turn: 42 });
  watcher.close();
  const [row] = store.compactions({ limit: 5 });
  assert.equal(row.trigger, 'native-auto');
  assert.equal(row.actor, 'system');
  assert.equal(row.outcome, 'ok');
  assert.deepEqual(row.range, { count: 3, tokens: 900, startSeq: 5, endSeq: 9 });
  assert.equal(row.model, 'deepseek-flash');
  assert.equal(row.merged, null, '旁路不知道合并状态就不写数');
  assert.equal(row.durationMs, 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T5 unknown：turn=null 且无 commandId → unknown，绝不误判 native-auto', () => {
  const { file, dir } = homeOf('t5');
  const store = storeOf(file);
  const watcher = createAttributionWatcher({ events: store });
  const session = new MockSession({ id: 'session-unknown' });
  feedForeign(watcher, session, { compactionId: 'cid-unknown', turn: null, failed: true });
  watcher.close();
  const [row] = store.compactions({ limit: 5 });
  assert.equal(row.trigger, 'unknown');
  assert.equal(row.actor, 'unknown');
  assert.notEqual(row.trigger, 'native-auto');
  assert.notEqual(row.trigger, 'ui-menu');
  assert.equal(row.outcome, 'fail');
  assert.equal(row.code, 'compaction-error');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T5b 外部命令：command/run 反查 + sourceCommandId → command（ours:false）', () => {
  const { file, dir } = homeOf('t5b');
  const store = storeOf(file);
  const watcher = createAttributionWatcher({ events: store });
  const session = new MockSession({ id: 'session-cmd' });
  watcher.onEvent(session, { type: 'command/run', time: 1, data: { commandId: 'c9', name: 'compact' } });
  feedForeign(watcher, session, { compactionId: 'cid-cmd', turn: null, sourceCommandId: 'c9' });
  watcher.close();
  const [row] = store.compactions({ limit: 5 });
  assert.equal(row.trigger, 'command');
  assert.equal(row.actor, 'user');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T5c 去重：同一个 compactionId 的 end 重复到达只记一条', () => {
  const { file, dir } = homeOf('t5c');
  const store = storeOf(file);
  const watcher = createAttributionWatcher({ events: store });
  const session = new MockSession({ id: 'session-dedupe' });
  feedForeign(watcher, session, { compactionId: 'cid-dup', turn: 7 });
  // 再喂一遍 end（模拟宿主重复派发/重启后回放）。
  watcher.onEvent(session, { type: 'compaction/end', time: 2, data: { compactionId: 'cid-dup' } });
  watcher.close();
  assert.equal(store.compactions({ limit: 10 }).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T5d own claim：我们 claim 的 id 旁路一条都不写', () => {
  const { file, dir } = homeOf('t5d');
  const store = storeOf(file);
  const watcher = createAttributionWatcher({ events: store });
  const session = new MockSession({ id: 'session-own' });
  claimCompactionId('cid-own');
  feedForeign(watcher, session, { compactionId: 'cid-own', turn: 9 });
  releaseCompactionId('cid-own');
  watcher.close();
  assert.equal(store.compactions({ limit: 10 }).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ================================================================== *
 * ③ lastCompaction / 失败留档 / 端点
 * ================================================================== */

test('T6 lastCompaction：readState 顶层从事件投影；没有事件流 → null', async () => {
  const { file, dir } = homeOf('t6');
  const store = storeOf(file);
  const { deps, engine } = makeCompactDeps({ store });
  const session = baseSourceSession();
  const agent = createAgent(session);
  await betterCompact(deps, { agent, trigger: 'ui-menu' });

  // 最小 readState ctx（harness 的 createHandoffHost 没有 agents.get/sessions.get）。
  const stateCtx = {
    tokenMeter: {
      measure() {
        return {
          totalTokens: 40_000,
          surfaceTokens: 40_000,
          nodes: session.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 })),
        };
      },
    },
    llm: { async resolveModelInfo() { return { context: { contextWindow: 200_000 } }; } },
    get: (name) => (name === 'sessionTitle' ? { get: () => ({ title: '归属测试' }) } : undefined),
    agents: { get: (id) => (id === agent.id ? agent : undefined), list: () => [agent] },
    sessions: { get: () => session, flush() {} },
  };
  const stateDeps = {
    ctx: stateCtx,
    cfg: resolveConfig({ retention: { recentTailTokens: 0 } }),
    lock: createLock(),
    engine,
    events: store,
    nativeConfig: { autoEnabled: true, thresholdRatio: 0.8 },
  };
  const state = await readState(stateDeps, { sessionId: session.id });
  assert.notEqual(state.lastCompaction, null, '有归属行 → lastCompaction 必须非 null');
  assert.deepEqual(Object.keys(state.lastCompaction).sort(), [...ATTRIBUTION_ROW_KEYS].sort());
  assert.equal(state.lastCompaction.trigger, 'ui-menu');
  assert.equal(state.lastCompaction.actor, 'user');
  assert.equal(state.lastCompaction.range.count > 0, true);

  const withoutEvents = await readState({ ...stateDeps, events: undefined }, { sessionId: session.id });
  assert.equal(withoutEvents.lastCompaction, null, '没有事件流 → null（不猜）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T7 失败留档：error.compactionId 与会话日志、归属事件行同一主键', async () => {
  const { file, dir } = homeOf('t7');
  const store = storeOf(file);
  const badLlm = createFakeLlm({
    routes: [{ kind: 'summary', match: () => true, replies: ['不合格摘要（没有六段）'] }],
  });
  const { deps } = makeCompactDeps({ store, llm: badLlm });
  const session = baseSourceSession();
  let caught = null;
  await assert.rejects(
    betterCompact(deps, { agent: createAgent(session), trigger: 'ui-menu' }),
    (error) => {
      caught = error;
      assert.equal(error.code, 'summary');
      assert.equal(typeof error.compactionId, 'string');
      return true;
    },
  );
  const startEvent = session.log.find((event) => event.type === 'compaction/start');
  assert.equal(startEvent.data.compactionId, caught.compactionId, '失败也能和 DSH 事件对上号');
  const [row] = store.compactions({ limit: 5 });
  assert.equal(row.compactionId, caught.compactionId);
  assert.equal(row.outcome, 'fail');
  assert.equal(row.code, 'summary');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T8 端点：GET /api/compact-relay-attribution → {ok, attribution, total, limit}', async () => {
  const { file, dir } = homeOf('t8');
  const store = storeOf(file);
  const watcher = createAttributionWatcher({ events: store });
  const session = new MockSession({ id: 'session-endpoint' });
  feedForeign(watcher, session, { compactionId: 'cid-ep1', turn: 1, at: Date.now() - 2000 });
  feedForeign(watcher, session, { compactionId: 'cid-ep2', turn: null, at: Date.now() - 1000 });
  watcher.close();

  const host = createFakeHost();
  const ctx = host.makeContext(true);
  const deps = {
    ctx,
    cfg: resolveConfig({ retention: { recentTailTokens: 0 } }),
    lock: createLock(),
    engine: createFakeEngine(),
    events: store,
  };
  // 复用 plugin-load 的路由装配方式（registerHttp 在此 import 前已静态可用）。
  const { registerHttp } = await import('../lib/adapters/http.js');
  registerHttp(ctx, deps);

  const all = await callRouteAsync(host, '/api/compact-relay-attribution?limit=20');
  assert.equal(all.status, 200);
  assert.equal(all.body.ok, true);
  assert.equal(Array.isArray(all.body.attribution), true);
  assert.equal(all.body.total, 2);
  assert.deepEqual(all.body.attribution.map((row) => row.trigger).sort(), ['native-auto', 'unknown']);

  const one = await callRouteAsync(host, '/api/compact-relay-attribution?limit=1');
  assert.equal(one.body.attribution.length, 1);
  assert.equal(one.body.total, 2, 'total 是过滤后的全量，不受 limit 影响');

  const scoped = await callRouteAsync(host, '/api/compact-relay-attribution?sessionId=session-endpoint&limit=20');
  assert.equal(scoped.body.total, 2);
  const none = await callRouteAsync(host, '/api/compact-relay-attribution?sessionId=other&limit=20');
  assert.equal(none.body.total, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ================================================================== *
 * 运行
 * ================================================================== */

let passed = 0;
let failed = 0;
for (const entry of cases) {
  try {
    await entry.fn();
    passed += 1;
    console.log(`PASS  ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${entry.name}`);
    console.error(error);
  }
}
console.log(`\n${passed}/${cases.length} passed`);
if (failed > 0) process.exit(1);
