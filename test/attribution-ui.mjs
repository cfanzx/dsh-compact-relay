/**
 * 0.5.6 Phase D2：压缩归属（客户端 + checkpoint 摘要头）。
 *
 *   node test/attribution-ui.mjs
 *
 * 覆盖（总计划 D2 / task-3 §1、§3.4、§4.3、§4.5）：
 *   1. 文案映射：trigger 七种 / actor 三种 / 未知一律「来源不明」「不明」——只做措辞，不猜；
 *   2. checkpoint 摘要头：`〔压缩归属：…〕` 只追加在 blocks[0]，摘要正文不被污染，
 *      不传归属行时与 0.5.5 **逐字节一致**；
 *   3. shrink 体积防护：**仍量「不带归属行」的同源包帧**（零回归），且带归属行时依旧会拦截；
 *   4. 完成反馈：toast / 命令卡共用的 message 末尾带「归属：菜单压缩（用户）」；
 *   5. 客户端产物（真实 lib/client.js bundle）：归属文案、`data-cr-last-compaction`、
 *      `data-cr-diff-attribution`、3 处 POST 的 `trigger:'ui-menu'`；**不能出现任何 turn 推断**；
 *   6. 组件级（真实 bundle + 极简 React 替身）：悬停卡归属行、无记录文案、
 *      「查看上次压缩」面板按 compactionId 精确匹配。
 *
 * 全程 temp `DSH_HOME` / temp 事件文件；不写真实 ~/.dsh、不启宿主。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { betterCompact } from '../lib/actions/better-compact.js';
import { actorOfTrigger } from '../lib/core/attribution.js';
import {
  ACTOR_LABELS,
  MERGED_LABELS,
  NO_ATTRIBUTION_LABEL,
  TRIGGER_LABELS,
  actorLabelOf,
  attributionLabelOf,
  attributionLabelOrNoRecord,
  attributionLineOf,
  compactionIdShort,
  mergedLabelOf,
  tokensShortOf,
  triggerLabelOf,
} from '../lib/core/attribution-label.js';
import { CHECKPOINT_PREAMBLE, SUMMARY_OPEN_TAG, frameSummary } from '../lib/core/prompts.js';
import { REQUIRED_SECTIONS } from '../lib/core/validate-summary.js';
import { createEventStore } from '../lib/dsh/events.js';
import { createAgent, createHandoffHost, createPluginDeps, createTmpDir } from './harness/host.mjs';
import { createFakeLlm } from './harness/llm.mjs';
import { baseSourceSession } from './harness/session.mjs';

const repoRoot = new URL('../', import.meta.url);
const bundle = fs.readFileSync(new URL('lib/client.js', repoRoot), 'utf8');

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/* ================================================================== *
 * 1. 文案映射（core/attribution-label.js：服务端与 bundle 同一份源码）
 * ================================================================== */

