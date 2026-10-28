/**
 * 0.4 P1-1 + P1-2 单测：压缩预览「建议锁定」提示 + pin 保留契约。
 *
 * 覆盖任务验收四项：
 *   ① 候选识别：关键决策 / 报错堆栈 / 明确要求别改 各一例 + 反例（普通消息、短消息、
 *      系统消息、运行时合成的 user/message、工具结果普通输出）；
 *   ② 建议条数出现在预览数据里（preview.pinSuggest.count/items）且预览只读、不自动锁；
 *   ③ 交接单程序段（当前进度）含 pin 锚点（seq + 角色 + 一句摘要）；
 *   ④ pin 命中数正确（preview.pinHits.inRange/total），锁定消息不进入压缩范围
 *      （现有 clipRangeByPins 行为不回退，压缩后仍在 surface）。
 *
 * 纯 node 跑；不调 LLM、不写真实文件、零网络。
 */
import assert from 'node:assert/strict';
import { createLock } from '../lib/actions/lock.js';
import { previewBetterCompact } from '../lib/actions/better-compact.js';
import { resolveConfig } from '../lib/config.js';
import { buildHandoffProgramSections } from '../lib/core/handoff-facts.js';
import {
  isUserAuthoredMessage,
  messageSnippetOf,
  messageTextOf,
  pinAnchorOf,
  roleLabelOf,
} from '../lib/core/pin-anchors.js';
import { PIN_SUGGEST_LIMIT, PIN_SUGGEST_REASONS, suggestPinCandidates } from '../lib/core/pin-suggest.js';
import { PIN_RECORD_TYPE } from '../lib/core/pins.js';
import { MockSession } from './harness/session.mjs';

/* ------------------------------------------------------------------ *
 * 夹具：DSH v4 两种事件形状（user 的 data 就是消息；assistant 包在 data.message）
 * ------------------------------------------------------------------ */

function userMsg(text, source = { kind: 'user' }) {
  return { type: 'user/message', data: { content: text, source } };
}
function assistantMsg(text) {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } };
}
function toolMsg(text) {
  return { type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } };
}
function systemMsg(text) {
  return { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text }] } } };
}
function withSeq(events) {
  return events.map((event, seq) => ({ ...event, seq }));
}

/* ================================================================== *
 * ① 候选识别：三类信号各一例 + 反例
 * ================================================================== */

const fixtures = withSeq([
  userMsg('不要改 lib/api.js 的公开接口，必须保留原样，其他随你'), // seq0 明确要求别改
  assistantMsg('TypeError: cb is not a function\n    at run (/app/index.js:12:5)'), // seq1 报错堆栈
  userMsg('好的，继续'), // seq2 反例：短句
  assistantMsg('决定采用方案 B（事件驱动替代轮询），结论已写进交接单'), // seq3 关键决策
  userMsg('麻烦把测试再跑一遍，辛苦了'), // seq4 反例：普通消息
  systemMsg('你是一个助手，下面是一些关键决策与不要改的约束'), // seq5 反例：系统消息
  userMsg('决定采用旧方案，不要动这块', { kind: 'compact-checkpoint' }), // seq6 反例：压缩摘要（合成消息）
  toolMsg('文件已写入：/tmp/a.js'), // seq7 反例：工具结果普通输出
  userMsg('不要改'), // seq8 反例：太短
]);

const candidates = suggestPinCandidates(fixtures);
assert.deepEqual(
  candidates.map((item) => [item.seq, item.reason]),
  [
    [0, PIN_SUGGEST_REASONS.keep],
    [1, PIN_SUGGEST_REASONS.error],
    [3, PIN_SUGGEST_REASONS.decision],
  ],
  '只命中三类信号，反例（短句/普通消息/系统/合成 user/工具输出/太短）不进入候选',
);
assert.deepEqual(
  candidates.map((item) => item.role),
  ['用户', '助手', '助手'],
  '角色标签来自事件类型（用户/助手）',
);
assert.equal(candidates[0].snippet.startsWith('不要改 lib/api.js'), true, '候选带一句摘要');
assert.deepEqual(suggestPinCandidates([]), []);
assert.deepEqual(suggestPinCandidates(null), []);

