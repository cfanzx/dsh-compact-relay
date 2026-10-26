/**
 * 0.5.1 DCR-05：完整交接链服务端读取（不加载祖先会话）—— 单测。
 *
 *   node test/relay-chain-endpoint.mjs
 *
 * 覆盖：
 *   1. 真机 bug 原形：祖先会话**全都没加载**（ctx.sessions 为空），仍能从持久化
 *      header/log 一次读出整条链（客户端不再逐级 GET，不会停在 sessionId:null）；
 *   2. 8 跳上限、成环去重、读不到某一层时保留已读行 + unreadable；
 *   3. DCR-02 老链：没有 relay 记录时用 header.parentSession + 标题逐层兜底合成；
 *   4. HTTP `/api/compact-relay-chain`：GET/鉴权/400/405 与真实 registerHttp 接线；
 *   5. 宿主没有 sessionPersistence 时明确 ok:false（客户端回落旧逐级读法）。
 */
import assert from 'node:assert/strict';
import { registerHttp } from '../lib/adapters/http.js';
import { RELAY_RECORD_TYPE } from '../lib/core/relay.js';
import { MAX_CHAIN_HOPS, readRelayChain } from '../lib/dsh/relay-chain.js';

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

const TITLE = '原会话标题';

/* ------------------------------------------------------------------ *
 * 宿主替身：ctx.sessionPersistence + ctx.sessions（默认全未加载）
 * ------------------------------------------------------------------ */

function relayEvent(record) {
  return { type: RELAY_RECORD_TYPE, ignorable: true, data: record };
}

function titleEvent(title) {
  return { type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'user' } } };
}

function entryOf(id, { parentId = null, events = [] } = {}) {
  return {
    header: {
      version: 4,
      id,
      createdAt: 1,
      isSeeded: false,
      ...(parentId === null ? {} : { parentSession: parentId }),
    },
    events,
  };
}

function createPersistence(entries) {
  const opens = [];
  return {
    opens,
    async stat(id) {
      const entry = entries.get(id);
      return entry === undefined ? undefined : { header: entry.header, revision: 'rev-1', sizeBytes: 1 };
    },
    async open(id, access) {
      opens.push({ id, access });
      const entry = entries.get(id);
      if (entry === undefined) {
        const error = new Error(`session "${id}" not found`);
        error.name = 'SessionPersistenceNotFoundError';
        throw error;
      }
      return {
        header: entry.header,
        async read() {
          return { eventState: 'detached', events: entry.events };
        },
        async close() {},
      };
    },
  };
}

/** 全部会话都「未加载」的 ctx；live 可选覆盖某些 id。 */
function createCtx(entries, { live = new Map() } = {}) {
  const persistence = createPersistence(entries);
  return {
    persistence,
    live,
    ctx: {
      sessions: {
        get: (id) => live.get(id),
        list: () => [...live.values()],
      },
      get(name) {
        return name === 'sessionPersistence' ? persistence : undefined;
      },
    },
  };
}

/**
 * 造一条 depth 层祖先的链（self → anc-1 → … → anc-depth），
 * 每层都有 relay 记录 + 交接单 path。返回 entries。
 */
function buildChain(depth, selfId = 'session-self') {
  const entries = new Map();
  let child = selfId;
  for (let level = 1; level <= depth; level += 1) {
    const parent = `session-anc-${level}`;
    const ordinal = depth - level + 1;
    const record = {
      parentId: parent,
      childId: child,
      ordinal,
      baseTitle: TITLE,
      scheme: 'history-n',
      path: `/tmp/dcr-handoffs/handoff-hop-${ordinal}.md`,
      at: ordinal,
    };
    const childEntry = entries.get(child) ?? entryOf(child);
    childEntry.events.push(relayEvent(record));
    entries.set(child, childEntry);
    const parentEntry = entries.get(parent) ?? entryOf(parent);
    // 父日志里这一条是「出站」记录（childId = 子会话）。
    parentEntry.events.push(relayEvent(record));
    entries.set(parent, parentEntry);
    child = parent;
  }
  return entries;
}

