/**
 * 0.5.0 命名反转测试 —— 第一个用户可见功能。
 *
 * 验收（用户视角）：
 *   - 新链交接后：旧会话「历史 N：<原名>」，新会话继承**干净原名**，列表读起来是一条对话；
 *   - 第 1/2/3 次序号连续，不重号；
 *   - 旧链（已存在的「交接第 N 次：」链 / 0.3 旧 record）继续旧命名，旧会话**一个字符不改**
 *     （链级 cutover，不迁移、不混用）。
 *
 * 数据面（与 relay-chain.mjs 的链不变量互补）：
 *   - 父/子 relay 记录都写 scheme + titleSeq；新链父记录另带 historyTitle；
 *   - 80 字节标题预算：前缀先计入，超长先缩 base，且不切坏多字节字符；
 *   - 旧会话 rename 失败只 warn 不阻断交接；同一目标重复执行不重复 append rename。
 *
 *   node test/handoff-naming.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handoff } from '../lib/actions/handoff.js';
import {
  HISTORY_PREFIX,
  MAX_TITLE_BYTES,
  RELAY_RECORD_TYPE,
  historyTitleOf,
  splitHandoffTitle,
  truncateTitleUtf8,
} from '../lib/core/relay.js';
import { HANDOFF_SECTIONS } from '../lib/core/handoff-doc.js';
import { REQUIRED_SECTIONS } from '../lib/core/validate-summary.js';
import { renameHistoryOf } from '../lib/dsh/sessions.js';
import { relayRecordOf } from '../lib/dsh/relay.js';
import { createAgent, createFakeEngine, createHandoffHost, createPluginDeps, createTmpDir } from './harness/host.mjs';
import { createFakeLlm } from './harness/llm.mjs';
import { baseSourceSession } from './harness/session.mjs';

/* ---------------- 确定性摘要/交接单 + host ---------------- */

function summaryReply() {
  return REQUIRED_SECTIONS.map((section) => `${section}\n- ${section}：根据本轮变更记录关键结论与证据`).join('\n');
}

function handoffReply() {
  return HANDOFF_SECTIONS.map((section) => `## ${section}\n- ${section}的内容：完成验证、记录结论并标注下一步`).join('\n');
}

function makeCtx(hostOptions = {}) {
  const llm = createFakeLlm({
    routes: [
      { kind: 'handoff', match: ({ instruction }) => instruction.includes('交接文档'), replies: [handoffReply()] },
      { kind: 'summary', match: () => true, replies: [summaryReply()] },
    ],
  });
  const engine = createFakeEngine();
  const { ctx, record } = createHandoffHost({ llm, engine, ...hostOptions });
  return { ctx, engine, record };
}

function relayEventsOf(session) {
  return session.log.filter((event) => event?.type === RELAY_RECORD_TYPE);
}

function tmpDeps(ctx, engine, prefix) {
  return createPluginDeps({ ctx, engine, handoffDir: createTmpDir(prefix) });
}

/** 有状态 sessionTitle 替身：rename 真的改 get() 的返回值，并记录 rename/flush 次数。 */
function statefulTitleHost(initialTitle, { failRename = false, eventSeqStart = 7 } = {}) {
  const state = { title: initialTitle, renames: [], flushes: 0, warnings: [], failRename };
  const ctx = {
    get(name) {
      if (name === 'sessionTitle') {
        return {
          get: () => ({ title: state.title }),
          rename(session, title) {
            if (state.failRename) throw new Error('session is not live in this store');
            state.title = title;
            state.renames.push({ sessionId: session.id, title });
            return { title, eventSeq: eventSeqStart + state.renames.length - 1 };
          },
        };
      }
      if (name === 'sessions') {
        return {
          async flush() {
            state.flushes += 1;
          },
        };
      }
      return undefined;
    },
    sessions: {
      async flush() {
        state.flushes += 1;
      },
    },
  };
  const log = {
    warn(message) {
      state.warnings.push(message);
    },
  };
  return { ctx, state, log };
}

/* ================================================================== *
 * 1) 新链第 1 次：旧会话「历史 1：X」，新会话「X」
 * ================================================================== */

