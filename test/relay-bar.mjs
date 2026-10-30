/**
 * 0.5.0 接力条 v1 —— `conversation.input.dock` 的组件级测试。
 *
 *   node test/relay-bar.mjs
 *
 * 锁住四层：
 *   1. 客户端产物：`conversation.input.dock` 注册 + 接力条标记 + 恢复入口真的进了 lib/client.js；
 *   2. 显示条件：chain 非 null 且是本会话入站记录才渲染；无 chain / 老宿主没有
 *      chain 字段 / 出站记录 → 返回 null（不占高度）；
 *   3. 文案与菜单：新链「历史 N：原名」、旧链「交接第 N 次：原名」；菜单入口
 *      （查看交接单 / 回到原会话 / 恢复旧会话 / 路线图占位），无 path 时「查看交接单」
 *      禁用并显示「暂无交接单」；父会话已归档时出现「恢复旧会话」；
 *   4. 交互与定位：点这一行→ fixed + 向上弹的菜单（bottom 定位、z-index 顶层），
 *      回到原会话调用注入的 openSession(parentId)，已归档/未知时先走
 *      ctx.uiWorkspace.unarchiveSession（老宿主退回 HTTP recover），交接单走
 *      `/api/compact-relay-handoffs?file=<basename>`（不是全路径）；
 *   5. 0.5.1 批 3：完整交接链列表（按需展开、每层一次 state GET、8 跳上限、
 *      sessionId 去重、失败重试、行内交接单/跳转）与父→子「去新会话」入口。
 *
 * 不引 jsdom / React：用极简 React 替身把真实 bundle 的组件跑起来（与
 * test/settings-ux.mjs 同一套思路），业务代码原样执行。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const repoRoot = new URL('../', import.meta.url);
const bundle = fs.readFileSync(new URL('lib/client.js', repoRoot), 'utf8');

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/* ------------------------------------------------------------------ *
 * 1. 极简 React 替身（state / effect / ref / callback）
 * ------------------------------------------------------------------ */

const flatten = (nodes) => nodes.flat(Infinity).filter((node) => node !== null && node !== undefined && node !== false && node !== true);

function createReactFacade() {
  let active = null;
  const depsEqual = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

  return {
    __mount(mount) {
      active = mount;
    },
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children: flatten(children) };
    },
    useState(initial) {
      const index = active.cursor++;
      if (active.slots[index] === undefined) {
        active.slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      }
      const slot = active.slots[index];
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) {
          slot.value = value;
          active.dirty = true;
        }
      };
      return [slot.value, set];
    },
    useRef(initial) {
      const index = active.cursor++;
      if (active.slots[index] === undefined) active.slots[index] = { kind: 'ref', current: initial };
      return active.slots[index];
    },
    useCallback(fn, deps) {
      const index = active.cursor++;
      const slot = active.slots[index];
      if (slot === undefined || slot.kind !== 'callback' || !depsEqual(slot.deps, deps)) {
        active.slots[index] = { kind: 'callback', fn, deps };
      }
      return active.slots[index].fn;
    },
    useEffect(fn, deps) {
      const index = active.cursor++;
      const slot = active.slots[index];
      if (slot === undefined || slot.kind !== 'effect' || !depsEqual(slot.deps, deps)) {
        active.slots[index] = { kind: 'effect', deps, cleanup: null };
        active.pending.push({ index, fn });
      }
    },
  };
}

function mountComponent(Component, react, props) {
  const mount = { slots: [], cursor: 0, dirty: false, pending: [] };
  let tree = null;

  const runEffects = () => {
    const effects = mount.pending;
    mount.pending = [];
    for (const { index, fn } of effects) {
      const slot = mount.slots[index];
      if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup();
      const cleanup = fn();
      if (slot !== undefined) slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
    }
  };

  const renderOnce = () => {
    react.__mount(mount);
    mount.cursor = 0;
    mount.dirty = false;
    tree = Component(props);
    runEffects();
    return tree;
  };

  async function settle(maxTicks = 60) {
    for (let tick = 0; tick < maxTicks; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!mount.dirty) return tree;
      renderOnce();
    }
    throw new Error('渲染未收敛（可能存在 effect 死循环）');
  }

  return { renderOnce, settle, get tree() { return tree; } };
}

function walk(node, fn) {
  if (node === null || typeof node !== 'object') return;
  fn(node);
  for (const child of node.children) walk(child, fn);
}

function findAll(tree, predicate) {
  const found = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function findByAttr(tree, attr) {
  return findAll(tree, (node) => node.props !== null && node.props !== undefined && node.props[attr] !== undefined)[0] ?? null;
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.children);
}

/* ------------------------------------------------------------------ *
 * 2. 用真实 bundle 加载组件
 * ------------------------------------------------------------------ */

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function loadBundle({ withUnarchive = true, unarchiveError = false, unarchiveFailTimes = 0, recoverFails = false, recoverFailTimes = 0 } = {}) {
  const react = createReactFacade();
  const registered = {};
  const exported = {};
  const fetches = [];
  const listeners = {};
  const stateResponses = new Map();
  // 0.5.1 批 3：某个祖先会话的 state 读不到（测「完整交接链」的失败/重试分支）。
  const stateFailures = new Set();
  // 0.5.1 DCR-05：服务端整链端点。默认 404 = 老插件，让旧用例走逐级 state 读法。
  const chainResponses = new Map();
  let chainResponse = { status: 404, payload: { ok: false, message: 'not found' } };
  const actionCalls = [];
  const unarchiveCalls = [];
  let stateResponse = { ok: true, chain: null };
  let docResponse = { ok: true, name: 'handoff-x.md', path: '/tmp/handoffs/handoff-x.md', content: '# 交接单\n- 条目' };
  // 0.5.2 L 项：强制归档动作的响应（默认成功；测试可改成 500 或 status:'pinned'）。
  let forceArchiveResponse = {
    ok: true,
    status: 'archived',
    note: '旧会话已归档（可在新会话输入框上方「已接力自 …」→「恢复旧会话」找回；侧栏视图选「全部对话（显示已归档）」，再对该会话点「取消归档」）。',
  };
  // 0.5.1 批 2：交接预览响应（九段草稿 + 就绪 + 可编辑两段）。
  const previewResponse = {
    ok: true,
    draft: '## 1. 目标\n- 完成批 2\n## 2. 证据\n- npm test',
    readiness: { ok: true, missing: [], warnings: [] },
    editable: { titles: ['约束', '下一步'], sections: { 约束: '不要动 0.6 目录', 下一步: '补真机验证' }, maxChars: 4000, note: '程序生成的段不可改。' },
    ordinal: 1,
    pressure: 400,
    summaries: 0,
    changedFiles: [],
    attempts: 1,
  };
  // 0.6 压缩预览卡收藏区：preview 动作的响应（外层 {ok, planId, preview}）。
  // preview.favoritePreview 是服务端 additive 字段——卡片据此渲染「已收藏 / 建议补」两块。
  let compactPreviewResponse = {
    ok: true,
    planId: 'plan-favorite-1',
    preview: {
      nodes: 5,
      tokens: 1200,
      startSeq: 1,
      endSeq: 5,
      planId: 'plan-favorite-1',
      tooSmall: false,
      favoriteHits: { inRange: 2, total: 5 },
      favoritePreview: {
        total: 5,
        favoritedCount: 2,
        favorited: [
          { seq: 1, role: '用户', title: '不要改 lib/api.js 的公开接口…' },
          { seq: 4, role: '助手', title: '决定采用方案 B（事件驱动替代轮询）…' },
        ],
        suggest: [
          {
            seq: 2,
            role: '助手',
            reason: '报错堆栈',
            snippet: 'TypeError: cb is not a function at run (/app/index.js:12:5)',
          },
        ],
      },
    },
  };
  // 0.6 卡片内「收藏」按钮的响应（默认成功；测试可换 400 失败）。
  let favoriteMarkResponse = { ok: true, active: true, seq: 2, count: 3, message: '已收藏第 2 条' };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Error,
    URL,
    innerWidth: 1280,
    innerHeight: 900,
    // 组件的滚动/缩放监听挂在 window 上；测试不模拟滚动，给 no-op 即可。
    addEventListener() {},
    removeEventListener() {},
    navigator: { clipboard: { writeText: async () => {} } },
    document: {
      body: {},
      documentElement: {},
      // 0.5.5：收藏星标「常亮」样式注入需要 head / getElementById / createElement，
      // 这里给一个极简替身，测试可读回注入的 CSS 文本（真实页面由浏览器执行同一段 CSS）。
      head: {
        children: [],
        appendChild(el) {
          this.children.push(el);
          return el;
        },
      },
      getElementById(id) {
        return this.head.children.find((el) => el.id === id) ?? null;
      },
      createElement(tag) {
        return { tagName: String(tag).toUpperCase(), id: '', textContent: '', dataset: {}, style: {}, remove() {} };
      },
      addEventListener(type, handler) {
        (listeners[type] ??= []).push(handler);
      },
      removeEventListener(type, handler) {
        const list = listeners[type] ?? [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      },
    },
    getComputedStyle: () => ({ backgroundColor: 'rgb(255,255,255)', color: 'rgb(31,35,41)' }),
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
  };
  sandbox.window = sandbox;
  sandbox.fetch = (url, options) => {
    fetches.push({ url, options });
    if (typeof url === 'string' && url.startsWith('/api/compact-relay-chain')) {
      const sessionId = decodeURIComponent((url.split('sessionId=')[1] ?? ''));
      const response = chainResponses.has(sessionId) ? chainResponses.get(sessionId) : chainResponse;
      const resolved = typeof response === 'function' ? response() : response;
      return Promise.resolve(jsonResponse(resolved.status ?? 200, resolved.payload ?? resolved));
    }
    if (typeof url === 'string' && url.startsWith('/api/compact-relay-state')) {
      const sessionId = decodeURIComponent((url.split('sessionId=')[1] ?? ''));
      if (stateFailures.has(sessionId)) return Promise.resolve(jsonResponse(500, { ok: false, message: 'state 读取失败' }));
      const response = stateResponses.has(sessionId) ? stateResponses.get(sessionId) : stateResponse;
      // 允许用函数给出「第 N 次请求」的响应（测会话尚未加载时的重试）。
      return Promise.resolve(jsonResponse(200, typeof response === 'function' ? response() : response));
    }
    if (typeof url === 'string' && url.startsWith('/api/compact-relay-handoffs?file=')) return Promise.resolve(jsonResponse(200, docResponse));
    if (url === '/api/compact-relay-action' && options?.method === 'POST') {
      const body = JSON.parse(options.body);
      actionCalls.push(body);
      // 0.5.1 批 2：指示灯交接预览 / 确认交接（归档开关 + 置顶确认）。
      if (body.action === 'handoff-preview') return Promise.resolve(jsonResponse(200, previewResponse));
      if (body.action === 'handoff') {
        return Promise.resolve(
          jsonResponse(200, { ok: true, message: '交接完成', childId: 'child-session-1', path: '/tmp/handoffs/handoff-x.md' }),
        );
      }
      // 0.5.2 L 项：强制归档（默认成功；测试可换成失败/置顶响应）。
      if (body.action === 'force-archive') {
        const response =
          typeof forceArchiveResponse === 'function' ? forceArchiveResponse(body) : forceArchiveResponse;
        return Promise.resolve(
          response !== null && typeof response === 'object' && typeof response.status === 'number'
            ? jsonResponse(response.status, response.payload ?? response)
            : jsonResponse(200, response),
        );
      }
      // 0.6 压缩预览（只读）与卡内「收藏」（favorite-mark，按 sessionId+seq）。
      // 支持 `{status, payload}` 模拟失败；直接传 payload 默认 200。
      if (body.action === 'preview' || body.action === 'favorite-mark') {
        const source = body.action === 'preview' ? compactPreviewResponse : favoriteMarkResponse;
        const response = typeof source === 'function' ? source(body) : source;
        return Promise.resolve(
          response !== null && typeof response === 'object' && typeof response.status === 'number'
            ? jsonResponse(response.status, response.payload ?? response)
            : jsonResponse(200, response),
        );
      }
      // recoverFails / recoverFailTimes：插件 HTTP recover 通道失败（测双通道重试）。
      const failing = recoverFails || actionCalls.length <= recoverFailTimes;
      return Promise.resolve(
        failing
          ? jsonResponse(500, { ok: false, message: '恢复接口不可用' })
          : jsonResponse(200, { ok: true, recovered: true, message: '已恢复旧会话' }),
      );
    }
    return Promise.reject(new Error(`未预期的请求：${url}`));
  };
  sandbox.__ModuleLoader__ = {
    load(entry) {
      exported.module = entry.factory(() => react);
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox, { filename: 'lib/client.js' });
  assert.equal(typeof exported.module.apply, 'function', 'client bundle 应导出 apply');

  const openCalls = [];
  const ctx = {
    slots: {
      inject(name, factory) {
        factory();
      },
      register(meta, component) {
        registered[meta.name] = { meta, component };
        return () => {};
      },
    },
    // child-session-1 预先登记：交接确认后 waitAndOpen 不用等 30×400ms 的目录轮询。
    sessions: { list: { getSnapshot: () => ({ byId: { 'child-session-1': { id: 'child-session-1' } } }) }, refresh() {} },
    uiWorkspace: {
      openSession(sessionId) {
        openCalls.push(sessionId);
      },
      ...(withUnarchive
        ? {
            async unarchiveSession(sessionId) {
              unarchiveCalls.push(sessionId);
              // unarchiveFailTimes=N：前 N 次失败（测「恢复失败重试 unarchive+open」）。
              if (unarchiveError || unarchiveCalls.length <= unarchiveFailTimes) throw new Error('unarchive rejected by host');
            },
          }
        : {}),
    },
  };
  exported.module.apply(ctx);

  function setState(response, forSessionId) {
    if (typeof forSessionId === 'string') stateResponses.set(forSessionId, response);
    else stateResponse = response;
  }
  /** 0.5.1 批 3：让某个会话的 state 请求失败（500）；healState 恢复正常。 */
  function failState(forSessionId) {
    stateFailures.add(forSessionId);
  }
  function healState(forSessionId) {
    stateFailures.delete(forSessionId);
  }
  function setDoc(response) {
    docResponse = response;
  }
  /** 0.5.2 L 项：设置强制归档的响应（直接传 payload 默认 200；`{status,payload}` 可模拟失败）。 */
  function setForceArchiveResponse(response) {
    forceArchiveResponse = response;
  }
  /** 0.6：设置压缩预览（preview 动作）的响应（直接传 payload 默认 200；`{status,payload}` 可模拟失败）。 */
  function setCompactPreviewResponse(response) {
    compactPreviewResponse = response;
  }
  /** 0.6：设置卡内收藏（favorite-mark 动作）的响应。 */
  function setFavoriteMarkResponse(response) {
    favoriteMarkResponse = response;
  }
  /**
   * 0.5.1 DCR-05：设置 `/api/compact-relay-chain` 的响应。
   * 传 `{status, payload}` 可模拟老宿主（404）；直接传 payload 默认 200。
   */
  function setChainResponse(response, forSessionId) {
    const normalized =
      response !== null && typeof response === 'object' && typeof response.status === 'number'
        ? response
        : { status: 200, payload: response };
    if (typeof forSessionId === 'string') chainResponses.set(forSessionId, normalized);
    else chainResponse = normalized;
  }
  function mountLeft(sessionId) {
    const entry = registered['conversation.input.left'];
    assert.ok(entry !== undefined, '应注册 conversation.input.left（指示灯）');
    assert.equal(entry.meta.id, 'compact-relay');
    const props = entry.meta.inject(sessionId);
    assert.equal(props.sessionId, sessionId, '指示灯 props 应透传 sessionId');
    const renderer = mountComponent(entry.component, react, props);
    renderer.renderOnce();
    return renderer;
  }
  /** 0.5.5：读回星标模块注入的 `<style id="dcr-favorite-style">`（常亮规则在里面）。 */
  function favoriteStyle() {
    return sandbox.document.head.children.find((el) => el.id === 'dcr-favorite-style') ?? null;
  }
  /** 0.5.5：挂一条助手消息的收藏星标（宿主会把 messageId 作为 slot ownerProps 传入）。 */
  function mountFavoriteStar(sessionId, messageId) {
    const entry = registered['conversation.chat.assistant-actions'];
    assert.ok(entry !== undefined, '应注册 conversation.chat.assistant-actions（收藏星标）');
    assert.equal(entry.meta.id, 'compact-relay-favorite');
    const injected = entry.meta.inject(sessionId);
    const renderer = mountComponent(entry.component, react, { ...injected, messageId });
    renderer.renderOnce();
    return renderer;
  }
  function mount(sessionId) {
    const entry = registered['conversation.input.dock'];
    assert.ok(entry !== undefined, '应注册 conversation.input.dock');
    assert.equal(entry.meta.id, 'compact-relay');
    assert.equal(entry.meta.order, 10, '接力条应在 TodoPanel(0) 与 queue(20) 之间');
    const props = entry.meta.inject(sessionId);
    assert.equal(props.sessionId, sessionId, 'dock 的 session scope 参数应透传 sessionId');
    const renderer = mountComponent(entry.component, react, props);
    return renderer;
  }
  function fire(type, event) {
    for (const handler of listeners[type] ?? []) handler(event);
  }
  return { registered, sandbox, fetches, openCalls, unarchiveCalls, actionCalls, setState, setDoc, setChainResponse, setForceArchiveResponse, setCompactPreviewResponse, setFavoriteMarkResponse, failState, healState, mount, mountLeft, mountFavoriteStar, favoriteStyle, fire };
}

const SESSION_ID = 'session-new-0001';
const OLD_SESSION_ID = 'session-old-0001';

const CHAIN = {
  ordinal: 1,
  baseTitle: '原会话标题',
  parentId: OLD_SESSION_ID,
  childId: SESSION_ID,
  scheme: 'history-n',
  path: '/Users/x/.dsh/handoffs/handoff-2026-10-26T09-00-00-000Z.md',
};

const rowElement = {
  getBoundingClientRect: () => ({ left: 40, right: 1000, top: 700, bottom: 732 }),
};

/* ------------------------------------------------------------------ *
 * 3. 客户端产物静态守卫
 * ------------------------------------------------------------------ */

test('客户端产物：input.dock 注册 + 接力条标记 + 主题 token 都在 bundle 里', () => {
  for (const marker of [
    "ctx.slots.inject('conversation.input.dock'",
    "name: 'conversation.input.dock'",
    "'data-cr-relay-bar': '1'",
    "'data-cr-relay-menu': '1'",
    "'data-cr-relay-doc': '1'",
    '已接力自',
    '查看交接单',
    '回到原会话',
    '恢复旧会话',
    "'data-cr-relay-parent-archived'",
    "action: 'recover'",
    'ctx.uiWorkspace?.unarchiveSession',
    "RELAY_CHAIN_ENDPOINT = '/api/compact-relay-chain'",
    "'data-cr-relay-chain-open-parent'",
    '上一层会话未打开',
    '打开并继续',
    '路线图（即将上线）',
    '暂无交接单',
    // 0.5.1 批 3：完整交接链 + 父→子入口
    '完整交接链',
    '去新会话',
    '无法读取更早的链路',
    "'data-cr-relay-chain-row'",
    "'data-cr-relay-chain-open'",
    "'data-cr-relay-chain-doc'",
    "'data-cr-relay-chain-retry'",
    "'data-cr-relay-next'",
    // 0.5.2 L 项：强制归档旧会话（显式二次确认；默认不强制）
    '强制归档旧会话（会停止后台任务）',
    '会停止旧会话上正在跑的任务',
    "'data-cr-force-archive'",
    "'data-cr-force-warning'",
    "'data-cr-force-run'",
    "action: 'force-archive'",
    'confirmStop: true',
  ]) {
    assert.ok(bundle.includes(marker), `bundle 应包含 ${marker}`);
  }
  // 深浅主题：文字/底色必须走 DSH token（老宿主由 theme 兜底），不写死黑白。
  assert.ok(bundle.includes('--dsw-alias-label-primary'), '主文字应走 DSH 主题 token');
  assert.ok(bundle.includes('--dsw-specific-menu'), '底色应走 DSH 菜单 token');
  assert.ok(bundle.includes('--dsh-composer-side-clearance'), '宽度应与宿主 dock 条目同口径');
});

/* ------------------------------------------------------------------ *
 * 4. 显示条件
 * ------------------------------------------------------------------ */

test('无 chain：不渲染任何东西（不占高度）', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: null, sessionId: SESSION_ID });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  assert.equal(renderer.tree, null, 'chain=null 时组件应返回 null');
});

