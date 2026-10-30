/**
 * 0.5.6 Phase B 任务 1：泄压阀可见化 —— 服务端数据面单测。
 *
 *   node test/release-valve.mjs
 *
 * 背景：摘要份数达到 maxSummaries 后，`compactionPolicy` 打开「合并旧摘要」分支，
 * 压缩范围从「最后一个 checkpoint 之后」跳到「会话开头」。0.5.5 及以前这个开关
 * 没有任何事前标识（预览只有数字，没有「本次是否合并」）。本批只加语义，不改判定。
 *
 * 锁住六件事：
 *   T1 跨阈值范围跳变：n=5 常规（2 条 / startSeq=24），n=6 合并（18 条 / startSeq=3）；
 *   T2 阈值语义（防差一次）：max−1 份时 merges 必须 false（再压一次才是第 max 份常规摘要）；
 *   T3 单向棘轮：越过阈值后 merges 持续 true，且 countSummaries 不随合并减少；
 *   T4 preview 契约 additive：merge 四字段、5/6 份键集合一致、message 只在合并时带语义前缀；
 *   T5 maxSummaries=1 特例与「不限」（0）语义：0 份不出现分数；0=不限永远 false；
 *   T6 state.compactRange.merge 与 preview.merge 同值（同一份 mergeValveOf 口径）。
 *
 * 纯 node、零依赖：夹具是纯对象（不依赖 MockSession / 真机）；DSH_HOME 指到临时目录，
 * 不读写真实 ~/.dsh；不调 LLM、零网络。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLock } from '../lib/actions/lock.js';
import { previewBetterCompact } from '../lib/actions/better-compact.js';
import { readState } from '../lib/actions/state.js';
import { resolveConfig } from '../lib/config.js';
import { compactionPolicy, mergeValveOf } from '../lib/core/policy.js';
import { countSummaries } from '../lib/dsh/session-view.js';
import { selectCompactableRange } from '../lib/dsh/select-range.js';

// 收藏文件等落临时目录（defaultDshHome 在调用时读 env，import 之后设置也生效）。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-release-valve-'));
process.env.DSH_HOME = tmpHome;

/* ------------------------------------------------------------------ *
 * 1. 夹具：n 份「已提交摘要」的会话（与 task-1 §4.1 的 R1 同构）
 *
 * 每份已提交摘要 = compaction/summary + 无 error 的 compaction/end + 覆盖
 * summary.seq 的 replace（最后一条 user/message，sourceEventSeqs 指向 summary）。
 * 最后一次 checkpoint 之后压 2 条助手消息，所以常规压缩范围是 2 条；
 * 合并时 from firstIdx（system 之后第一条 = seq 3）到尾部，共 3n 条。
 * ------------------------------------------------------------------ */

function buildSession(n) {
  const log = [];
  const surface = [];
  log.push({ seq: 0, type: 'system/message', data: {} });
  surface.push(0);
  for (let i = 1; i <= n; i += 1) {
    const base = log.length;
    log.push({ seq: base, type: 'compaction/summary', data: { compactionId: `c${i}` } });
    log.push({ seq: base + 1, type: 'compaction/end', data: { compactionId: `c${i}` } });
    const checkpoint = base + 2;
    log.push({
      seq: checkpoint,
      type: 'user/message',
      data: { source: { kind: 'compact-checkpoint' } },
      sourceEventSeqs: [base],
    });
    surface.push(checkpoint);
    for (let k = 0; k < 2; k += 1) {
      const seq = log.length;
      log.push({ seq, type: 'assistant/message', data: {} });
      surface.push(seq);
    }
  }
  return {
    id: `session-valve-${n}`,
    log,
    surface: { nodes: surface },
    eventAt(seq) {
      return this.log[seq];
    },
  };
}

const engine = {
  isCompactCheckpointSource: (source) => source?.kind === 'compact-checkpoint',
  toolPairingBalancedBefore: () => true,
  toolPairingBalancedAfter: () => true,
};
const tokenMeter = {
  measure(session) {
    const nodes = session.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 }));
    return { totalTokens: nodes.length * 100, surfaceTokens: nodes.length * 100, nodes };
  },
};
const llm = {
  async resolveModelInfo() {
    return { context: { contextWindow: 200_000 } };
  },
};
const cfg = resolveConfig({ retention: { recentTailTokens: 0 } });

/** 预览 deps：只够 previewBetterCompact 跑选段/文案（不写任何东西）。 */
function previewDeps() {
  return {
    ctx: { tokenMeter, llm },
    cfg,
    lock: createLock(),
    engine,
  };
}

