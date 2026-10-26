/**
 * 0.3.5 单测：「会话没有活 agent」不能显示成「没有可压缩内容」。
 *
 * 背景（外部用户报告，0.3.3 Windows / 0.3.4 源码同样存在）：
 *   readState 的 target = picked ?? passivized(liveSessionOf(...))；有 live session、
 *   还没有活 agent 时压力能测出来，但 compactRange 只在 picked 存在时算 → null，
 *   菜单把「会话未激活」误显示成「暂无可压缩内容」并禁用压缩按钮。
 *
 * 这里锁住三件事：
 *   1. 无 agent + 有内容的 live session → 仍算出 compactRange（显示用），并标 reason='no_agent'；
 *   2. 有活 agent → reason=null（行为与 0.3.4 一致）；
 *   3. 空会话/没有会话 → compactRange=null 且 reason=null（不误报 no_agent）。
 */
import assert from 'node:assert/strict';
import { readState } from '../lib/actions/state.js';
import { createLock } from '../lib/actions/lock.js';
import { resolveConfig } from '../lib/config.js';
import { RELAY_RECORD_TYPE } from '../lib/core/relay.js';
import { MockSession } from './harness/session.mjs';

const cfg = resolveConfig({ retention: { recentTailTokens: 0 } });
const engine = {
  isCompactCheckpointSource: () => false,
  toolPairingBalancedBefore: () => true,
  toolPairingBalancedAfter: () => true,
};
const llm = {
  async resolveModelInfo() {
    return { context: { contextWindow: 200_000 } };
  },
};
const tokenMeter = {
  measure(session) {
    const nodes = session.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 }));
    return { totalTokens: nodes.length * 100, surfaceTokens: nodes.length * 100, nodes };
  },
};

/**
 * @param {{liveSession?:object, agent?:object, archivedSessionIds?:string[], unarchive?:boolean}} input
 * @returns {object} readState deps
 */
function depsOf({ liveSession, agent, archivedSessionIds, unarchive } = {}) {
  return {
    ctx: {
      tokenMeter,
      llm,
      // 0.5.0：父会话归档状态（readState.parentArchived）的数据源。
      // 0.5.1 DCR-03：同一份 registry 还回答「能不能恢复」（capabilities.unarchive）。
      get: (name) =>
        name === 'workspaceRegistry' && (Array.isArray(archivedSessionIds) || unarchive === true)
          ? {
              ...(Array.isArray(archivedSessionIds) ? { archivedSessionIds } : {}),
              ...(unarchive === true ? { async unarchiveSession() {} } : {}),
            }
          : undefined,
      agents: {
        get: (id) => (agent !== undefined && agent.id === id ? agent : undefined),
        list: () => (agent === undefined ? [] : [agent]),
      },
      sessions: {
        get: (id) => (liveSession !== undefined && liveSession.id === id ? liveSession : undefined),
        flush() {},
      },
    },
    cfg,
    lock: createLock(),
    engine,
  };
}