test('文案映射：trigger 七种 + actor 三种；未知一律「来源不明」/「不明」', () => {
  assert.deepEqual(Object.keys(TRIGGER_LABELS).sort(), [
    'command',
    'external',
    'handoff',
    'native-auto',
    'ui-menu',
    'ui-ring',
    'unknown',
  ]);
  assert.equal(triggerLabelOf('ui-menu'), '菜单压缩');
  assert.equal(triggerLabelOf('ui-ring'), '环压缩');
  assert.equal(triggerLabelOf('command'), '命令压缩');
  assert.equal(triggerLabelOf('handoff'), '交接压缩');
  assert.equal(triggerLabelOf('native-auto'), 'DSH 原生自动');
  assert.equal(triggerLabelOf('external'), '来源不明');
  assert.equal(triggerLabelOf('unknown'), '来源不明');
  // 缺失/错类型/未知枚举 → 来源不明（不猜成菜单压缩或原生自动）
  for (const bad of [undefined, null, '', '  ', 42, {}, [], 'UI-MENU-2', 'auto']) {
    assert.equal(triggerLabelOf(bad), '来源不明', `非法 trigger ${JSON.stringify(bad)} 必须是来源不明`);
  }
  assert.equal(triggerLabelOf(' UI-Menu '), '菜单压缩', '大小写/空格归一');

  assert.deepEqual(ACTOR_LABELS, { user: '用户', system: '系统', unknown: '不明' });
  assert.equal(actorLabelOf('user'), '用户');
  assert.equal(actorLabelOf('system'), '系统');
  assert.equal(actorLabelOf('unknown'), '不明');
  for (const bad of [undefined, null, '', 0, {}, 'menue']) {
    assert.equal(actorLabelOf(bad), '不明', `非法 actor ${JSON.stringify(bad)} 必须是不明`);
  }

  assert.deepEqual(MERGED_LABELS, {
    merged: '已合并旧摘要',
    plain: '未合并旧摘要',
    unknown: '合并情况未知',
  });
  assert.equal(mergedLabelOf(true), '已合并旧摘要');
  assert.equal(mergedLabelOf(false), '未合并旧摘要');
  assert.equal(mergedLabelOf(null), '合并情况未知');
  assert.equal(mergedLabelOf(undefined), '合并情况未知');

  // 组合：actor 由服务端给（native-auto→system），文案层不二次推断。
  assert.equal(attributionLabelOf({ trigger: 'ui-menu', actor: 'user' }), '菜单压缩（用户）');
  assert.equal(attributionLabelOf({ trigger: 'native-auto', actor: 'system' }), 'DSH 原生自动（系统）');
  assert.equal(attributionLabelOf({ trigger: 'unknown', actor: 'unknown' }), '来源不明（不明）');
  assert.equal(attributionLabelOf(null), '来源不明（不明）');

  assert.equal(NO_ATTRIBUTION_LABEL, '来源不明（无归属记录）');
  assert.equal(attributionLabelOrNoRecord(null), NO_ATTRIBUTION_LABEL);
  assert.equal(attributionLabelOrNoRecord(undefined), NO_ATTRIBUTION_LABEL);
  assert.equal(attributionLabelOrNoRecord({ trigger: 'command', actor: 'user' }), '命令压缩（用户）');

  // 红线：措辞层不读 turn/summaries 之类旁证；塞进去也改变不了结论。
  const smuggled = attributionLabelOf({ trigger: undefined, actor: undefined, turn: 7, summaries: 9 });
  assert.equal(smuggled, '来源不明（不明）', '旁证不能把来源变成原生自动');
  assert.equal(actorOfTrigger('native-auto'), 'system');
});

