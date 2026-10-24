/**
 * 0.4 P1-3 单测：轻账本（压缩/交接可审计流水）+ 设置页一行累计数字。
 *
 * 覆盖任务验收：
 *   ① 记录字段完整（kind/时间/压前压后 tokens+ratio/耗时/pin 命中/交接单路径）；
 *   ② 设置页数字与账本一致（test 里用临时账本文件断言）；
 *   ③ 记录不含消息原文/摘要/交接单正文（敏感 fixture 断言不出现）；
 *   ④ 写失败/文件损坏静默降级（不影响动作、不抛）；
 *   ⑤ 条数上限 200（用小的 maxEntries 测裁剪）；
 *   ⑥ 客户端 bundle 有「累计」一行（静态守卫）。
 *
 * 纯 node 跑：全部写临时目录，不碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsStore } from '../lib/actions/settings.js';
import { settingsPayloadOf } from '../lib/adapters/http.js';
import {
  LEDGER_MAX_ENTRIES,
  LEDGER_SCHEMA,
  buildLedgerRecord,
  normalizeLedgerRecord,
  parseLedgerLines,
  summarizeLedgerRecords,
} from '../lib/core/ledger.js';
import { createLedgerStore, readLedgerFile } from '../lib/dsh/ledger.js';

/** 一次性临时目录（不写真实 ~/.dsh）。 */
function tmpDir(prefix = 'relay-ledger-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ================================================================== *
 * ① 记录字段完整 + 只收白名单
 * ================================================================== */

const compactRecord = buildLedgerRecord({
  kind: 'compact',
  at: '2026-10-24T21:30:00+08:00',
  durationMs: 4321.6,
  beforeTokens: 264_000,
  afterTokens: 100_000,
  beforeRatio: 0.264,
  afterRatio: 0.1,
  pinHits: { inRange: 1, total: 2 },
});
assert.deepEqual(Object.keys(compactRecord).sort(), [
  'afterRatio',
  'afterTokens',
  'at',
  'beforeRatio',
  'beforeTokens',
  'durationMs',
  'freedTokens',
  'handoff',
  'kind',
  'pinHits',
  'schema',
]);
assert.equal(compactRecord.schema, LEDGER_SCHEMA);
assert.equal(compactRecord.kind, 'compact');
assert.equal(compactRecord.durationMs, 4322, '耗时四舍五入到整数 ms');
assert.equal(compactRecord.freedTokens, 164_000, '腾出 = 压前 - 压后');
assert.equal(compactRecord.beforeRatio, 0.264);
assert.equal(compactRecord.afterRatio, 0.1);
assert.deepEqual(compactRecord.pinHits, { inRange: 1, total: 2 });
assert.equal(compactRecord.handoff, null, '压缩记录没有交接单字段');

const handoffRecord = buildLedgerRecord({
  kind: 'handoff',
  at: '2026-10-24T21:31:00+08:00',
  durationMs: 9000,
  beforeTokens: 200_000,
  afterTokens: 120_000,
  beforeRatio: 0.2,
  afterRatio: 0.12,
  pinHits: { inRange: 0, total: 1 },
  handoff: { path: '/tmp/relay/handoff-2026-10-24T21-31-00-000Z.md', childId: 'session-abc', started: true },
});
assert.equal(handoffRecord.kind, 'handoff');
assert.equal(handoffRecord.handoff.path.endsWith('.md'), true, '交接记录带落盘路径');
assert.equal(handoffRecord.handoff.childId, 'session-abc');
assert.equal(handoffRecord.handoff.started, true);

assert.equal(buildLedgerRecord({ kind: 'bogus' }), null, '非法 kind 丢弃');
assert.equal(normalizeLedgerRecord({ schema: 'other', kind: 'compact' }), null, 'schema 不符不认');
assert.equal(normalizeLedgerRecord('junk'), null);

/* ================================================================== *
 * ③ 敏感 fixture：只记数值/路径，不含消息原文/摘要/交接单正文/sessionId/cwd
 * ================================================================== */

const CHAT = '消息原文唯一标记：把支付回调改成幂等';
const SUMMARY = '摘要正文唯一标记：已完成全部重构';
const HANDOFF_BODY = '交接单正文唯一标记：## 总体目标 把 X 改成 Y';
const sensitive = buildLedgerRecord({
  kind: 'handoff',
  at: '2026-10-24T21:32:00+08:00',
  durationMs: 100,
  beforeTokens: 10,
  afterTokens: 5,
  beforeRatio: 0.1,
  afterRatio: 0.05,
  pinHits: { inRange: 0, total: 1 },
  handoff: { path: '/tmp/relay/handoff-1.md', childId: 'session-abc', started: false },
  // 下面都是「不该进账本」的字段：buildLedgerRecord 走 allowlist，必须全部丢弃。
  message: CHAT,
  summary: SUMMARY,
  handoffBody: HANDOFF_BODY,
  sessionId: 'session-secret-123',
  cwd: '/Users/alice/work',
});
const sensitiveText = JSON.stringify(sensitive);
for (const needle of [CHAT, SUMMARY, HANDOFF_BODY, 'session-secret-123', '/Users/alice']) {
  assert.equal(sensitiveText.includes(needle), false, `账本不能出现隐私内容：${needle}`);
}
assert.equal(sensitiveText.includes('/tmp/relay/handoff-1.md'), true, '交接单路径按需求保留');

/* ================================================================== *
 * 读侧容错 + ② 汇总口径
 * ================================================================== */

const validLine = JSON.stringify(compactRecord);
const corruptText = [
  validLine,
  'not-json-at-all',
  '[]',
  JSON.stringify({ schema: 'other/v1', kind: 'compact' }),
  '',
  JSON.stringify({ schema: LEDGER_SCHEMA, kind: 'bogus' }),
].join('\n');
assert.equal(parseLedgerLines(corruptText).length, 1, '坏行/坏记录全部跳过，只剩一条合法记录');
assert.equal(parseLedgerLines('').length, 0);
assert.equal(parseLedgerLines(undefined).length, 0);

const summary = summarizeLedgerRecords([
  buildLedgerRecord({ kind: 'compact', at: '2026-10-24T21:30:00+08:00', durationMs: 1000, beforeTokens: 10_000, afterTokens: 6_000 }),
  buildLedgerRecord({ kind: 'compact', at: '2026-10-24T21:31:00+08:00', durationMs: 3000, beforeTokens: 6_000, afterTokens: 5_000 }),
  buildLedgerRecord({ kind: 'handoff', at: '2026-10-24T21:32:00+08:00', durationMs: 2000, beforeTokens: 5_000, afterTokens: 4_000 }),
]);
assert.deepEqual(summary, {
  count: 3,
  compactCount: 2,
  handoffCount: 1,
  freedTokens: 4_000 + 1_000 + 1_000,
  avgDurationMs: 2000,
  lastAt: '2026-10-24T21:32:00+08:00',
});
assert.deepEqual(summarizeLedgerRecords([]), {
  count: 0,
  compactCount: 0,
  handoffCount: 0,
  freedTokens: 0,
  avgDurationMs: null,
  lastAt: null,
});
assert.equal(LEDGER_MAX_ENTRIES, 200, '默认保留最近 200 条');

/* ================================================================== *
 * ④ IO 降级：损坏文件 / 不可写路径 / 缺失文件都不抛
 * ================================================================== */

const ioDir = tmpDir();
const ioFile = path.join(ioDir, 'nested', 'compact-relay-ledger.jsonl');
const store = createLedgerStore({ file: ioFile, maxEntries: 3 });
assert.deepEqual(store.records(), [], '文件不存在 → 空数组');
assert.equal(store.summary().count, 0);

// 上限裁剪：写 5 条只留最近 3 条。
for (let index = 0; index < 5; index += 1) {
  assert.deepEqual(
    store.record({
      kind: 'compact',
      durationMs: 1000 + index,
      beforeTokens: 10_000 - index * 100,
      afterTokens: 9_000 - index * 100,
      pinHits: { inRange: 0, total: 0 },
    }),
    { ok: true },
  );
}
const kept = store.records();
assert.equal(kept.length, 3, '超过上限只保留最近 3 条');
assert.equal(kept[2].durationMs, 1004, '保留的是最新记录');
assert.equal(fs.readFileSync(ioFile, 'utf8').trim().split('\n').length, 3, '文件里也只留 3 行');

// 损坏文件：坏行不影响读；还能继续追加。
fs.appendFileSync(ioFile, 'broken-line\n', 'utf8');
assert.equal(store.records().length, 3, '坏行被跳过');
assert.deepEqual(store.record({ kind: 'compact', durationMs: 2000 }), { ok: true }, '损坏后仍可追加');
assert.equal(store.records().length, 3, '裁剪逻辑仍正常（最近 3 条）');

// 不可写：把账本路径放到一个「普通文件」下面 → mkdir 失败，静默返回 ok:false。
const blocker = path.join(ioDir, 'blocker-file');
fs.writeFileSync(blocker, 'x', 'utf8');
const brokenStore = createLedgerStore({ file: path.join(blocker, 'ledger.jsonl') });
let threw = false;
let brokenResult = null;
try {
  brokenResult = brokenStore.record({ kind: 'compact', durationMs: 1 });
} catch {
  threw = true;
}
assert.equal(threw, false, '写失败不许抛（否则会影响压缩/交接本体）');
assert.deepEqual(brokenResult, { ok: false });
assert.deepEqual(brokenStore.records(), []);
assert.equal(brokenStore.summary().count, 0, '读失败按空账本处理');
assert.equal(brokenStore.record({ kind: 'bogus' }).ok, false, '非法记录静默丢弃');
assert.deepEqual(readLedgerFile(path.join(ioDir, 'missing.jsonl')), []);

/* ================================================================== *
 * ② 设置页数字与账本一致（settingsPayloadOf 用同一份账本文件）
 * ================================================================== */

const settingsDir = tmpDir();
const settingsFile = path.join(settingsDir, 'compact-relay.json');
const settings = createSettingsStore({ file: settingsFile });
const ledgerFile = path.join(settingsDir, 'compact-relay-ledger.jsonl');
const ledger = createLedgerStore({ file: ledgerFile });
ledger.record({
  kind: 'compact',
  durationMs: 4000,
  beforeTokens: 100_000,
  afterTokens: 60_000,
  beforeRatio: 0.1,
  afterRatio: 0.06,
  pinHits: { inRange: 1, total: 2 },
});
ledger.record({
  kind: 'handoff',
  durationMs: 8000,
  beforeTokens: 60_000,
  afterTokens: 40_000,
  beforeRatio: 0.06,
  afterRatio: 0.04,
  pinHits: { inRange: 0, total: 1 },
  handoff: { path: '/tmp/relay/handoff-2.md', childId: 'session-xyz', started: true },
});
const payload = settingsPayloadOf({ settings, ledger });
const expected = summarizeLedgerRecords(readLedgerFile(ledgerFile));
assert.deepEqual(payload.ledger, expected, '设置端点下发的累计数字必须与账本文件算出来的一致');
assert.equal(payload.ledger.count, 2);
assert.equal(payload.ledger.compactCount, 1);
assert.equal(payload.ledger.handoffCount, 1);
assert.equal(payload.ledger.freedTokens, 60_000, '腾出 = 40K + 20K');
assert.equal(payload.ledger.avgDurationMs, 6000);

// 没有账本（deps.ledger 缺失/读不到）→ ledger:null，设置页显示引导文案，不影响设置本身。
assert.equal(settingsPayloadOf({ settings }).ledger, null);

/* ================================================================== *
 * ⑥ 客户端静态守卫：设置页有「累计」一行（lib/client.js 已重建）
 * ================================================================== */

const settingsFragment = fs.readFileSync(new URL('../lib/client/50-settings.js', import.meta.url), 'utf8');
assert.equal(settingsFragment.includes('data-cr-ledger'), true, '设置页要有账本累计行标记');
assert.equal(settingsFragment.includes('腾出约'), true, '累计行要含腾出 tokens');
const bundle = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.equal(bundle.includes('data-cr-ledger'), true, 'lib/client.js 需要重建（--check 会兜底）');

console.log('PASS  0.4 P1-3 轻账本：字段完整 + allowlist（不含消息/摘要/交接单正文/sessionId/cwd）');
console.log('PASS  0.4 P1-3 轻账本：JSONL 追加 / 坏行跳过 / 上限裁剪 / 只读汇总口径');
console.log('PASS  0.4 P1-3 降级：文件损坏与不可写都不抛、不改变调用方成功/失败');
console.log('PASS  0.4 P1-3 设置页：累计数字与账本文件同源一致 + 客户端累计行已渲染');
