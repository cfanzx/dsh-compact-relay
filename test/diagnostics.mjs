/**
 * dcr 0.4 P0-2 诊断包单测 —— 覆盖方案 §7 的 T1–T9，外加动作层埋点接线。
 *
 * 运行：node test/diagnostics.mjs（已接入 `npm test`）
 *
 * 约束：
 *   - 纯 node、零网络：T4 会把 `globalThis.fetch` 换成抛错函数，并静态扫描两个新模块源码；
 *   - 所有断言都在本机内存里完成，不读真实 ~/.dsh、不读写任何会话数据。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerDshStubHooks } from './harness/dsh-stubs.mjs';
import { MockSession } from './harness/session.mjs';
import {
  DIAG_SCHEMA,
  JSON_BYTE_LIMIT,
  REDACTION_PLACEHOLDER,
  assertNoLeak,
  buildDiagnostics,
  renderIssueUrl,
} from '../lib/dsh/diagnostics.js';
import {
  ERROR_ENTRY_LIMIT,
  LATENCY_SAMPLE_LIMIT,
  createDiagCounters,
  errorCodeOf,
  localIso,
} from '../lib/dsh/diag-counters.js';

// 动作层会 import lib/dsh/* → @deepseek-ai/*：必须在动态 import 前注册测试替身解析钩子。
registerDshStubHooks();
const { runCompaction } = await import('../lib/actions/compact-run.js');
const { handoff } = await import('../lib/actions/handoff.js');
const { pinLastTurn, unpinAll } = await import('../lib/actions/pin.js');

/* ------------------------------------------------------------------ *
 * 夹具：正常输入 + 敏感 fixture（绝不允许出现在产物里）
 * ------------------------------------------------------------------ */

const FIXED_DATE = new Date('2026-10-24T15:40:00+08:00');
const CHAT_EXCERPT = '这是不该出现在诊断包里的聊天原文：帮我把支付回调逻辑改成幂等';
const SENSITIVE = [
  'ghp_AAAAbbbbCCCCddddEEEEffff',
  'sk-proj-abcdefghijklmnop',
  '/Users/alice/secret/handoff.md',
  'alice@example.com',
  'Authorization: Bearer abc123def456',
  'cookie=abc123def',
];
/** 敏感串里的「值本体」：整串被脱敏后这些子串也不能残留。 */
const SENSITIVE_BODIES = ['abc123def456', 'abc123def', 'alice', 'secret/handoff.md', 'sk-proj', 'ghp_'];

