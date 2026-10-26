/**
 * 0.5.0 F5 链不变量测试 —— 锁住「命名反转」依赖的三层数据契约。
 *
 * 为什么单独一个文件：0.5.0 会把旧会话改名「历史 N：<原名>」、新会话继承原名；
 * 那时**标题里不再有链号**，「第几次交接」只能从 relay record 读。F1（scheme 纯函数）、
 * F3（子会话 record）、F4（readState.chain 投影）各自有单测，本文件只锁它们串成
 * 一条接力链之后的不变量：
 *
 *   1) 三跳接力：第 1/2/3 次序号 1→2→3，标题干净（原题无前缀）也不重号；
 *   2) record 形状：子会话自带 canonical 字段，父会话记录刻意不写 F2 新字段（现网写出不变）；
 *   3) scheme 不混用：交接第 N 次 / 历史 N / legacy 各归各的，history 标题可往返；
 *   4) 旧链兼容：交接第 N 次解析逐字节不变（固定期望，不随实现漂）；
 *   5) 投影：relayChainOf 只取记录字段，缺的给 null、没 path 就不出现这个键；
 *      6) readState：chain 与 relay 同源下发（老字段一个不改）。
 *
 * 只锁**现有行为**，不测 0.5.0 尚未实现的改名/接力条/自动归档。这里红 = 地基契约被改，
 * 需要连同 0.5.0 的迁移方案一起评审，而不是顺手把期望改掉。
 *
 *   node test/relay-chain.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handoff } from '../lib/actions/handoff.js';
import { createLock } from '../lib/actions/lock.js';
import { readState } from '../lib/actions/state.js';
import { resolveConfig } from '../lib/config.js';
import { HANDOFF_SECTIONS } from '../lib/core/handoff-doc.js';
import { HISTORY_PREFIX, RELAY_RECORD_TYPE, historyTitleOf, relayTitleOf, splitHandoffTitle } from '../lib/core/relay.js';
import { REQUIRED_SECTIONS } from '../lib/core/validate-summary.js';
import { handoffTitlePlanOf } from '../lib/dsh/sessions.js';
import { normalizeRelayRecord, relayChainOf, relayRecordOf } from '../lib/dsh/relay.js';
import { createAgent, createFakeEngine, createHandoffHost, createPluginDeps, createTmpDir } from './harness/host.mjs';
import { createFakeLlm } from './harness/llm.mjs';
import { MockSession, baseSourceSession } from './harness/session.mjs';

/* ================================================================== *
 * 夹具：确定性摘要/交接单回复 + 三跳接力链
 *
 * 标题服务恒返回干净原题「原会话标题」（splitHandoffTitle → handedOff=0），
 * 与 0.5.0 改名后的「历史 N：原会话标题」一样解析不出链号 —— 序号只能靠 record。
 * ================================================================== */

const CLEAN_TITLE = '原会话标题';

function summaryReply() {
  return REQUIRED_SECTIONS.map((section) => `${section}\n- ${section}：根据本轮变更记录关键结论与证据`).join('\n');
}

function handoffReply() {
  return HANDOFF_SECTIONS.map(
    (section) => `## ${section}\n- ${section}的内容：完成验证、记录结论并标注下一步`,
  ).join('\n');
}

function makeChainHost() {
  const llm = createFakeLlm({
    routes: [
      {
        kind: 'handoff',
        match: ({ instruction }) => instruction.includes('交接文档'),
        replies: [handoffReply()],
      },
      { kind: 'summary', match: () => true, replies: [summaryReply()] },
    ],
  });
  const engine = createFakeEngine();
  const { ctx, record } = createHandoffHost({ llm, engine });
  return { ctx, engine, record };
}

/** 会话日志里的全部 relay 记录事件（父记录 + 子记录都在各自的 log 里）。 */
function relayEventsOf(session) {
  return session.log.filter((event) => event?.type === RELAY_RECORD_TYPE);
}

/**
 * 「这条会话自己的」record：F3 写进子会话的那条（data.childId === 本会话 id）。
 * 之后本会话再交接时，父记录的 childId 指向下一代，不会混进来。
 */