test('老宿主没有 chain 字段：不崩、不显示', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, sessionId: SESSION_ID, level: 'idle' });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  assert.equal(renderer.tree, null, '没有 chain 字段时应静默不渲染');
});

test('出站记录（本会话交接给下一代）：不显示「已接力自」', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: { ...CHAIN, parentId: SESSION_ID, childId: 'session-grandchild' } });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  assert.equal(renderer.tree, null);
});

test('坏数据（ordinal 缺失/链不是对象）不渲染', async () => {
  for (const chain of [{}, { ordinal: 0, parentId: OLD_SESSION_ID }, 'chain', 7]) {
    const harness = loadBundle();
    harness.setState({ ok: true, chain, sessionId: SESSION_ID });
    const renderer = harness.mount(SESSION_ID);
    renderer.renderOnce();
    await renderer.settle();
    assert.equal(renderer.tree, null, `chain=${JSON.stringify(chain)} 不应渲染`);
  }
});

/* ------------------------------------------------------------------ *
 * 5. 文案 / 定位 / 菜单
 * ------------------------------------------------------------------ */

test('会话还没被宿主加载（sessionId=null）：短重试后补上接力条', async () => {
  const harness = loadBundle();
  // 把组件里的 500ms 重试压成下一轮宏任务，测试不必真等。
  harness.sandbox.setTimeout = (fn) => globalThis.setTimeout(fn, 0);
  let calls = 0;
  harness.setState(() => {
    calls += 1;
    return calls === 1
      ? { ok: true, chain: null, sessionId: null }
      : { ok: true, chain: CHAIN, sessionId: SESSION_ID };
  });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  // 第一帧没有变化（chain 仍是 null），settle 会提前返回；显式把重试的 0ms 计时器跑几轮。
  for (let tick = 0; tick < 20 && calls < 2; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await renderer.settle();
  assert.ok(calls >= 2, `应重试至少一次（实际 ${calls} 次）`);
  const bar = findByAttr(renderer.tree, 'data-cr-relay-bar');
  assert.ok(bar !== null, '重试拿到链后应渲染接力条');
  assert.ok(textOf(bar).includes('历史 1：原会话标题'));
});

test('新链：一行「已接力自 历史 1：原名 ▾」，fixed 向上弹、顶层', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: CHAIN, parentArchived: true });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();

  const bar = findByAttr(renderer.tree, 'data-cr-relay-bar');
  assert.ok(bar !== null, '有链时应渲染接力条');
  assert.equal(bar.props['data-cr-relay-parent-archived'], 'true', '已归档状态应透到 DOM（调试/测试用）');
  assert.equal(bar.props['data-cr-relay-ordinal'], '1');
  assert.equal(bar.props['data-cr-relay-scheme'], 'history-n');
  assert.equal(bar.props['aria-expanded'], false);
  // 文案：前缀 + 「历史 N：原名」+ ▾（▾ 是 aria-hidden 的视觉提示）。
  const barText = textOf(bar);
  assert.ok(barText.includes('已接力自'), `缺少「已接力自」：${barText}`);
  assert.ok(barText.includes('历史 1：原会话标题'), `新链文案不对：${barText}`);
  assert.ok(barText.includes('▾'), '应有一行的下拉指示 ▾');

  // 根容器宽度与宿主 dock 条目同口径；文字/底色走主题 token。
  const root = findByAttr(renderer.tree, 'data-cr-relay-root');
  assert.ok(root.props.style.width.includes('--dsh-composer-side-clearance'));
  assert.ok(root.props.style.maxWidth.includes('--dsh-composer-card-max-width'));
  // 卡片外观在内层：backdrop-filter 若落在 fixed 菜单的祖先上，会让菜单相对这一行定位。
  const card = findByAttr(renderer.tree, 'data-cr-relay-card');
  assert.ok(String(card.props.style.background).includes('--dsw-specific-menu'));
  assert.ok(String(card.props.style.color).includes('--dsw-alias-label-primary'));
  assert.equal(root.props.style.backdropFilter, undefined, 'fixed 菜单的祖先不能带 backdrop-filter');
  assert.equal(card.props.style.overflow, 'hidden');

  // 点这一行 → 菜单向上弹（bottom 定位，而不是从顶部往下掉）。
  bar.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const menu = findByAttr(renderer.tree, 'data-cr-relay-menu');
  assert.ok(menu !== null, '点击后应出现下拉菜单');
  assert.equal(menu.props.style.position, 'fixed', '菜单用 fixed 脱离输入区裁剪');
  assert.equal(menu.props.style.zIndex, 60, '菜单应在顶层');
  assert.equal(typeof menu.props.style.bottom, 'number', '输入框上方应向上弹（bottom 定位）');
  assert.equal(menu.props.style.top, undefined, '向上弹时不应同时写 top');
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-bar').props['aria-expanded'], true);

  // 入口顺序与文案固定（父会话已归档 → 多一个「恢复旧会话」；有祖先 → 多「完整交接链」）。
  const actions = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] !== undefined).map((node) => node.props['data-cr-relay-action']);
  assert.deepEqual(actions, ['doc', 'parent', 'unarchive', 'chain', 'roadmap']);
  const restoreItem = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'unarchive')[0];
  assert.ok(textOf(restoreItem).includes('恢复旧会话'));
  assert.ok(textOf(restoreItem).includes('已归档'));
  const roadmapItem = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'roadmap')[0];
  assert.ok(textOf(roadmapItem).includes('路线图（即将上线）'));
  assert.equal(roadmapItem.props.disabled, true, '路线图占位不可点');
  assert.equal(roadmapItem.props.onClick(), undefined);
});

