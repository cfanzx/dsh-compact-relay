/**
 * 0.5.2 S1 契约快照（golden）—— 把「行为不变」从口头变成机器判据。
 *
 * 为什么单独一个文件、为什么锁得这么死（`dcr-架构梳理与重构方案-2026-10-26.md` §S1）：
 * 0.5.x 的接力链接口是**字节级契约**（会话日志是 JSONL，record 的键顺序、null/省略语义
 * 都会落进用户磁盘），而「行为不变」此前只能靠人读 diff。S2 起要动 record 的唯一构造点、
 * 后面还要动 readState 的投影实现 —— 没有这份 golden，每一步都在赌。
 *
 * 本文件锁三张契约面 + 一次负向自检：
 *   1) **readState 帧**：完整键集合、每个字段的结构与类型（不锁值）、链投影的取值
 *      （id/path/时间戳规范化后）；6 个场景：无目标会话 / 无链 / 新链父会话 /
 *      新链子会话 / 老链子会话（header 兜底）/ 老宿主无 registry。
 *   2) **父/子 relay record**：字段集合、**键顺序**（= JSON.stringify 的字节序）、
 *      null 与省略的语义（titleSeq 写 null；path 有才带；historyTitle 只在改名生效时写）、
 *      新链 / 老链 / 改名失败三条真实流程的逐字段取值。
 *   3) **标题格式**：historyTitleOf / relayTitleOf / splitHandoffTitle / handoffTitlePlanOf
 *      的典型输出（含 80 字节预算、全角/半角冒号、脏输入、legacy 堆叠、record 续号）。
 *   4) **负向自检**：断言机制必须对「改一个键 / 改一个值 / 换键顺序」敏感（见文件末尾）。
 *
 * 数据全部来自真实流程（`handoff()` + fake host，见 test/harness），不是手搓的会话日志：
 * 这样父/子 record 的写法、时间戳口径、titleSeq 的来源都是生产代码算出来的。
 *
 * 怎么更新期望（只在**有意**改契约时）：
 *   node test/contract-golden.mjs --print-golden
 * 把打印出的常量整段替换到下面 `SHAPES` / `VALUES` 的位置，再人工 review 每一条差异。
 *
 *   node test/contract-golden.mjs
 */
import assert from 'node:assert/strict';
import { handoff } from '../lib/actions/handoff.js';
import { createLock } from '../lib/actions/lock.js';
import { readState } from '../lib/actions/state.js';
import { resolveConfig } from '../lib/config.js';
import { HANDOFF_SECTIONS } from '../lib/core/handoff-doc.js';
import {
  MAX_TITLE_BYTES,
  RELAY_RECORD_TYPE,
  historyTitleOf,
  relayTitleOf,
  splitHandoffTitle,
} from '../lib/core/relay.js';
import { REQUIRED_SECTIONS } from '../lib/core/validate-summary.js';
import { localIso } from '../lib/dsh/diag-counters.js';
import { normalizeRelayRecord } from '../lib/dsh/relay.js';
import { handoffTitlePlanOf } from '../lib/dsh/sessions.js';
import { createAgent, createFakeEngine, createHandoffHost, createPluginDeps, createTmpDir } from './harness/host.mjs';
import { createFakeLlm } from './harness/llm.mjs';
import { MockSession, baseSourceSession } from './harness/session.mjs';

/* ================================================================== *
 * 0. 夹具：真实交接流程（三个 host 覆盖新链 / 改名失败 / 老链）
 *
 * 一个 llm 替身给三个 host 共用（replies 可重复取）。三个 host 各自 reset 插件级缓存，
 * 互不串味。
 * ================================================================== */

function summaryReply() {
  return REQUIRED_SECTIONS.map((section) => `${section}\n- ${section}：根据本轮变更记录关键结论与证据`).join('\n');
}

function handoffReply() {
  return HANDOFF_SECTIONS.map((section) => `## ${section}\n- ${section}的内容：完成验证、记录结论并标注下一步`).join('\n');
}

function makeLlm() {
  return createFakeLlm({
    routes: [
      {
        kind: 'handoff',
        match: ({ instruction }) => instruction.includes('交接文档'),
        replies: [handoffReply()],
      },
      { kind: 'summary', match: () => true, replies: [summaryReply()] },
    ],
  });
}

const llm = makeLlm();
const engine = createFakeEngine();

/** 某一跳的父会话日志里、指向该跳子会话的 relay 记录（原始对象，未 normalize）。 */
function parentRecordOf(hop) {
  return hop.parent.log
    .filter((event) => event?.type === RELAY_RECORD_TYPE)
    .map((event) => event.data)
    .filter((data) => data?.childId === hop.child.id)
    .at(-1);
}

/** 子会话**自己**那条 relay 记录（childId === 本会话；它之后再交接产生的出站记录不算）。 */
function childRecordOf(child) {
  const own = child.log
    .filter((event) => event?.type === RELAY_RECORD_TYPE)
    .map((event) => event.data)
    .filter((data) => data?.childId === child.id);
  assert.equal(own.length, 1, '新会话必须有且只有一条自己的入站 relay 记录');
  return own[0];
}

/* --- host A：新链两跳（父/子 rename 都成功，titleSeq 可区分） --- */
const hostA = createHandoffHost({ llm, engine, renameEventSeq: ({ call }) => call });
const parentA = baseSourceSession({ id: 'source-A' });
const hopsA = [];
{
  let parent = parentA;
  for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
    const deps = createPluginDeps({ ctx: hostA.ctx, engine, handoffDir: createTmpDir(`contract-golden-A${ordinal}-`) });
    const result = await handoff(deps, { agent: createAgent(parent) });
    const child = hostA.record.child;
    hopsA.push({ ordinal, parent, child, result });
    parent = child;
  }
}
const [hopA1, hopA2] = hopsA;
const childA1 = hopA1.child;
const childA2 = hopA2.child;
/** host A 两跳之后宿主侧真实归档集合（source、child1 各在交接成功后被归档）。 */
const archivedA = hostA.record.archivedSessionIds;

/* --- host B：新链一跳，但**父会话改名失败**（historyTitle 必须不写键、titleSeq=null） --- */
const hostB = createHandoffHost({
  llm,
  engine,
  renameEventSeq: ({ call }) => call,
  // 只让**旧会话**的 rename 失败（新会话改标题仍成功）：父记录必须 titleSeq=null 且不写 historyTitle。
  renameBrokenFor: 'source-B',
});
const parentB = baseSourceSession({ id: 'source-B' });
const hopB = await (async () => {
  const deps = createPluginDeps({ ctx: hostB.ctx, engine, handoffDir: createTmpDir('contract-golden-B-') });
  await handoff(deps, { agent: createAgent(parentB) });
  return { parent: parentB, child: hostB.record.child };
})();

/* --- host C：老链（标题「交接第 2 次：…」→ scheme=handoff-n，父记录 titleSeq=null） --- */
const hostC = createHandoffHost({
  llm,
  engine,
  renameEventSeq: ({ call }) => call,
  sessionTitleText: '交接第 2 次：老链题',
});
const parentC = baseSourceSession({ id: 'source-C' });
const hopC = await (async () => {
  const deps = createPluginDeps({ ctx: hostC.ctx, engine, handoffDir: createTmpDir('contract-golden-C-') });
  const plan = handoffTitlePlanOf(hostC.ctx, parentC);
  await handoff(deps, { agent: createAgent(parentC) });
  return { parent: parentC, child: hostC.record.child, plan };
})();

/* ================================================================== *
 * 1. readState 帧夹具
 * ================================================================== */

const cfg = resolveConfig({ retention: { recentTailTokens: 0 } });

/** 与 harness host 同口径的 token 计价（每条 surface 节点 100 tokens）。 */
const tokenMeter = {
  measure(session) {
    const nodes = session.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 }));
    return { totalTokens: nodes.length * 100, surfaceTokens: nodes.length * 100, nodes };
  },
};

