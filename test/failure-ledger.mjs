/**
 * 0.5.6 Phase A：失败留档 + HTTP 500 统一出口 + preview 双保护（node 级，不起宿主）。
 *
 *   node test/failure-ledger.mjs
 *
 * 覆盖（总计划 Phase A 验收 3/5/6 与 task-4 A1/A2/A5/A6/A7）：
 *   - 500 响应恒带 `{ok:false, code, message, failureId, failure}`，且先落盘再回包；
 *   - 事件文件里 start/end 两行共享 id，end 行 outcome=fail + 宿主原始 message；
 *   - preview 双保护：会话忙碌 → 409 busy（不打模型、不算失败记录）；
 *     尾部工具调用未配对 → 409 pairing-tail（不打模型、留档、context 带 pairingBalanced=false）；
 *   - 诊断端点 `events` 块 additive（recentFailures ≤10、行键与 CLI 一致、已脱敏）；
 *     且 `dcr-diagnostics/v1` 的 `json` 里没有 events（冻结白名单不破）；
 *   - GET 端点 500 也带 code（state 端点）；
 *   - B 级动作只在失败时记一行（favorite-mark 400）；
 *   - compact-transaction 的 catch 把 compactionId 挂到错误上。
 *
 * 全部写临时 DSH_HOME，不碰真实 ~/.dsh；DSH 包用 test/harness/dsh-stubs 解析。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerDshStubHooks } from './harness/dsh-stubs.mjs';

registerDshStubHooks();
const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-failure-home-'));
process.env.DSH_HOME = dshHome;

const { registerHttp } = await import('../lib/adapters/http.js');
const { createEventStore, readEventsFile } = await import('../lib/dsh/events.js');
const { EVENT_ROW_KEYS, EVENT_SCHEMA } = await import('../lib/core/events.js');
const { createLock } = await import('../lib/actions/lock.js');
const { resolveConfig } = await import('../lib/config.js');
const { replaceRangeWithSummary } = await import('../lib/dsh/compact-transaction.js');
const { createAgent, createFakeEngine, createFakeHost, createTmpDir, callRoute, requireRoute } = await import('./harness/host.mjs');
const { createFakeLlm } = await import('./harness/llm.mjs');
const { MockSession } = await import('./harness/session.mjs');
const { HANDOFF_SECTIONS } = await import('../lib/core/handoff-doc.js');

const EVENTS_FILE = path.join(dshHome, 'compact-relay-events.jsonl');

/** 等异步 handler 写完响应（HTTP 路由是 void async）。 */
async function callAction(host, pathname, payload, { timeoutMs = 1500 } = {}) {
  const route = requireRoute(host, pathname);
  const res = {
    status: undefined,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers ?? {});
    },
    end(body) {
      this.body = body ?? '';
    },
    on() {},
  };
  const body = JSON.stringify(payload);
  const req = {
    method: 'POST',
    url: pathname,
    headers: { 'content-type': 'application/json' },
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(body));
      if (event === 'end') handler();
    },
    destroy() {},
  };
  route.handler(req, res);
  const deadline = Date.now() + timeoutMs;
  while (res.body === '' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) };
}

async function callGet(host, pathWithQuery, { timeoutMs = 1500 } = {}) {
  const pathname = new URL(pathWithQuery, 'http://127.0.0.1').pathname;
  const route = requireRoute(host, pathname);
  const res = {
    status: undefined,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers ?? {});
    },
    end(body) {
      this.body = body ?? '';
    },
    on() {},
  };
  route.handler({ method: 'GET', url: pathWithQuery, headers: {}, on() {} }, res);
  const deadline = Date.now() + timeoutMs;
  while (res.body === '' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) };
}

/** 与 DSH DeepSeek adapter 同一条报错/同一个 code（见 task-4 E12）。 */
function invalidRequestError() {
  const error = new Error('DeepSeek Messages tool calls need immediate results');
  error.name = 'LlmError';
  error.code = 'INVALID_REQUEST';
  return error;
}