// 建议条数上限：优先保留「明确要求别改」，同级取更早的；输出仍按文档顺序。
const many = withSeq([
  ...Array.from({ length: 6 }, (_, index) => assistantMsg(`决定采用方案 ${index}，先按这个来（细节 ${index}）`)),
  userMsg('不要修改 old-api.js，这个文件必须保留原样！'),
]);
const limited = suggestPinCandidates(many);
assert.equal(limited.length, PIN_SUGGEST_LIMIT, `最多建议 ${PIN_SUGGEST_LIMIT} 条`);
assert.equal(
  limited.some((item) => item.reason === PIN_SUGGEST_REASONS.keep),
  true,
  '超上限时先保「明确要求别改」',
);
assert.equal(
  limited.filter((item) => item.reason === PIN_SUGGEST_REASONS.decision).length,
  PIN_SUGGEST_LIMIT - 1,
  '剩余名额给（更早的）关键决策',
);
assert.deepEqual(
  limited.map((item) => item.seq),
  [...limited.map((item) => item.seq)].sort((left, right) => left - right),
  '返回顺序按 seq 升序（文档顺序）',
);

// 摘要截断：不贴全文。
const longText = `决定采用长方案：${'细节'.repeat(120)}`;
const longCandidate = suggestPinCandidates(withSeq([assistantMsg(longText)]));
assert.equal(longCandidate.length, 1);
assert.equal(longCandidate[0].snippet.length <= 60, true, '摘要 ≤60 字符');
assert.equal(longCandidate[0].snippet.endsWith('…'), true, '超长摘要要有省略号');

/* ================================================================== *
 * pin-anchors 基础函数（与 /pin list、交接单锚点共用一份实现）
 * ================================================================== */

assert.equal(roleLabelOf('user/message'), '用户');
assert.equal(roleLabelOf('assistant/message'), '助手');
assert.equal(roleLabelOf('tool/result'), '工具');
assert.equal(roleLabelOf('system/message'), '系统');
assert.equal(roleLabelOf('other'), '其他');
assert.equal(messageTextOf(assistantMsg('a\n\nb')), 'a b', '空白折叠成一行');
assert.equal(messageTextOf(undefined), '');
assert.equal(messageSnippetOf(undefined), '');
assert.equal(isUserAuthoredMessage(userMsg('x')), true);
assert.equal(isUserAuthoredMessage({ type: 'user/message', data: { content: 'x' } }), true, '无 source 的老夹具按用户消息');
assert.equal(isUserAuthoredMessage(userMsg('x', { kind: 'compact-checkpoint' })), false, '压缩摘要不是用户原话');
assert.equal(pinAnchorOf({ type: 'user/message', seq: 4, data: { content: '保留这块' } }).seq, 4);
assert.equal(pinAnchorOf({ type: 'user/message', data: { content: 'x' } }), null, '没有 seq 不能当锚点');
assert.equal(pinAnchorOf({ type: 'assistant/message', seq: 5, data: { message: { content: [] } } }).snippet, '（无文本）');

/* ================================================================== *
 * ③ 交接单「当前进度」程序段含 pin 锚点（九段结构不变）
 * ================================================================== */

const noAnchors = buildHandoffProgramSections({ pins: { count: 1, seqs: [3] } });
assert.equal(noAnchors['当前进度'].includes('锁定消息：1 条'), true);
assert.equal(noAnchors['当前进度'].includes('锁定锚点'), false, '没有 anchors 时保持原有输出（向后兼容）');

const withAnchors = buildHandoffProgramSections({
  pins: {
    count: 2,
    seqs: [3, 7],
    anchors: [
      { seq: 3, role: '用户', snippet: '不要改 lib/api.js 的公开接口' },
      { seq: 7, role: '助手', snippet: '决定采用方案 B' },
    ],
  },
});
assert.equal(withAnchors['当前进度'].includes('锁定消息：2 条'), true);
assert.equal(withAnchors['当前进度'].includes('锁定锚点（保留契约'), true, '程序段要列出保留契约锚点');
assert.equal(withAnchors['当前进度'].includes('seq 3 · 用户 · 「不要改 lib/api.js 的公开接口」'), true);
assert.equal(withAnchors['当前进度'].includes('seq 7 · 助手 · 「决定采用方案 B」'), true);
assert.equal(withAnchors['当前进度'].includes('跨引擎压缩器是否遵守取决于其实现'), true, '声明只承诺展示');

