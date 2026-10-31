/**
 * 0.5.7 长动作异步化：HTTP 三动作 + 兼容层（12 条，fake host + 慢 LLM stub）。
 *
 *   node test/jobs-http.mjs
 *
 * 覆盖（架构 §2 / §7）：
 *   1. job-start 快速返回（<50ms）与响应体；
 *   2. job-status 轮询到 done + result；
 *   3. jobCompatMs=50 时旧同步动作（handoff-preview）回 202 pending，且**不中止** job；
 *   4. 202 响应体逐字段；
 *   5. 缺/非法 jobId → 400 code=jobid；job-start 未知 kind → 400；
 *   6. 未知/过期 jobId → 404 code=nojob；
 *   7. job-cancel → cancelled，abort 真传到动作、事件 end=cancelled（不是 fail）；
 *   8. client-error 落一行事件（status/bodyHead/kind 进 context）；
 *   9. compact 经兼容层真路径（deps.jobs 存在）200 体 + start/end 两行 jobId 一致；
 *  10. handoff 经兼容层真路径 200 体逐字段 + 两行 jobId 一致；
 *  11. /handoff status 成功路径（start→running→done→cancelled）。
 *  12. previewHandoff 取消收口（S2：信号已 abort + 底层非取消错误 → end=cancelled）。
 *
 * 全部写临时 DSH_HOME，不碰真实 ~/.dsh；LLM 是本地 stub，不跑真实模型。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerDshStubHooks } from './harness/dsh-stubs.mjs';

registerDshStubHooks();
const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-jobs-http-home-'));
process.env.DSH_HOME = dshHome;

const { registerCommands } = await import('../lib/adapters/commands.js');
const { registerHttp } = await import('../lib/adapters/http.js');
const { previewHandoff } = await import('../lib/actions/handoff.js');
const { createJobTable } = await import('../lib/dsh/jobs.js');
const { createEventStore, readEventsFile } = await import('../lib/dsh/events.js');
const { createLock } = await import('../lib/actions/lock.js');
const { resolveConfig } = await import('../lib/config.js');
const { HANDOFF_SECTIONS } = await import('../lib/core/handoff-doc.js');
const { REQUIRED_SECTIONS } = await import('../lib/core/validate-summary.js');
const {
  createAgent,
  createFakeEngine,
  createFakeHost,
  createHandoffHost,
  createTmpDir,
  requireRoute,
} = await import('./harness/host.mjs');
const { createFakeLlm } = await import('./harness/llm.mjs');
const { MockSession, baseSourceSession } = await import('./harness/session.mjs');

let envSeq = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function handoffReply() {
  return HANDOFF_SECTIONS.map((section) => `## ${section}\n- ${section}的内容：完成验证、记录结论并标注下一步`).join('\n');
}

/** 压缩摘要（与 test/handoff.mjs 同形：REQUIRED_SECTIONS 自带 `## ` 前缀）。
 *  H9 的 compact 真路径需要。 */
function summaryReply() {
  return REQUIRED_SECTIONS.map((section) => `${section}\n- ${section.replace(/^##\s+/u, '')}：根据本轮变更记录关键结论与证据`).join('\n');
}

/**
 * 慢交接单 stub：等到 gate 放行才吐正文；signal abort 时立刻 reject（取消用例）。
 * 这是唯一「慢」的来源 —— 宿主/插件不需要真的 sleep。
 * observed 可选：记录 stream 是否已开始 / signal 是否真的被 abort（T2 断言用）。
 */