// 老数据兼容：0.5.0 之前的子记录没有 path（当时 F3 不写），这时才向父会话回查。
test('子记录无 path：向父会话读回同一条链的 path 后，查看交接单可用', async () => {
  const harness = loadBundle();
  const { path, ...localNoPath } = CHAIN;
  harness.setState({ ok: true, chain: localNoPath, sessionId: SESSION_ID });
  // 父会话里的同一条记录是出站记录：childId 指回本会话，path 就是那份交接单。
  harness.setState({ ok: true, chain: { ...CHAIN, parentId: OLD_SESSION_ID, childId: SESSION_ID }, sessionId: OLD_SESSION_ID }, OLD_SESSION_ID);
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();

  const bar = findByAttr(renderer.tree, 'data-cr-relay-bar');
  assert.equal(bar.props['data-cr-relay-path'], CHAIN.path, '应从父记录补回交接单路径');
  const stateCalls = harness.fetches.filter((entry) => String(entry.url).startsWith('/api/compact-relay-state'));
  assert.equal(stateCalls.length, 2, '本会话一次 + 父会话一次');
  assert.ok(String(stateCalls[1].url).includes(`sessionId=${OLD_SESSION_ID}`), '第二次应读父会话状态');

  bar.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const docItem = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'doc')[0];
  assert.equal(docItem.props.disabled, false, '补回 path 后查看交接单应可点');
  assert.ok(!textOf(docItem).includes('暂无交接单'));
});

test('子记录自带 path：直接用本会话的 path，不再回查父会话', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: CHAIN, sessionId: SESSION_ID });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();

  const bar = findByAttr(renderer.tree, 'data-cr-relay-bar');
  assert.equal(bar.props['data-cr-relay-path'], CHAIN.path, '子记录自带的 path 应直接可用');
  const stateCalls = harness.fetches.filter((entry) => String(entry.url).startsWith('/api/compact-relay-state'));
  assert.equal(stateCalls.length, 1, '自带 path 时只读本会话，不再向父会话回查');
  assert.equal(
    harness.fetches.some((entry) => String(entry.url).includes(OLD_SESSION_ID)),
    false,
    '父会话未加载/已归档也不影响（根本没请求它）',
  );

  bar.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const docItem = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'doc')[0];
  assert.equal(docItem.props.disabled, false, '自带 path 时查看交接单直接可点');
  assert.ok(!textOf(docItem).includes('暂无交接单'));
});

test('父记录对不上（childId 不是本会话 / 链号不一致）：不采用 path，保持禁用', async () => {
  for (const wrong of [
    { ...CHAIN, childId: 'session-other', path: CHAIN.path },
    { ...CHAIN, ordinal: 99, childId: SESSION_ID, path: CHAIN.path },
  ]) {
    const harness = loadBundle();
    const { path, ...localNoPath } = CHAIN;
    harness.setState({ ok: true, chain: localNoPath, sessionId: SESSION_ID });
    harness.setState({ ok: true, chain: wrong, sessionId: OLD_SESSION_ID }, OLD_SESSION_ID);
    const renderer = harness.mount(SESSION_ID);
    renderer.renderOnce();
    await renderer.settle();
    assert.equal(findByAttr(renderer.tree, 'data-cr-relay-bar').props['data-cr-relay-path'], '');
    findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
    await renderer.settle();
    const docItem = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'doc')[0];
    assert.equal(docItem.props.disabled, true, `父记录 ${JSON.stringify(wrong)} 不应被采用`);
    assert.ok(textOf(docItem).includes('暂无交接单'));
  }
});

test('旧链：「已接力自 交接第 2 次：原名」', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: { ...CHAIN, ordinal: 2, scheme: 'handoff-n' } });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  const bar = findByAttr(renderer.tree, 'data-cr-relay-bar');
  assert.ok(textOf(bar).includes('已接力自 交接第 2 次：原会话标题'), `旧链文案不对：${textOf(bar)}`);
});

test('无 path：查看交接单禁用并提示「暂无交接单」', async () => {
  const harness = loadBundle();
  const { path, ...noPath } = CHAIN;
  harness.setState({ ok: true, chain: noPath });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const docItem = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'doc')[0];
  assert.equal(docItem.props.disabled, true, '无 path 时查看交接单应禁用');
  assert.ok(textOf(docItem).includes('暂无交接单'), `应提示暂无交接单：${textOf(docItem)}`);
});

/* ------------------------------------------------------------------ *
 * 6. 交互
 * ------------------------------------------------------------------ */

test('回到原会话：调用 openSession(parentId) 并关闭菜单', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: CHAIN });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const parentItem = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'parent')[0];
  parentItem.props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.openCalls, [OLD_SESSION_ID], '应把父会话 id 交给 ctx.uiWorkspace.openSession');
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-menu'), null, '点击后菜单应关闭');
});

test('恢复旧会话：已归档 → 先 unarchive(parentId) 再 openSession，并更新本地归档状态', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: CHAIN, parentArchived: true });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const restoreItem = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'unarchive')[0];
  assert.ok(restoreItem !== undefined, '已归档时应出现「恢复旧会话」入口');
  assert.ok(textOf(restoreItem).includes('已归档'), `恢复项应说明当前已归档：${textOf(restoreItem)}`);
  restoreItem.props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.unarchiveCalls, [OLD_SESSION_ID], '应先走 ctx.uiWorkspace.unarchiveSession');
  assert.deepEqual(harness.openCalls, [OLD_SESSION_ID], '恢复后应自动切回旧会话');
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-menu'), null, '恢复成功后菜单关闭');
  assert.equal(
    findByAttr(renderer.tree, 'data-cr-relay-bar').props['data-cr-relay-parent-archived'],
    'false',
    '本地归档状态应更新，恢复入口随之消失',
  );
});

test('未归档：不显示恢复入口，「回到原会话」直接 open', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: CHAIN, parentArchived: false });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const actions = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] !== undefined).map((node) => node.props['data-cr-relay-action']);
  assert.deepEqual(actions, ['doc', 'parent', 'force-archive', 'chain', 'roadmap'], '未归档时不应出现恢复入口（但应有强制归档入口）');
  findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'parent')[0].props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.unarchiveCalls, [], '未归档时不应调用 unarchive');
  assert.deepEqual(harness.openCalls, [OLD_SESSION_ID]);
});

test('老宿主没有 unarchiveSession：恢复入口走 HTTP recover，再切换会话', async () => {
  const harness = loadBundle({ withUnarchive: false });
  harness.setState({ ok: true, chain: CHAIN, parentArchived: true });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'unarchive')[0].props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.actionCalls, [{ action: 'recover', sessionId: OLD_SESSION_ID }], '应走 dcr 自己的 recover 动作');
  assert.deepEqual(harness.openCalls, [OLD_SESSION_ID], 'HTTP 恢复成功后仍应切回旧会话');
});

test('恢复失败（宿主 API 与 HTTP recover 都失败）：提示错误、菜单保持打开、不误切换', async () => {
  const harness = loadBundle({ unarchiveError: true, recoverFails: true });
  harness.setState({ ok: true, chain: CHAIN, parentArchived: true });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'unarchive')[0].props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.unarchiveCalls, [OLD_SESSION_ID], '先走宿主 API');
  assert.deepEqual(harness.actionCalls, [{ action: 'recover', sessionId: OLD_SESSION_ID }], '失败后换 HTTP recover 重试一次');
  assert.deepEqual(harness.openCalls, [], '恢复失败不能假装已恢复并切走');
  const notice = findByAttr(renderer.tree, 'data-cr-relay-notice');
  assert.ok(notice !== null, '应显示恢复失败提示');
  assert.ok(textOf(notice).includes('恢复旧会话失败'), `提示应说明恢复失败：${textOf(notice)}`);
  assert.ok(findByAttr(renderer.tree, 'data-cr-relay-menu') !== null, '失败后菜单保留，用户可重试');
});

test('已归档时点「回到原会话」也先恢复再打开（不让用户撞归档墙）', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: CHAIN, parentArchived: true });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'parent')[0].props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.unarchiveCalls, [OLD_SESSION_ID], '已归档时「回到原会话」应先恢复');
  assert.deepEqual(harness.openCalls, [OLD_SESSION_ID]);
});

test('查看交接单：只用 basename 走已有 handoffs API，并显示交接单内容', async () => {  const harness = loadBundle();
  harness.setState({ ok: true, chain: CHAIN });
  harness.setDoc({ ok: true, name: 'handoff-2026-10-26T09-00-00-000Z.md', path: CHAIN.path, content: '# 交接单\n- 关键结论' });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'doc')[0].props.onClick();
  await renderer.settle();

  const docFetches = harness.fetches.filter((entry) => String(entry.url).includes('/api/compact-relay-handoffs?file='));
  assert.equal(docFetches.length, 1, '应只请求一次交接单');
  const file = decodeURIComponent(docFetches[0].url.split('file=')[1]);
  assert.equal(file, 'handoff-2026-10-26T09-00-00-000Z.md', 'API 只接受 basename，不能把全路径塞进 file=');
  assert.equal(file.includes('/'), false);

  const docPanel = findByAttr(renderer.tree, 'data-cr-relay-doc');
  assert.ok(docPanel !== null, '应出现交接单面板');
  assert.ok(textOf(docPanel).includes('交接单'));
  assert.ok(textOf(docPanel).includes('关键结论'), '交接单 markdown 应渲染出内容');
});

test('Esc / 点外面关闭菜单', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: CHAIN });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  assert.ok(findByAttr(renderer.tree, 'data-cr-relay-menu') !== null);

  harness.fire('keydown', { key: 'Escape' });
  await renderer.settle();
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-menu'), null, 'Esc 应关闭菜单');
});

/* ------------------------------------------------------------------ *
 * 6.5 DCR-03 / DCR-01 客户端：菜单打开刷 state、未知归档也先恢复、失败重试、
 *     没有恢复能力时隐藏入口、父会话出站记录（next）补 path
 * ------------------------------------------------------------------ */

const stateFetchCount = (harness) =>
  harness.fetches.filter((entry) => String(entry.url).startsWith('/api/compact-relay-state')).length;

const actionKeys = (tree) =>
  findAll(tree, (node) => node.props?.['data-cr-relay-action'] !== undefined).map((node) => node.props['data-cr-relay-action']);

test('菜单打开时刷新 state：别处归档的变化会出现在菜单里', async () => {
  const harness = loadBundle();
  // 打开前：宿主报告未归档（没有恢复入口）。
  harness.setState({ ok: true, chain: CHAIN, parentArchived: false, capabilities: { unarchive: true } });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  assert.equal(stateFetchCount(harness), 1);

  // 侧栏/另一个窗口把父会话归档了：readState 已变，但组件还拿着旧状态。
  harness.setState({ ok: true, chain: CHAIN, parentArchived: true, capabilities: { unarchive: true } });
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();

  assert.equal(stateFetchCount(harness), 2, '打开菜单应刷新一次 state，不能沿用打开前的旧归档状态');
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-bar').props['data-cr-relay-parent-archived'], 'true');
  assert.ok(actionKeys(renderer.tree).includes('unarchive'), '刷新后应出现「恢复旧会话」入口（不再是死入口）');
});

test('归档状态未知（parentArchived=null）：点「回到原会话」也先 unarchive 再 open', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: CHAIN, capabilities: { unarchive: true } });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'parent')[0].props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.unarchiveCalls, [OLD_SESSION_ID], '未知状态也要先恢复（unarchive 幂等）');
  assert.deepEqual(harness.openCalls, [OLD_SESSION_ID]);
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-menu'), null, '成功后关闭菜单');
});

test('恢复失败换通道重试：宿主 API 失败 → HTTP recover 成功，仍能切回旧会话', async () => {
  const harness = loadBundle({ unarchiveFailTimes: 1 });
  harness.setState({ ok: true, chain: CHAIN, parentArchived: true, capabilities: { unarchive: true } });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'unarchive')[0].props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.unarchiveCalls, [OLD_SESSION_ID], '宿主 API 失败一次');
  assert.deepEqual(harness.actionCalls, [{ action: 'recover', sessionId: OLD_SESSION_ID }], '换 HTTP recover 通道重试');
  assert.deepEqual(harness.openCalls, [OLD_SESSION_ID], '重试成功后再 open（不在失败时切走）');
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-menu'), null, '重试成功后菜单关闭');
});

test('恢复失败同通道重试：老宿主只有 HTTP recover，第一次失败第二次成功', async () => {
  const harness = loadBundle({ withUnarchive: false, recoverFailTimes: 1 });
  harness.setState({ ok: true, chain: CHAIN, parentArchived: true, capabilities: { unarchive: true } });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'unarchive')[0].props.onClick();
  await renderer.settle();
  assert.equal(harness.actionCalls.length, 2, '只有一条通道时同通道重试一次');
  assert.deepEqual(harness.openCalls, [OLD_SESSION_ID]);
});

test('没有恢复能力（客户端无 unarchiveSession + 服务端 capabilities.unarchive=false）：隐藏恢复入口', async () => {
  const harness = loadBundle({ withUnarchive: false });
  harness.setState({ ok: true, chain: CHAIN, parentArchived: true, capabilities: { unarchive: false } });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  assert.deepEqual(actionKeys(renderer.tree), ['doc', 'parent', 'chain', 'roadmap'], '老宿主没有恢复能力时不显示「恢复旧会话」');
});