test('归属行：逐字节等于验收示例；缺字段写「未知」而不是 0/猜测', () => {
  const row = {
    compactionId: 'a1b2c3d4-0000-4000-8000-000000000000',
    trigger: 'ui-menu',
    actor: 'user',
    range: { count: 22, tokens: 32500, startSeq: 1, endSeq: 22 },
    merged: false,
  };
  assert.equal(attributionLineOf(row), '〔压缩归属：菜单压缩·用户｜22 条｜32.5k tokens｜未合并旧摘要｜#a1b2c3d4〕');

  // 每种 trigger 的整行（文案映射在整行里也必须一致）
  assert.equal(
    attributionLineOf({ ...row, trigger: 'ui-ring' }),
    '〔压缩归属：环压缩·用户｜22 条｜32.5k tokens｜未合并旧摘要｜#a1b2c3d4〕',
  );
  assert.equal(
    attributionLineOf({ ...row, trigger: 'handoff', actor: 'user' }),
    '〔压缩归属：交接压缩·用户｜22 条｜32.5k tokens｜未合并旧摘要｜#a1b2c3d4〕',
  );
  assert.equal(
    attributionLineOf({ ...row, trigger: 'native-auto', actor: 'system' }),
    '〔压缩归属：DSH 原生自动·系统｜22 条｜32.5k tokens｜未合并旧摘要｜#a1b2c3d4〕',
  );
  assert.equal(
    attributionLineOf({ ...row, trigger: 'external', actor: 'user' }),
    '〔压缩归属：来源不明·用户｜22 条｜32.5k tokens｜未合并旧摘要｜#a1b2c3d4〕',
  );

  // 合并旧摘要 / 缺字段
  assert.equal(
    attributionLineOf({ ...row, merged: true }),
    '〔压缩归属：菜单压缩·用户｜22 条｜32.5k tokens｜已合并旧摘要｜#a1b2c3d4〕',
  );
  const unknownLine = attributionLineOf({ trigger: 'unknown', actor: 'unknown' });
  assert.equal(unknownLine, '〔压缩归属：来源不明·不明｜条数未知｜token 未知｜合并情况未知〕');
  assert.equal(unknownLine.includes('0 条'), false, '不知道就不能写 0 条');
  assert.equal(unknownLine.includes('0 tokens'), false, '不知道就不能写 0 tokens');
  // 缺 compactionId 时省略 #段（不写 #undefined）
  assert.equal(attributionLineOf({ ...row, compactionId: null }).includes('#'), false);

  // token 短写法边界
  assert.equal(tokensShortOf(0), '0');
  assert.equal(tokensShortOf(900), '900');
  assert.equal(tokensShortOf(1000), '1.0k');
  assert.equal(tokensShortOf(32500), '32.5k');
  assert.equal(tokensShortOf(1000000), '1000.0k');
  assert.equal(tokensShortOf(null), null);
  assert.equal(tokensShortOf(-1), null);
  assert.equal(tokensShortOf('32.5k'), null);

  assert.equal(compactionIdShort('a1b2c3d4e5f6'), 'a1b2c3d4');
  assert.equal(compactionIdShort('a1b2'), 'a1b2');
  assert.equal(compactionIdShort(''), null);
  assert.equal(compactionIdShort(null), null);
});

