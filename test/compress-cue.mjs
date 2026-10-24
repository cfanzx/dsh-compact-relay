/**
 * 0.3.4 / 0.4 P0-1 单测：可压缩区间 cue（纯函数 + 文案 v2）+ 注入门控 + state-hub 缓存 + prompt 适配。
 *
 * 0.4 P0-1 新增用例（方案 §4）：
 *   U1  文案 v2：4 个完成信号关键词 + 「被拒绝不会改动历史」；不含「不确定就不用调」
 *   U2  门控：0.08 不注入 / 0.12 注入 / 0.40（压缩线）不注入 / 0.45 不注入；
 *       连续 2 轮不注入、第 4 轮再注入（距上次注入 ≥ CUE_MIN_TURNS=3 轮）
 *   U3  门控不改变「无 agent 不注入」「同一轮不重复注入」；异常安全不变
 *   U6  原有 compress-cue / state-hub / prompt 断言随新文案与新区间同步更新
 *
 * cue 是模型「这里适合压缩」判断的唯一可执行条件来源，边界/节流/异常安全都要锁住；
 * 缓存是 systemPrompt 同步回调的数据源，必须证明「没有 SSE 订阅者也会更新」。
 */
import assert from 'node:assert/strict';
import {
  BUCKET_RATIO,
  HINT_SUPPRESS_RATIO,
  bucketRatio,
  compressCueText,
  cueBandOf,
  formatPercent,
  inCompressCueBand,
} from '../lib/core/compress-cue.js';
import {
  CUE_MAX_RATIO,
  CUE_MIN_RATIO,
  CUE_MIN_TURNS,
  compressionMinRatio,
} from '../lib/core/policy.js';
import { createStateHub } from '../lib/dsh/state-hub.js';
import { createDiagCounters } from '../lib/dsh/diag-counters.js';
import { compressCueFor, registerCompressCue, resetCueTurns } from '../lib/adapters/prompt.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 默认门控区间（1M 窗口 + 保留 40K → 动态最小线 4.4% → 被 10% 下限覆盖）。 */
const BAND = cueBandOf({ compactRatio: 0.4, dynamicMinRatio: 0.05 });

/* ================================================================== *
 * U2 门控常量与区间：10%–40%、不含压缩线；边界取值
 * ================================================================== */

assert.equal(CUE_MIN_RATIO, 0.1, 'cue 下限常量 10%');
assert.equal(CUE_MAX_RATIO, 0.4, 'cue 上限常量 40%');
assert.equal(CUE_MIN_TURNS, 3, '注入限频：距上次注入 ≥3 轮');
assert.deepEqual(BAND, { minRatio: 0.1, maxRatio: 0.4 });

// 区间 = max(10%, 动态最小线) .. min(40%, 压缩线)
assert.deepEqual(cueBandOf({ compactRatio: 0.4, dynamicMinRatio: 0.05 }), { minRatio: 0.1, maxRatio: 0.4 });
assert.deepEqual(cueBandOf({ compactRatio: 0.25, dynamicMinRatio: 0.05 }), { minRatio: 0.1, maxRatio: 0.25 }, '用户压缩线更低时上头跟着收');
assert.deepEqual(cueBandOf({ compactRatio: 0.4, dynamicMinRatio: 0.22 }), { minRatio: 0.22, maxRatio: 0.4 }, '小窗口动态最小线抬高下限');
assert.deepEqual(cueBandOf({}), { minRatio: 0.1, maxRatio: 0.4 }, '缺参时回落默认区间');

// U2 边界：0.08 不注入 / 0.12 注入 / 0.45 不注入；压缩线本身不注入（工具会拒绝）。
assert.equal(inCompressCueBand({ ratio: 0.08, ...BAND }), false);
assert.equal(inCompressCueBand({ ratio: 0.1, ...BAND }), true, '下限本身可注入（≥）');
assert.equal(inCompressCueBand({ ratio: 0.12, ...BAND }), true);
assert.equal(inCompressCueBand({ ratio: 0.3999, ...BAND }), true);
assert.equal(inCompressCueBand({ ratio: 0.4, ...BAND }), false, '压缩线本身不注入（到线该直接建议压缩）');
assert.equal(inCompressCueBand({ ratio: 0.45, ...BAND }), false);
assert.equal(inCompressCueBand({ ratio: Number.NaN, ...BAND }), false);
assert.equal(inCompressCueBand({ ratio: 0.2, minRatio: Number.NaN, maxRatio: 0.4 }), false);
assert.equal(inCompressCueBand({ ratio: 0.2, minRatio: 0.4, maxRatio: 0.3 }), false, '非法区间（min>max）不注入');
// 用户把压缩线配到 10% 以下：区间为空，永不注入（不会诱导注定被拒的调用）。
assert.equal(inCompressCueBand({ ratio: 0.08, ...cueBandOf({ compactRatio: 0.08, dynamicMinRatio: 0.05 }) }), false);

