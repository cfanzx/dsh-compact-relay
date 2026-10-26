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
import { PIN_RECORD_TYPE, latestPinnedSeqs } from '../lib/core/pins.js';
import { HANDOFF_SECTIONS } from '../lib/core/handoff-doc.js';
import { REQUIRED_SECTIONS } from '../lib/core/validate-summary.js';
import { archiveHandoffSource, handoffArchiveNoteOf, isSessionArchived, isSessionPinned } from '../lib/dsh/handoff-archive.js';
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

test('DCR-04 文案：归档成功提示用宿主真实标签「全部对话（显示已归档）」+「取消归档」', () => {
  const okNote = handoffArchiveNoteOf({ status: 'archived', archived: true });
  // 宿主侧栏没有「全部会话」这个视图（实测 dsh-client-ui-workspace 的 viewOptions 三选一：
  // 「隐藏已归档」「全部对话（显示已归档）」「仅显示已归档」；取消归档是会话行的动作文案）。
  assert.equal(okNote.includes('全部会话'), false, `宿主没有「全部会话」标签：${okNote}`);
  assert.ok(okNote.includes('全部对话（显示已归档）'), `应指向真实视图标签：${okNote}`);
  assert.ok(okNote.includes('取消归档'), `应给出真实动作文案「取消归档」：${okNote}`);
  assert.ok(okNote.includes('恢复旧会话'), '接力条恢复入口仍要提到');
  // 「此前已归档」文案不引用侧栏视图（当时就没有提，保持不动）。
  const alreadyNote = handoffArchiveNoteOf({ status: 'already', archived: true });
  assert.equal(alreadyNote.includes('全部会话'), false);
  assert.ok(alreadyNote.includes('恢复旧会话'));
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
test('archive pinned（测试盲区）：旧会话有锁定消息时照样归档，pin 记录不被改动', async () => {
  const session = baseSourceSession();
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1, 2], at: Date.now() });
  const { deps, record } = makeHandoffCtx();
  const result = await handoff(deps, { agent: createAgent(session), commandId: 'cmd-archive-pinned' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.archive, { status: 'archived', archived: true }, '有锁定消息不阻断自动归档（0.5.1 现状）');
  assert.deepEqual(record.archivedSessionIds, ['source-session']);
  // pin 是会话内 plugin record：归档只动 workspace registry，不读/不写/不删 pin。
  const pinEvents = session.log.filter((event) => event.type === PIN_RECORD_TYPE);
  assert.equal(pinEvents.length, 1, '归档不新增/不删除 pin 记录');
  assert.equal(latestPinnedSeqs(session.log).join(','), '1,2', '锁定集合原样保留（恢复旧会话后 pin 还在）');
  assert.equal(fs.existsSync(result.path), true, '归档不会连交接单一起删掉');
});

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
 * 0.5.1 批 2：归档开关 + 置顶保护
 * ------------------------------------------------------------------ */