const llmInfo = {
  async resolveModelInfo() {
    return { context: { contextWindow: 200_000 } };
  },
};

/**
 * readState 的 deps 替身（与 test/state-passive.mjs 同口径）。
 *
 * @param {object} options
 * @param {object[]} [options.sessions] 可被 sessions.get 找到的会话
 * @param {object} [options.agent] 活 agent（不传 = 只有 live session）
 * @param {string[]} [options.archived] workspaceRegistry.archivedSessionIds
 * @param {string[]} [options.pinned] workspaceRegistry.pinnedSessionIds
 * @param {boolean} [options.registry] false = 老宿主没有 workspaceRegistry
 * @param {boolean} [options.unarchive] registry 有没有 unarchiveSession 接缝
 * @param {Record<string,string>} [options.titles] 会话标题（sessionTitle.get）
 */
function stateDepsOf({ sessions = [], agent = null, archived = [], pinned = [], registry = true, unarchive = true, archive = true, titles = {} } = {}) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const ctx = {
    tokenMeter,
    llm: llmInfo,
    get(name) {
      if (name === 'sessionTitle') return { get: (session) => ({ title: titles[session.id] }) };
      if (name !== 'workspaceRegistry') return undefined;
      if (!registry) return undefined;
      return {
        archivedSessionIds: [...archived],
        pinnedSessionIds: [...pinned],
        ...(unarchive ? { async unarchiveSession() {} } : {}),
        // 0.5.2 L 项：强制归档能力位的数据源（与真实 registry 同形）。
        ...(archive ? { async archiveSession() {} } : {}),
      };
    },
    agents: {
      get: (id) => (agent !== null && agent.id === id ? agent : undefined),
      list: () => (agent === null ? [] : [agent]),
    },
    sessions: { get: (id) => byId.get(id), flush() {} },
  };
  return { ctx, cfg, lock: createLock(), engine };
}

/** 4 条消息的干净会话（无链、无记录）。 */
function plainSession(id = 'session-plain') {
  return new MockSession({
    id,
    events: [
      { type: 'user/message', data: { role: 'user', content: '第一条' } },
      { type: 'assistant/message', data: { role: 'assistant', content: '回复一' } },
      { type: 'user/message', data: { role: 'user', content: '第二条' } },
      { type: 'assistant/message', data: { role: 'assistant', content: '回复二' } },
    ],
  });
}

/** 老链子会话：0.5.0 之前生成的老链没有 relay record，靠 header + 标题兜底。 */
const legacyChild = new MockSession({
  id: 'session-legacy-kid',
  header: { parentSession: 'session-legacy-parent' },
  events: [{ type: 'user/message', data: { role: 'user', content: '老链里的交接单' } }],
});

const plain = plainSession();
const chainSessions = [parentA, childA1, childA2];

const frames = {
  // 1) 没有目标会话（HTTP 首帧/调试路径）：target=null，所有会话相关字段为 null。
  empty: await readState(stateDepsOf({}), {}),
  // 2) 普通会话：无 relay、无链、无 registry 状态干扰。
  noChain: await readState(stateDepsOf({ sessions: [plain], archived: [] }), { sessionId: plain.id }),
  // 3) 新链父会话（child1）：日志里既有入站记录（第 1 跳）也有出站记录（第 2 跳）。
  //    chain 必须取入站（DCR-01），next 取出站，relay 仍是最新一条（出站）。
  chainParent: await readState(stateDepsOf({ sessions: chainSessions, archived: archivedA }), { sessionId: childA1.id }),
  // 4) 新链子会话（child2）：只有入站记录。
  chainChild: await readState(stateDepsOf({ sessions: chainSessions, archived: archivedA }), { sessionId: childA2.id }),
  // 5) 老链子会话：没有 record，header.parentSession + 「交接第 N 次」标题合成只读链。
  legacyChild: await readState(
    stateDepsOf({ sessions: [legacyChild], titles: { [legacyChild.id]: '交接第 3 次：老链题' } }),
    { sessionId: legacyChild.id },
  ),
  // 6) 老宿主：没有 workspaceRegistry（读不到归档/置顶/恢复能力）。
  noRegistry: await readState(stateDepsOf({ sessions: [childA2], registry: false }), { sessionId: childA2.id }),
};

/* ================================================================== *
 * 2. 快照工具
 * ================================================================== */

/** 叶子类型标签：只区分结构/类型，不锁值（`undefined` 单独标出来，因为它会被 JSON 吞掉）。 */
function typeTagOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 把一个值压成「排序后的 `path=类型` 行」。
 * - 对象：逐键递归（键名进 path，顺序不参与，排序后比较）；
 * - 数组：`path[]=empty` / `path[]=<首元素类型>`（本帧里的数组只有空数组，够用）；
 * - 叶子：`path=null` / `path=string` / `path=number` / …
 * 这样快照锁「键存在 + 结构 + 类型」，改值不会红，改结构一定红。
 */
function typeLinesOf(value, prefix = '', out = []) {
  if (value === null) {
    out.push(`${prefix}=null`);
    return out;
  }
  if (Array.isArray(value)) {
    out.push(value.length === 0 ? `${prefix}[]=empty` : `${prefix}[]=${typeTagOf(value[0])}`);
    return out;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) out.push(`${prefix}={}`);
    for (const key of keys) typeLinesOf(value[key], prefix === '' ? key : `${prefix}.${key}`, out);
    return out;
  }
  out.push(`${prefix}=${typeTagOf(value)}`);
  return out;
}

/** 一帧的类型快照（排序后的行，用 \n 连接 = 可逐行 diff 的字符串）。 */
function shapeOf(frame) {
  return typeLinesOf(frame).sort().join('\n');
}

/** 会话 id → 稳定标签（golden 里不出现随机 uuid）。 */
const ID_LABELS = new Map([
  [parentA.id, '<parentA>'],
  [childA1.id, '<childA1>'],
  [childA2.id, '<childA2>'],
  [parentB.id, '<parentB>'],
  [hopB.child.id, '<childB>'],
  [parentC.id, '<parentC>'],
  [hopC.child.id, '<childC>'],
  ['session-legacy-kid', '<legacyKid>'],
  ['session-legacy-parent', '<legacyParent>'],
]);

function labelOf(id) {
  if (typeof id !== 'string') return id;
  return ID_LABELS.get(id) ?? `<id:${id}>`;
}

/** 父记录（normalize 后的读侧形状）→ golden 值：只规范化 id/时间/路径/planId。 */
function normalizedRelayOf(relay) {
  if (relay === null) return null;
  const out = {};
  for (const [key, value] of Object.entries(relay)) {
    if (key === 'parentId' || key === 'childId' || key === 'parentSessionId') out[key] = labelOf(value);
    // 0.6：链根会话 id 与随机 uuid 绑定 → golden 只锁「有值」，不锁具体 id。
    else if (key === 'rootId') out[key] = typeof value === 'string' ? '<rootId>' : value;
    else if (key === 'at') out[key] = '<at>';
    else if (key === 'atIso') out[key] = '<atIso>';
    else if (key === 'path') out[key] = '<path>';
    else if (key === 'planId') out[key] = typeof value === 'string' ? '<planId>' : value;
    else out[key] = value;
  }
  return out;
}

/** 链投影 → golden 值：只规范化 id/路径（序号、scheme、原题、synthesized 都要锁值）。 */
function normalizedChainOf(chain) {
  if (chain === null) return null;
  const out = {};
  for (const [key, value] of Object.entries(chain)) {
    if (key === 'parentId' || key === 'childId') out[key] = labelOf(value);
    else if (key === 'path') out[key] = '<path>';
    else out[key] = value;
  }
  return out;
}

