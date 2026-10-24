/**
 * 0.4 P2-3：DSH 原生自动压缩「真实触发线」。
 *
 * 背景（BUG-012 后续）：指示灯过去直接显示 compaction-basic 的 thresholdRatio（默认 80%），
 * 但 DSH 实际按 token 数触发：
 *   thresholdTokens = floor(min(W × rate, W − 输出预留 − headroom))，触发点 = thresholdTokens / W。
 * 输出预留 = requestHeader.config.maxTokens ?? 适配器 defaultMaxTokens；headroom 与 rate 可被
 * modelPolicies 按 provider+model 覆盖（Win 真实配置就是 modelPolicies 列表写法）。
 *
 * 本测试锁：纯函数公式、配置解析（直属 headroom / 嵌套 modelPolicies / BUG-012 不误读全局）、
 * 路由策略匹配、以及 readState 下发的 native 字段（真实线 + 老字段兼容）。
 */
import assert from 'node:assert/strict';
import { nativeLineOf, NATIVE_HEADROOM_DEFAULT } from '../lib/core/native-line.js';
import { parseCompactionOverride, parseModelPolicies, resolveNativePolicy } from '../lib/dsh/native-compaction.js';
import { readState } from '../lib/actions/state.js';
import { createLock } from '../lib/actions/lock.js';
import { resolveConfig } from '../lib/config.js';
import { MockSession } from './harness/session.mjs';

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/* ------------------------------------------------------------------ *
 * 1. 纯函数：公式与边界
 * ------------------------------------------------------------------ */

test('0.4 P2-3 真实线：窗口比例与容量预算取小者（80% vs 路由压下来）', () => {
  // 1M 窗口、输出预留 8192、headroom 65536 → 容量预算 926272 > 800000 → 真实线 80%。
  const wide = nativeLineOf({ contextWindow: 1_000_000, reservedCompletionTokens: 8192, thresholdRatio: 0.8, headroomTokens: 65536 });
  assert.equal(wide.ok, true);
  assert.equal(wide.thresholdTokens, 800_000);
  assert.equal(wide.ratio, 0.8);

  // 同一窗口，但路由请求预留 256464 输出 → 容量预算 678000 < 800000 → 真实线 67.8%。
  const tight = nativeLineOf({ contextWindow: 1_000_000, reservedCompletionTokens: 256_464, thresholdRatio: 0.8, headroomTokens: 65536 });
  assert.equal(tight.ok, true);
  assert.equal(tight.thresholdTokens, 678_000);
  assert.equal(Number(tight.ratio.toFixed(3)), 0.678);
  assert.equal(tight.pressureBudgetTokens, 678_000);
});

test('0.4 P2-3 真实线：缺省值、无效输入与预算不够', () => {
  // headroom 缺省 = 65536（与 dsh-compaction-basic 默认一致）。
  const def = nativeLineOf({ contextWindow: 200_000, reservedCompletionTokens: 0, thresholdRatio: 0.8 });
  assert.equal(def.ok, true);
  assert.equal(def.thresholdTokens, Math.floor(Math.min(160_000, 200_000 - NATIVE_HEADROOM_DEFAULT)));
  assert.equal(def.thresholdTokens, 134_464);

  assert.equal(nativeLineOf({}).ok, false);
  assert.equal(nativeLineOf({ contextWindow: -1, thresholdRatio: 0.8 }).reason, 'input');
  assert.equal(nativeLineOf({ contextWindow: 1000, thresholdRatio: 0 }).reason, 'input');
  // 输出预留 + headroom 吃掉全部窗口 → 算不出（不是 0%）。
  assert.equal(nativeLineOf({ contextWindow: 100_000, reservedCompletionTokens: 40_000, thresholdRatio: 0.8, headroomTokens: 70_000 }).reason, 'no-budget');
  // 负数预留/余量按 0 / 默认值处理，不炸。
  const neg = nativeLineOf({ contextWindow: 1_000_000, reservedCompletionTokens: -5, thresholdRatio: 0.8, headroomTokens: -5 });
  assert.equal(neg.ok, true);
  assert.equal(neg.thresholdTokens, 800_000);
});