test('checkpoint 摘要头：只进 blocks[0]；不传归属行时与 0.5.5 逐字节一致', () => {
  const summary = [{ type: 'text', text: '## Current Goal\n- 施工 D2' }];
  const line = '〔压缩归属：菜单压缩·用户｜22 条｜32.5k tokens｜未合并旧摘要｜#a1b2c3d4〕';

  const framed = frameSummary(summary, line);
  assert.equal(framed.length, 3);
  assert.equal(framed[0].text.includes(CHECKPOINT_PREAMBLE), true);
  assert.equal(framed[0].text.includes(line), true);
  assert.equal(framed[0].text.includes(SUMMARY_OPEN_TAG), true);
  assert.ok(
    framed[0].text.indexOf(CHECKPOINT_PREAMBLE) < framed[0].text.indexOf(line),
    '归属行必须在 preamble 之后',
  );
  assert.ok(framed[0].text.indexOf(line) < framed[0].text.indexOf(SUMMARY_OPEN_TAG), '归属行在 open tag 之前');
  assert.equal(framed[1].text, '## Current Goal\n- 施工 D2', '摘要正文块原样不动');
  assert.equal(framed[2].text, '</compacted-summary>');

  // 0.5.5 逐字节快照（不传第二参 / 传 null / 传空串都必须与它完全一致）
  const legacy = [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>` },
    { type: 'text', text: '## Current Goal\n- 施工 D2' },
    { type: 'text', text: '</compacted-summary>' },
  ];
  assert.deepEqual(frameSummary(summary), legacy);
  assert.equal(JSON.stringify(frameSummary(summary)), JSON.stringify(legacy));
  assert.equal(JSON.stringify(frameSummary(summary, null)), JSON.stringify(legacy));
  assert.equal(JSON.stringify(frameSummary(summary, '')), JSON.stringify(legacy));
  assert.equal(JSON.stringify(frameSummary(summary, 42)), JSON.stringify(legacy));
});

/* ================================================================== *
 * 2. 集成：真实压缩写 checkpoint / shrink 防护量无归属行 / 完成反馈
 * ================================================================== */

function summaryReply() {
  return REQUIRED_SECTIONS.map((section) => `${section}\n- ${section}：D2 摘要正文`).join('\n');
}

function makeLlm() {
  return createFakeLlm({
    routes: [{ kind: 'summary', match: () => true, replies: [summaryReply()] }],
  });
}

function makeCompactDeps({ estimateMessage } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-attribution-ui-'));
  const store = createEventStore({
    file: path.join(dir, 'compact-relay-events.jsonl'),
    version: '0.5.6',
    home: dir,
  });
  const host = createHandoffHost({ llm: makeLlm() });
  const deps = createPluginDeps({
    ctx: host.ctx,
    engine: host.engine,
    handoffDir: createTmpDir('dcr-attribution-ui-handoff-'),
  });
  deps.events = store;
  deps.ledger = { record: () => {} };
  if (typeof estimateMessage === 'function') {
    deps.ctx.tokenMeter = { ...(deps.ctx.tokenMeter ?? {}), estimateMessage };
  }
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { deps, dir, cleanup };
}

function checkpointEventOf(session) {
  return session.log.find(
    (event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint',
  );
}

test('集成：checkpoint 摘要头写进 replace 消息，摘要正文不被污染', async () => {
  const { deps, cleanup } = makeCompactDeps();
  try {
    const session = baseSourceSession();
    const outcome = await betterCompact(deps, { agent: createAgent(session), trigger: 'ui-menu' });
    assert.equal(outcome.compacted, true);

    const replaceEvent = checkpointEventOf(session);
    assert.ok(replaceEvent !== undefined, '压缩必须提交一条 checkpoint 消息');
    const header = replaceEvent.data.content[0].text;
    const shortId = outcome.compactionId.slice(0, 8);
    assert.ok(
      header.includes(
        `〔压缩归属：菜单压缩·用户｜${outcome.shadowedSeqs.length} 条｜${tokensShortOf(outcome.shadowedTokenCount)} tokens｜未合并旧摘要｜#${shortId}〕`,
      ),
      `摘要头应带归属行：${header}`,
    );
    // 摘要正文（blocks[1]）仍是模型原文，行只出现在 blocks[0]
    const body = replaceEvent.data.content[1].text;
    assert.equal(body, outcome.summary.map((block) => block.text).join('\n') || body);
    assert.equal(body.includes('压缩归属'), false, '摘要正文不能被归属行污染');
    assert.equal(replaceEvent.data.content.at(-1).text, '</compacted-summary>');
    // 归属行与事件行同一份 trigger（服务端记账口径不因 UI 新增而变）
    const [row] = deps.events.compactions({ limit: 1 });
    assert.equal(row.trigger, 'ui-menu');
    assert.equal(row.compactionId, outcome.compactionId);
  } finally {
    cleanup();
  }
});

test('shrink 防护：量的是「不带归属行」的同源包帧（0.5.5 零回归）', async () => {
  const measured = [];
  const { deps, cleanup } = makeCompactDeps({
    estimateMessage: (message) => {
      measured.push(message);
      return 10; // 远小于被遮罩 token → 不触发 shrink
    },
  });
  try {
    const session = baseSourceSession();
    const outcome = await betterCompact(deps, { agent: createAgent(session), trigger: 'ui-menu' });
    assert.equal(outcome.compacted, true);

    assert.equal(measured.length, 1, '一次压缩只量一次包帧');
    const replaceEvent = checkpointEventOf(session);
    const summaryBlocks = replaceEvent.data.content.slice(1, -1);
    // 量到的必须是 0.5.5 的包帧（无归属行），逐字节一致
    const legacy = frameSummary(summaryBlocks);
    assert.equal(JSON.stringify(measured[0].content), JSON.stringify(legacy), '防护量的必须是不带归属行的包帧');
    assert.equal(measured[0].content[0].text.includes('压缩归属'), false, '防护入参不能含归属行');
    // 提交的包帧才含归属行
    assert.equal(replaceEvent.data.content[0].text.includes('压缩归属'), true);
    // 同源：source 与提交消息一致（同一 compactionId）
    assert.deepEqual(measured[0].source, replaceEvent.data.source);
  } finally {
    cleanup();
  }
});

