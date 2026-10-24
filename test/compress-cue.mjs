/**
 * 0.3.4（BUG-010）单测：可压缩区间提示（cue 纯函数）+ state-hub 状态缓存 + prompt 适配。
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
  formatPercent,
  inCompressCueBand,
} from '../lib/core/compress-cue.js';
import { compressionMinRatio } from '../lib/core/policy.js';
import { createStateHub } from '../lib/dsh/state-hub.js';
import { compressCueFor, registerCompressCue } from '../lib/adapters/prompt.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 1. 区间边界：最小线含、压缩线不含（到线就该直接压，不再提示记断点）
 * ------------------------------------------------------------------ */

assert.equal(inCompressCueBand({ ratio: 0.049, minRatio: 0.05, compactRatio: 0.4 }), false);
assert.equal(inCompressCueBand({ ratio: 0.05, minRatio: 0.05, compactRatio: 0.4 }), true, '最小线本身在区间内');
assert.equal(inCompressCueBand({ ratio: 0.3999, minRatio: 0.05, compactRatio: 0.4 }), true);
assert.equal(inCompressCueBand({ ratio: 0.4, minRatio: 0.05, compactRatio: 0.4 }), false, '压缩线本身不在区间内');
assert.equal(inCompressCueBand({ ratio: 0.9, minRatio: 0.05, compactRatio: 0.4 }), false);
assert.equal(inCompressCueBand({ ratio: Number.NaN, minRatio: 0.05, compactRatio: 0.4 }), false);
assert.equal(inCompressCueBand({ ratio: 0.2, minRatio: Number.NaN, compactRatio: 0.4 }), false);

/* ------------------------------------------------------------------ *
 * 2. 5% 桶 / 百分比格式：提示要稳定，不能每个 token 都变
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * 3. cue 文案：区间外空串、区间内点名工具、已记 hint 抑制
 * ------------------------------------------------------------------ */

const band = { minRatio: 0.05, compactRatio: 0.4 };
assert.equal(compressCueText({ ratio: 0.02, ...band }), '', '低于最小线不提示');
assert.equal(compressCueText({ ratio: 0.4, ...band }), '', '到压缩线不提示');
assert.equal(compressCueText({ ratio: 0.02, minRatio: 0.3, compactRatio: 0.2 }), '', '非法区间（min>compact）不提示');
assert.equal(compressCueText({ ratio: Number.NaN, ...band }), '');

const cue = compressCueText({ ratio: 0.32, ...band, compressHint: null });
assert.equal(typeof cue, 'string');
assert.equal(cue.includes('mark_compress_point'), true, '提示要告诉模型调用哪个工具');
assert.equal(cue.includes('上下文容量约 30%'), true, '容量按 5% 桶：32% → 30%');
assert.equal(cue.includes('可压缩区间 5%–40%'), true);

assert.equal(HINT_SUPPRESS_RATIO, 0.1);
assert.equal(
  compressCueText({ ratio: 0.32, ...band, compressHint: { ratio: 0.25 } }),
  '',
  '刚记过 hint（差 7pp < 10pp）不重复提醒',
);
assert.equal(
  compressCueText({ ratio: 0.32, ...band, compressHint: { ratio: 0.2 } }).length > 0,
  true,
  '差 12pp 已超过抑制窗口，重新提示',
);
assert.equal(
  compressCueText({ ratio: 0.32, ...band, compressHint: { ratio: Number.NaN } }).length > 0,
  true,
  'hint 数据非法时按「没有 hint」处理',
);

/* ------------------------------------------------------------------ *
 * 4. 动态最小线：小窗口 + 保留近期原文时，最小线会抬到 5% 以上
 * ------------------------------------------------------------------ */