/* ================================================================== *
 * 5% 桶 / 百分比格式：提示要稳定，不能每个 token 都变
 * ================================================================== */

assert.equal(BUCKET_RATIO, 0.05);
assert.equal(bucketRatio(0.32), 0.3);
assert.equal(bucketRatio(0.399), 0.35);
assert.equal(bucketRatio(0.05), 0.05);
assert.equal(bucketRatio(0), 0);
assert.equal(bucketRatio(1), 1);
assert.equal(bucketRatio(Number.NaN), 0);
assert.equal(bucketRatio(1.7), 1, '超界比例先夹到 1 再取桶');
assert.equal(formatPercent(0.05), '5');
assert.equal(formatPercent(0.325), '32.5');
assert.equal(formatPercent(0.4), '40');
assert.equal(formatPercent(Number.NaN), '?');
// 动态下限可能是 33.569%：展示值向上取整，避免「约 30%（区间 33.6%–40%）」自相矛盾。
assert.equal(formatPercent(0.33568), '33.6');
assert.equal(formatPercent(0.3351), '33.6', '33.51% 向上取整到 33.6（四舍五入会得到 33.5，可能低于真实下限）');

/* ================================================================== *
 * U1 文案 v2：4 个完成信号 + 被拒无副作用；不含旧的「不确定就不用调」
 * ================================================================== */

const CUE_SIGNALS = ['功能已实现并验证', '文档已交付', '问题已定位并修复', '准备交接'];
const cue = compressCueText({ ratio: 0.32, ...BAND, compressHint: null });
assert.equal(typeof cue, 'string');
assert.equal(cue.includes('mark_compress_point'), true, '提示要告诉模型调用哪个工具');
for (const signal of CUE_SIGNALS) {
  assert.equal(cue.includes(signal), true, `文案 v2 缺少完成信号：${signal}`);
}
assert.equal(cue.includes('被拒绝不会改动历史'), true, '要明确「被拒零副作用」');
assert.equal(cue.includes('不处于阶段收尾就不用管这句'), true, '保留边界：不处于阶段收尾不用硬凑');
assert.equal(cue.includes('不确定就不用调'), false, '旧文案的保守措辞不能残留（H1：让模型倾向跳过）');
assert.equal(cue.includes('上下文容量约 30%'), true, '容量按 5% 桶：32% → 30%');
assert.equal(cue.includes('可压缩区间 10%–40%'), true, '区间文案用门控区间');

// 区间外/非法输入：空串（宿主不展示空 context）。
assert.equal(compressCueText({ ratio: 0.02, ...BAND }), '');
assert.equal(compressCueText({ ratio: 0.08, ...BAND }), '');
assert.equal(compressCueText({ ratio: 0.4, ...BAND }), '');
assert.equal(compressCueText({ ratio: 0.45, ...BAND }), '');
assert.equal(compressCueText({ ratio: Number.NaN, ...BAND }), '');
assert.equal(compressCueText({ ratio: 0.2, minRatio: 0.3, maxRatio: 0.2 }), '');

// 刚记过 hint：容量只涨 <10pp 不重复提醒；超过或数据非法照常提示。
assert.equal(HINT_SUPPRESS_RATIO, 0.1);
assert.equal(
  compressCueText({ ratio: 0.32, ...BAND, compressHint: { ratio: 0.25 } }),
  '',
  '刚记过 hint（差 7pp < 10pp）不重复提醒',
);
assert.equal(
  compressCueText({ ratio: 0.32, ...BAND, compressHint: { ratio: 0.2 } }).length > 0,
  true,
  '差 12pp 已超过抑制窗口，重新提示',
);
assert.equal(
  compressCueText({ ratio: 0.32, ...BAND, compressHint: { ratio: Number.NaN } }).length > 0,
  true,
  'hint 数据非法时按「没有 hint」处理',
);