/** 一帧里与接力链契约相关的取值（其余字段只锁结构与类型）。 */
function contractValuesOf(state) {
  return {
    relay: normalizedRelayOf(state.relay),
    chain: normalizedChainOf(state.chain),
    next: normalizedChainOf(state.next),
    parentArchived: state.parentArchived,
    nextArchived: state.nextArchived,
    // 0.5.2 L 项：入站父会话的置顶状态（强制归档确认文案的数据源）。
    parentPinned: state.parentPinned,
    sessionPinned: state.sessionPinned,
    capabilities: state.capabilities,
  };
}

/* ================================================================== *
 * 3. 固定期望（golden）
 *
 * 【生成】node test/contract-golden.mjs --print-golden
 * 【原则】结构/类型/键顺序/链投影取值 = 锁死；其余业务数值（压力、阈值、色板…）不锁值。
 * ================================================================== */

/** 期望的 readState 顶层键集合（少一个/多一个都红；顺序不参与，比较前排序）。 */
const FRAME_KEYS = [
  'advice',
  'busy',
  'capabilities',
  'chain',
  'colors',
  'compactRange',
  'compactRangeReason',
  'compressHint',
  'favoriteSuggest',
  'favorites',
  // 0.5.6-C：只读 header 的「可能有父会话」提示（客户端据它决定是否走整链端点兜底）。
  'hasParent',
  // 0.5.6-D1：最近一次压缩归属（事件流投影；无记录 → null）。
  'lastCompaction',
  'level',
  'native',
  'next',
  'nextArchived',
  'parentArchived',
  'parentPinned',
  'pins',
  'pressure',
  'ratio',
  'relay',
  'revision',
  'sessionId',
  'sessionPinned',
  'settingsError',
  'summaries',
  'surfaceTokens',
  'thresholds',
  'window',
];

/** 父记录 / 子记录的键顺序（= JSON.stringify 的字节顺序，**不许重排**）。 */
const PARENT_RECORD_KEYS = [
  'parentId',
  'childId',
  'ordinal',
  'at',
  'atIso',
  'parentSessionId',
  'index',
  'path',
  'planId',
  'title',
  'baseTitle',
  'scheme',
  'titleSeq',
  'historyTitle',
  'rootId',
];
const CHILD_RECORD_KEYS = ['parentId', 'childId', 'ordinal', 'baseTitle', 'title', 'scheme', 'titleSeq', 'path', 'at', 'atIso'];