const CLEAN_TITLE = '对于A的讨论';
{
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx({ sessionTitleText: CLEAN_TITLE });
  const result = await handoff(tmpDeps(ctx, engine, 'relay-naming-first-'), { agent: createAgent(session) });
  const child = record.child;

  // 旧会话 + 新会话各一次 rename，顺序固定：先建子会话/改子标题，成功后再改旧名。
  assert.deepEqual(record.renames, [
    { sessionId: child.id, title: CLEAN_TITLE },
    { sessionId: session.id, title: `历史 1：${CLEAN_TITLE}` },
  ]);
  assert.equal(result.childId, child.id);

  // 交接单里的「原会话标题」取的是改名前的标题（不能写进「历史 1」）。
  const doc = fs.readFileSync(result.path, 'utf8');
  assert.equal(doc.includes(`原会话标题：${CLEAN_TITLE}`), true, '文档头取 rename 前的原标题');

  // 父记录：scheme/titleSeq/historyTitle + 原有字段。
  const parentEvents = relayEventsOf(session);
  assert.equal(parentEvents.length, 1);
  const parent = parentEvents[0].data;
  assert.equal(parent.scheme, 'history-n');
  assert.equal(parent.titleSeq, null, '默认替身 rename 不返回 eventSeq → null（不猜）');
  assert.equal(parent.historyTitle, `历史 1：${CLEAN_TITLE}`);
  assert.equal(parent.title, CLEAN_TITLE, '父记录的 title 是新会话标题（继承的干净原名）');
  assert.equal(parent.baseTitle, CLEAN_TITLE);
  assert.equal(parent.ordinal, 1);

  // 子记录：同一 scheme，title 是干净原名，不带 historyTitle（它自己的名字不是历史名）。
  const childEvents = relayEventsOf(child);
  assert.equal(childEvents.length, 1);
  const childRecord = childEvents[0].data;
  assert.equal(childRecord.scheme, 'history-n');
  assert.equal(childRecord.ordinal, 1);
  assert.equal(childRecord.baseTitle, CLEAN_TITLE);
  assert.equal(childRecord.title, CLEAN_TITLE);
  assert.equal(childRecord.titleSeq, null);
  assert.equal('historyTitle' in childRecord, false);
}

console.log('PASS  0.5.0 命名反转：第 1 次交接 → 旧会话「历史 1：X」、新会话继承 X（父/子记录同 scheme）');

/* ================================================================== *
 * 2) 新链第 2 次：旧会话「历史 2：X」，新会话仍叫 X，序号不重
 * ================================================================== */

{
  const source = baseSourceSession();
  const { ctx, engine, record } = makeCtx({ sessionTitleText: CLEAN_TITLE });
  await handoff(tmpDeps(ctx, engine, 'relay-naming-chain-1-'), { agent: createAgent(source) });
  const firstChild = record.child;

  // 第 2 跳从子会话继续（它自己的 relay 记录带 ordinal=1 / scheme=history-n）。
  const second = await handoff(tmpDeps(ctx, engine, 'relay-naming-chain-2-'), { agent: createAgent(firstChild) });
  const grandchild = record.child;

  assert.deepEqual(record.renames, [
    { sessionId: firstChild.id, title: CLEAN_TITLE },
    { sessionId: source.id, title: `历史 1：${CLEAN_TITLE}` },
    { sessionId: grandchild.id, title: CLEAN_TITLE },
    { sessionId: firstChild.id, title: `历史 2：${CLEAN_TITLE}` },
  ]);
  assert.equal(second.childId, grandchild.id);

  // 第 2 跳的父记录（写在 firstChild 日志最后）与子记录都接着 2，不重复 1。
  const secondParent = relayRecordOf(firstChild);
  assert.equal(secondParent.ordinal, 2);
  assert.equal(secondParent.scheme, 'history-n');
  assert.equal(secondParent.historyTitle, `历史 2：${CLEAN_TITLE}`);
  const grandchildRecord = relayRecordOf(grandchild);
  assert.equal(grandchildRecord.ordinal, 2);
  assert.equal(grandchildRecord.scheme, 'history-n');
  assert.equal(grandchildRecord.baseTitle, CLEAN_TITLE);
  assert.equal(grandchildRecord.title, CLEAN_TITLE);

  // 文档头序号也同步（数据与文案不各说各话）。
  const doc = fs.readFileSync(second.path, 'utf8');
  assert.equal(doc.includes('- 交接序号：第 2 次交接'), true);
}

