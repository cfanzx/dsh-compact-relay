/**
 * 0.5.1 D03：文本截断两个共享口径（`lib/core/clip.js`）—— 单测 + 迁移点回归。
 *
 *   node test/clip.mjs
 *
 * 背景（架构评审 D03）：截断散在 6 处、3 种单位（UTF-16 码元 / 码点 / UTF-8 字节）、
 * 2 种省略号预算策略，0.6 工作树里又写了两份逐行相同的「按码点截断加省略号」。
 * 0.5.1 把「字符截断」收成两个函数：
 *   - `clipChars`：按**码点**（Array.from），emoji 不会被切半；
 *   - `clipCodeUnits`：按**UTF-16 码元**（String.prototype.slice，旧行为，逐字节兼容）。
 * 省略号预算显式命名：
 *   - 'inside'（默认）：省略号算进上限 —— 结果长度 ≤ max（旧 `max-1 + '…'` 口径）；
 *   - 'append'：省略号额外多 1 字符 —— compaction-log 的预览既有输出，必须保留；
 *   - false：不补省略号。
 * 字节预算（标题 80B）**不**并进来：那是宿主 `session-title` 契约克隆（core/relay.js）。
 *
 * 本文件同时锁住迁移点的既有输出（60 字摘要 / 200 字预览 / 140 字错误原因），
 * 保证「消重复不改行为」。
 */
import assert from 'node:assert/strict';
import { clipChars, clipCodeUnits } from '../lib/core/clip.js';
import { messageSnippetOf } from '../lib/core/pin-anchors.js';
import { collectCompactions } from '../lib/dsh/compaction-log.js';
import { errorText } from '../lib/core/errors.js';
import { actionError } from '../lib/core/errors.js';

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/* ------------------------------------------------------------------ *
 * 1. clipChars：码点口径
 * ------------------------------------------------------------------ */

test('clipChars inside：结果按码点计 ≤ max，超出补一个省略号', () => {
  assert.equal(clipChars('abcdef', 4), 'abc…');
  assert.equal(clipChars('abcdef', 6), 'abcdef', '刚好等于上限原样返回');
  assert.equal(clipChars('abcdef', 7), 'abcdef');
  assert.equal(clipChars('abcdef', 1), '…', '上限 1 只剩省略号（仍算「截断过」）');
  assert.equal(clipChars('abcdef', 0), '…', '上限 0：旧实现给一个省略号，保持一致');
  // 中文按码点 = 按字，不按字节。
  assert.equal(clipChars('一二三四五', 3), '一二…');
  assert.equal(clipChars('一二三四五', 5), '一二三四五');
});

test('clipChars：emoji（代理对）按码点截断，不切出半个字符', () => {
  const emoji = '😀😁😂😃';
  assert.equal(Array.from(emoji).length, 4);
  assert.equal(clipChars(emoji, 2), '😀…');
  assert.equal(clipChars(emoji, 3), '😀😁…');
  // 对照：码元口径同样输入会切在代理对中间（这是它「不切 emoji」的差异点）。
  assert.equal(clipCodeUnits(emoji, 2), '\ud83d…');
});

test('clipChars append / false：省略号预算显式可选', () => {
  assert.equal(clipChars('abcdef', 2, { ellipsis: 'append' }), 'ab…', 'append 允许比上限多 1 字符');
  assert.equal(clipChars('abcdef', 2, { ellipsis: false }), 'ab');
  assert.equal(clipChars('abcdef', 0, { ellipsis: false }), '');
});

test('clipChars：非字符串 / 非法 max 不抛错', () => {
  for (const dirty of [undefined, null, 42, {}, [], true]) {
    assert.equal(clipChars(dirty, 5), '', `非字符串回落空串：${JSON.stringify(dirty)}`);
  }
  assert.equal(clipChars('abcdef', undefined), 'abcdef', 'max 非法 → 原样返回（不猜预算）');
  assert.equal(clipChars('abcdef', Number.NaN), 'abcdef');
  assert.equal(clipChars('abcdef', 3.9), 'ab…', '小数上限向下取整');
});

/* ------------------------------------------------------------------ *
 * 2. clipCodeUnits：码元口径（旧行为逐字节兼容）
 * ------------------------------------------------------------------ */