function ownRecordsOf(session) {
  return relayEventsOf(session).filter((event) => event?.data?.childId === session.id);
}

/** 用标题服务造一个最小 ctx（handoffTitlePlanOf 只需要 relay 记录 + 标题）。 */
function ctxWithTitle(title) {
  return {
    get(name) {
      return name === 'sessionTitle' ? { get: () => ({ title }) } : undefined;
    },
  };
}

// 三跳接力：source → child1 → child2 → child3，每跳用独立 handoffDir。
const { ctx, engine, record } = makeChainHost();
const source = baseSourceSession();
const hops = [];
let parent = source;
for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir(`relay-f5-chain-${ordinal}-`) });
  const plan = handoffTitlePlanOf(ctx, parent);
  const result = await handoff(deps, { agent: createAgent(parent) });
  const child = record.child;
  hops.push({ ordinal, parent, child, plan, result });
  parent = child;
}
const [firstHop, secondHop, thirdHop] = hops;

/* ================================================================== *
 * 1) 三跳链序号 1→2→3：标题干净也不重号
 * ================================================================== */

for (const hop of hops) {
  const { ordinal, parent: hopParent, child, plan } = hop;
  // 前提：这一跳的父会话标题解析不出链号（0.5.0 改名成「历史 N」后同样为 0）。
  assert.equal(splitHandoffTitle(CLEAN_TITLE).handedOff, 0, '夹具标题本身不带链号');
  assert.equal(plan.index, ordinal, `第 ${ordinal} 跳 plan.index 必须是 ${ordinal}`);
  assert.equal(plan.baseTitle, CLEAN_TITLE, '原题不随标题前缀变化');
  assert.equal(plan.title, `交接第 ${ordinal} 次：${CLEAN_TITLE}`, '交接标题序号连续');
  // 第 1 跳没有父记录可用（旧会话），第 2 跳起必须走 record，不能回退标题解析。
  assert.equal(plan.viaRecord, ordinal > 1, `第 ${ordinal} 跳 viaRecord`);

  const own = ownRecordsOf(child);
  assert.equal(own.length, 1, `第 ${ordinal} 跳子会话恰有 1 条自己的 record`);
  assert.equal(own[0].data.ordinal, ordinal, `子会话 record ordinal=${ordinal}`);
  assert.equal(own[0].data.baseTitle, CLEAN_TITLE);
  assert.equal(own[0].data.parentId, hopParent.id, 'record.parentId 指向真正的父会话');
  assert.equal(own[0].data.childId, child.id);
  assert.equal(relayRecordOf(hopParent).ordinal, ordinal, '父会话里这一跳的 record 同号');

  // 交接单头部的「第 N 次交接」与实际链号一致（文档与数据不能各说各话）。
  const doc = fs.readFileSync(hop.result.path, 'utf8');
  assert.equal(doc.includes(`- 交接序号：第 ${ordinal} 次交接`), true, `第 ${ordinal} 跳交接单序号`);
}

assert.deepEqual(
  hops.map((hop) => ownRecordsOf(hop.child)[0].data.ordinal),
  [1, 2, 3],
  '三跳链序号依次 1、2、3',
);
assert.deepEqual(
  record.renames.map((rename) => rename.title),
  [
    '交接第 1 次：原会话标题',
    '交接第 2 次：原会话标题',
    '交接第 3 次：原会话标题',
  ],
  '三跳标题 1→2→3，不重号',
);

// 标题被手改/改成「历史 N」时，链号与原名仍以 record 为准（0.5.0 改名后的真实场景）。
{
  const drifted = new MockSession({
    id: 'session-title-drift',
    events: [
      {
        type: RELAY_RECORD_TYPE,
        ignorable: true,
        data: { parentId: 'gp', childId: 'session-title-drift', ordinal: 2, baseTitle: CLEAN_TITLE, scheme: 'handoff-n', at: 1 },
      },
    ],
  });
  const plan = handoffTitlePlanOf(ctxWithTitle('历史 9：被手改过的面板标题'), drifted);
  assert.equal(plan.viaRecord, true);
  assert.equal(plan.index, 3, '链号 = record.ordinal + 1，标题里的 9 不参与');
  assert.equal(plan.baseTitle, CLEAN_TITLE, '原题来自 record，不跟着面板标题跑');
}

