/**
 * 0.4.2 设置页 UX 修复 —— 保存失败可见 + 粘性保存工具条。
 *
 *   node test/settings-ux.mjs
 *
 * 真机反馈（2026-10-25）：
 *   1. 交接线填 65（上限 62）点保存「没有显示保存失败」——保存失败必须出现在视线内；
 *   2. 设置页很长，保存按钮在页面最底部——改成粘性底部工具条。
 *
 * 本测试锁四层（零依赖，不引 jsdom / React）：
 *   1. 客户端产物：粘性工具条、可见错误状态、交接线行内错误都真的进了 bundle；
 *   2. 手工渲染：用一个极简 React 替身把真实 `CompactRelaySettings` 组件跑起来
 *      （state / effect / ref / callback + 事件），断言：
 *        - 保存 POST 带 nativeRatio（state.native.ratio 透传）；
 *        - 服务端 400 + field 后，错误文案同时出现在粘性条和交接线行内；
 *        - 粘性工具条 position:sticky / bottom:0，含未保存指示 + 保存 + 恢复默认；
 *   3. HTTP 路由：真实 `registerHttp` 的 /api/compact-relay-settings 把 body.nativeRatio
 *      透传给 settings.save()（带 → 65% 拒绝并给 62%；不带 → 0.4.1 兼容放行）；
 *   4. 服务端拒绝时不落盘（设置文件都没生成）。
 *
 * 只写临时目录（os.tmpdir()），不碰 ~/.dsh。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { createSettingsStore } from '../lib/actions/settings.js';
import { registerHttp } from '../lib/adapters/http.js';
import { handoffGuard } from '../lib/core/handoff-guard.js';
import { readNativeCompaction } from '../lib/dsh/native-compaction.js';

const repoRoot = new URL('../', import.meta.url);

/* ------------------------------------------------------------------ *
 * 0. 隔离 profile：native 配置按 80% 阈值 + 自动压缩开启
 * ------------------------------------------------------------------ */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-settings-ux-'));
const profileDir = path.join(tmpRoot, 'profile');
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(
  path.join(profileDir, 'cordis.patch.yml'),
  ['- id: compaction-basic', '  config:', '    auto: true', '    thresholdRatio: 0.8', ''].join('\n'),
  'utf8',
);
// resolveProfileDir 会扫描 argv 里带 cordis.patch.yml 的目录（与 handoff-guard.mjs 同法）。
process.argv.push(profileDir);
assert.equal(readNativeCompaction().autoEnabled, true, '测试 profile 应被识别');

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/* ------------------------------------------------------------------ *
 * 1. 极简 React 替身 + 手工渲染
 * ------------------------------------------------------------------ */

const flatten = (nodes) =>
  nodes.flat(Infinity).filter((node) => node !== null && node !== undefined && node !== false && node !== true);

/**
 * 一个稳定的 React façade：hooks 读写「当前挂载实例」的槽位。
 * 不是 React 的替代品——它把组件当普通函数调用，effect 在渲染后同步跑，
 * 事件处理器由测试手动触发（够验证设置页的状态与渲染路径）。
 */
