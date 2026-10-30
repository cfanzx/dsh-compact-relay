/**
 * 0.5.6 Phase A：事件 schema / 裁剪 / 脱敏 / 存储降级（`dcr-event/v1`）。
 *
 *   node test/events-unit.mjs
 *
 * 覆盖（总计划 Phase A 验收 1–2）：
 *   - buildEventRecord 白名单键集（17 键）、枚举合法性、id/at 必填；
 *   - message 单行 + ≤300 码元；落盘档删凭据、保留路径、$HOME→~；
 *   - context 按 action 白名单 pick（未知键丢弃、标量截断、读侧保留扩展键）；
 *   - parse/normalize 容错（坏行/未知 schema 跳过）；
 *   - eventRowOf（11 键）/ exportRowOf（同键 + 全套脱敏 + session 遮蔽 + message ≤200）；
 *   - pruneEvents 失败保护（800 行 / 失败 200）+ 字节上限；collapseEvents 的 stalled；
 *   - dsh/events store 的 record/read/status/recentFailures 与不可写路径降级；
 *   - dsh/jsonl 的 stat 守卫 / tmp→rename / 永不抛。
 *
 * 全部写临时目录，不碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  A_LEVEL_ACTIONS,
  EVENT_ACTIONS,
  EVENT_KEEP_FAILURES,
  EVENT_MAX_ROWS,
  EVENT_OUTCOMES,
  EVENT_PHASES,
  EVENT_ROW_KEYS,
  EVENT_SCHEMA,
  EVENT_TRIGGERS,
  STALLED_MS,
  buildEventRecord,
  collapseEvents,
  contextOf,
  eventRowOf,
  exportRowOf,
  filterEvents,
  normalizeEventRecord,
  parseEventLines,
  pruneEvents,
  shouldRecordFailure,
} from '../lib/core/events.js';
import { REDACTION_PLACEHOLDER, redactLocalText } from '../lib/core/redact.js';
import { appendEventRecord, createEventStore, newEventId, readEventsFile } from '../lib/dsh/events.js';
import { createJsonlLog, jsonlStat, rewriteJsonlLines, splitJsonlLines } from '../lib/dsh/jsonl.js';

function tmpDir(prefix = 'relay-events-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const BASE = {
  schema: EVENT_SCHEMA,
  id: 'evt-20261030T154000-7c1e33ab',
  phase: 'end',
  at: '2026-10-30T15:40:00+08:00',
  action: 'handoff-preview',
  trigger: 'ui-menu',
  actor: 'user',
  outcome: 'fail',
  sessionId: 'session-8b0fbefe-1111-2222',
  compactionId: null,
  planId: null,
  childId: null,
  durationMs: 1832,
  code: 'INVALID_REQUEST',
  message: '失败：DeepSeek Messages tool calls need immediate results',
  context: { tokens: 464337, ratio: 0.443, summaries: 6 },
  v: '0.5.6',
};

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* ================================================================== *
 * ① schema 键集 / 枚举 / 必填
 * ================================================================== */

test('E1 schema 键集冻结为 17 键，枚举只接受白名单', () => {
  const record = buildEventRecord(BASE);
  assert.deepEqual(Object.keys(record).sort(), [
    'action',
    'actor',
    'at',
    'childId',
    'code',
    'compactionId',
    'context',
    'durationMs',
    'id',
    'message',
    'outcome',
    'phase',
    'planId',
    'schema',
    'sessionId',
    'trigger',
    'v',
  ]);
  assert.equal(record.schema, EVENT_SCHEMA);
  assert.deepEqual(EVENT_PHASES, ['start', 'end']);
  assert.deepEqual(EVENT_TRIGGERS, ['ui-menu', 'ui-ring', 'command', 'handoff', 'native-auto', 'external', 'unknown']);
  assert.deepEqual(EVENT_OUTCOMES, ['ok', 'fail', 'cancelled', 'stalled']);
  assert.equal(EVENT_ACTIONS.includes('handoff-preview'), true);
  assert.equal(A_LEVEL_ACTIONS.includes('preview'), true);
  assert.equal(A_LEVEL_ACTIONS.includes('favorite-toggle'), false, '收藏是 B 级');
  assert.equal(EVENT_MAX_ROWS, 800);
  assert.equal(EVENT_KEEP_FAILURES, 200);
});