console.log('PASS  0.5.0 F5 链序号：三跳接力 1→2→3，标题干净/被改名也不重号');

/* ================================================================== *
 * 2) record 形状：子会话字段齐全，父会话记录不写新字段（现网写出不变）
 * ================================================================== */

{
  const childEvent = ownRecordsOf(firstHop.child)[0];
  const childRecord = childEvent.data;

  // 事件层：走 plugin record 通道（ignorable），不进模型可见 surface。
  assert.equal(childEvent.ignorable, true, '子记录走 plugin record 通道');
  assert.equal(firstHop.child.surface.nodes.includes(childEvent.seq), false, '记录不进模型可见 surface（不算 token）');

  // canonical 字段齐全（0.5.0 命名反转后靠这些字段，不靠 title 文案）。
  assert.equal(childRecord.parentId, source.id);
  assert.equal(childRecord.childId, firstHop.child.id);
  assert.equal(childRecord.ordinal, 1);
  assert.equal(childRecord.baseTitle, CLEAN_TITLE);
  assert.equal(childRecord.scheme, 'handoff-n', '交接产生的链固定写 handoff-n');
  assert.equal(childRecord.title, '交接第 1 次：原会话标题');
  assert.equal(Number.isInteger(childRecord.at), true);
  assert.equal(typeof childRecord.atIso, 'string');
  assert.equal(childRecord.titleSeq, null, 'rename 不返回 eventSeq 时写 null（不猜）');
  assert.equal('historyTitle' in childRecord, false, 'handoff-n 记录不写 historyTitle');
  assert.equal('path' in childRecord, false, '子记录不重复父记录的交接单路径');

  // 读回：白名单补齐 0.3 旧名（只读别名，不改写盘形状）。
  // 注意用「自己的那条」原始 data 归一化，不用 relayRecordOf(child) —— 终态里
  // child1 已经交接出下一代，日志最新一条会是第 2 跳的**父记录**（ordinal=2）。
  const childRead = normalizeRelayRecord(childRecord);
  assert.equal(childRead.ordinal, 1);
  assert.equal(childRead.index, 1, 'normalize 补齐旧字段 index');
  assert.equal(childRead.parentSessionId, source.id, 'normalize 补齐旧字段 parentSessionId');
  assert.equal(childRead.scheme, 'handoff-n');
  assert.equal(childRead.titleSeq, null);
  assert.equal(childRead.historyTitle, null, '缺失字段读成 null');
  assert.equal(Object.hasOwn(childRead, 'path'), false);
  // 终态对照：最新记录 ≠ 自己的记录 —— 所以「自己的链号」必须按 childId 认，不能只看最后一条。
  assert.equal(relayRecordOf(firstHop.child).ordinal, 2, 'child1 交接出下一代后，最新记录是第 2 跳的父记录');
  assert.equal(ownRecordsOf(firstHop.child)[0].data.ordinal, 1, '自己的 record 仍是 1');

  // 父记录：保持 0.3/0.4 现场形状，F2 新字段一个都不写（现网数据安全）。
  const parentEvents = relayEventsOf(source);
  assert.equal(parentEvents.length, 1, '第 1 跳的父会话只有 1 条 relay 记录');
  const parentRecord = parentEvents[0].data;
  assert.equal(parentRecord.parentId, source.id);
  assert.equal(parentRecord.parentSessionId, source.id, '旧字段照旧写');
  assert.equal(parentRecord.childId, firstHop.child.id);
  assert.equal(parentRecord.ordinal, 1);
  assert.equal(parentRecord.index, 1, '旧字段 index 照旧写');
  assert.equal(parentRecord.baseTitle, CLEAN_TITLE);
  assert.equal(parentRecord.title, '交接第 1 次：原会话标题');
  assert.equal(parentRecord.path, firstHop.result.path, '父记录保留交接单路径');
  assert.equal('scheme' in parentRecord, false, '父记录不写 scheme（F2 只放行读取）');
  assert.equal('titleSeq' in parentRecord, false, '父记录不写 titleSeq');
  assert.equal('historyTitle' in parentRecord, false, '父记录不写 historyTitle');

  // 双写一致：同一次交接在父、子两侧写的链号/原题/子 id 必须相同。
  assert.equal(parentRecord.ordinal, childRecord.ordinal, '父/子记录 ordinal 相同');
  assert.equal(parentRecord.childId, childRecord.childId, '父/子记录 childId 相同');
  assert.equal(parentRecord.baseTitle, childRecord.baseTitle, '父/子记录 baseTitle 相同');
}