function handoffReply() {
  return HANDOFF_SECTIONS.map((section) => `## ${section}\n- ${section}的内容：完成验证、记录结论并标注下一步`).join('\n');
}

/** 一个会话：surface 头是 user/message（deriveEventMessage 由 MockSession 默认提供）。 */
function makeSession(id) {
  return new MockSession({ id }).seed([
    { type: 'system/message', data: { text: 'system' } },
    { type: 'user/message', data: { text: '请继续' } },
  ]);
}

/** 组装一个 HTTP 环境（host + deps + store），路由只注册一次。 */
function makeEnv({ engine, llm, session, agentOverrides = {} } = {}) {
  const handoffDir = createTmpDir('dcr-failure-handoff-');
  const events = createEventStore({ file: EVENTS_FILE, version: '0.5.6', home: os.homedir() });
  const agent = createAgent(session, agentOverrides);
  const host = createFakeHost({
    services: {
      agents: { get: () => agent, list: () => [agent] },
      sessions: { get: () => session, flush() {} },
      tokenMeter: {
        measure: (target) => ({
          totalTokens: 40_000,
          surfaceTokens: 40_000,
          nodes: target.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 })),
        }),
      },
      llm,
    },
  });
  const ctx = host.makeContext(true);
  const deps = {
    ctx,
    cfg: resolveConfig({ handoffDir, retention: { recentTailTokens: 0 } }),
    lock: createLock(),
    engine: engine ?? createFakeEngine(),
    events,
    settings: { view: () => ({ version: '0.5.6' }) },
  };
  registerHttp(ctx, deps);
  return { host, deps, events, agent, session };
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* ================================================================== *
 * F1：500 恒带 code+message+failureId+failure，先落盘再回包
 * ================================================================== */

test('F1 handoff-preview 内部 500：body 带 code/message/failureId/failure，事件文件有 start+end', async () => {
  fs.rmSync(EVENTS_FILE, { force: true });
  const session = makeSession('session-f1');
  const llm = createFakeLlm({
    routes: [
      {
        kind: 'handoff',
        match: () => true,
        stream: () => {
          throw invalidRequestError();
        },
      },
    ],
  });
  const env = makeEnv({ llm, session });
  const res = await callAction(env.host, '/api/compact-relay-action', {
    action: 'handoff-preview',
    sessionId: session.id,
    trigger: 'ui-menu',
  });

  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'INVALID_REQUEST');
  assert.equal(res.body.message, '失败：DeepSeek Messages tool calls need immediate results');
  assert.match(res.body.failureId, /^evt-\d{8}T\d{6}-[0-9a-f]{8}$/u);
  assert.equal(res.body.failure.action, 'handoff-preview');
  assert.equal(res.body.failure.trigger, 'ui-menu');
  assert.equal(res.body.failure.code, 'INVALID_REQUEST');
  assert.equal(res.body.failure.outcome, 'fail');
  assert.equal(res.body.failure.message.includes('DeepSeek Messages'), true);
  assert.equal(res.body.failure.sessionId.startsWith('…'), true, '外发投影遮蔽 sessionId');
  assert.equal(typeof res.body.failure.context.lastSurfaceType, 'string');
  assert.equal(res.body.failure.context.pairingBalanced, true);

  const raw = readEventsFile(EVENTS_FILE);
  assert.equal(raw.length, 2, 'start+end 两行');
  assert.equal(raw[0].phase, 'start');
  assert.equal(raw[1].phase, 'end');
  assert.equal(raw[0].id, raw[1].id);
  assert.equal(raw[1].id, res.body.failureId);
  assert.equal(raw[1].outcome, 'fail');
  assert.equal(raw[1].code, 'INVALID_REQUEST');
  assert.equal(raw[1].message, 'DeepSeek Messages tool calls need immediate results', '落盘保留宿主原始 message');
  assert.equal(raw[0].schema, EVENT_SCHEMA);
  assert.equal(raw[0].action, 'handoff-preview');
  assert.equal(raw[0].trigger, 'ui-menu');
});