/** 对同一夹具再跑一次 selectCompactableRange（纯服务端，不经过预览包装）。 */
function rangeOf(session) {
  return selectCompactableRange({
    session,
    nodes: session.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 })),
    engine,
    cfg,
    tokenOf: (node) => node.heuristicTokens,
  });
}

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/* ------------------------------------------------------------------ *
 * 2. T1–T6
 * ------------------------------------------------------------------ */

test('T1 跨阈值范围跳变：n=5 常规 2 条 / n=6 合并 18 条（startSeq 24 → 3）', async () => {
  const five = buildSession(5);
  const six = buildSession(6);
  assert.equal(countSummaries(five), 5, '夹具口径：n=5 应数出 5 份已提交摘要');
  assert.equal(countSummaries(six), 6, '夹具口径：n=6 应数出 6 份已提交摘要');

  const fiveRange = rangeOf(five);
  const sixRange = rangeOf(six);
  assert.equal(fiveRange.shadowedSeqs.length, 2, 'n=5：只压 checkpoint 之后的 2 条');
  assert.equal(fiveRange.startSeq, 24, 'n=5：起点是最后一次 checkpoint 之后');
  assert.equal(sixRange.shadowedSeqs.length, 18, 'n=6：从会话开头合并，范围 18 条');
  assert.equal(sixRange.startSeq, 3, 'n=6：起点跳到会话头之后第一条');

  const fiveOutcome = await previewBetterCompact(previewDeps(), { agent: { id: five.id, session: five } });
  const sixOutcome = await previewBetterCompact(previewDeps(), { agent: { id: six.id, session: six } });
  assert.equal(fiveOutcome.preview.merge.merges, false, 'n=5（max−1）绝不能是合并');
  assert.equal(fiveOutcome.preview.nodes, 2);
  assert.equal(sixOutcome.preview.merge.merges, true, 'n=6（到 max）必须是合并');
  assert.equal(sixOutcome.preview.nodes, 18);
  assert.equal(sixOutcome.preview.startSeq, 3);
});

test('T2 阈值语义（防差一次）：max−1 份 merges=false、到 max 才 true、n=4 还剩 2 次', () => {
  const thresholds = { maxSummaries: 6 };
  const five = mergeValveOf({ summaries: 5, thresholds });
  const six = mergeValveOf({ summaries: 6, thresholds });
  const four = mergeValveOf({ summaries: 4, thresholds });

  // 清单原文「max−1 份时再压一次会合并」差一次：第 6 次压缩开始时是 5 份，仍是常规压缩。
  assert.equal(five.merges, false, 'max−1 份时 merges 必须为 false（钉死「差一次」）');
  assert.equal(five.normalLeft, 1, 'max−1 份时还剩最后 1 次常规压缩');
  assert.equal(six.merges, true, '达到 max 份时 merges 必须为 true');
  assert.equal(six.normalLeft, 0);
  assert.equal(four.merges, false);
  assert.equal(four.normalLeft, 2);
  assert.deepEqual(five, { merges: false, normalLeft: 1, summaries: 5, maxSummaries: 6 });
  // compactionPolicy 与 mergeValveOf 同一份判定，不允许两套口径漂移。
  assert.equal(compactionPolicy({ summaries: 5, thresholds }).allowMergeOldSummaries, false);
  assert.equal(compactionPolicy({ summaries: 6, thresholds }).allowMergeOldSummaries, true);
});

test('T3 单向棘轮：n=7 仍 merges=true，countSummaries 不随合并减少', () => {
  const six = buildSession(6);
  const seven = buildSession(7);
  assert.equal(mergeValveOf({ summaries: 7, thresholds: { maxSummaries: 6 } }).merges, true, '打开后不会回到 false');
  assert.equal(countSummaries(seven) >= countSummaries(six), true, '份数是历史提交次数口径，单调不减');
  assert.equal(countSummaries(seven), 7);

  const sevenRange = rangeOf(seven);
  assert.equal(sevenRange.startSeq, 3, 'n=7：仍然从会话开头');
  assert.equal(sevenRange.shadowedSeqs.length, 21);
});

