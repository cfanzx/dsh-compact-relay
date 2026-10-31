/**
 * 0.5.6 Phase A：事件 schema 一致性（writer ↔ reader ↔ 行投影 ↔ 后续 CLI/端点）。
 *
 *   node test/events-schema-parity.mjs
 *
 * 这里把「对外契约」逐项冻结（等价于 contract-golden 的作用，但只针对事件流）：
 *   - `dcr-event/v1` 的 17 个写入键 + 顺序无关；
 *   - 行投影 `eventRowOf` / 外发投影 `exportRowOf` 的 11 键且两两同键；
 *   - 每个 action 的 context 白名单（Phase B/C/D 加字段必须改这里，属于有意识变更）；
 *   - build → JSON → parse 的往返不丢字段；
 *   - 枚举冻结（试图 push 不生效）。
 */
import assert from 'node:assert/strict';
import {
  A_LEVEL_ACTIONS,
  EVENT_ACTIONS,
  EVENT_ACTORS,
  EVENT_CONTEXT_KEYS,
  EVENT_OUTCOMES,
  EVENT_PHASES,
  EVENT_ROW_KEYS,
  EVENT_SCHEMA,
  EVENT_TRIGGERS,
  buildEventRecord,
  eventRowOf,
  exportRowOf,
  parseEventLines,
} from '../lib/core/events.js';
import { EVENTS_FILE } from '../lib/dsh/events.js';

/** 写入键（17）——冻结；改这个列表必须同时改 schema 版本。 */
export const EVENT_RECORD_KEYS = Object.freeze([
  'schema',
  'id',
  'phase',
  'at',
  'action',
  'trigger',
  'actor',
  'outcome',
  'sessionId',
  'compactionId',
  'planId',
  'childId',
  'durationMs',
  'code',
  'message',
  'context',
  'v',
]);

/** 读侧行（CLI --json / 端点 recentFailures / export 机读块）——冻结。 */
export const EXPECTED_ROW_KEYS = Object.freeze([
  'id',
  'at',
  'action',
  'trigger',
  'outcome',
  'durationMs',
  'code',
  'message',
  'sessionId',
  'compactionId',
  'context',
]);

/** context 白名单（Phase A 版；Phase D 加 compaction range 字段时改这里 + core/events）。 */
const EXPECTED_CONTEXT_KEYS = Object.freeze({
  preview: [
    'phase',
    'surfaceNodes',
    'note',
    'nodes',
    'tokens',
    'shadowedTokens',
    'summaries',
    'ratio',
    'advice',
    'pinned',
    'lastSurfaceSeq',
    'lastSurfaceType',
    'openTurn',
    'pairingBalanced',
  ],
  compact: [
    'phase',
    'surfaceNodes',
    'note',
    'nodes',
    'tokens',
    'ratio',
    'shadowedSeqs',
    'startSeq',
    'endSeq',
    'shadowedTokens',
    'summaries',
    'allowMergeOldSummaries',
    'pinned',
    'pinnedKept',
    'attempts',
    // 0.5.6 D1（压缩归属）：摘要模型 / 本次是否合并旧摘要（additive）。
    'model',
    'merged',
    // 0.5.7：长动作异步化（start/end 行共享 jobId）。
    'jobId',
  ],
  cancel: ['kind', 'inflight'],
  'handoff-preview': [
    'phase',
    'surfaceNodes',
    'note',
    'tokens',
    'ratio',
    'summaries',
    'pinned',
    'attempts',
    'ready',
    'openTurn',
    'pairingBalanced',
    'lastSurfaceSeq',
    'lastSurfaceType',
    // 0.5.7：长动作异步化（start/end 行共享 jobId）。
    'jobId',
  ],
  handoff: [
    'phase',
    'surfaceNodes',
    'note',
    'tokens',
    'ratio',
    'summaries',
    'pinned',
    'compacted',
    'shadowedSeqs',
    'attempts',
    'ready',
    'archive',
    'lastSurfaceSeq',
    'lastSurfaceType',
    // 0.5.7：长动作异步化（start/end 行共享 jobId）。
    'jobId',
  ],
  'force-archive': ['phase', 'surfaceNodes', 'archived', 'activity', 'status', 'hasChild'],
  recover: ['phase', 'surfaceNodes', 'archived', 'status'],
  'favorite-toggle': [],
  'favorite-mark': [],
  'favorite-score-trial': [],
  'pin-toggle': [],
  diff: [],
  state: [],
  'native-auto': ['enabled'],
  // 0.5.7：客户端错误（B 级动作，只有 end 行）；bodyHead 客户端先 clip 到 80 码点。
  'client-error': ['status', 'bodyHead', 'kind'],
  unknown: [],
});

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('P1 写入键 17 个 + schema 版本 + 文件名固定', () => {
  assert.equal(EVENT_SCHEMA, 'dcr-event/v1');
  assert.equal(EVENTS_FILE, 'compact-relay-events.jsonl');
  assert.deepEqual(Object.keys(EVENT_CONTEXT_KEYS).sort(), Object.keys(EXPECTED_CONTEXT_KEYS).sort());
  const record = buildEventRecord({
    id: 'evt-20261030T154000-7c1e33ab',
    phase: 'end',
    at: '2026-10-30T15:40:00+08:00',
    action: 'compact',
    trigger: 'ui-menu',
    outcome: 'ok',
    durationMs: 10,
    message: null,
    context: null,
  });
  assert.deepEqual(Object.keys(record).sort(), [...EVENT_RECORD_KEYS].sort());
  for (const key of EVENT_RECORD_KEYS) assert.equal(key in record, true, `缺少字段 ${key}`);
});

