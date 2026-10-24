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
 * @param {{liveSession?:object, agent?:object}} input
 * @returns {object} readState deps
 */
function depsOf({ liveSession, agent } = {}) {
  return {
    ctx: {
      tokenMeter,
      llm,
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

console.log('PASS  0.3.5 state：无活 agent 的 live session 仍算出可压范围 + reason=no_agent');
console.log('PASS  0.3.5 state：有活 agent reason=null；空会话/无会话不误报'); 