const SHAPES = {
  empty: `advice=string
busy=boolean
capabilities.forceArchive=boolean
capabilities.unarchive=boolean
chain=null
colors.autoAdapt=boolean
colors.base.compact=string
colors.base.handoff=string
colors.base.idle=string
colors.base.pin=string
colors.base.stage=string
colors.mode=string
colors.palette.dark.compact=string
colors.palette.dark.handoff=string
colors.palette.dark.idle=string
colors.palette.dark.pin=string
colors.palette.dark.stage=string
colors.palette.light.compact=string
colors.palette.light.handoff=string
colors.palette.light.idle=string
colors.palette.light.pin=string
colors.palette.light.stage=string
compactRange=null
compactRangeReason=null
compressHint=null
favoriteSuggest[]=empty
favorites.count=number
favorites.messageIds[]=empty
favorites.seqs[]=empty
favorites.truncated=boolean
hasParent=null
lastCompaction=null
level=string
native.autoEnabled=boolean
native.contextWindow=null
native.headroomTokens=number
native.overridden=boolean
native.ratio=null
native.reservedCompletionTokens=null
native.route=null
native.thresholdRatio=number
native.thresholdTokens=null
native.unavailable=null
next=null
nextArchived=null
parentArchived=null
parentPinned=null
pins.atRisk=null
pins.count=number
pins.marks[]=empty
pins.seqs[]=empty
pins.stale.count=number
pins.stale.native=number
pins.stale.other=number
pins.stale.seqs[]=empty
pins.stale.unknown=number
pressure=null
ratio=number
relay=null
revision=number
sessionId=null
sessionPinned=null
settingsError=null
summaries=number
surfaceTokens=null
thresholds.compactAt=number
thresholds.compactRatio=number
thresholds.handoffAt=number
thresholds.handoffRatio=number
thresholds.maxSummaries=number
thresholds.window=number
window=number`,
  noChain: `advice=string
busy=boolean
capabilities.forceArchive=boolean
capabilities.unarchive=boolean
chain=null
colors.autoAdapt=boolean
colors.base.compact=string
colors.base.handoff=string
colors.base.idle=string
colors.base.pin=string
colors.base.stage=string
colors.mode=string
colors.palette.dark.compact=string
colors.palette.dark.handoff=string
colors.palette.dark.idle=string
colors.palette.dark.pin=string
colors.palette.dark.stage=string
colors.palette.light.compact=string
colors.palette.light.handoff=string
colors.palette.light.idle=string
colors.palette.light.pin=string
colors.palette.light.stage=string
compactRange.endSeq=number
compactRange.merge.maxSummaries=number
compactRange.merge.merges=boolean
compactRange.merge.normalLeft=number
compactRange.merge.summaries=number
compactRange.nodes=number
compactRange.startSeq=number
compactRange.tokens=number
compactRangeReason=string
compressHint=null
favoriteSuggest[]=empty
favorites.count=number
favorites.messageIds[]=empty
favorites.seqs[]=empty
favorites.truncated=boolean
hasParent=boolean
lastCompaction=null
level=string
native.autoEnabled=boolean
native.contextWindow=number
native.headroomTokens=number
native.overridden=boolean
native.ratio=number
native.reservedCompletionTokens=number
native.route.model=string
native.route.provider=string
native.route.reasoningEffort=string
native.thresholdRatio=number
native.thresholdTokens=number
native.unavailable=null
next=null
nextArchived=null
parentArchived=null
parentPinned=null
pins.atRisk=null
pins.count=number
pins.marks[]=empty
pins.seqs[]=empty
pins.stale.count=number
pins.stale.native=number
pins.stale.other=number
pins.stale.seqs[]=empty
pins.stale.unknown=number
pressure=number
ratio=number
relay=null
revision=number
sessionId=string
sessionPinned=boolean
settingsError=null
summaries=number
surfaceTokens=number
thresholds.compactAt=number
thresholds.compactRatio=number
thresholds.handoffAt=number
thresholds.handoffRatio=number
thresholds.maxSummaries=number
thresholds.window=number
window=number`,
  chainParent: `advice=string
busy=boolean
capabilities.forceArchive=boolean
capabilities.unarchive=boolean
chain.baseTitle=string
chain.childId=string
chain.ordinal=number
chain.parentId=string
chain.path=string
chain.scheme=string
colors.autoAdapt=boolean
colors.base.compact=string
colors.base.handoff=string
colors.base.idle=string
colors.base.pin=string
colors.base.stage=string
colors.mode=string
colors.palette.dark.compact=string
colors.palette.dark.handoff=string
colors.palette.dark.idle=string
colors.palette.dark.pin=string
colors.palette.dark.stage=string
colors.palette.light.compact=string
colors.palette.light.handoff=string
colors.palette.light.idle=string
colors.palette.light.pin=string
colors.palette.light.stage=string
compactRange=null
compactRangeReason=null
compressHint=null
favoriteSuggest[]=empty
favorites.count=number
favorites.messageIds[]=empty
favorites.seqs[]=empty
favorites.truncated=boolean
hasParent=boolean
lastCompaction=null
level=string
native.autoEnabled=boolean
native.contextWindow=number
native.headroomTokens=number
native.overridden=boolean
native.ratio=number
native.reservedCompletionTokens=number
native.route.model=string
native.route.provider=string
native.route.reasoningEffort=string
native.thresholdRatio=number
native.thresholdTokens=number
native.unavailable=null
next.baseTitle=string
next.childId=string
next.ordinal=number
next.parentId=string
next.path=string
next.scheme=string
nextArchived=boolean
parentArchived=boolean
parentPinned=boolean
pins.atRisk=null
pins.count=number
pins.marks[]=empty
pins.seqs[]=empty
pins.stale.count=number
pins.stale.native=number
pins.stale.other=number
pins.stale.seqs[]=empty
pins.stale.unknown=number
pressure=number
ratio=number
relay.at=number
relay.atIso=string
relay.baseTitle=string
relay.childId=string
relay.historyTitle=string
relay.index=number
relay.ordinal=number
relay.parentId=string
relay.parentSessionId=string
relay.path=string
relay.planId=null
relay.rootId=string
relay.scheme=string
relay.title=string
relay.titleSeq=number
revision=number
sessionId=string
sessionPinned=boolean
settingsError=null
summaries=number
surfaceTokens=number
thresholds.compactAt=number
thresholds.compactRatio=number
thresholds.handoffAt=number
thresholds.handoffRatio=number
thresholds.maxSummaries=number
thresholds.window=number
window=number`,
  chainChild: `advice=string
busy=boolean
capabilities.forceArchive=boolean
capabilities.unarchive=boolean
chain.baseTitle=string
chain.childId=string
chain.ordinal=number
chain.parentId=string
chain.path=string
chain.scheme=string
colors.autoAdapt=boolean
colors.base.compact=string
colors.base.handoff=string
colors.base.idle=string
colors.base.pin=string
colors.base.stage=string
colors.mode=string
colors.palette.dark.compact=string
colors.palette.dark.handoff=string
colors.palette.dark.idle=string
colors.palette.dark.pin=string
colors.palette.dark.stage=string
colors.palette.light.compact=string
colors.palette.light.handoff=string
colors.palette.light.idle=string
colors.palette.light.pin=string
colors.palette.light.stage=string
compactRange=null
compactRangeReason=null
compressHint=null
favoriteSuggest[]=empty
favorites.count=number
favorites.messageIds[]=empty
favorites.seqs[]=empty
favorites.truncated=boolean
hasParent=boolean
lastCompaction=null
level=string
native.autoEnabled=boolean
native.contextWindow=number
native.headroomTokens=number
native.overridden=boolean
native.ratio=number
native.reservedCompletionTokens=number
native.route.model=string
native.route.provider=string
native.route.reasoningEffort=string
native.thresholdRatio=number
native.thresholdTokens=number
native.unavailable=null
next=null
nextArchived=null
parentArchived=boolean
parentPinned=boolean
pins.atRisk=null
pins.count=number
pins.marks[]=empty
pins.seqs[]=empty
pins.stale.count=number
pins.stale.native=number
pins.stale.other=number
pins.stale.seqs[]=empty
pins.stale.unknown=number
pressure=number
ratio=number
relay.at=number
relay.atIso=string
relay.baseTitle=string
relay.childId=string
relay.historyTitle=null
relay.index=number
relay.ordinal=number
relay.parentId=string
relay.parentSessionId=string
relay.path=string
relay.planId=null
relay.scheme=string
relay.title=string
relay.titleSeq=number
revision=number
sessionId=string
sessionPinned=boolean
settingsError=null
summaries=number
surfaceTokens=number
thresholds.compactAt=number
thresholds.compactRatio=number
thresholds.handoffAt=number
thresholds.handoffRatio=number
thresholds.maxSummaries=number
thresholds.window=number
window=number`,
  legacyChild: `advice=string
busy=boolean
capabilities.forceArchive=boolean
capabilities.unarchive=boolean
chain.baseTitle=string
chain.childId=string
chain.ordinal=number
chain.parentId=string
chain.scheme=string
chain.synthesized=boolean
colors.autoAdapt=boolean
colors.base.compact=string
colors.base.handoff=string
colors.base.idle=string
colors.base.pin=string
colors.base.stage=string
colors.mode=string
colors.palette.dark.compact=string
colors.palette.dark.handoff=string
colors.palette.dark.idle=string
colors.palette.dark.pin=string
colors.palette.dark.stage=string
colors.palette.light.compact=string
colors.palette.light.handoff=string
colors.palette.light.idle=string
colors.palette.light.pin=string
colors.palette.light.stage=string
compactRange=null
compactRangeReason=null
compressHint=null
favoriteSuggest[]=empty
favorites.count=number
favorites.messageIds[]=empty
favorites.seqs[]=empty
favorites.truncated=boolean
hasParent=boolean
lastCompaction=null
level=string
native.autoEnabled=boolean
native.contextWindow=number
native.headroomTokens=number
native.overridden=boolean
native.ratio=number
native.reservedCompletionTokens=number
native.route.model=string
native.route.provider=string
native.route.reasoningEffort=string
native.thresholdRatio=number
native.thresholdTokens=number
native.unavailable=null
next=null
nextArchived=null
parentArchived=boolean
parentPinned=boolean
pins.atRisk=null
pins.count=number
pins.marks[]=empty
pins.seqs[]=empty
pins.stale.count=number
pins.stale.native=number
pins.stale.other=number
pins.stale.seqs[]=empty
pins.stale.unknown=number
pressure=number
ratio=number
relay=null
revision=number
sessionId=string
sessionPinned=boolean
settingsError=null
summaries=number
surfaceTokens=number
thresholds.compactAt=number
thresholds.compactRatio=number
thresholds.handoffAt=number
thresholds.handoffRatio=number
thresholds.maxSummaries=number
thresholds.window=number
window=number`,
  noRegistry: `advice=string
busy=boolean
capabilities.forceArchive=boolean
capabilities.unarchive=boolean
chain.baseTitle=string
chain.childId=string
chain.ordinal=number
chain.parentId=string
chain.path=string
chain.scheme=string
colors.autoAdapt=boolean
colors.base.compact=string
colors.base.handoff=string
colors.base.idle=string
colors.base.pin=string
colors.base.stage=string
colors.mode=string
colors.palette.dark.compact=string
colors.palette.dark.handoff=string
colors.palette.dark.idle=string
colors.palette.dark.pin=string
colors.palette.dark.stage=string
colors.palette.light.compact=string
colors.palette.light.handoff=string
colors.palette.light.idle=string
colors.palette.light.pin=string
colors.palette.light.stage=string
compactRange=null
compactRangeReason=null
compressHint=null
favoriteSuggest[]=empty
favorites.count=number
favorites.messageIds[]=empty
favorites.seqs[]=empty
favorites.truncated=boolean
hasParent=boolean
lastCompaction=null
level=string
native.autoEnabled=boolean
native.contextWindow=number
native.headroomTokens=number
native.overridden=boolean
native.ratio=number
native.reservedCompletionTokens=number
native.route.model=string
native.route.provider=string
native.route.reasoningEffort=string
native.thresholdRatio=number
native.thresholdTokens=number
native.unavailable=null
next=null
nextArchived=null
parentArchived=null
parentPinned=null
pins.atRisk=null
pins.count=number
pins.marks[]=empty
pins.seqs[]=empty
pins.stale.count=number
pins.stale.native=number
pins.stale.other=number
pins.stale.seqs[]=empty
pins.stale.unknown=number
pressure=number
ratio=number
relay.at=number
relay.atIso=string
relay.baseTitle=string
relay.childId=string
relay.historyTitle=null
relay.index=number
relay.ordinal=number
relay.parentId=string
relay.parentSessionId=string
relay.path=string
relay.planId=null
relay.scheme=string
relay.title=string
relay.titleSeq=number
revision=number
sessionId=string
sessionPinned=null
settingsError=null
summaries=number
surfaceTokens=number
thresholds.compactAt=number
thresholds.compactRatio=number
thresholds.handoffAt=number
thresholds.handoffRatio=number
thresholds.maxSummaries=number
thresholds.window=number
window=number`,
};