test('P2 行投影 11 键：eventRowOf 与 exportRowOf 同键，顺序冻结', () => {
  assert.deepEqual([...EVENT_ROW_KEYS], [...EXPECTED_ROW_KEYS]);
  const record = buildEventRecord({
    id: 'evt-20261030T154000-7c1e33ab',
    phase: 'end',
    at: '2026-10-30T15:40:00+08:00',
    action: 'handoff',
    trigger: 'command',
    outcome: 'fail',
    durationMs: 3,
    code: 'handoff',
    message: '失败：就绪检查未通过',
    sessionId: 'session-8b0fbefe-1111-2222',
    compactionId: '00000000-0000-4000-8000-000000000000',
    context: { tokens: 1 },
  });
  const row = eventRowOf(record);
  const exported = exportRowOf(record);
  assert.deepEqual(Object.keys(row), [...EXPECTED_ROW_KEYS]);
  assert.deepEqual(Object.keys(exported), [...EXPECTED_ROW_KEYS]);
  assert.equal(row.code, 'handoff');
  assert.equal(exported.code, 'handoff');
});

test('P3 build → JSON → parse 往返字段不变', () => {
  const input = {
    id: 'evt-20261030T154000-abcdef12',
    phase: 'end',
    at: '2026-10-30T15:40:00+08:00',
    action: 'compact',
    trigger: 'handoff',
    actor: 'user',
    outcome: 'ok',
    durationMs: 1234,
    code: null,
    message: null,
    sessionId: 'session-8b0fbefe-1111-2222',
    compactionId: 'c-1',
    planId: 'p-1',
    childId: null,
    context: { tokens: 100, ratio: 0.25, shadowedSeqs: [1, 2, 3] },
    v: '0.5.6',
  };
  const built = buildEventRecord(input);
  const [parsed] = parseEventLines(JSON.stringify(built));
  assert.deepEqual(parsed, built, '往返逐字段一致');
  assert.deepEqual(parseEventLines(`${JSON.stringify(built)}\n{broken`), [built]);
});

test('P4 枚举冻结：push/改写不生效', () => {
  for (const enumValue of [EVENT_ACTIONS, EVENT_TRIGGERS, EVENT_OUTCOMES, EVENT_PHASES, EVENT_ACTORS, A_LEVEL_ACTIONS]) {
    assert.equal(Object.isFrozen(enumValue), true);
    const before = enumValue.length;
    try {
      enumValue.push('hacked');
    } catch {
      /* 严格模式下抛 TypeError，非严格静默；两种都行 */
    }
    assert.equal(enumValue.length, before);
  }
  assert.deepEqual([...EVENT_PHASES], ['start', 'end']);
  assert.equal(EVENT_ACTIONS.includes('compact'), true);
  assert.equal(EVENT_TRIGGERS.includes('ui-menu'), true);
  assert.equal(EVENT_OUTCOMES.includes('stalled'), true);
  assert.equal(A_LEVEL_ACTIONS.includes('recover'), true);
});

test('P5 context 白名单逐 action 冻结（Phase D 扩展必须改这份清单）', () => {
  for (const [action, keys] of Object.entries(EXPECTED_CONTEXT_KEYS)) {
    assert.deepEqual([...EVENT_CONTEXT_KEYS[action]], keys, `action=${action} 的 context 白名单变了`);
    assert.equal(Object.isFrozen(EVENT_CONTEXT_KEYS[action]), true, `action=${action} 的白名单要冻结`);
  }
  assert.equal(Object.isFrozen(EVENT_CONTEXT_KEYS), true);
});

test('P6 写入侧白名单 vs 读侧扩展：旧数据向前兼容', () => {
  const raw = {
    schema: 'dcr-event/v1',
    id: 'evt-x',
    phase: 'end',
    at: '2026-10-30T15:40:00+08:00',
    action: 'compact',
    trigger: 'unknown',
    outcome: 'ok',
    context: { tokens: 5, compactionRange: '3-9', attribution: 'native-auto' },
  };
  const parsed = parseEventLines(JSON.stringify(raw))[0];
  assert.equal(parsed.context.compactionRange, '3-9', '未来字段读侧保留');
  assert.equal(parsed.context.attribution, 'native-auto');
});

/* run */
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