console.log('PASS  0.5.0 F5 record：子会话字段齐全；父记录不写 scheme/titleSeq/historyTitle（现网写出不变）');

/* ================================================================== *
 * 3) scheme 不混用：handoff-n / history-n / legacy + history 标题往返
 * ================================================================== */

assert.equal(HISTORY_PREFIX, '历史');

// 前缀决定 scheme，互不串味。
assert.equal(splitHandoffTitle('交接第 1 次：X').scheme, 'handoff-n');
assert.equal(splitHandoffTitle('交接第 2 次：X').scheme, 'handoff-n');
assert.equal(splitHandoffTitle('交接第3次:X').scheme, 'handoff-n', '半角冒号/无空格仍是 handoff-n');
assert.equal(splitHandoffTitle('历史 1：X').scheme, 'history-n');
assert.equal(splitHandoffTitle('历史 3：X').scheme, 'history-n');
assert.equal(splitHandoffTitle('历史 12：X').scheme, 'history-n', '两位序号仍是 history-n');
assert.equal(splitHandoffTitle('历史12：X').scheme, 'history-n', '序号前空格可省');
assert.equal(splitHandoffTitle('历史 3: X').scheme, 'history-n', '半角冒号兼容');
assert.equal(splitHandoffTitle('历史：X').scheme, 'legacy', '没有序号的「历史：」不算 history-n');
assert.equal(splitHandoffTitle('交接：X').scheme, 'legacy');
assert.equal(splitHandoffTitle('接棒：X').scheme, 'legacy');
assert.equal(splitHandoffTitle('普通会话标题').scheme, 'legacy');
for (const dirty of [undefined, null, '', '   ', 42, {}, [], true]) {
  assert.deepEqual(
    splitHandoffTitle(dirty),
    { baseTitle: '会话', handedOff: 0, scheme: 'legacy' },
    `空/脏输入回落「会话」：${JSON.stringify(dirty)}`,
  );
}

// 前缀优先：名字里带另一种标题也不改外层 scheme。
assert.equal(splitHandoffTitle('交接：历史 2：X').scheme, 'legacy');
assert.equal(splitHandoffTitle('历史 2：交接第 1 次：X').scheme, 'history-n');
assert.equal(splitHandoffTitle('历史 2：交接第 1 次：X').baseTitle, '交接第 1 次：X');
assert.equal(splitHandoffTitle(relayTitleOf(1, historyTitleOf(2, 'X'))).scheme, 'handoff-n');
assert.equal(splitHandoffTitle(relayTitleOf(1, historyTitleOf(2, 'X'))).baseTitle, '历史 2：X');
assert.equal(splitHandoffTitle(historyTitleOf(1, relayTitleOf(2, 'X'))).scheme, 'history-n');
assert.equal(splitHandoffTitle(historyTitleOf(1, relayTitleOf(2, 'X'))).baseTitle, '交接第 2 次：X');