const VALUES = {
  empty: `{
  "relay": null,
  "chain": null,
  "next": null,
  "parentArchived": null,
  "nextArchived": null,
  "parentPinned": null,
  "sessionPinned": null,
  "capabilities": {
    "unarchive": true,
    "forceArchive": true
  }
}`,
  noChain: `{
  "relay": null,
  "chain": null,
  "next": null,
  "parentArchived": null,
  "nextArchived": null,
  "parentPinned": null,
  "sessionPinned": false,
  "capabilities": {
    "unarchive": true,
    "forceArchive": true
  }
}`,
  chainParent: `{
  "relay": {
    "parentId": "<childA1>",
    "childId": "<childA2>",
    "ordinal": 2,
    "at": "<at>",
    "atIso": "<atIso>",
    "parentSessionId": "<childA1>",
    "index": 2,
    "path": "<path>",
    "planId": null,
    "title": "原会话标题",
    "baseTitle": "原会话标题",
    "scheme": "history-n",
    "titleSeq": 4,
    "historyTitle": "历史 2：原会话标题",
    "rootId": "<rootId>"
  },
  "chain": {
    "ordinal": 1,
    "baseTitle": "原会话标题",
    "parentId": "<parentA>",
    "childId": "<childA1>",
    "scheme": "history-n",
    "path": "<path>"
  },
  "next": {
    "ordinal": 2,
    "baseTitle": "原会话标题",
    "parentId": "<childA1>",
    "childId": "<childA2>",
    "scheme": "history-n",
    "path": "<path>"
  },
  "parentArchived": true,
  "nextArchived": false,
  "parentPinned": false,
  "sessionPinned": false,
  "capabilities": {
    "unarchive": true,
    "forceArchive": true
  }
}`,
  chainChild: `{
  "relay": {
    "parentId": "<childA1>",
    "childId": "<childA2>",
    "ordinal": 2,
    "at": "<at>",
    "atIso": "<atIso>",
    "parentSessionId": "<childA1>",
    "index": 2,
    "path": "<path>",
    "planId": null,
    "title": "原会话标题",
    "baseTitle": "原会话标题",
    "scheme": "history-n",
    "titleSeq": 3,
    "historyTitle": null
  },
  "chain": {
    "ordinal": 2,
    "baseTitle": "原会话标题",
    "parentId": "<childA1>",
    "childId": "<childA2>",
    "scheme": "history-n",
    "path": "<path>"
  },
  "next": null,
  "parentArchived": true,
  "nextArchived": null,
  "parentPinned": false,
  "sessionPinned": false,
  "capabilities": {
    "unarchive": true,
    "forceArchive": true
  }
}`,
  legacyChild: `{
  "relay": null,
  "chain": {
    "ordinal": 3,
    "baseTitle": "老链题",
    "parentId": "<legacyParent>",
    "childId": "<legacyKid>",
    "scheme": "handoff-n",
    "synthesized": true
  },
  "next": null,
  "parentArchived": false,
  "nextArchived": null,
  "parentPinned": false,
  "sessionPinned": false,
  "capabilities": {
    "unarchive": true,
    "forceArchive": true
  }
}`,
  noRegistry: `{
  "relay": {
    "parentId": "<childA1>",
    "childId": "<childA2>",
    "ordinal": 2,
    "at": "<at>",
    "atIso": "<atIso>",
    "parentSessionId": "<childA1>",
    "index": 2,
    "path": "<path>",
    "planId": null,
    "title": "原会话标题",
    "baseTitle": "原会话标题",
    "scheme": "history-n",
    "titleSeq": 3,
    "historyTitle": null
  },
  "chain": {
    "ordinal": 2,
    "baseTitle": "原会话标题",
    "parentId": "<childA1>",
    "childId": "<childA2>",
    "scheme": "history-n",
    "path": "<path>"
  },
  "next": null,
  "parentArchived": null,
  "nextArchived": null,
  "parentPinned": null,
  "sessionPinned": null,
  "capabilities": {
    "unarchive": false,
    "forceArchive": false
  }
}`,
};

/* ================================================================== *
 * 3b. 期望生成器（只在有意改契约时用）
 *
 *   node test/contract-golden.mjs --print-golden
 *
 * 打印出的两个常量整段替换上面的 __GOLDEN_SHAPES__ / __GOLDEN_VALUES__ 占位，
 * 然后人工 review 每一条差异：结构/类型/键顺序的变化都要能说出「为什么」。
 * ================================================================== */

if (process.argv.includes('--print-golden')) {
  const literalOf = (object) =>
    Object.entries(object)
      .map(([name, text]) => `  ${name}: \`${text}\`,`)
      .join('\n');
  const shapes = {};
  const values = {};
  for (const [name, frame] of Object.entries(frames)) {
    shapes[name] = shapeOf(frame);
    values[name] = JSON.stringify(contractValuesOf(frame), null, 2);
  }
  console.log('const SHAPES = {\n' + literalOf(shapes) + '\n};\n');
  console.log('const VALUES = {\n' + literalOf(values) + '\n};\n');
  process.exit(0);
}

/* ================================================================== *
 * 4. readState 帧契约（S1-a）
 * ================================================================== */

