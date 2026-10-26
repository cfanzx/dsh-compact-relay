/**
 * 0.5.1 批 2：pin 失效标注（C 方案）+ 原生压缩吃掉 pin 的提前保护 —— 单测。
 *
 *   node test/pin-health.mjs
 *
 * 覆盖三层：
 *   1. `core/pin-health.js`：pin 快照 vs 当前 surface 的 live 集合差异；
 *      失效原因（原生自动压缩 turn≠null / 其它压缩 / 历史变化）只读日志判定；
 *   2. `core/native-pin-risk.js` + `core/native-line.js`：按 compaction-basic 的
 *      `selectCompactableRange` 同口径预判「下一次原生压缩会覆盖哪些 pin」；
 *   3. `actions/state.js`：additive 字段 `pins.stale` / `pins.atRisk` / `sessionPinned`
 *      （老客户端忽略；不改 `pins.count` 既有语义）。
 */
import assert from 'node:assert/strict';
import { readState } from '../lib/actions/state.js';
import { createLock } from '../lib/actions/lock.js';
import { nativeRetainTokensOf } from '../lib/core/native-line.js';
import { parseCompactionOverride, parseModelPolicies, resolveNativePolicy } from '../lib/dsh/native-compaction.js';
import { nativePinnedRiskOf } from '../lib/core/native-pin-risk.js';
import { togglePin } from '../lib/actions/pin.js';
import { pinHealthOf } from '../lib/core/pin-health.js';
import { PIN_RECORD_TYPE, latestPinnedSeqs } from '../lib/core/pins.js';
import { resolveConfig } from '../lib/config.js';
import { MockSession } from './harness/session.mjs';

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/* ------------------------------------------------------------------ *
 * 夹具：一次压缩事务（replace 掉 [1,2]）
 * ------------------------------------------------------------------ */

function appendCompaction(session, { ids = [1, 2], native = true, compactionId = 'c1' } = {}) {
  const turn = native ? 3 : null;
  const start = session.append('compaction/start', {
    compactionId,
    turn,
    ...(native ? {} : { sourceCommandId: 'cmd-manual' }),
  });
  const summary = session.append('compaction/summary', {
    compactionId,
    shadowedSeqs: [...ids],
    shadowedRange: { start: ids[0], end: ids[ids.length - 1] },
  });
  session.append(
    'user/message',
    { role: 'user', content: '压缩摘要' },
    {
      surfaceOp: { op: 'replace', startSeq: ids[0], endSeq: ids[ids.length - 1] },
      sourceEventSeqs: [start.seq, summary.seq, ...ids],
    },
  );
  session.append('compaction/end', { compactionId });
  return { start, summary };
}

function sessionWithMessages(id = 'pin-session') {
  return new MockSession({
    id,
    cwd: undefined,
    agentPreset: undefined,
    events: [
      { type: 'user/message', data: { role: 'user', content: '第一条' } },
      { type: 'assistant/message', data: { role: 'assistant', content: '回复一' } },
      { type: 'user/message', data: { role: 'user', content: '第二条' } },
      { type: 'assistant/message', data: { role: 'assistant', content: '回复二' } },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * 1. pinHealthOf：live / stale / 原因
 * ------------------------------------------------------------------ */

test('pinHealth：都在 surface 上 → 全部 live、没有 stale', () => {
  const session = sessionWithMessages();
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1, 2], at: 1 });
  const health = pinHealthOf({ pinnedSeqs: [1, 2], surfaceSeqs: session.surface.nodes, log: session.log });
  assert.deepEqual(health.live, [1, 2]);
  assert.deepEqual(health.stale, []);
  assert.equal(health.cause, null);
  assert.deepEqual(health.causes, { native: 0, other: 0, unknown: 0 });
});

test('pinHealth：没有 pin 记录 → 空集合（不误报失效）', () => {
  const session = sessionWithMessages();
  const health = pinHealthOf({ pinnedSeqs: [], surfaceSeqs: session.surface.nodes, log: session.log });
  assert.deepEqual(health.live, []);
  assert.deepEqual(health.stale, []);
  assert.equal(health.cause, null);
});

test('pinHealth：原生自动压缩（compaction/start.turn≠null）移走 2 条 → cause=native', () => {
  const session = sessionWithMessages();
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1, 2], at: 1 });
  appendCompaction(session, { ids: [1, 2], native: true });

  const health = pinHealthOf({ pinnedSeqs: [1, 2], surfaceSeqs: session.surface.nodes, log: session.log });
  assert.deepEqual(health.live, []);
  assert.deepEqual(health.stale, [1, 2]);
  assert.equal(health.cause, 'native');
  assert.deepEqual(health.causes, { native: 2, other: 0, unknown: 0 });
});