// historyTitleOf 生成格式：与 relayTitleOf 同一套空格/冒号规则，原名先 trim。
assert.equal(historyTitleOf(1, '会话A'), '历史 1：会话A');
assert.equal(historyTitleOf(2, '会话A'), '历史 2：会话A');
assert.equal(historyTitleOf(12, '会话A'), '历史 12：会话A', '两位序号不补零、不换算');
assert.equal(historyTitleOf(1, '  前后空格  '), '历史 1：前后空格');
assert.equal(historyTitleOf(1, '带：冒号 的 标题'), '历史 1：带：冒号 的 标题');
assert.equal(historyTitleOf(1, ''), '历史 1：会话', '空题回落「会话」');
assert.equal(historyTitleOf(1, '   '), '历史 1：会话');
assert.equal(historyTitleOf(1, undefined), '历史 1：会话');
assert.equal(historyTitleOf(1, null), '历史 1：会话');

// 往返：historyTitleOf → splitHandoffTitle 还原原名/序号/唯一 scheme。
for (const base of ['会话A', '带：冒号 的标题', '原会话标题']) {
  for (const n of [1, 2, 3, 12]) {
    assert.deepEqual(
      splitHandoffTitle(historyTitleOf(n, base)),
      { baseTitle: base, handedOff: n, scheme: 'history-n' },
      `往返：历史 ${n}：${base}`,
    );
  }
}
assert.deepEqual(
  splitHandoffTitle(historyTitleOf(2, '')),
  { baseTitle: '会话', handedOff: 2, scheme: 'history-n' },
  '往返也守空题兜底',
);

// 长标题 >80 字节：0.5.0 的纯函数层现状不截断（真做 80 字节预算时这组要随行为一起改）。
const longBase = '很长的会话标题'.repeat(12);
assert.equal(Buffer.byteLength(longBase, 'utf8') > 80, true, '夹具要超过 80 字节');
const longHistory = historyTitleOf(3, longBase);
assert.equal(Buffer.byteLength(longHistory, 'utf8') > 80, true);
assert.deepEqual(
  splitHandoffTitle(longHistory),
  { baseTitle: longBase, handedOff: 3, scheme: 'history-n' },
  '>80 字节标题不截断、可往返',
);
assert.equal(splitHandoffTitle(relayTitleOf(3, longBase)).baseTitle, longBase, '交接标题同样不截断');

console.log('PASS  0.5.0 F5 scheme：handoff-n / history-n / legacy 不混用；历史 N 往返、两位数、空题、>80B 现状不截断');

/* ================================================================== *
 * 4) 旧链兼容：交接第 N 次解析逐字节不变（固定期望，不信当前实现）
 * ================================================================== */

/**
 * 固定期望表：F1 之前 splitHandoffTitle 只返回 baseTitle/handedOff；这里按
 * 「逐字节」锁死这两个字段的 JSON（含字段顺序），trim/兜底/序号解析任何漂移都会红。
 */
const LEGACY_EXPECTATIONS = [
  ['交接第 1 次：X', '{"baseTitle":"X","handedOff":1}'],
  ['交接第 2 次：原会话标题', '{"baseTitle":"原会话标题","handedOff":2}'],
  ['交接第2次:X', '{"baseTitle":"X","handedOff":2}'],
  ['交接第 12 次：X', '{"baseTitle":"X","handedOff":12}'],
  ['交接第 3 次：', '{"baseTitle":"会话","handedOff":3}'],
  ['交接第 1 次：  前后空格  ', '{"baseTitle":"前后空格","handedOff":1}'],
  ['交接：X', '{"baseTitle":"X","handedOff":1}'],
  ['接棒：X', '{"baseTitle":"X","handedOff":1}'],
  ['交接：接棒：X', '{"baseTitle":"X","handedOff":2}'],
  ['交接：', '{"baseTitle":"会话","handedOff":1}'],
  ['普通会话标题', '{"baseTitle":"普通会话标题","handedOff":0}'],
  ['', '{"baseTitle":"会话","handedOff":0}'],
  [undefined, '{"baseTitle":"会话","handedOff":0}'],
];
for (const [title, expected] of LEGACY_EXPECTATIONS) {
  const parsed = splitHandoffTitle(title);
  assert.equal(
    JSON.stringify({ baseTitle: parsed.baseTitle, handedOff: parsed.handedOff }),
    expected,
    `旧链解析逐字节不变：${String(title)}`,
  );
}
assert.equal(relayTitleOf(2, 'X'), '交接第 2 次：X', '旧标题生成格式不变');

