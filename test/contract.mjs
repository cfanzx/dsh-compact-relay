/**
 * 契约测试 —— A7 的「fake 与真实语义之间」的锁。
 *
 *   node test/contract.mjs
 *
 * 三件事（表驱动，失败一条不影响其它条）：
 *   1. 锁定 `test/harness/session.mjs` 的 append / surfaceOp replace / appendPluginRecord /
 *      故障注入语义，并让**真实**的替换事务（lib/dsh/compact-transaction.js）在 fake session 上跑通；
 *   2. 冻结 `lib/dsh/engine.js` 必须提供的符号清单（与 lib 源码里的 `engine.*` 使用对齐），
 *      fake engine 必须逐符号一致；
 *   3. 锁定 `test/harness/llm.mjs` 的确定性流 / finish reason / 脚本顺序 / 取消语义。
 *
 * 这些用例只跑 node，不加载真实 DSH、不调模型；真机差异由 e2e 兜底。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerDshStubHooks } from './harness/dsh-stubs.mjs';
import { ENGINE_SYMBOLS, createFakeEngine, createFakeHost, createPluginDeps } from './harness/host.mjs';
import { createFakeLlm, createStuckStream } from './harness/llm.mjs';
import { MockSession, baseSession } from './harness/session.mjs';
import { countSummaries, entryState, surfaceSeqs } from '../lib/dsh/session-view.js';
import { replaceRangeWithSummary } from '../lib/dsh/compact-transaction.js';
import { callStream } from '../lib/dsh/llm-call.js';

// 真实 engine 通过 test/stubs 加载：路径解析钩子必须先注册（静态 import 已在此之前完成）。
registerDshStubHooks();
const { default: realEngine } = await import('../lib/dsh/engine.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, '../lib');

function baseSessionWithoutHeader(options = {}) {
  return new MockSession({ id: 'contract-session', cwd: undefined, agentPreset: undefined, ...options });
}

/** lib 源码里实际消费的 engine 符号集合（去掉 import 路径里 engine.js 的干扰）。 */
function engineSymbolsUsedInLib() {
  const used = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(full, 'utf8').replaceAll('engine.js', '');
        for (const match of source.matchAll(/\bengine\.([A-Za-z_$][A-Za-z0-9_$]*)/gu)) used.add(match[1]);
      }
    }
  };
  walk(libDir);
  return [...used].sort();
}

/** 用真实事务替换一段 surface（fake session + fake engine + 确定性 summarize）。 */
function runRealTransaction(session, { summarize } = {}) {
  return replaceRangeWithSummary({
    session,
    range: { startSeq: 1, endSeq: 2, shadowedSeqs: [1, 2], shadowedTokenCount: 123 },
    engine: createFakeEngine(),
    summarize: summarize ?? (async () => ({ summary: [{ type: 'text', text: '一段契约摘要' }], provider: 'mock', model: 'mock-model' })),
  });
}

/** callStream 的最小 options：fake llm 靠最后一条消息分流。 */
function streamOptions(text = '请总结') {
  return { provider: 'mock', model: 'mock-model', messages: [{ role: 'user', content: [{ type: 'text', text }] }], maxTokens: 64 };
}

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/* ---------------- fake session 语义 ---------------- */

test('session: append 分配单调 seq，只有消息事件进 surface', () => {
  const session = baseSessionWithoutHeader();
  const start = session.append('compaction/start', { compactionId: 'c1' });
  assert.equal(start.seq, 0);
  assert.equal(start.data.compactionId, 'c1');
  assert.equal(typeof start.time, 'number');
  assert.deepEqual(session.surface.nodes, [], '生命周期事件不进 surface');

  const user = session.append('user/message', { role: 'user' });
  const assistant = session.append('assistant/message', { role: 'assistant' }, { surfaceOp: 'append' });
  assert.deepEqual(session.surface.nodes, [user.seq, assistant.seq]);
  assert.deepEqual(surfaceSeqs(session), [1, 2]);
  assert.equal(session.seq, session.log.length, 'seq getter = 日志长度');
  assert.equal(session.appendCalls, 3);
});

test('session: seed 按日志顺序写 surface，eventAt 按 seq 取事件', () => {
  const session = baseSession();
  assert.equal(session.log.length, 4);
  assert.deepEqual(session.surface.nodes, [0, 1, 2, 3]);
  assert.equal(session.eventAt(0).type, 'system/message');
  assert.equal(session.eventAt(2).type, 'assistant/message');
  assert.equal(session.eventAt(99), undefined);
  assert.equal(session.snapshotEvents().length, 4);
  assert.equal(session.deriveEventMessage({ type: 'compaction/start', seq: 9 }), null, '非消息事件派生为 null');
  assert.equal(session.deriveEventMessage(session.eventAt(1)).content[0].text, 'event-1');
});