/* ================================================================== *
 * 动态最小线：小窗口 + 保留近期原文时，下限会抬到 10% 以上（区间与显示一致）
 * ================================================================== */

assert.equal(compressionMinRatio({ minRatio: 0.05 }, { recentTailTokens: 0 }, 1_000_000), 0.05);
const dynamicMin = compressionMinRatio({ minRatio: 0.05 }, { recentTailTokens: 40_000 }, 200_000);
assert.equal(dynamicMin, 0.22, '(40K 保留 + 4K 最小可压) / 200K = 22%');
const dynamicBand = cueBandOf({ compactRatio: 0.4, dynamicMinRatio: dynamicMin });
assert.deepEqual(dynamicBand, { minRatio: 0.22, maxRatio: 0.4 });
assert.equal(compressCueText({ ratio: 0.2, ...dynamicBand }), '', '20% 低于动态最小线 22%，不提示');
const dynamicCue = compressCueText({ ratio: 0.22, ...dynamicBand });
assert.equal(dynamicCue.length > 0, true, '22% 在区间内要提示');
assert.equal(dynamicCue.includes('22%'), true, '提示里显示的是动态最小线');
assert.equal(dynamicCue.includes('可压缩区间 22%–40%'), true, '区间文案与动态下限一致');

// 审计修正（2026-10-24）：显示值必须 clamp 到区间下限，且解析出的「约 N%」≥ minRatio。
// 覆盖 128K / 200K / 256K 三种窗口下的动态下限（128K + 40K 保留时 minRatio≈33.569%，
// 旧实现 5% 桶会把 33.7% 显示成「约 30%」，与同一句的区间下限矛盾）。
for (const window of [128 * 1024, 200 * 1024, 256 * 1024]) {
  const minRatio = compressionMinRatio({ minRatio: 0.05 }, { recentTailTokens: 40_000 }, window);
  const loopBand = cueBandOf({ compactRatio: 0.4, dynamicMinRatio: minRatio });
  const ratios = [
    loopBand.minRatio,
    loopBand.minRatio + 0.001,
    loopBand.minRatio + 0.02,
    (loopBand.minRatio + loopBand.maxRatio) / 2,
    loopBand.maxRatio - 0.0001,
  ];
  for (const ratio of ratios) {
    const text = compressCueText({ ratio, ...loopBand, compressHint: null });
    assert.equal(text.length > 0, true, `窗口 ${window} 比例 ${ratio} 应提示`);
    const shown = /约 ([\d.]+)%/.exec(text);
    const lower = /可压缩区间 ([\d.]+)%/.exec(text);
    assert.notEqual(shown, null, '提示里应有「约 N%」');
    assert.notEqual(lower, null, '提示里应有区间下限');
    assert.equal(
      Number(shown[1]) / 100 >= loopBand.minRatio - 1e-9,
      true,
      `窗口 ${window} 比例 ${ratio}：显示值 ${shown[1]}% 不能低于真实下限 ${(loopBand.minRatio * 100).toFixed(4)}%`,
    );
    assert.equal(
      Number(shown[1]) >= Number(lower[1]),
      true,
      `窗口 ${window} 比例 ${ratio}：显示值 ${shown[1]}% 不能低于同一句的区间下限 ${lower[1]}%`,
    );
  }
}

/* ================================================================== *
 * U3 / U2 prompt 适配：门控（区间 + 轮次限频）、异常安全、无 agent 不注入
 * ================================================================== */

const deps = {
  cfg: { thresholds: { compactRatio: 0.4, minRatio: 0.05 }, retention: { recentTailTokens: 40_000 } },
};
const ratioOfSession = new Map([
  ['s1', 0.32],
  ['low', 0.08],
  ['mid', 0.12],
  ['line', 0.4],
  ['high', 0.45],
]);
const fakeHub = {
  latestState: (id) =>
    ratioOfSession.has(id)
      ? { ratio: ratioOfSession.get(id), window: 1_000_000, compressHint: null }
      : undefined,
};
const cueOf = (id) => compressCueFor({ context: { agent: { session: { id } } }, deps, hub: fakeHub });