console.log('PASS  0.5.0 命名反转：第 2 次交接 → 旧会话「历史 2：X」、新会话仍 X，序号不重');

/* ================================================================== *
 * 3) titleSeq：父/子记录各取「自己那次 rename」的 eventSeq
 * ================================================================== */

{
  const session = baseSourceSession();
  // rename 顺序：第 1 次是子会话，第 2 次是旧会话 → 101 / 102，不能取错。
  const { ctx, engine, record } = makeCtx({
    sessionTitleText: CLEAN_TITLE,
    renameEventSeq: ({ call }) => 100 + call,
  });
  await handoff(tmpDeps(ctx, engine, 'relay-naming-seq-'), { agent: createAgent(session) });
  const child = record.child;
  const parent = relayEventsOf(session)[0].data;
  const childRecord = relayEventsOf(child)[0].data;

  assert.equal(childRecord.titleSeq, 101, '子记录 titleSeq = 子会话 rename 的 eventSeq');
  assert.equal(parent.titleSeq, 102, '父记录 titleSeq = 旧会话 rename 的 eventSeq');
  assert.equal(parent.historyTitle, `历史 1：${CLEAN_TITLE}`);
}

console.log('PASS  0.5.0 命名反转：父记录 titleSeq 取旧会话 rename、子记录取子会话 rename');

/* ================================================================== *
 * 4) 旧链 cutover：交接第 N 次 / 0.3 旧记录 → 旧会话一个字符不改
 * ================================================================== */

{
  // 4.1 已存在的「交接第 1 次：X」链（无 record）：继续「交接第 2 次：X」。
  const legacy = baseSourceSession();
  const { ctx, engine, record } = makeCtx({ sessionTitleText: '交接第 1 次：旧链标题' });
  await handoff(tmpDeps(ctx, engine, 'relay-naming-legacy-'), { agent: createAgent(legacy) });
  const child = record.child;

  assert.deepEqual(record.renames, [{ sessionId: child.id, title: '交接第 2 次：旧链标题' }]);
  assert.equal(
    record.renames.some((rename) => rename.sessionId === legacy.id),
    false,
    '旧链不改旧会话标题（没有 session/title 事件）',
  );
  const parent = relayEventsOf(legacy)[0].data;
  assert.equal(parent.scheme, 'handoff-n');
  assert.equal(parent.titleSeq, null, '旧链不 rename 旧会话 → titleSeq null');
  assert.equal('historyTitle' in parent, false, '旧链不写 historyTitle');
  assert.equal(parent.title, '交接第 2 次：旧链标题');
  const childRecord = relayEventsOf(child)[0].data;
  assert.equal(childRecord.scheme, 'handoff-n');
  assert.equal(childRecord.ordinal, 2);
  assert.equal(childRecord.title, '交接第 2 次：旧链标题');
}

{
  // 4.2 0.3 旧 record（scheme 缺失）+ 干净标题：仍按旧链续号，不迁移到新命名。
  const legacy = baseSourceSession();
  legacy.log.push({
    type: RELAY_RECORD_TYPE,
    ignorable: true,
    seq: legacy.log.length,
    data: { parentSessionId: 'session-gp', childId: legacy.id, index: 1, baseTitle: '旧链标题', at: 1 },
  });
  const { ctx, engine, record } = makeCtx({ sessionTitleText: CLEAN_TITLE });
  await handoff(tmpDeps(ctx, engine, 'relay-naming-legacy-record-'), { agent: createAgent(legacy) });

  assert.deepEqual(record.renames, [{ sessionId: record.child.id, title: '交接第 2 次：旧链标题' }]);
  const parent = relayRecordOf(legacy);
  assert.equal(parent.ordinal, 2);
  assert.equal(parent.scheme, 'handoff-n', '0.3 旧记录 scheme=null → 旧链，不迁移');
}

console.log('PASS  0.5.0 命名反转：旧链 cutover —— 交接第 N 次/0.3 旧记录不改旧标题、不迁移 scheme');

/* ================================================================== *
 * 5) 80 字节预算：前缀计入、超长先缩 base、不切坏多字节字符
 * ================================================================== */

