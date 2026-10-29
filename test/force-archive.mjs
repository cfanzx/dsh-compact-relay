/**
 * 0.5.2 L 项：强制归档旧会话（显式二次确认 + stopActivity 透传 + 失败不静默）。
 *
 *   node test/force-archive.mjs
 *
 * 锁住五层：
 *   1. 动作层 `forceArchiveSession`：confirmStop 是唯一凭证；只有它才把
 *      `{stopActivity:true}` 传给 `workspaceRegistry.archiveSession`；已归档幂等；
 *      置顶要单独确认（否则 pinned + 现有置顶文案）；失败抛可读错误。
 *   2. HTTP `action:'force-archive'`：不要求活 agent（旧会话通常没有）、缺
 *      confirmStop → 400 且不碰 registry、成功回 status/note、失败回具体原因。
 *   3. `readState`：`capabilities.forceArchive` 与 `parentPinned` 两个 additive 字段。
 *   4. 默认不强制：交接的自动归档仍然**不带** stopActivity（0.5.0/0.5.1 行为不变）。
 *   5. 静态守卫：生产代码里唯一传 `stopActivity: true` 的地方是 `actions/force-archive.js`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forceArchiveSession } from '../lib/actions/force-archive.js';
import { handoff } from '../lib/actions/handoff.js';
import { readState } from '../lib/actions/state.js';
import { createLock } from '../lib/actions/lock.js';
import { resolveConfig } from '../lib/config.js';
import { registerHttp } from '../lib/adapters/http.js';
import { HANDOFF_SECTIONS } from '../lib/core/handoff-doc.js';
import { RELAY_RECORD_TYPE } from '../lib/core/relay.js';
import { REQUIRED_SECTIONS } from '../lib/core/validate-summary.js';
import { localIso } from '../lib/dsh/diag-counters.js';
import { createAgent, createFakeEngine, createHandoffHost, createPluginDeps, createTmpDir } from './harness/host.mjs';
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

/**
 * 只提供归档接缝的极简 ctx（与 `dsh/handoff-archive.js` 读的宿主形状一致）。
 * @param {{archived?:string[], pinned?:string[], archiveSession?:Function}} [options]
 */
function archiveCtx({ archived = [], pinned = [], archiveSession } = {}) {
  const archivedSet = new Set(archived);
  const pinnedSet = new Set(pinned);
  const calls = [];
  return {
    calls,
    archivedSet,
    pinnedSet,
    ctx: {
      get(name) {
        if (name !== 'workspaceRegistry') return undefined;
        return {
          get archivedSessionIds() {
            return [...archivedSet];
          },
          get pinnedSessionIds() {
            return [...pinnedSet];
          },
          async archiveSession(sessionId, options) {
            calls.push({ sessionId, options });
            if (typeof archiveSession === 'function') await archiveSession({ sessionId, options, archivedSet, pinnedSet });
            else {
              archivedSet.add(sessionId);
              pinnedSet.delete(sessionId);
            }
          },
        };
      },
    },
  };
}

function summaryReply() {
  return REQUIRED_SECTIONS.map((section) => `${section}\n- ${section}：根据本轮变更记录关键结论与证据`).join('\n');
}

function handoffReply() {
  return HANDOFF_SECTIONS.map((section) => `## ${section}\n- ${section}的内容：完成验证、记录结论并标注下一步`).join('\n');
}