function gatedLlm(gate, observed = null) {
  const route = {
    kind: 'handoff',
    match: () => true,
    stream: (options = {}) =>
      (async function* gatedHandoff() {
        const signal = options.signal;
        if (observed !== null) {
          observed.started = true;
          observed.signal = signal;
        }
        await new Promise((resolve, reject) => {
          let settled = false;
          const done = (fn, value) => {
            if (settled) return;
            settled = true;
            fn(value);
          };
          const noteAbort = () => {
            if (observed !== null) {
              observed.aborted = true;
              observed.reason = signal.reason;
            }
          };
          if (signal?.aborted) {
            noteAbort();
            done(reject, signal.reason ?? new Error('aborted'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => {
              noteAbort();
              done(reject, signal.reason ?? new Error('aborted'));
            },
            { once: true },
          );
          gate.promise.then(() => done(resolve));
        });
        yield { type: 'text-delta', index: 0, text: handoffReply() };
      })(),
  };
  return createFakeLlm({ routes: [route] });
}

/** 一个隔离的 HTTP 环境（deps 与 index.js 同名，jobs 用测试参数）。 */
function makeEnv({ gate, jobCompatMs, observed } = {}) {
  envSeq += 1;
  const handoffDir = createTmpDir('dcr-jobs-handoff-');
  const eventsFile = path.join(dshHome, `compact-relay-events-${envSeq}.jsonl`);
  const events = createEventStore({ file: eventsFile, version: '0.5.7', home: os.homedir() });
  const session = new MockSession({ id: `session-jobs-${envSeq}` }).seed([
    { type: 'system/message', data: { text: 'system' } },
    { type: 'user/message', data: { text: '请继续' } },
  ]);
  const agent = createAgent(session);
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
      llm: gatedLlm(gate, observed),
    },
  });
  const ctx = host.makeContext(true);
  const deps = {
    ctx,
    cfg: resolveConfig({
      handoffDir,
      retention: { recentTailTokens: 0 },
      ...(jobCompatMs === undefined ? {} : { timeouts: { jobCompatMs } }),
    }),
    lock: createLock(),
    jobs: createJobTable({ sweepMs: 0 }),
    events,
    engine: createFakeEngine(),
    settings: { view: () => ({ version: '0.5.7' }) },
  };
  registerHttp(ctx, deps);
  return { host, deps, events, eventsFile, session, agent };
}

/**
 * 交接/压缩成功路径的隔离环境：业务 ctx 用 createHandoffHost（agents.create /
 * workspaceRegistry / sessionTitle 都在），HTTP 外壳仍用 createFakeHost。
 * 与 makeEnv 的区别是这里 LLM 用确定性双路由（摘要 + 交接文档），让动作真正跑通。
 */
function makeActionEnv({ commands = false } = {}) {
  envSeq += 1;
  const handoffDir = createTmpDir('dcr-jobs-handoff-');
  const eventsFile = path.join(dshHome, `compact-relay-events-${envSeq}.jsonl`);
  const events = createEventStore({ file: eventsFile, version: '0.5.7', home: os.homedir() });
  const session = baseSourceSession({ id: `session-jobs-${envSeq}` });
  const agent = createAgent(session);
  const llm = createFakeLlm({
    routes: [
      { kind: 'handoff', match: ({ instruction }) => instruction.includes('交接文档'), replies: [handoffReply()] },
      { kind: 'summary', match: () => true, replies: [summaryReply()] },
    ],
  });
  const business = createHandoffHost({ llm });
  const host = createFakeHost({
    services: {
      llm,
      tokenMeter: business.ctx.tokenMeter,
      agents: { ...business.ctx.agents, get: () => agent, list: () => [agent] },
      sessions: { ...business.ctx.sessions, get: () => session },
      get: business.ctx.get,
    },
  });
  const ctx = host.makeContext(true);
  const deps = {
    ctx,
    cfg: resolveConfig({ handoffDir, retention: { recentTailTokens: 0 } }),
    lock: createLock(),
    jobs: createJobTable({ sweepMs: 0 }),
    events,
    engine: createFakeEngine(),
    settings: { view: () => ({ version: '0.5.7' }) },
  };
  registerHttp(ctx, deps);
  if (commands === true) registerCommands(ctx, deps);
  return { host, deps, events, eventsFile, session, agent, handoffDir };
}

/** 等 job 表里的任务离开 running（不依赖 HTTP 轮询，供命令级用例用）。 */
async function waitJobStatus(env, jobId, predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = env.deps.jobs.get(jobId);
    if (last !== null && predicate(last) === true) return last;
    await sleep(5);
  }
  throw new Error(`任务 ${jobId} 未在 ${timeoutMs}ms 内满足条件，最后状态：${JSON.stringify(last)}`);
}

/** 发一个 action POST，等异步 handler 写完响应；返回 {status, body, ms}。 */
async function callAction(host, payload, { timeoutMs = 2000 } = {}) {
  const route = requireRoute(host, '/api/compact-relay-action');
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
    url: '/api/compact-relay-action',
    headers: { 'content-type': 'application/json' },
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(body));
      if (event === 'end') handler();
    },
    destroy() {},
  };
  const startedAt = Date.now();
  route.handler(req, res);
  const deadline = startedAt + timeoutMs;
  while (res.body === '' && Date.now() < deadline) await sleep(1);
  assert.notEqual(res.body, '', `动作 ${payload.action} 在 ${timeoutMs}ms 内没有响应`);
  return { status: res.status, body: JSON.parse(res.body), ms: Date.now() - startedAt };
}

