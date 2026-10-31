/**
 * 0.5.7 长动作异步化：job 表纯单测（15 条，不起 HTTP / 不碰真实 DSH）。
 *
 *   node test/jobs-unit.mjs
 *
 * 覆盖（架构 §1 / §7）：id 前缀与初态、同 key 复用、异 key busy、force 同 key 先取消旧任务、
 * force 异 key 仍 busy、settle TTL 与 sweep、上限淘汰、latest、cancel（running/已结束）、
 * close（卸载）、失败映射 error、launch 异步（setImmediate）与成功 result、
 * launch 后同 tick 取消/卸载不执行（M1）、never-settle 动作的 promise 结算（M3）。
 * 断言只依赖 lib/dsh/jobs.js 的公开契约，不读内部 Map。
 */
import assert from 'node:assert/strict';
import {
  JOB_ID_PREFIX,
  JOB_KINDS,
  JOB_MAX,
  JOB_TTL_MS,
  createJobTable,
  paramsDigestOf,
} from '../lib/dsh/jobs.js';

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/** 手动解析的 Promise（慢动作替身：由用例决定何时完成/失败）。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让出一次事件循环（launch 用 setImmediate）。 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 可控时钟 + 不起扫描 timer 的表（sweep 由用例显式调用）。 */
function makeTable(options = {}) {
  let clock = 1000;
  const table = createJobTable({ now: () => clock, sweepMs: 0, ...options });
  return {
    table,
    advance(ms) {
      clock += ms;
    },
  };
}

/** 慢动作替身：记录 run 收到的 {signal, jobId}。 */
function makeRun() {
  const gate = deferred();
  const calls = [];
  const run = ({ signal, jobId }) => {
    calls.push({ signal, jobId });
    return gate.promise;
  };
  return { run, calls, resolve: gate.resolve, reject: gate.reject };
}

test('U1 id 前缀 dcrjob- / 常量冻结 / 初始 running', () => {
  assert.equal(JOB_TTL_MS, 10 * 60_000);
  assert.equal(JOB_MAX, 50);
  assert.deepEqual([...JOB_KINDS], ['handoff-preview', 'handoff', 'compact']);
  assert.equal(JOB_ID_PREFIX, 'dcrjob-');
  const { table } = makeTable();
  const first = table.start({ kind: 'compact', sessionId: 's1', run: async () => 1 });
  const second = table.start({ kind: 'handoff', sessionId: 's1', run: async () => 2 });
  assert.equal(first.reused, false);
  assert.match(first.job.id, /^dcrjob-/u);
  assert.notEqual(first.job.id, second.job.id);
  assert.equal(first.job.status, 'running');
  assert.equal(table.get(first.job.id)?.status, 'running');
  assert.equal(table.list().length, 2);
  table.close();
});

test('U2 同 key running 复用；参数键顺序不影响幂等 key', () => {
  const { table } = makeTable();
  const first = table.start({
    kind: 'handoff',
    sessionId: 's1',
    params: { edits: { 约束: 'a', 下一步: 'b' }, archive: true },
    run: async () => 1,
  });
  const again = table.start({
    kind: 'handoff',
    sessionId: 's1',
    params: { archive: true, edits: { 下一步: 'b', 约束: 'a' } },
    run: async () => 2,
  });
  assert.equal(again.reused, true);
  assert.equal(again.job.id, first.job.id);
  assert.equal(table.list().length, 1);
  assert.equal(paramsDigestOf({ edits: { a: 1, b: 2 } }), paramsDigestOf({ edits: { b: 2, a: 1 } }));
  table.close();
});