// 没有 record 的旧会话：靠标题解析继续，序号 = 解析出的次数 + 1。
{
  const legacyTitle = new MockSession({ id: 'session-legacy-title' });
  const plan = handoffTitlePlanOf(ctxWithTitle('交接第 2 次：旧会话'), legacyTitle);
  assert.equal(plan.viaRecord, false, '无 record 才回退标题解析');
  assert.equal(plan.index, 3);
  assert.equal(plan.baseTitle, '旧会话');
  assert.equal(plan.title, '交接第 3 次：旧会话');
}

// 0.3 旧 record（只有 index/parentSessionId）：序号继续，原题从标题兜底读。
{
  const legacyRecord = new MockSession({
    id: 'session-legacy-record',
    events: [
      {
        type: RELAY_RECORD_TYPE,
        ignorable: true,
        data: { parentSessionId: 'gp', childId: 'session-legacy-record', index: 1, at: 1 },
      },
    ],
  });
  const plan = handoffTitlePlanOf(ctxWithTitle('交接第 1 次：旧会话'), legacyRecord);
  assert.equal(plan.viaRecord, true);
  assert.equal(plan.index, 2, 'index=1 的旧记录 → 下一次是第 2 次');
  assert.equal(plan.baseTitle, '旧会话', '旧记录没有 baseTitle 时从标题兜底');
}

console.log('PASS  0.5.0 F5 旧链：交接第 N 次解析逐字节不变；无 record/0.3 旧 record 仍能续号');

/* ================================================================== *
 * 5) relayChainOf 投影：只取记录字段，缺的 null、没 path 不带键
 * ================================================================== */

// 5.1 字段齐全的新记录（F3 字段 + path）→ 六字段投影，不多不少。
{
  const full = normalizeRelayRecord({
    parentId: 'parent-1',
    childId: 'child-1',
    ordinal: 2,
    baseTitle: '原会话标题',
    title: '交接第 2 次：原会话标题',
    scheme: 'handoff-n',
    titleSeq: 7,
    path: '/tmp/dcr-handoffs/handoff-chain.md',
    at: 111,
    atIso: '2026-10-26T12:00:00+08:00',
  });
  const chain = relayChainOf(full);
  assert.deepEqual(
    chain,
    {
      ordinal: 2,
      baseTitle: '原会话标题',
      parentId: 'parent-1',
      childId: 'child-1',
      scheme: 'handoff-n',
      path: '/tmp/dcr-handoffs/handoff-chain.md',
    },
    '新记录投影 = 六字段（path 有才带）',
  );
  assert.deepEqual(
    Object.keys(chain),
    ['ordinal', 'baseTitle', 'parentId', 'childId', 'scheme', 'path'],
    '投影不下发 title/titleSeq/at 等记录私有字段',
  );
}

// 5.2 真实 F3 子记录（没有 path）→ 不带 path 键；scheme 原样。
{
  const chain = relayChainOf(normalizeRelayRecord(ownRecordsOf(firstHop.child)[0].data));
  assert.deepEqual(
    chain,
    {
      ordinal: 1,
      baseTitle: CLEAN_TITLE,
      parentId: source.id,
      childId: firstHop.child.id,
      scheme: 'handoff-n',
    },
    'F3 子记录没有 path 就不出现这个键',
  );
  assert.equal(Object.hasOwn(chain, 'path'), false);
}

// 5.3 父记录（有 path、按 F2 不写 scheme）→ path 带上，scheme 不猜、给 null。
{
  const chain = relayChainOf(relayRecordOf(source));
  assert.deepEqual(
    chain,
    {
      ordinal: 1,
      baseTitle: CLEAN_TITLE,
      parentId: source.id,
      childId: firstHop.child.id,
      scheme: null,
      path: firstHop.result.path,
    },
    '父记录没写的 scheme 投影为 null（不从标题反推 handoff-n）',
  );
  assert.deepEqual(
    Object.keys(chain),
    ['ordinal', 'baseTitle', 'parentId', 'childId', 'scheme', 'path'],
  );
}

