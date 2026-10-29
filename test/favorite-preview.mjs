/**
 * 0.6 压缩预览卡「收藏 / 建议补收藏」区块 —— 后端数据契约单测。
 *
 *   node test/favorite-preview.mjs
 *
 * 锁住五件事（preview 响应只做 additive 字段，既有契约不动）：
 *   1. preview.favoritePreview.favorited = 本段已收藏**条目**（seq + 角色 + 标题片段），
 *      角色复用 pin-anchors.roleLabelOf、标题复用 favorites.buildFavoriteTitle；
 *   2. preview.favoritePreview.suggest = pinSuggest 同一套识别的候选，**去掉本段已收藏的 seq**
 *      （语义从「建议锁定」改成「建议收藏」，不新写启发式）；
 *   3. favoriteHits / pinSuggest 等既有字段保持原样（兼容旧客户端与既有断言）；
 *   4. 预览纯只读：不改会话日志、不写收藏文件（红线：绝不自动收藏）；
 *   5. 用户发言也能被 favorite-mark 按 seq 收藏（标记层不要求活 agent），收完预览列表/计数同步。
 *
 * 纯 node 跑；DSH_HOME 指到临时目录，不读写真实 ~/.dsh；不调 LLM、零网络。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLock } from '../lib/actions/lock.js';
import { markFavoriteBySeq } from '../lib/actions/favorite.js';
import { previewBetterCompact } from '../lib/actions/better-compact.js';
import { resolveConfig } from '../lib/config.js';
import { DIRECTORY_MAX } from '../lib/core/favorites.js';
import { PIN_SUGGEST_REASONS } from '../lib/core/pin-suggest.js';
import { favoritesFileOf } from '../lib/dsh/favorites-file.js';
import { MockSession } from './harness/session.mjs';

// 收藏文件写到临时 DSH_HOME（defaultDshHome 在调用时读 env，import 之后设置也生效）。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-favorite-preview-'));
process.env.DSH_HOME = tmpHome;

/* ------------------------------------------------------------------ *
 * 夹具：与 pin-contract.mjs 同一套 DSH v4 事件形状
 * ------------------------------------------------------------------ */

function userMsg(text, source = { kind: 'user' }) {
  return { type: 'user/message', data: { content: text, source } };
}
function assistantMsg(text) {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } };
}

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

function previewSession(id = 'session-fav-preview') {
  return new MockSession({
    id,
    events: [
      userMsg('不要改 lib/api.js 的公开接口，必须保留原样，其他随你'), // seq0 明确要求别改
      assistantMsg('TypeError: cb is not a function\n    at run (/app/index.js:12:5)'), // seq1 报错堆栈
      userMsg('好的，继续'), // seq2 反例：普通用户消息（但用户可以手动收藏它）
      assistantMsg('决定采用方案 B（事件驱动替代轮询），结论已写进交接单'), // seq3 关键决策
    ],
  });
}

/* ================================================================== *
 * ① 没有收藏时：字段齐全 / 建议 = 全部候选 / 文案改成收藏口径
 * ================================================================== */

const session = previewSession();
const agent = { id: 'agent-fav-preview', session };
const favoriteFile = favoritesFileOf(deps.ctx, session);
const clean = await previewBetterCompact(deps, { agent });

assert.equal(clean.ok, true);
assert.notEqual(clean.preview, null);
const cleanFavorite = clean.preview.favoritePreview;
assert.notEqual(cleanFavorite, null, 'preview 要有 additive 字段 favoritePreview');
assert.equal(cleanFavorite.total, clean.preview.nodes, 'total = 本段条数');
assert.equal(cleanFavorite.favoritedCount, 0);
assert.deepEqual(cleanFavorite.favorited, [], '没有收藏时条目列表为空');
assert.equal(cleanFavorite.suggest.length, 3, '没有收藏时建议补 = 全部候选');
assert.deepEqual(
  cleanFavorite.suggest.map((item) => item.seq),
  [0, 1, 3],
  '建议补候选与 pinSuggest 同一套识别',
);
assert.deepEqual(
  cleanFavorite.suggest.map((item) => item.role),
  ['用户', '助手', '助手'],
  '建议条目的角色来自 roleLabelOf',
);
assert.equal(
  cleanFavorite.suggest.every((item) => typeof item.reason === 'string' && item.reason.length > 0),
  true,
  '每条建议带理由',
);
assert.equal(
  cleanFavorite.suggest.every((item) => item.snippet.length > 0 && item.snippet.length <= 60),
  true,
  '每条建议带 ≤60 字符摘要（不贴全文）',
);
// 兼容字段保持原样：pinSuggest / favoriteHits 结构不变（旧客户端/既有断言继续可用）。
assert.equal(clean.preview.pinSuggest.count, 3, 'pinSuggest 兼容字段保留');
assert.deepEqual(clean.preview.favoriteHits, { inRange: 0, total: 4 });
assert.equal(clean.message.includes('建议先点星收藏'), true, '文案改成收藏口径');
assert.equal(clean.message.includes('只提示，不会自动收藏'), true);
assert.equal(clean.message.includes('/pin'), false, 'pin 已下线：文案不能再指回 /pin');
assert.equal(fs.existsSync(favoriteFile), false, '预览不写收藏文件（没有收藏时连文件都不该出现）');