function richInput(overrides = {}) {
  return {
    now: FIXED_DATE,
    version: '0.3.6',
    runtime: {
      dshVersion: null,
      node: '22.14.0',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.6.0',
      locale: 'zh-CN',
    },
    config: {
      thresholds: { compactRatio: 0.4, handoffRatio: 0.6, maxSummaries: 6 },
      retention: { recentTailTokens: 40000 },
      timeouts: { compactMs: 600000, handoffMs: 600000 },
      colors: { mode: 'auto', autoAdapt: true },
      handoffDirCustomized: true,
      linksCustomized: false,
    },
    state: {
      window: 1_000_000,
      tokens: 264_000,
      ratio: 0.264,
      summaries: 1,
      pins: 0,
      advice: 'none',
      compactRange: { nodes: 12, tokens: 8000 },
      nativeAuto: { enabled: true, lineRatio: 0.8 },
    },
    counters: { compactOk: 1, compactFail: 0, handoffOk: 0, handoffFail: 0, pins: 0 },
    latency: { compact: { n: 1, p50: 120, p95: 120 }, handoff: { n: 0, p50: null, p95: null } },
    errors: [{ code: 'busy', phase: 'compact', at: '2026-10-24T15:31:02+08:00', count: 1 }],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 形状白名单（测试自己定义，不由实现自证）—— T1
 * ------------------------------------------------------------------ */

const LEAF = { kind: 'primitive' };
const OPTIONAL = (schema) => ({ ...schema, optional: true });

const DIAG_SHAPE = {
  kind: 'object',
  keys: {
    schema: LEAF,
    generatedAt: LEAF,
    plugin: { kind: 'object', keys: { name: LEAF, version: LEAF } },
    runtime: {
      kind: 'object',
      keys: {
        dshVersion: LEAF,
        node: LEAF,
        platform: LEAF,
        arch: LEAF,
        osRelease: LEAF,
        locale: LEAF,
      },
    },
    config: {
      kind: 'object',
      keys: {
        thresholds: { kind: 'object', keys: { compactRatio: LEAF, handoffRatio: LEAF, maxSummaries: LEAF } },
        retention: { kind: 'object', keys: { recentTailTokens: LEAF } },
        timeouts: { kind: 'object', keys: { compactMs: LEAF, handoffMs: LEAF } },
        colors: { kind: 'object', keys: { mode: LEAF, autoAdapt: LEAF } },
        handoffDirCustomized: LEAF,
        linksCustomized: LEAF,
      },
    },
    state: {
      kind: 'objectOrNull',
      keys: {
        window: LEAF,
        tokens: LEAF,
        ratio: LEAF,
        summaries: LEAF,
        pins: LEAF,
        advice: LEAF,
        compactRange: { kind: 'objectOrNull', keys: { nodes: LEAF, tokens: LEAF } },
        nativeAuto: { kind: 'objectOrNull', keys: { enabled: LEAF, lineRatio: LEAF } },
      },
    },
    counters: {
      kind: 'object',
      keys: {
        compactOk: LEAF,
        compactFail: LEAF,
        handoffOk: LEAF,
        handoffFail: LEAF,
        pins: LEAF,
        cueInjected: LEAF,
        markCalls: LEAF,
        markAccepted: LEAF,
        markRejected: LEAF,
      },
    },
    latency: {
      kind: 'object',
      keys: {
        compact: { kind: 'object', keys: { n: LEAF, p50: LEAF, p95: LEAF } },
        handoff: { kind: 'object', keys: { n: LEAF, p50: LEAF, p95: LEAF } },
      },
    },
    errors: {
      kind: 'array',
      max: 20,
      item: { kind: 'object', keys: { code: LEAF, phase: LEAF, at: LEAF, count: LEAF } },
    },
    // 方案 §8 的可选字段：只在发生脱敏时出现（只出数量）。
    redactions: OPTIONAL(LEAF),
  },
};

/** 任何一层都不允许出现这些 key（值形态敏感字段；精确匹配，不做子串）。 */
const FORBIDDEN_KEYS = new Set([
  // 注意：`summaries` 是契约里的合法字段（state.summaries / thresholds.maxSummaries），
  // 所以禁止 key 用精确匹配、且只列契约之外的字段；产物形状由上面的白名单保证。
  'message',
  'messages',
  'summary',
  'prompt',
  'completion',
  'toolargs',
  'args',
  'content',
  'cwd',
  'homedir',
  'hostname',
  'username',
  'user',
  'cookie',
  'authorization',
  'token',
  'secret',
  'password',
  'sessionid',
  'path',
  'file',
  'dir',
  'handoffdir',
  'links',
]);

function checkShape(value, schema, path) {
  if (schema.kind === 'primitive') {
    assert.equal(
      value === null || ['string', 'number', 'boolean'].includes(typeof value),
      true,
      `${path} 只能是标量或 null，实际 ${typeof value}`,
    );
    return;
  }
  if (schema.kind === 'objectOrNull') {
    if (value === null) return;
    checkShape(value, { ...schema, kind: 'object' }, path);
    return;
  }
  if (schema.kind === 'array') {
    assert.equal(Array.isArray(value), true, `${path} 应为数组`);
    assert.equal(value.length <= schema.max, true, `${path} 条目数不能超过 ${schema.max}`);
    value.forEach((item, index) => checkShape(item, schema.item, `${path}[${index}]`));
    return;
  }
  // object
  assert.equal(value !== null && typeof value === 'object' && !Array.isArray(value), true, `${path} 应为对象`);
  for (const [key, child] of Object.entries(value)) {
    const childSchema = schema.keys[key];
    assert.notEqual(childSchema, undefined, `${path}.${key} 不在白名单里（禁止后续手滑加字段）`);
    assert.equal(FORBIDDEN_KEYS.has(key.toLowerCase()), false, `${path}.${key} 是禁止出现的 key`);
    checkShape(child, childSchema, `${path}.${key}`);
  }
  for (const [key, childSchema] of Object.entries(schema.keys)) {
    if (childSchema.optional === true) continue;
    assert.equal(Object.prototype.hasOwnProperty.call(value, key), true, `${path}.${key} 缺失`);
  }
}

/* ------------------------------------------------------------------ *
 * 测试运行器
 * ------------------------------------------------------------------ */

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* ================================================================== *
 * T1 形状白名单：递归 key ⊆ §3 契约；多余字段被裁掉
 * ================================================================== */

test('T1 形状白名单：JSON 递归 key ⊆ 契约；未知输入字段不透传', () => {
  const { json } = buildDiagnostics(richInput());
  checkShape(json, DIAG_SHAPE, '$');
  assert.equal(json.schema, DIAG_SCHEMA);
  assert.equal(json.plugin.name, 'dsh-compact-relay');
  assert.equal(json.plugin.version, '0.3.6');
  assert.equal(json.runtime.dshVersion, null, '拿不到的东西就是 null，不猜');
  assert.equal(json.generatedAt.startsWith('2026-10-24T15:40:00'), true, '注入时间要生效（测试可复现）');

  // 输入里塞任何未声明字段：产物必须原样裁掉（allowlist，不透传）。
  const polluted = buildDiagnostics(
    richInput({
      runtime: { ...richInput().runtime, headless: true, extra: { nested: 'x' } },
      config: { ...richInput().config, secretFlag: true, handoffDir: '/Users/alice/handoffs' },
      state: {
        ...richInput().state,
        sessionId: 'session-abc12345',
        cwd: '/Users/alice/work',
        messages: [{ role: 'user', content: CHAT_EXCERPT }],
        summary: CHAT_EXCERPT,
      },
      counters: { ...richInput().counters, lastMessage: CHAT_EXCERPT },
      errors: [{ ...richInput().errors[0], message: CHAT_EXCERPT, stack: 'at /Users/alice/x.js' }],
      junk: 'nope',
    }),
  );
  checkShape(polluted.json, DIAG_SHAPE, '$');
  const text = JSON.stringify(polluted.json) + polluted.markdown;
  // 注意：`handoffDirCustomized` 是合法布尔字段名，所以只断言「值」（路径/会话 id），不断言子串 key。
  for (const needle of [CHAT_EXCERPT, 'session-abc12345', '/Users/alice']) {
    assert.equal(text.includes(needle), false, `未声明字段的值不能出现在产物里：${needle}`);
  }
  assert.deepEqual(
    Object.keys(polluted.json.errors[0]).sort(),
    ['at', 'code', 'count', 'phase'],
    '错误条目只允许 code/phase/at/count（绝不收 message/stack）',
  );
});

/* ================================================================== *
 * T2 敏感 fixture：assertNoLeak 报 hit；产物不残留原文（清洗兜底）
 * ================================================================== */

test('T2 敏感 fixture：检测集报 hit；注入敏感串后产物只留 [REDACTED]', () => {
  const detected = assertNoLeak(SENSITIVE.join('\n'));
  assert.equal(detected.ok, false, '敏感 fixture 必须被检测出来');
  for (const label of ['github-token', 'openai-key', 'unix-abs-path', 'email', 'cookie']) {
    assert.equal(detected.hits.includes(label), true, `检测集应命中 ${label}（实际：${detected.hits.join(',')}）`);
  }
  assert.equal(detected.hits.some((label) => label === 'authorization-header' || label === 'bearer-token'), true);
  // 只返回模式 label，不把命中的原文带出去（诊断计数/日志用）。
  const joinedHits = detected.hits.join('|');
  for (const needle of ['ghp_', 'sk-proj', 'alice@example.com', 'abc123def456']) {
    assert.equal(joinedHits.includes(needle), false, `hits 不能包含原文：${needle}`);
  }
  // 任意聊天原文默认不在检测集里（不是「魔法识别」），但可显式追加禁词。
  assert.equal(assertNoLeak(CHAT_EXCERPT).ok, true);
  assert.equal(assertNoLeak(CHAT_EXCERPT, [CHAT_EXCERPT]).ok, false, 'extraDeny 要能兜底断言固定 fixture');

  const built = buildDiagnostics(
    richInput({
      version: `0.3.6 ${SENSITIVE[0]}`,
      runtime: {
        ...richInput().runtime,
        dshVersion: SENSITIVE[1],
        osRelease: SENSITIVE[2],
        locale: SENSITIVE[3],
      },
      errors: [
        { code: SENSITIVE[4], phase: 'compact', at: '2026-10-24T15:31:02+08:00', count: 1 },
        { code: `cookie=${SENSITIVE[5].split('=')[1]}`, phase: 'handoff', at: '2026-10-24T15:32:02+08:00', count: 2 },
      ],
    }),
  );
  const productText = JSON.stringify(built.json);
  assert.equal(productText.includes(REDACTION_PLACEHOLDER), true, '命中后应替换成 [REDACTED]');
  assert.equal(typeof built.json.redactions === 'number' && built.json.redactions > 0, true, '脱敏数量只出数量、不出原文');
  for (const needle of [...SENSITIVE, ...SENSITIVE_BODIES]) {
    assert.equal(productText.includes(needle), false, `JSON 产物不能残留敏感原文：${needle}`);
    assert.equal(built.markdown.includes(needle), false, `Markdown 产物不能残留敏感原文：${needle}`);
  }
  checkShape(built.json, DIAG_SHAPE, '$');
});

/* ================================================================== *
 * T3 禁止字段：聊天原文 / sessionId / 路径不进 Markdown + JSON
 * ================================================================== */

test('T3 禁止字段：产物 Markdown/JSON 不出现聊天原文、路径、sessionId 值', () => {
  const { json, markdown } = buildDiagnostics(richInput());
  const text = `${JSON.stringify(json)}\n${markdown}`;
  for (const needle of [CHAT_EXCERPT, '/Users/', 'C:\\\\', 'session-', 'alice@example.com', 'ghp_']) {
    assert.equal(text.includes(needle), false, `产物不能出现：${needle}`);
  }
  // 人读 Markdown 只包含数值/枚举/布尔/错误码，不含自由文本块。
  assert.equal(markdown.includes('聊天'), false);
  assert.equal(markdown.includes('摘要正文'), false);
});

/* ================================================================== *
 * T4 零网络：fetch 抛错不影响；两个新模块源码无网络 API
 * ================================================================== */

test('T4 零网络：fetch 换成抛错函数后构建/URL 全程不触发网络', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error('network!');
  };
  try {
    const built = buildDiagnostics(richInput());
    assert.equal(built.markdown.length > 0, true);
    const url = renderIssueUrl({ version: '0.3.6', runtime: richInput().runtime });
    assert.equal(typeof url, 'string');
    assert.equal(fetchCalls, 0, '诊断构建/URL 生成不能调用 fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 静态守卫：两个新模块里不出现任何网络 API（方案 A2 的 grep 断言）。
  for (const relative of ['../lib/dsh/diagnostics.js', '../lib/dsh/diag-counters.js']) {
    const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.equal(
      /(?:\bfetch\s*\(|XMLHttpRequest|node:https?\b|node:net\b|from 'https?'|from "https?")/u.test(source),
      false,
      `${relative} 不允许出现网络 API`,
    );
  }
});

/* ================================================================== *
 * T5 URL 长度：< 7500，只预填短字段，不塞 Markdown
 * ================================================================== */

test('T5 issue URL：< 7500 字符、含模板参数、长输入也不膨胀', () => {
  const url = renderIssueUrl({ version: '0.3.6', runtime: { platform: 'darwin', osRelease: '24.6.0' } });
  assert.equal(url.length < 7500, true, `URL 长度 ${url.length} 必须 < 7500`);
  assert.equal(url.includes('template=bug_report.yml'), true);
  assert.equal(url.includes('dcr-version=0.3.6'), true);
  assert.equal(url.startsWith('https://github.com/cfanzx/dsh-compact-relay/issues/new?'), true);
  assert.equal(url.includes('dsh-compact-relay 诊断信息'), false, 'URL 不允许塞 Markdown 正文');
  const huge = renderIssueUrl({
    version: '9'.repeat(20_000),
    runtime: { platform: 'p'.repeat(5000), osRelease: 'r'.repeat(5000), dshVersion: 'd'.repeat(5000) },
  });
  assert.equal(huge.length < 7500, true, '异常长输入也必须收在 7500 以内');
});

/* ================================================================== *
 * T6 大小上限：200 条错误输入 → JSON ≤ 64KB / errors ≤ 20 / 单条 ≤ 200 字符
 * ================================================================== */

test('T6 尺寸上限：JSON ≤ 64KB、errors ≤ 20 条且单条 ≤ 200 字符、Markdown 可读', () => {
  const noise = Array.from({ length: 200 }, (_, index) => ({
    code: `code-${index}-${'x'.repeat(400)}`,
    phase: 'compact',
    at: '2026-10-24T15:31:02+08:00',
    count: index + 1,
    message: CHAT_EXCERPT,
  }));
  const built = buildDiagnostics(
    richInput({
      errors: noise,
      latency: { compact: { n: 20, p50: 120, p95: 480 }, handoff: { n: 20, p50: 80, p95: 400 } },
    }),
  );
  const jsonText = JSON.stringify(built.json);
  assert.equal(Buffer.byteLength(jsonText, 'utf8') <= JSON_BYTE_LIMIT, true, 'JSON 必须 ≤ 64KB');
  assert.equal(built.json.errors.length <= 20, true, '错误码最多 20 条');
  assert.equal(built.json.errors.length, 20);
  for (const entry of built.json.errors) {
    assert.equal(JSON.stringify(entry).length <= 200, true, '单条错误序列化后必须 ≤ 200 字符');
  }
  assert.equal(built.markdown.includes(CHAT_EXCERPT), false, '错误 message 不进产物');
  assert.equal(built.markdown.includes('cue 注入'), true, 'Markdown 要带 P0-1 判断机制读数（cue 注入 / mark 调用）');
  assert.equal(built.markdown.length < 8192, true, '人读 Markdown 保持短小（方案目标 2–4KB）');
});

/* ================================================================== *
 * T7 p50 / p95：空样本 null；样本 <3 也给值；n 正确；p95 ≥ p50；只留最近 20
 * ================================================================== */

test('T7 p50/p95：空样本 null、n 正确、p95 ≥ p50、只留最近 20 个样本', () => {
  const empty = createDiagCounters();
  assert.deepEqual(empty.snapshot().latency.compact, { n: 0, p50: null, p95: null });
  assert.deepEqual(empty.snapshot().latency.handoff, { n: 0, p50: null, p95: null });

  const one = createDiagCounters();
  one.recordDuration('compact', 100);
  assert.deepEqual(one.snapshot().latency.compact, { n: 1, p50: 100, p95: 100 });

  const three = createDiagCounters();
  for (const ms of [100, 300, 200]) three.recordDuration('compact', ms);
  const threeSnap = three.snapshot().latency.compact;
  assert.equal(threeSnap.n, 3);
  assert.equal(threeSnap.p50, 200);
  assert.equal(threeSnap.p95, 300);
  assert.equal(threeSnap.p95 >= threeSnap.p50, true);

  const twenty = createDiagCounters();
  for (let index = 1; index <= 20; index += 1) twenty.recordDuration('handoff', index * 10);
  let snap = twenty.snapshot().latency.handoff;
  assert.equal(snap.n, 20);
  assert.equal(snap.p50, 100);
  assert.equal(snap.p95, 190);
  twenty.recordDuration('handoff', 1000); // 第 21 个样本：最旧的 10ms 被挤掉
  snap = twenty.snapshot().latency.handoff;
  assert.equal(snap.n, LATENCY_SAMPLE_LIMIT);
  assert.equal(snap.p50, 110);
  assert.equal(snap.p95, 200);
  assert.equal(snap.p95 >= snap.p50, true);

  for (const size of [1, 2, 3, 7, 19, 20]) {
    const counters = createDiagCounters();
    for (let index = 1; index <= size; index += 1) counters.recordDuration('compact', index);
    const entry = counters.snapshot().latency.compact;
    assert.equal(entry.n <= LATENCY_SAMPLE_LIMIT, true);
    if (entry.n > 0) assert.equal(entry.p95 >= entry.p50, true, `n=${size} 时 p95 不能小于 p50`);
  }

  // 非法样本 / 未知类别一律忽略；快照是全新对象，改不坏内部状态。
  const guard = createDiagCounters();
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100', null, undefined, {}]) {
    guard.recordDuration('compact', bad);
  }
  guard.recordDuration('pin', 100);
  guard.recordDuration('compact', 12.6);
  assert.equal(guard.snapshot().latency.compact.n, 1);
  assert.equal(guard.snapshot().latency.compact.p50, 13, '毫秒取整');
  const detached = guard.snapshot();
  detached.latency.compact.n = 999;
  assert.equal(guard.snapshot().latency.compact.n, 1, 'snapshot() 必须返回副本');
});

/* ================================================================== *
 * T8 计数器：bumpAction/bumpPin 计数、错误聚合只留 code/phase/at/count
 * ================================================================== */

test('T8 计数器：动作/锁定计数、错误按 (code,phase) 聚合、最多 20 条、只留四个字段', () => {
  const counters = createDiagCounters();
  assert.deepEqual(counters.snapshot().errors, []);
  assert.deepEqual(counters.snapshot().counters, {
    compactOk: 0,
    compactFail: 0,
    handoffOk: 0,
    handoffFail: 0,
    pins: 0,
    cueInjected: 0,
    markCalls: 0,
    markAccepted: 0,
    markRejected: 0,
  });
  counters.bumpAction('compact', true);
  counters.bumpAction('compact', false);
  counters.bumpAction('handoff', true);
  counters.bumpAction('handoff', false);
  counters.bumpPin();
  counters.bumpPin();
  counters.bumpAction('pin', true); // 未知类别忽略
  assert.deepEqual(counters.snapshot().counters, {
    compactOk: 1,
    compactFail: 1,
    handoffOk: 1,
    handoffFail: 1,
    pins: 2,
    cueInjected: 0,
    markCalls: 0,
    markAccepted: 0,
    markRejected: 0,
  });

  counters.recordError('busy', 'compact');
  counters.recordError('busy', 'compact');
  counters.recordError('timeout', 'handoff');
  const errors = counters.snapshot().errors;
  assert.equal(errors.length, 2, '同 (code,phase) 要聚合，不重复占条目');
  // 最近出现的在前：timeout 在 busy 之后记录。
  assert.equal(errors[0].code, 'timeout');
  assert.equal(errors[1].code, 'busy');
  assert.equal(errors[1].count, 2);
  assert.deepEqual(Object.keys(errors[0]).sort(), ['at', 'code', 'count', 'phase'], '错误条目只留四个字段');
  assert.match(errors[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u, 'at 是本地 ISO 时间');

  // 条目上限 20 + 最久未出现的先淘汰。
  const many = createDiagCounters();
  for (let index = 0; index < 25; index += 1) many.recordError(`code-${index}`, 'compact');
  const kept = many.snapshot().errors;
  assert.equal(kept.length, ERROR_ENTRY_LIMIT);
  assert.equal(kept[0].code, 'code-24');
  assert.equal(kept.some((entry) => entry.code === 'code-4'), false, '最旧的一条要淘汰');
  // 超长 code 截断，不留巨串。
  const long = createDiagCounters();
  long.recordError('x'.repeat(500), 'p'.repeat(200));
  assert.equal(long.snapshot().errors[0].code.length <= 60, true);
  assert.equal(long.snapshot().errors[0].phase.length <= 20, true);

  // errorCodeOf：优先稳定 code，其次 name，最后 'error'。
  assert.equal(errorCodeOf(Object.assign(new Error('boom'), { code: 'busy' })), 'busy');
  assert.equal(errorCodeOf(new Error('boom')), 'error');
  assert.equal(errorCodeOf(null), 'error');
  assert.equal(errorCodeOf('plain text'), 'error');
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(errorCodeOf(abort), 'AbortError');
  assert.match(localIso(FIXED_DATE), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/u);

  // 0.4 P0-1：cue 注入 / mark 调用（被拒也算调用）计量也进 counters 白名单。
  counters.bumpCueInjected();
  counters.bumpCueInjected();
  counters.bumpMark(true);
  counters.bumpMark(false);
  counters.bumpMark(false);
  const p01 = counters.snapshot().counters;
  assert.equal(p01.cueInjected, 2);
  assert.equal(p01.markCalls, 3);
  assert.equal(p01.markAccepted, 1);
  assert.equal(p01.markRejected, 2);
  assert.equal(p01.markAccepted + p01.markRejected, p01.markCalls, '不变式：接受 + 拒绝 = 调用总数');
});

test('T8b 动作层埋点接线：compact/handoff 失败计数 + pin 锁定计数', async () => {
  // 压缩：agent 不支持 runMaintenance → 失败路径要记 compactFail / 错误码 / 耗时。
  const compactDiag = createDiagCounters();
  await assert.rejects(
    runCompaction(
      { ctx: {}, cfg: { summary: { maxTokens: 100 } }, engine: {}, diag: compactDiag },
      { agent: {}, session: {}, range: { startSeq: 0, endSeq: 1, shadowedSeqs: [1], shadowedTokenCount: 1 } },
    ),
    /不支持/u,
  );
  const compactSnap = compactDiag.snapshot();
  assert.equal(compactSnap.counters.compactFail, 1);
  assert.equal(compactSnap.counters.compactOk, 0);
  assert.equal(compactSnap.errors[0].phase, 'compact');
  assert.equal(compactSnap.errors[0].code, 'unsupported');
  assert.equal(compactSnap.latency.compact.n, 1, '失败也要记耗时样本（p50/p95 才有数据）');

  // 交接：agent 为空 → 失败路径要记 handoffFail。
  const handoffDiag = createDiagCounters();
  await assert.rejects(handoff({ diag: handoffDiag }, { agent: null }), /没有打开的会话/u);
  const handoffSnap = handoffDiag.snapshot();
  assert.equal(handoffSnap.counters.handoffFail, 1);
  assert.equal(handoffSnap.counters.handoffOk, 0);
  assert.equal(handoffSnap.errors[0].phase, 'handoff');

  // 锁定：成功写入才计数；解锁不计数（toggle 锁一次记一次）。
  const pinDiag = createDiagCounters();
  const session = new MockSession();
  session.seed([{ type: 'user/message', data: { content: 'hello', source: { kind: 'user' } } }]);
  const pinDeps = {
    diag: pinDiag,
    engine: { appendPluginRecord: (target, type, data) => target.appendPluginRecord(type, data) },
  };
  const first = pinLastTurn(pinDeps, { agent: { session } });
  assert.equal(first.pinned.length, 1);
  assert.equal(pinDiag.snapshot().counters.pins, 1);
  pinLastTurn(pinDeps, { agent: { session } });
  assert.equal(pinDiag.snapshot().counters.pins, 2);
  unpinAll(pinDeps, { agent: { session } });
  assert.equal(pinDiag.snapshot().counters.pins, 2, '解锁不算锁定次数');
});

/* ================================================================== *
 * T9 文案：只用「生成/预览/复制」，不出现「发送/上传/上报」
 * ================================================================== */

test('T9 文案：设置页诊断区按钮用「生成/预览/复制」，无「发送/上传/上报」', () => {
  const fragment = fs.readFileSync(new URL('../lib/client/50-settings.js', import.meta.url), 'utf8');
  for (const label of [
    '诊断信息',
    '生成并预览',
    '打开问题报告页',
    '复制 Markdown',
    '复制 JSON',
    '诊断信息预览（脱敏）',
    '只在本机生成',
  ]) {
    assert.equal(fragment.includes(label), true, `设置页缺少文案：${label}`);
  }
  assert.equal(/(发送|上传|上报)/u.test(fragment), false, '诊断区文案不允许出现「发送/上传/上报」');
  // 预览弹层要可访问 + 只读：role=dialog / aria-label / readOnly 文本区。
  assert.equal(fragment.includes('role'), true);
  assert.equal(fragment.includes('aria-label'), true);
  // 产物是构建出来的：lib/client.js 也必须同步（未构建时 npm test 的 --check 会先红）。
  const bundle = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.equal(bundle.includes('诊断信息预览（脱敏）'), true, 'lib/client.js 需要重建');
});

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

let passed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${cases.length} passed`);