test('E2 start 行强制 outcome/message/code 为 null；非法 phase/action/id/at → null', () => {
  const start = buildEventRecord({ ...BASE, phase: 'start', outcome: 'ok', message: '不应保留', code: 'x', durationMs: 1 });
  assert.equal(start.outcome, null);
  assert.equal(start.message, null);
  assert.equal(start.code, null);
  assert.equal(start.durationMs, null);
  assert.equal(buildEventRecord({ ...BASE, phase: 'middle' }), null);
  assert.equal(buildEventRecord({ ...BASE, action: 'not-an-action' }), null);
  assert.equal(buildEventRecord({ ...BASE, id: '' }), null);
  assert.equal(buildEventRecord({ ...BASE, at: '' }), null);
  assert.equal(buildEventRecord(null), null);
  // 非法 trigger/actor/outcome 归一（不猜）：unknown / user / fail。
  const odd = buildEventRecord({ ...BASE, trigger: 'from-mars', actor: 'robot', outcome: 'weird' });
  assert.equal(odd.trigger, 'unknown');
  assert.equal(odd.actor, 'user');
  assert.equal(odd.outcome, 'fail', 'end 行 outcome 非法时按 fail，不能读成成功');
});

/* ================================================================== *
 * ② 截断 + 落盘档脱敏
 * ================================================================== */

test('E3 message 单行化 + ≤300 码元（emoji 不切坏）', () => {
  const long = `${'a'.repeat(500)}\n第二行\t制表符`;
  const record = buildEventRecord({ ...BASE, message: long });
  assert.equal(record.message.length <= 300, true);
  assert.equal(record.message.includes('\n'), false);
  const emoji = buildEventRecord({ ...BASE, message: `${'🙂'.repeat(400)}` });
  assert.equal([...emoji.message].length <= 300, true, '按码点预算，不切坏代理对');
});

test('E4 落盘档：删凭据/邮箱，保留路径，$HOME 缩成 ~', () => {
  const message =
    '读取 /Users/alice/secret/handoff.md 失败；Authorization: Bearer abc123def456；cookie=abc123def；' +
    'token ghp_AAAAbbbbCCCCddddEEEEffff；邮箱 alice@example.com';
  const record = buildEventRecord({ ...BASE, message, home: '/Users/alice' });
  assert.equal(record.message.includes('ghp_'), false);
  assert.equal(record.message.includes('abc123def456'), false);
  assert.equal(record.message.includes('abc123def'), false);
  assert.equal(record.message.includes('alice@example.com'), false);
  assert.equal(record.message.includes(REDACTION_PLACEHOLDER), true);
  assert.equal(record.message.includes('~/secret/handoff.md'), true, 'home 前缀缩成 ~，保留路径供本地排查');
});

test('E5 redactLocalText 非字符串/空串不炸', () => {
  assert.deepEqual(redactLocalText(''), { text: '', count: 0 });
  assert.deepEqual(redactLocalText(null), { text: '', count: 0 });
  assert.deepEqual(redactLocalText('clean text'), { text: 'clean text', count: 0 });
});

/* ================================================================== *
 * ③ context 白名单
 * ================================================================== */

test('E6 context 按 action 白名单 pick；未知键丢弃；值只留标量/数组', () => {
  const picked = contextOf('compact', {
    tokens: 1000,
    ratio: 0.2,
    shadowedSeqs: [3, 4, 5],
    futureKey: '不在白名单里的键',
    nested: { a: 1 },
    nan: Number.NaN,
    longString: 'x'.repeat(200),
  });
  assert.deepEqual(Object.keys(picked).sort(), ['ratio', 'shadowedSeqs', 'tokens']);
  assert.equal(picked.shadowedSeqs, '3,4,5');
  assert.equal(picked.tokens, 1000);
  assert.equal(contextOf('unknown', { tokens: 1 }), null, 'unknown 动作没有上下文白名单');
  const clipped = contextOf('handoff', { archive: 'a'.repeat(500) });
  assert.equal([...clipped.archive].length <= 80, true);
});