test('父会话出站记录（next）补 path：优先 next，不被父会话自己的入站 chain 带偏', async () => {
  const harness = loadBundle();
  const { path, ...localNoPath } = CHAIN;
  harness.setState({ ok: true, chain: localNoPath, sessionId: SESSION_ID });
  // 父会话自己的 chain 是它的入站记录（另一份交接单），next 才是「本会话这一跳」的出站记录。
  harness.setState(
    {
      ok: true,
      sessionId: OLD_SESSION_ID,
      chain: { ordinal: 7, baseTitle: '更早的链', parentId: 'grandparent', childId: OLD_SESSION_ID, scheme: 'history-n', path: '/tmp/handoffs/handoff-grandparent.md' },
      next: { ...CHAIN, parentId: OLD_SESSION_ID, childId: SESSION_ID },
    },
    OLD_SESSION_ID,
  );
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  assert.equal(
    findByAttr(renderer.tree, 'data-cr-relay-bar').props['data-cr-relay-path'],
    CHAIN.path,
    '应从父会话的 next（出站）补回本跳的交接单路径',
  );
});

/* ------------------------------------------------------------------ *
 * 7. 0.5.1 批 2：pin 失效标注 / 原生压缩预警 / 归档开关 + 置顶确认
 * ------------------------------------------------------------------ */

const INDICATOR_BASE = {
  sessionId: SESSION_ID,
  revision: 1,
  pressure: 400,
  window: 100000,
  ratio: 0.004,
  summaries: 0,
  advice: 'none',
  thresholds: { compactAt: 40000, handoffAt: 60000, compactRatio: 0.4, handoffRatio: 0.6 },
  colors: null,
  pins: {
    count: 1,
    seqs: [5],
    marks: [{ seq: 5, ratio: 0.5 }],
    stale: { count: 0, seqs: [], native: 0, other: 0, unknown: 0 },
    atRisk: null,
  },
  compactRange: null,
  compactRangeReason: null,
  busy: false,
  compressHint: null,
  native: {
    autoEnabled: true,
    thresholdRatio: 0.8,
    ratio: 0.75,
    thresholdTokens: 75000,
    contextWindow: 100000,
    headroomTokens: 0,
    overridden: false,
    route: null,
  },
  chain: null,
  parentArchived: null,
  capabilities: { unarchive: true },
  sessionPinned: null,
};

function indicatorState(overrides = {}) {
  return { ...INDICATOR_BASE, ...overrides };
}

async function mountIndicator(harness) {
  const renderer = harness.mountLeft(SESSION_ID);
  await renderer.settle();
  const trigger = findByAttr(renderer.tree, 'data-cr-level');
  assert.ok(trigger !== null, '应渲染指示灯按钮');
  return { renderer, trigger };
}

test('指示灯：锁定已下线——失效/风险 pin 不再出现在悬停卡与菜单（旧记录只读忽略）', async () => {
  const harness = loadBundle();
  harness.setState(
    indicatorState({
      pins: {
        count: 2,
        seqs: [4, 5],
        marks: [
          { seq: 4, ratio: 0.25 },
          { seq: 5, ratio: 0.75 },
        ],
        stale: { count: 2, seqs: [1, 2], native: 2, other: 0, unknown: 0 },
        atRisk: { count: 2, seqs: [4, 5] },
      },
    }),
  );
  const { renderer, trigger } = await mountIndicator(harness);
  // 0.5.3：pin 退役为收藏——环上不画位置块（0.5.1 定稿），失效/风险标注也一并下线。
  assert.equal(findByAttr(renderer.tree, 'data-cr-pin-mark'), null, '有 pin 也不应在环上画位置块');

  trigger.props.onMouseEnter({ currentTarget: rowElement });
  await renderer.settle();
  const tooltip = findByAttr(renderer.tree, 'data-cr-tooltip');
  assert.ok(tooltip !== null, '悬停卡应出现');
  const text = textOf(tooltip);
  for (const word of ['已锁定', '已失效', '锁定消息']) {
    assert.equal(text.includes(word), false, `悬停卡不应再出现「${word}」：${text}`);
  }
  assert.equal(findByAttr(renderer.tree, 'data-cr-pin-stale'), null, '不再渲染失效标注');
  assert.equal(findByAttr(renderer.tree, 'data-cr-pin-risk'), null, '不再渲染原生压缩覆盖预警');

  trigger.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  // 菜单不再有锁定项；也不再有「先交接或解锁」类提示。
  assert.equal(findAll(renderer.tree, (node) => node.props?.['data-cr-item'] === 'pin').length, 0, '菜单不应再有锁定项');
  assert.equal(
    findAll(renderer.tree, (node) => typeof textOf(node) === 'string' && textOf(node).includes('建议先交接（/handoff）')).length,
    0,
    '不应再有让用户去解锁的提示',
  );
});

test('交接预览：置顶会话必须明确选择「交接并归档（取消置顶）」或「只交接，保留置顶」', async () => {
  const harness = loadBundle();
  harness.setState(indicatorState({ sessionPinned: true }));
  const { renderer, trigger } = await mountIndicator(harness);

  trigger.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const handoffItem = findAll(renderer.tree, (node) => node.props?.['data-cr-item'] === 'handoff')[0];
  assert.ok(handoffItem !== undefined, '菜单应有交接入口');
  handoffItem.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await renderer.settle();

  const panel = findByAttr(renderer.tree, 'data-cr-handoff-preview');
  assert.ok(panel !== null, '应打开交接预览');
  const warning = findByAttr(renderer.tree, 'data-cr-handoff-pinned-warning');
  assert.ok(warning !== null, '置顶会话必须弹「归档会取消置顶」提示');
  assert.ok(textOf(warning).includes('归档会取消置顶'), textOf(warning));
  assert.equal(findByAttr(renderer.tree, 'data-cr-handoff-archive').props.checked, true, '归档默认开');
  const runBtn = findByAttr(renderer.tree, 'data-cr-handoff-run');
  assert.ok(textOf(runBtn).includes('交接并归档（取消置顶）'), textOf(runBtn));
  const keepBtn = findByAttr(renderer.tree, 'data-cr-handoff-keep');
  assert.ok(keepBtn !== null, '必须提供「只交接，保留置顶」出口');
  assert.ok(textOf(keepBtn).includes('只交接，保留置顶'));

  runBtn.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const handoffCalls = harness.actionCalls.filter((call) => call.action === 'handoff');
  assert.equal(handoffCalls.length, 1);
  assert.equal(handoffCalls.at(-1).archive, true);
  assert.equal(handoffCalls.at(-1).confirmUnpin, true, '确认归档必须显式带 confirmUnpin（服务端才归档）');
});

test('交接预览：选「只交接，保留置顶」→ archive:false（旧会话不归档、置顶不动）', async () => {
  const harness = loadBundle();
  harness.setState(indicatorState({ sessionPinned: true }));
  const { renderer, trigger } = await mountIndicator(harness);

  trigger.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  findAll(renderer.tree, (node) => node.props?.['data-cr-item'] === 'handoff')[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-handoff-keep').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 5));

  const handoff = harness.actionCalls.filter((call) => call.action === 'handoff').at(-1);
  assert.equal(handoff.archive, false);
  assert.equal(handoff.confirmUnpin, undefined, '不归档就不需要取消置顶确认');
});

test('交接预览：草稿预览框不许被弹窗 flex 压成 0 高（0.5.2 UI 修复回归）', async () => {
  const harness = loadBundle();
  const { renderer, trigger } = await mountIndicator(harness);

  trigger.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  findAll(renderer.tree, (node) => node.props?.['data-cr-item'] === 'handoff')[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await renderer.settle();

  const panel = findByAttr(renderer.tree, 'data-cr-handoff-preview');
  assert.ok(panel !== null, '应打开交接预览');

  // 真机 bug（2026-10-27）：弹窗是 maxHeight 的 flex column，子项默认 flex-shrink:1；
  // 草稿框是 overflow:auto 的滚动容器、自动最小尺寸为 0，于是被压成 14px 高的一条缝
  // （内容高度 0，只剩边框 + padding），九段草稿完全看不见，弹窗自己反而不滚。
  // 结构契约：内容包裹层保持自然高度（flexShrink:0），超出 maxHeight 由弹窗滚动；
  // 草稿框自己也不许被压（防御性 flexShrink:0），内容超出时只在自己的 220 上限内滚。
  const body = findByAttr(renderer.tree, 'data-cr-handoff-body');
  assert.ok(body !== null, '交接预览要有内容包裹层标记 data-cr-handoff-body');
  assert.equal(body.props.style.flexShrink, 0, 'body 必须 flexShrink:0，否则 maxHeight 会把草稿框压没');

  const draft = findByAttr(renderer.tree, 'data-cr-handoff-draft');
  assert.ok(draft !== null, '交接预览要有草稿框标记 data-cr-handoff-draft');
  assert.equal(draft.props.style.flexShrink, 0, '草稿框必须 flexShrink:0（任何 flex 上下文都不许压它）');
  assert.equal(draft.props.style.maxHeight, 220, '草稿框自身的 220 内部滚动上限保持');
  assert.equal(draft.props.style.overflow, 'auto', '草稿内容超出时在框内滚动，而不是撑爆弹窗');
  assert.ok(textOf(draft).includes('完成批 2'), `草稿框要真的渲染出草稿文本：${textOf(draft).slice(0, 120)}`);
});

test('交接预览：取消勾选归档 → 不弹置顶提示，确认按钮变「不归档」', async () => {
  const harness = loadBundle();
  harness.setState(indicatorState({ sessionPinned: true }));
  const { renderer, trigger } = await mountIndicator(harness);

  trigger.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  findAll(renderer.tree, (node) => node.props?.['data-cr-item'] === 'handoff')[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await renderer.settle();

  const checkbox = findByAttr(renderer.tree, 'data-cr-handoff-archive');
  checkbox.props.onChange({ target: { checked: false } });
  await renderer.settle();
  assert.equal(findByAttr(renderer.tree, 'data-cr-handoff-pinned-warning'), null, '不归档就不需要取消置顶确认');
  const runBtn = findByAttr(renderer.tree, 'data-cr-handoff-run');
  assert.ok(textOf(runBtn).includes('确认交接（不归档）'), textOf(runBtn));

  runBtn.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const handoff = harness.actionCalls.filter((call) => call.action === 'handoff').at(-1);
  assert.equal(handoff.archive, false);
});

/* ------------------------------------------------------------------ *
 * 8. 0.5.1 批 3：完整交接链列表 + 父→子入口
 *
 * 完整链的数据是**按需**读来的：点「完整交接链」之前不预加载；每层一次 state GET；
 * 最多 8 跳、按 sessionId 去重防循环；某层读不到就停下并给重试（已读到的行保留），
 * 主菜单其他入口不受影响。
 * ------------------------------------------------------------------ */

const CHAIN_TITLE = '原会话标题';
const ancId = (level) => (level === 0 ? SESSION_ID : `session-anc-${level}`);

/**
 * depth 层祖先链夹具：self(0) → anc-1 → … → anc-depth（根，没有入站记录）。
 * 第 k 层的 state.chain 指向它的父会话（ordinal = 它自己的链号），next 是它交接给
 * 下一代的出站记录 —— 形状与真实 readState 一致（0.5.1 起 chain=入站、next=出站）。
 */
function chainFixture(depth) {
  const states = new Map();
  for (let level = 0; level < depth; level += 1) {
    const ordinal = depth - level;
    const childId = ancId(level);
    const parentId = ancId(level + 1);
    const hop = { ordinal, baseTitle: CHAIN_TITLE, parentId, childId, scheme: 'history-n', path: `/tmp/dcr-handoffs/handoff-hop-${ordinal}.md` };
    states.set(childId, {
      ok: true,
      sessionId: childId,
      chain: hop,
      next: hop,
      nextArchived: false,
      capabilities: { unarchive: true },
    });
  }
  const rootId = ancId(depth);
  states.set(rootId, { ok: true, sessionId: rootId, chain: null, next: null, nextArchived: null, capabilities: { unarchive: true } });
  return states;
}

function applyStates(harness, states) {
  for (const [sessionId, state] of states) harness.setState(state, sessionId);
}

const chainRows = (tree) => findAll(tree, (node) => node.props?.['data-cr-relay-chain-row'] !== undefined);

async function mountBar(harness) {
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();
  return renderer;
}

async function openMenu(harness, renderer) {
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
}

async function openChainView(harness, renderer) {
  await openMenu(harness, renderer);
  findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'chain')[0].props.onClick();
  await renderer.settle();
}

/** 祖先会话的 state GET 次数（不含本会话；菜单打开时会刷一次本会话 state）。 */
const ancestorFetches = (harness) =>
  harness.fetches.filter(
    (entry) => String(entry.url).startsWith('/api/compact-relay-state') && !String(entry.url).endsWith(encodeURIComponent(SESSION_ID)),
  ).length;

test('完整交接链：按需展开才逐级拉，每层一次 state GET，行文案「历史 N：原名」', async () => {
  const harness = loadBundle();
  applyStates(harness, chainFixture(3));
  const renderer = await mountBar(harness);
  assert.equal(stateFetchCount(harness), 1, '没点开完整链之前不预加载祖先（只有本会话一次）');

  await openMenu(harness, renderer);
  assert.equal(ancestorFetches(harness), 0, '只是打开菜单不拉祖先');
  const baseline = stateFetchCount(harness);
  findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'chain')[0].props.onClick();
  await renderer.settle();

  const rows = chainRows(renderer.tree);
  assert.deepEqual(
    rows.map((row) => row.props['data-cr-relay-chain-row']),
    ['session-anc-1', 'session-anc-2', 'session-anc-3'],
    '从近到远逐级列出祖先（根会话没有入站记录，不再往下拉）',
  );
  rows.forEach((row, index) => {
    assert.ok(textOf(row).includes(`历史 ${3 - index}：${CHAIN_TITLE}`), `第 ${index + 1} 行文案不对：${textOf(row)}`);
  });
  assert.equal(ancestorFetches(harness), 3, '展开后每层祖先各 1 次 state GET（3 层）');
  assert.equal(stateFetchCount(harness) - baseline, 3, '展开完整链只多这 3 次请求（不并发、不重复）');

  // 行内交接单入口：每层都带 path → 都可点。
  const docButtons = rows.map((row) => findAll(row, (node) => node.props?.['data-cr-relay-chain-doc'] !== undefined)[0]);
  assert.deepEqual(docButtons.map((button) => button.props.disabled), [false, false, false]);
});

test('完整交接链：最多 8 跳，超出时明说只显示最近 8 层', async () => {
  const harness = loadBundle();
  applyStates(harness, chainFixture(12));
  const renderer = await mountBar(harness);
  await openChainView(harness, renderer);

  const rows = chainRows(renderer.tree);
  assert.equal(rows.length, 8, '上限 8 跳（防万一条路成环/链极长）');
  assert.equal(ancestorFetches(harness), 8, '8 次祖先 state GET，不多拉');
  const capped = findByAttr(renderer.tree, 'data-cr-relay-chain-capped');
  assert.ok(capped !== null, '截断时要有说明，不能假装到头了');
  assert.ok(textOf(capped).includes('8'), `应说明只显示最近 8 层：${textOf(capped)}`);
});

test('完整交接链：链路成环时按 sessionId 去重，不会无限拉', async () => {
  const harness = loadBundle();
  const mk = (id, parentId, ordinal) => ({
    ok: true,
    sessionId: id,
    chain: { ordinal, baseTitle: CHAIN_TITLE, parentId, childId: id, scheme: 'history-n', path: `/tmp/dcr-handoffs/handoff-${ordinal}.md` },
    next: null,
    capabilities: { unarchive: true },
  });
  harness.setState(mk(SESSION_ID, 'session-anc-1', 3), SESSION_ID);
  harness.setState(mk('session-anc-1', 'session-anc-2', 2), 'session-anc-1');
  harness.setState(mk('session-anc-2', 'session-anc-1', 1), 'session-anc-2'); // 指回已经列过的会话

  const renderer = await mountBar(harness);
  await openChainView(harness, renderer);
  assert.deepEqual(
    chainRows(renderer.tree).map((row) => row.props['data-cr-relay-chain-row']),
    ['session-anc-1', 'session-anc-2'],
    '同一条会话只出现一次',
  );
  assert.equal(ancestorFetches(harness), 2, '成环就停：只拉了这 2 层祖先');
});

test('完整交接链：某层读不到 → 「无法读取更早的链路」+ 重试从断点继续，且不影响其他入口', async () => {
  const harness = loadBundle();
  applyStates(harness, chainFixture(3));
  harness.failState('session-anc-2');
  const renderer = await mountBar(harness);
  await openChainView(harness, renderer);

  const error = findByAttr(renderer.tree, 'data-cr-relay-chain-error');
  assert.ok(error !== null, '读不到祖先时要有明确提示');
  assert.ok(textOf(error).includes('无法读取更早的链路'), textOf(error));
  assert.equal(chainRows(renderer.tree).length, 1, '已读到的那一层保留（不整块清空）');
  assert.equal(ancestorFetches(harness), 2, 'anc-1 成功 + anc-2 失败；失败后不再往下拉');

  // 宿主恢复后点「重试」：从断点继续，已经读到的层不重复拉。
  harness.healState('session-anc-2');
  findByAttr(renderer.tree, 'data-cr-relay-chain-retry').props.onClick();
  await renderer.settle();
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-chain-error'), null, '重试成功后错误提示消失');
  assert.equal(chainRows(renderer.tree).length, 3, '剩下的两层补上');
  assert.equal(ancestorFetches(harness), 4, 'anc-1 不重复拉（anc-1、失败的 anc-2、重试的 anc-2 与 anc-3）');

  // 返回主菜单：其他入口照常可用（链读失败不阻断菜单）。
  findByAttr(renderer.tree, 'data-cr-relay-chain-back').props.onClick();
  await renderer.settle();
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-chain'), null, '返回后回到主菜单');
  const parentItem = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'parent')[0];
  assert.ok(parentItem !== undefined && parentItem.props.disabled === false, '「回到原会话」仍可用');
  parentItem.props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.openCalls.slice(-1), ['session-anc-1'], '链读失败不影响跳到原会话');
});