async function pollUntil(host, jobId, predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await callAction(host, { action: 'job-status', jobId });
    if (last.status === 200 && predicate(last.body) === true) return last.body;
    await sleep(5);
  }
  throw new Error(`轮询 ${jobId} 超时，最后状态：${JSON.stringify(last?.body ?? null)}`);
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('H1 job-start <50ms 返回 jobId，动作在后台执行（status=running）', async () => {
  const gate = deferred();
  const env = makeEnv({ gate });
  const res = await callAction(env.host, {
    action: 'job-start',
    kind: 'handoff-preview',
    sessionId: env.session.id,
    trigger: 'ui-menu',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.jobId, /^dcrjob-/u);
  assert.equal(res.body.kind, 'handoff-preview');
  assert.equal(res.body.status, 'running');
  assert.equal(res.body.reused, false);
  assert.equal(typeof res.body.startedAt, 'number');
  assert.ok(res.ms < 50, `job-start 必须 <50ms 返回（实测 ${res.ms}ms）`);
  await sleep(10); // 让 setImmediate 真正开始跑动作
  const status = await callAction(env.host, { action: 'job-status', jobId: res.body.jobId });
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'running');
  assert.equal(status.body.kind, 'handoff-preview');
  assert.equal(typeof status.body.elapsedMs, 'number');
  env.deps.jobs.close();
});

test('H2 轮询到 done：result 与旧同步响应同形状（draft/readiness/editable）', async () => {
  const gate = deferred();
  const env = makeEnv({ gate });
  const started = await callAction(env.host, {
    action: 'job-start',
    kind: 'handoff-preview',
    sessionId: env.session.id,
    trigger: 'ui-menu',
  });
  await sleep(10);
  gate.resolve();
  const done = await pollUntil(env.host, started.body.jobId, (body) => body.status === 'done');
  assert.equal(done.ok, true);
  assert.equal(done.status, 'done');
  assert.equal(typeof done.result.draft, 'string');
  assert.equal(done.result.draft.includes('## 总体目标'), true);
  assert.equal(done.result.ok, true);
  assert.equal(typeof done.result.readiness.ok, 'boolean');
  assert.equal(typeof done.result.editable, 'object');
  assert.equal(done.result.error, undefined);
  // 事件流：start/end 两行都要带同一个 jobId（架构 §3 的坑：context 是逐 action 白名单）。
  const rows = readEventsFile(env.eventsFile).filter((row) => row.action === 'handoff-preview');
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.context.jobId, started.body.jobId);
  env.deps.jobs.close();
});