test('T4 preview 契约 additive：merge 四字段 + 键集合一致 + 只在合并时改 message', async () => {
  const five = buildSession(5);
  const six = buildSession(6);
  const fiveOutcome = await previewBetterCompact(previewDeps(), { agent: { id: five.id, session: five } });
  const sixOutcome = await previewBetterCompact(previewDeps(), { agent: { id: six.id, session: six } });

  assert.deepEqual(
    Object.keys(fiveOutcome.preview).sort(),
    Object.keys(sixOutcome.preview).sort(),
    'n=5/n=6 预览键集合必须一致（只有数字跳变是 0.5.5 的问题）',
  );
  assert.ok(Object.hasOwn(fiveOutcome.preview, 'merge'), 'preview 必须有 additive 的 merge 字段');

  for (const outcome of [fiveOutcome, sixOutcome]) {
    const merge = outcome.preview.merge;
    assert.equal(typeof merge.merges, 'boolean');
    assert.equal(typeof merge.summaries, 'number');
    assert.equal(typeof merge.maxSummaries, 'number');
    assert.ok(merge.normalLeft === null || typeof merge.normalLeft === 'number', 'normalLeft = number|null（不限时为 null）');
  }

  assert.equal(fiveOutcome.message.includes('合并压缩'), false, 'n=5 是常规压缩，message 不能提合并');
  assert.equal(fiveOutcome.message.includes('下一次'), false, '文案不许用「下一次」（阀是之后每次）');
  assert.ok(sixOutcome.message.includes('从会话开头'), 'n=6 的 message 必须明说从会话开头');
  assert.ok(sixOutcome.message.includes('6/6'), 'n=6 的 message 必须带 6/6 份数');
  assert.ok(sixOutcome.message.startsWith('本次是合并压缩'), '合并说明置前，不能只出现在尾缀');
  assert.ok(sixOutcome.message.includes('压缩预估'), '原有「压缩预估」信息必须保留');
});

test('T5 maxSummaries=1 特例与「不限」：0 份不出现分数；max=0 永远不合并', () => {
  const one = resolveConfig({ thresholds: { maxSummaries: 1 } });
  assert.equal(one.thresholds.maxSummaries, 1, 'maxSummaries=1 是合法配置');

  const zero = mergeValveOf({ summaries: 0, thresholds: one.thresholds });
  assert.equal(zero.merges, false, '0 份当然不合并');
  assert.equal(zero.normalLeft, 1);
  assert.equal(zero.summaries, 0);

  // max=0 = 不限：永远不打开泄压阀，也没有「还剩几次」的有限上限。
  const unlimited = mergeValveOf({ summaries: 99, thresholds: { maxSummaries: 0 } });
  assert.equal(unlimited.merges, false, 'maxSummaries=0（不限）时 merges 必须永远为 false');
  assert.equal(unlimited.normalLeft, null, '不限时 normalLeft 为 null（不是 Infinity，JSON 可序列化）');
  assert.equal(unlimited.maxSummaries, 0);
  assert.equal(compactionPolicy({ summaries: 99, thresholds: { maxSummaries: 0 } }).allowMergeOldSummaries, false);

  return (async () => {
    const empty = buildSession(0);
    const outcome = await previewBetterCompact(previewDeps(), { agent: { id: empty.id, session: empty } });
    assert.equal(outcome.preview, null, '0 份没有可压范围');
    assert.equal(outcome.message.includes('合并'), false, '0 份时 message 不能出现合并字样/分数');
  })();
});

test('T6 state.compactRange.merge 与 preview.merge 同值（同一份 mergeValveOf 口径）', async () => {
  const session = buildSession(6);
  const agent = { id: session.id, session };
  const nativeConfig = { autoEnabled: false, thresholdRatio: 0.8, headroomTokens: 65_536, modelPolicies: [] };
  const state = await readState(
    {
      ctx: {
        tokenMeter,
        llm,
        get: () => undefined,
        agents: { get: (id) => (id === agent.id ? agent : undefined), list: () => [agent] },
        sessions: { get: (id) => (id === session.id ? session : undefined), flush() {} },
      },
      cfg,
      lock: createLock(),
      engine,
      nativeConfig,
    },
    { agent },
  );
  const outcome = await previewBetterCompact(previewDeps(), { agent });

  assert.notEqual(state.compactRange, null, '夹具应有可压范围');
  assert.deepEqual(state.compactRange.merge, outcome.preview.merge, 'state 与 preview 的泄压阀结论必须一致');
  assert.equal(state.compactRange.merge.merges, true);
  assert.equal(state.compactRange.merge.summaries, 6);
  assert.equal(state.compactRange.merge.maxSummaries, 6);
  assert.equal(state.compactRange.nodes, 18, 'state.compactRange 仍是既有四个字段 + merge（additive）');

  // 老字段原样：合并判定不改变 state 的既有形状。
  assert.deepEqual(Object.keys(state.compactRange).sort(), ['endSeq', 'merge', 'nodes', 'startSeq', 'tokens']);
});

/* ------------------------------------------------------------------ *
 * 3. 执行
 * ------------------------------------------------------------------ */

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(error);
  }
}
console.log(`\nrelease-valve：${cases.length - failed}/${cases.length} 通过`);
if (failed > 0) process.exit(1);