/* ================================================================== *
 * F2/F3：preview 双保护（busy / pairing-tail）
 * ================================================================== */

test('F2 会话正在回复：preview 409 busy，不打模型、不写失败投影', async () => {
  fs.rmSync(EVENTS_FILE, { force: true });
  const session = makeSession('session-f2');
  const llm = createFakeLlm({ routes: [{ kind: 'handoff', match: () => true, replies: [handoffReply()] }] });
  const env = makeEnv({
    llm,
    session,
    agentOverrides: {
      runMaintenance() {
        throw new Error('agent "session-f2" already has active work');
      },
    },
  });
  const res = await callAction(env.host, '/api/compact-relay-action', {
    action: 'handoff-preview',
    sessionId: session.id,
    trigger: 'ui-menu',
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'busy');
  assert.equal(llm.calls.length, 0, 'idle 闸在打模型之前拦住');
  assert.deepEqual(env.events.recentFailures(10), [], 'busy 是正常可重试状态，不进失败投影');
});

test('F3 尾部工具调用未配对：preview 409 pairing-tail，不打模型、留档且 context 标记未配对', async () => {
  fs.rmSync(EVENTS_FILE, { force: true });
  const session = makeSession('session-f3');
  const llm = createFakeLlm({ routes: [{ kind: 'handoff', match: () => true, replies: [handoffReply()] }] });
  const engine = createFakeEngine({ toolPairingBalancedAfter: () => false });
  const env = makeEnv({ llm, session, engine });
  const res = await callAction(env.host, '/api/compact-relay-action', {
    action: 'handoff-preview',
    sessionId: session.id,
    trigger: 'external',
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'pairing-tail');
  assert.match(res.body.message, /未完成的工具调用/u);
  assert.equal(llm.calls.length, 0, '配对闸在报文构造/打模型之前拦住');
  assert.equal(typeof res.body.failureId, 'string', '配对失败也是真失败 → 带 failureId');
  assert.equal(res.body.failure.code, 'pairing-tail');
  assert.equal(res.body.failure.context.pairingBalanced, false);
  const failures = env.events.recentFailures(10);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'pairing-tail');
});

/* ================================================================== *
 * F4：诊断端点 events 块（additive，不进 dcr-diagnostics/v1 json）
 * ================================================================== */

test('F4 诊断端点 events 块：recentFailures/ recentActions / 行键一致 / 已脱敏 / json 里没有 events', async () => {
  const env = makeEnv({ llm: createFakeLlm({ routes: [{ kind: 'handoff', match: () => true, replies: [handoffReply()] }] }), session: makeSession('session-f4') });
  const res = await callGet(env.host, '/api/compact-relay-diagnostics?sessionId=session-f4');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.schema, 'dcr-diagnostics/v1');
  assert.equal('events' in res.body.json, false, 'dcr-diagnostics/v1 的 json 形状不许加字段');
  const events = res.body.events;
  assert.equal(events !== null && typeof events === 'object', true);
  assert.equal(typeof events.writeable, 'boolean');
  assert.equal(events.file, 'compact-relay-events.jsonl', '只给文件名，不给绝对路径');
  assert.equal(Number.isInteger(events.rows), true);
  assert.equal(Array.isArray(events.recentFailures), true);
  assert.equal(Array.isArray(events.recentActions), true);
  assert.equal(events.recentFailures.length <= 10, true);
  assert.equal(events.recentActions.length <= 20, true);
  for (const row of events.recentFailures) {
    assert.deepEqual(Object.keys(row), [...EVENT_ROW_KEYS], '端点行键与 schema 一致');
    assert.equal(row.message === null || row.message.length <= 200, true);
    assert.equal(row.sessionId === null || row.sessionId.startsWith('…'), true, 'sessionId 已遮蔽');
  }
  const text = JSON.stringify(events);
  assert.equal(text.includes('/Users/'), false, '端点块里不许出现绝对路径');
  assert.equal(text.includes('session-f1'), false, '端点块里不许出现完整 sessionId');
});