test('session: surfaceOp replace 用新节点替换范围；surface 顺序不按 seq 排序', () => {
  const session = baseSession();
  const replace = session.append(
    'user/message',
    { role: 'user', content: [] },
    { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [4, 1, 2] },
  );
  assert.deepEqual(session.surface.nodes, [0, 4, 3], '旧尾部 seq3 留在 checkpoint 后面');
  assert.equal(session.surface.nodes[1] > session.surface.nodes[2], true, '替换后 surface seq 非单调（新 seq 在前）');
  assert.equal(session.surface.replaceGeneration, 1, '替换要递增 replaceGeneration');
  assert.deepEqual(replace.sourceEventSeqs, [4, 1, 2]);
});

test('session: 非法 replace 范围原子失败（日志/surface 都不动）', () => {
  const session = baseSession();
  const beforeLog = session.log.length;
  const beforeNodes = [...session.surface.nodes];
  assert.throws(
    () =>
      session.append(
        'user/message',
        { role: 'user' },
        { surfaceOp: { op: 'replace', startSeq: 9, endSeq: 10 } },
      ),
    /范围不在 surface 上/u,
  );
  assert.equal(session.log.length, beforeLog, '失败不能留半条日志');
  assert.deepEqual(session.surface.nodes, beforeNodes);
  assert.equal(session.surface.replaceGeneration, 0);
  assert.equal(session.appendCalls, 1, '故障计数按「调用次数」算，与是否写入无关');
});

test('session: appendPluginRecord 写 ignorable 记录且不进 surface', () => {
  const session = baseSessionWithoutHeader();
  const seq = session.appendPluginRecord('plugin:compact-relay/compress-hint', { ratio: 0.25, at: 1 });
  assert.equal(seq, 0);
  assert.equal(session.log[0].type, 'plugin:compact-relay/compress-hint');
  assert.equal(session.log[0].ignorable, true);
  assert.deepEqual(session.log[0].data, { ratio: 0.25, at: 1 });
  assert.deepEqual(session.surface.nodes, []);
});

test('session: failAppendOn 第 N 次抛错 → 原子失败，之后的 append 继续可用', () => {
  const session = baseSessionWithoutHeader({ failAppendOn: 2 });
  session.append('compaction/start', { compactionId: 'c1' });
  assert.throws(() => session.append('compaction/summary', {}), /模拟 append 失败（第 2 次/u);
  assert.equal(session.log.length, 1, '抛错的 append 不写日志');
  const end = session.append('compaction/end', { compactionId: 'c1' });
  assert.equal(end.seq, 1, '失败的那次不占 seq');
  assert.equal(session.appendCalls, 3);

  // 数组形式：第 1、3 次失败。
  const scripted = baseSessionWithoutHeader({ failAppendOn: [1, 3] });
  assert.throws(() => scripted.append('user/message', {}), /第 1 次/u);
  scripted.append('user/message', {});
  assert.throws(() => scripted.append('user/message', {}), /第 3 次/u);
  assert.equal(scripted.log.length, 1);
});

test('session: 未闭合 compaction/start → 真实事务按 busy 拒绝并保留锁', async () => {
  const session = baseSession();
  session.append('compaction/start', { compactionId: 'open' });
  assert.deepEqual(entryState(session), { openTurn: false, lockActive: true, unmatchedStartSeq: 4 });
  await assert.rejects(runRealTransaction(session), (error) => error.code === 'busy');
  assert.equal(entryState(session).lockActive, true, 'busy 拒绝不能顺手关掉别人的锁');
  session.append('compaction/end', { compactionId: 'open' });
  assert.equal(entryState(session).lockActive, false);
});

/* ---------------- 真实替换事务 × fake session ---------------- */

test('transaction: fake session 上跑真实替换事务，append 顺序/sourceEventSeqs/surface 全对', async () => {
  const session = baseSession();
  const result = await runRealTransaction(session);
  assert.deepEqual(
    session.log.slice(4).map((event) => event.type),
    ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'],
  );
  assert.deepEqual(session.log[6].sourceEventSeqs, [4, 5, 1, 2], 'sourceEventSeqs 必须覆盖 start/summary 与全部被遮罩节点');
  assert.deepEqual(session.log[6].surfaceOp, { op: 'replace', startSeq: 1, endSeq: 2 });
  assert.deepEqual(session.surface.nodes, [0, 6, 3]);
  assert.equal(result.summarySeq, 5);
  assert.equal(result.replaceSeq, 6);
  assert.equal(countSummaries(session), 1, '提交成功的压缩要计数');
  assert.equal(entryState(session).lockActive, false);
});