test('U3 同 session+kind 不同 key + running → busy（不排队、不复用）', () => {
  const { table } = makeTable();
  const first = table.start({
    kind: 'handoff',
    sessionId: 's1',
    params: { edits: { 约束: 'a' } },
    run: async () => 1,
  });
  const second = table.start({
    kind: 'handoff',
    sessionId: 's1',
    params: { edits: { 约束: 'b' } },
    run: async () => 2,
  });
  assert.equal(second.busy, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(table.list().length, 1);
  // 不同 session 互不影响
  const other = table.start({ kind: 'handoff', sessionId: 's2', params: { edits: { 约束: 'a' } }, run: async () => 3 });
  assert.equal(other.busy, undefined);
  table.close();
});

test('U4 force 同 key：先 abort 旧 job（置 cancelled）再起新 job，不复用', async () => {
  const { table } = makeTable();
  const slow = makeRun();
  const first = table.start({ kind: 'handoff-preview', sessionId: 's1', params: {}, run: slow.run });
  table.launch(first.job.id);
  await flush();
  assert.equal(slow.calls.length, 1, '旧任务已经在跑');
  const forced = table.start({ kind: 'handoff-preview', sessionId: 's1', params: {}, force: true, run: async () => 2 });
  assert.equal(forced.reused, false, 'force 不复用旧 job');
  assert.notEqual(forced.job.id, first.job.id);
  assert.equal(table.list().length, 2);
  const old = table.get(first.job.id);
  assert.equal(old.status, 'cancelled', '旧 job 先被取消（force 不绕过并发闸）');
  assert.equal(old.error.code, 'cancelled');
  assert.equal(slow.calls[0].signal.aborted, true, '旧任务必须收到 abort');
  // 旧任务晚到的失败不能污染状态（仍是 cancelled）；新任务照常 running。
  slow.reject(slow.calls[0].signal.reason);
  await first.job.promise.catch(() => {});
  await flush();
  assert.equal(table.get(first.job.id).status, 'cancelled');
  assert.equal(table.get(forced.job.id).status, 'running');
  table.close();
});

test('U4b force 不绕过并发闸：同 session+kind 异 key + running → 仍 busy，且不取消旧 job', () => {
  const { table } = makeTable();
  const first = table.start({
    kind: 'handoff',
    sessionId: 's1',
    params: { edits: { 约束: 'a' } },
    run: async () => 1,
  });
  const forced = table.start({
    kind: 'handoff',
    sessionId: 's1',
    params: { edits: { 约束: 'b' } },
    force: true,
    run: async () => 2,
  });
  assert.equal(forced.busy, true);
  assert.equal(forced.job.id, first.job.id);
  assert.equal(table.list().length, 1);
  assert.equal(table.get(first.job.id).status, 'running', '异 key force 不能顺手取消旧任务');
  table.close();
});

test('U5 settle 后 ttlAt=endedAt+TTL；sweep 清 settled，running 永不 TTL', async () => {
  const { table, advance } = makeTable({ ttlMs: 100 });
  const done = table.start({ kind: 'compact', sessionId: 's1', run: async () => ({ ok: true }) });
  table.launch(done.job.id);
  assert.deepEqual(await done.job.promise, { ok: true });
  const settled = table.get(done.job.id);
  assert.equal(settled.status, 'done');
  assert.equal(settled.ttlAt, settled.endedAt + 100);
  assert.equal(settled.ttlAt - settled.startedAt >= 100, true);

  const running = table.start({ kind: 'handoff', sessionId: 's2', run: () => new Promise(() => {}) });
  table.launch(running.job.id);
  advance(101);
  assert.equal(table.sweep(), 1);
  assert.equal(table.get(done.job.id), null);
  assert.notEqual(table.get(running.job.id), null);
  table.close();
});

test('U6 超过上限先淘汰最旧的 settled；running 不淘汰', async () => {
  const { table } = makeTable({ max: 2 });
  const ids = [];
  for (const sessionId of ['s1', 's2', 's3']) {
    const started = table.start({ kind: 'compact', sessionId, run: async () => sessionId });
    table.launch(started.job.id);
    await started.job.promise;
    ids.push(started.job.id);
  }
  assert.equal(table.list().length, 2);
  assert.equal(table.get(ids[0]), null, '最旧的 settled 应被淘汰');
  assert.notEqual(table.get(ids[1]), null);
  assert.notEqual(table.get(ids[2]), null);
  table.close();
});

test('U7 latest(sessionId[, kind]) 取最新；无匹配 null', async () => {
  const { table, advance } = makeTable();
  const first = table.start({ kind: 'compact', sessionId: 's1', run: async () => 1 });
  table.launch(first.job.id);
  await first.job.promise;
  advance(10);
  const second = table.start({ kind: 'handoff', sessionId: 's1', run: async () => 2 });
  table.launch(second.job.id);
  await second.job.promise;
  advance(10);
  assert.equal(table.latest('s1', 'handoff').id, second.job.id);
  assert.equal(table.latest('s1').id, second.job.id);
  assert.equal(table.latest('s1', 'compact').id, first.job.id);
  assert.equal(table.latest('s9'), null);
  table.close();
});

test('U8 cancel running → cancelled + 中止信号（AbortError 原因）', async () => {
  const { table } = makeTable();
  const slow = makeRun();
  const started = table.start({ kind: 'handoff-preview', sessionId: 's1', run: slow.run });
  table.launch(started.job.id);
  await flush();
  assert.equal(slow.calls.length, 1);
  const outcome = table.cancel(started.job.id);
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.job.status, 'cancelled');
  assert.equal(outcome.job.error.code, 'cancelled');
  assert.equal(slow.calls[0].signal.aborted, true);
  assert.equal(slow.calls[0].signal.reason.name, 'AbortError');
  slow.reject(slow.calls[0].signal.reason);
  await started.job.promise.catch(() => {});
  await flush();
  assert.equal(table.get(started.job.id).status, 'cancelled', '取消后动作晚到的失败不能翻成 error');
  table.close();
});

test('U9 cancel 已结束 → cancelled:false、状态不变；不存在/非法 id → null', async () => {
  const { table } = makeTable();
  const started = table.start({ kind: 'compact', sessionId: 's1', run: async () => 'ok' });
  table.launch(started.job.id);
  await started.job.promise;
  const outcome = table.cancel(started.job.id);
  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.job.status, 'done');
  assert.equal(table.cancel('dcrjob-doesnotexist'), null);
  assert.equal(table.cancel(''), null);
  assert.equal(table.cancel(42), null);
  assert.equal(table.get('x'.repeat(81)), null);
  table.close();
});

