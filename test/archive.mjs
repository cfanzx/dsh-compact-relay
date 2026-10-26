/**
 * 0.5.0：交接成功后自动归档旧会话 + 恢复入口 —— 单测。
 *
 *   node test/archive.mjs
 *
 * 覆盖两层：
 *   1. dsh 接缝 `lib/dsh/handoff-archive.js`：归档参数（绝不带 stopActivity）、
 *      已归档幂等、活跃会话有限重试后降级、失败不抛；归档文案；
 *   2. 业务编排：handoff 在子会话/改名/落盘之后自动归档，成功/失败/活跃/无接口
 *      都不阻断交接；旧链（handoff-n）同样归档；recover 动作幂等；HTTP recover
 *      路由不要求活 agent；客户端产物/源码里有恢复入口。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { handoff } from '../lib/actions/handoff.js';
import { recoverArchivedSession } from '../lib/actions/recover.js';
import { registerHttp } from '../lib/adapters/http.js';
import { RELAY_RECORD_TYPE } from '../lib/core/relay.js';
import { HANDOFF_SECTIONS } from '../lib/core/handoff-doc.js';
import { REQUIRED_SECTIONS } from '../lib/core/validate-summary.js';
import { archiveHandoffSource, handoffArchiveNoteOf, isSessionArchived } from '../lib/dsh/handoff-archive.js';
import {
  createAgent,
  createFakeEngine,
  createHandoffHost,
  createPluginDeps,
  createTmpDir,
} from './harness/host.mjs';
import { createFakeLlm } from './harness/llm.mjs';
import { MockSession, baseSourceSession } from './harness/session.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function summaryReply() {
  return REQUIRED_SECTIONS.map((section) => `${section}\n- ${section}：根据本轮变更记录关键结论与证据`).join('\n');
}

function handoffReply() {
  return HANDOFF_SECTIONS.map((section) => `## ${section}\n- ${section}的内容：完成验证、记录结论并标注下一步`).join('\n');
}

function makeHandoffCtx(hostOptions = {}) {
  const llm = createFakeLlm({
    reasoningSupport: true,
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
  const { ctx, record } = createHandoffHost({ llm, engine, ...hostOptions });
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-archive-') });
  return { ctx, engine, record, deps, llm };
}

/** 只提供归档接缝的极简 ctx。 */
function archiveCtx({ archivedSessionIds = [], archiveSession, unarchiveSession } = {}) {
  return {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined;
      return {
        archivedSessionIds,
        ...(archiveSession === undefined ? {} : { archiveSession }),
        ...(unarchiveSession === undefined ? {} : { unarchiveSession }),
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 1. dsh 接缝
 * ------------------------------------------------------------------ */

test('归档接缝：成功调用 archiveSession(id)，绝不传 stopActivity', async () => {
  const calls = [];
  const ctx = archiveCtx({
    async archiveSession(sessionId, options) {
      calls.push({ sessionId, options });
    },
  });
  const result = await archiveHandoffSource(ctx, 'session-old', { attempts: 1 });
  assert.deepEqual(result, { status: 'archived', archived: true, activityKinds: [] });
  assert.deepEqual(calls, [{ sessionId: 'session-old', options: undefined }], '只传 sessionId，不传第二个参数');
  assert.equal(calls[0].options?.stopActivity, undefined, '自动归档绝不能 stopActivity');
});

test('归档接缝：已在归档集合 → already，幂等且不重复写盘', async () => {
  let called = 0;
  const ctx = archiveCtx({
    archivedSessionIds: ['session-old'],
    async archiveSession() {
      called += 1;
    },
  });
  const result = await archiveHandoffSource(ctx, 'session-old', { attempts: 2, delayMs: 1 });
  assert.deepEqual(result, { status: 'already', archived: true, activityKinds: [] });
  assert.equal(called, 0, '已归档时不应再调 archiveSession');
});

test('归档接缝：宿主没有 registry → unavailable，不抛错', async () => {
  const result = await archiveHandoffSource({ get: () => undefined }, 'session-old');
  assert.deepEqual(result, { status: 'unavailable', archived: false, activityKinds: [] });
});

test('归档接缝：活跃会话有限重试后降级 active，不自动停止任务', async () => {
  let called = 0;
  const optionsSeen = [];
  const ctx = archiveCtx({
    async archiveSession(_sessionId, options) {
      called += 1;
      optionsSeen.push(options);
      const error = new Error("cannot archive session 'session-old': the session is active (turn)");
      error.name = 'WorkspaceActiveSessionError';
      error.activity = [{ kind: 'turn' }, { kind: 'job', items: [{ id: 'job-1', label: '跑测试' }] }];
      throw error;
    },
  });
  const warnings = [];
  const result = await archiveHandoffSource(ctx, 'session-old', {
    attempts: 2,
    delayMs: 1,
    log: { warn: (message) => warnings.push(message) },
  });
  assert.deepEqual(result, { status: 'active', archived: false, activityKinds: ['turn', 'job'] });
  assert.equal(called, 2, '默认对收尾中的 turn 重试一次');
  assert.equal(optionsSeen.every((options) => options?.stopActivity === undefined), true, '重试也不能 stopActivity');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('不自动停止任务'), '日志要说明为什么保留旧会话可见');
});

test('归档接缝：活跃错误后 turn 收尾 → 重试成功 archived', async () => {
  let called = 0;
  const ctx = archiveCtx({
    async archiveSession() {
      called += 1;
      if (called === 1) {
        const error = new Error('session is active');
        error.code = 'workspace/session-active';
        error.activity = [{ kind: 'turn' }];
        throw error;
      }
    },
  });
  const result = await archiveHandoffSource(ctx, 'session-old', { attempts: 2, delayMs: 1 });
  assert.deepEqual(result, { status: 'archived', archived: true, activityKinds: [] });
  assert.equal(called, 2, 'turn 收尾后重试应成功');
});

test('归档接缝：写盘异常 → failed，不抛错；文案固定「归档失败，不影响交接」', async () => {
  const ctx = archiveCtx({
    async archiveSession() {
      throw new Error('disk is full');
    },
  });
  const result = await archiveHandoffSource(ctx, 'session-old', { attempts: 1 });
  assert.deepEqual(result, { status: 'failed', archived: false, activityKinds: [] });
  for (const status of ['failed', 'unknown', 'unavailable', 'active']) {
    const note = handoffArchiveNoteOf({ status, archived: false, activityKinds: ['turn'] });
    assert.ok(note.includes('归档失败，不影响交接'), `${status} 的文案应包含固定短语：${note}`);
  }
  const okNote = handoffArchiveNoteOf({ status: 'archived', archived: true });
  assert.ok(okNote.includes('旧会话已归档'));
  assert.ok(okNote.includes('恢复旧会话'), '成功文案必须告诉用户恢复入口');
});

/* ------------------------------------------------------------------ *
 * 2. 交接编排
 * ------------------------------------------------------------------ */

test('交接成功：改名/落盘之后自动归档旧会话，返回 message 带恢复入口', async () => {
  const { deps, record } = makeHandoffCtx();
  const result = await handoff(deps, { agent: createAgent(baseSourceSession()), commandId: 'cmd-archive-ok' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.archive, { status: 'archived', archived: true });
  assert.deepEqual(record.archivedSessionIds, ['source-session'], '旧会话应进入 registry 归档集合');
  assert.equal(record.archiveCalls.length, 1);
  assert.deepEqual(record.archiveCalls[0], { sessionId: 'source-session', options: {} });
  assert.equal(record.archiveCalls[0].options.stopActivity, undefined, '交接流程也不能自动停止旧会话任务');
  // 顺序：新链先 rename「历史 N」，再归档；archive 发生时标题已经改好。
  assert.equal(record.renames.at(-1)?.title.startsWith('历史 1：'), true);
  assert.ok(result.message.includes('旧会话已归档'), result.message);
  assert.ok(result.message.includes('恢复旧会话'), result.message);
  assert.ok(result.message.includes(result.childId), '归档提示不能挤掉 childId');
  assert.equal(fs.existsSync(result.path), true, '归档失败/成功都不能删交接单');
});

test('交接成功但归档失败：交接照常成功，message 明说「归档失败，不影响交接」', async () => {
  const { deps, record } = makeHandoffCtx({ archiveBroken: true });
  const result = await handoff(deps, { agent: createAgent(baseSourceSession()), commandId: 'cmd-archive-fail' });

  assert.equal(result.ok, true, '归档失败绝不能阻断交接');
  assert.deepEqual(result.archive, { status: 'failed', archived: false });
  assert.equal(typeof result.childId, 'string');
  assert.equal(fs.existsSync(result.path), true);
  assert.ok(result.message.includes('归档失败，不影响交接'), result.message);
  assert.ok(result.message.includes('旧会话仍在列表里'), result.message);
  assert.equal(record.archivedSessionIds.includes('source-session'), false);
});

test('交接成功但旧会话仍活跃：不杀任务，有限重试后降级并提示任务族', async () => {
  const { deps, record } = makeHandoffCtx({ archiveActive: [{ kind: 'turn' }] });
  const result = await handoff(deps, { agent: createAgent(baseSourceSession()), commandId: 'cmd-archive-active' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.archive, { status: 'active', archived: false });
  assert.equal(record.archiveCalls.length, 2, '活跃时默认重试一次');
  assert.equal(
    record.archiveCalls.every((call) => call.options.stopActivity === undefined),
    true,
    '任何一次都不能自动 stopActivity',
  );
  assert.ok(result.message.includes('归档失败，不影响交接'), result.message);
  assert.ok(result.message.includes('仍有任务在跑：turn'), result.message);
});

test('交接成功但宿主没有归档接口：降级不归档，交接照常完成', async () => {
  const { deps } = makeHandoffCtx({ registryMissing: true });
  const result = await handoff(deps, { agent: createAgent(baseSourceSession()), commandId: 'cmd-archive-missing' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.archive, { status: 'unavailable', archived: false });
  assert.ok(result.message.includes('没有 workspace 归档接口'), result.message);
  assert.ok(result.message.includes('归档失败，不影响交接'), result.message);
});

test('旧链（handoff-n）：标题逻辑不动，但旧会话同样自动归档', async () => {
  const source = baseSourceSession({
    events: [
      {
        type: RELAY_RECORD_TYPE,
        ignorable: true,
        data: {
          parentId: 'previous-parent',
          childId: 'previous-child',
          ordinal: 1,
          baseTitle: '旧链标题',
          scheme: 'handoff-n',
          at: 1,
          atIso: '2026-10-26T00:00:00+08:00',
        },
      },
    ],
  });
  const { deps, record } = makeHandoffCtx();
  const result = await handoff(deps, { agent: createAgent(source), commandId: 'cmd-archive-old-chain' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.archive, { status: 'archived', archived: true });
  assert.deepEqual(record.archivedSessionIds, ['source-session']);
  assert.equal(
    record.renames.some((rename) => rename.sessionId === 'source-session'),
    false,
    '旧链不改旧会话标题（命名反转只作用于 history-n；子会话的 rename 不算）',
  );
  assert.ok(result.message.includes('旧会话已归档'), result.message);
});

/* ------------------------------------------------------------------ *
 * 3. 恢复动作 / HTTP
 * ------------------------------------------------------------------ */

test('recover：从归档集合移除旧会话，并回报剩余集合', async () => {
  const archived = new Set(['session-old', 'session-other']);
  const calls = [];
  const ctx = {
    get: () => ({
      get archivedSessionIds() {
        return [...archived];
      },
      async unarchiveSession(sessionId) {
        calls.push(sessionId);
        archived.delete(sessionId);
      },
    }),
  };
  assert.equal(isSessionArchived(ctx, 'session-old'), true);
  const result = await recoverArchivedSession({ ctx, log: { warn() {} } }, { sessionId: 'session-old' });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.deepEqual(calls, ['session-old']);
  assert.deepEqual(result.archivedSessionIds, ['session-other']);
  assert.ok(result.message.includes('已恢复旧会话'));
});

test('recover：本来就没归档 → recovered=false（幂等 no-op，不报错）', async () => {
  const calls = [];
  const ctx = {
    get: () => ({
      archivedSessionIds: [],
      async unarchiveSession(sessionId) {
        calls.push(sessionId);
      },
    }),
  };
  const result = await recoverArchivedSession({ ctx }, { sessionId: 'session-clean' });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, false);
  assert.deepEqual(calls, ['session-clean']);
  assert.ok(result.message.includes('本来就没有归档'));
});

test('recover：宿主没有恢复接口 → 可读失败（code=recover）', async () => {
  await assert.rejects(
    () => recoverArchivedSession({ ctx: { get: () => undefined } }, { sessionId: 'session-old' }),
    (error) => error.code === 'recover' && error.message.includes('没有 Workspace 归档恢复接口'),
  );
});

test('HTTP recover：不需要活 agent，200 返回恢复结果', async () => {
  const routes = [];
  const webCtx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    effect() {},
    connection: { requestRejection: () => undefined },
  };
  const archived = new Set(['session-old']);
  const deps = {
    ctx: {
      get: () => ({
        get archivedSessionIds() {
          return [...archived];
        },
        async unarchiveSession(sessionId) {
          archived.delete(sessionId);
        },
      }),
    },
  };
  registerHttp(webCtx, deps);
  const route = routes.find((entry) => entry.path === '/api/compact-relay-action');
  assert.ok(route !== undefined, 'action 路由应已注册');

  async function post(body) {
    const res = {
      status: undefined,
      body: '',
      writeHead(status) {
        this.status = status;
      },
      end(payload) {
        this.body = payload ?? '';
      },
    };
    const req = {
      method: 'POST',
      url: '/api/compact-relay-action',
      headers: {},
      on(event, handler) {
        if (event === 'data') handler(Buffer.from(JSON.stringify(body)));
        if (event === 'end') handler();
      },
    };
    route.handler(req, res);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: res.status, json: JSON.parse(res.body) };
  }

  const ok = await post({ action: 'recover', sessionId: 'session-old' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.recovered, true);
  assert.equal(archived.has('session-old'), false);

  const missing = await post({ action: 'recover' });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.ok, false);
});

test('客户端/服务端产物：恢复入口与 recover 动作真的在源码/构建产物里', () => {
  const httpSource = fs.readFileSync(`${repoRoot}lib/adapters/http.js`, 'utf8');
  assert.ok(httpSource.includes("parsed.action !== 'native-auto' && parsed.action !== 'recover'"));
  assert.ok(httpSource.includes("parsed.action === 'recover'"));
  assert.ok(httpSource.includes('recoverArchivedSession'));

  const bundle = fs.readFileSync(`${repoRoot}lib/client.js`, 'utf8');
  assert.ok(bundle.includes('恢复旧会话'));
  assert.ok(bundle.includes("action: 'recover'"));
  assert.ok(bundle.includes('data-cr-relay-parent-archived'));
  assert.ok(bundle.includes('uiWorkspace?.unarchiveSession'));
  assert.ok(bundle.includes('unarchiveSession(target)'));
});

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
for (const [name, fn] of cases) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL  ${name}`);
  }
}

console.log(`\narchive：${passed}/${cases.length} 通过`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}\n${failure.error && failure.error.stack ? failure.error.stack : failure.error}`);
  }
  process.exit(1);
}