function makeHandoffCtx() {
  const llm = createFakeLlm({
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
  const { ctx, record } = createHandoffHost({ llm, engine });
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-force-archive-') });
  return { deps, record };
}

/* ------------------------------------------------------------------ *
 * 1. 动作层：stopActivity 只在用户确认后传
 * ------------------------------------------------------------------ */

test('强制归档：confirmStop:true → archiveSession(id,{stopActivity:true})，文案沿用「旧会话已归档」', async () => {
  const fixture = archiveCtx();
  const result = await forceArchiveSession(
    { ctx: fixture.ctx, log: { warn() {} } },
    { sessionId: 'session-old', confirmStop: true },
  );

  assert.deepEqual(fixture.calls, [{ sessionId: 'session-old', options: { stopActivity: true } }], '必须且只在这一条路径传 stopActivity');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'archived');
  assert.equal(result.archived, true);
  // 0.5.3 P3-a：响应只回数量 + 本次新归档 id，不再回全量归档集合。
  assert.equal(result.archivedCount, 1);
  assert.deepEqual(result.newlyArchived, ['session-old']);
  assert.equal(result.archivedSessionIds, undefined, '全量 archivedSessionIds 必须不再下发（142 条 ≈ 7KB）');
  assert.ok(result.note.includes('旧会话已归档'), result.note);
  assert.ok(result.note.includes('恢复旧会话'), '成功文案必须告诉用户恢复入口');
  assert.equal(fixture.archivedSet.has('session-old'), true);
});

test('强制归档：没有 confirmStop 一律拒绝（默认不强制），根本不碰 registry', async () => {
  for (const confirmStop of [undefined, false, 'true', 1]) {
    const fixture = archiveCtx();
    await assert.rejects(
      () => forceArchiveSession({ ctx: fixture.ctx }, { sessionId: 'session-old', confirmStop }),
      (error) =>
        error.code === 'force-archive' &&
        error.message.includes('会停止旧会话上正在跑的任务') &&
        error.message.includes('显式确认'),
      `confirmStop=${String(confirmStop)} 必须被拒绝`,
    );
    assert.deepEqual(fixture.calls, [], `confirmStop=${String(confirmStop)} 不能调用 archiveSession`);
  }
});

test('强制归档：缺少 sessionId → 可读错误（code=force-archive）', async () => {
  await assert.rejects(
    () => forceArchiveSession({ ctx: archiveCtx().ctx }, { confirmStop: true }),
    (error) => error.code === 'force-archive' && error.message.includes('缺少要强制归档的会话 id'),
  );
});

test('强制归档：已归档 + 显式确认 → already，并补跑一次 stopActivity 兜底（P2-下 防漏杀）', async () => {
  const fixture = archiveCtx({ archived: ['session-old'] });
  const result = await forceArchiveSession(
    { ctx: fixture.ctx },
    { sessionId: 'session-old', confirmStop: true },
  );
  // 用户明确点了「强制归档」：即使已在集合里，也补停一次任务，避免归档前残留任务漏杀。
  assert.deepEqual(fixture.calls, [{ sessionId: 'session-old', options: { stopActivity: true } }]);
  assert.equal(result.status, 'already');
  assert.equal(result.archived, true);
  assert.equal(result.stopActivity, 'done');
  assert.deepEqual(result.newlyArchived, []);
  assert.ok(result.note.includes('此前已在归档中'), result.note);
  assert.ok(result.note.includes('补停'), result.note);
});

test('强制归档：已归档 + 没带确认 → already（200 语义），且明确「本次未执行 stopActivity」', async () => {
  const fixture = archiveCtx({ archived: ['session-old'] });
  const result = await forceArchiveSession({ ctx: fixture.ctx }, { sessionId: 'session-old' });
  assert.deepEqual(fixture.calls, [], '没确认时不能停任务');
  assert.equal(result.status, 'already');
  assert.equal(result.stopActivity, 'skipped');
  assert.ok(result.note.includes('未执行 stopActivity'), result.note);
});

test('强制归档：旧会话置顶且未确认 → pinned（不归档、不取消置顶），文案带「归档会取消置顶」', async () => {
  const fixture = archiveCtx({ pinned: ['session-old'] });
  const warnings = [];
  const result = await forceArchiveSession(
    { ctx: fixture.ctx, log: { warn: (message) => warnings.push(message) } },
    { sessionId: 'session-old', confirmStop: true },
  );
  assert.deepEqual(fixture.calls, [], '未确认取消置顶前不能归档（宿主会在同一笔写盘里 unpin）');
  assert.equal(result.status, 'pinned');
  assert.equal(result.archived, false);
  assert.ok(result.note.includes('归档会取消置顶'), result.note);
  assert.equal(warnings.length, 1);
});

test('强制归档：置顶已确认（confirmUnpin:true）→ 正常归档（stopActivity 仍透传）', async () => {
  const fixture = archiveCtx({ pinned: ['session-old'] });
  const result = await forceArchiveSession(
    { ctx: fixture.ctx },
    { sessionId: 'session-old', confirmStop: true, confirmUnpin: true },
  );
  assert.deepEqual(fixture.calls, [{ sessionId: 'session-old', options: { stopActivity: true } }]);
  assert.equal(result.status, 'archived');
  assert.equal(fixture.pinnedSet.has('session-old'), false, '归档后宿主会取消置顶');
});

test('强制归档：宿主没有 archiveSession → 可读错误，不静默', async () => {
  await assert.rejects(
    () => forceArchiveSession({ ctx: { get: () => undefined } }, { sessionId: 'session-old', confirmStop: true }),
    (error) => error.code === 'force-archive' && error.message.includes('没有 Workspace 归档接口'),
  );
});

test('强制归档：宿主抛错 → 可读错误带具体原因（code=force-archive，不吞）', async () => {
  const fixture = archiveCtx({
    archiveSession() {
      throw new Error('stop failed: job runner is gone');
    },
  });
  const warnings = [];
  await assert.rejects(
    () => forceArchiveSession({ ctx: fixture.ctx, log: { warn: (message) => warnings.push(message) } }, { sessionId: 'session-old', confirmStop: true }),
    (error) =>
      error.code === 'force-archive' &&
      error.message.includes('强制归档失败') &&
      error.message.includes('job runner is gone'),
  );
  assert.equal(warnings.length, 1, '失败要写插件日志');
});

test('强制归档：宿主找不到该会话 → 文案明确「找不到这个会话」', async () => {
  const fixture = archiveCtx({
    archiveSession() {
      const error = new Error('unknown session session-old');
      error.name = 'WorkspaceUnknownSessionError';
      throw error;
    },
  });
  await assert.rejects(
    () => forceArchiveSession({ ctx: fixture.ctx }, { sessionId: 'session-old', confirmStop: true }),
    (error) => error.code === 'force-archive' && error.message.includes('找不到这个会话'),
  );
});

/* ------------------------------------------------------------------ *
 * 2. HTTP：不要求活 agent、缺确认 400、失败回具体原因
 * ------------------------------------------------------------------ */

function registerActionRoute(deps) {
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
  registerHttp(webCtx, deps);
  const route = routes.find((entry) => entry.path === '/api/compact-relay-action');
  assert.ok(route !== undefined, 'action 路由应已注册');
  return route;
}

function postOf(route) {
  return async function post(body) {
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
  };
}

test('HTTP force-archive：不需要活 agent（旧会话通常没有），200 回 status/note', async () => {
  // deps 里没有 agents/sessions 服务：只要请求走了 resolveTarget 就会 409「没有活动会话」。
  const fixture = archiveCtx();
  const route = registerActionRoute({ ctx: fixture.ctx, log: { warn() {} } });
  const post = postOf(route);

  const ok = await post({ action: 'force-archive', sessionId: 'session-old', confirmStop: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.status, 'archived');
  assert.ok(ok.json.note.includes('旧会话已归档'));
  assert.deepEqual(fixture.calls, [{ sessionId: 'session-old', options: { stopActivity: true } }]);
});

test('HTTP force-archive：缺 confirmStop → 400 且不碰 registry（二次确认是硬门槛）', async () => {
  const fixture = archiveCtx();
  const route = registerActionRoute({ ctx: fixture.ctx });
  const post = postOf(route);

  const missing = await post({ action: 'force-archive', sessionId: 'session-old' });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.code, 'force-archive');
  assert.ok(missing.json.message.includes('会停止旧会话上正在跑的任务'), missing.json.message);

  const wrongType = await post({ action: 'force-archive', sessionId: 'session-old', confirmStop: 'yes' });
  assert.equal(wrongType.status, 400);
  assert.ok(wrongType.json.message.includes('confirmStop 必须是 true/false'), wrongType.json.message);

  assert.deepEqual(fixture.calls, [], '没确认时一次都不能调 archiveSession');
});

test('HTTP force-archive：缺 sessionId → 400（动作层校验）', async () => {
  const route = registerActionRoute({ ctx: archiveCtx().ctx });
  const post = postOf(route);
  const missing = await post({ action: 'force-archive', confirmStop: true });
  assert.equal(missing.status, 400);
  assert.ok(missing.json.message.includes('缺少要强制归档的会话 id'), missing.json.message);
});

test('HTTP force-archive：已归档 + 没带 confirmStop → 200 already（P2-1 不再先 400）', async () => {
  const fixture = archiveCtx({ archived: ['session-old'] });
  const route = registerActionRoute({ ctx: fixture.ctx });
  const post = postOf(route);
  const already = await post({ action: 'force-archive', sessionId: 'session-old' });
  assert.equal(already.status, 200, JSON.stringify(already.json));
  assert.equal(already.json.status, 'already');
  assert.equal(already.json.stopActivity, 'skipped');
  assert.deepEqual(fixture.calls, []);
});

test('HTTP force-archive：未知会话 → 404、宿主缺接缝 → 503（P2-2 错误码分档）', async () => {
  const unknownNamed = new Error('no such session');
  unknownNamed.name = 'WorkspaceUnknownSessionError';
  const unknownFixture = archiveCtx({
    archiveSession() {
      throw unknownNamed;
    },
  });
  const unknownPost = postOf(registerActionRoute({ ctx: unknownFixture.ctx, log: { warn() {} } }));
  const unknown = await unknownPost({ action: 'force-archive', sessionId: 'session-nope', confirmStop: true });
  assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
  assert.equal(unknown.json.code, 'force-archive');

  const noRegistry = { get: () => undefined };
  const missingPost = postOf(registerActionRoute({ ctx: noRegistry, log: { warn() {} } }));
  const missing = await missingPost({ action: 'force-archive', sessionId: 'session-old', confirmStop: true });
  assert.equal(missing.status, 503, JSON.stringify(missing.json));
});

test('HTTP force-archive：宿主内部失败 → 500 带具体原因（不是通用「失败：」）', async () => {
  const fixture = archiveCtx({
    archiveSession() {
      throw new Error('disk is full');
    },
  });
  const route = registerActionRoute({ ctx: fixture.ctx, log: { warn() {} } });
  const post = postOf(route);
  const failed = await post({ action: 'force-archive', sessionId: 'session-old', confirmStop: true });
  // 0.5.3 P2-2：宿主内部失败 → 500（以前一律 400）。
  assert.equal(failed.status, 500);
  assert.equal(failed.json.ok, false);
  assert.equal(failed.json.code, 'force-archive');
  assert.ok(failed.json.message.includes('disk is full'), failed.json.message);
  assert.equal(failed.json.message.startsWith('失败：'), false, '不能退化成通用 errorText');
});

test('HTTP force-archive：置顶未确认 → 200 + status=pinned（可让客户端再确认，不静默 unpin）', async () => {
  const fixture = archiveCtx({ pinned: ['session-old'] });
  const route = registerActionRoute({ ctx: fixture.ctx });
  const post = postOf(route);
  const pinned = await post({ action: 'force-archive', sessionId: 'session-old', confirmStop: true });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.json.status, 'pinned');
  assert.ok(pinned.json.note.includes('归档会取消置顶'));
  assert.deepEqual(fixture.calls, []);
});