{
  // 纯函数：前缀永远保留，base 被缩到预算内；总长 ≤80。
  const longBase = '很长的会话标题'.repeat(12);
  assert.equal(Buffer.byteLength(longBase, 'utf8') > MAX_TITLE_BYTES, true);
  const fitted = historyTitleOf(3, longBase, MAX_TITLE_BYTES);
  assert.equal(fitted.startsWith(`${HISTORY_PREFIX} 3：`), true, '前缀不被截掉');
  assert.equal(Buffer.byteLength(fitted, 'utf8') <= MAX_TITLE_BYTES, true, `历史标题 ≤${MAX_TITLE_BYTES} 字节`);
  const parsed = splitHandoffTitle(fitted);
  assert.equal(parsed.scheme, 'history-n');
  assert.equal(parsed.handedOff, 3);
  assert.equal(longBase.startsWith(parsed.baseTitle), true, '缩的是 base 尾部，不是前缀');
  assert.equal(parsed.baseTitle.length > 0, true);

  // emoji 等 4 字节字符不被切坏（不出现半个代理对）。
  // 预算刚好只够前缀：不越界、不吞前缀。
  const prefixOnly = historyTitleOf(1, longBase, Buffer.byteLength('历史 1：', 'utf8'));
  assert.equal(prefixOnly, '历史 1：');
  assert.equal(Buffer.byteLength(prefixOnly, 'utf8') <= MAX_TITLE_BYTES, true);

  const emojiBase = '😀'.repeat(40);
  const emojiFitted = truncateTitleUtf8(emojiBase, 11);
  assert.equal(Buffer.byteLength(emojiFitted, 'utf8') <= 11, true);
  assert.equal([...emojiFitted].every((character) => character === '😀'), true, '不切坏代理对');

  // 端到端：改名目标与子会话标题都 ≤80，父记录仍保存完整原名/实际历史名。
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx({ sessionTitleText: longBase });
  await handoff(tmpDeps(ctx, engine, 'relay-naming-bytes-'), { agent: createAgent(session) });
  const [childRename, parentRename] = record.renames;
  assert.equal(Buffer.byteLength(childRename.title, 'utf8') <= MAX_TITLE_BYTES, true, '新会话标题也守预算');
  assert.equal(Buffer.byteLength(parentRename.title, 'utf8') <= MAX_TITLE_BYTES, true, '历史标题守预算');
  assert.equal(parentRename.title, historyTitleOf(1, longBase, MAX_TITLE_BYTES));
  assert.equal(longBase.startsWith(childRename.title), true, '新会话标题是原名的可读前缀');
  const parent = relayEventsOf(session)[0].data;
  assert.equal(parent.baseTitle, longBase, '记录里保存完整原名');
  assert.equal(parent.historyTitle, parentRename.title, '记录里的历史名 = 实际改名目标');
}

console.log('PASS  0.5.0 命名反转：80 字节预算 —— 前缀保留、只缩 base、不切坏多字节字符');

/* ================================================================== *
 * 6) renameHistoryOf：幂等 guard / 旧链不动 / rename 失败降级 / flush
 * ================================================================== */

{
  const session = { id: 'session-old' };
  const { ctx, state, log } = statefulTitleHost('原名');

  // 6.1 首次：改名 + flush，titleSeq 来自 rename 快照。
  const first = await renameHistoryOf(ctx, session, { index: 1, baseTitle: '原名', log });
  assert.deepEqual(first, { renamed: true, title: '历史 1：原名', titleSeq: 7, reason: null });
  assert.equal(state.title, '历史 1：原名');
  assert.equal(state.renames.length, 1);
  assert.equal(state.flushes, 1, '改名后 flush 旧会话');

  // 6.2 幂等：同一链重复执行，标题已是目标 → 不重复 append rename、不再改。
  const second = await renameHistoryOf(ctx, session, { index: 1, baseTitle: '原名', log });
  assert.deepEqual(second, { renamed: false, title: '历史 1：原名', titleSeq: null, reason: 'already' });
  assert.equal(state.renames.length, 1, '同一目标只 rename 一次（不重复加前缀）');

  // 6.3 宿主已把连续空白折叠：语义上已是目标 → 不重复 rename。
  const collapseHost = statefulTitleHost('历史 3：a b');
  const collapsed = await renameHistoryOf(collapseHost.ctx, session, { index: 3, baseTitle: 'a  b', log });
  assert.equal(collapsed.renamed, false, '空白折叠后的同一标题不再 rename');
  assert.equal(collapsed.reason, 'already');
  assert.equal(collapseHost.state.renames.length, 0);

  // 6.4 宿主按更小预算截断过：当前是目标的合法前缀 → 也跳过。
  const truncatedHost = statefulTitleHost('历史 2：前');
  const skipped = await renameHistoryOf(truncatedHost.ctx, session, { index: 2, baseTitle: '前缀很长', log });
  assert.equal(skipped.renamed, false);
  assert.equal(skipped.reason, 'already');
  assert.equal(truncatedHost.state.renames.length, 0);
}