test('E7 读侧保留未来扩展的 context 键（旧数据不用迁移）', () => {
  const raw = {
    ...BASE,
    context: { tokens: 10, futureAttribution: 'ui-menu', rangeStartSeq: 3 },
  };
  const parsed = normalizeEventRecord(raw);
  assert.equal(parsed.context.futureAttribution, 'ui-menu');
  assert.equal(parsed.context.rangeStartSeq, 3);
  // 写侧仍只允许白名单（防止整对象扩散）。
  const built = buildEventRecord(raw);
  assert.deepEqual(Object.keys(built.context).sort(), ['tokens']);
});

/* ================================================================== *
 * ④ 读侧容错 / 行投影
 * ================================================================== */

test('E8 parseEventLines：坏行 / 未知 schema / 非法记录跳过', () => {
  const good = JSON.stringify(buildEventRecord(BASE));
  const text = [
    good,
    'not-json',
    '{"schema":"dcr-event/v2","id":"x"}',
    JSON.stringify({ ...buildEventRecord(BASE), action: 'nope' }),
    '',
    '   ',
  ].join('\n');
  const records = parseEventLines(text);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, BASE.id);
  assert.deepEqual(parseEventLines(null), []);
});

test('E9 eventRowOf 11 键；exportRowOf 同键但脱敏/遮蔽/截断', () => {
  const record = buildEventRecord({
    ...BASE,
    message: `失败：/Users/alice/secret/handoff.md ${'x'.repeat(400)}`,
    context: { tokens: 1, note: '/Users/alice/secret/handoff.md' },
  });
  const row = eventRowOf(record);
  assert.deepEqual(Object.keys(row), [...EVENT_ROW_KEYS]);
  assert.equal(row.context.tokens, 1);

  const exported = exportRowOf(record);
  assert.deepEqual(Object.keys(exported), [...EVENT_ROW_KEYS], '外发投影与本地行同键');
  assert.equal(exported.message.includes('/Users/alice'), false, '外发必须脱掉绝对路径');
  assert.equal(exported.message.includes(REDACTION_PLACEHOLDER), true);
  assert.equal(exported.message.length <= 200, true);
  assert.equal(exported.sessionId, `…${record.sessionId.slice(-8)}`, '只留尾 8 位');
  assert.equal([...exported.sessionId].length <= 9, true);
  assert.equal(exported.context.note.includes('/Users/alice'), false);
});

test('E10 filterEvents：action/outcome/session/last', () => {
  const rows = [
    { ...buildEventRecord(BASE) },
    { ...buildEventRecord(BASE), id: 'b', action: 'compact', outcome: 'ok', code: null, message: null },
    { ...buildEventRecord(BASE), id: 'c', action: 'compact', outcome: 'fail', code: 'commit' },
  ];
  assert.equal(filterEvents(rows, { action: 'compact' }).length, 2);
  assert.equal(filterEvents(rows, { outcome: 'ok' }).length, 1);
  assert.equal(filterEvents(rows, { last: 2 }).length, 2);
  assert.equal(filterEvents(rows, { sessionId: 'nope' }).length, 0);
});

test('E11 collapseEvents：end 行覆盖 start；start-only >10min → stalled，未超时 → null', () => {
  const start = buildEventRecord({ ...BASE, phase: 'start', id: 'evt-a', at: '2026-10-30T10:00:00+08:00' });
  const end = buildEventRecord({ ...BASE, phase: 'end', id: 'evt-a', at: '2026-10-30T10:00:01+08:00', outcome: 'ok' });
  const collapsed = collapseEvents([start, end]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].outcome, 'ok');

  const stale = buildEventRecord({ ...BASE, phase: 'start', id: 'evt-b', at: '2026-10-30T10:00:00+08:00' });
  const now = Date.parse('2026-10-30T10:20:00+08:00');
  assert.equal(collapseEvents([stale], { now })[0].outcome, 'stalled');
  const justInside = Date.parse('2026-10-30T10:00:00+08:00') + STALLED_MS - 1000;
  assert.equal(collapseEvents([stale], { now: justInside })[0].outcome, null);
});

/* ================================================================== *
 * ⑤ 裁剪：800 行 + 失败保护 200 + 字节上限
 * ================================================================== */