assert.equal(compressionMinRatio({ minRatio: 0.05 }, { recentTailTokens: 0 }, 1_000_000), 0.05);
const dynamicMin = compressionMinRatio({ minRatio: 0.05 }, { recentTailTokens: 40_000 }, 200_000);
assert.equal(dynamicMin, 0.22, '(40K 保留 + 4K 最小可压) / 200K = 22%');
assert.equal(
  compressCueText({ ratio: 0.2, minRatio: dynamicMin, compactRatio: 0.4 }),
  '',
  '20% 低于动态最小线 22%，即使高于配置的 5% 也不提示',
);
assert.equal(
  compressCueText({ ratio: 0.22, minRatio: dynamicMin, compactRatio: 0.4 }).includes('22%'),
  true,
  '提示里显示的是动态最小线',
);

// 审计修正（2026-10-24）：显示值必须 clamp 到区间下限，且解析出的「约 N%」≥ minRatio。
// 覆盖 128K / 200K / 256K 三种窗口下的动态下限（128K + 40K 保留时 minRatio≈33.569%，
// 旧实现 5% 桶会把 33.7% 显示成「约 30%」，与同一句的区间下限矛盾）。
for (const window of [128 * 1024, 200 * 1024, 256 * 1024]) {
  const minRatio = compressionMinRatio({ minRatio: 0.05 }, { recentTailTokens: 40_000 }, window);
  const compactRatio = 0.4;
  const ratios = [minRatio, minRatio + 0.001, minRatio + 0.02, (minRatio + compactRatio) / 2, compactRatio - 0.0001];
  for (const ratio of ratios) {
    const text = compressCueText({ ratio, minRatio, compactRatio, compressHint: null });
    assert.equal(text.length > 0, true, `窗口 ${window} 比例 ${ratio} 应提示`);
    const shown = /约 ([\d.]+)%/.exec(text);
    const lower = /可压缩区间 ([\d.]+)%/.exec(text);
    assert.notEqual(shown, null, '提示里应有「约 N%」');
    assert.notEqual(lower, null, '提示里应有区间下限');
    assert.equal(
      Number(shown[1]) / 100 >= minRatio - 1e-9,
      true,
      `窗口 ${window} 比例 ${ratio}：显示值 ${shown[1]}% 不能低于真实下限 ${(minRatio * 100).toFixed(4)}%`,
    );
    assert.equal(
      Number(shown[1]) >= Number(lower[1]),
      true,
      `窗口 ${window} 比例 ${ratio}：显示值 ${shown[1]}% 不能低于同一句的区间下限 ${lower[1]}%`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 5. state-hub：无 SSE 订阅者也更新缓存、150ms 防抖、卸载清理、异常安全
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * 6. prompt 适配：注册 + 同步取值 + 异常/缺缓存/缺服务全部降级为 ''
 * ------------------------------------------------------------------ */

const deps = { cfg: { thresholds: { compactRatio: 0.4 }, retention: { recentTailTokens: 0 } } };
const fakeHub = {
  latestState: (id) => (id === 's1' ? { ratio: 0.32, window: 1_000_000, compressHint: null } : undefined),
};
assert.equal(
  compressCueFor({ context: { agent: { session: { id: 's1' } } }, deps, hub: fakeHub }).includes('上下文容量约 30%'),
  true,
);
assert.equal(compressCueFor({ context: { agent: { session: { id: 'unknown' } } }, deps, hub: fakeHub }), '', '缓存没有就返回空串');
assert.equal(compressCueFor({ context: undefined, deps, hub: fakeHub }), '');
assert.equal(compressCueFor({ context: { agent: { session: { id: 's1' } } }, deps: { cfg: {} }, hub: fakeHub }), '', '配置缺字段返回空串');
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

// 没有 systemPrompt 服务：注册返回 undefined（不抛）；有服务则注册 name/order/text
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
assert.equal(registered[0].text({ agent: { session: { id: 's1' } } }).includes('mark_compress_point'), true);
assert.equal(registered[0].text({ agent: { session: { id: 's1' } } }).includes('30%'), true);

console.log('PASS  0.3.4 可压缩区间提示：区间边界/5% 桶/文案/动态最小线/hint 抑制');
console.log('PASS  0.3.4 state-hub 缓存：无订阅者更新/防抖/卸载清理/异常安全/close');
console.log('PASS  0.3.4 prompt 适配：注册 + 同步取值 + 缺服务/异常降级');