/* ------------------------------------------------------------------ *
 * 2. 配置解析：headroomTokens 直属键 + modelPolicies 嵌套列表
 * ------------------------------------------------------------------ */

test('0.4 P2-3 配置解析：config 直属 headroomTokens，嵌套层不能当全局', () => {
  const text = [
    '- id: compaction-basic',
    '  config:',
    '    thresholdRatio: 0.7',
    '    headroomTokens: 4096',
    '    modelPolicies:',
    '      - provider: mac-unc',
    '        model: qwen35-unc-64k',
    '        headroomTokens: 2048',
    '        thresholdRatio: 0.5',
    '- id: other',
  ].join('\n');
  const override = parseCompactionOverride(text);
  // BUG-012 保持：嵌套 modelPolicies 里的 thresholdRatio 不能变成全局线。
  assert.deepEqual(override, { found: true, thresholdRatio: 0.7, headroomTokens: 4096 });
  // 嵌套项单独解析出来（列表写法，Win 真实配置就是这个形状）。
  assert.deepEqual(parseModelPolicies(text), [{ provider: 'mac-unc', model: 'qwen35-unc-64k', headroomTokens: 2048, thresholdRatio: 0.5 }]);
  // 映射写法（key 当 model）也认。
  const mapped = ['- id: compaction-basic', '  config:', '    modelPolicies:', '      deepseek-flash:', '        thresholdRatio: 0.6'].join('\n');
  assert.deepEqual(parseModelPolicies(mapped), [{ provider: null, model: 'deepseek-flash', thresholdRatio: 0.6 }]);
  // 没有条目 / 没有 config / 没有 modelPolicies → 空。
  assert.deepEqual(parseModelPolicies('[]\n'), []);
  assert.deepEqual(parseModelPolicies('- id: compaction-basic\n'), []);
});

test('0.4 P2-3 路由策略：按 provider+model 精确覆盖，不匹配回落全局', () => {
  const cfg = { thresholdRatio: 0.8, headroomTokens: 65536, modelPolicies: [{ provider: 'mac-unc', model: 'qwen35-unc-64k', headroomTokens: 4096 }] };
  assert.deepEqual(resolveNativePolicy(cfg, { provider: 'mac-unc', model: 'qwen35-unc-64k' }), { thresholdRatio: 0.8, headroomTokens: 4096, overridden: true });
  assert.deepEqual(resolveNativePolicy(cfg, { provider: 'deepseek-official', model: 'deepseek-flash' }), { thresholdRatio: 0.8, headroomTokens: 65536, overridden: false });
  assert.deepEqual(resolveNativePolicy(cfg, null), { thresholdRatio: 0.8, headroomTokens: 65536, overridden: false });
  // provider 写了但不匹配 → 不算命中（避免把别的 provider 的同名模型套上来）。
  const strict = { thresholdRatio: 0.8, headroomTokens: 65536, modelPolicies: [{ provider: 'p1', model: 'm1', thresholdRatio: 0.5 }] };
  assert.equal(resolveNativePolicy(strict, { provider: 'p2', model: 'm1' }).overridden, false);
});

/* ------------------------------------------------------------------ *
 * 3. readState：真实线下发 + 老字段兼容
 * ------------------------------------------------------------------ */

const cfg = resolveConfig({ retention: { recentTailTokens: 0 } });
const engine = { isCompactCheckpointSource: () => false, toolPairingBalancedBefore: () => true, toolPairingBalancedAfter: () => true };
const tokenMeter = {
  measure(session) {
    const nodes = session.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 }));
    return { totalTokens: nodes.length * 100, surfaceTokens: nodes.length * 100, nodes };
  },
};