// U3：无 agent / 缓存缺失 / 配置缺失 / 窗口非法 → 一律 ''（行为不变）。
resetCueTurns();
assert.equal(compressCueFor({ context: undefined, deps, hub: fakeHub }), '');
assert.equal(compressCueFor({ context: {}, deps, hub: fakeHub }), '');
assert.equal(cueOf('unknown'), '', '缓存没有就返回空串');
assert.equal(
  compressCueFor({ context: { agent: { session: { id: 's1' } } }, deps: { cfg: {} }, hub: fakeHub }),
  '',
  '配置缺字段返回空串',
);
assert.equal(
  compressCueFor({
    context: { agent: { session: { id: 's1' } } },
    deps,
    hub: { latestState: () => ({ ratio: 0.32, window: 0, compressHint: null }) },
  }),
  '',
  '缓存里窗口非法返回空串',
);
assert.equal(
  compressCueFor({
    context: {
      get agent() {
        throw new Error('boom');
      },
    },
    deps,
    hub: fakeHub,
  }),
  '',
  '任何异常都必须返回空串，不能影响宿主组装 prompt',
);

// U2：区间门控 —— 0.08 不注入 / 0.12 注入 / 0.40（压缩线）不注入 / 0.45 不注入。
resetCueTurns();
assert.equal(cueOf('low').length, 0, '0.08 不注入');
resetCueTurns();
assert.equal(cueOf('mid').length > 0, true, '0.12 注入');
resetCueTurns();
assert.equal(cueOf('line').length, 0, '0.40 不注入（到压缩线该直接建议压缩）');
resetCueTurns();
assert.equal(cueOf('high').length, 0, '0.45 不注入');

// U2：轮次限频 —— 第 1 轮注入；第 2、3 轮不注入；第 4 轮再注入。
resetCueTurns();
const injectedTurns = [];
for (let round = 1; round <= 5; round += 1) {
  injectedTurns.push(cueOf('mid').length > 0);
}
assert.deepEqual(injectedTurns, [true, false, false, true, false], '距上次注入 ≥3 轮才再注入');

// U3：不同会话互不影响（限频按会话维度）。
resetCueTurns();
assert.equal(cueOf('mid').length > 0, true);
assert.equal(cueOf('s1').length > 0, true, '另一个会话的首轮不受前一个会话影响');

// U4（cue 侧）：实际注入一次 cueInjected +1；被门控挡下的轮次不计数。
const countedDeps = {
  ...deps,
  diag: createDiagCounters(),
};
resetCueTurns();
const countedCueOf = (id) =>
  compressCueFor({ context: { agent: { session: { id } } }, deps: countedDeps, hub: fakeHub });
for (let round = 1; round <= 4; round += 1) countedCueOf('mid');
assert.equal(countedDeps.diag.snapshot().counters.cueInjected, 2, '4 轮里只有第 1、4 轮真注入');
countedCueOf('low');
countedCueOf('high');
assert.equal(countedDeps.diag.snapshot().counters.cueInjected, 2, '区间外不注入也不计数');

// 没有 systemPrompt 服务：注册返回 undefined（不抛）；有服务则注册 name/order/text。
assert.equal(registerCompressCue({}, deps, fakeHub), undefined);
assert.equal(registerCompressCue({ systemPrompt: {} }, deps, fakeHub), undefined);
const registered = [];
const dispose = registerCompressCue(
  {
    systemPrompt: {
      context(definition) {
        registered.push(definition);
        return () => {};
      },
    },
  },
  deps,
  fakeHub,
);
assert.equal(typeof dispose, 'function');
assert.equal(registered.length, 1);
assert.equal(registered[0].name, 'compact-relay:compress-cue');
assert.equal(registered[0].order, 300);
assert.equal(typeof registered[0].text, 'function');
resetCueTurns();
const registeredText = registered[0].text({ agent: { session: { id: 's1' } } });
assert.equal(registeredText.includes('mark_compress_point'), true);
assert.equal(registeredText.includes('30%'), true);

/* ================================================================== *
 * state-hub：无 SSE 订阅者也更新缓存、150ms 防抖、卸载清理、异常安全
 * ================================================================== */