/** 有内容的会话（4 条消息节点，pressure=400）。 */
function sessionWithMessages(id = 'session-passive') {
  return new MockSession({
    id,
    cwd: undefined,
    agentPreset: undefined,
    events: [
      { type: 'user/message', data: { role: 'user', content: '第一条' } },
      { type: 'assistant/message', data: { role: 'assistant', content: '回复一' } },
      { type: 'user/message', data: { role: 'user', content: '第二条' } },
      { type: 'assistant/message', data: { role: 'assistant', content: '回复二' } },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * 1. 无活 agent + 有内容的 live session：范围要算出来，reason='no_agent'
 * ------------------------------------------------------------------ */

{
  const session = sessionWithMessages('session-passive');
  const state = await readState(depsOf({ liveSession: session }), { sessionId: session.id });

  assert.equal(state.sessionId, 'session-passive');
  assert.equal(state.pressure, 400, 'passivized live session 也要能测出压力');
  assert.equal(state.compactRange !== null, true, '无活 agent 也要算出可压范围（显示用）');
  assert.equal(state.compactRange.nodes, 4);
  assert.equal(state.compactRange.tokens, 400);
  assert.equal(state.compactRangeReason, 'no_agent', '无活 agent 时要标 no_agent，客户端据此换文案');
}

/* ------------------------------------------------------------------ *
 * 2. 有活 agent：reason=null（既有语义不变）
 * ------------------------------------------------------------------ */

{
  const session = sessionWithMessages('session-active');
  const agent = { id: 'agent-active', session };
  const state = await readState(depsOf({ liveSession: session, agent }), { sessionId: session.id });

  // 既有语义：有活 agent 时 target 是 agent，state.sessionId 取 agent.id（HTTP 契约不变）。
  assert.equal(state.sessionId, 'agent-active');
  assert.equal(state.compactRange !== null, true);
  assert.equal(state.compactRange.nodes, 4);
  assert.equal(state.compactRangeReason, null, '有活 agent 时不应标 no_agent');
}

/* ------------------------------------------------------------------ *
 * 3. 空会话：不误报 —— compactRange=null 且 reason=null
 * ------------------------------------------------------------------ */

{
  const empty = new MockSession({ id: 'session-empty', cwd: undefined, agentPreset: undefined });
  const state = await readState(depsOf({ liveSession: empty }), { sessionId: empty.id });

  assert.equal(state.sessionId, 'session-empty');
  assert.equal(state.compactRange, null);
  assert.equal(state.compactRangeReason, null, '空会话不能误报成「会话未激活」');
}

/* ------------------------------------------------------------------ *
 * 4. 没有会话：同样是 null/null（additive 字段不引入噪声）
 * ------------------------------------------------------------------ */

{
  const state = await readState(depsOf({}), { sessionId: 'session-missing' });
  assert.equal(state.sessionId, null);
  assert.equal(state.compactRange, null);
  assert.equal(state.compactRangeReason, null);
  assert.equal(state.relay, null, '没有会话 → 没有接力链记录');
  assert.equal(state.chain, null, '没有会话 → 没有链投影（0.5.0 F4）');
}

/* ------------------------------------------------------------------ *
 * 5. HTTP 契约 additive：既有字段仍在，新字段只加不改
 * ------------------------------------------------------------------ */

{
  const session = sessionWithMessages('session-contract');
  const state = await readState(depsOf({ liveSession: session }), { sessionId: session.id });
  for (const key of [
    'revision',
    'sessionId',
    'pressure',
    'ratio',
    'summaries',
    'advice',
    'level',
    'pins',
    'compactRange',
    'busy',
    'thresholds',
    'colors',
    'compressHint',
    'native',
  ]) {
    assert.equal(Object.hasOwn(state, key), true, `既有 state 字段 ${key} 不能丢`);
  }
  assert.equal(Object.hasOwn(state, 'compactRangeReason'), true, '新字段 compactRangeReason 必须存在');
}

/* ------------------------------------------------------------------ *
 * 6. 0.4 BUG-013：压缩/交接后旧 compressHint 必须失效（checkpoint 判定）
 *
 * 根因：readState 调 lastCheckpointSurfaceSeq(session) 漏传 isCheckpointSource，
 * session-view 里 TypeError 被吞 → 永远 -1 → checkpointSeq undefined →
 * compressHintIsActive 恒 true（旧断点残留 + 旧 ratio 抑制 cue 注入）。
 * 这里锁住「旧 hint + 更新的 checkpoint → null」和「hint 比 checkpoint 新 → 保留」。
 * ------------------------------------------------------------------ */

const HINT_TYPE = 'plugin:compact-relay/compress-hint';

/** 用「认 compact-checkpoint source」的 fake engine 构造 readState deps。 */
function checkpointDepsOf(session) {
  const deps = depsOf({ liveSession: session });
  deps.engine = {
    ...engine,
    isCompactCheckpointSource: (source) => source?.kind === 'compact-checkpoint',
  };
  return deps;
}

{
  // 旧 hint（seq 1）+ 更新的 checkpoint（seq 2）→ 提示已失效。
  const session = new MockSession({
    id: 'session-hint-stale',
    cwd: undefined,
    agentPreset: undefined,
    events: [
      { type: 'user/message', data: { role: 'user', content: '旧消息' } },
      { type: HINT_TYPE, ignorable: true, data: { ratio: 0.264, at: 111 } },
      { type: 'user/message', data: { role: 'user', content: '压缩摘要', source: { kind: 'compact-checkpoint', compactionId: 'c1' } } },
    ],
  });
  const state = await readState(checkpointDepsOf(session), { sessionId: session.id });
  assert.equal(state.compressHint, null, '压缩/交接 checkpoint 之后的旧 compressHint 必须失效（BUG-013）');
  assert.equal(session.log[1].seq < session.log[2].seq, true, '夹具顺序：hint seq < checkpoint seq');
}

{
  // 正向：hint（seq 2）比 checkpoint（seq 1）新 → 仍然有效，不能被误杀。
  const session = new MockSession({
    id: 'session-hint-fresh',
    cwd: undefined,
    agentPreset: undefined,
    events: [
      { type: 'user/message', data: { role: 'user', content: '旧消息' } },
      { type: 'user/message', data: { role: 'user', content: '压缩摘要', source: { kind: 'compact-checkpoint', compactionId: 'c2' } } },
      { type: HINT_TYPE, ignorable: true, data: { ratio: 0.264, at: 222 } },
    ],
  });
  const state = await readState(checkpointDepsOf(session), { sessionId: session.id });
  assert.notEqual(state.compressHint, null, 'hint 比 checkpoint 新时应保留（不能把正常情况误杀）');
  assert.equal(state.compressHint.ratio, 0.264);
  assert.equal(state.compressHint.seq, 2);
}

/* ------------------------------------------------------------------ *
 * 7. 0.5.0 F4：readState.relay 扩成只读 chain
 *
 * 链信息全部来自会话日志里的那条 relay record（不解析标题、不猜默认值）：
 *   - 新记录（F3 写在子会话里）→ 六个字段都可读，path 有才带；
 *   - 旧记录（0.3/0.4，无 scheme/baseTitle）→ 对应字段 null，链号仍可读；
 *   - 没有记录 → chain=null；
 *   - 旧字段 relay 一个不改（canonical/旧名/F2 字段都还能读）。
 * ------------------------------------------------------------------ */

/** 造一个带 relay 记录的会话（记录内容按场景给定）。 */
function sessionWithRelay(id, data) {
  return new MockSession({
    id,
    cwd: undefined,
    agentPreset: undefined,
    events: [
      { type: 'user/message', data: { role: 'user', content: '交接单' } },
      { type: RELAY_RECORD_TYPE, ignorable: true, data },
    ],
  });
}

{
  // 新记录：F3 写入的字段齐全（parentId/childId/ordinal/baseTitle/scheme/path）。
  // 0.5.1 DCR-01：chain 只投影**本会话的入站记录**（childId===本会话 id），
  // 所以夹具的 session.id 必须和 record.childId 对齐，否则它是一条出站记录。
  const path = '/Users/x/.dsh/sessions/child-1/session.jsonl';
  const session = sessionWithRelay('child-1', {
    parentId: 'parent-1',
    childId: 'child-1',
    ordinal: 2,
    baseTitle: '原会话标题',
    title: '交接第 2 次：原会话标题',
    scheme: 'handoff-n',
    titleSeq: 7,
    path,
    at: 111,
    atIso: '2026-10-26T12:00:00+08:00',
  });
  const state = await readState(depsOf({ liveSession: session }), { sessionId: session.id });

  assert.deepEqual(
    state.chain,
    {
      ordinal: 2,
      baseTitle: '原会话标题',
      parentId: 'parent-1',
      childId: 'child-1',
      scheme: 'handoff-n',
      path,
    },
    'chain 必须是 relay 记录的只读投影（六个字段，path 有则带）',
  );
  // 旧字段原样：canonical + 0.3 旧名 + 0.4.3 F2 字段都还能读（客户端兼容）。
  assert.equal(state.relay.parentId, 'parent-1');
  assert.equal(state.relay.parentSessionId, 'parent-1');
  assert.equal(state.relay.ordinal, 2);
  assert.equal(state.relay.index, 2);
  assert.equal(state.relay.childId, 'child-1');
  assert.equal(state.relay.baseTitle, '原会话标题');
  assert.equal(state.relay.scheme, 'handoff-n');
  assert.equal(state.relay.titleSeq, 7);
  assert.equal(state.relay.path, path);
  // SSE 帧体积：chain 只多一小块（~100B 量级），不能把标题/日志正文搬进帧里。
  assert.equal(JSON.stringify(state.chain).length < 512, true, 'chain 投影不能撑大 SSE 帧');
  // 0.5.0：父会话归档状态来自 workspaceRegistry.archivedSessionIds，独立于 chain。
  assert.equal(state.parentArchived, null, '宿主没有归档服务 → parentArchived=null（不知道，不猜 false）');
  const archivedState = await readState(depsOf({ liveSession: session, archivedSessionIds: ['parent-1'] }), {
    sessionId: session.id,
  });
  assert.equal(archivedState.parentArchived, true, '父会话在归档集合 → parentArchived=true（接力条显示恢复入口）');
  assert.deepEqual(archivedState.chain, state.chain, '归档状态不能污染 chain 的纯投影');
  const unarchivedState = await readState(depsOf({ liveSession: session, archivedSessionIds: [] }), {
    sessionId: session.id,
  });
  assert.equal(unarchivedState.parentArchived, false, '父会话不在归档集合 → false');
}

{
  // 旧记录（0.3 写法：只有 index/parentSessionId/childId/at，没有 scheme/baseTitle/path）。
  // 同样是「本会话的入站记录」：session.id 与 record.childId 一致。
  const session = sessionWithRelay('child-0', {
    parentSessionId: 'parent-0',
    childId: 'child-0',
    index: 1,
    at: 9,
  });
  const state = await readState(depsOf({ liveSession: session }), { sessionId: session.id });

  assert.deepEqual(
    state.chain,
    { ordinal: 1, baseTitle: null, parentId: 'parent-0', childId: 'child-0', scheme: null },
    '旧记录：链号可从 index 兼容读出，scheme/baseTitle 取不到就是 null（不猜）',
  );
  assert.equal('path' in state.chain, false, '记录没有 path 时 chain 不带这个键');
  // 旧字段读取语义不变（旧记录仍按原来的 normalizeRelayRecord 结果下发）。
  assert.equal(state.relay.ordinal, 1);
  assert.equal(state.relay.scheme, null);
  assert.equal(state.relay.baseTitle, undefined, '旧字段保持原样：记录没有 baseTitle 就不出现');
}

{
  // 没有 relay 记录：chain=null（老会话/从未交接），不是空对象。
  const session = sessionWithMessages('session-chain-none');
  const state = await readState(depsOf({ liveSession: session }), { sessionId: session.id });
  assert.equal(state.relay, null);
  assert.equal(state.chain, null);
}

{
  // 0.5.1 DCR-01：只有出站记录（本会话交接给下一代）→ chain=null（接力条不显示），
  // 但旧字段 relay 一个字节都不改，出站投影走新增的 next。
  const session = new MockSession({
    id: 'session-outbound-only',
    cwd: undefined,
    agentPreset: undefined,
    events: [
      { type: 'user/message', data: { role: 'user', content: '历史' } },
      { type: RELAY_RECORD_TYPE, ignorable: true, data: { parentId: 'session-outbound-only', childId: 'session-next-gen', ordinal: 1, baseTitle: '原题', scheme: 'history-n', path: '/tmp/handoff-a.md', at: 1 } },
    ],
  });
  const state = await readState(depsOf({ liveSession: session, archivedSessionIds: ['session-outbound-only'] }), {
    sessionId: session.id,
  });
  assert.equal(state.chain, null, '出站记录不是「已接力自」→ chain=null');
  assert.equal(state.parentArchived, null, 'chain=null 时没有父会话可查归档');
  assert.equal(state.relay.childId, 'session-next-gen', '旧字段 relay 仍是最近一条记录（不改语义）');
  assert.deepEqual(
    state.next,
    { ordinal: 1, baseTitle: '原题', parentId: 'session-outbound-only', childId: 'session-next-gen', scheme: 'history-n', path: '/tmp/handoff-a.md' },
    'next = 最近一条出站记录的只读投影（父→子入口/父记录补 path 用）',
  );
  // 0.5.1 DCR-03：宿主没有 unarchiveSession → 客户端据此隐藏「恢复旧会话」。
  assert.deepEqual(state.capabilities, { unarchive: false }, '没有 registry.unarchiveSession → unarchive=false');
}

{
  // 0.5.1 DCR-01（中段会话，bug 原形）：日志里入站在前、出站在后。
  // 旧实现取「最近一条」→ childId=下一代 → 客户端判定不是本会话 → 接力条消失。
  const mid = new MockSession({
    id: 'session-mid',
    cwd: undefined,
    agentPreset: undefined,
    events: [
      { type: 'user/message', data: { role: 'user', content: '交接单' } },
      {
        type: RELAY_RECORD_TYPE,
        ignorable: true,
        data: { parentId: 'session-root', childId: 'session-mid', ordinal: 1, baseTitle: '原题', scheme: 'history-n', path: '/tmp/handoff-hop1.md', at: 1 },
      },
      { type: 'user/message', data: { role: 'user', content: '下一跳' } },
      {
        type: RELAY_RECORD_TYPE,
        ignorable: true,
        data: { parentId: 'session-mid', childId: 'session-leaf', ordinal: 2, baseTitle: '原题', scheme: 'history-n', path: '/tmp/handoff-hop2.md', at: 2 },
      },
    ],
  });
  const state = await readState(depsOf({ liveSession: mid, archivedSessionIds: ['session-root'] }), { sessionId: mid.id });
  assert.deepEqual(
    state.chain,
    { ordinal: 1, baseTitle: '原题', parentId: 'session-root', childId: 'session-mid', scheme: 'history-n', path: '/tmp/handoff-hop1.md' },
    '中段会话：chain 取的是本会话的入站记录，不是最新的出站记录',
  );
  assert.equal(state.parentArchived, true, 'parentArchived 用入站 parentId（session-root）');
  assert.equal(state.relay.ordinal, 2, '旧字段 relay 仍是最近一条出站记录');
  assert.equal(state.next.childId, 'session-leaf', 'next 是最近一条出站记录（第 2 跳）');
  // 归档集合里只有出站的目标（下一代）时，不能把 parentArchived 算成 true。
  const wrongArchive = await readState(depsOf({ liveSession: mid, archivedSessionIds: ['session-leaf'] }), {
    sessionId: mid.id,
  });
  assert.equal(wrongArchive.parentArchived, false, 'parentArchived 只看入站 parentId，不被出站 childId 带偏');
  const capable = await readState(depsOf({ liveSession: mid, unarchive: true }), { sessionId: mid.id });
  assert.deepEqual(capable.capabilities, { unarchive: true }, '宿主有 unarchiveSession → unarchive=true');
}

{
  // 0.5.1 批 3（父→子入口）：`nextArchived` = 出站记录的目标会话（下一代）是否在归档集合里。
  //
  // 和 parentArchived 完全对称：用 **next.childId** 查（不是本会话、也不是入站 parentId），
  // 客户端据此决定「去新会话」要不要先 unarchive（宿主拒绝打开归档会话）。
  // 没有出站记录 / 宿主读不到归档集合 → null（不知道，不猜 false）。
  const parent = new MockSession({
    id: 'session-parent-side',
    cwd: undefined,
    agentPreset: undefined,
    events: [
      { type: 'user/message', data: { role: 'user', content: '交接单' } },
      {
        type: RELAY_RECORD_TYPE,
        ignorable: true,
        data: { parentId: 'session-parent-side', childId: 'session-child-side', ordinal: 1, baseTitle: '原题', scheme: 'history-n', path: '/tmp/handoff-out.md', at: 1 },
      },
    ],
  });
  const archivedChild = await readState(depsOf({ liveSession: parent, archivedSessionIds: ['session-child-side'] }), {
    sessionId: parent.id,
  });
  assert.equal(archivedChild.nextArchived, true, '下一代在归档集合 → nextArchived=true（去新会话先恢复）');
  assert.equal(archivedChild.parentArchived, null, '没有入站记录 → parentArchived 仍是 null（两个字段各查各的）');

  const liveChild = await readState(depsOf({ liveSession: parent, archivedSessionIds: [] }), { sessionId: parent.id });
  assert.equal(liveChild.nextArchived, false, '下一代不在归档集合 → false（可以直接 openSession）');

  // 归档集合里只有本会话自己（交接后旧会话被归档）时，nextArchived 不能被算成 true。
  const selfArchived = await readState(depsOf({ liveSession: parent, archivedSessionIds: ['session-parent-side'] }), {
    sessionId: parent.id,
  });
  assert.equal(selfArchived.nextArchived, false, 'nextArchived 只看出站 childId，不被本会话/入站 id 带偏');

  const noRegistry = await readState(depsOf({ liveSession: parent }), { sessionId: parent.id });
  assert.equal(noRegistry.nextArchived, null, '宿主没有归档服务 → nextArchived=null（不知道）');

  // 没有出站记录（子会话一侧）：nextArchived 必须为 null，不能拿别人的归档状态充数。
  const childSession = sessionWithRelay('session-child-side', {
    parentId: 'session-parent-side',
    childId: 'session-child-side',
    ordinal: 1,
    baseTitle: '原题',
    scheme: 'history-n',
  });
  const noNext = await readState(depsOf({ liveSession: childSession, archivedSessionIds: ['session-parent-side'] }), {
    sessionId: childSession.id,
  });
  assert.equal(noNext.next, null);
  assert.equal(noNext.nextArchived, null, '没有出站记录 → nextArchived=null');
}

console.log('PASS  0.3.5 state：无活 agent 的 live session 仍算出可压范围 + reason=no_agent');
console.log('PASS  0.3.5 state：有活 agent reason=null；空会话/无会话不误报');
console.log('PASS  0.4 BUG-013 state：checkpoint 之后的旧 compressHint 失效 / 更新的 hint 保留');
console.log('PASS  0.5.0 F4 state：relay 扩成只读 chain（新记录全字段、旧记录 null、无记录 null、旧字段不变）');
console.log('PASS  0.5.1 DCR-01 state：chain=本会话入站记录、next=出站投影、parentArchived 取入站 parentId');
console.log('PASS  0.5.1 DCR-03 state：capabilities.unarchive 反映宿主有没有恢复接口');
console.log('PASS  0.5.1 批 3 state：nextArchived 看出站 childId（父→子入口先恢复归档会话）');