test('完整交接链：祖先未加载 → 「上一层会话未打开」+「打开并继续」（不再只是错误提示）', async () => {
  const harness = loadBundle();
  applyStates(harness, chainFixture(2));
  // 更早的那一层还没加载：宿主回 sessionId=null + chain=null。如果把它当成「没有父会话」
  // 就会静默少列一层 —— 必须停在断点，并给出可操作入口。
  harness.setState({ ok: true, sessionId: null, chain: null, capabilities: { unarchive: true } }, 'session-anc-2');
  const renderer = await mountBar(harness);
  await openChainView(harness, renderer);
  assert.equal(chainRows(renderer.tree).length, 1, '只列真正读到的那一层');
  const error = findByAttr(renderer.tree, 'data-cr-relay-chain-error');
  assert.ok(error !== null, '「没加载」不能当成「到头了」');
  assert.ok(textOf(error).includes('上一层会话未打开'), textOf(error));
  assert.equal(
    error.props['data-cr-relay-chain-blocked'],
    'session-anc-2',
    '错误块要标明断点会话，界面才能给出对应入口',
  );
  const openParent = findByAttr(renderer.tree, 'data-cr-relay-chain-open-parent');
  assert.ok(openParent !== null, '未加载时必须给出「打开并继续」可操作入口');
  assert.equal(openParent.props['data-cr-relay-chain-open-parent'], 'session-anc-2');
  assert.ok(textOf(openParent).includes('打开并继续'));

  // 用户在别处打开那个会话后，手动「重试」仍然可用（保留旧兜底路径）。
  harness.setState(chainFixture(2).get('session-anc-2'), 'session-anc-2');
  findByAttr(renderer.tree, 'data-cr-relay-chain-retry').props.onClick();
  await renderer.settle();
  assert.equal(chainRows(renderer.tree).length, 2, '重试后补齐');
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-chain-error'), null, '成功后续上就不该再有错误提示');
});

test('完整交接链：未加载断点点「打开并继续」→ unarchive + openSession，加载后自动续读', async () => {
  const harness = loadBundle();
  applyStates(harness, chainFixture(2));
  harness.setState({ ok: true, sessionId: null, chain: null, capabilities: { unarchive: true } }, 'session-anc-2');
  const renderer = await mountBar(harness);
  await openChainView(harness, renderer);
  assert.equal(chainRows(renderer.tree).length, 1, '断点前只列已读层');

  // 宿主在 openSession 后把该会话加载进内存（模拟真实切会话）。
  harness.setState(chainFixture(2).get('session-anc-2'), 'session-anc-2');
  findByAttr(renderer.tree, 'data-cr-relay-chain-open-parent').props.onClick();
  await renderer.settle();

  assert.deepEqual(harness.unarchiveCalls, ['session-anc-2'], '先走宿主 unarchive（幂等，未归档是 no-op）');
  assert.deepEqual(harness.openCalls, ['session-anc-2'], '再调用 openSession 打开上一层会话');
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-chain-error'), null, '自动续读成功后错误提示消失');
  assert.equal(chainRows(renderer.tree).length, 2, '自动续读补齐剩余层，不用用户再手点重试');
});

test('完整交接链：服务端整链端点一次读全，不再逐级 GET 祖先 state（祖先未加载也行）', async () => {
  const harness = loadBundle();
  applyStates(harness, chainFixture(2));
  // 服务端已经按持久化日志读完整条链：客户端只发一次整链 GET。
  harness.setChainResponse({
    ok: true,
    sessionId: SESSION_ID,
    done: true,
    capped: false,
    unreadable: null,
    rows: [
      { sessionId: 'session-anc-1', ordinal: 2, baseTitle: CHAIN_TITLE, scheme: 'history-n', path: '/tmp/dcr-handoffs/handoff-hop-2.md' },
      { sessionId: 'session-anc-2', ordinal: 1, baseTitle: CHAIN_TITLE, scheme: 'history-n', path: '/tmp/dcr-handoffs/handoff-hop-1.md' },
    ],
  });
  const renderer = await mountBar(harness);
  await openChainView(harness, renderer);

  const rows = chainRows(renderer.tree);
  assert.deepEqual(
    rows.map((row) => row.props['data-cr-relay-chain-row']),
    ['session-anc-1', 'session-anc-2'],
    '一次拿到整条链（祖先没加载也能列全）',
  );
  assert.equal(ancestorFetches(harness), 0, '不再逐级 GET 祖先的 /api/compact-relay-state');
  const chainCalls = harness.fetches.filter((entry) => String(entry.url).startsWith('/api/compact-relay-chain'));
  assert.equal(chainCalls.length, 1, '整链端点只打一次（不逐级、不重复）');
  assert.ok(String(chainCalls[0].url).includes(`sessionId=${SESSION_ID}`), '整链端点带当前会话 id');
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-chain-error'), null);

  // 行内交接单仍可直接打开（服务端一次带回 path）。
  const docButtons = rows.map((row) => findAll(row, (node) => node.props?.['data-cr-relay-chain-doc'] !== undefined)[0]);
  assert.deepEqual(docButtons.map((button) => button.props.disabled), [false, false]);
});

test('完整交接链：整链端点读取失败 → 已读行保留 +「打开并继续」；not-found 不造死入口', async () => {
  const harness = loadBundle();
  applyStates(harness, chainFixture(2));
  harness.setChainResponse({
    ok: true,
    sessionId: SESSION_ID,
    done: false,
    capped: false,
    unreadable: { sessionId: 'session-anc-2', reason: 'error' },
    rows: [
      { sessionId: 'session-anc-1', ordinal: 2, baseTitle: CHAIN_TITLE, scheme: 'history-n', path: '/tmp/dcr-handoffs/handoff-hop-2.md' },
    ],
  });
  const renderer = await mountBar(harness);
  await openChainView(harness, renderer);
  assert.equal(chainRows(renderer.tree).length, 1, '已读到的层保留');
  const error = findByAttr(renderer.tree, 'data-cr-relay-chain-error');
  assert.ok(error !== null);
  assert.ok(textOf(error).includes('无法读取更早的链路'));
  assert.equal(
    findByAttr(renderer.tree, 'data-cr-relay-chain-open-parent').props['data-cr-relay-chain-open-parent'],
    'session-anc-2',
    '读日志临时失败：打开这一层可能让它变成 live，给出入口',
  );

  // 持久化里根本没有这一层（已删除/从未落盘）：打开也救不回来，只给重试。
  const missingHarness = loadBundle();
  applyStates(missingHarness, chainFixture(2));
  missingHarness.setChainResponse({
    ok: true,
    sessionId: SESSION_ID,
    done: false,
    capped: false,
    unreadable: { sessionId: 'session-anc-2', reason: 'not-found' },
    rows: [
      { sessionId: 'session-anc-1', ordinal: 2, baseTitle: CHAIN_TITLE, scheme: 'history-n', path: '/tmp/dcr-handoffs/handoff-hop-2.md' },
    ],
  });
  const missingRenderer = await mountBar(missingHarness);
  await openChainView(missingHarness, missingRenderer);
  assert.equal(findByAttr(missingRenderer.tree, 'data-cr-relay-chain-open-parent'), null, 'not-found 不应出现必然失败的入口');
  assert.ok(findByAttr(missingRenderer.tree, 'data-cr-relay-chain-retry') !== null, '仍可重试');
});