function makeRows(total, failCount) {
  const rows = [];
  for (let index = 0; index < total; index += 1) {
    const fail = index < failCount;
    rows.push(
      buildEventRecord({
        ...BASE,
        id: `evt-${index}`,
        phase: 'end',
        at: `2026-10-30T10:00:${String(index % 60).padStart(2, '0')}+08:00`,
        outcome: fail ? 'fail' : 'ok',
        code: fail ? 'commit' : null,
        message: fail ? `失败 #${index}` : null,
      }),
    );
  }
  return rows;
}

test('E12 pruneEvents：900 行含 300 失败 → 800 行且失败一条不少', () => {
  const rows = makeRows(900, 300);
  const kept = pruneEvents(rows);
  assert.equal(kept.length, 800);
  assert.equal(kept.filter((row) => row.outcome === 'fail').length, 300);
  assert.equal(kept.some((row) => row.id === 'evt-300'), false, '最旧的非失败行先被删');
  assert.equal(kept.some((row) => row.id === 'evt-0'), true, '失败行受保护，不先删');
});

test('E13 pruneEvents：900 条全是失败 → 只留最近 200 条', () => {
  const rows = makeRows(900, 900);
  const kept = pruneEvents(rows);
  assert.equal(kept.length, 200);
  assert.equal(kept[0].id, 'evt-700');
  assert.equal(kept[kept.length - 1].id, 'evt-899');
});

test('E14 pruneEvents：字节上限优先（maxBytes 很小 → 非失败被删，失败仍保底）', () => {
  const rows = makeRows(50, 10);
  const kept = pruneEvents(rows, { maxRows: 800, maxBytes: 8000, keepFailures: 200 });
  assert.equal(kept.length < 50, true);
  assert.equal(kept.filter((row) => row.outcome === 'fail').length, 10, '失败保护优先于字节上限');
});

/* ================================================================== *
 * ⑥ 失败写入门槛
 * ================================================================== */

test('E15 shouldRecordFailure：busy/changed/nosession-409 不写，取消写', () => {
  assert.equal(shouldRecordFailure({ code: 'busy', statusCode: 409 }), false);
  assert.equal(shouldRecordFailure({ code: 'changed', statusCode: 409 }), false);
  assert.equal(shouldRecordFailure({ code: 'nosession', statusCode: 409 }), false);
  assert.equal(shouldRecordFailure({ code: 'busy', cancelled: true }), true);
  assert.equal(shouldRecordFailure({ code: 'pairing-tail', statusCode: 409 }), true);
  assert.equal(shouldRecordFailure({ statusCode: 500 }), true);
});

/* ================================================================== *
 * ⑦ dsh/events store：写入 / 读取 / 投影 / 降级
 * ================================================================== */

test('E16 store：start/end 共享 id、自动耗时、status 行数/最后时间', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'compact-relay-events.jsonl');
  const store = createEventStore({ file, version: '0.5.6', home: '/Users/alice' });
  const started = store.start({
    action: 'handoff-preview',
    trigger: 'ui-menu',
    sessionId: 'session-tail-open',
    context: { tokens: 1000 },
  });
  assert.equal(started.ok, true);
  assert.match(started.id, /^evt-\d{8}T\d{6}-[0-9a-f]{8}$/u);
  const ended = store.end({
    id: started.id,
    outcome: 'fail',
    code: 'INVALID_REQUEST',
    message: 'DeepSeek Messages tool calls need immediate results',
    context: { tokens: 1000, pairingBalanced: false },
  });
  assert.equal(ended.ok, true);
  const raw = readEventsFile(file);
  assert.equal(raw.length, 2);
  assert.equal(raw[0].phase, 'start');
  assert.equal(raw[1].phase, 'end');
  assert.equal(raw[0].id, raw[1].id);
  assert.equal(raw[1].durationMs >= 0, true);
  assert.equal(raw[1].context.pairingBalanced, false);

  const status = store.status();
  assert.equal(status.rows, 2);
  assert.equal(status.exists, true);
  assert.equal(status.writeable, true);
  assert.equal(status.lastAt, raw[1].at);
  assert.equal(newEventId(new Date('2026-10-30T15:40:00+08:00')).startsWith('evt-20261030T154000-'), true);
});