function createReactFacade() {
  let active = null;
  const depsEqual = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

  return {
    /** 切换到某个挂载实例（每次 render 前调用）。 */
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

/** 挂载一个组件函数（真实组件，不 mock 业务代码）。 */
function mountComponent(Component, react) {
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
    tree = Component();
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

/**
 * 用真实 lib/client.js（DSH 的模块加载器 IIFE）跑设置栏组件；
 * 只替换 React 与浏览器 API，业务代码原样执行。
 */
function loadBundle() {
  const bundle = fs.readFileSync(new URL('lib/client.js', repoRoot), 'utf8');
  const react = createReactFacade();
  const registered = {};
  const exported = {};

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
    navigator: { clipboard: { writeText: async () => {} } },
    document: { body: {} },
    getComputedStyle: () => ({ backgroundColor: 'rgb(255,255,255)', color: 'rgb(31,35,41)' }),
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init === undefined ? undefined : init.detail;
      }
    },
  };
  sandbox.window = sandbox;
  sandbox.open = () => {};
  sandbox.dispatchEvent = () => true;
  // fetch 由每个用例在挂载前替换。
  sandbox.fetch = (...args) => sandbox.__fetch(...args);
  sandbox.__fetch = async () => {
    throw new Error('测试未注入 fetch');
  };
  sandbox.__ModuleLoader__ = {
    load(entry) {
      exported.module = entry.factory(() => react);
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox, { filename: 'lib/client.js' });
  assert.ok(exported.module !== null && typeof exported.module.apply === 'function', 'client bundle 应导出 apply');

  const ctx = {
    slots: {
      inject(name, factory) {
        factory();
      },
      register(meta, component) {
        registered[meta.name] = component;
        return () => {};
      },
    },
    sessions: { list: { getSnapshot: () => ({ byId: {} }) }, refresh() {} },
    uiWorkspace: { openSession() {} },
  };
  exported.module.apply(ctx);
  const Component = registered['settings.section'];
  assert.equal(typeof Component, 'function', '设置栏应注册 settings.section');
  return { Component, react, sandbox };
}

const { Component, react, sandbox } = loadBundle();

/* ------------------------------------------------------------------ *
 * 2. 测试数据 / fetch 替身
 * ------------------------------------------------------------------ */

const BASE_CONFIG = {
  thresholds: { minRatio: 0.05, compactRatio: 0.4, handoffRatio: 0.6, maxSummaries: 6 },
  retention: { recentTailTokens: 40000 },
  handoffDir: '/tmp/relay-settings-ux-handoffs',
  colors: {
    mode: 'auto',
    autoAdapt: true,
    base: { idle: '#6F7680', stage: '#2563EB', compact: '#C26A00', handoff: '#D92D20', pin: '#C026D3' },
  },
  links: {
    tutorial: 'https://github.com/cfanzx/dsh-compact-relay/blob/main/TUTORIAL.md',
    feedback: 'https://github.com/cfanzx/dsh-compact-relay/issues',
  },
};

const SETTINGS_VIEW = {
  config: BASE_CONFIG,
  defaults: BASE_CONFIG,
  palettes: {},
  windowFallback: 1_000_000,
  version: '0.4.2-test',
  native: { autoEnabled: true, thresholdRatio: 0.8, file: path.join(profileDir, 'cordis.patch.yml') },
  path: '/tmp/relay-settings-ux.json',
  settingsError: null,
};

/** deepseek-flash 1M 的真实线（与范围定稿验收 #1 同一组数）。 */
const STATE_VIEW = {
  native: {
    ratio: 0.678,
    thresholdTokens: 678_000,
    contextWindow: 1_000_000,
    reservedCompletionTokens: 256_464,
    headroomTokens: 65_536,
    overridden: false,
    route: null,
  },
};

const jsonResponse = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

/** 挂真实设置页：GET 返回固定 view/state，POST 交给 onPost。 */
async function mountSettings({ config = BASE_CONFIG, state = STATE_VIEW, onPost }) {
  const posts = [];
  const fetches = [];
  sandbox.__fetch = async (url, options = {}) => {
    fetches.push({ url, options });
    if (url === '/api/compact-relay-settings' && options.method === undefined) {
      return jsonResponse(200, { ok: true, ...SETTINGS_VIEW, config });
    }
    if (url === '/api/compact-relay-state') return jsonResponse(200, state);
    if (url === '/api/compact-relay-settings' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      posts.push(body);
      return onPost(body);
    }
    throw new Error(`未预期的请求：${options.method ?? 'GET'} ${url}`);
  };

  const renderer = mountComponent(Component, react);
  renderer.renderOnce();
  await renderer.settle();
  return { renderer, posts, fetches };
}

const handoffInput = (tree) =>
  findAll(tree, (node) => node.props !== null && node.props !== undefined && node.props['aria-label'] === '交接提醒线（百分比）')[0] ?? null;

/* ------------------------------------------------------------------ *
 * 3. 客户端产物 / 渲染路径
 * ------------------------------------------------------------------ */

test('0.4.2 客户端产物：粘性工具条、可见错误状态、交接线行内错误都在 bundle 里', () => {
  const bundle = fs.readFileSync(new URL('lib/client.js', repoRoot), 'utf8');
  for (const marker of ['data-cr-savebar', 'data-cr-save-status', 'data-cr-handoff-error', 'data-cr-reset', 'data-cr-dirty']) {
    assert.ok(bundle.includes(marker), `bundle 应包含 ${marker}`);
  }
  assert.ok(bundle.includes("position: 'sticky'"), '保存工具条应使用 position: sticky');
  assert.ok(bundle.includes('bottom: 0'), '保存工具条应贴视口底部');
  const saveButtons = bundle.match(/'data-cr-save': '1'/g) ?? [];
  assert.equal(saveButtons.length, 1, '保存按钮应只有粘性条里这一个');
});

test('0.4.2 设置页：交接线 65 + 服务端拒绝 → nativeRatio 透传，错误在粘性条与交接线行内都可见', async () => {
  const guardMessage = handoffGuard({ actualRatio: 0.678, configuredRatio: 0.8, handoffRatio: 0.65, compactRatio: 0.4 }).message;
  assert.ok(guardMessage.includes('最高可设 62%'), '测试基准：guard.message 应给出 62%');

  const { renderer, posts } = await mountSettings({
    onPost: async () => jsonResponse(400, { ok: false, message: guardMessage, field: 'thresholds.handoffRatio' }),
  });

  // 粘性工具条：sticky + 底部贴边 + 保存/恢复默认/未保存指示。
  const bar = findByAttr(renderer.tree, 'data-cr-savebar');
  assert.ok(bar !== null, '设置页应有粘性保存工具条');
  assert.equal(bar.props.style.position, 'sticky');
  assert.equal(bar.props.style.bottom, 0);
  assert.equal(textOf(findByAttr(renderer.tree, 'data-cr-save')).trim(), '保存');
  assert.equal(textOf(findByAttr(renderer.tree, 'data-cr-reset')).trim(), '恢复默认');
  assert.equal(findByAttr(renderer.tree, 'data-cr-dirty').props['data-cr-dirty'], '0');

  // 交接线输入 65 → 有未保存修改（工具条常驻可见）。
  const input = handoffInput(renderer.tree);
  assert.ok(input !== null, '应能定位交接提醒线输入框');
  input.props.onChange({ target: { value: '65' } });
  await renderer.settle();
  const dirty = findByAttr(renderer.tree, 'data-cr-dirty');
  assert.equal(dirty.props['data-cr-dirty'], '1', '改过交接线后应显示「有未保存的修改」');
  assert.ok(textOf(dirty).includes('有未保存的修改'));

  // 点保存 → POST 必须带 nativeRatio（0.678），服务端拒绝后错误可见。
  findByAttr(renderer.tree, 'data-cr-save').props.onClick();
  await renderer.settle();
  assert.equal(posts.length, 1, '应只发一次保存请求');
  assert.equal(posts[0].thresholds.handoffRatio, 0.65);
  assert.equal(posts[0].nativeRatio, 0.678, 'POST body 应透传 state.native.ratio（服务端同口径校验的前提）');

  const status = findByAttr(renderer.tree, 'data-cr-save-status');
  assert.ok(status !== null, '保存失败后粘性条里必须有可见状态');
  assert.equal(status.props['data-cr-save-status'], 'error');
  assert.ok(textOf(status).includes('保存失败'), '粘性条应显示「保存失败」');
  assert.ok(textOf(status).includes('最高可设 62%'), `粘性条应带目标值，实际：${textOf(status)}`);

  const inline = findByAttr(renderer.tree, 'data-cr-handoff-error');
  assert.ok(inline !== null, '交接线行内必须出现错误提示');
  assert.equal(textOf(inline), guardMessage, '行内错误文案沿用 guard.message（含实际线与目标值）');
  assert.ok(textOf(inline).includes('67.8%') && textOf(inline).includes('最高可设 62%'));

  // 失败不清表单（用户改过的 65 还在，方便直接改）。
  // 0.4.2 修复后输入框显示的是「草稿字符串」（用户打什么显示什么），所以断言字符串 '65'。
  assert.equal(handoffInput(renderer.tree).props.value, '65');
});

test('0.4.2 设置页（真机 bug）：交接线输入 80 原样保留、不被改成 99；保存被拒给目标值；改 62 保存成功', async () => {
  const messageOf = (ratio) => handoffGuard({ actualRatio: 0.678, configuredRatio: 0.8, handoffRatio: ratio, compactRatio: 0.4 }).message;
  const message80 = messageOf(0.8);
  assert.ok(message80.includes('最高可设 62%'), '测试基准：guard 对 80% 应给出「最高可设 62%」');

  // 服务端同口径替身：超过 62% → 400 + field；62% 及以下 → 200 并回写配置。
  const { renderer, posts } = await mountSettings({
    onPost: async (body) => {
      const ratio = body.thresholds.handoffRatio;
      if (ratio > 0.62) return jsonResponse(400, { ok: false, message: messageOf(ratio), field: 'thresholds.handoffRatio' });
      const nextConfig = { ...BASE_CONFIG, thresholds: { ...BASE_CONFIG.thresholds, handoffRatio: ratio } };
      return jsonResponse(200, { ok: true, ...SETTINGS_VIEW, config: nextConfig });
    },
  });

  const inputNow = () => handoffInput(renderer.tree);
  assert.equal(inputNow().props.value, '60', '初始交接线应为 60（默认 0.6）');
  assert.equal(inputNow().props.max, 62, 'input 的 max 应该是当前真实上限 62，而不是 99');

  // ① 清空准备重打：以前空串会被 Number('')/100 → 夹成 0.05 → 显示 5%，用户根本打不出新值。
  inputNow().props.onChange({ target: { value: '' } });
  await renderer.settle();
  assert.equal(inputNow().props.value, '', '清空后应保持空，不该自己跳成 5');
  // 失焦丢弃草稿 → 回到表单值（表单没被空输入改动，仍是 60）。
  inputNow().props.onBlur();
  await renderer.settle();
  assert.equal(inputNow().props.value, '60', '空输入失焦后应回到原值 60，而不是留下 5');

  // ② 真机键序（旧 bug 的最短复现）：输入框显示 60，光标在末尾敲 8 → 浏览器给的是 "608"。
  //    旧代码 Math.min(0.99, 6.08) → 0.99 → 显示 99（用户看到「输入 80 变成 99」）。
  inputNow().props.onChange({ target: { value: '608' } });
  await renderer.settle();
  assert.equal(inputNow().props.value, '608', '用户输入什么就显示什么：不能被夹成 99');
  assert.notEqual(inputNow().props.value, 99);

  // ③ 重新输入 80：全选后打字（真机 select() 已验证会替换），逐键 8 → 80。
  inputNow().props.onChange({ target: { value: '8' } });
  await renderer.settle();
  assert.equal(inputNow().props.value, '8');
  inputNow().props.onChange({ target: { value: '80' } });
  await renderer.settle();
  assert.equal(inputNow().props.value, '80', '输入 80 后输入框必须还是 80');
  assert.equal(findByAttr(renderer.tree, 'data-cr-dirty').props['data-cr-dirty'], '1', '改过 80 后应显示未保存');

  // 上限提示可见，但只是提示（不改写输入）。
  assert.ok(textOf(findByAttr(renderer.tree, 'data-cr-handoff-cap')).includes('最高可设 62%'));
  assert.equal(textOf(findByAttr(renderer.tree, 'data-cr-handoff-cap-chip')).trim(), '最高 62%');

  // ④ 保存 80 → 服务端拒绝（400 + field），条内与行内都出现「最高可设 62%」。
  findByAttr(renderer.tree, 'data-cr-save').props.onClick();
  await renderer.settle();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].thresholds.handoffRatio, 0.8, 'POST 必须是用户输入的 0.8，不能是 0.99');
  assert.ok(!posts.some((body) => body.thresholds.handoffRatio === 0.99), '任何一次保存都不该出现 0.99');

  const status = findByAttr(renderer.tree, 'data-cr-save-status');
  assert.equal(status.props['data-cr-save-status'], 'error');
  assert.ok(textOf(status).includes('最高可设 62%'), `条内应给目标值，实际：${textOf(status)}`);
  const inline = findByAttr(renderer.tree, 'data-cr-handoff-error');
  assert.ok(inline !== null, '交接线行内必须同时出现错误');
  assert.equal(textOf(inline), message80, '行内文案沿用服务端 guard.message');
  assert.ok(textOf(inline).includes('67.8%') && textOf(inline).includes('最高可设 62%'));
  assert.equal(inputNow().props.value, '80', '被拒后用户的 80 还在，方便直接改');

  // ⑤ 改成 62 → 保存成功（服务端 200），输入框与状态都跟上。
  inputNow().props.onChange({ target: { value: '62' } });
  await renderer.settle();
  assert.equal(inputNow().props.value, '62');
  assert.equal(findByAttr(renderer.tree, 'data-cr-handoff-error'), null, '重新输入后旧错误应清掉');
  findByAttr(renderer.tree, 'data-cr-save').props.onClick();
  await renderer.settle();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].thresholds.handoffRatio, 0.62);
  const ok = findByAttr(renderer.tree, 'data-cr-save-status');
  assert.equal(ok.props['data-cr-save-status'], 'ok');
  assert.ok(textOf(ok).includes('已保存'));
  assert.equal(findByAttr(renderer.tree, 'data-cr-dirty').props['data-cr-dirty'], '0', '保存成功后不再脏');
  assert.equal(inputNow().props.value, '62', '保存成功后显示保存下来的 62');
});