test('pinHealth：插件/手动压缩（turn=null + sourceCommandId）→ cause=other（不冒充原生）', () => {
  const session = sessionWithMessages();
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1, 2], at: 1 });
  appendCompaction(session, { ids: [1, 2], native: false });

  const health = pinHealthOf({ pinnedSeqs: [1, 2], surfaceSeqs: session.surface.nodes, log: session.log });
  assert.deepEqual(health.stale, [1, 2]);
  assert.equal(health.cause, 'other');
  assert.deepEqual(health.causes, { native: 0, other: 2, unknown: 0 });
});

test('pinHealth：手动压缩但没带 sourceCommandId（插件菜单动作）→ 仍算 other，不冒充原生', () => {
  const session = sessionWithMessages();
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1], at: 1 });
  const start = session.append('compaction/start', { compactionId: 'c-manual', turn: null });
  const summary = session.append('compaction/summary', { compactionId: 'c-manual', shadowedSeqs: [1] });
  session.append('user/message', { role: 'user', content: '摘要' }, {
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
    sourceEventSeqs: [start.seq, summary.seq, 1],
  });
  session.append('compaction/end', { compactionId: 'c-manual' });

  const health = pinHealthOf({ pinnedSeqs: [1], surfaceSeqs: session.surface.nodes, log: session.log });
  assert.equal(health.cause, 'other', '有压缩证据就不能说「历史变化」');
  assert.deepEqual(health.causes, { native: 0, other: 1, unknown: 0 });
});

test('pinHealth：surface 变了但日志里没有覆盖它的 replace（撤销/分支）→ cause=unknown', () => {
  const session = sessionWithMessages();
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1, 2], at: 1 });
  // 只把 seq1 从 surface 拿掉，不留 replace 证据（模拟历史被改写但没有压缩事务）。
  session.surface.nodes = session.surface.nodes.filter((seq) => seq !== 1);

  const health = pinHealthOf({ pinnedSeqs: [1, 2], surfaceSeqs: session.surface.nodes, log: session.log });
  assert.deepEqual(health.live, [2]);
  assert.deepEqual(health.stale, [1]);
  assert.equal(health.cause, 'unknown', '没有压缩证据时不能归因成原生压缩');
  assert.deepEqual(health.causes, { native: 0, other: 0, unknown: 1 });
});

test('pinHealth：混合原因 → cause=mixed，计数分开给', () => {
  const session = sessionWithMessages();
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1, 2, 3], at: 1 });
  appendCompaction(session, { ids: [1], native: true });
  session.surface.nodes = session.surface.nodes.filter((seq) => seq !== 3);

  const health = pinHealthOf({ pinnedSeqs: [1, 2, 3], surfaceSeqs: session.surface.nodes, log: session.log });
  assert.deepEqual(health.live, [2]);
  assert.deepEqual(health.stale, [1, 3]);
  assert.equal(health.cause, 'mixed');
  assert.deepEqual(health.causes, { native: 1, other: 0, unknown: 1 });
});

/* ------------------------------------------------------------------ *
 * 2. nativeRetainTokensOf / nativePinnedRiskOf
 * ------------------------------------------------------------------ */

test('nativeRetainTokensOf：显式 retainTokens 优先；否则 messageBudget × retainRatio（宿主默认 0.16）', () => {
  assert.equal(
    nativeRetainTokensOf({ contextWindow: 1000, reservedCompletionTokens: 100, retainTokens: 128 }),
    128,
    '显式 retainTokens 直接生效',
  );
  assert.equal(
    nativeRetainTokensOf({ contextWindow: 1000, reservedCompletionTokens: 100, retainRatio: 0.2 }),
    180,
    'retainRatio 按 messageBudget（窗口 − 输出预留）折算',
  );
  assert.equal(nativeRetainTokensOf({ contextWindow: 1000, reservedCompletionTokens: 100 }), 144, '缺省 0.16');
  assert.equal(nativeRetainTokensOf({ contextWindow: null, reservedCompletionTokens: 0 }), null);
});