test('transaction: 第 3 次 append（replace 提交）注入故障 → 补 end(error)，历史不动', async () => {
  const session = baseSession({ failAppendOn: 3 });
  await assert.rejects(runRealTransaction(session), /模拟 append 失败（第 3 次/u);
  assert.deepEqual(
    session.log.map((event) => event.type),
    ['system/message', 'user/message', 'assistant/message', 'user/message', 'compaction/start', 'compaction/summary', 'compaction/end'],
  );
  const end = session.log.at(-1);
  assert.equal(end.type, 'compaction/end');
  assert.notEqual(end.data.error, undefined, '必须补一条带 error 的 end（否则留下未闭合压缩锁）');
  assert.equal(entryState(session).lockActive, false);
  assert.deepEqual(session.surface.nodes, [0, 1, 2, 3], '提交失败不能改 surface');
  assert.equal(countSummaries(session), 0, 'summary + end(error) 不算已提交压缩（防幽灵计数）');
});

/* ---------------- 真实 engine 符号清单 ---------------- */

test('engine: 冻结符号清单（真实 engine ↔ fake engine ↔ lib 源码使用）', () => {
  assert.deepEqual(Object.keys(realEngine), ENGINE_SYMBOLS, '真实 engine 导出符号/顺序锁死；改 DSH 接缝需同步契约');
  assert.equal(Object.isFrozen(realEngine), true, '真实 engine 必须冻结');
  const fake = createFakeEngine();
  assert.deepEqual(Object.keys(fake), ENGINE_SYMBOLS);
  assert.equal(Object.isFrozen(fake), true, 'fake engine 必须冻结');
  for (const symbol of ENGINE_SYMBOLS) {
    assert.equal(typeof realEngine[symbol], 'function', `真实 engine.${symbol} 应是函数`);
    assert.equal(typeof fake[symbol], 'function', `fake engine.${symbol} 应是函数`);
    assert.equal(fake[symbol], realEngine[symbol], `fake engine.${symbol} 应与真实 engine 同实现（都来自 test/stubs）`);
  }
  assert.deepEqual(engineSymbolsUsedInLib(), [...ENGINE_SYMBOLS].sort(), 'lib 源码消费的 engine.* 必须都在清单内');
  assert.throws(() => createFakeEngine({ notASymbol: () => {} }), /未知 engine 符号/u);
});

test('engine: fake engine 每个符号的最小语义可用', () => {
  const engine = createFakeEngine();
  const source = engine.compactCheckpointSource('compaction-1', 'cmd-1');
  assert.deepEqual(source, { kind: 'compact-checkpoint', compactionId: 'compaction-1', sourceCommandId: 'cmd-1' });
  assert.deepEqual(engine.compactCheckpointSource('c'), { kind: 'compact-checkpoint', compactionId: 'c' });
  assert.equal(engine.isCompactCheckpointSource(source), true);
  assert.equal(engine.isCompactCheckpointSource({ kind: 'other' }), false);
  assert.equal(engine.isCompactCheckpointSource(null), false);
  assert.equal(engine.toolPairingBalancedBefore(), true);
  assert.equal(engine.toolPairingBalancedAfter(), true);

  const message = engine.createUserMessage({ content: [{ type: 'text', text: 'x' }], source });
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: 'x' }]);
  assert.deepEqual(engine.errorChain(new Error('boom')), { name: 'Error', message: 'boom' });
  assert.deepEqual(engine.errorChain('plain'), { name: 'Error', message: 'plain' });

  const session = baseSessionWithoutHeader();
  assert.equal(engine.appendPluginRecord(session, 'plugin:compact-relay/pin', { seqs: [1] }), 0);
  assert.equal(session.log[0].ignorable, true);

  const assembler = new engine.BlockAssembler();
  assembler.push({ type: 'text-delta', index: 0, text: 'he' });
  assembler.push({ type: 'text-delta', index: 0, text: 'llo' });
  assembler.push({ type: 'finish', reason: { kind: 'stop' } });
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(assembler.finish, { kind: 'stop' });

  assert.equal(engine.defineTool({ name: 't', execute: () => 'ok' }).name, 't');
  assert.throws(() => engine.defineTool({ name: '', execute: () => {} }));
});

/* ---------------- fake host / llm 语义 ---------------- */