test('完整交接链：行内交接单只用 basename；本层记录没 path 时用父会话出站记录的 path', async () => {
  const harness = loadBundle();
  // 老记录：本会话与 anc-1 的入站记录都没有 path，路径只写在父会话的出站 next 里。
  harness.setState(
    {
      ok: true,
      sessionId: SESSION_ID,
      chain: { ordinal: 2, baseTitle: CHAIN_TITLE, parentId: 'session-anc-1', childId: SESSION_ID, scheme: 'history-n' },
      capabilities: { unarchive: true },
    },
    SESSION_ID,
  );
  harness.setState(
    {
      ok: true,
      sessionId: 'session-anc-1',
      chain: { ordinal: 1, baseTitle: CHAIN_TITLE, parentId: 'session-anc-2', childId: 'session-anc-1', scheme: 'history-n' },
      next: {
        ordinal: 2,
        baseTitle: CHAIN_TITLE,
        parentId: 'session-anc-1',
        childId: SESSION_ID,
        scheme: 'history-n',
        path: '/tmp/dcr-handoffs/handoff-hop-2.md',
      },
      capabilities: { unarchive: true },
    },
    'session-anc-1',
  );
  harness.setState(
    {
      ok: true,
      sessionId: 'session-anc-2',
      chain: null,
      next: {
        ordinal: 1,
        baseTitle: CHAIN_TITLE,
        parentId: 'session-anc-2',
        childId: 'session-anc-1',
        scheme: 'history-n',
        path: '/tmp/dcr-handoffs/handoff-hop-1.md',
      },
      capabilities: { unarchive: true },
    },
    'session-anc-2',
  );

  const renderer = await mountBar(harness);
  await openChainView(harness, renderer);
  const rows = chainRows(renderer.tree);
  assert.equal(rows.length, 2);
  const docButtons = rows.map((row) => findAll(row, (node) => node.props?.['data-cr-relay-chain-doc'] !== undefined)[0]);
  assert.deepEqual(docButtons.map((button) => button.props.disabled), [false, false], '从父会话出站记录补回 path 后行内交接单可点');

  docButtons[0].props.onClick();
  await renderer.settle();
  const docFetches = harness.fetches.filter((entry) => String(entry.url).includes('/api/compact-relay-handoffs?file='));
  const file = decodeURIComponent(String(docFetches.at(-1).url).split('file=')[1]);
  assert.equal(file, 'handoff-hop-2.md', '接口只接受 basename');
  assert.equal(file.includes('/'), false, '不能把全路径塞进 file=');
  assert.ok(textOf(findByAttr(renderer.tree, 'data-cr-relay-doc')).includes('交接单'));

  findByAttr(renderer.tree, 'data-cr-relay-doc-back').props.onClick();
  await renderer.settle();
  assert.ok(findByAttr(renderer.tree, 'data-cr-relay-chain') !== null, '从交接单返回要回到完整链列表');
  assert.equal(chainRows(renderer.tree).length, 2);
});

test('完整交接链：整条链路都没有交接单路径 → 行内入口禁用并提示「暂无交接单」', async () => {
  const harness = loadBundle();
  harness.setState(
    {
      ok: true,
      sessionId: SESSION_ID,
      chain: { ordinal: 1, baseTitle: CHAIN_TITLE, parentId: 'session-anc-1', childId: SESSION_ID, scheme: 'history-n' },
      capabilities: { unarchive: true },
    },
    SESSION_ID,
  );
  harness.setState(
    { ok: true, sessionId: 'session-anc-1', chain: null, next: null, capabilities: { unarchive: true } },
    'session-anc-1',
  );

  const renderer = await mountBar(harness);
  await openChainView(harness, renderer);
  const row = chainRows(renderer.tree)[0];
  const docButton = findAll(row, (node) => node.props?.['data-cr-relay-chain-doc'] !== undefined)[0];
  assert.equal(docButton.props.disabled, true, '没有 path 时不能给出会必然失败的入口');
  assert.ok(String(docButton.props.title).includes('暂无交接单'), String(docButton.props.title));
});

test('完整交接链：点某一层 → 先 unarchive 再 openSession（旧会话默认已归档，不能撞归档墙）', async () => {
  const harness = loadBundle();
  applyStates(harness, chainFixture(2));
  const renderer = await mountBar(harness);
  await openChainView(harness, renderer);
  const rows = chainRows(renderer.tree);
  assert.equal(rows.length, 2);
  findAll(rows[1], (node) => node.props?.['data-cr-relay-chain-open'] !== undefined)[0].props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.unarchiveCalls, ['session-anc-2'], '先恢复（unarchive 幂等，未归档时是 no-op）');
  assert.deepEqual(harness.openCalls, ['session-anc-2'], '再切到该会话（ctx.uiWorkspace.openSession）');
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-menu'), null, '跳转成功后菜单关闭');
});

const OUTBOUND = {
  ordinal: 2,
  baseTitle: CHAIN_TITLE,
  parentId: SESSION_ID,
  childId: 'session-child-9',
  scheme: 'history-n',
  path: '/tmp/dcr-handoffs/handoff-out.md',
};

test('父→子入口：只有出站记录（chain=null）也显示接力条与「去新会话」', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, sessionId: SESSION_ID, chain: null, next: OUTBOUND, nextArchived: false, capabilities: { unarchive: true } });
  const renderer = await mountBar(harness);

  const bar = findByAttr(renderer.tree, 'data-cr-relay-bar');
  assert.ok(bar !== null, '父会话侧（已把接力棒交给下一代）也要有接力条');
  assert.equal(bar.props['data-cr-relay-next'], 'session-child-9', '出站目标要透到 DOM（调试/测试用）');
  assert.ok(textOf(bar).includes('已交接给新会话'), `父会话侧文案不对：${textOf(bar)}`);

  bar.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  assert.deepEqual(actionKeys(renderer.tree), ['doc', 'next', 'roadmap'], '父会话侧：交接单 + 去新会话 + 路线图占位');
  const nextItem = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'next')[0];
  assert.ok(textOf(nextItem).includes('去新会话'), textOf(nextItem));
  nextItem.props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.openCalls, ['session-child-9'], 'openSession(next.childId)');
  assert.deepEqual(harness.unarchiveCalls, [], 'nextArchived=false → 不需要恢复，直接切');
  assert.equal(findByAttr(renderer.tree, 'data-cr-relay-menu'), null, '跳转成功后菜单关闭');
});

test('父→子入口：next.childId 指回本会话（脏记录/老插件形态）→ 不出「去新会话」', async () => {
  const harness = loadBundle();
  harness.setState({ ok: true, sessionId: SESSION_ID, chain: null, next: { ...OUTBOUND, childId: SESSION_ID }, capabilities: { unarchive: true } });
  const renderer = await mountBar(harness);
  assert.equal(renderer.tree, null, '不能给出「把自己再打开一次」的入口');
});

test('父→子入口：新会话已归档或状态未知 → 先 unarchive 再 open', async () => {
  for (const nextArchived of [true, undefined]) {
    const harness = loadBundle();
    harness.setState({
      ok: true,
      sessionId: SESSION_ID,
      chain: null,
      next: OUTBOUND,
      ...(nextArchived === undefined ? {} : { nextArchived }),
      capabilities: { unarchive: true },
    });
    const renderer = await mountBar(harness);
    findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
    await renderer.settle();
    findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'next')[0].props.onClick();
    await renderer.settle();
    assert.deepEqual(harness.unarchiveCalls, ['session-child-9'], `nextArchived=${String(nextArchived)} 也要先恢复（幂等）`);
    assert.deepEqual(harness.openCalls, ['session-child-9'], '恢复后再切');
  }
});

test('中段会话：既有「回到原会话」也有「去新会话」，还能列出完整链', async () => {
  const harness = loadBundle();
  applyStates(harness, chainFixture(1));
  harness.setState(
    {
      ok: true,
      sessionId: SESSION_ID,
      parentArchived: false,
      nextArchived: false,
      capabilities: { unarchive: true },
      chain: { ordinal: 2, baseTitle: CHAIN_TITLE, parentId: 'session-anc-1', childId: SESSION_ID, scheme: 'history-n', path: '/tmp/dcr-handoffs/handoff-hop-2.md' },
      next: OUTBOUND,
    },
    SESSION_ID,
  );
  const renderer = await mountBar(harness);
  findByAttr(renderer.tree, 'data-cr-relay-bar').props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  assert.deepEqual(
    actionKeys(renderer.tree),
    ['doc', 'next', 'parent', 'force-archive', 'chain', 'roadmap'],
    '两个方向 + 强制归档 + 完整链都在',
  );

  // 菜单已经开着：直接点「完整交接链」，不要再点一次接力条（那会关掉菜单）。
  findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'chain')[0].props.onClick();
  await renderer.settle();
  assert.equal(chainRows(renderer.tree).length, 1, '中段会话只列出它自己的祖先');
  assert.ok(textOf(chainRows(renderer.tree)[0]).includes('历史 2：原会话标题'));
});

/* ------------------------------------------------------------------ *
 * 8.5 0.5.2 L 项：强制归档旧会话（入口 / 二次确认 / stopActivity 透传 / 失败不静默）
 * ------------------------------------------------------------------ */

const forceItemOf = (tree) => findAll(tree, (node) => node.props?.['data-cr-relay-action'] === 'force-archive')[0] ?? null;
const forcePanelOf = (tree) => findByAttr(tree, 'data-cr-force-archive');
const forceActionOf = (tree, attr) => findByAttr(tree, attr);

/** 打开接力条菜单（带 parentArchived / capabilities / parentPinned 等 state 覆盖）。 */
async function mountForceMenu(overrides = {}) {
  const harness = loadBundle();
  harness.setState({ ok: true, chain: CHAIN, ...overrides });
  const renderer = await mountBar(harness);
  await openMenu(harness, renderer);
  return { harness, renderer };
}

test('强制归档入口：旧会话未归档时菜单出现「强制归档旧会话（会停止后台任务）」，且默认不发请求', async () => {
  const { harness, renderer } = await mountForceMenu({
    parentArchived: false,
    capabilities: { unarchive: true, forceArchive: true },
  });

  const item = forceItemOf(renderer.tree);
  assert.ok(item !== null, '未归档的旧会话应给出「强制归档」出路');
  assert.ok(textOf(item).includes('强制归档旧会话（会停止后台任务）'), `入口文案不对：${textOf(item)}`);
  assert.equal(item.props.disabled, false);
  assert.deepEqual(
    harness.actionCalls.filter((call) => call.action === 'force-archive'),
    [],
    '默认不强制：只渲染菜单不能自动归档/停任务',
  );
});

test('强制归档：点入口只出二次确认（不发请求），确认文案明说会停止旧会话上的任务', async () => {
  const { harness, renderer } = await mountForceMenu({ parentArchived: false });

  forceItemOf(renderer.tree).props.onClick();
  await renderer.settle();

  const panel = forcePanelOf(renderer.tree);
  assert.ok(panel !== null, '应出现强制归档确认面板');
  assert.equal(panel.props['data-cr-force-phase'], 'confirm');
  assert.equal(panel.props['data-cr-force-target'], OLD_SESSION_ID, '确认面板要指向旧会话（不是当前会话）');
  assert.ok(textOf(panel).includes('会停止旧会话上正在跑的任务'), `确认文案必须写清破坏性后果：${textOf(panel)}`);
  assert.ok(textOf(panel).includes('强制归档（停止任务）'));
  assert.ok(textOf(panel).includes('默认自动归档'), '要说明默认行为不变（活跃时保留可见）');
  assert.deepEqual(
    harness.actionCalls.filter((call) => call.action === 'force-archive'),
    [],
    '二次确认阶段不能发请求',
  );

  // 取消：回到主列表，仍然什么都不做。
  findByAttr(renderer.tree, 'data-cr-force-cancel').props.onClick();
  await renderer.settle();
  assert.equal(forcePanelOf(renderer.tree), null, '取消后确认面板应关闭');
  assert.ok(forceItemOf(renderer.tree) !== null, '取消后回到主列表，入口还在');
  assert.deepEqual(harness.actionCalls.filter((call) => call.action === 'force-archive'), []);
});

test('强制归档：确认后 POST action=force-archive + confirmStop:true，成功显示现有归档文案并更新状态', async () => {
  const { harness, renderer } = await mountForceMenu({ parentArchived: false });

  forceItemOf(renderer.tree).props.onClick();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-force-run').props.onClick();
  await renderer.settle();

  assert.deepEqual(
    harness.actionCalls.filter((call) => call.action === 'force-archive'),
    [{ action: 'force-archive', sessionId: OLD_SESSION_ID, confirmStop: true }],
    '确认后必须带 confirmStop:true（服务端据此允许 stopActivity）',
  );
  const panel = forcePanelOf(renderer.tree);
  assert.ok(panel !== null, '应出现结果面板');
  assert.equal(panel.props['data-cr-force-phase'], 'done');
  const note = textOf(findByAttr(renderer.tree, 'data-cr-force-note'));
  assert.ok(note.includes('旧会话已归档'), `成功文案沿用 handoffArchiveNoteOf：${note}`);
  assert.ok(note.includes('恢复旧会话'), '成功文案必须告诉用户恢复入口');
  assert.equal(
    findByAttr(renderer.tree, 'data-cr-relay-bar').props['data-cr-relay-parent-archived'],
    'true',
    '成功后本地归档状态更新',
  );

  // 返回主列表：旧会话已归档 → 强制入口消失，恢复入口出现。
  findByAttr(renderer.tree, 'data-cr-force-done-back').props.onClick();
  await renderer.settle();
  assert.equal(forceItemOf(renderer.tree), null, '已归档后不再显示强制归档入口');
  assert.ok(actionKeys(renderer.tree).includes('unarchive'), '已归档后应能恢复旧会话');
});