test('shrink 防护：带归属行时仍会拦截（不会因为多一行而放行）', async () => {
  const measured = [];
  const { deps, cleanup } = makeCompactDeps({
    estimateMessage: (message) => {
      measured.push(message);
      return 10_000_000; // 远大于被遮罩 token → 必须拦
    },
  });
  try {
    const session = baseSourceSession();
    await assert.rejects(
      betterCompact(deps, { agent: createAgent(session), trigger: 'ui-menu' }),
      (error) => error.code === 'shrink',
      '摘要比被遮罩内容大时必须抛 shrink',
    );
    assert.equal(measured.length, 1);
    assert.equal(measured[0].content[0].text.includes('压缩归属'), false);
    assert.equal(checkpointEventOf(session), undefined, '被拦下时不得提交 checkpoint');
  } finally {
    cleanup();
  }
});

test('完成反馈：message 末尾带归属（菜单 / 命令 / 缺省未知）', async () => {
  const expectations = [
    { trigger: 'ui-menu', label: '菜单压缩（用户）' },
    { trigger: 'command', label: '命令压缩（用户）' },
    { trigger: 'handoff', label: '交接压缩（用户）' },
  ];
  for (const { trigger, label } of expectations) {
    const { deps, cleanup } = makeCompactDeps();
    try {
      const session = baseSourceSession();
      const outcome = await betterCompact(deps, { agent: createAgent(session), trigger });
      assert.equal(outcome.compacted, true);
      assert.ok(outcome.message.startsWith('压缩完成：'), outcome.message);
      assert.ok(outcome.message.endsWith(`归属：${label}`), `完成文案要带归属：${outcome.message}`);
      assert.ok(outcome.message.includes('条旧会话 → 1 条摘要'), '原有文案内容不能被挤掉');
      assert.ok(outcome.message.includes('腾出约'), '原有文案内容不能被挤掉');
    } finally {
      cleanup();
    }
  }
  const { deps, cleanup } = makeCompactDeps();
  try {
    const session = baseSourceSession();
    const outcome = await betterCompact(deps, { agent: createAgent(session) });
    assert.ok(outcome.message.endsWith(`归属：${attributionLabelOf({ trigger: 'unknown', actor: 'unknown' })}`), outcome.message);
    assert.equal(outcome.message.includes('菜单压缩'), false, '缺省不能猜成菜单压缩');
  } finally {
    cleanup();
  }
});

/* ================================================================== *
 * 3. 客户端产物静态守卫（真实 lib/client.js）
 * ================================================================== */

test('客户端产物：归属文案 + data-cr-* 归属钩子 + 3 处 trigger:ui-menu', () => {
  for (const marker of [
    // 文案（与 core/attribution-label.js 同一份内联源码）
    "'ui-menu': '菜单压缩'",
    "'ui-ring': '环压缩'",
    "command: '命令压缩'",
    "handoff: '交接压缩'",
    "'native-auto': 'DSH 原生自动'",
    "external: '来源不明'",
    "unknown: '来源不明'",
    "NO_ATTRIBUTION_LABEL = '来源不明（无归属记录）'",
    '上次压缩：',
    '归属：',
    '条数未知',
    '合并情况未知',
    // 内联进来的纯函数（不是客户端另写一份 taxonomy）
    'function triggerLabelOf(',
    'function actorLabelOf(',
    'function attributionLabelOf(',
    'function attributionLineOf(',
    'const lastCompactionViewOf =',
    'const lastCompactionTextOf =',
    'const diffAttributionOf =',
    // 组件钩子
    "'data-cr-last-compaction'",
    "'data-cr-diff-attribution'",
    'lastCompactionViewOf(data.lastCompaction)',
    // 面板只认 id 完全相同
    'lastView.compactionId === id',
  ]) {
    assert.ok(bundle.includes(marker), `bundle 应包含 ${marker}`);
  }

  // 3 处 POST 带 trigger:'ui-menu'（预览 / 交接预览 / 确认执行）
  const uiMenuSends = bundle.match(/trigger: 'ui-menu'/g) ?? [];
  assert.equal(uiMenuSends.length, 3, `应有 3 处 POST 带 trigger:'ui-menu'，实际 ${uiMenuSends.length}`);
  assert.ok(bundle.includes("action: 'preview'"), '菜单预览入口仍在');
  assert.ok(bundle.includes("action: 'handoff-preview'"), '交接预览入口仍在');
});