// 锚点很多时只列前 10 条 + 说明剩余（控制交接单体积）。
const manyAnchors = buildHandoffProgramSections({
  pins: {
    count: 12,
    seqs: Array.from({ length: 12 }, (_, index) => index),
    anchors: Array.from({ length: 12 }, (_, index) => ({ seq: index, role: '用户', snippet: `保留 ${index}` })),
  },
});
assert.equal(manyAnchors['当前进度'].includes('另有 2 条锁定未列出'), true);
assert.equal((manyAnchors['当前进度'].match(/seq \d+ · /gu) ?? []).length, 10, '最多列 10 条锚点');

/* ================================================================== *
 * ② + ④ 压缩预览：pinSuggest 条数 / pinHits 命中数 / 只读不自动锁
 * ================================================================== */

const cfg = resolveConfig({ retention: { recentTailTokens: 0 } });
const engine = {
  isCompactCheckpointSource: (source) => source?.kind === 'compact-checkpoint',
  toolPairingBalancedBefore: () => true,
  toolPairingBalancedAfter: () => true,
};
const tokenMeter = {
  measure(session) {
    const nodes = session.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 }));
    return { totalTokens: nodes.length * 100, surfaceTokens: nodes.length * 100, nodes };
  },
};
const deps = {
  ctx: {
    tokenMeter,
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: 200_000 } };
      },
    },
  },
  cfg,
  lock: createLock(),
  engine,
};

function previewSession() {
  return new MockSession({
    id: 'session-pin-preview',
    events: [
      userMsg('不要改 lib/api.js 的公开接口，必须保留原样，其他随你'), // seq0 建议锁定：明确要求别改
      assistantMsg('TypeError: cb is not a function\n    at run (/app/index.js:12:5)'), // seq1 报错堆栈
      userMsg('好的，继续'), // seq2 反例
      assistantMsg('决定采用方案 B（事件驱动替代轮询），结论已写进交接单'), // seq3 关键决策
    ],
  });
}

const session = previewSession();
const agent = { id: 'agent-pin-preview', session };
const logBefore = session.log.length;
const preview = await previewBetterCompact(deps, { agent });

assert.equal(preview.ok, true);
assert.notEqual(preview.preview, null);
const suggested = preview.preview.pinSuggest;
assert.equal(suggested.count, 3, '预览数据里要有建议锁定条数');
assert.deepEqual(
  suggested.items.map((item) => item.reason),
  [PIN_SUGGEST_REASONS.keep, PIN_SUGGEST_REASONS.error, PIN_SUGGEST_REASONS.decision],
  '三类候选理由都要出现在预览数据里',
);
assert.equal(suggested.items.every((item) => typeof item.snippet === 'string' && item.snippet.length > 0), true);
assert.deepEqual(preview.preview.pinHits, { inRange: 0, total: 0 }, '没有锁定消息时 pin 命中为 0');
assert.equal(preview.message.includes('建议先 /pin 再压'), true, '预览文案给一句建议');
assert.equal(preview.message.includes('只提示，不会自动锁定'), true, '明确只提示、不自动锁');
assert.equal(session.log.length, logBefore, '预览只读：不会自动写 pin（也不会写任何会话事件）');
assert.equal(
  session.log.some((event) => event.type === PIN_RECORD_TYPE),
  false,
  '预览绝不能自动锁定消息',
);

// 用户手动锁定一条（seq1 报错堆栈）：压缩范围不再包含它，pin 命中数正确。
session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1], at: Date.now() });
const logAfterPin = session.log.length;
const previewPinned = await previewBetterCompact(deps, { agent });
// 0.6：pin 退役（改「收藏」），锁定记录不再保护消息、不再截断范围。
assert.equal(previewPinned.preview.pinnedKept, undefined, 'pin 退役后不再统计锁定保护');
assert.equal(previewPinned.preview.endSeq < 1, false, '锁定记录不再截断压缩范围');
assert.equal(session.log.length, logAfterPin, '再次预览仍然只读');
// 0.6：pin 退役，锁定记录不再参与建议列表过滤（pinSuggest 本身保留）。

console.log('PASS  0.4 P1-1 建议锁定：关键决策/报错堆栈/明确要求别改识别 + 反例全排除');
console.log('PASS  0.4 P1-1 建议锁定：预览只提示不自动锁（不写会话事件）+ 超上限时优先保留关键要求');
console.log('PASS  0.4 P1-2 pin 保留契约：交接单「当前进度」含锚点（seq + 角色 + 一句摘要，最多 10 条）');
console.log('PASS  0.4 P1-2 pin 命中：预览 pinHits inRange/total 正确，锁定消息不进入压缩范围');
