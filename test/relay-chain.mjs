/**
 * 0.5.0 F5 链不变量测试 —— 锁住「命名反转」依赖的三层数据契约。
 *
 * 为什么单独一个文件：0.5.0 会把旧会话改名「历史 N：<原名>」、新会话继承原名；
 * 那时**标题里不再有链号**，「第几次交接」只能从 relay record 读。F1（scheme 纯函数）、
 * F3（子会话 record）、F4（readState.chain 投影）各自有单测，本文件只锁它们串成
 * 一条接力链之后的不变量：
 *
 *   1) 三跳接力：第 1/2/3 次序号 1→2→3，标题干净（原题无前缀）也不重号；
 *   2) record 形状：父/子都写 scheme+titleSeq+path（同一个交接单路径），新链父记录另带 historyTitle；
 *   3) scheme 不混用：交接第 N 次 / 历史 N / legacy 各归各的，history 标题可往返；
 *   4) 旧链兼容：交接第 N 次解析逐字节不变（固定期望，不随实现漂）；
 *   5) 投影：relayChainOf 只取记录字段，缺的给 null、没 path 就不出现这个键；
 *      6) readState：chain 与 relay 同源下发（老字段一个不改）。
 *
 * 0.5.0 命名反转已实现：这里锁「新链继承原名 + 旧会话历史 N + 旧链一字符不改」的
 * 链不变量。这里红 = 链契约被改，需要连同迁移方案一起评审，而不是顺手把期望改掉。
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
import { normalizeRelayRecord, relayChainOf, relayInboundRecordOf, relayOutboundRecordOf, relayRecordOf } from '../lib/dsh/relay.js';
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
  // 0.5.0 命名反转：干净标题 = 新链 → 新会话继承原名，旧会话背「历史 N」。
  assert.equal(plan.scheme, 'history-n', `第 ${ordinal} 跳走新链`);
  assert.equal(plan.title, CLEAN_TITLE, '新会话标题=原名（不带序号）');
  assert.equal(plan.historyTitle, `历史 ${ordinal}：${CLEAN_TITLE}`, '旧会话标题序号连续');
  // 第 1 跳没有父记录可用（旧会话），第 2 跳起必须走 record，不能回退标题解析。
  assert.equal(plan.viaRecord, ordinal > 1, `第 ${ordinal} 跳 viaRecord`);

  const own = ownRecordsOf(child);
  assert.equal(own.length, 1, `第 ${ordinal} 跳子会话恰有 1 条自己的 record`);
  assert.equal(own[0].data.ordinal, ordinal, `子会话 record ordinal=${ordinal}`);
  assert.equal(own[0].data.baseTitle, CLEAN_TITLE);
  assert.equal(own[0].data.parentId, hopParent.id, 'record.parentId 指向真正的父会话');
  assert.equal(own[0].data.childId, child.id);
  assert.equal(own[0].data.scheme, 'history-n', '子记录与本次链的 scheme 一致');
  assert.equal(own[0].data.title, CLEAN_TITLE, '子记录 title 是干净原名');
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
// 每跳两次 rename：先建子会话改原名，成功后再把旧会话改「历史 N」。
assert.deepEqual(
  record.renames,
  [
    { sessionId: firstHop.child.id, title: CLEAN_TITLE },
    { sessionId: source.id, title: `历史 1：${CLEAN_TITLE}` },
    { sessionId: secondHop.child.id, title: CLEAN_TITLE },
    { sessionId: firstHop.child.id, title: `历史 2：${CLEAN_TITLE}` },
    { sessionId: thirdHop.child.id, title: CLEAN_TITLE },
    { sessionId: secondHop.child.id, title: `历史 3：${CLEAN_TITLE}` },
  ],
  '三跳：新会话继承原名，旧会话历史 1→2→3，不重号',
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
  // scheme 也以 record 为准：旧记录（handoff-n）不因标题被改成「历史 9」而漂到新链。
  assert.equal(plan.scheme, 'handoff-n', '旧链 record 固定旧命名（cutover，不迁移）');
  assert.equal(plan.title, '交接第 3 次：原会话标题');
  assert.equal(plan.historyTitle, null, '旧链不生成历史标题');

  // 新链 record（history-n）同样不信面板标题：序号/原名/方案都来自 record。
  const historyDrift = new MockSession({
    id: 'session-history-drift',
    events: [
      {
        type: RELAY_RECORD_TYPE,
        ignorable: true,
        data: { parentId: 'gp', childId: 'session-history-drift', ordinal: 2, baseTitle: CLEAN_TITLE, scheme: 'history-n', at: 1 },
      },
    ],
  });
  const historyPlan = handoffTitlePlanOf(ctxWithTitle('历史 9：被手改过的面板标题'), historyDrift);
  assert.equal(historyPlan.viaRecord, true);
  assert.equal(historyPlan.index, 3);
  assert.equal(historyPlan.scheme, 'history-n', '新链 record 继续新链');
  assert.equal(historyPlan.baseTitle, CLEAN_TITLE);
  assert.equal(historyPlan.title, CLEAN_TITLE);
  assert.equal(historyPlan.historyTitle, '历史 3：原会话标题');
}

console.log('PASS  0.5.0 F5 链序号：三跳接力 1→2→3；新链继承原名/旧会话历史 N，标题被手改也不重号');

/* ================================================================== *
 * 2) record 形状：父/子会话都写 scheme/titleSeq；新链父记录再写 historyTitle
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
  assert.equal(childRecord.scheme, 'history-n', '干净标题的首次交接走新链 history-n');
  assert.equal(childRecord.title, CLEAN_TITLE, '新会话标题=原名');
  assert.equal(Number.isInteger(childRecord.at), true);
  assert.equal(typeof childRecord.atIso, 'string');
  assert.equal(childRecord.titleSeq, null, 'rename 不返回 eventSeq 时写 null（不猜）');
  assert.equal('historyTitle' in childRecord, false, '子会话标题是原名，不写 historyTitle');
  assert.equal(childRecord.path, firstHop.result.path, '子记录自带交接单路径（接力条不用回查父会话）');

  // 读回：白名单补齐 0.3 旧名（只读别名，不改写盘形状）。
  // 注意用「自己的那条」原始 data 归一化，不用 relayRecordOf(child) —— 终态里
  // child1 已经交接出下一代，日志最新一条会是第 2 跳的**父记录**（ordinal=2）。
  const childRead = normalizeRelayRecord(childRecord);
  assert.equal(childRead.ordinal, 1);
  assert.equal(childRead.index, 1, 'normalize 补齐旧字段 index');
  assert.equal(childRead.parentSessionId, source.id, 'normalize 补齐旧字段 parentSessionId');
  assert.equal(childRead.scheme, 'history-n');
  assert.equal(childRead.titleSeq, null);
  assert.equal(childRead.historyTitle, null, '子记录缺失字段读成 null');
  assert.equal(childRead.path, firstHop.result.path, 'normalize 放行并读回子记录的 path');
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
  assert.equal(parentRecord.title, CLEAN_TITLE, '父记录的 title 仍是新会话标题（新链=原名）');
  assert.equal(parentRecord.path, firstHop.result.path, '父记录保留交接单路径');
  // 0.5.0 有意行为变化：父记录也写 scheme + titleSeq（F5 旧期望「父记录不写」已更新）。
  assert.equal(parentRecord.scheme, 'history-n', '父记录与子记录同 scheme');
  assert.equal(parentRecord.titleSeq, null, '父记录 titleSeq 取旧会话 rename 的 eventSeq（替身不返回→null）');
  assert.equal(parentRecord.historyTitle, `历史 1：${CLEAN_TITLE}`, '父记录额外记下旧会话改名后的标题');

  // 双写一致：同一次交接在父、子两侧写的链号/原题/子 id/交接单路径必须相同。
  assert.equal(parentRecord.ordinal, childRecord.ordinal, '父/子记录 ordinal 相同');
  assert.equal(parentRecord.childId, childRecord.childId, '父/子记录 childId 相同');
  assert.equal(parentRecord.baseTitle, childRecord.baseTitle, '父/子记录 baseTitle 相同');
  assert.equal(parentRecord.path, childRecord.path, '父/子记录 path 相同（同一份交接单）');
}

console.log('PASS  0.5.0 F5 record：父/子记录同 scheme+titleSeq+path；新链父记录带 historyTitle');

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
  assert.equal(plan.scheme, 'handoff-n', '旧标题链继续旧命名（cutover）');
  assert.equal(plan.title, '交接第 3 次：旧会话', '旧链标题一字符不改');
  assert.equal(plan.historyTitle, null, '旧链不生成历史标题');
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
  assert.equal(plan.scheme, 'handoff-n', '0.3 旧记录 scheme=null → 旧链（不迁移）');
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

// 5.2 真实 F3 子记录（0.5.0 起自带 path）→ 投影带上 path；scheme 原样。
{
  const chain = relayChainOf(normalizeRelayRecord(ownRecordsOf(firstHop.child)[0].data));
  assert.deepEqual(
    chain,
    {
      ordinal: 1,
      baseTitle: CLEAN_TITLE,
      parentId: source.id,
      childId: firstHop.child.id,
      scheme: 'history-n',
      path: firstHop.result.path,
    },
    '子记录自带 path，投影直接带上（接力条不再需要回查父会话）',
  );
  assert.deepEqual(
    Object.keys(chain),
    ['ordinal', 'baseTitle', 'parentId', 'childId', 'scheme', 'path'],
  );
}

// 5.3 父记录（0.5.0 也写 scheme + historyTitle）→ path 带上；投影不暴露 historyTitle。
{
  const chain = relayChainOf(relayRecordOf(source));
  assert.deepEqual(
    chain,
    {
      ordinal: 1,
      baseTitle: CLEAN_TITLE,
      parentId: source.id,
      childId: firstHop.child.id,
      scheme: 'history-n',
      path: firstHop.result.path,
    },
    '父记录写什么 scheme 就投影什么（historyTitle 不属于链投影字段）',
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
 * 6) readState：chain=本会话入站记录、next=出站投影（0.5.1 DCR-01）
 *
 * 契约变化：0.5.0 的 chain 是「最近一条记录」，祖先会话再次交接后最近一条变成
 * 出站（childId=下一代）→ 客户端入站判定不成立 → 接力条消失。0.5.1 起：
 *   - `relay` 旧字段不动（仍是最近一条记录，出站/入站都可能）；
 *   - `chain` 只取 childId===本会话 的入站记录（接力条据此显示「已接力自」）；
 *   - `next` 是最近一条出站记录的投影（父→子入口 / 父记录补 path 用，只加不改）。
 * ================================================================== */

