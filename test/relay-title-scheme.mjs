/**
 * 0.4.3 F1 单测：标题方案（handoff-n / history-n / legacy）。
 *
 * 锁定：
 *  - historyTitleOf 生成「历史 N：<原名>」，空格/全角冒号/序号写法与 relayTitleOf 同一套规则；
 *  - splitHandoffTitle 新增 scheme，但 baseTitle/handedOff 的字段名与旧语义不变；
 *  - 「交接：/接棒：」旧前缀仍走 legacy，可堆叠；
 *  - 空串/脏输入回落「会话」；>80 字节长标题不截断（0.4.3 只做纯函数，不改变现有长度行为）；
 *  - historyTitleOf → splitHandoffTitle 往返，两种 scheme 不混用。
 *
 * 为什么锁这些：0.5.0 的「历史 N + 原名继承」要靠这层解析做兜底；新 scheme 一旦
 * 和旧交接标题、legacy 前缀互相串味，接力链序号就会跳号/重号。
 */
import assert from 'node:assert/strict';
import { HISTORY_PREFIX, historyTitleOf, relayTitleOf, splitHandoffTitle } from '../lib/core/relay.js';

const parse = (title) => splitHandoffTitle(title);

/* ================================================================== *
 * 1) historyTitleOf：格式与 relayTitleOf 严格同规则
 * ================================================================== */

assert.equal(HISTORY_PREFIX, '历史');
assert.equal(historyTitleOf(1, '会话A'), '历史 1：会话A');
assert.equal(historyTitleOf(2, '会话A'), '历史 2：会话A');
assert.equal(historyTitleOf(3, '会话A'), '历史 3：会话A');
assert.equal(historyTitleOf(12, '会话A'), '历史 12：会话A', '两位序号照写（不补零/不换算）');
assert.equal(historyTitleOf(1, '  前后空格  '), '历史 1：前后空格', '原名先 trim');
assert.equal(historyTitleOf(1, '带：冒号 的 标题'), '历史 1：带：冒号 的 标题', '原名里的冒号原样保留');
assert.equal(historyTitleOf(1, ''), '历史 1：会话', '空原名兜底「会话」');
assert.equal(historyTitleOf(1, '   '), '历史 1：会话', '空白原名兜底「会话」');
assert.equal(historyTitleOf(1, undefined), '历史 1：会话');
assert.equal(historyTitleOf(1, null), '历史 1：会话');
assert.equal(historyTitleOf(1, 42), '历史 1：会话', '非字符串兜底「会话」');
assert.equal(relayTitleOf(2, '会话A'), '交接第 2 次：会话A', '旧生成格式不变');

/* ================================================================== *
 * 2) history-n：历史 1/2/3、两位数、容错空格与半角冒号
 * ================================================================== */

assert.deepEqual(parse('历史 1：X'), { baseTitle: 'X', handedOff: 1, scheme: 'history-n' });
assert.deepEqual(parse('历史 2：X'), { baseTitle: 'X', handedOff: 2, scheme: 'history-n' });
assert.deepEqual(parse('历史 3：X'), { baseTitle: 'X', handedOff: 3, scheme: 'history-n' });
assert.deepEqual(parse('历史 12：X'), { baseTitle: 'X', handedOff: 12, scheme: 'history-n' }, '两位数序号');
assert.deepEqual(parse('历史12：X'), { baseTitle: 'X', handedOff: 12, scheme: 'history-n' }, '序号前空格可省（与交接第 N 次一致）');
assert.deepEqual(parse('历史 3: X'), { baseTitle: 'X', handedOff: 3, scheme: 'history-n' }, '半角冒号兼容（与旧解析一致）');
assert.deepEqual(parse('  历史 4：X  '), { baseTitle: 'X', handedOff: 4, scheme: 'history-n' }, '整体前后空白先 trim');
assert.deepEqual(parse('历史 2：'), { baseTitle: '会话', handedOff: 2, scheme: 'history-n' }, '只有前缀没有原名 → 兜底');
assert.deepEqual(parse('历史：X'), { baseTitle: '历史：X', handedOff: 0, scheme: 'legacy' }, '没有序号的「历史：」不算 history-n');

/* ================================================================== *
 * 3) handoff-n：现有「交接第 N 次：」解析结果不变
 * ================================================================== */

assert.deepEqual(parse('交接第 1 次：X'), { baseTitle: 'X', handedOff: 1, scheme: 'handoff-n' });
assert.deepEqual(parse('交接第2次:X'), { baseTitle: 'X', handedOff: 2, scheme: 'handoff-n' });
assert.deepEqual(parse('交接第 12 次：X'), { baseTitle: 'X', handedOff: 12, scheme: 'handoff-n' });
assert.deepEqual(parse('交接第 3 次：'), { baseTitle: '会话', handedOff: 3, scheme: 'handoff-n' });

/* ================================================================== *
 * 4) legacy：旧「交接：/接棒：」堆叠、无前缀、空/脏输入
 * ================================================================== */