test('U10 close abort 全部 running（置 cancelled 不置 error、幂等、清 timer）', async () => {
  const { table } = makeTable({ sweepMs: 5 });
  const slow = makeRun();
  const started = table.start({ kind: 'compact', sessionId: 's1', run: slow.run });
  table.launch(started.job.id);
  await flush();
  table.close();
  const view = table.get(started.job.id);
  assert.equal(view.status, 'cancelled');
  assert.equal(view.error.code, 'cancelled');
  assert.equal(view.error.message.includes('卸载'), true);
  assert.equal(slow.calls[0].signal.aborted, true);
  assert.throws(() => table.start({ kind: 'compact', sessionId: 's1', run: async () => 1 }), /已关闭/u);
  table.close(); // 重复卸载无害
  slow.reject(slow.calls[0].signal.reason);
  await started.job.promise.catch(() => {});
});

test('U11 动作抛错 → status error + {code,message}；launch 幂等', async () => {
  const { table } = makeTable();
  const boom = new Error('模型挂了');
  boom.code = 'llm';
  const started = table.start({
    kind: 'compact',
    sessionId: 's1',
    run: async () => {
      throw boom;
    },
  });
  assert.equal(table.launch(started.job.id), true);
  assert.equal(table.launch(started.job.id), false);
  await assert.rejects(() => started.job.promise, /模型挂了/u);
  const view = table.get(started.job.id);
  assert.equal(view.status, 'error');
  assert.deepEqual(view.error, { code: 'llm', message: '模型挂了' });
  assert.equal(view.result, null);
  table.close();
});

test('U12 launch 之前不执行；成功 → done/result；job.promise 拿得到同一个结果', async () => {
  const { table } = makeTable();
  let executed = 0;
  const started = table.start({
    kind: 'handoff-preview',
    sessionId: 's1',
    run: async ({ jobId }) => {
      executed += 1;
      return { ok: true, draft: '草稿', jobId };
    },
  });
  assert.equal(executed, 0, 'start 不能同步执行动作');
  table.launch(started.job.id);
  assert.equal(executed, 0, 'launch 用 setImmediate：调用栈内不执行');
  const result = await started.job.promise;
  assert.equal(executed, 1);
  assert.deepEqual(result, { ok: true, draft: '草稿', jobId: started.job.id });
  const view = table.get(started.job.id);
  assert.equal(view.status, 'done');
  assert.deepEqual(view.result, result);
  assert.equal(view.error, null);
  assert.equal(view.ttlAt >= view.endedAt, true);
  table.close();
});

test('U13 launch 后同 tick cancel/close → run 不执行，状态保持 cancelled（M1）', async () => {
  const { table } = makeTable();
  const slow = makeRun();
  const started = table.start({ kind: 'handoff-preview', sessionId: 's1', run: slow.run });
  assert.equal(table.launch(started.job.id), true);
  const outcome = table.cancel(started.job.id); // 同一个 tick，setImmediate 回调还没跑
  assert.equal(outcome.cancelled, true);
  await flush();
  assert.equal(slow.calls.length, 0, '已取消的任务不能再启动 run（否则副作用照跑）');
  assert.equal(table.get(started.job.id).status, 'cancelled', '不能因为 run 没跑就丢状态');

  const closeRun = makeRun();
  const closing = table.start({ kind: 'compact', sessionId: 's2', run: closeRun.run });
  assert.equal(table.launch(closing.job.id), true);
  table.close(); // 卸载同样发生在 setImmediate 之前
  await flush();
  assert.equal(closeRun.calls.length, 0, '表已关闭时 launch 的回调不能再启动 run');
  assert.equal(table.get(closing.job.id).status, 'cancelled');
});

test('U14 动作不响应 abort（never-settle）：cancel/close 后 job.promise 仍结算为 cancelled（M3）', async () => {
  const { table } = makeTable();
  const never = () => new Promise(() => {});
  const cancelled = table.start({ kind: 'handoff-preview', sessionId: 's1', run: never });
  table.launch(cancelled.job.id);
  await flush();
  table.cancel(cancelled.job.id);
  await assert.rejects(
    () => cancelled.job.promise,
    (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.code, 'cancelled');
      assert.equal(error.message, '任务已取消');
      return true;
    },
    'cancel 必须结清 compat 层 deferred，不能永久悬挂',
  );
  assert.equal(table.get(cancelled.job.id).status, 'cancelled');

  const closed = table.start({ kind: 'compact', sessionId: 's2', run: never });
  table.launch(closed.job.id);
  await flush();
  table.close();
  await assert.rejects(
    () => closed.job.promise,
    (error) => error.code === 'cancelled' && error.message.includes('卸载'),
    '卸载路径同样要结清 deferred',
  );
  assert.equal(table.get(closed.job.id).status, 'cancelled');
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
console.log(`\njobs-unit：${passed}/${cases.length} 通过`);