test('nativePinnedRiskOf：按 retainTokens 从尾部保留，范围内 pin 才报', () => {
  const nodes = [0, 1, 2, 3, 4, 5, 6, 7].map((seq) => ({ seq, heuristicTokens: 10 }));
  const risk = nativePinnedRiskOf({ pinnedSeqs: [2, 7], nodes, firstIdx: 0, retainTokens: 30 });
  assert.deepEqual(risk.seqs, [2], '尾部 3 条（5/6/7）保留，锁定 7 不在范围内；2 在范围内');
  assert.equal(risk.count, 1);
  assert.equal(risk.startSeq, 0);
  assert.equal(risk.endSeq, 4);
});

test('nativePinnedRiskOf：配对平衡回退会缩小覆盖（与宿主同口径）', () => {
  const nodes = [0, 1, 2, 3, 4, 5, 6, 7].map((seq) => ({ seq, heuristicTokens: 10 }));
  const risk = nativePinnedRiskOf({
    pinnedSeqs: [2, 4],
    nodes,
    firstIdx: 0,
    retainTokens: 20,
    // 尾部保留 2 条 → keepFromIdx=6（范围 [0..5]）；6/5 之前都不能切 → 回退到 4，
    // 范围缩成 [0..3]：锁定 4 被保留、锁定 2 仍会被压。
    isBalancedBefore: (seq) => seq !== 6 && seq !== 5,
  });
  assert.deepEqual(risk.seqs, [2]);
  assert.equal(risk.endSeq, 3);
});

test('nativePinnedRiskOf：没有 pin / 没有节点 / 保留整段 → null', () => {
  const nodes = [0, 1, 2].map((seq) => ({ seq, heuristicTokens: 10 }));
  assert.equal(nativePinnedRiskOf({ pinnedSeqs: [], nodes, retainTokens: 10 }), null);
  assert.equal(nativePinnedRiskOf({ pinnedSeqs: [0], nodes: [], retainTokens: 10 }), null);
  const risk = nativePinnedRiskOf({ pinnedSeqs: [0], nodes, firstIdx: 0, retainTokens: 1000 });
  assert.equal(risk, null, '保留预算 ≥ 全部节点 → 没有可压范围');
});

test('nativePinnedRiskOf：有 system head 时从下标 1 起（system 永不被压）', () => {
  const nodes = [0, 1, 2, 3, 4].map((seq) => ({ seq, heuristicTokens: 10 }));
  const risk = nativePinnedRiskOf({ pinnedSeqs: [0, 1, 4], nodes, firstIdx: 1, retainTokens: 10 });
  // 尾部保留 seq4 → 范围 [1..3]；0 是 system（不在范围），1 在范围，4 被保留。
  assert.deepEqual(risk.seqs, [1]);
});

/* ------------------------------------------------------------------ *
 * 3. readState：pins.stale / pins.atRisk / sessionPinned
 * ------------------------------------------------------------------ */

const baseCfg = resolveConfig({ retention: { recentTailTokens: 0 } });
const engine = {
  isCompactCheckpointSource: () => false,
  toolPairingBalancedBefore: () => true,
  toolPairingBalancedAfter: () => true,
};

function depsOf({ session, agent, pinnedSessionIds, nativeConfig, tokenMeter } = {}) {
  return {
    ctx: {
      tokenMeter:
        tokenMeter ??
        {
          measure(target) {
            const nodes = target.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 }));
            return { totalTokens: nodes.length * 100, surfaceTokens: nodes.length * 100, nodes };
          },
        },
      llm: {
        async resolveModelInfo() {
          return { context: { contextWindow: 100_000 }, defaultMaxTokens: 0 };
        },
      },
      get(name) {
        if (name !== 'workspaceRegistry') return undefined;
        return {
          get pinnedSessionIds() {
            return Array.isArray(pinnedSessionIds) ? pinnedSessionIds : [];
          },
          archivedSessionIds: [],
        };
      },
      agents: {
        get: (id) => (agent !== undefined && agent.id === id ? agent : undefined),
        list: () => (agent === undefined ? [] : [agent]),
      },
      sessions: {
        get: (id) => (session !== undefined && session.id === id ? session : undefined),
        flush() {},
      },
    },
    cfg: baseCfg,
    lock: createLock(),
    engine,
    ...(nativeConfig === undefined ? {} : { nativeConfig }),
  };
}