test('host: createFakeHost 收注册结果，并提供 connection 鉴权替身', () => {
  const host = createFakeHost();
  assert.equal(host.ctx.webServer, undefined, '根 ctx 默认不带 webServer（headless 环境也要能加载）');
  host.ctx.commands.register({ name: 'cmd-x' });
  host.ctx.tools.register({ name: 'tool-x' });
  host.ctx.on('session/event', () => {});
  host.ctx.inject(['webServer', 'connection'], (child) => {
    child.webServer.register({ path: '/api/x', handler() {} });
  });
  assert.deepEqual(host.commands.map((definition) => definition.name), ['cmd-x']);
  assert.deepEqual(host.tools.map((definition) => definition.name), ['tool-x']);
  assert.deepEqual(host.eventHandlers.map((entry) => entry.name), ['session/event']);
  assert.deepEqual(host.routes.map((route) => route.path), ['/api/x']);

  host.setConnectionRejection(401);
  assert.equal(host.ctx.connection.requestRejection({}), 401);
  host.setConnectionRejection(403);
  assert.equal(host.ctx.connection.requestRejection({}), 403);
  host.setConnectionRejection(undefined);
  assert.equal(host.ctx.connection.requestRejection({}), undefined);
});

test('host: createPluginDeps 组装 cfg/lock/engine', () => {
  const engine = createFakeEngine();
  const deps = createPluginDeps({ ctx: {}, engine, handoffDir: '/tmp/contract-handoffs' });
  assert.equal(deps.cfg.handoffDir, '/tmp/contract-handoffs');
  assert.equal(deps.engine, engine);
  assert.equal(typeof deps.lock.tryAcquire, 'function');
  deps.lock.tryAcquire('s1');
  assert.equal(deps.lock.isBusy('s1'), true);
  deps.lock.release('s1');
  assert.equal(deps.lock.isBusy('s1'), false);
});

test('llm: 确定性文本流 + usage/finish reason 透传', async () => {
  const build = () =>
    createFakeLlm({
      contextWindow: 200_000,
      routes: [{ kind: 'summary', replies: [{ text: '固定回复' }] }],
    });
  const run = (llm) =>
    callStream({
      ctx: { llm },
      engine: createFakeEngine(),
      options: streamOptions(),
      retry: false,
    });
  const first = await run(build());
  const second = await run(build());
  assert.deepEqual(first.blocks(), second.blocks(), '同样脚本必须得到同样结果');
  assert.deepEqual(first.blocks(), [{ type: 'text', text: '固定回复' }]);
  assert.deepEqual(first.finish, { kind: 'stop' }, '正常结束的 finish 是 stop');
  assert.equal(first.usage, undefined);

  const truncated = createFakeLlm({ routes: [{ kind: 'x', replies: [{ text: '半截', finish: 'max-tokens' }] }] });
  const assembler = await run(truncated);
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: '半截' }]);
  assert.deepEqual(assembler.finish, { kind: 'max-tokens' }, 'finish reason 要原样透传（截断重试靠它判断）');
});

test('llm: reply 脚本按次消耗、最后一条复用；调用记录字段稳定', async () => {
  const llm = createFakeLlm({ routes: [{ kind: 'summary', replies: ['一', '二'] }] });
  const texts = [];
  for (let index = 0; index < 3; index += 1) {
    const assembler = await callStream({
      ctx: { llm },
      engine: createFakeEngine(),
      options: streamOptions(),
      retry: false,
    });
    texts.push(assembler.blocks()[0].text);
  }
  assert.deepEqual(texts, ['一', '二', '二']);
  assert.equal(llm.calls.length, 3);
  assert.deepEqual(
    llm.calls.map((call) => call.kind),
    ['summary', 'summary', 'summary'],
  );
  assert.equal(llm.calls[0].maxTokens, 64);
  assert.deepEqual(
    Object.keys(llm.calls[0]).sort(),
    ['kind', 'maxTokens', 'messages', 'reasoningEffort'],
    'llm.calls 字段与旧 record.llmCalls 一致，不多不少',
  );
  assert.equal(llm.callsOf('summary').length, 3);
});

test('llm: resolveModelInfo 区分是否支持 reasoning off', async () => {
  const withReasoning = createFakeLlm({ reasoningSupport: true });
  const info = await withReasoning.resolveModelInfo();
  assert.deepEqual(info.context, { contextWindow: 1_000_000 });
  assert.equal(info.reasoning.efforts.some((effort) => effort.id === 'off'), true);

  const without = createFakeLlm({ contextWindow: 200_000, reasoningSupport: false });
  const plain = await without.resolveModelInfo();
  assert.deepEqual(plain, { context: { contextWindow: 200_000 } });
});

test('llm: route.stream 卡住 + abort → callStream 归一为 cancelled', async () => {
  const llm = createFakeLlm({ routes: [{ kind: 'stuck', stream: createStuckStream() }] });
  const controller = new AbortController();
  const pending = callStream({
    ctx: { llm },
    engine: createFakeEngine(),
    options: streamOptions(),
    signal: controller.signal,
    timeoutMs: 5000,
    label: '契约调用',
    retry: false,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error) => error.code === 'cancelled');
});

/* ---------------- run ---------------- */

let passed = 0;
for (const [name, fn] of cases) {
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