// 5.4 0.3 旧记录缺字段 → 一律 null，不补默认 baseTitle/scheme。
{
  const chain = relayChainOf(normalizeRelayRecord({ parentSessionId: 'parent-0', childId: 'child-0', index: 1, at: 9 }));
  assert.deepEqual(
    chain,
    { ordinal: 1, baseTitle: null, parentId: 'parent-0', childId: 'child-0', scheme: null },
    '旧记录缺的字段给 null，不猜',
  );
  assert.equal(Object.hasOwn(chain, 'path'), false);
}

// 5.5 没有记录 → null（不是空对象）。
assert.equal(relayChainOf(null), null);
assert.equal(relayChainOf(undefined), null);
assert.equal(relayChainOf('not-a-record'), null);

console.log('PASS  0.5.0 F5 投影：relayChainOf 新记录六字段、旧记录缺字段 null、无 path 不带键、无记录 null');

/* ================================================================== *
 * 6) readState：chain 与 relay 同源（F4 additive，旧字段一个不改）
 * ================================================================== */

const stateCfg = resolveConfig({ retention: { recentTailTokens: 0 } });

function stateDeps() {
  return {
    ctx: {
      tokenMeter: {
        measure(session) {
          const nodes = session.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 }));
          return { totalTokens: nodes.length * 100, surfaceTokens: nodes.length * 100, nodes };
        },
      },
      llm: {
        async resolveModelInfo() {
          return { context: { contextWindow: 200_000 }, defaultMaxTokens: 8192 };
        },
      },
      agents: { get: () => undefined, list: () => [] },
      sessions: { get: () => undefined, flush() {} },
    },
    cfg: stateCfg,
    lock: createLock(),
    engine,
    // 固定原生压缩配置，避免测试机 profile 影响 native 段（与本文件断言无关）。
    nativeConfig: { autoEnabled: true, thresholdRatio: 0.8, headroomTokens: 65536, modelPolicies: [] },
  };
}

function agentOf(session) {
  return { id: session.id, session, options: { provider: 'mock', model: 'mock-model' } };
}

{
  // 最后一跳的子会话：日志里只有自己的 F3 record（ordinal=3、无 path）。
  const childState = await readState(stateDeps(), { agent: agentOf(thirdHop.child) });
  assert.deepEqual(childState.chain, relayChainOf(childState.relay), 'chain 必须是 relay 的只读投影');
  assert.deepEqual(childState.chain, {
    ordinal: 3,
    baseTitle: CLEAN_TITLE,
    parentId: thirdHop.parent.id,
    childId: thirdHop.child.id,
    scheme: 'handoff-n',
  });
  assert.equal(Object.hasOwn(childState.chain, 'path'), false, '子会话链没有 path 键');
  // 旧字段原样：子记录没写 0.3 旧名，读侧仍补齐（老客户端还能读）。
  assert.equal(childState.relay.ordinal, 3);
  assert.equal(childState.relay.index, 3);
  assert.equal(childState.relay.parentSessionId, thirdHop.parent.id);
  assert.equal(childState.relay.childId, thirdHop.child.id);

  // 源会话：日志里是父记录（ordinal=1、有 path、无 scheme），投影照记录给。
  const sourceState = await readState(stateDeps(), { agent: agentOf(source) });
  assert.deepEqual(sourceState.chain, relayChainOf(sourceState.relay));
  assert.equal(sourceState.chain.ordinal, 1);
  assert.equal(sourceState.chain.scheme, null, '父记录没写 scheme → 链投影 null，不从标题猜');
  assert.equal(sourceState.chain.path, firstHop.result.path);
  assert.equal(sourceState.relay.parentId, source.id);
}

console.log('PASS  0.5.0 F5 readState：chain 与 relay 同源下发（子记录带链号、父记录带 path、旧字段不变）');
