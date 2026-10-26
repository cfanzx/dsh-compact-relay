/**
 * 0.5.0 接力条 v1 —— `conversation.input.dock` 的组件级测试。
 *
 *   node test/relay-bar.mjs
 *
 * 锁住四层：
 *   1. 客户端产物：`conversation.input.dock` 注册 + 接力条标记真的进了 lib/client.js；
 *   2. 显示条件：chain 非 null 且是本会话入站记录才渲染；无 chain / 老宿主没有
 *      chain 字段 / 出站记录 → 返回 null（不占高度）；
 *   3. 文案与菜单：新链「历史 N：原名」、旧链「交接第 N 次：原名」；菜单三项
 *      （查看交接单 / 回到原会话 / 路线图占位），无 path 时「查看交接单」禁用并显示
 *      「暂无交接单」；
 *   4. 交互与定位：点这一行→ fixed + 向上弹的菜单（bottom 定位、z-index 顶层），
 *      回到原会话调用注入的 openSession(parentId)，交接单走
 *      `/api/compact-relay-handoffs?file=<basename>`（不是全路径）。
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

function loadBundle() {
  const react = createReactFacade();
  const registered = {};
  const exported = {};
  const fetches = [];
  const listeners = {};
  const stateResponses = new Map();
  let stateResponse = { ok: true, chain: null };
  let docResponse = { ok: true, name: 'handoff-x.md', path: '/tmp/handoffs/handoff-x.md', content: '# 交接单\n- 条目' };

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
    if (typeof url === 'string' && url.startsWith('/api/compact-relay-state')) {
      const sessionId = decodeURIComponent((url.split('sessionId=')[1] ?? ''));
      const response = stateResponses.has(sessionId) ? stateResponses.get(sessionId) : stateResponse;
      // 允许用函数给出「第 N 次请求」的响应（测会话尚未加载时的重试）。
      return Promise.resolve(jsonResponse(200, typeof response === 'function' ? response() : response));
    }
    if (typeof url === 'string' && url.startsWith('/api/compact-relay-handoffs?file=')) return Promise.resolve(jsonResponse(200, docResponse));
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
    sessions: { list: { getSnapshot: () => ({ byId: {} }) }, refresh() {} },
    uiWorkspace: {
      openSession(sessionId) {
        openCalls.push(sessionId);
      },
    },
  };
  exported.module.apply(ctx);

  function setState(response, forSessionId) {
    if (typeof forSessionId === 'string') stateResponses.set(forSessionId, response);
    else stateResponse = response;
  }
  function setDoc(response) {
    docResponse = response;
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
  return { registered, sandbox, fetches, openCalls, setState, setDoc, mount, fire };
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
    '路线图（即将上线）',
    '暂无交接单',
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
  harness.setState({ ok: true, chain: CHAIN });
  const renderer = harness.mount(SESSION_ID);
  renderer.renderOnce();
  await renderer.settle();

  const bar = findByAttr(renderer.tree, 'data-cr-relay-bar');
  assert.ok(bar !== null, '有链时应渲染接力条');
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

  // 三个入口，顺序与文案固定。
  const actions = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] !== undefined).map((node) => node.props['data-cr-relay-action']);
  assert.deepEqual(actions, ['doc', 'parent', 'roadmap']);
  const roadmapItem = findAll(renderer.tree, (node) => node.props?.['data-cr-relay-action'] === 'roadmap')[0];
  assert.ok(textOf(roadmapItem).includes('路线图（即将上线）'));
  assert.equal(roadmapItem.props.disabled, true, '路线图占位不可点');
  assert.equal(roadmapItem.props.onClick(), undefined);
});

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

test('查看交接单：只用 basename 走已有 handoffs API，并显示交接单内容', async () => {
  const harness = loadBundle();
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
 * 7. 执行
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