test('归档开关：archive:false → 不归档，交接照常成功，message 明说旧会话仍在列表里', async () => {
  const { deps, record } = makeHandoffCtx();
  const result = await handoff(deps, {
    agent: createAgent(baseSourceSession()),
    commandId: 'cmd-no-archive',
    archive: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.archive, { status: 'skipped', archived: false });
  assert.equal(record.archiveCalls.length, 0, 'archive:false 时绝不能调用 archiveSession');
  assert.deepEqual(record.archivedSessionIds, []);
  assert.ok(result.message.includes('未归档'), result.message);
  assert.ok(result.message.includes('仍在列表里'), result.message);
  assert.equal(fs.existsSync(result.path), true, '不归档不影响交接单落盘');
});

test('归档开关：不传 archive → 默认仍自动归档（0.5.0 行为不变）', async () => {
  const { deps, record } = makeHandoffCtx();
  const result = await handoff(deps, { agent: createAgent(baseSourceSession()), commandId: 'cmd-default-archive' });
  assert.deepEqual(result.archive, { status: 'archived', archived: true });
  assert.equal(record.archiveCalls.length, 1);
});

test('置顶保护：旧会话在侧栏置顶且未确认 → 不归档（status=pinned），提示归档会取消置顶', async () => {
  const { deps, record } = makeHandoffCtx({ pinnedSessionIds: ['source-session'] });
  const result = await handoff(deps, { agent: createAgent(baseSourceSession()), commandId: 'cmd-pinned-skip' });

  assert.equal(result.ok, true, '置顶保护不能阻断交接');
  assert.deepEqual(result.archive, { status: 'pinned', archived: false });
  assert.equal(record.archiveCalls.length, 0, '未确认时绝不归档（归档会取消置顶）');
  assert.deepEqual(record.archivedSessionIds, []);
  assert.ok(result.message.includes('置顶'), result.message);
  assert.ok(result.message.includes('归档会取消置顶'), result.message);
  assert.ok(result.message.includes('未自动归档'), result.message);
  assert.ok(result.message.includes(result.childId), '置顶提示不能挤掉 childId');
});

test('置顶保护：用户确认「交接并归档」→ 才归档（归档同时会取消置顶）', async () => {
  const { deps, record } = makeHandoffCtx({ pinnedSessionIds: ['source-session'] });
  const result = await handoff(deps, {
    agent: createAgent(baseSourceSession()),
    commandId: 'cmd-pinned-confirmed',
    confirmUnpin: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.archive, { status: 'archived', archived: true });
  assert.equal(record.archiveCalls.length, 1);
  assert.deepEqual(record.archivedSessionIds, ['source-session']);
  assert.ok(result.message.includes('旧会话已归档'), result.message);
});

test('置顶保护：archive:false 优先 → 只交接，置顶保持不变（即使 confirmUnpin）', async () => {
  const { deps, record } = makeHandoffCtx({ pinnedSessionIds: ['source-session'] });
  const result = await handoff(deps, {
    agent: createAgent(baseSourceSession()),
    commandId: 'cmd-pinned-keep',
    archive: false,
    confirmUnpin: true,
  });

  assert.deepEqual(result.archive, { status: 'skipped', archived: false });
  assert.equal(record.archiveCalls.length, 0);
});

test('置顶保护接缝：isSessionPinned 读 registry.pinnedSessionIds；读不到 → null', () => {
  const pinnedCtx = { get: () => ({ pinnedSessionIds: ['a', 'b'] }) };
  assert.equal(isSessionPinned(pinnedCtx, 'a'), true);
  assert.equal(isSessionPinned(pinnedCtx, 'c'), false);
  assert.equal(isSessionPinned({ get: () => undefined }, 'a'), null, '宿主没有置顶集合时不能猜 false');
  assert.equal(isSessionPinned({ get: () => ({ pinnedSessionIds: 'nope' }) }, 'a'), null);
});

test('归档文案：skipped / pinned 分支各自说清后果，不冒充「归档失败」', () => {
  const skipped = handoffArchiveNoteOf({ status: 'skipped', archived: false });
  assert.ok(skipped.includes('未归档'), skipped);
  assert.ok(skipped.includes('仍在列表里'), skipped);
  assert.equal(skipped.includes('归档失败'), false);

  const pinned = handoffArchiveNoteOf({ status: 'pinned', archived: false });
  assert.ok(pinned.includes('置顶'), pinned);
  assert.ok(pinned.includes('归档会取消置顶'), pinned);
  assert.ok(pinned.includes('未自动归档'), pinned);
  assert.equal(pinned.includes('归档失败'), false);
});

test('HTTP handoff：archive:false 不归档旧会话；archive/confirmUnpin 类型错 → 400', async () => {
  const llm = createFakeLlm({
    reasoningSupport: true,
    routes: [
      { kind: 'handoff', match: ({ instruction }) => instruction.includes('交接文档'), replies: [handoffReply()] },
      { kind: 'summary', match: () => true, replies: [summaryReply()] },
    ],
  });
  const engine = createFakeEngine();
  const { ctx, record } = createHandoffHost({ llm, engine });
  const source = baseSourceSession();
  const agent = createAgent(source);
  const originalAgents = ctx.agents;
  ctx.agents = { ...originalAgents, get: (id) => (id === agent.id ? agent : undefined), list: () => [agent] };

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
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-archive-http-') });
  registerHttp(webCtx, deps);
  const route = routes.find((entry) => entry.path === '/api/compact-relay-action');

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
    route.handler(
      {
        method: 'POST',
        url: '/api/compact-relay-action',
        headers: {},
        on(event, handler) {
          if (event === 'data') handler(Buffer.from(JSON.stringify(body)));
          if (event === 'end') handler();
        },
      },
      res,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { status: res.status, json: JSON.parse(res.body) };
  }

  const ok = await post({ action: 'handoff', sessionId: 'source-session', archive: false });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.ok, true);
  assert.equal(record.archiveCalls.length, 0, 'HTTP archive:false 不能归档旧会话');
  assert.ok(String(ok.json.message).includes('未归档'), ok.json.message);

  const badArchive = await post({ action: 'handoff', sessionId: 'source-session', archive: 'yes' });
  assert.equal(badArchive.status, 400);
  assert.ok(String(badArchive.json.message).includes('archive'), badArchive.json.message);

  const badConfirm = await post({ action: 'handoff', sessionId: 'source-session', confirmUnpin: 'yes' });
  assert.equal(badConfirm.status, 400);
  assert.ok(String(badConfirm.json.message).includes('confirmUnpin'), badConfirm.json.message);
});

test('客户端产物：置顶确认、归档开关、pin 失效标注、原生压缩预警都在源码/构建产物里', () => {
  const indicator = fs.readFileSync(`${repoRoot}lib/client/30-indicator.js`, 'utf8');
  assert.ok(indicator.includes('data-cr-handoff-archive'), '交接预览要有归档开关');
  assert.ok(indicator.includes('data-cr-handoff-pinned-warning'), '置顶会话要有确认提示');
  assert.ok(indicator.includes('交接并归档（取消置顶）'), '置顶确认要明确取消置顶');
  assert.ok(indicator.includes('只交接，保留置顶'), '取消归档选项要保留置顶');
  assert.ok(indicator.includes('data-cr-pins-stale'), '指示灯要暴露 pin 失效率');
  assert.ok(indicator.includes('随原生压缩移除'), '失效 pin 要标明是原生压缩移除的');
  assert.ok(indicator.includes('原生压缩预计覆盖'), '要提前提示原生压缩会覆盖 pin');
  assert.ok(indicator.includes('交接后会默认自动归档旧会话'), 'onboarding 要提出自动归档行为');
  assert.ok(indicator.includes('可取消勾选'), 'onboarding 要说明自动归档可关闭');
  // 0.5.1 设计定稿：环只表达容量，pin 位置块不再渲染；marks 数据读取保留（0.6 时间线用）。
  assert.ok(!indicator.includes('data-cr-pin-mark'), '环上不再出现 pin 位置块（位置标记归 0.6 时间线）');
  assert.ok(indicator.includes('位置标记归 0.6 时间线'), '源码要注明 marks 归 0.6 时间线');
  assert.ok(indicator.includes('marks: Array.isArray(data.pins.marks)'), 'pins.marks 数据读取要保留（0.6 时间线用）');

  const bundle = fs.readFileSync(`${repoRoot}lib/client.js`, 'utf8');
  for (const markerText of ['data-cr-handoff-archive', '交接并归档（取消置顶）', '随原生压缩移除', '原生压缩预计覆盖', '位置标记归 0.6 时间线']) {
    assert.ok(bundle.includes(markerText), `构建产物缺少：${markerText}`);
  }
  assert.ok(!bundle.includes('data-cr-pin-mark'), '构建产物也不应再有 pin 位置块');
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