test('强制归档失败：可读错误留在面板里（不静默、不假装成功），可重试', async () => {
  const { harness, renderer } = await mountForceMenu({ parentArchived: false });
  harness.setForceArchiveResponse({
    status: 500,
    payload: { ok: false, code: 'force-archive', message: '强制归档失败：job runner 不可用' },
  });

  forceItemOf(renderer.tree).props.onClick();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-force-run').props.onClick();
  await renderer.settle();

  const panel = forcePanelOf(renderer.tree);
  assert.equal(panel.props['data-cr-force-phase'], 'error', '失败要停在错误面板，不能静默关闭');
  const errorText = textOf(findByAttr(renderer.tree, 'data-cr-force-error'));
  assert.ok(errorText.includes('强制归档失败'), `必须显示可读错误：${errorText}`);
  assert.ok(errorText.includes('job runner 不可用'), `必须带具体原因：${errorText}`);
  assert.equal(
    findByAttr(renderer.tree, 'data-cr-relay-bar').props['data-cr-relay-parent-archived'],
    'false',
    '失败不能把旧会话标成已归档',
  );

  // 重试：再次发请求（同一目标），仍失败也不崩。
  findByAttr(renderer.tree, 'data-cr-force-retry').props.onClick();
  await renderer.settle();
  assert.equal(
    harness.actionCalls.filter((call) => call.action === 'force-archive').length,
    2,
    '重试应重新发请求',
  );
  assert.equal(forcePanelOf(renderer.tree).props['data-cr-force-phase'], 'error');
});

test('强制归档：旧会话置顶时确认卡写明「归档会取消置顶」，请求带 confirmUnpin:true', async () => {
  const { harness, renderer } = await mountForceMenu({ parentArchived: false, parentPinned: true });

  forceItemOf(renderer.tree).props.onClick();
  await renderer.settle();
  const panel = forcePanelOf(renderer.tree);
  const pinLine = textOf(findByAttr(renderer.tree, 'data-cr-force-pin'));
  assert.ok(pinLine.includes('旧会话已在侧栏置顶'), `置顶提示缺失：${pinLine}`);
  assert.ok(pinLine.includes('归档会同时取消置顶'), `必须说明归档会取消置顶：${pinLine}`);
  assert.ok(textOf(panel).includes('会停止旧会话上正在跑的任务'), '置顶时同样要写清会停止任务');

  findByAttr(renderer.tree, 'data-cr-force-run').props.onClick();
  await renderer.settle();
  assert.deepEqual(
    harness.actionCalls.filter((call) => call.action === 'force-archive'),
    [{ action: 'force-archive', sessionId: OLD_SESSION_ID, confirmStop: true, confirmUnpin: true }],
    '置顶已确认时一并传 confirmUnpin:true',
  );
});

test('强制归档：服务端回报 pinned（状态过期）→ 不假装成功，给「仍然归档（取消置顶）」重发', async () => {
  const { harness, renderer } = await mountForceMenu({ parentArchived: false, parentPinned: false });
  harness.setForceArchiveResponse((body) =>
    body.confirmUnpin === true
      ? { ok: true, status: 'archived', note: '旧会话已归档（可在新会话「恢复旧会话」找回）。' }
      : {
          ok: true,
          status: 'pinned',
          note: '旧会话已置顶，本次未自动归档（归档会取消置顶；如要归档，可在交接确认里选「交接并归档（取消置顶）」，或先取消置顶）。',
        },
  );

  forceItemOf(renderer.tree).props.onClick();
  await renderer.settle();
  findByAttr(renderer.tree, 'data-cr-force-run').props.onClick();
  await renderer.settle();

  const pinnedNote = textOf(findByAttr(renderer.tree, 'data-cr-force-note'));
  assert.ok(pinnedNote.includes('归档会取消置顶'), `置顶文案沿用现有：${pinnedNote}`);
  assert.equal(
    findByAttr(renderer.tree, 'data-cr-relay-bar').props['data-cr-relay-parent-archived'],
    'false',
    'pinned 没有归档，不能标成已归档',
  );

  findByAttr(renderer.tree, 'data-cr-force-unpin').props.onClick();
  await renderer.settle();
  assert.deepEqual(harness.actionCalls.filter((call) => call.action === 'force-archive'), [
    { action: 'force-archive', sessionId: OLD_SESSION_ID, confirmStop: true },
    { action: 'force-archive', sessionId: OLD_SESSION_ID, confirmStop: true, confirmUnpin: true },
  ]);
  assert.ok(textOf(findByAttr(renderer.tree, 'data-cr-force-note')).includes('旧会话已归档'));
});

test('强制归档：宿主明确没有 archiveSession（capabilities.forceArchive=false）→ 隐藏入口', async () => {
  const { renderer } = await mountForceMenu({
    parentArchived: false,
    capabilities: { unarchive: true, forceArchive: false },
  });
  assert.equal(forceItemOf(renderer.tree), null, '宿主没有归档接口时不显示必然失败的入口');
});

test('强制归档：旧会话已归档时不再显示强制入口（只保留恢复）', async () => {
  const { renderer } = await mountForceMenu({ parentArchived: true });
  assert.equal(forceItemOf(renderer.tree), null);
  assert.ok(actionKeys(renderer.tree).includes('unarchive'));
});

/* ------------------------------------------------------------------ *
 * 8c. 0.6 压缩预览卡收藏区
 *   汇总行「本段 N 条 · 已收藏 M 条 · 建议补 K 条」/ 已收藏条目 [用户][助手] /
 *   建议补收藏条目（role·reason：snippet + 收藏按钮）/ 点收藏走 favorite-mark。
 *   红线：打开卡片不自动收藏（不点按钮零请求）；失败不假装成功、只在卡内轻提示。
 * ------------------------------------------------------------------ */

/** 打开「确认压缩」卡：state 需要 compactRange 才能点菜单里的压缩入口。 */
async function openCompactPreview(harness) {
  harness.setState(indicatorState({ compactRange: { nodes: 5, tokens: 1200 } }));
  const { renderer, trigger } = await mountIndicator(harness);
  trigger.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const compactItem = findAll(renderer.tree, (node) => node.props?.['data-cr-item'] === 'compact')[0];
  assert.ok(compactItem !== undefined, '菜单应有压缩入口');
  compactItem.props.onClick();
  await renderer.settle();
  assert.ok(findByAttr(renderer.tree, 'data-cr-preview') !== null, '应打开压缩预览卡');
  return renderer;
}

const favoriteMarkCalls = (harness) => harness.actionCalls.filter((call) => call.action === 'favorite-mark');

test('压缩预览卡收藏区：汇总行/已收藏条目/建议补列表齐全，打开卡片不自动收藏', async () => {
  const harness = loadBundle();
  const renderer = await openCompactPreview(harness);

  const summary = findByAttr(renderer.tree, 'data-cr-favorite-summary');
  assert.ok(summary !== null, '收藏区要有汇总行');
  assert.equal(textOf(summary), '本段 5 条 · 已收藏 2 条 · 建议补 1 条');

  const favoritedRows = findAll(renderer.tree, (node) => node.props?.['data-cr-favorite-item'] !== undefined);
  assert.deepEqual(
    favoritedRows.map((node) => node.props['data-cr-favorite-item']),
    ['1', '4'],
    '已收藏条目按 seq 渲染',
  );
  assert.equal(textOf(favoritedRows[0]), '[用户] 不要改 lib/api.js 的公开接口…', '用户条目显示 [用户] + 标题片段');
  assert.equal(textOf(favoritedRows[1]), '[助手] 决定采用方案 B（事件驱动替代轮询）…', '助手条目显示 [助手] + 标题片段');

  const suggestRow = findByAttr(renderer.tree, 'data-cr-favorite-suggest-row');
  assert.ok(suggestRow !== null, '建议补收藏要有条目');
  const suggestText = textOf(suggestRow);
  assert.equal(suggestText.includes('[助手]'), true, '建议条目显示角色');
  assert.equal(suggestText.includes('报错堆栈'), true, '建议条目显示推荐理由');
  assert.equal(suggestText.includes('TypeError: cb is not a function'), true, '建议条目显示摘要');
  const markButton = findByAttr(renderer.tree, 'data-cr-favorite-mark');
  assert.equal(textOf(markButton), '收藏', '每条建议带「收藏」按钮');

  // 红线：只提示、绝不自动收藏——没点按钮就不能有 favorite-mark 请求。
  assert.deepEqual(favoriteMarkCalls(harness), [], '打开预览卡不得自动收藏');
});

test('压缩预览卡收藏区：点「收藏」→ favorite-mark(sessionId,seq) → 行变「已收藏 ✓」+计数更新', async () => {
  const harness = loadBundle();
  const renderer = await openCompactPreview(harness);

  findByAttr(renderer.tree, 'data-cr-favorite-mark').props.onClick();
  await renderer.settle();

  assert.deepEqual(
    favoriteMarkCalls(harness),
    [{ action: 'favorite-mark', sessionId: SESSION_ID, seq: 2, active: true }],
    '按 sessionId+seq 收藏；active:true 只加不切换（预览数据过期也不会误取消）',
  );
  assert.equal(findByAttr(renderer.tree, 'data-cr-favorite-mark'), null, '成功后按钮收起');
  const done = findByAttr(renderer.tree, 'data-cr-favorite-done');
  assert.ok(done !== null, '该行要变成「已收藏 ✓」');
  assert.equal(textOf(done), '已收藏 ✓');
  assert.equal(textOf(findByAttr(renderer.tree, 'data-cr-favorite-summary')), '本段 5 条 · 已收藏 3 条 · 建议补 0 条');
  const favoritedRows = findAll(renderer.tree, (node) => node.props?.['data-cr-favorite-item'] !== undefined);
  assert.equal(favoritedRows.length, 3, '刚收藏的条目要补进「本段已收藏」列表');
  assert.equal(textOf(favoritedRows[2]).includes('TypeError: cb is not a function'), true);
});

test('压缩预览卡收藏区：收藏失败 → 卡内轻提示、不假装成功、可重试', async () => {
  const harness = loadBundle();
  harness.setFavoriteMarkResponse({
    status: 400,
    payload: { ok: false, message: '这条工作的收藏已达上限 500 条，先取消一些' },
  });
  const renderer = await openCompactPreview(harness);

  findByAttr(renderer.tree, 'data-cr-favorite-mark').props.onClick();
  await renderer.settle();
  const error = findByAttr(renderer.tree, 'data-cr-favorite-error');
  assert.ok(error !== null, '失败要在卡内给轻提示');
  assert.equal(textOf(error).includes('已达上限'), true, '提示要用宿主给的原因');
  assert.equal(findByAttr(renderer.tree, 'data-cr-favorite-done'), null, '失败不能显示已收藏');
  assert.equal(textOf(findByAttr(renderer.tree, 'data-cr-favorite-summary')), '本段 5 条 · 已收藏 2 条 · 建议补 1 条', '失败不改计数');

  // 重试：换成成功后提示消失、行变已收藏。
  harness.setFavoriteMarkResponse({ ok: true, active: true, seq: 2, count: 3, message: '已收藏第 2 条' });
  findByAttr(renderer.tree, 'data-cr-favorite-mark').props.onClick();
  await renderer.settle();
  assert.equal(findByAttr(renderer.tree, 'data-cr-favorite-error'), null, '重试成功后提示消失');
  assert.ok(findByAttr(renderer.tree, 'data-cr-favorite-done') !== null);
  assert.equal(favoriteMarkCalls(harness).length, 2);
});

test('压缩预览卡收藏区：老宿主没有 favoritePreview 字段 → 不渲染收藏区（既有确认流程不受影响）', async () => {
  const harness = loadBundle();
  harness.setCompactPreviewResponse({
    ok: true,
    planId: 'plan-old-host',
    preview: { nodes: 3, tokens: 900, startSeq: 1, endSeq: 3, planId: 'plan-old-host', tooSmall: false },
  });
  const renderer = await openCompactPreview(harness);

  assert.equal(findByAttr(renderer.tree, 'data-cr-favorite-preview'), null, '老宿主没有新字段就不渲染收藏区');
  assert.ok(findByAttr(renderer.tree, 'data-cr-confirm-run') !== null, '确认压缩按钮照常可用（契约没被破坏）');
  assert.deepEqual(favoriteMarkCalls(harness), [], '不渲染收藏区时也不会偷偷发收藏请求');
});

test('压缩预览卡收藏区（0.5.4）：工具条目保留在已收藏列表、无正文标题显示「第 N 条」', async () => {
  const harness = loadBundle();
  // 服务端 0.5.4：建议已过滤工具角色；收藏条目保留工具（用户可能真收藏了），无正文标题换成「第 N 条」。
  harness.setCompactPreviewResponse({
    ok: true,
    planId: 'plan-054',
    preview: {
      nodes: 3,
      tokens: 900,
      startSeq: 1,
      endSeq: 3,
      planId: 'plan-054',
      tooSmall: false,
      favoritePreview: {
        total: 3,
        favoritedCount: 2,
        favorited: [
          { seq: 9, role: '工具', title: '第 9 条' },
          { seq: 10, role: '助手', title: '决定采用方案 B' },
        ],
        suggest: [{ seq: 11, role: '用户', reason: '明确要求别改', snippet: '不要动 lib/api.js 的公开接口' }],
      },
    },
  });
  const renderer = await openCompactPreview(harness);

  assert.equal(textOf(findByAttr(renderer.tree, 'data-cr-favorite-summary')), '本段 3 条 · 已收藏 2 条 · 建议补 1 条');
  const favoritedRows = findAll(renderer.tree, (node) => node.props?.['data-cr-favorite-item'] !== undefined);
  assert.equal(textOf(favoritedRows[0]), '[工具] 第 9 条', '工具条目保留，无正文标题显示「第 N 条」而不是「（无文本）」');
  assert.equal(textOf(favoritedRows[1]), '[助手] 决定采用方案 B');
  const suggestText = textOf(findByAttr(renderer.tree, 'data-cr-favorite-suggest-row'));
  assert.equal(suggestText.includes('[用户]'), true, '建议区只渲染服务端给的用户/助手候选');
  assert.equal(suggestText.includes('[工具]'), false, '建议区不出现工具角色');
});