/* ================================================================== *
 * 1) bug 原形：祖先全未加载也能一次读全
 * ================================================================== */

test('完整链读取：祖先会话全未加载（sessions 空）仍从持久化日志一次读出 3 层', async () => {
  const entries = buildChain(3);
  // 老记录：本会话那条没有 path（0.4 及更早只在父会话日志里写 path）——
  // 第一行的交接单应从 anc-1 的出站记录补回来。buildChain 两侧共享同一对象，
  // 所以删掉子侧后要把父侧的 path 放回去。
  delete entries.get('session-self').events.at(-1).data.path;
  const parentCopy = entries
    .get('session-anc-1')
    .events.find((event) => event.data.childId === 'session-self');
  parentCopy.data.path = '/tmp/dcr-handoffs/handoff-hop-3.md';
  const { ctx, persistence } = createCtx(entries);
  const result = await readRelayChain(ctx, { sessionId: 'session-self' });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.rows.map((row) => row.sessionId),
    ['session-anc-1', 'session-anc-2', 'session-anc-3'],
    '从近到远列出祖先（不依赖 ctx.sessions 加载）',
  );
  assert.deepEqual(result.rows.map((row) => row.ordinal), [3, 2, 1], '链号来自子会话的入站记录');
  assert.deepEqual(result.rows.map((row) => row.path), [
    '/tmp/dcr-handoffs/handoff-hop-3.md',
    '/tmp/dcr-handoffs/handoff-hop-2.md',
    '/tmp/dcr-handoffs/handoff-hop-1.md',
  ]);
  assert.equal(result.done, true);
  assert.equal(result.capped, false);
  assert.equal(result.unreadable, null);
  assert.equal(persistence.opens.every((open) => open.access === 'read'), true, '只开只读句柄，不创建 live 会话');
  assert.equal(persistence.opens.length >= 3, true, '每层祖先各只读一次日志');
});

test('完整链读取：本会话 live 时用内存日志，祖先仍可从未加载的持久化日志读', async () => {
  const entries = buildChain(2);
  const liveSelf = {
    id: 'session-self',
    header: { version: 4, id: 'session-self', createdAt: 1, isSeeded: false },
    log: [
      relayEvent({
        parentId: 'session-anc-1',
        childId: 'session-self',
        ordinal: 2,
        baseTitle: TITLE,
        scheme: 'history-n',
        at: 2,
      }),
    ],
  };
  const { ctx } = createCtx(entries, { live: new Map([['session-self', liveSelf]]) });
  const result = await readRelayChain(ctx, { sessionId: 'session-self' });
  assert.deepEqual(result.rows.map((row) => row.sessionId), ['session-anc-1', 'session-anc-2']);
  assert.deepEqual(result.rows.map((row) => row.ordinal), [2, 1]);
});

/* ================================================================== *
 * 2) 8 跳上限 / 成环去重 / 断点
 * ================================================================== */

test('完整链读取：最多 8 跳，capped=true 且不拉第 9 层', async () => {
  const entries = buildChain(12);
  const { ctx, persistence } = createCtx(entries);
  const result = await readRelayChain(ctx, { sessionId: 'session-self' });
  assert.equal(result.rows.length, MAX_CHAIN_HOPS, '硬上限 8 层');
  assert.equal(result.capped, true);
  assert.equal(result.done, true);
  assert.equal(result.rows.at(-1).sessionId, 'session-anc-8');
  assert.equal(
    persistence.opens.filter((open) => open.id.startsWith('session-anc-')).length,
    8,
    '到顶后不再读第 9 层（self 那一次不算）',
  );
});