{
  // 6.5 旧链：直接返回 old-chain，不读标题服务、不改名、不 flush。
  const session = { id: 'session-legacy' };
  const { ctx, state } = statefulTitleHost('交接第 1 次：X');
  const result = await renameHistoryOf(ctx, session, { index: 2, baseTitle: 'X', scheme: 'handoff-n' });
  assert.deepEqual(result, { renamed: false, title: null, titleSeq: null, reason: 'old-chain' });
  assert.equal(state.renames.length, 0);
  assert.equal(state.flushes, 0);
}

{
  // 6.6 rename 失败（宿主非 live/服务异常）：只 warn，不抛、不阻断，标题保持原样。
  const session = { id: 'session-failing' };
  const { ctx, state, log } = statefulTitleHost('原名', { failRename: true });
  const result = await renameHistoryOf(ctx, session, { index: 1, baseTitle: '原名', log });
  assert.equal(result.renamed, false);
  assert.equal(result.reason, 'failed');
  assert.equal(result.titleSeq, null);
  assert.equal(state.title, '原名', '失败时标题保持原样');
  assert.equal(state.flushes, 0);
  assert.equal(state.warnings.length, 1);
  assert.equal(state.warnings[0].includes('改名'), true);

  // 6.7 sessionTitle 服务整体不可用：同样降级（不抛）。
  const noService = { get: () => undefined };
  const unavailable = await renameHistoryOf(noService, session, { index: 1, baseTitle: '原名', log });
  assert.equal(unavailable.renamed, false);
  assert.equal(unavailable.reason, 'unavailable');
}

console.log('PASS  0.5.0 命名反转：renameHistoryOf —— 幂等 guard、旧链不动、失败降级、成功后 flush');

/* ================================================================== *
 * 7) 旧会话 rename 失败：不阻断交接、不写假的 historyTitle
 * ================================================================== */

{
  const session = baseSourceSession();
  // 只让旧会话的 rename 抛错（子会话标题仍成功）：模拟旧会话非 live / 标题服务异常。
  const { ctx, engine, record } = makeCtx({ sessionTitleText: CLEAN_TITLE, renameBrokenFor: session.id });
  const deps = tmpDeps(ctx, engine, 'relay-naming-rename-fail-');
  const warnings = [];
  deps.log = { warn: (message) => warnings.push(message) };

  const result = await handoff(deps, { agent: createAgent(session) });
  assert.equal(result.ok, true, '旧会话改名失败不能阻断交接');
  assert.equal(result.started, true);
  assert.deepEqual(record.renames, [{ sessionId: record.child.id, title: CLEAN_TITLE }], '旧会话没有被改名');

  const parent = relayEventsOf(session)[0].data;
  assert.equal(parent.scheme, 'history-n', '链方案仍是新链（子会话已按新链就绪）');
  assert.equal(parent.titleSeq, null, '没 rename 成功就没有 titleSeq');
  assert.equal('historyTitle' in parent, false, '不能记录一个没生效的历史标题');
  assert.equal(warnings.some((message) => message.includes('改名')), true, '失败要留 warn');

  // 子会话记录不受影响，下次仍能从它续到第 2 次。
  const childRecord = relayEventsOf(record.child)[0].data;
  assert.equal(childRecord.scheme, 'history-n');
  assert.equal(childRecord.ordinal, 1);
  assert.equal(relayRecordOf(record.child).ordinal, 1);
}

console.log('PASS  0.5.0 命名反转：旧会话 rename 失败 → 交接成功、warn、不写假的 historyTitle');