/* ------------------------------------------------------------------ *
 * 9b. 0.5.5 收藏星标常亮（用户反馈：收藏后星标随 hover 动作行一起消失）
 *   根因：宿主动作行默认 opacity:0，星标数据/属性都在、只是整行透明。
 *   修复：注入 CSS，用 :has() 只让「含已收藏星标的动作行」常亮，且非 hover 时只露星标。
 *   这里锁住：CSS 契约（选择器/作用范围/不依赖哈希类名）+ 星标 aria-pressed 状态。
 * ------------------------------------------------------------------ */

test('收藏星标常亮（0.5.5）：注入 CSS 用 :has() 只让含已收藏星标的动作行可见', async () => {
  const harness = loadBundle();
  const style = harness.favoriteStyle();
  assert.ok(style !== null, '应注入 <style id="dcr-favorite-style">');
  const css = String(style.textContent).replace(/\s+/gu, ' ');
  assert.equal(css.includes('@media (hover: hover)'), true, '只在有 hover 的设备上生效（触屏本来就常显）');
  assert.equal(css.includes('opacity: 1 !important'), true, '要覆盖宿主非 hover 时的 opacity:0');
  assert.equal(css.includes('button.dcr-favorite-star[aria-pressed="true"]'), true, '只对已收藏的星标生效（未收藏走宿主 hover 规则）');
  assert.equal(css.includes('[data-actions-reveal="hover"]'), true, '可见性开关用宿主稳定属性，不用哈希类名');
  assert.equal(css.includes('[data-slot="conversation.chat.assistant-actions"]'), true, '用 slot 契约锚定动作行（宿主类名哈希不影响）');
  assert.equal(css.includes(':has('), true, '靠 :has() 从星标反选到宿主动作行');
  assert.equal(css.includes(':not(:hover):not(:focus-within)'), true, '非 hover / 非键盘焦点时才收起其它按钮');
  assert.equal(css.includes('pointer-events: none'), true, '被隐藏的其它按钮不留隐形可点区域');
  assert.equal(/[A-Za-z0-9]{5,}_actions/.test(css), false, 'CSS 不能依赖宿主哈希类名（会随构建变）');
  assert.equal(css.includes('.dcr-favorite-star:hover'), true, '原有星标 hover 样式保留');
});

test('收藏星标常亮（0.5.5）：已收藏消息的星标 aria-pressed=true（CSS 选择器依赖该状态）', async () => {
  const harness = loadBundle();
  harness.setState({
    ok: true,
    sessionId: SESSION_ID,
    favorites: { count: 1, kind: 'seq', seqs: [3], messageIds: ['msg-fav-1'] },
  });
  const renderer = harness.mountFavoriteStar(SESSION_ID, 'msg-fav-1');
  await renderer.settle();
  const star = findAll(renderer.tree, (node) => node.props?.['aria-pressed'] !== undefined)[0];
  assert.ok(star !== undefined, '已收藏消息应渲染星标');
  assert.equal(star.props.className, 'dcr-favorite-star');
  assert.equal(star.props['aria-pressed'], 'true', '已收藏 → aria-pressed=true（常亮 CSS 的选择器锚点）');
  assert.equal(star.props.title, '取消收藏');

  // 未收藏消息：aria-pressed=false → 不命中常亮规则。
  const other = harness.mountFavoriteStar(SESSION_ID, 'msg-not-fav');
  await other.settle();
  const plainStar = findAll(other.tree, (node) => node.props?.['aria-pressed'] !== undefined)[0];
  assert.ok(plainStar !== undefined);
  assert.equal(plainStar.props['aria-pressed'], 'false');
  assert.equal(plainStar.props.title, '收藏这条');
});

/* ------------------------------------------------------------------ *
 * 8d. 0.5.6-B 泄压阀可见化（C1–C4）
 *   悬停卡/菜单头/压缩项 note 三处同一句「再压一次就到上限…之后每次…」或
 *   「本次压缩就会…」；确认卡只在本次真的合并时出现 [data-cr-merge-warning]。
 *   红线：正常态（还剩 ≥2 次常规压缩 / 老宿主无 merge 字段）零噪音。
 * ------------------------------------------------------------------ */

const mergeOf = (overrides = {}) => ({ merges: false, normalLeft: 3, summaries: 3, maxSummaries: 6, ...overrides });

const compactItemOf = (tree) => findAll(tree, (node) => node.props?.['data-cr-item'] === 'compact')[0] ?? null;
/** 压缩项说明在 item 的最后一个孩子（非 oneLine 行：label + note）。 */
const itemNoteText = (item) => (item === null ? '' : textOf(item.children[item.children.length - 1]));

async function openIndicatorMenu(harness, state) {
  harness.setState(indicatorState(state));
  const { renderer, trigger } = await mountIndicator(harness);
  trigger.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  return { renderer, trigger };
}

test('C1 泄压阀 max−1：悬停卡/菜单头「再压一次就到上限…之后每次」，压缩项标「最后 1 次常规压缩」', async () => {
  const harness = loadBundle();
  harness.setState(indicatorState({ compactRange: { nodes: 5, tokens: 1200, merge: mergeOf({ normalLeft: 1, summaries: 5 }) } }));
  const { renderer, trigger } = await mountIndicator(harness);

  trigger.props.onMouseEnter({ currentTarget: rowElement });
  await renderer.settle();
  const tooltipText = textOf(findByAttr(renderer.tree, 'data-cr-tooltip'));
  assert.ok(tooltipText.includes('再压一次就到上限'), `悬停卡要提示「再压一次就到上限」：${tooltipText}`);
  assert.ok(tooltipText.includes('全量合并'), `悬停卡要明说全量合并旧摘要：${tooltipText}`);
  assert.ok(tooltipText.includes('之后每次'), '文案必须是「之后每次」而不是「下一次」');
  assert.equal(tooltipText.includes('下一次'), false, '文案不许出现「下一次」（阀是单向棘轮）');

  trigger.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const menuHint = findByAttr(renderer.tree, 'data-cr-merge-hint');
  assert.ok(menuHint !== null, '菜单头应出现泄压阀提示（data-cr-merge-hint）');
  const menuHintText = textOf(menuHint);
  assert.ok(menuHintText.includes('再压一次就到上限'));
  assert.ok(menuHintText.includes('之后每次'));
  assert.equal(
    itemNoteText(compactItemOf(renderer.tree)).startsWith('最后 1 次常规压缩'),
    true,
    `压缩项 note 要事先说明这是最后一次常规压缩：${itemNoteText(compactItemOf(renderer.tree))}`,
  );
});

test('C2 已到上限：悬停卡/菜单头「本次压缩就会…」，压缩项标「⚠ 全量合并」', async () => {
  const harness = loadBundle();
  harness.setState(
    indicatorState({ compactRange: { nodes: 18, tokens: 1800, merge: mergeOf({ merges: true, normalLeft: 0, summaries: 6 }) } }),
  );
  const { renderer, trigger } = await mountIndicator(harness);

  trigger.props.onMouseEnter({ currentTarget: rowElement });
  await renderer.settle();
  const tooltipText = textOf(findByAttr(renderer.tree, 'data-cr-tooltip'));
  assert.ok(tooltipText.includes('本次压缩就会'), `已到上限要说「本次」：${tooltipText}`);
  assert.ok(tooltipText.includes('合并全部旧摘要'));
  assert.equal(tooltipText.includes('下一次'), false);

  trigger.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const menuHintText = textOf(findByAttr(renderer.tree, 'data-cr-merge-hint'));
  assert.ok(menuHintText.includes('本次压缩就会'));
  assert.equal(
    itemNoteText(compactItemOf(renderer.tree)).startsWith('⚠ 全量合并'),
    true,
    `合并时压缩项要有醒目前缀：${itemNoteText(compactItemOf(renderer.tree))}`,
  );
});

test('C3 确认卡警示块：只有本次真的合并才出现（data-cr-merge-warning）；老宿主无字段不显示且可确认', async () => {
  const basePreview = { nodes: 18, tokens: 1800, startSeq: 3, endSeq: 30, planId: 'p1', tooSmall: false };

  // ① 本次合并 → 醒目警示块（语义：范围变大 + 不可逆 + 先交接）。
  const mergedHarness = loadBundle();
  mergedHarness.setCompactPreviewResponse({
    ok: true,
    planId: 'p1',
    preview: { ...basePreview, merge: mergeOf({ merges: true, normalLeft: 0, summaries: 6 }) },
  });
  const mergedRenderer = await openCompactPreview(mergedHarness);
  const warning = findByAttr(mergedRenderer.tree, 'data-cr-merge-warning');
  assert.ok(warning !== null, '合并压缩时确认卡应有 [data-cr-merge-warning]');
  const warningText = textOf(warning);
  for (const token of ['从会话开头', '6/6', '交接']) {
    assert.ok(warningText.includes(token), `警示块必须包含「${token}」：${warningText}`);
  }
  assert.equal(findByAttr(mergedRenderer.tree, 'data-cr-confirm-run').props.disabled, false, '警示块不改变确认按钮可用性');

  // ② 本次不合并（还剩 2 次常规）→ 不出现警示块。
  const regularHarness = loadBundle();
  regularHarness.setCompactPreviewResponse({
    ok: true,
    planId: 'p1',
    preview: { ...basePreview, merge: mergeOf({ normalLeft: 2, summaries: 4 }) },
  });
  const regularRenderer = await openCompactPreview(regularHarness);
  assert.equal(findByAttr(regularRenderer.tree, 'data-cr-merge-warning'), null, '常规压缩不能出现警示块');

  // ③ 老宿主（没有 merge 字段）→ 不出现、不报错，确认照常可点。
  const legacyHarness = loadBundle();
  legacyHarness.setCompactPreviewResponse({ ok: true, planId: 'p1', preview: { ...basePreview } });
  const legacyRenderer = await openCompactPreview(legacyHarness);
  assert.equal(findByAttr(legacyRenderer.tree, 'data-cr-merge-warning'), null, '老宿主没有 merge 字段时整块不渲染');
  const legacyRun = findByAttr(legacyRenderer.tree, 'data-cr-confirm-run');
  assert.notEqual(legacyRun.props.disabled, true, '老宿主确认按钮不能被新字段禁用');
  legacyRun.props.onClick();
  await legacyRenderer.settle();
  assert.ok(
    legacyHarness.actionCalls.some((call) => call.action === 'compact'),
    '老宿主点确认仍应照常发压缩请求（向后兼容）',
  );
});

test('C4 正常会话零噪音：还剩 ≥2 次常规压缩 / 老宿主无 merge → 不出现任何合并提示', async () => {
  // ① normalLeft >= 2（正常态）。
  const harness = loadBundle();
  harness.setState(indicatorState({ compactRange: { nodes: 5, tokens: 1200, merge: mergeOf({ normalLeft: 2, summaries: 4 }) } }));
  const { renderer, trigger } = await mountIndicator(harness);
  trigger.props.onMouseEnter({ currentTarget: rowElement });
  await renderer.settle();
  const tooltipText = textOf(findByAttr(renderer.tree, 'data-cr-tooltip'));
  assert.equal(tooltipText.includes('合并'), false, `正常态悬停卡不能提合并：${tooltipText}`);

  trigger.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  assert.equal(findByAttr(renderer.tree, 'data-cr-merge-hint'), null, '正常态菜单头不出现泄压阀提示');
  assert.equal(itemNoteText(compactItemOf(renderer.tree)).includes('合并'), false, '正常态压缩项 note 不出现合并字样');

  // ② 老宿主（compactRange 无 merge 字段）→ 同样零噪音、不渲染空节点。
  const legacyHarness = loadBundle();
  const legacy = await openIndicatorMenu(legacyHarness, { compactRange: { nodes: 5, tokens: 1200 } });
  assert.equal(findByAttr(legacy.renderer.tree, 'data-cr-merge-hint'), null, '老宿主没有 merge 字段时菜单不出现提示');
  assert.equal(itemNoteText(compactItemOf(legacy.renderer.tree)).includes('合并'), false);
});

/* ------------------------------------------------------------------ *
 * 9. 执行
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

console.log(`\nrelay-bar：${passed}/${cases.length} 通过`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}\n${failure.error && failure.error.stack ? failure.error.stack : failure.error}`);
  }
  process.exit(1);
}
// 组件里还有轮询/引导/toast 的浏览器定时器（真实页面会一直活着）；单测跑完显式退出。
process.exit(0);
