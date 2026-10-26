/**
 * 0.4 P2-1 + P2-2 单测（纯函数层）：交接预览「两段可编辑」+ 接力链元数据。
 *
 * P2-1 覆盖：
 *  - 只允许「约束 / 下一步」两段；程序生成段/拼错段名/非对象 → 抛 code='edits'（HTTP 层映射 400）；
 *  - 空值/空白 → 回落原文（不覆盖）；超长拒绝；applyHandoffEdits 只动两段、不改入参；
 *  - composeHandoffText 仍是九段固定顺序（九段结构不变）。
 * P2-2 覆盖：
 *  - relay 记录 canonical 字段 parentId/childId/ordinal/at/atIso；
 *  - 0.3 旧记录（parentSessionId/index）读出来补齐 canonical 字段，新旧字段一致。
 *
 * 0.4.3 F2 覆盖：
 *  - 白名单放行 scheme（handoff-n/history-n）/titleSeq（正整数）/historyTitle（非空字符串）；
 *  - 旧记录三个新字段读成 null；非法值回落 null，不连坐必填字段。
 *
 * 集成（预览→确认→落盘内容生效、程序段被拒、链式第 2 次交接）在 test/handoff.mjs。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  HANDOFF_EDIT_MAX_CHARS,
  applyHandoffEdits,
  editableHandoffView,
  normalizeHandoffEdits,
} from '../lib/core/handoff-edit.js';
import { HANDOFF_EDITABLE_SECTIONS, HANDOFF_SECTIONS, composeHandoffText } from '../lib/core/handoff-spec.js';
import { normalizeRelayRecord } from '../lib/dsh/relay.js';

/* ================================================================== *
 * P2-1 可编辑段：白名单 / 空值回落 / 超长 / 非法字段
 * ================================================================== */

assert.deepEqual([...HANDOFF_EDITABLE_SECTIONS], ['约束', '下一步'], '只有这两段可编辑');
assert.equal(HANDOFF_EDIT_MAX_CHARS, 4000);

assert.deepEqual(normalizeHandoffEdits(undefined), {}, '没传编辑 = 不覆盖');
assert.deepEqual(normalizeHandoffEdits(null), {});
assert.deepEqual(
  normalizeHandoffEdits({ 约束: '  禁止改公开 API  ', 下一步: '先跑 npm test' }),
  { 约束: '禁止改公开 API', 下一步: '先跑 npm test' },
  '合法两段：trim 后保留',
);
assert.deepEqual(normalizeHandoffEdits({ 约束: '   ', 下一步: '' }), {}, '空值/空白回落原文（等同没改）');
assert.deepEqual(normalizeHandoffEdits({}), {});

// 非法字段：程序生成的段 / 拼错的段名 / 非字符串 / 非对象 → code='edits'，消息说明哪些段不能改。
for (const [edits, needle] of [
  [{ 当前进度: '伪造进度' }, '当前进度'],
  [{ 改过的文件: '伪造文件' }, '改过的文件'],
  [{ 总体目标: '伪造目标' }, '总体目标'],
  [{ Goal: 'x' }, 'Goal'],
]) {
  assert.throws(
    () => normalizeHandoffEdits(edits),
    (error) => {
      assert.equal(error.code, 'edits', `非法字段必须抛 code=edits：${needle}`);
      assert.equal(error.message.includes('只能编辑'), true, '错误信息要说明只允许两段');
      assert.equal(error.message.includes(needle), true, `错误信息要点名非法字段：${needle}`);
      return true;
    },
  );
}
assert.throws(() => normalizeHandoffEdits('not-an-object'), (error) => error.code === 'edits');
assert.throws(() => normalizeHandoffEdits([]), (error) => error.code === 'edits');
assert.throws(() => normalizeHandoffEdits({ 约束: 42 }), (error) => error.code === 'edits');
assert.throws(
  () => normalizeHandoffEdits({ 约束: 'x'.repeat(HANDOFF_EDIT_MAX_CHARS + 1) }),
  (error) => error.code === 'edits' && error.message.includes('长度上限'),
  '超长拒绝（不静默截断）',
);

// applyHandoffEdits：只覆盖两段、返回新对象、不改入参。
const originalSections = Object.fromEntries(HANDOFF_SECTIONS.map((title) => [title, `原文-${title}`]));
const edited = applyHandoffEdits(originalSections, { 约束: '新约束', 下一步: '新下一步' });
assert.equal(edited['约束'], '新约束');
assert.equal(edited['下一步'], '新下一步');
assert.equal(edited['当前进度'], '原文-当前进度', '程序段不许被覆盖');
assert.equal(originalSections['约束'], '原文-约束', '不改入参');
assert.deepEqual(
  applyHandoffEdits(originalSections, { 约束: '   ' })['约束'],
  '原文-约束',
  '空编辑不覆盖（回落原文）',
);

// composeHandoffText：九段固定顺序 + 标题格式不变（P2-1 只改文本内容，不改段数）。
const composed = composeHandoffText(originalSections);
const positions = HANDOFF_SECTIONS.map((title) => composed.indexOf(`## ${title}`));
assert.equal(positions.every((position) => position >= 0), true, '九段标题都在');
assert.deepEqual(positions, [...positions].sort((a, b) => a - b), '九段顺序固定');

// editableHandoffView：客户端只拿到两段 + 上限 + 不可改说明。
const view = editableHandoffView(originalSections);
assert.deepEqual(view.titles, ['约束', '下一步']);
assert.equal(view.maxChars, HANDOFF_EDIT_MAX_CHARS);
assert.equal(view.sections['约束'], '原文-约束');
assert.equal(view.note.includes('不能改'), true, '预览要说明程序生成段不可改');