test('clipCodeUnits inside：与旧 `slice(0, max-1) + …` 完全一致', () => {
  for (const [text, max] of [
    ['abcdef', 4],
    ['abcdef', 6],
    ['abcdef', 1],
    ['一二三四五', 3],
    ['x'.repeat(200), 60],
  ]) {
    const legacy = text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
    assert.equal(clipCodeUnits(text, max), legacy, `码元口径必须逐字节兼容：${max}`);
    assert.equal(clipCodeUnits(text, max).length <= Math.max(max, 1), true);
  }
  assert.equal(clipCodeUnits('abcdef', 0), '…');
  assert.equal(clipCodeUnits(undefined, 4), '');
  assert.equal(clipCodeUnits('abcdef', undefined), 'abcdef');
});

test('clipCodeUnits append：压缩历史预览的「多 1 字符」既有输出必须保留', () => {
  const text = 'y'.repeat(5);
  assert.equal(clipCodeUnits(text, 3, { ellipsis: 'append' }), `${'y'.repeat(3)}…`);
  assert.equal(clipCodeUnits(text, 5, { ellipsis: 'append' }), text, '刚好等于上限不截断');
  assert.equal(clipCodeUnits(text, 6, { ellipsis: 'append' }), text);
  assert.equal(clipCodeUnits(text, 3, { ellipsis: false }), 'yyy');
});

/* ------------------------------------------------------------------ *
 * 3. 迁移点回归：行为不变（60 字摘要 / 200 字预览 / 140 字错误原因）
 * ------------------------------------------------------------------ */

test('迁移点 pin-anchors.messageSnippetOf：60 字符上限 + 省略号 + 空文本', () => {
  const long = { type: 'user/message', data: { role: 'user', content: '锁定'.repeat(80) } };
  const snippet = messageSnippetOf(long);
  assert.equal(snippet.length <= 60, true, '摘要 ≤60');
  assert.equal(snippet.endsWith('…'), true);
  assert.equal(snippet, `${'锁定'.repeat(80).slice(0, 59)}…`, '逐字节等于旧实现');
  assert.equal(messageSnippetOf({ type: 'user/message', data: { role: 'user', content: '短' } }), '短');
  assert.equal(messageSnippetOf({ type: 'user/message', data: { role: 'user', content: '' } }), '');
  assert.equal(messageSnippetOf({ type: 'user/message', data: { role: 'user', content: 'a\n\n b' } }), 'a b');
});

test('迁移点 compaction-log.previewOf：200 字 + 省略号（多 1）与 previewTruncated', () => {
  const exact = 'z'.repeat(200);
  const over = 'z'.repeat(201);
  const session = (summary) => ({
    id: 'session-clip-preview',
    log: [
      { seq: 0, type: 'compaction/summary', data: { compactionId: 'a', summary } },
      { seq: 1, type: 'compaction/end', data: { compactionId: 'a' } },
      { seq: 2, type: 'user/message', data: { role: 'user' }, sourceEventSeqs: [0] },
    ],
  });
  const exactItem = collectCompactions(session(exact), { limit: 1 })[0];
  assert.equal(exactItem.preview, exact, '刚好 200 字原样返回');
  assert.equal(exactItem.previewTruncated, false);
  const overItem = collectCompactions(session(over), { limit: 1 })[0];
  assert.equal(overItem.preview, `${'z'.repeat(200)}…`, '201 字 → 前 200 字 + 省略号（长度 201）');
  assert.equal(overItem.preview.length, 201, '既有输出：预览最多 200 字 + 省略号');
  assert.equal(overItem.previewTruncated, true);
});

test('迁移点 errors.errorText：错误原因 140 字截断 + 省略号', () => {
  const long = '坏'.repeat(200);
  const text = errorText(actionError('summary', long));
  assert.ok(text.includes('原因：'), text);
  const detail = text.split('原因：')[1];
  assert.equal(detail, `${'坏'.repeat(139)}…`, '原因保留 139 字 + 省略号（合计 140）');
  const short = errorText(actionError('summary', '短原因'));
  assert.equal(short.endsWith('原因：短原因'), true, '短原因不截断');
});

/* ------------------------------------------------------------------ *
 * 4. 执行
 * ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
for (const [name, fn] of cases) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL  ${name}`);
  }
}

console.log(`\nclip：${passed}/${cases.length} 通过`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}\n${failure.error && failure.error.stack ? failure.error.stack : failure.error}`);
  }
  process.exit(1);
}