/* ------------------------------------------------------------------ *
 * 3. readState：capabilities.forceArchive + parentPinned
 * ------------------------------------------------------------------ */

function stateDepsOf({ pinned = [], archive = true, archived = [] } = {}) {
  const session = new MockSession({
    id: 'session-child',
    header: { parentSession: 'session-old' },
    events: [
      { type: 'user/message', data: { role: 'user', content: '第一条' } },
      { type: 'assistant/message', data: { role: 'assistant', content: '回复一' } },
    ],
  });
  const at = Date.now();
  session.appendPluginRecord(RELAY_RECORD_TYPE, {
    parentId: 'session-old',
    childId: 'session-child',
    ordinal: 1,
    baseTitle: '原会话',
    title: '原会话',
    scheme: 'history-n',
    titleSeq: 1,
    at,
    atIso: localIso(new Date(at)),
  });
  const tokenMeter = {
    measure(value) {
      const nodes = value.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 }));
      return { totalTokens: nodes.length * 100, surfaceTokens: nodes.length * 100, nodes };
    },
  };
  return {
    ctx: {
      tokenMeter,
      llm: { async resolveModelInfo() { return { context: { contextWindow: 200_000 } }; } },
      get(name) {
        if (name !== 'workspaceRegistry') return undefined;
        return {
          archivedSessionIds: [...archived],
          pinnedSessionIds: [...pinned],
          ...(archive ? { async archiveSession() {} } : {}),
        };
      },
      agents: { get: () => undefined, list: () => [] },
      sessions: { get: (id) => (id === session.id ? session : undefined), flush() {} },
    },
    cfg: resolveConfig({ retention: { recentTailTokens: 0 } }),
    lock: createLock(),
    engine: { isCompactCheckpointSource: () => false, toolPairingBalancedBefore: () => true, toolPairingBalancedAfter: () => true },
  };
}