/* ================================================================== *
 * P2-2 relay 元数据：canonical 字段 + 旧记录兼容
 * ================================================================== */

const newRecord = normalizeRelayRecord({
  parentId: 'session-parent',
  childId: 'session-child',
  ordinal: 2,
  at: 1_730_000_000_000,
  atIso: '2026-10-24T21:30:00+08:00',
  path: '/tmp/handoff-1.md',
  planId: 'plan-1',
  title: '交接第 2 次：原题',
  baseTitle: '原题',
});
assert.equal(newRecord.parentId, 'session-parent');
assert.equal(newRecord.childId, 'session-child');
assert.equal(newRecord.ordinal, 2);
assert.equal(newRecord.at, 1_730_000_000_000);
assert.equal(newRecord.atIso, '2026-10-24T21:30:00+08:00');
assert.equal(newRecord.parentSessionId, 'session-parent', '旧字段别名同步（兼容 0.3）');
assert.equal(newRecord.index, 2);
assert.equal(newRecord.path, '/tmp/handoff-1.md');
// 0.4.3 F2：旧记录没有新字段 → 一律 null（旧字段读取语义不变）。
assert.equal(newRecord.scheme, null, '旧记录没有 scheme → null');
assert.equal(newRecord.titleSeq, null, '旧记录没有 titleSeq → null');
assert.equal(newRecord.historyTitle, null, '旧记录没有 historyTitle → null');

// 0.3 旧记录：只有 parentSessionId/index → 读出来补齐 canonical 字段。
const legacy = normalizeRelayRecord({ parentSessionId: 'session-old', childId: 'session-kid', index: 1, at: 123 });
assert.equal(legacy.parentId, 'session-old');
assert.equal(legacy.ordinal, 1);
assert.equal(legacy.index, 1);
assert.equal(legacy.atIso, null, '旧记录没有 ISO 时间就 null（不猜）');
assert.equal(legacy.scheme, null);
assert.equal(legacy.titleSeq, null);
assert.equal(legacy.historyTitle, null);

// 0.4.3 F2：0.5.0 命名反转的预留字段能读回（只放行，不改变必填校验）。
const namedRecord = normalizeRelayRecord({
  parentId: 'session-parent',
  childId: 'session-child',
  ordinal: 2,
  at: 1_730_000_000_000,
  scheme: 'history-n',
  titleSeq: 2,
  historyTitle: '历史 2：原题',
});
assert.equal(namedRecord.scheme, 'history-n');
assert.equal(namedRecord.titleSeq, 2);
assert.equal(namedRecord.historyTitle, '历史 2：原题');
assert.equal(namedRecord.ordinal, 2, '新字段不影响必填字段');

const handoffScheme = normalizeRelayRecord({ childId: 'c', ordinal: 1, scheme: 'handoff-n' });
assert.equal(handoffScheme.scheme, 'handoff-n');
assert.equal(handoffScheme.titleSeq, null, '没给 titleSeq 仍为 null');
assert.equal(handoffScheme.historyTitle, null);

// 非法可选值 → null，不连坐其它字段。scheme 只认两种新标题，legacy 不写进记录。
for (const scheme of ['legacy', 'bogus', '', 1, null, undefined]) {
  const record = normalizeRelayRecord({ childId: 'c', ordinal: 1, scheme });
  assert.equal(record.scheme, null, `scheme 只认 handoff-n/history-n：${String(scheme)}`);
  assert.equal(record.ordinal, 1, '非法 scheme 不影响必填字段');
}
for (const titleSeq of [0, -1, 1.5, '3', NaN, null]) {
  const record = normalizeRelayRecord({ childId: 'c', ordinal: 1, titleSeq });
  assert.equal(record.titleSeq, null, `titleSeq 必须是正整数：${String(titleSeq)}`);
}
for (const historyTitle of ['', 42, null, {}, []]) {
  const record = normalizeRelayRecord({ childId: 'c', ordinal: 1, historyTitle });
  assert.equal(record.historyTitle, null, 'historyTitle 必须非空字符串');
}

// 不合法记录：没有 childId / 没有序号 → null。
assert.equal(normalizeRelayRecord({ parentId: 'p', ordinal: 1 }), null);
assert.equal(normalizeRelayRecord({ childId: 'c', at: 1 }), null);
assert.equal(normalizeRelayRecord('junk'), null);

/* ================================================================== *
 * 客户端静态守卫：预览卡有「两段可编辑」入口 + 不可改说明（lib/client.js 已重建）
 * ================================================================== */

const bundle = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.equal(bundle.includes('data-cr-handoff-edit'), true, '交接预览卡要有两段可编辑 textarea');
assert.equal(bundle.includes('可编辑两段'), true);
const fragment = fs.readFileSync(new URL('../lib/client/30-indicator.js', import.meta.url), 'utf8');
assert.equal(fragment.includes('程序生成的段不可改') || fragment.includes('editable.note'), true, '界面要保留「程序生成段不可改」说明');

console.log('PASS  0.4 P2-1 可编辑段：只有「约束/下一步」，空值回落、超长/非法字段 code=edits');
console.log('PASS  0.4 P2-1 九段结构：composeHandoffText 仍固定九段顺序，程序段不许覆盖');
console.log('PASS  0.4 P2-2 relay 元数据：parentId/childId/ordinal/at/atIso + 旧记录兼容');
console.log('PASS  0.4.3 F2 relay 字段：scheme/titleSeq/historyTitle 白名单放行，旧记录 null、非法值回落');
console.log('PASS  0.4 P2-1 客户端：交接预览卡有可编辑两段入口（bundle 已重建）');