function sessionOf({ requestMaxTokens = 256_464, model = 'deepseek-flash' } = {}) {
  const session = new MockSession({
    id: 'session-native-line',
    events: [
      { type: 'user/message', data: { role: 'user', content: '一' } },
      { type: 'assistant/message', data: { role: 'assistant', content: '二' } },
    ],
  });
  session.requestHeader = () => ({ config: { provider: 'deepseek-official', model, maxTokens: requestMaxTokens } });
  return session;
}

function depsOf(session, nativeConfig) {
  const agent = { id: 'agent-native-line', session };
  return {
    ctx: {
      tokenMeter,
      llm: {
        async resolveModelInfo() {
          return { context: { contextWindow: 1_000_000 }, defaultMaxTokens: 8192 };
        },
      },
      agents: { get: (id) => (id === agent.id ? agent : undefined), list: () => [agent] },
      sessions: { get: (id) => (id === session.id ? session : undefined), flush() {} },
    },
    cfg,
    lock: createLock(),
    engine,
    nativeConfig,
  };
}

test('0.4 P2-3 readState：native 下发真实触发线（67.8%），老字段仍在', async () => {
  const session = sessionOf();
  const state = await readState(depsOf(session, { autoEnabled: true, thresholdRatio: 0.8, headroomTokens: 65536, modelPolicies: [] }), { sessionId: session.id });
  assert.equal(state.native.autoEnabled, true, '老字段 autoEnabled 保留');
  assert.equal(state.native.thresholdRatio, 0.8, '老字段 thresholdRatio 保留（窗口比例）');
  assert.equal(state.native.ratio, 0.678, '真实触发线 = floor(min(800000, 1000000-256464-65536))/1000000');
  assert.equal(state.native.thresholdTokens, 678_000);
  assert.equal(state.native.contextWindow, 1_000_000);
  assert.equal(state.native.reservedCompletionTokens, 256_464);
  assert.equal(state.native.headroomTokens, 65536);
  assert.equal(state.native.overridden, false);
  assert.deepEqual(state.native.route, { provider: 'deepseek-official', model: 'deepseek-flash' });
  assert.equal(state.native.unavailable, null);
  // 既有 state 字段不受影响。
  for (const key of ['revision', 'sessionId', 'ratio', 'summaries', 'advice', 'pins', 'compactRange', 'thresholds', 'compressHint', 'native']) {
    assert.equal(Object.hasOwn(state, key), true, `既有字段 ${key} 不能丢`);
  }
});

test('0.4 P2-3 readState：modelPolicies 覆盖该路由 → 用覆盖值算线', async () => {
  const session = sessionOf({ requestMaxTokens: 0 });
  // mac-unc 真实 Win 配置：headroomTokens 4096 + maxTokens 2048（作为输出预留的适配器默认值不参与）。
  const state = await readState(
    depsOf(session, {
      autoEnabled: true,
      thresholdRatio: 0.8,
      headroomTokens: 65536,
      modelPolicies: [{ provider: 'deepseek-official', model: 'deepseek-flash', headroomTokens: 4096 }],
    }),
    { sessionId: session.id },
  );
  assert.equal(state.native.overridden, true);
  assert.equal(state.native.headroomTokens, 4096);
  // W=1M、预留 0、headroom 4096、rate 0.8 → min(800000, 995904) = 800000 → 80%。
  assert.equal(state.native.ratio, 0.8);
});

test('0.4 P2-3 readState：算不出真实线时 ratio=null + unavailable 原因（客户端回落窗口比例）', async () => {
  const session = sessionOf({ requestMaxTokens: 990_000 });
  const state = await readState(depsOf(session, { autoEnabled: true, thresholdRatio: 0.8, headroomTokens: 65536, modelPolicies: [] }), { sessionId: session.id });
  assert.equal(state.native.ratio, null);
  assert.equal(state.native.unavailable, 'no-budget');
  assert.equal(state.native.thresholdRatio, 0.8, '老字段仍给窗口比例，客户端可回落');
});

/* 运行全部用例（异步用例逐个 await；失败即退出非 0）。 */
for (const [name, fn] of cases) {
  try {
    const result = fn();
    if (result !== undefined && typeof result.then === 'function') await result;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
}