test('H3 jobCompatMs=50：旧 handoff-preview 15s 预算变 50ms → 202 pending（job 继续跑）', async () => {
  const gate = deferred();
  const env = makeEnv({ gate, jobCompatMs: 50 });
  const res = await callAction(env.host, {
    action: 'handoff-preview',
    sessionId: env.session.id,
    trigger: 'ui-menu',
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.code, 'pending');
  assert.match(res.body.jobId, /^dcrjob-/u);
  assert.ok(res.ms >= 45, `要等满预算再回（实测 ${res.ms}ms）`);
  // 超时不 abort job：放行后同一个 jobId 仍能轮询到 done
  gate.resolve();
  const done = await pollUntil(env.host, res.body.jobId, (body) => body.status === 'done');
  assert.equal(done.result.draft.includes('## 总体目标'), true);
  env.deps.jobs.close();
});

test('H4 202 响应体逐字段（ok:false / code / pending / jobId / kind / message）', async () => {
  const gate = deferred();
  const env = makeEnv({ gate, jobCompatMs: 40 });
  const res = await callAction(env.host, {
    action: 'handoff-preview',
    sessionId: env.session.id,
    trigger: 'ui-menu',
  });
  assert.equal(res.status, 202);
  assert.deepEqual(Object.keys(res.body).sort(), ['code', 'jobId', 'kind', 'message', 'ok', 'pending']);
  assert.equal(res.body.ok, false, 'ok:false 是刻意的：旧脚本不能把 pending 当成功');
  assert.equal(res.body.code, 'pending');
  assert.equal(res.body.pending, true);
  assert.equal(res.body.kind, 'handoff-preview');
  assert.equal(res.body.message, '任务进行中（约十几秒），请稍候…');
  gate.resolve();
  await pollUntil(env.host, res.body.jobId, (body) => body.status === 'done');
  env.deps.jobs.close();
});

test('H5 缺/非法 jobId → 400 code=jobid；job-start 未知 kind → 400', async () => {
  const gate = deferred();
  const env = makeEnv({ gate });
  for (const payload of [
    { action: 'job-status' },
    { action: 'job-status', jobId: 42 },
    { action: 'job-status', jobId: '' },
    { action: 'job-status', jobId: 'x'.repeat(81) },
    { action: 'job-cancel' },
  ]) {
    const res = await callAction(env.host, payload);
    assert.equal(res.status, 400, `${JSON.stringify(payload)} 必须 400`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'jobid');
  }
  const badKind = await callAction(env.host, {
    action: 'job-start',
    kind: 'hack',
    sessionId: env.session.id,
  });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.body.code, 'kind');
  // job-start 仍然要求 sessionId（不进 sessionOptionalAction 例外）
  const noSession = await callAction(env.host, { action: 'job-start', kind: 'handoff-preview' });
  assert.equal(noSession.status, 400);
  env.deps.jobs.close();
});

test('H6 未知 jobId → 404 code=nojob（status 与 cancel 同一口径）', async () => {
  const gate = deferred();
  const env = makeEnv({ gate });
  for (const action of ['job-status', 'job-cancel']) {
    const res = await callAction(env.host, { action, jobId: 'dcrjob-000000000000' });
    assert.equal(res.status, 404, `${action} 未知 jobId 要 404`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'nojob');
    assert.equal(res.body.message.includes('过期'), true);
  }
  env.deps.jobs.close();
});

test('H7 job-cancel → abort 真传到动作：事件 end=cancelled（不是 fail）+ status=cancelled', async () => {
  const gate = deferred();
  const observed = { started: false, aborted: false };
  const env = makeEnv({ gate, observed });
  const started = await callAction(env.host, {
    action: 'job-start',
    kind: 'handoff-preview',
    sessionId: env.session.id,
    trigger: 'ui-menu',
  });
  // 先确认动作真的进到了模型调用（否则「abort 传到动作」没有意义）。
  const startDeadline = Date.now() + 1000;
  while (observed.started !== true && Date.now() < startDeadline) await sleep(5);
  assert.equal(observed.started, true, '取消前动作必须已经进到模型调用');
  const cancelled = await callAction(env.host, { action: 'job-cancel', jobId: started.body.jobId });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.ok, true);
  assert.equal(cancelled.body.cancelled, true);
  assert.equal(cancelled.body.status, 'cancelled');
  // gate 从未放行：stub 只能靠 abort 退出 —— 这就证明 abort 真的传到了动作持有的 signal
  // （若 combinedSignal 被改回 signal ?? idleSignal，这里会一直等到超时）。
  const abortDeadline = Date.now() + 1000;
  while (observed.aborted !== true && Date.now() < abortDeadline) await sleep(5);
  assert.equal(observed.aborted, true, '取消必须 abort 动作持有的 signal');
  assert.equal(observed.reason?.name, 'AbortError');
  // 注意：stub 拿到的是 callStream 内部 controller 的 signal（reason 是 DOMException，
  // 数字 code=20），不是 job 的 AbortError —— 只要 abort 传到了这一层就证明链路打通。
  // 事件流：end 行 outcome=cancelled（不是 fail），start/end 同一 jobId。
  const rowsDeadline = Date.now() + 2000;
  let rows = [];
  while (Date.now() < rowsDeadline) {
    rows = readEventsFile(env.eventsFile).filter((row) => row.action === 'handoff-preview');
    if (rows.some((row) => row.phase === 'end')) break;
    await sleep(5);
  }
  assert.equal(rows.length, 2, '取消也要 start/end 成对');
  const end = rows.find((row) => row.phase === 'end');
  assert.equal(end.outcome, 'cancelled', '取消的 end 行必须记 cancelled');
  assert.equal(end.code, 'cancelled');
  assert.equal(rows.some((row) => row.outcome === 'fail'), false, '取消不能记 fail');
  for (const row of rows) assert.equal(row.context.jobId, started.body.jobId);
  const status = await callAction(env.host, { action: 'job-status', jobId: started.body.jobId });
  assert.equal(status.body.status, 'cancelled');
  assert.equal(status.body.error.code, 'cancelled');
  assert.equal(status.body.result, undefined);
  // 再取消一次：已结束，cancelled:false（幂等，不改状态）
  const again = await callAction(env.host, { action: 'job-cancel', jobId: started.body.jobId });
  assert.equal(again.status, 200);
  assert.equal(again.body.cancelled, false);
  assert.equal(again.body.status, 'cancelled');
  env.deps.jobs.close();
});