test('readState：capabilities.forceArchive 反映宿主有没有 archiveSession', async () => {
  const withArchive = await readState(stateDepsOf({ archive: true }), { sessionId: 'session-child' });
  assert.equal(withArchive.capabilities.forceArchive, true);
  assert.equal(withArchive.capabilities.unarchive, false, '没有 unarchiveSession 时恢复能力位仍是 false');

  const withoutArchive = await readState(stateDepsOf({ archive: false }), { sessionId: 'session-child' });
  assert.equal(withoutArchive.capabilities.forceArchive, false);
});

test('readState：parentPinned 读链上旧会话的置顶状态（false / true / 读不到=null）', async () => {
  const notPinned = await readState(stateDepsOf({ pinned: [] }), { sessionId: 'session-child' });
  assert.equal(notPinned.parentPinned, false);

  const pinned = await readState(stateDepsOf({ pinned: ['session-old'] }), { sessionId: 'session-child' });
  assert.equal(pinned.parentPinned, true, '强制归档的二次确认要据此写「归档会取消置顶」');

  const noRegistry = await readState(
    {
      ...stateDepsOf(),
      ctx: { ...stateDepsOf().ctx, get: () => undefined },
    },
    { sessionId: 'session-child' },
  );
  assert.equal(noRegistry.parentPinned, null, '读不到置顶集合 → null（不猜 false）');
  assert.equal(noRegistry.capabilities.forceArchive, false);
});