test('0.4.2 设置页：保存成功也在粘性条里可见（成功状态不再只写页尾）', async () => {
  const nextConfig = { ...BASE_CONFIG, thresholds: { ...BASE_CONFIG.thresholds, handoffRatio: 0.61 } };
  const { renderer } = await mountSettings({
    onPost: async () => jsonResponse(200, { ok: true, ...SETTINGS_VIEW, config: nextConfig }),
  });
  findByAttr(renderer.tree, 'data-cr-save').props.onClick();
  await renderer.settle();
  const status = findByAttr(renderer.tree, 'data-cr-save-status');
  assert.ok(status !== null);
  assert.equal(status.props['data-cr-save-status'], 'ok');
  assert.ok(textOf(status).includes('已保存'));
  assert.equal(findByAttr(renderer.tree, 'data-cr-dirty').props['data-cr-dirty'], '0');
});

/* ------------------------------------------------------------------ *
 * 4. HTTP 路由：nativeRatio 透传（真实 registerHttp）
 * ------------------------------------------------------------------ */

let settingsSeq = 0;

function createHttpHarness() {
  settingsSeq += 1;
  const settingsFile = path.join(tmpRoot, `settings-${settingsSeq}.json`);
  const store = createSettingsStore({ file: settingsFile });
  const routes = new Map();
  const webCtx = {
    webServer: {
      host: '127.0.0.1',
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    effect() {
      return () => {};
    },
  };
  registerHttp(webCtx, { settings: store, hub: { refreshAll() {} }, ledger: null });
  const route = routes.get('/api/compact-relay-settings');
  assert.ok(route !== undefined, '设置路由应注册成功');

  async function request({ method = 'GET', body = null } = {}) {
    const stream = Readable.from(body === null ? [] : [Buffer.from(body, 'utf8')]);
    stream.method = method;
    stream.url = '/api/compact-relay-settings';
    stream.headers = { host: '127.0.0.1:1234', 'content-type': 'application/json' };

    let resolveEnd;
    const ended = new Promise((resolve) => {
      resolveEnd = resolve;
    });
    const res = {
      statusCode: 200,
      payload: null,
      writeHead(code) {
        this.statusCode = code;
      },
      end(text) {
        const raw = text === undefined ? '' : String(text);
        try {
          this.payload = JSON.parse(raw);
        } catch {
          this.payload = raw;
        }
        resolveEnd();
      },
    };
    route.handler(stream, res);
    await ended;
    return { status: res.statusCode, payload: res.payload };
  }

  return { request, settingsFile, store };
}

test('0.4.2 服务端路由：body.nativeRatio 透传 → 65% 拒绝、400 字段定位、不落盘', async () => {
  const { request, settingsFile } = createHttpHarness();
  const rejected = await request({
    method: 'POST',
    body: JSON.stringify({ thresholds: { handoffRatio: 0.65 }, nativeRatio: 0.678 }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.payload.ok, false);
  assert.equal(rejected.payload.field, 'thresholds.handoffRatio', '字段级定位应透传到响应（设置页行内提示用）');
  assert.ok(rejected.payload.message.includes('67.8%'), `文案应带实际线，实际：${rejected.payload.message}`);
  assert.ok(rejected.payload.message.includes('最高可设 62%'), `文案应带目标值，实际：${rejected.payload.message}`);
  assert.equal(fs.existsSync(settingsFile), false, '拒绝时不得落盘');
});

test('0.4.2 服务端路由：带 nativeRatio 保存 62% 通过；不带 nativeRatio 的旧客户端 65% 仍兼容放行', async () => {
  const { request, settingsFile } = createHttpHarness();
  const accepted = await request({
    method: 'POST',
    body: JSON.stringify({ thresholds: { handoffRatio: 0.62 }, nativeRatio: 0.678 }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.payload.ok, true);
  assert.equal(accepted.payload.config.thresholds.handoffRatio, 0.62);
  assert.equal(fs.existsSync(settingsFile), true, '通过时应落盘');

  // 0.4.1 兼容：旧客户端不带 nativeRatio → 退回配置阈值兜底（最高 79%），65% 允许。
  const legacy = await request({
    method: 'POST',
    body: JSON.stringify({ thresholds: { handoffRatio: 0.65 } }),
  });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.payload.config.thresholds.handoffRatio, 0.65);
});

/* 运行全部用例（异步用例逐个 await；失败即退出非 0）。 */
for (const [name, fn] of cases) {
  try {
    const result = fn();
    if (result !== undefined && typeof result.then === 'function') await result;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
}