test('完整链读取：链路成环时按 sessionId 去重后停止', async () => {
  const entries = new Map([
    ['session-self', entryOf('session-self', {
      events: [relayEvent({ parentId: 'session-anc-1', childId: 'session-self', ordinal: 2, baseTitle: TITLE, scheme: 'history-n', at: 2 })],
    })],
    ['session-anc-1', entryOf('session-anc-1', {
      events: [relayEvent({ parentId: 'session-anc-2', childId: 'session-anc-1', ordinal: 1, baseTitle: TITLE, scheme: 'history-n', at: 1 })],
    })],
    ['session-anc-2', entryOf('session-anc-2', {
      events: [relayEvent({ parentId: 'session-anc-1', childId: 'session-anc-2', ordinal: 1, baseTitle: TITLE, scheme: 'history-n', at: 1 })],
    })],
  ]);
  const { ctx } = createCtx(entries);
  const result = await readRelayChain(ctx, { sessionId: 'session-self' });
  assert.deepEqual(result.rows.map((row) => row.sessionId), ['session-anc-1', 'session-anc-2']);
  assert.equal(result.done, true);
  assert.equal(result.capped, false);
});

test('完整链读取：某层读不到时保留已读行 + unreadable（不整块清空）', async () => {
  const entries = new Map([
    ['session-self', entryOf('session-self', {
      events: [relayEvent({ parentId: 'session-anc-1', childId: 'session-self', ordinal: 2, baseTitle: TITLE, scheme: 'history-n', at: 2 })],
    })],
    ['session-anc-1', entryOf('session-anc-1', {
      events: [relayEvent({ parentId: 'session-gone', childId: 'session-anc-1', ordinal: 1, baseTitle: TITLE, scheme: 'history-n', at: 1 })],
    })],
  ]);
  const { ctx } = createCtx(entries);
  const result = await readRelayChain(ctx, { sessionId: 'session-self' });
  assert.equal(result.rows.length, 1, '已读到的 anc-1 保留');
  assert.deepEqual(result.unreadable, { sessionId: 'session-gone', reason: 'not-found' });
  assert.equal(result.done, false);
  assert.equal(result.capped, false);
});

