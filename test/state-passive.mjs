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
 * @param {{liveSession?:object, agent?:object, archivedSessionIds?:string[]}} input
 * @returns {object} readState deps
 */
function depsOf({ liveSession, agent, archivedSessionIds } = {}) {
  return {
    ctx: {
      tokenMeter,
      llm,
      // 0.5.0：父会话归档状态（readState.parentArchived）的数据源。
      get: (name) =>
        name === 'workspaceRegistry' && Array.isArray(archivedSessionIds) ? { archivedSessionIds } : undefined,
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
  const path = '/Users/x/.dsh/sessions/child-1/session.jsonl';
  const session = sessionWithRelay('session-chain-full', {
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
  const session = sessionWithRelay('session-chain-legacy', {
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

console.log('PASS  0.3.5 state：无活 agent 的 live session 仍算出可压范围 + reason=no_agent');
console.log('PASS  0.3.5 state：有活 agent reason=null；空会话/无会话不误报');
console.log('PASS  0.4 BUG-013 state：checkpoint 之后的旧 compressHint 失效 / 更新的 hint 保留');
console.log('PASS  0.5.0 F4 state：relay 扩成只读 chain（新记录全字段、旧记录 null、无记录 null、旧字段不变）');