test('客户端产物：不含任何 turn 推断（turn:null ⇒ native-auto 无从发生）', () => {
  // 客户端根本不能读 turn：没有属性访问、没有 null/undefined 比较。
  assert.equal(/\.turn\b/.test(bundle), false, '客户端不得访问 .turn');
  assert.equal(/turn\s*===?\s*(null|undefined)/.test(bundle), false, '客户端不得比较 turn 是否为空');
  assert.equal(/turn\s*(!==?|==)\s*(null|undefined)/.test(bundle), false);
  assert.equal(bundle.includes('turn: null'), false);
  assert.equal(bundle.includes('turn:null'), false);
  // native-auto 在客户端只作为「标签键」出现，不是任何比较/推断的结果
  assert.equal(bundle.includes("'native-auto': 'DSH 原生自动'"), true);
  for (const comparison of [
    "=== 'native-auto'",
    "'native-auto' ===",
    "!== 'native-auto'",
    "'native-auto' !==",
    "== 'native-auto'",
  ]) {
    assert.equal(bundle.includes(comparison), false, `客户端不应拿 native-auto 做判断：${comparison}`);
  }
  assert.equal(/trigger\s*={2,3}\s*['"]native-auto/.test(bundle), false);
  // 也不许出现「猜测式」措辞
  for (const guess of ['推测', '可能是原生', '疑似原生']) {
    assert.equal(bundle.includes(guess), false, `不应出现猜测措辞：${guess}`);
  }
});

/* ================================================================== *
 * 4. 组件级：极简 React 替身把真实 bundle 的指示灯跑起来
 * ================================================================== */

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

  async function settle(maxTicks = 80) {
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

const SESSION_ID = 'session-d2-0001';
const rowElement = {
  getBoundingClientRect: () => ({ left: 40, right: 1000, top: 700, bottom: 732 }),
};

const COMPACT_AT = '2026-10-30T07:40:00.000Z';
const LAST_COMPACTION = {
  compactionId: 'comp-latest-0001-abcd',
  at: COMPACT_AT,
  trigger: 'ui-menu',
  actor: 'user',
  outcome: 'ok',
  durationMs: 1200,
  range: { count: 22, tokens: 32500, startSeq: 1, endSeq: 22 },
  model: 'deepseek-flash',
  merged: false,
  code: null,
  message: null,
};

const BASE_STATE = {
  sessionId: SESSION_ID,
  revision: 1,
  pressure: 400,
  window: 100000,
  ratio: 0.004,
  summaries: 1,
  advice: 'none',
  thresholds: { compactAt: 40000, handoffAt: 60000, compactRatio: 0.4, handoffRatio: 0.6 },
  colors: null,
  pins: {
    count: 0,
    seqs: [],
    marks: [],
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

const DIFF_ITEMS = [
  {
    seq: 30,
    compactionId: 'comp-latest-0001-abcd',
    at: Date.parse(COMPACT_AT),
    committed: true,
    open: false,
    error: null,
    shadowedCount: 22,
    shadowedTokens: 32500,
    preview: '最近一次摘要预览',
  },
  {
    seq: 10,
    compactionId: 'comp-older-0002-abcd',
    at: Date.parse(COMPACT_AT) - 3600_000,
    committed: true,
    open: false,
    error: null,
    shadowedCount: 8,
    shadowedTokens: 9000,
    preview: '更早一次摘要预览',
  },
];

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function loadBundle() {
  const react = createReactFacade();
  const registered = {};
  const exported = {};
  const fetches = [];
  const storage = new Map([['compact-relay:onboarded', '1']]);
  let stateResponse = { ...BASE_STATE, lastCompaction: LAST_COMPACTION };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
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
    URLSearchParams,
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    document: {
      body: {},
      visibilityState: 'visible',
      documentElement: { dataset: {} },
      head: { children: [], appendChild(el) { this.children.push(el); return el; } },
      getElementById: () => null,
      createElement: (tag) => ({ tagName: String(tag).toUpperCase(), id: '', textContent: '', style: {}, remove() {} }),
      addEventListener() {},
      removeEventListener() {},
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
      return Promise.resolve(jsonResponse(200, stateResponse));
    }
    if (typeof url === 'string' && url.startsWith('/api/compact-relay-diff')) {
      return Promise.resolve(jsonResponse(200, { ok: true, items: DIFF_ITEMS, count: DIFF_ITEMS.length }));
    }
    if (url === '/api/compact-relay-action') return Promise.resolve(jsonResponse(200, { ok: true }));
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
    uiWorkspace: { openSession() {}, async unarchiveSession() {} },
  };
  exported.module.apply(ctx);

  function setState(state) {
    stateResponse = state;
  }

  function mountIndicator() {
    const entry = registered['conversation.input.left'];
    assert.ok(entry !== undefined, '应注册 conversation.input.left（指示灯）');
    const props = entry.meta.inject(SESSION_ID);
    const renderer = mountComponent(entry.component, react, props);
    renderer.renderOnce();
    return renderer;
  }

  return { sandbox, fetches, setState, mountIndicator };
}

async function mountIndicator(harness) {
  const renderer = harness.mountIndicator();
  await renderer.settle();
  const trigger = findByAttr(renderer.tree, 'data-cr-level');
  assert.ok(trigger !== null, '应渲染指示灯按钮');
  return { renderer, trigger };
}

function attributionNode(tree) {
  return findByAttr(tree, 'data-cr-last-compaction');
}

test('悬停卡：有归属 → 一行「上次压缩：菜单压缩·用户 · 22 条 / 32.5k · HH:MM」', async () => {
  const harness = loadBundle();
  const { renderer, trigger } = await mountIndicator(harness);

  trigger.props.onMouseEnter({ currentTarget: rowElement });
  await renderer.settle();
  const node = attributionNode(renderer.tree);
  assert.ok(node !== null, '悬停卡应出现归属行');
  assert.equal(node.props['data-cr-last-compaction'], 'ui-menu');
  const text = textOf(node);
  assert.ok(text.startsWith('上次压缩：菜单压缩·用户'), text);
  assert.ok(text.includes('22 条 / 32.5k'), text);
  assert.ok(/ · \d{2}:\d{2}$/.test(text), `应带本地时刻：${text}`);
  // 悬停卡里不能出现任何猜测的原生自动
  assert.equal(textOf(findByAttr(renderer.tree, 'data-cr-tooltip')).includes('DSH 原生自动'), false);
});

test('悬停卡：原生自动归属显示「DSH 原生自动·系统」', async () => {
  const harness = loadBundle();
  harness.setState({
    ...BASE_STATE,
    lastCompaction: { ...LAST_COMPACTION, trigger: 'native-auto', actor: 'system', merged: true },
  });
  const { renderer, trigger } = await mountIndicator(harness);
  trigger.props.onMouseEnter({ currentTarget: rowElement });
  await renderer.settle();
  const node = attributionNode(renderer.tree);
  assert.ok(node !== null);
  assert.equal(node.props['data-cr-last-compaction'], 'native-auto');
  const text = textOf(node);
  assert.ok(text.includes('DSH 原生自动·系统'), text);
  assert.ok(text.includes('已合并旧摘要') === false, '悬停行只放来源/范围/时间，不挤合并说明');
});

test('悬停卡：老会话压缩过但没有归属记录 → 「来源不明（无归属记录）」，属性 unknown', async () => {
  const harness = loadBundle();
  harness.setState({ ...BASE_STATE, summaries: 3 }); // 没有 lastCompaction 键 = 老宿主/无事件流
  const { renderer, trigger } = await mountIndicator(harness);
  trigger.props.onMouseEnter({ currentTarget: rowElement });
  await renderer.settle();
  const node = attributionNode(renderer.tree);
  assert.ok(node !== null, '无归属记录时也要有这一行（明说不知道）');
  assert.equal(node.props['data-cr-last-compaction'], 'unknown');
  assert.equal(textOf(node), `上次压缩：${NO_ATTRIBUTION_LABEL}`);
  assert.equal(textOf(node).includes('原生自动'), false, '不能猜');
  assert.equal(textOf(node).includes('菜单压缩'), false, '不能猜');
});

test('悬停卡：从未压缩过 → 不渲染归属行（零噪音）', async () => {
  const harness = loadBundle();
  harness.setState({ ...BASE_STATE, summaries: 0, lastCompaction: null });
  const { renderer, trigger } = await mountIndicator(harness);
  trigger.props.onMouseEnter({ currentTarget: rowElement });
  await renderer.settle();
  assert.ok(findByAttr(renderer.tree, 'data-cr-tooltip') !== null, '悬停卡本身要在');
  assert.equal(attributionNode(renderer.tree), null, '没有压缩过就不出现归属行');
});

async function openDiffPanel(harness) {
  const { renderer, trigger } = await mountIndicator(harness);
  trigger.props.onClick({ currentTarget: rowElement });
  await renderer.settle();
  const diffItem = findAll(renderer.tree, (node) => node.props?.['data-cr-item'] === 'diff')[0];
  assert.ok(diffItem !== undefined, '菜单应有「查看上次压缩」');
  diffItem.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await renderer.settle();
  const panel = findByAttr(renderer.tree, 'data-cr-diff');
  assert.ok(panel !== null, '应打开压缩历史面板');
  return { renderer, panel };
}

test('查看上次压缩：只有 compactionId 相同的那条认归属，其余「无归属记录」', async () => {
  const harness = loadBundle();
  const { panel } = await openDiffPanel(harness);
  const entries = findAll(panel, (node) => node.props?.['data-cr-diff-item'] !== undefined);
  assert.equal(entries.length, 2, '两条压缩记录都应渲染');

  const rows = entries.map((entry) => {
    const line = findAll(entry, (node) => node.props?.['data-cr-diff-attribution'] !== undefined)[0];
    assert.ok(line !== undefined, '每条压缩都要有一行归属');
    return { trigger: line.props['data-cr-diff-attribution'], text: textOf(line) };
  });
  assert.equal(rows[0].trigger, 'ui-menu');
  assert.equal(rows[0].text, '归属：菜单压缩（用户）');
  assert.equal(rows[1].trigger, 'unknown');
  assert.equal(rows[1].text, `归属：${NO_ATTRIBUTION_LABEL}`);
  // 面板里任何地方都不许出现猜出来的原生自动
  assert.equal(textOf(panel).includes('DSH 原生自动'), false);
});

test('查看上次压缩：lastCompaction 为 null → 全部「无归属记录」（没有猜测的触发者）', async () => {
  const harness = loadBundle();
  harness.setState({ ...BASE_STATE, summaries: 2, lastCompaction: null });
  const { panel } = await openDiffPanel(harness);
  const rows = findAll(panel, (node) => node.props?.['data-cr-diff-attribution'] !== undefined).map((node) => ({
    trigger: node.props['data-cr-diff-attribution'],
    text: textOf(node),
  }));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.trigger, 'unknown');
    assert.equal(row.text, `归属：${NO_ATTRIBUTION_LABEL}`);
  }
});

/* ================================================================== *
 * 运行
 * ================================================================== */

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

console.log(`\nattribution-ui：${passed}/${cases.length} 通过`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[失败] ${failure.name}\n${failure.error && failure.error.stack ? failure.error.stack : failure.error}`);
  }
  process.exit(1);
}
// 组件里还有轮询/引导/toast 的浏览器定时器（真实页面会一直活着）；单测跑完显式退出。
process.exit(0);