test('readState：pins.stale 标注被原生压缩移除的 pin（count/seqs/native 计数）', async () => {
  const session = sessionWithMessages('state-stale');
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1, 2], at: 1 });
  appendCompaction(session, { ids: [1, 2], native: true });

  const state = await readState(depsOf({ session }), { sessionId: session.id });
  assert.equal(state.pins.count, 0, '既有 pins.count 仍是 live 集合（老客户端语义不变）');
  assert.deepEqual(state.pins.stale, { count: 2, seqs: [1, 2], native: 2, other: 0, unknown: 0 });
  assert.equal(state.pins.atRisk, null, '当前没到原生线 → 没有预判覆盖');
});

test('readState：sessionPinned 读宿主 registry 置顶集合（读不到 → null）', async () => {
  const session = sessionWithMessages('state-pinned');
  const pinned = await readState(depsOf({ session, pinnedSessionIds: [session.id] }), { sessionId: session.id });
  assert.equal(pinned.sessionPinned, true);

  const notPinned = await readState(depsOf({ session, pinnedSessionIds: [] }), { sessionId: session.id });
  assert.equal(notPinned.sessionPinned, false);

  const unknown = await readState(
    { ...depsOf({ session }), ctx: { ...depsOf({ session }).ctx, get: () => undefined } },
    { sessionId: session.id },
  );
  assert.equal(unknown.sessionPinned, null, '宿主读不到置顶集合 → null（不猜 false）');
});

test('readState：到原生触发线时 pins.atRisk = 下一次原生压缩会覆盖的 pin', async () => {
  const session = sessionWithMessages('state-risk');
  // 路由/窗口单独一套，避免与其它用例的模型缓存串味。
  session.requestHeader = () => ({ config: { provider: 'risk-provider', model: 'risk-model' } });
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1, 2], at: 1 });

  const tokenMeter = {
    measure(target) {
      // 6 条 × 100 = 600 tokens；原生线 500（1000 × 0.5）。
      const nodes = target.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 }));
      return { totalTokens: nodes.length * 100, surfaceTokens: nodes.length * 100, nodes };
    },
  };
  const nativeConfig = { autoEnabled: true, thresholdRatio: 0.5, headroomTokens: 0, modelPolicies: [] };
  const ctxSession = new MockSession({
    id: 'state-risk',
    cwd: undefined,
    agentPreset: undefined,
    events: [
      { type: 'system/message', data: { message: { role: 'system', content: [] } } },
      ...[1, 2, 3, 4, 5].map((index) => ({ type: 'user/message', data: { role: 'user', content: `第 ${index} 条` } })),
    ],
  });
  ctxSession.requestHeader = () => ({ config: { provider: 'risk-provider', model: 'risk-model' } });
  ctxSession.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1, 2], at: 1 });

  const deps = depsOf({ session: ctxSession, tokenMeter, nativeConfig });
  deps.ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 1000 }, defaultMaxTokens: 0 });
  const state = await readState(deps, { sessionId: ctxSession.id });

  // retainTokens = (1000 − 0) × 0.16 = 160 → 尾部保留 2 条（100+100≥160），范围 [0..3]（system 头跳过 → 1..3），
  // 锁定 1 在范围内、2 也在范围内（range [1..3] 含 2）。
  assert.deepEqual(state.pins.atRisk.seqs, [1, 2]);
  assert.equal(state.pins.atRisk.count, 2);
  assert.equal(state.native.autoEnabled, true);
});