{
  // 4.1 顶层键集合：S5 拆投影时最容易顺手改名/加字段，这里一次锁死。
  for (const [name, frame] of Object.entries(frames)) {
    assert.deepEqual(Object.keys(frame).sort(), FRAME_KEYS, `${name}: readState 顶层键集合变了（S1 契约）`);
    assert.equal(typeof frame.revision, 'number', `${name}: revision 必须是 number（客户端按它丢弃乱序帧）`);
    assert.equal(frame.capabilities !== null && typeof frame.capabilities === 'object', true, `${name}: capabilities 必须是对象`);
  }

  // 4.2 结构与类型快照（不锁值）。
  for (const [name, frame] of Object.entries(frames)) {
    assert.equal(shapeOf(frame), SHAPES[name], `${name}: readState 帧的结构/类型与 golden 不一致`);
  }

  // 4.3 链投影取值（id/时间戳/路径规范化后逐字段比对）。
  for (const [name, frame] of Object.entries(frames)) {
    assert.equal(
      JSON.stringify(contractValuesOf(frame), null, 2),
      VALUES[name],
      `${name}: relay/chain/next 的取值与 golden 不一致`,
    );
  }

  // 4.4 快照之外再独立核对几条「值」语义（不靠 golden 自证）。
  {
    const parentState = frames.chainParent;
    assert.equal(parentState.chain.ordinal, 1, '父会话的 chain 必须是**入站**那一跳（第 1 跳）');
    assert.equal(parentState.chain.childId, childA1.id, 'chain.childId 是本会话');
    assert.equal(parentState.chain.path, hopA1.result.path, 'chain.path 是入站那跳的交接单');
    assert.equal(parentState.chain.scheme, 'history-n');
    assert.equal('synthesized' in parentState.chain, false, 'record 投影不带 synthesized');
    assert.equal(parentState.next.ordinal, 2, '父会话的 next 必须是**出站**那一跳（第 2 跳）');
    assert.equal(parentState.next.childId, childA2.id);
    assert.equal(parentState.next.path, hopA2.result.path);
    assert.equal(parentState.relay.ordinal, 2, 'relay 是日志里最近一条（出站），语义一个字节不改');
    assert.equal(parentState.parentArchived, true, '父会话（source）已自动归档');
    assert.equal(parentState.nextArchived, false, '出站目标是新会话，未归档');

    const childState = frames.chainChild;
    assert.equal(childState.chain.path, hopA2.result.path);
    assert.equal(childState.next, null, '新链子会话没有出站记录');
    assert.equal(childState.parentArchived, true, '子会话的父会话（child1）已被归档');
    // 0.5.2 L 项：强制归档的数据源 —— 旧会话置顶状态 + 宿主能力位（独立于 golden 再核一遍）。
    assert.equal(childState.parentPinned, false, '子会话的旧会话（child1）未置顶');
    assert.equal(frames.noChain.parentPinned, null, '没有链 → parentPinned=null（不猜 false）');
    assert.equal(frames.noRegistry.parentPinned, null, '读不到置顶集合 → parentPinned=null');
    assert.equal(childState.capabilities.forceArchive, true, '宿主有 archiveSession → 强制归档能力位为 true');
    assert.equal(frames.noRegistry.capabilities.forceArchive, false, '没有 registry → 强制归档能力位为 false');

    assert.equal(frames.legacyChild.chain.synthesized, true, '老链兜底链带 synthesized 标记');
    assert.equal(frames.legacyChild.chain.ordinal, 3, '老链序号来自标题「交接第 3 次」');
    assert.equal(frames.legacyChild.chain.baseTitle, '老链题');
    assert.equal(frames.legacyChild.chain.parentId, 'session-legacy-parent');
    assert.equal(frames.legacyChild.relay, null, '老链没有 record');
    assert.equal(frames.noChain.chain, null);
    assert.equal(frames.noChain.relay, null);
    assert.equal(frames.empty.sessionId, null, '没有目标会话时 sessionId=null');

    // 0.5.6-C：hasParent 是「会话头口径」的只读提示，不依赖日志/记录。
    //   没有 target → null（不知道，客户端仍可尝试磁盘兜底）；
    //   普通根会话 → false（客户端据此零额外请求）；
    //   header.parentSession 的老链子会话 → true。
    // 注：新链子会话在 contract-golden 的 fake host 里**没有**把 meta.parentSession
    // 落进 MockSession.header（真实宿主会落，见 lib/dsh/sessions.js），所以这两帧只锁
    // 类型（boolean），取值语义由 test/state-passive.mjs 的 4b 段单独锁。
    assert.equal(frames.empty.hasParent, null, '没有目标会话 → hasParent=null（不知道，不是 false）');
    assert.equal(frames.noChain.hasParent, false, '普通根会话 → hasParent=false');
    assert.equal(frames.legacyChild.hasParent, true, '老链子会话（header.parentSession）→ hasParent=true');
    assert.equal(frames.chainParent.hasParent, false, 'fake host 不落 meta.parentSession → 新链父会话这里为 false');

    // relay 的时间口径：at 是 epoch ms，atIso 是**本地** ISO（含时区偏移），不是 UTC。
    const relay = frames.chainChild.relay;
    assert.equal(Number.isFinite(relay.at), true);
    assert.equal(relay.atIso, localIso(new Date(relay.at)), 'atIso 必须与 at 同源（本地 ISO，diag-counters 口径）');
    assert.match(relay.atIso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    assert.equal(Math.abs(Date.now() - relay.at) < 60_000, true, 'at 是这次交接的时间');
  }
}

console.log('PASS  0.5.2 S1 readState 帧：6 场景键集合 + 结构与类型快照 + 链投影取值（chain=入站/next=出站）');

/* ================================================================== *
 * 5. 父/子 relay record 契约（S1-b）
 * ================================================================== */

{
  // 5.1 真实新链两跳：父/子记录的键集合与顺序（JSONL 字节序）。
  for (const hop of hopsA) {
    const parentRecord = parentRecordOf(hop);
    const childRecord = childRecordOf(hop.child);
    assert.notEqual(parentRecord, undefined, `第 ${hop.ordinal} 跳父记录必须存在`);
    assert.deepEqual(Object.keys(parentRecord), PARENT_RECORD_KEYS, `第 ${hop.ordinal} 跳父记录键顺序（record 字节契约）`);
    assert.deepEqual(Object.keys(childRecord), CHILD_RECORD_KEYS, `第 ${hop.ordinal} 跳子记录键顺序（record 字节契约）`);
    // 任何值都不能是 undefined：JSON.stringify 会把 undefined 键**静默丢弃**（字节就变了）。
    for (const [label, record] of [['父', parentRecord], ['子', childRecord]]) {
      for (const [key, value] of Object.entries(record)) {
        assert.notEqual(value, undefined, `第 ${hop.ordinal} 跳${label}记录 ${key} 不能是 undefined（会被 JSON 吞掉）`);
      }
      assert.deepEqual(JSON.parse(JSON.stringify(record)), record, `第 ${hop.ordinal} 跳${label}记录必须 JSON 往返稳定`);
    }
  }

  // 5.2 新链第 1 跳：逐字段取值（父记录 = 13+historyTitle；子记录 = 9+path）。
  {
    const parentRecord = parentRecordOf(hopA1);
    const childRecord = childRecordOf(childA1);
    const relayAtOfParent = parentRecord.at;
    assert.equal(parentRecord.parentId, parentA.id);
    assert.equal(parentRecord.childId, childA1.id);
    assert.equal(parentRecord.ordinal, 1);
    assert.equal(parentRecord.parentSessionId, parentA.id, '0.3 旧字段 parentSessionId 必须双写');
    assert.equal(parentRecord.index, 1, '0.3 旧字段 index 必须双写');
    assert.equal(parentRecord.path, hopA1.result.path, '父记录 path = 已落盘的交接单');
    assert.equal(typeof parentRecord.planId, 'string', '这次交接前有压缩 → planId 是字符串');
    assert.equal(parentRecord.title, '原会话标题', '新链新会话标题 = 干净原名');
    assert.equal(parentRecord.baseTitle, '原会话标题');
    assert.equal(parentRecord.scheme, 'history-n');
    assert.equal(parentRecord.titleSeq, 2 * hopA1.ordinal, '父记录 titleSeq 取**旧会话** rename 的 eventSeq（每跳第 2 次 rename）');
    assert.equal(parentRecord.historyTitle, '历史 1：原会话标题', '改名生效 → 写 historyTitle');
    assert.equal(Number.isFinite(relayAtOfParent), true);
    assert.equal(parentRecord.atIso, localIso(new Date(relayAtOfParent)), '父记录 atIso 与 at 同源');

    assert.equal(childRecord.parentId, parentA.id);
    assert.equal(childRecord.childId, childA1.id);
    assert.equal(childRecord.ordinal, 1);
    assert.equal(childRecord.baseTitle, '原会话标题');
    assert.equal(childRecord.title, '原会话标题');
    assert.equal(childRecord.scheme, 'history-n');
    assert.equal(childRecord.titleSeq, 2 * hopA1.ordinal - 1, '子记录 titleSeq 取**子会话** rename 的 eventSeq（每跳第 1 次 rename）');
    assert.equal(childRecord.path, hopA1.result.path, '子记录带同一个交接单 path');
    assert.equal(Number.isFinite(childRecord.at), true);
    assert.equal(childRecord.atIso, localIso(new Date(childRecord.at)));
    assert.equal('parentSessionId' in childRecord, false, '子记录**不写** 0.3 旧字段 parentSessionId');
    assert.equal('index' in childRecord, false, '子记录**不写** 0.3 旧字段 index');
    assert.equal('planId' in childRecord, false, '子记录**不写** planId');
    assert.equal('historyTitle' in childRecord, false, '子记录**不写** historyTitle');
  }

  // 5.3 新链第 2 跳：从 record 续号（不靠标题），父子 titleSeq 各取**自己**那次 rename。
  //     夹具的 renameEventSeq 是 ({call}) => call，每跳固定两次 rename：先子会话、后旧会话。
  //     这里因此断言关系式（2N-1 / 2N）而不是写死 1/2/3/4 —— 顺序变化仍会被抓到。
  {
    const parentRecord = parentRecordOf(hopA2);
    const childRecord = childRecordOf(hopA2.child);
    assert.equal(parentRecord.ordinal, 2, '第 2 跳序号来自父会话的入站 record');
    assert.equal(parentRecord.historyTitle, '历史 2：原会话标题');
    assert.equal(parentRecord.titleSeq, 2 * hopA2.ordinal, '父记录 titleSeq = 本次旧会话 rename 的 eventSeq');
    assert.equal(childRecord.titleSeq, 2 * hopA2.ordinal - 1, '子记录 titleSeq = 本次子会话 rename 的 eventSeq');
    assert.equal(childRecord.ordinal, 2);
    // planId 是恒写键（可能 null）；具体 null/字符串取决于这次交接前压了什么，交给单测锁 null 路径。
    assert.equal('planId' in parentRecord, true, 'planId 是恒写键，不是条件写入');
    assert.equal(parentRecord.planId === null || typeof parentRecord.planId === 'string', true, 'planId 只能 null/string');
  }

  // 5.4 父会话改名失败：historyTitle 不写键、titleSeq 写 null（键仍存在）——最容易在「统一美化」时丢的差异。
  {
    const parentRecord = parentRecordOf(hopB);
    assert.deepEqual(Object.keys(parentRecord), PARENT_RECORD_KEYS.filter((key) => key !== 'historyTitle'));
    assert.equal(parentRecord.scheme, 'history-n');
    assert.equal(parentRecord.titleSeq, null, '没 rename 成功 → titleSeq 写 null（不是省略）');
    assert.equal('titleSeq' in parentRecord, true, 'titleSeq 必须存在');
    assert.equal('historyTitle' in parentRecord, false, '不能记录一个没生效的历史标题');
    assert.equal(typeof parentRecord.planId === 'string' || parentRecord.planId === null, true, 'planId 只能是字符串或 null');
    assert.equal(childRecordOf(hopB.child).historyTitle === undefined, true, '子记录永远没有 historyTitle');
  }

  // 5.5 老链（handoff-n）：父/子记录 scheme 一致，父记录 titleSeq=null、无 historyTitle，标题一字符不改。
  {
    const parentRecord = parentRecordOf(hopC);
    const childRecord = childRecordOf(hopC.child);
    assert.equal(hopC.plan.scheme, 'handoff-n', '「交接第 N 次」标题 = 旧链');
    assert.equal(parentRecord.scheme, 'handoff-n');
    assert.equal(childRecord.scheme, 'handoff-n');
    assert.equal(parentRecord.ordinal, 3);
    assert.equal(childRecord.ordinal, 3);
    assert.equal(parentRecord.title, '交接第 3 次：老链题', '旧链标题一个字符不改');
    assert.equal(childRecord.title, '交接第 3 次：老链题');
    assert.equal(parentRecord.titleSeq, null, '旧链不改名 → titleSeq null');
    assert.equal('historyTitle' in parentRecord, false, '旧链不写 historyTitle');
    assert.deepEqual(Object.keys(parentRecord), PARENT_RECORD_KEYS.filter((key) => key !== 'historyTitle'));
    assert.equal(typeof parentRecord.planId, 'string', '干净的老会话这次交接前有压缩 → planId 是字符串');
  }

  // 5.6 读侧往返：真实记录过一遍 normalizeRelayRecord 再投影，字段不增不减（读侧行为不变）。
  {
    const parentRecord = parentRecordOf(hopA1);
    const normalized = normalizeRelayRecord(parentRecord);
    assert.equal(normalized.ordinal, parentRecord.ordinal);
    assert.equal(normalized.index, parentRecord.ordinal);
    assert.equal(normalized.parentSessionId, parentRecord.parentId);
    assert.equal(normalized.path, parentRecord.path);
    assert.equal(normalized.titleSeq, parentRecord.titleSeq);
    assert.equal(normalized.historyTitle, parentRecord.historyTitle);
    const legacy = normalizeRelayRecord({ parentSessionId: 'p0', childId: 'c0', index: 2, at: 1 });
    assert.deepEqual(legacy, {
      parentId: 'p0',
      childId: 'c0',
      ordinal: 2,
      at: 1,
      atIso: null,
      parentSessionId: 'p0',
      index: 2,
      planId: null,
      scheme: null,
      titleSeq: null,
      historyTitle: null,
    }, '0.3 旧记录（只有 parentSessionId/index/childId/at）读取形状不变');
  }
}

console.log('PASS  0.5.2 S1 父/子 relay record：键顺序 + null/省略语义 + 新链/改名失败/老链三条真实流程');

/* ================================================================== *
 * 6. 标题格式契约（S1-c）
 * ================================================================== */

{
  // 6.1 splitHandoffTitle：all 输入形态 → 固定期望（handedOff/baseTitle/scheme 三元组）。
  const splitTable = [
    [undefined, { baseTitle: '会话', handedOff: 0, scheme: 'legacy' }],
    ['', { baseTitle: '会话', handedOff: 0, scheme: 'legacy' }],
    ['   ', { baseTitle: '会话', handedOff: 0, scheme: 'legacy' }],
    ['原会话标题', { baseTitle: '原会话标题', handedOff: 0, scheme: 'legacy' }],
    ['交接第 2 次：原题', { baseTitle: '原题', handedOff: 2, scheme: 'handoff-n' }],
    ['交接第2次:原题', { baseTitle: '原题', handedOff: 2, scheme: 'handoff-n' }],
    ['  交接第 12 次：  原题  ', { baseTitle: '原题', handedOff: 12, scheme: 'handoff-n' }],
    ['交接第 3 次：', { baseTitle: '会话', handedOff: 3, scheme: 'handoff-n' }],
    ['历史 2：原题', { baseTitle: '原题', handedOff: 2, scheme: 'history-n' }],
    ['历史2:原题', { baseTitle: '原题', handedOff: 2, scheme: 'history-n' }],
    ['历史 0：原题', { baseTitle: '原题', handedOff: 0, scheme: 'history-n' }],
    ['交接：原题', { baseTitle: '原题', handedOff: 1, scheme: 'legacy' }],
    ['交接：交接：原题', { baseTitle: '原题', handedOff: 2, scheme: 'legacy' }],
    ['接棒：原题', { baseTitle: '原题', handedOff: 1, scheme: 'legacy' }],
    ['接棒：交接：原题', { baseTitle: '原题', handedOff: 2, scheme: 'legacy' }],
    ['交接第 2 次：历史 5：原题', { baseTitle: '历史 5：原题', handedOff: 2, scheme: 'handoff-n' }],
  ];
  for (const [input, expected] of splitTable) {
    assert.deepEqual(splitHandoffTitle(input), expected, `splitHandoffTitle(${JSON.stringify(input)})`);
  }

  // 6.2 relayTitleOf / historyTitleOf：格式逐字节固定（空格位置、全角冒号、trim、空题回落）。
  assert.equal(relayTitleOf(2, '原题'), '交接第 2 次：原题');
  assert.equal(relayTitleOf(2, ''), '交接第 2 次：会话');
  assert.equal(relayTitleOf(2), '交接第 2 次：会话');
  assert.equal(relayTitleOf(2, '  原题  '), '交接第 2 次：原题');
  assert.equal(relayTitleOf(12, '原题'), '交接第 12 次：原题');
  assert.equal(historyTitleOf(1, '原题'), '历史 1：原题');
  assert.equal(historyTitleOf(1), '历史 1：会话');
  assert.equal(historyTitleOf(3, '  '), '历史 3：会话');
  assert.equal(historyTitleOf(1, '原题', undefined), '历史 1：原题', '不传预算 = 不截断（0.4.3 纯函数行为）');

  // 80 字节预算：前缀「历史 1：」= 11 字节先计入预算，只缩 base，不切坏多字节字符。
  assert.equal(Buffer.byteLength('历史 1：', 'utf8'), 11, 'golden 前提：前缀就是 11 字节');
  assert.equal(MAX_TITLE_BYTES, 80);
  assert.equal(historyTitleOf(1, 'X'.repeat(100), MAX_TITLE_BYTES), `历史 1：${'X'.repeat(69)}`, '80-11=69 个 ASCII');
  assert.equal(Buffer.byteLength(historyTitleOf(1, 'X'.repeat(100), MAX_TITLE_BYTES), 'utf8'), 80);
  assert.equal(historyTitleOf(1, '中'.repeat(41), MAX_TITLE_BYTES), `历史 1：${'中'.repeat(23)}`, '69 字节放得下 23 个汉字（69B）');
  assert.equal(Buffer.byteLength(historyTitleOf(1, '中'.repeat(41), MAX_TITLE_BYTES), 'utf8'), 80);
  assert.equal(historyTitleOf(7, '原题', 8), '历史 7：', '预算连 base 都放不下 → 只保留前缀');
  assert.equal(historyTitleOf(7, '原题', -1), '历史 7：原题', '非法预算按不截断处理');

  // 6.3 handoffTitlePlanOf：典型输出（无 record 的干净题/旧链题/历史题/脏题 + 有 record 的续号）。
  const planCtx = (title) => ({ get: (name) => (name === 'sessionTitle' ? { get: () => ({ title }) } : undefined) });
  const planSession = (id, events = []) => new MockSession({ id, events });
  const planTable = [
    // [标题, 会话事件, 期望]
    [
      '原会话标题',
      [],
      { index: 1, baseTitle: '原会话标题', title: '原会话标题', historyTitle: '历史 1：原会话标题', scheme: 'history-n', viaRecord: false },
    ],
    [
      '交接第 2 次：老链题',
      [],
      { index: 3, baseTitle: '老链题', title: '交接第 3 次：老链题', historyTitle: null, scheme: 'handoff-n', viaRecord: false },
    ],
    [
      '历史 2：老链题',
      [],
      { index: 3, baseTitle: '老链题', title: '老链题', historyTitle: '历史 3：老链题', scheme: 'history-n', viaRecord: false },
    ],
    [
      undefined,
      [],
      { index: 1, baseTitle: '会话', title: '交接第 1 次：会话', historyTitle: null, scheme: 'handoff-n', viaRecord: false },
    ],
    [
      'A'.repeat(100),
      [],
      {
        index: 1,
        baseTitle: 'A'.repeat(100),
        title: 'A'.repeat(80),
        historyTitle: `历史 1：${'A'.repeat(69)}`,
        scheme: 'history-n',
        viaRecord: false,
      },
    ],
  ];
  for (const [title, events, expected] of planTable) {
    const session = planSession('session-plan-fixture', events);
    assert.deepEqual(handoffTitlePlanOf(planCtx(title), session), expected, `handoffTitlePlanOf(title=${JSON.stringify(title)})`);
  }

  // 有 record 时以 record 为准（不读标题里的链号；0.3 旧记录读 index）。
  {
    const recordEvent = (data) => ({ type: RELAY_RECORD_TYPE, ignorable: true, data });
    const modern = planSession('session-plan-record', [
      recordEvent({ parentId: 'p', childId: 'session-plan-record', ordinal: 5, baseTitle: 'R题', scheme: 'history-n', titleSeq: 1, at: 1 }),
    ]);
    assert.deepEqual(handoffTitlePlanOf(planCtx('原会话标题'), modern), {
      index: 6,
      baseTitle: 'R题',
      title: 'R题',
      historyTitle: '历史 6：R题',
      scheme: 'history-n',
      viaRecord: true,
    }, '新链 record 续号：以 record 的 scheme/baseTitle 为准（标题里的链号不参与）');

    const legacy = planSession('session-plan-old', [
      recordEvent({ parentSessionId: 'p', childId: 'session-plan-old', index: 7, at: 1 }),
    ]);
    assert.deepEqual(handoffTitlePlanOf(planCtx('交接第 9 次：标题题'), legacy), {
      index: 8,
      baseTitle: '标题题',
      title: '交接第 8 次：标题题',
      historyTitle: null,
      scheme: 'handoff-n',
      viaRecord: true,
    }, '0.3 旧记录（只有 index、无 baseTitle/scheme）：index+1=8，按旧链命名，baseTitle 回退标题解析');

    // 老链子会话标题是「交接第 N 次：X」但 record 说 history-n → scheme 以 record 为准（链级 cutover）。
    const cutover = planSession('session-plan-cut', [
      recordEvent({ parentId: 'p', childId: 'session-plan-cut', ordinal: 2, baseTitle: 'C题', scheme: 'history-n', at: 1 }),
    ]);
    assert.equal(handoffTitlePlanOf(planCtx('交接第 2 次：C题'), cutover).scheme, 'history-n');
  }
}

console.log('PASS  0.5.2 S1 标题格式：splitHandoffTitle/relayTitleOf/historyTitleOf/handoffTitlePlanOf 固定期望（含 80B 预算）');

/* ================================================================== *
 * 7. 负向自检 —— 断言机制必须对「改一个键/改一个值/换键顺序」敏感
 *
 * 手工复核（已在本分支逐条做过：改 → 红 → 改回 → 绿；红在哪一条见括号）：
 *   a) 把 core/relay-record.js 父记录的 `scheme` 改成 `'x'`
 *      → 4.2 `chainParent` 帧结构/类型快照红（'x' 不在读侧白名单 → normalize 读成 null，
 *      `"scheme": null` 与 `"history-n"` 是不同结构）；改成同类型的 `'handoff-n'`（只改值）
 *      → 4.3 `VALUES.chainParent` 取值快照红（`"scheme": "handoff-n"` vs `"history-n"`）。
 *   b) 把子记录构造里的 `titleSeq` 删掉
 *      → 4.2 `chainChild` 的 `relay.titleSeq=number` 变 `null` 红；
 *      同时 test/relay-record.mjs 的「与 0.5.1 手写形状逐字节一致」deepEqual 红。
 *   c) 把 actions/state.js 的 `chain` 从入站记录改成「最近一条记录」（= 出站）
 *      → 4.3 `VALUES.chainParent.chain.ordinal` 2≠1 红（4.4 的「chain 必须是入站那一跳」也会红）。
 * 下面这组断言把「机制本身」也锁进测试：即使生产代码没改，快照比较也必须能发现差异。
 * ================================================================== */

{
  const sample = { ordinal: 1, baseTitle: '原题', scheme: 'history-n', path: '/tmp/h.md' };

  // (a) 改一个值：值快照与形状快照的表现不同 —— 值快照必须红，类型快照保持绿（不锁值的证据）。
  assert.notDeepEqual(normalizedChainOf({ ...sample, scheme: 'x' }), normalizedChainOf(sample), '值变了，取值快照必须红');
  assert.equal(shapeOf({ ...sample, scheme: 'x' }), shapeOf(sample), '只改值不改类型 → 类型快照必须保持绿（不锁值）');

  // (b) 删一个键：键集合/类型快照必须红。
  const { path: _dropped, ...withoutPath } = sample;
  assert.notDeepEqual(Object.keys(withoutPath), Object.keys(sample), '删键 → 键集合必须红');
  assert.notEqual(shapeOf(withoutPath), shapeOf(sample), '删键 → 类型快照必须红');

  // (c) 改类型：null → 0 / string → number 必须被类型快照抓到。
  assert.notEqual(shapeOf({ path: null }), shapeOf({ path: '' }), 'null 与空串是不同契约（path 有才带键）');
  assert.notEqual(shapeOf({ ordinal: null }), shapeOf({ ordinal: 0 }), '序号 null 与 0 是不同契约');

  // (d) 键顺序：record 的键序契约由上面的 `Object.keys` deepEqual 守卫（重排副本会红）；
  // 不再用 JSON.stringify 自证 —— 那是恒真断言，不是有效自检。
}

console.log('PASS  0.5.2 S1 负向自检：改键/改值/改类型/换键序都会被快照抓到（见上方手工复核清单）');