/* ------------------------------------------------------------------ *
 * 4. 默认不强制：交接自动归档不带 stopActivity（0.5.0/0.5.1 行为不变）
 * ------------------------------------------------------------------ */

test('默认不强制：交接自动归档仍然只传 sessionId，绝不 stopActivity', async () => {
  const { deps, record } = makeHandoffCtx();
  const result = await handoff(deps, { agent: createAgent(baseSourceSession()), commandId: 'cmd-default-not-forced' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.archive, { status: 'archived', archived: true });
  assert.equal(record.archiveCalls.length, 1);
  assert.deepEqual(record.archiveCalls[0].options, {}, '自动归档只传 sessionId（第二个参数为空对象）');
  assert.equal(record.archiveCalls[0].options.stopActivity, undefined, '自动流程绝不能替用户停任务');
  assert.ok(result.message.includes('旧会话已归档'));
});

/* ------------------------------------------------------------------ *
 * 5. 静态守卫
 * ------------------------------------------------------------------ */

test('静态守卫：生产代码里唯一传 stopActivity:true 的是 actions/force-archive.js', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'client') continue; // 客户端只有文案/注释，没有宿主调用
        walk(full);
      } else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(repoRoot, 'lib'));
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // 只看代码行（粗暴剔除行注释/块注释行），注释里解释 stopActivity 是允许的。
    const code = text
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');
    if (/\bstopActivity\s*:\s*true\b/.test(code)) hits.push(path.relative(repoRoot, file));
  }
  assert.deepEqual(hits, ['lib/actions/force-archive.js'], `stopActivity:true 只允许出现在强制归档动作里：${hits.join(', ')}`);

  const forceSource = fs.readFileSync(path.join(repoRoot, 'lib/actions/force-archive.js'), 'utf8');
  assert.ok(forceSource.includes("confirmStop !== true"), '动作层必须自己校验 confirmStop（不只靠 HTTP）');
});

/* ------------------------------------------------------------------ *
 * 运行
 * ------------------------------------------------------------------ */

let passed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
}
console.log(`force-archive：${passed}/${cases.length} 通过`);