test('readState：原生自动压缩关闭 / 未到线 → pins.atRisk=null（不制造噪音）', async () => {
  const session = sessionWithMessages('state-risk-off');
  session.requestHeader = () => ({ config: { provider: 'risk-off', model: 'risk-off-model' } });
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1], at: 1 });
  const tokenMeter = {
    measure(target) {
      const nodes = target.surface.nodes.map((seq) => ({ seq, heuristicTokens: 10 }));
      return { totalTokens: nodes.length * 10, surfaceTokens: nodes.length * 10, nodes };
    },
  };
  const deps = depsOf({
    session,
    tokenMeter,
    nativeConfig: { autoEnabled: false, thresholdRatio: 0.5, headroomTokens: 0, modelPolicies: [] },
  });
  const state = await readState(deps, { sessionId: session.id });
  assert.equal(state.pins.atRisk, null);

  const depsOn = depsOf({
    session,
    tokenMeter,
    nativeConfig: { autoEnabled: true, thresholdRatio: 0.5, headroomTokens: 0, modelPolicies: [] },
  });
  const notYet = await readState(depsOn, { sessionId: session.id });
  assert.equal(notYet.pins.atRisk, null, '压力远低于线时不要预判');
});

/* ------------------------------------------------------------------ *
 * 4. compaction-basic 配置：retainRatio / retainTokens 解析（预判的数据源）
 * ------------------------------------------------------------------ */

test('native-compaction 解析：retainRatio/retainTokens 只认 config 直属子键，modelPolicies 可按路由覆盖', () => {
  const text = [
    '- id: compaction-basic',
    '  config:',
    '    auto: true',
    '    thresholdRatio: 0.7',
    '    retainRatio: 0.2',
    '    modelPolicies:',
    '      - provider: mac-unc',
    '        model: qwen35',
    '        thresholdRatio: 0.5',
    '        retainTokens: 4096',
    '    nested:',
    '      retainRatio: 0.9',
  ].join('\n');
  const override = parseCompactionOverride(text);
  assert.equal(override.retainRatio, 0.2, '直属 retainRatio 生效');
  assert.equal(override.retainTokens, undefined, '没有直属 retainTokens');
  const policies = parseModelPolicies(text);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].retainTokens, 4096, '路由级 retainTokens 被解析');
  const route = resolveNativePolicy(
    { thresholdRatio: 0.7, headroomTokens: 0, retainRatio: 0.2, modelPolicies: policies },
    { provider: 'mac-unc', model: 'qwen35' },
  );
  assert.equal(route.thresholdRatio, 0.5);
  assert.equal(route.retainTokens, 4096, '路由覆盖保留预算');
  assert.equal(route.retainRatio, 0.2, '未覆盖的保留比值沿用全局');
});

test('native-compaction 解析：显式 retainTokens 与 retainRatio 并存时，宿主以 retainTokens 为准', () => {
  const text = ['- id: compaction-basic', '  config:', '    retainRatio: 0.2', '    retainTokens: 512'].join('\n');
  const override = parseCompactionOverride(text);
  assert.equal(override.retainRatio, 0.2);
  assert.equal(override.retainTokens, 512);
  assert.equal(
    nativeRetainTokensOf({ contextWindow: 1000, reservedCompletionTokens: 0, retainRatio: 0.2, retainTokens: 512 }),
    512,
  );
});

test('togglePin：pin 全部失效时点菜单是「清空记录」，不会反过来新锁一条', () => {
  const session = sessionWithMessages('toggle-stale');
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1, 2], at: 1 });
  appendCompaction(session, { ids: [1, 2], native: true });
  const deps = {
    engine: {
      appendPluginRecord(target, type, data) {
        return target.appendPluginRecord(type, data);
      },
    },
  };
  const outcome = togglePin(deps, { agent: { session } });
  // 旧实现：live=0 → pinLastTurn（又锁一条）；新实现：快照非空 → unpinAll（写 seqs: []）。
  assert.equal(outcome.pinned.length, 0, `应清空而不是新锁：${JSON.stringify(outcome)}`);
  assert.deepEqual(latestPinnedSeqs(session.log), [], '最新 pin 记录应是空集合');
});

/* ------------------------------------------------------------------ *
 * 运行
 * ------------------------------------------------------------------ */

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} PASS`);
if (failed > 0) process.exit(1);