console.log('PASS  0.6 预览收藏：无收藏时 favoritePreview 全量建议（角色/理由/摘要）+ 文案改收藏口径');

/* ================================================================== *
 * ② 收藏两条后：已收藏条目（角色+标题）/ 建议补排除已收藏 / 预览只读
 * ================================================================== */

await markFavoriteBySeq(deps, { sessionId: session.id, seq: 0, active: true }); // 用户「别改」
await markFavoriteBySeq(deps, { sessionId: session.id, seq: 3, active: true }); // 助手「关键决策」
const fileBefore = fs.readFileSync(favoriteFile, 'utf8');
const logBefore = session.log.length;
const preview = await previewBetterCompact(deps, { agent });
const favorite = preview.preview.favoritePreview;

assert.equal(favorite.total, 4);
assert.equal(favorite.favoritedCount, 2);
assert.deepEqual(
  favorite.favorited.map((item) => item.seq),
  [0, 3],
  '已收藏条目按本段顺序（seq 升序）',
);
assert.deepEqual(favorite.favorited.map((item) => item.role), ['用户', '助手'], '条目带角色标签');
assert.equal(favorite.favorited[0].title.includes('不要改'), true, '用户条目标题来自正文片段');
assert.equal(favorite.favorited[1].title.includes('决定采用方案 B'), true, '助手条目标题来自正文片段');
assert.ok(favorite.favorited.every((item) => item.title.length > 0 && item.title.length <= 60));
assert.deepEqual(favorite.suggest.map((item) => item.seq), [1], '建议补要排除已收藏的 seq');
assert.equal(favorite.suggest[0].reason, PIN_SUGGEST_REASONS.error, '剩下的候选理由不变');
assert.deepEqual(preview.preview.favoriteHits, { inRange: 2, total: 4 }, 'favoriteHits 既有字段口径不变');
assert.equal(preview.preview.pinSuggest.count, 3, 'pinSuggest 兼容字段不因收藏而变');
assert.equal(preview.message.includes('已收藏 2 条'), true);
assert.equal(preview.message.includes('这 1 条还没收藏'), true, '文案只数还没收藏的候选');
// 红线：预览只读——不写会话日志、不写收藏文件、不自动收藏。
assert.equal(session.log.length, logBefore, '预览不写会话事件');
assert.equal(fs.readFileSync(favoriteFile, 'utf8'), fileBefore, '预览不改收藏文件');

console.log('PASS  0.6 预览收藏：已收藏条目（[用户]/[助手]+标题）/ 建议补排除已收藏 / 预览只读零自动收藏');

/* ================================================================== *
 * ③ 用户发言按 seq 收藏：favorite-mark 的 active:true 幂等只加不切换
 * ================================================================== */

const userMark = await markFavoriteBySeq(deps, { sessionId: session.id, seq: 2, active: true });
assert.equal(userMark.active, true);
assert.equal(userMark.seq, 2);
const again = await markFavoriteBySeq(deps, { sessionId: session.id, seq: 2, active: true });
assert.equal(again.active, true, 'active:true 幂等：已是收藏状态不会切换成取消');
assert.equal(again.note, 'already');
const afterUser = await previewBetterCompact(deps, { agent });
assert.equal(afterUser.preview.favoritePreview.favoritedCount, 3);
assert.deepEqual(
  afterUser.preview.favoritePreview.favorited.map((item) => item.seq),
  [0, 2, 3],
  '用户发言也能被收藏并出现在本段已收藏列表',
);
assert.equal(afterUser.preview.favoritePreview.favorited[1].role, '用户');
assert.equal(afterUser.preview.favoritePreview.favorited[1].title.includes('好的，继续'), true);

console.log('PASS  0.6 预览收藏：用户发言可按 seq 收藏（active:true 幂等只加）+ 列表/计数同步');

/* ================================================================== *
 * ④ 已收藏超过 DIRECTORY_MAX：条目列表截断、favoritedCount 仍是全量
 * ================================================================== */

const manySession = new MockSession({
  id: 'session-fav-many',
  events: Array.from({ length: 25 }, (_, index) => userMsg(`第 ${index} 条普通消息，只是占一条历史记录`)),
});
const manyAgent = { id: 'agent-fav-many', session: manySession };
for (let seq = 0; seq < 25; seq += 1) {
  await markFavoriteBySeq(deps, { sessionId: manySession.id, seq, active: true });
}
const manyPreview = await previewBetterCompact(deps, { agent: manyAgent });
const manyFavorite = manyPreview.preview.favoritePreview;
assert.equal(manyFavorite.favoritedCount, 25, 'favoritedCount 是全量数');
assert.equal(manyFavorite.favorited.length, DIRECTORY_MAX, '条目列表按 DIRECTORY_MAX 截断');
assert.equal(manyFavorite.total, 25);
assert.equal(manyPreview.preview.favoriteHits.inRange, 25);

console.log('PASS  0.6 预览收藏：已收藏 > DIRECTORY_MAX 时条目截断、favoritedCount 仍全量');

console.log(`\nfavorite-preview：DSH_HOME=${tmpHome}`);