assert.deepEqual(parse('交接：X'), { baseTitle: 'X', handedOff: 1, scheme: 'legacy' });
assert.deepEqual(parse('接棒：X'), { baseTitle: 'X', handedOff: 1, scheme: 'legacy' });
assert.deepEqual(parse('交接：接棒：X'), { baseTitle: 'X', handedOff: 2, scheme: 'legacy' }, '旧前缀可堆叠');
assert.deepEqual(parse('交接：'), { baseTitle: '会话', handedOff: 1, scheme: 'legacy' });
assert.deepEqual(parse('普通会话标题'), { baseTitle: '普通会话标题', handedOff: 0, scheme: 'legacy' }, '无前缀不改名');

for (const dirty of [undefined, null, '', '   ', '\n\t', 42, {}, [], true]) {
  assert.deepEqual(
    parse(dirty),
    { baseTitle: '会话', handedOff: 0, scheme: 'legacy' },
    `空/脏输入回落「会话」：${JSON.stringify(dirty)}`,
  );
}

// 旧字段名与数量：只多一个 scheme，不乱塞别的字段。
assert.deepEqual(
  Object.keys(parse('任意标题')).sort(),
  ['baseTitle', 'handedOff', 'scheme'],
  '返回字段 = baseTitle/handedOff + 新增 scheme',
);

/* ================================================================== *
 * 5) 往返：historyTitleOf → splitHandoffTitle
 * ================================================================== */

for (const base of ['会话A', '带：冒号 的标题', '原会话标题', '历史 1：看起来像前缀的原名']) {
  for (const n of [1, 2, 3, 12]) {
    assert.deepEqual(
      parse(historyTitleOf(n, base)),
      { baseTitle: base, handedOff: n, scheme: 'history-n' },
      `往返：历史 ${n}：${base}`,
    );
  }
}
assert.deepEqual(parse(historyTitleOf(2, '')), { baseTitle: '会话', handedOff: 2, scheme: 'history-n' }, '往返也守兜底');

/* ================================================================== *
 * 6) scheme 不混用：前缀决定 scheme，原名里的另一种标题原样保留
 * ================================================================== */

assert.equal(parse(historyTitleOf(2, 'X')).scheme, 'history-n');
assert.notEqual(parse(historyTitleOf(2, 'X')).scheme, 'handoff-n');
assert.equal(parse(relayTitleOf(2, 'X')).scheme, 'handoff-n');
assert.notEqual(parse(relayTitleOf(2, 'X')).scheme, 'history-n');
assert.equal(parse('交接：历史 2：X').scheme, 'legacy', '旧前缀开头不会被当成 history-n');
assert.equal(parse('历史 2：交接第 1 次：X').scheme, 'history-n', '历史前缀开头优先于名字里的交接标题');
assert.equal(parse('历史 2：交接第 1 次：X').baseTitle, '交接第 1 次：X');
assert.equal(parse(relayTitleOf(1, historyTitleOf(2, 'X'))).scheme, 'handoff-n', '交接前缀开头优先');
assert.equal(parse(relayTitleOf(1, historyTitleOf(2, 'X'))).baseTitle, '历史 2：X');
assert.equal(parse(historyTitleOf(1, relayTitleOf(2, 'X'))).baseTitle, '交接第 2 次：X');

/* ================================================================== *
 * 7) 超长标题（>80 字节）：不截断、不抛，解析结果与生成一致
 * ================================================================== */

const longBase = '很长的会话标题'.repeat(12);
assert.equal(Buffer.byteLength(longBase, 'utf8') > 80, true, '夹具要超过 80 字节');
const longHistory = historyTitleOf(3, longBase);
assert.equal(Buffer.byteLength(longHistory, 'utf8') > 80, true);
const longParsed = parse(longHistory);
assert.equal(longParsed.baseTitle, longBase, '0.4.3 纯函数层不截断（现有行为不变）');
assert.equal(longParsed.handedOff, 3);
assert.equal(longParsed.scheme, 'history-n');
assert.equal(parse(relayTitleOf(3, longBase)).baseTitle, longBase, '交接标题同样不截断（现有行为不变）');

console.log('PASS  0.4.3 F1 生成：历史 N 空格/全角冒号/序号写法与 relayTitleOf 同规则');
console.log('PASS  0.4.3 F1 解析：历史 1/2/3/12 + 容错空格半角冒号 + 空题兜底');
console.log('PASS  0.4.3 F1 旧链：交接第 N 次 / 交接：/接棒：堆叠 / 无前缀 / 空脏输入结果不变');
console.log('PASS  0.4.3 F1 往返：historyTitleOf → splitHandoffTitle 还原原名与序号');
console.log('PASS  0.4.3 F1 scheme：handoff-n / history-n / legacy 不混用，前缀优先');
console.log('PASS  0.4.3 F1 超长：>80 字节标题不截断不抛（现有行为不变）');