const states = new Map();
const hub = createStateHub({
  readState: async (sessionId) => {
    const entry = states.get(sessionId);
    if (entry === 'throw') throw new Error('measure boom');
    return entry;
  },
});
assert.equal(hub.latestState('s1'), undefined);
assert.equal(hub.latestState(''), undefined);

states.set('s1', { sessionId: 's1', ratio: 0.32, window: 200_000, compressHint: { ratio: 0.25, at: 1, seq: 9 }, colors: {} });
hub.onSessionEvent({ id: 's1' }, { type: 'user/message' });
await sleep(320);
assert.deepEqual(
  hub.latestState('s1'),
  { ratio: 0.32, window: 200_000, compressHint: { ratio: 0.25, at: 1, seq: 9 } },
  '没有 SSE 订阅者时也要缓存（systemPrompt 读它）',
);

// 会话还没加载/已卸载（state.sessionId 为空）→ 清掉旧缓存，避免提示读不存在的会话
states.set('s1', { sessionId: null, ratio: 0, window: 200_000, compressHint: null });
hub.onSessionEvent({ id: 's1' }, {});
await sleep(250);
assert.equal(hub.latestState('s1'), undefined);

// readState 抛错：不炸、不写缓存
states.set('s2', 'throw');
hub.onSessionEvent({ id: 's2' }, {});
await sleep(250);
assert.equal(hub.latestState('s2'), undefined);

// 同一会话 150ms 内多次事件 → 只算一次（防抖）
let calls = 0;
const hub2 = createStateHub({
  readState: async (sessionId) => {
    calls += 1;
    return { sessionId, ratio: 0.2, window: 100_000, compressHint: null };
  },
});
for (let index = 0; index < 5; index += 1) hub2.onSessionEvent({ id: 's' }, {});
await sleep(320);
assert.equal(calls, 1, '150ms 防抖窗口内的多次事件只算一次');
assert.deepEqual(hub2.latestState('s'), { ratio: 0.2, window: 100_000, compressHint: null });
hub2.close();
assert.equal(hub2.latestState('s'), undefined, 'close 要清缓存');
hub.close();

// 乱序完成：先发出的慢读（revision 1）后到，不能覆盖后发快读（revision 2）。
const resolvers = [];
const hub3 = createStateHub({
  readState: () => new Promise((resolve) => resolvers.push(resolve)),
});
hub3.onSessionEvent({ id: 'race' }, {});
await sleep(240);
assert.equal(resolvers.length, 1, '第一轮应发起一次读取');
hub3.onSessionEvent({ id: 'race' }, {});
await sleep(240);
assert.equal(resolvers.length, 2, '第二轮应再发起一次读取');
resolvers[1]({ sessionId: 'race', revision: 2, ratio: 0.32, window: 200_000, compressHint: null });
await sleep(30);
resolvers[0]({ sessionId: 'race', revision: 1, ratio: 0.1, window: 200_000, compressHint: null });
await sleep(30);
assert.equal(hub3.latestState('race').ratio, 0.32, 'revision 更旧的慢读结果不能覆盖新缓存');
assert.equal(hub3.latestState('race').window, 200_000);
hub3.close();

// sessionId 对不上：不写缓存（防止串会话），也不抛错。
const hub4 = createStateHub({
  readState: async () => ({ sessionId: 'other', revision: 9, ratio: 0.5, window: 200_000, compressHint: null }),
});
hub4.onSessionEvent({ id: 'want' }, {});
await sleep(240);
assert.equal(hub4.latestState('want'), undefined, 'state.sessionId 与缓存键不一致时不写缓存');
hub4.close();

console.log('PASS  0.4 P0-1 cue v2：4 个完成信号 + 被拒无副作用（不含「不确定就不用调」）');
console.log('PASS  0.4 P0-1 门控：区间 10%–40%（不含压缩线）/ 0.08、0.40、0.45 不注入');
console.log('PASS  0.4 P0-1 限频：距上次注入 ≥3 轮（第 4 轮再注入），按会话隔离 + cueInjected 计量');
console.log('PASS  0.4 P0-1 prompt 适配：无 agent/缓存缺失/异常降级为空串（行为不变）');
console.log('PASS  0.3.4 可压缩区间提示：5% 桶/动态最小线/hint 抑制（随 v2 区间同步更新）');
console.log('PASS  0.3.4 state-hub 缓存：无订阅者更新/防抖/卸载清理/异常安全/close');