const stateCfg = resolveConfig({ retention: { recentTailTokens: 0 } });

/**
 * readState 替身依赖。
 * 0.5.1 起额外用到两件宿主能力：sessionTitle（DCR-02 老链兜底靠标题解析）与
 * workspaceRegistry（parentArchived / capabilities.unarchive）。
 * @param {{titles?:Map<string,string>, archivedSessionIds?:string[], unarchive?:boolean}} [input]
 */
function stateDeps({ titles = new Map(), archivedSessionIds, unarchive = false } = {}) {
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
      get(name) {
        if (name === 'sessionTitle') {
          return {
            get: (session) => (session !== undefined && titles.has(session.id) ? { title: titles.get(session.id) } : undefined),
          };
        }
        if (name === 'workspaceRegistry' && (Array.isArray(archivedSessionIds) || unarchive === true)) {
          return {
            ...(Array.isArray(archivedSessionIds) ? { archivedSessionIds } : {}),
            ...(unarchive === true ? { async unarchiveSession() {} } : {}),
          };
        }
        return undefined;
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

// 6.1 读取器本身：入站 / 出站分开找，旧 relayRecordOf 语义不变。
{
  const mid = firstHop.child; // 日志：入站（第 1 跳）+ 出站（第 2 跳）
  assert.equal(relayRecordOf(mid).ordinal, 2, 'relayRecordOf 仍是最近一条（出站），旧语义不动');
  assert.equal(relayInboundRecordOf(mid).ordinal, 1, '入站记录 = childId 指向本会话的那条');
  assert.equal(relayInboundRecordOf(mid).childId, mid.id);
  assert.equal(relayInboundRecordOf(mid).path, firstHop.result.path, '入站记录带自己那一跳的交接单');
  assert.equal(relayOutboundRecordOf(mid).ordinal, 2, '出站记录 = 本会话交接给下一代的那条');
  assert.equal(relayOutboundRecordOf(mid).childId, secondHop.child.id);
  assert.equal(relayInboundRecordOf(source), null, '根会话没有入站记录');
  assert.equal(relayOutboundRecordOf(source).childId, firstHop.child.id);
  assert.equal(relayInboundRecordOf(thirdHop.child).ordinal, 3, '链尾只有入站记录');
  assert.equal(relayOutboundRecordOf(thirdHop.child), null, '链尾没有出站记录');
  assert.equal(relayInboundRecordOf(new MockSession({ id: 'session-no-log' })), null, '没有记录 → null');
}

// 6.2 链尾子会话：只有入站记录 → chain 仍是那份投影，next=null，parentArchived 看父会话。
{
  const tailState = await readState(stateDeps({ archivedSessionIds: [thirdHop.parent.id] }), {
    agent: agentOf(thirdHop.child),
  });
  assert.deepEqual(tailState.chain, relayChainOf(tailState.relay), '只有入站记录时 chain 与 relay 同源');
  assert.deepEqual(tailState.chain, {
    ordinal: 3,
    baseTitle: CLEAN_TITLE,
    parentId: thirdHop.parent.id,
    childId: thirdHop.child.id,
    scheme: 'history-n',
    path: thirdHop.result.path,
  });
  assert.equal(tailState.next, null, '链尾没有出站记录 → next=null');
  assert.equal(tailState.parentArchived, true, '链尾会话的父会话（第 2 跳子会话）在归档集合里');
  // 旧字段原样：子记录没写 0.3 旧名，读侧仍补齐（老客户端还能读）。
  assert.equal(tailState.relay.ordinal, 3);
  assert.equal(tailState.relay.index, 3);
  assert.equal(tailState.relay.parentSessionId, thirdHop.parent.id);
  assert.equal(tailState.relay.childId, thirdHop.child.id);
  assert.equal(tailState.relay.path, thirdHop.result.path);
}

// 6.3 中段会话（DCR-01 bug 原形）：chain=第 1 跳入站，next=第 2 跳出站。
{
  const midState = await readState(stateDeps({ archivedSessionIds: [source.id] }), { agent: agentOf(firstHop.child) });
  assert.deepEqual(midState.chain, {
    ordinal: 1,
    baseTitle: CLEAN_TITLE,
    parentId: source.id,
    childId: firstHop.child.id,
    scheme: 'history-n',
    path: firstHop.result.path,
  }, '祖先会话再次交接后，chain 仍是自己的入站记录（接力条不消失）');
  assert.deepEqual(midState.next, {
    ordinal: 2,
    baseTitle: CLEAN_TITLE,
    parentId: firstHop.child.id,
    childId: secondHop.child.id,
    scheme: 'history-n',
    path: secondHop.result.path,
  }, 'next 是最近一条出站记录（父→子入口的数据源）');
  assert.equal(midState.relay.ordinal, 2, 'relay 仍是最近一条（出站），旧字段一个不改');
  assert.equal(midState.parentArchived, true, 'parentArchived 用入站 parentId（source）');
  const otherArchive = await readState(stateDeps({ archivedSessionIds: [secondHop.child.id] }), {
    agent: agentOf(firstHop.child),
  });
  assert.equal(otherArchive.parentArchived, false, 'parentArchived 不被出站 childId（下一代）带偏');
}

// 6.4 根会话：只有出站记录 → chain=null（不显示接力条），relay/next 照常可读。
{
  const sourceState = await readState(stateDeps(), { agent: agentOf(source) });
  assert.equal(sourceState.chain, null, '根会话没有入站记录 → chain=null');
  assert.equal(sourceState.parentArchived, null, '没有 chain 就没有 parentArchived');
  assert.equal(sourceState.relay.ordinal, 1, 'relay 旧字段仍可读（最近一条记录）');
  assert.equal(sourceState.relay.path, firstHop.result.path);
  assert.deepEqual(sourceState.next, {
    ordinal: 1,
    baseTitle: CLEAN_TITLE,
    parentId: source.id,
    childId: firstHop.child.id,
    scheme: 'history-n',
    path: firstHop.result.path,
  }, 'next 接管原来「链字段」里的出站信息');
  assert.deepEqual(sourceState.capabilities, { unarchive: false }, '宿主没有 unarchiveSession → false');
}

// 6.5 DCR-03：capabilities.unarchive 反映服务端 recover 接缝是否可用。
{
  const capable = await readState(stateDeps({ unarchive: true }), { agent: agentOf(source) });
  assert.deepEqual(capable.capabilities, { unarchive: true }, '宿主有 workspaceRegistry.unarchiveSession → true');
  const noRegistry = await readState(stateDeps(), { agent: agentOf(thirdHop.child) });
  assert.deepEqual(noRegistry.capabilities, { unarchive: false }, '没有 registry → false（客户端隐藏恢复入口）');
}

console.log('PASS  0.5.1 DCR-01 readState：chain=本会话入站记录、next=出站投影、relay 旧字段不变、capabilities.unarchive');

/* ================================================================== *
 * 7) DCR-02：0.5.0 前的老链没有 record → 用会话头兜底合成只读 chain
 *
 * 条件（全部满足才合成）：header.parentSession 存在、origin!=='subagent'、
 * isSeeded!==true（fork 继承前缀不算交接链）、标题能解析出「交接第 N 次」。
 * 合成链只读：relay 仍是 null（不伪造旧字段）、不写日志、不带 path（客户端
 * 用父会话的出站记录补 path）。
 * ================================================================== */

const LEGACY_CHILD_ID = 'session-legacy-child';
const LEGACY_PARENT_ID = 'session-legacy-parent';

/** 老链子会话：0.5.0 之前交接生成 —— 没有 relay record，只有会话头血缘 + 旧标题。 */
function legacyChild({ header = { parentSession: LEGACY_PARENT_ID }, id = LEGACY_CHILD_ID } = {}) {
  return new MockSession({
    id,
    cwd: undefined,
    agentPreset: undefined,
    header,
    events: [{ type: 'user/message', data: { role: 'user', content: '旧的交接单正文' } }],
  });
}

/* 7.1 正常老链：header.parentSession + 「交接第 N 次：」标题 → 合成 chain。 */
{
  const session = legacyChild();
  const state = await readState(
    stateDeps({ titles: new Map([[LEGACY_CHILD_ID, '交接第 2 次：老链标题']]), archivedSessionIds: [LEGACY_PARENT_ID] }),
    { agent: agentOf(session) },
  );
  assert.deepEqual(
    state.chain,
    {
      ordinal: 2,
      baseTitle: '老链标题',
      parentId: LEGACY_PARENT_ID,
      childId: LEGACY_CHILD_ID,
      scheme: 'handoff-n',
      synthesized: true,
    },
    '老链兜底：序号/原题/父会话都从会话头 + 标题合成',
  );
  assert.equal('path' in state.chain, false, '合成链没有交接单路径（客户端向父会话读回）');
  assert.equal(state.relay, null, '没有 record：relay 仍是 null（不伪造旧字段）');
  assert.equal(state.next, null, '没有出站记录 → next=null');
  assert.equal(state.parentArchived, true, 'parentArchived 用 header.parentSession 查归档集合');
  assert.equal(state.parentArchived !== null, true, '兜底链也能判断归档状态（恢复入口不会死）');
}

/* 7.2 「历史 N：」标题的老链（record 丢了但标题是 0.5.0 新链形态）→ scheme=history-n。 */
{
  const session = legacyChild({ id: 'session-history-legacy' });
  const state = await readState(
    stateDeps({ titles: new Map([['session-history-legacy', '历史 3：新链标题']]) }),
    { agent: agentOf(session) },
  );
  assert.deepEqual(state.chain, {
    ordinal: 3,
    baseTitle: '新链标题',
    parentId: LEGACY_PARENT_ID,
    childId: 'session-history-legacy',
    scheme: 'history-n',
    synthesized: true,
  }, '「历史 N：」标题合成 history-n 链（接力条显示「历史 3：新链标题」）');
}

/* 7.3 不该合成的四种情况：subagent / fork(isSeeded) / 没有父会话 / 干净标题。 */
{
  const negatives = [
    {
      name: 'subagent 会话（origin=subagent）',
      session: legacyChild({ header: { parentSession: LEGACY_PARENT_ID, origin: 'subagent' } }),
      title: '交接第 1 次：X',
    },
    {
      name: 'fork 会话（isSeeded=true，继承前缀不是交接链）',
      session: legacyChild({ header: { parentSession: LEGACY_PARENT_ID, isSeeded: true } }),
      title: '交接第 1 次：X',
    },
    {
      name: '没有 header.parentSession',
      session: legacyChild({ header: { cwd: '/tmp/x' } }),
      title: '交接第 1 次：X',
    },
    {
      name: '干净标题（handedOff=0，不是交接出来的会话）',
      session: legacyChild(),
      title: '普通会话标题',
    },
  ];
  for (const item of negatives) {
    const state = await readState(stateDeps({ titles: new Map([[item.session.id, item.title]]) }), {
      agent: agentOf(item.session),
    });
    assert.equal(state.chain, null, `${item.name} 不应合成接力链`);
    assert.equal(state.relay, null, `${item.name}：relay 保持 null`);
  }
  // 标题服务读不到（老宿主/未加载）→ 不猜，宁可不显示。
  const noTitle = await readState(stateDeps(), { agent: agentOf(legacyChild()) });
  assert.equal(noTitle.chain, null, '读不到标题时不合成（不猜链号）');
}

/* 7.4 有入站 record 时优先用 record（不合成、path 直接可用）。 */
{
  const session = new MockSession({
    id: 'session-with-record-and-header',
    cwd: undefined,
    agentPreset: undefined,
    header: { parentSession: 'header-parent' },
    events: [
      { type: 'user/message', data: { role: 'user', content: '交接单' } },
      {
        type: RELAY_RECORD_TYPE,
        ignorable: true,
        data: { parentId: 'record-parent', childId: 'session-with-record-and-header', ordinal: 4, baseTitle: '记录原题', scheme: 'history-n', path: '/tmp/handoff-record.md', at: 1 },
      },
    ],
  });
  const state = await readState(stateDeps({ titles: new Map([[session.id, '交接第 9 次：标题里的原题']]) }), {
    agent: agentOf(session),
  });
  assert.deepEqual(state.chain, {
    ordinal: 4,
    baseTitle: '记录原题',
    parentId: 'record-parent',
    childId: session.id,
    scheme: 'history-n',
    path: '/tmp/handoff-record.md',
  }, '有 record 时以 record 为准（不合成、父会话取 record.parentId）');
  assert.equal('synthesized' in state.chain, false, 'record 投影不带 synthesized 标记');
}

console.log('PASS  0.5.1 DCR-02 readState：老链 header 兜底合成 chain（排除 subagent/fork/干净标题，record 优先）');