test('完整链读取：当前会话不在持久化里 → ok:false not-found（客户端回落旧读法）', async () => {
  const { ctx } = createCtx(new Map());
  const result = await readRelayChain(ctx, { sessionId: 'session-lost' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-found');
});

test('完整链读取：宿主没有 sessionPersistence → ok:false unsupported', async () => {
  const ctx = { sessions: { get: () => undefined, list: () => [] }, get: () => undefined };
  const result = await readRelayChain(ctx, { sessionId: 'session-self' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported');
});

/* ================================================================== *
 * 3) DCR-02 老链：没有 relay 记录，header + 标题逐层兜底
 * ================================================================== */

test('完整链读取：0.5.0 前老链没有 relay 记录 → header+标题逐层合成', async () => {
  const entries = new Map([
    ['session-legacy-self', entryOf('session-legacy-self', {
      parentId: 'session-legacy-1',
      events: [titleEvent('交接第 2 次：老链标题')],
    })],
    ['session-legacy-1', entryOf('session-legacy-1', {
      parentId: 'session-legacy-2',
      events: [titleEvent('交接第 1 次：更老标题')],
    })],
    ['session-legacy-2', entryOf('session-legacy-2')],
  ]);
  const { ctx } = createCtx(entries);
  const result = await readRelayChain(ctx, { sessionId: 'session-legacy-self' });
  assert.deepEqual(
    result.rows,
    [
      { sessionId: 'session-legacy-1', ordinal: 2, baseTitle: '老链标题', scheme: 'handoff-n', path: null },
      { sessionId: 'session-legacy-2', ordinal: 1, baseTitle: '更老标题', scheme: 'handoff-n', path: null },
    ],
    '老链没有记录也能从 header.parentSession + 「交接第 N 次」标题逐层读',
  );
  assert.equal(result.done, true);
});

test('完整链读取：header 是 subagent/fork 或无标题 → 不合成（不猜链号）', async () => {
  const entries = new Map([
    ['session-sub', {
      header: { version: 4, id: 'session-sub', createdAt: 1, isSeeded: false, parentSession: 'session-p', origin: 'subagent' },
      events: [titleEvent('交接第 1 次：X')],
    }],
    ['session-fork', {
      header: { version: 4, id: 'session-fork', createdAt: 1, isSeeded: true, parentSession: 'session-p' },
      events: [titleEvent('交接第 1 次：X')],
    }],
    ['session-clean', {
      header: { version: 4, id: 'session-clean', createdAt: 1, isSeeded: false, parentSession: 'session-p' },
      events: [titleEvent('普通会话标题')],
    }],
    ['session-p', entryOf('session-p')],
  ]);
  for (const id of ['session-sub', 'session-fork', 'session-clean']) {
    const { ctx } = createCtx(entries);
    const result = await readRelayChain(ctx, { sessionId: id });
    assert.deepEqual(result.rows, [], `${id} 不应合成接力链`);
    assert.equal(result.done, true);
  }
});

/* ================================================================== *
 * 4) HTTP 端点：真实 registerHttp 接线
 * ================================================================== */

function createWebCtx() {
  const routes = [];
  return {
    routes,
    webCtx: {
      webServer: {
        register(route) {
          routes.push(route);
          return () => {};
        },
      },
      effect() {},
      connection: { requestRejection: () => undefined },
    },
  };
}

async function callRoute(route, { method = 'GET', url }) {
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
  route.handler({ method, url, headers: {} }, res);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body) };
}

test('HTTP：GET /api/compact-relay-chain 一次返回整条链（祖先未加载）', async () => {
  const entries = buildChain(3);
  const { ctx } = createCtx(entries);
  const { routes, webCtx } = createWebCtx();
  registerHttp(webCtx, { ctx });
  const route = routes.find((entry) => entry.path === '/api/compact-relay-chain');
  assert.ok(route !== undefined, '应注册 /api/compact-relay-chain');

  const ok = await callRoute(route, { url: '/api/compact-relay-chain?sessionId=session-self' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.deepEqual(ok.json.rows.map((row) => row.sessionId), ['session-anc-1', 'session-anc-2', 'session-anc-3']);

  const missing = await callRoute(route, { url: '/api/compact-relay-chain' });
  assert.equal(missing.status, 400, '缺少 sessionId 必须 400');
  assert.equal(missing.json.ok, false);

  const post = await callRoute(route, { method: 'POST', url: '/api/compact-relay-chain?sessionId=session-self' });
  assert.equal(post.status, 405, '只读端点只支持 GET');
});

test('HTTP：没有 sessionPersistence 时返回 ok:false（客户端回落逐级读法）', async () => {
  const { ctx } = createCtx(new Map());
  // 删掉持久化服务，模拟老宿主。
  ctx.get = () => undefined;
  const { routes, webCtx } = createWebCtx();
  registerHttp(webCtx, { ctx });
  const route = routes.find((entry) => entry.path === '/api/compact-relay-chain');
  const res = await callRoute(route, { url: '/api/compact-relay-chain?sessionId=session-self' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.code, 'unsupported');
});

test('HTTP：链端点同样先过宿主 connection 鉴权', async () => {
  const entries = buildChain(1);
  const { ctx } = createCtx(entries);
  const { routes, webCtx } = createWebCtx();
  webCtx.connection = { requestRejection: () => 401 };
  registerHttp(webCtx, { ctx });
  const route = routes.find((entry) => entry.path === '/api/compact-relay-chain');
  const res = await callRoute(route, { url: '/api/compact-relay-chain?sessionId=session-self' });
  assert.equal(res.status, 401, '未认证必须 401');
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

console.log(`\nrelay-chain-endpoint：${passed}/${cases.length} 通过`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}\n${failure.error && failure.error.stack ? failure.error.stack : failure.error}`);
  }
  process.exit(1);
}