/* ================================================================== *
 * F5：GET 端点 500 也带 code
 * ================================================================== */

test('F5 state 端点内部异常：500 body 带 code+message（不再是只有 error 字段）', async () => {
  const env = makeEnv({ llm: createFakeLlm({ routes: [{ kind: 'handoff', match: () => true, replies: [handoffReply()] }] }), session: makeSession('session-f5') });
  const saved = env.deps.cfg;
  env.deps.cfg = null; // 无 agent 时 readState 读 cfg.contextWindowFallback 会抛
  const res = await callGet(env.host, '/api/compact-relay-state');
  env.deps.cfg = saved;
  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
  assert.equal(typeof res.body.code, 'string');
  assert.equal(res.body.code.length > 0, true);
  assert.equal(typeof res.body.message, 'string');
  assert.equal(res.body.message.length > 0, true);
});

/* ================================================================== *
 * F6：A 级同步动作（cancel）也成对记事件
 * ================================================================== */

test('F6 cancel 动作：start/end 成对、outcome ok、trigger 贯通', async () => {
  fs.rmSync(EVENTS_FILE, { force: true });
  const session = makeSession('session-f6');
  const env = makeEnv({
    llm: createFakeLlm({ routes: [{ kind: 'handoff', match: () => true, replies: [handoffReply()] }] }),
    session,
  });
  const res = await callAction(env.host, '/api/compact-relay-action', {
    action: 'cancel',
    sessionId: session.id,
    trigger: 'ui-menu',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.cancelled, false, '没有在跑的任务也照常返回（行为不变）');
  const raw = readEventsFile(EVENTS_FILE);
  assert.equal(raw.length, 2);
  assert.equal(raw[0].phase, 'start');
  assert.equal(raw[1].phase, 'end');
  assert.equal(raw[0].action, 'cancel');
  assert.equal(raw[1].outcome, 'ok');
  assert.equal(raw[0].trigger, 'ui-menu');
});

/* ================================================================== *
 * F7：B 级动作只在失败时记一行（favorite-mark 400）
 * ================================================================== */

test('F7 favorite-mark 失败：400 且事件流记一行 fail（B 级只在失败时留档）', async () => {
  fs.rmSync(EVENTS_FILE, { force: true });
  const session = makeSession('session-f7');
  const env = makeEnv({
    llm: createFakeLlm({ routes: [{ kind: 'handoff', match: () => true, replies: [handoffReply()] }] }),
    session,
  });
  const res = await callAction(env.host, '/api/compact-relay-action', {
    action: 'favorite-mark',
    sessionId: 'session-f7',
    seq: 'not-a-number',
    active: true,
    trigger: 'ui-menu',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  const raw = readEventsFile(EVENTS_FILE);
  assert.equal(raw.length, 1, 'B 级失败只记一行 end（没有 start）');
  assert.equal(raw[0].phase, 'end');
  assert.equal(raw[0].action, 'favorite-mark');
  assert.equal(raw[0].outcome, 'fail');
  assert.equal(raw[0].trigger, 'ui-menu');
});

/* ================================================================== *
 * F8：compact-transaction 的 catch 把 compactionId 挂到错误上
 * ================================================================== */

test('F8 事务失败：error.compactionId 与会话日志里的 compaction/start 对上号', async () => {
  const session = makeSession('session-f8');
  const engine = createFakeEngine();
  const nodes = [...session.surface.nodes];
  const range = { startSeq: nodes[0], endSeq: nodes[nodes.length - 1], shadowedSeqs: nodes };
  let caught = null;
  try {
    await replaceRangeWithSummary({
      session,
      range,
      engine,
      summarize: async () => {
        throw new Error('模型挂了');
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught !== null, true);
  assert.equal(caught.code, 'commit');
  assert.equal(typeof caught.compactionId, 'string');
  const start = session.log.find((event) => event.type === 'compaction/start');
  assert.equal(start.data.compactionId, caught.compactionId, '失败也能与会话日志配对');
});

/* run */
let passed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${cases.length} passed`);