test('E17 store.recentFailures 排除 busy/changed，外发脱敏；recentActions 只留最近 N', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'events.jsonl');
  const store = createEventStore({ file, version: '0.5.6' });
  const okStart = store.start({ action: 'compact', trigger: 'ui-menu', sessionId: 'session-abc12345' });
  store.end({ id: okStart.id, outcome: 'ok', code: null, message: null });
  const busyStart = store.start({ action: 'preview', trigger: 'ui-menu', sessionId: 'session-abc12345' });
  store.end({ id: busyStart.id, outcome: 'fail', code: 'busy', message: '当前会话正在回复中' });
  const failStart = store.start({ action: 'preview', trigger: 'command', sessionId: 'session-abc12345' });
  store.end({
    id: failStart.id,
    outcome: 'fail',
    code: 'INVALID_REQUEST',
    message: '读取 /Users/alice/x.md 失败',
  });

  const failures = store.recentFailures(10);
  assert.equal(failures.length, 1, 'busy 不算失败投影');
  assert.equal(failures[0].code, 'INVALID_REQUEST');
  assert.equal(failures[0].message.includes('/Users/alice'), false, '端点/导出一律脱敏');
  assert.equal(failures[0].sessionId.startsWith('…'), true);
  assert.deepEqual(Object.keys(failures[0]), [...EVENT_ROW_KEYS]);

  const actions = store.recentActions(2);
  assert.equal(actions.length, 2);
  assert.equal(actions[1].action, 'preview');
});

test('E18 store：不可写路径静默降级（不抛、status.writeable=false、动作结果不受影响）', () => {
  const dir = tmpDir();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const store = createEventStore({ file: path.join(blocker, 'events.jsonl') });
  let threw = false;
  try {
    const started = store.start({ action: 'compact', trigger: 'ui-menu' });
    store.end({ id: started.id, outcome: 'ok' });
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  assert.equal(store.rows().length, 0);
  assert.equal(store.status().writeable, false);
  assert.deepEqual(store.recentFailures(5), []);
});

test('E19 store：800 行上限（用小上限验证轮转与失败保护）', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'events.jsonl');
  const store = createEventStore({ file, maxRows: 4, keepFailures: 2, version: '0.5.6' });
  for (let index = 0; index < 6; index += 1) {
    const started = store.start({ action: 'compact', trigger: 'external' });
    store.end({ id: started.id, outcome: index === 5 ? 'fail' : 'ok' });
  }
  const raw = readEventsFile(file);
  assert.equal(raw.length <= 4, true, '文件行数受上限约束');
  assert.equal(raw.every((record) => record.action === 'compact'), true);
});

test('E20 appendEventRecord 非法记录返回 ok:false 不抛', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'events.jsonl');
  assert.deepEqual(appendEventRecord(null, file), { ok: false });
  assert.deepEqual(appendEventRecord({ schema: 'bad' }, file), { ok: true }, 'append 只负责写，不校验 schema');
  assert.deepEqual(readEventsFile(file), [], '读侧跳过未知 schema');
});

/* ================================================================== *
 * ⑧ dsh/jsonl 公共件
 * ================================================================== */

test('E21 jsonl：stat / split / tmp→rename / 轮转 / 永不抛', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'log.jsonl');
  assert.deepEqual(jsonlStat(file), { exists: false, size: 0, mtimeMs: null });
  assert.deepEqual(splitJsonlLines('a\n\n b \r\n'), ['a', 'b']);
  assert.equal(rewriteJsonlLines(file, ['{"a":1}', '{"b":2}']), true);
  assert.equal(jsonlStat(file).exists, true);
  assert.equal(splitJsonlLines(fs.readFileSync(file, 'utf8')).length, 2);

  const log = createJsonlLog({ file, maxRows: 2 });
  // 已有 2 行、上限 2：append 后立刻轮转（返回值带 rotated，行为仍 ok）。
  assert.deepEqual(log.append('{"c":3}'), { ok: true, rotated: true });
  assert.deepEqual(log.append('{"d":4}'), { ok: true, rotated: true });
  assert.equal(log.count(), 2);
  assert.equal(splitJsonlLines(fs.readFileSync(file, 'utf8')).length, 2);

  // 路径不可写（父级是普通文件）→ append ok:false，不抛。
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const broken = createJsonlLog({ file: path.join(blocker, 'x.jsonl') });
  assert.deepEqual(broken.append('{"x":1}'), { ok: false });
  assert.equal(broken.status().writeable, false);
});

/* ================================================================== *
 * run
 * ================================================================== */

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