test('H8 client-error 落一行事件（status/bodyHead/kind 进 context，bodyHead ≤80）', async () => {
  const gate = deferred();
  const env = makeEnv({ gate });
  const res = await callAction(env.host, {
    action: 'client-error',
    kind: 'handoff-preview',
    status: 502,
    bodyHead: 'x'.repeat(200),
    code: 'transport',
    message: '交接预览失败：Bad Gateway',
    trigger: 'ui-menu',
    // 刻意不带 sessionId：client-error 在 sessionOptionalAction 例外表里
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const rows = readEventsFile(env.eventsFile).filter((row) => row.action === 'client-error');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.phase, 'end');
  assert.equal(row.outcome, 'fail');
  assert.equal(row.code, 'transport');
  assert.equal(row.trigger, 'ui-menu');
  assert.equal(row.context.kind, 'handoff-preview');
  assert.equal(row.context.status, 502);
  assert.equal(row.context.bodyHead.length <= 80, true);
  env.deps.jobs.close();
});

test('H9 compact 经兼容层真路径：200 体与 job-status.result 同形 + start/end 两行 jobId 一致', async () => {
  const env = makeActionEnv();
  const res = await callAction(env.host, { action: 'compact', sessionId: env.session.id, trigger: 'ui-menu' });
  assert.equal(res.status, 200, 'deps.jobs 存在时 compact 必须走 job 兼容层并 200');
  assert.deepEqual(Object.keys(res.body).sort(), ['message', 'ok']);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.message, 'string');
  assert.equal(res.body.message.includes('压缩完成'), true);
  // 证明不是 D2 退化路径（deps.jobs 缺失时同步返回）：表里确实有同一条 job 且已 done。
  const job = env.deps.jobs.latest(env.session.id, 'compact');
  assert.notEqual(job, null);
  assert.equal(job.status, 'done');
  const status = await callAction(env.host, { action: 'job-status', jobId: job.id });
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'done');
  assert.deepEqual(status.body.result, res.body, 'job-status.result 必须与 200 响应体逐字段一致');
  // 事件流：compact 的 start/end 两行都带同一个 jobId（better-compact 的两处整体替换）。
  const rows = readEventsFile(env.eventsFile).filter((row) => row.action === 'compact');
  assert.equal(rows.length, 2, 'compact 成败都要 start/end 成对');
  for (const row of rows) assert.equal(row.context.jobId, job.id);
  assert.equal(rows.find((row) => row.phase === 'end').outcome, 'ok');
  env.deps.jobs.close();
});

test('H10 handoff 经兼容层真路径：200 体逐字段 + start/end 两行 jobId 一致', async () => {
  const env = makeActionEnv();
  const res = await callAction(env.host, {
    action: 'handoff',
    sessionId: env.session.id,
    trigger: 'ui-menu',
    archive: true,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['archive', 'childId', 'message', 'ok', 'path']);
  assert.equal(res.body.ok, true);
  assert.match(res.body.childId, /^session-[0-9a-f-]{36}$/u);
  assert.equal(path.dirname(res.body.path), env.handoffDir);
  assert.match(path.basename(res.body.path), /^handoff-.+\.md$/u);
  assert.deepEqual(res.body.archive, { status: 'archived', archived: true });
  assert.equal(res.body.message.includes(res.body.childId), true);
  assert.equal(res.body.message.includes(res.body.path), true);
  assert.equal(res.body.message.includes(`#child=${res.body.childId}`), true);
  const job = env.deps.jobs.latest(env.session.id, 'handoff');
  assert.notEqual(job, null);
  assert.equal(job.status, 'done');
  const status = await callAction(env.host, { action: 'job-status', jobId: job.id });
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'done');
  assert.deepEqual(status.body.result, res.body, 'job-status.result 必须与 200 响应体逐字段一致');
  // 事件流：handoff 自己的 start/end 两行带同一个 jobId（内部压缩不占这两行）。
  const rows = readEventsFile(env.eventsFile).filter((row) => row.action === 'handoff');
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.context.jobId, job.id);
  assert.equal(rows.find((row) => row.phase === 'end').outcome, 'ok');
  env.deps.jobs.close();
});

test('H11 /handoff status 成功路径：start→running→done→cancelled（真实 job 表装配）', async () => {
  const env = makeActionEnv({ commands: true });
  const def = env.host.commands.find((definition) => definition.name === 'handoff');
  assert.equal(typeof def?.handler, 'function');
  const invoke = (rawInput, commandId) => def.handler({ rawInput, agent: env.agent, signal: undefined, commandId });

  const started = await invoke('', 'cmd-h1');
  assert.equal(started.kind, 'success');
  const idMatch = /任务 (dcrjob-[0-9a-f]+)/u.exec(started.text);
  assert.notEqual(idMatch, null, '启动文本必须带 jobId');
  const jobId = idMatch[1];

  // start 后立即查：命令只起任务不轮询，应回 running。
  const running = await invoke('status', 'cmd-h2');
  assert.equal(running.kind, 'success');
  assert.equal(running.text.includes('进行中'), true);
  assert.equal(running.text.includes(jobId), true);

  const done = await waitJobStatus(env, jobId, (job) => job.status !== 'running');
  assert.equal(done.status, 'done');
  const byId = await invoke(`status ${jobId}`, 'cmd-h3');
  assert.equal(byId.kind, 'success');
  assert.equal(byId.text.includes(done.result.childId), true, 'done 后要回交接结果全文');
  assert.equal(byId.childId, done.result.childId);
  // 不带 jobId：按 session 取最新一条 handoff。
  const latest = await invoke('status', 'cmd-h4');
  assert.equal(latest.kind, 'success');
  assert.equal(latest.childId, done.result.childId);

  // cancelled：起第二个任务后立刻取消（setImmediate 还没跑，M1 守卫保证 run 不执行）。
  const second = await invoke('', 'cmd-h5');
  const secondMatch = /任务 (dcrjob-[0-9a-f]+)/u.exec(second.text);
  assert.notEqual(secondMatch, null);
  const secondId = secondMatch[1];
  assert.notEqual(secondId, jobId);
  assert.equal(env.deps.jobs.cancel(secondId).cancelled, true);
  const cancelledStatus = await invoke('status', 'cmd-h6');
  assert.equal(cancelledStatus.kind, 'error');
  assert.equal(cancelledStatus.text.includes('已取消'), true);
  assert.equal(cancelledStatus.text.includes(secondId), true);
  assert.equal(env.deps.jobs.get(secondId).status, 'cancelled');
  env.deps.jobs.close();
});

test('H12 S2：previewHandoff 信号已 abort + 底层抛非取消错误 → 仍收口 cancelled（end 行不记 fail）', async () => {
  const env = makeActionEnv();
  const controller = new AbortController();
  controller.abort();
  // 底层（runMaintenance）抛的不是 AbortError/code:'cancelled'：没有 cancelErrorOf 时
  // A 级 end 行会记 fail，而 job 侧因 signal.aborted 仍算 cancelled（台账与状态打架）。
  const agent = {
    id: env.session.id,
    session: env.session,
    options: { provider: 'mock', model: 'mock-model' },
    runMaintenance: async () => {
      throw new Error('底层炸了');
    },
  };
  await assert.rejects(
    () => previewHandoff(env.deps, { agent, signal: controller.signal, trigger: 'ui-menu' }),
    (error) => {
      assert.equal(error.code, 'cancelled');
      assert.equal(error.message, '已取消交接预览；会话记录没有改动。');
      return true;
    },
  );
  const rows = readEventsFile(env.eventsFile).filter((row) => row.action === 'handoff-preview');
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.phase === 'end').outcome, 'cancelled');
  assert.equal(rows.some((row) => row.outcome === 'fail'), false, '取消不能记 fail');
  env.deps.jobs.close();
});

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
console.log(`\njobs-http：${passed}/${cases.length} 通过`);
