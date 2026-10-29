/**
 * 推荐收藏单测（0.5.3 P1-6/P1-7）：
 *   1) 打分纯函数：档位阈值、词表规范化/匹配、判定顺序（屏蔽 > 必亮 > 分数）；
 *   2) 模型打分：stub ctx.llm.stream 返回 JSON → 解析出分数；模型失败/乱输出 → null（不亮）；
 *   3) 事件钩子：必亮词命中 → 生成建议（不发模型调用）；屏蔽词 → 不生成；
 *      **红线：任何路径都不写收藏文件**（DSH_HOME 临时目录里不出现 dcr-favorites）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FAVORITE_SCORE_LEVELS,
  decideFavoriteSuggest,
  favoriteScoreThresholdOf,
  matchFavoriteWord,
  normalizeFavoriteLevel,
  normalizeFavoriteWords,
  parseFavoriteScore,
} from '../lib/core/favorite-score.js';
import { DEFAULT_CONFIG } from '../lib/core/config-schema.js';
import { listFavoriteSuggestions } from '../lib/actions/favorite.js';
import { scoreFavoriteMessage } from '../lib/dsh/favorite-scorer.js';
import { createFavoriteWatcher } from '../lib/dsh/favorite-watch.js';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-favorite-suggest-'));
process.env.DSH_HOME = tmpHome;

// ---------- 1) 纯函数 ----------
assert.deepEqual(FAVORITE_SCORE_LEVELS, { loose: 60, standard: 75, strict: 85 });
assert.equal(favoriteScoreThresholdOf('loose'), 60);
assert.equal(favoriteScoreThresholdOf('strict'), 85);
assert.equal(favoriteScoreThresholdOf('nope'), 75);
assert.equal(normalizeFavoriteLevel('loose'), 'loose');
assert.equal(normalizeFavoriteLevel('what'), 'standard');

assert.deepEqual(normalizeFavoriteWords([' 定案 ', '定案', '', 3, '12345678901234567']), ['定案', '123456789012']);
assert.equal(normalizeFavoriteWords(Array.from({ length: 30 }, (_, i) => `词${i}`)).length, 20);
assert.equal(matchFavoriteWord('这里要按这个定案', ['定案']), '定案');
assert.equal(matchFavoriteWord('这里要按这个定案', ['测试']), null);
assert.equal(matchFavoriteWord('ABC 结论', ['abc']), 'abc'); // 大小写无关

// 判定顺序：屏蔽词优先于必亮词，必亮词跳过分数；模型失败 → 不亮（fail closed）
assert.deepEqual(
  decideFavoriteSuggest({ text: '定案：按这个做，别看测试了', score: 99, mustWords: ['定案'], muteWords: ['测试'] }),
  { suggest: false, score: null, matched: '测试', reason: 'mute-word' },
);
assert.deepEqual(
  decideFavoriteSuggest({ text: '这个方案已经定案，就按这样执行', score: null, mustWords: ['定案'], muteWords: [] }),
  { suggest: true, score: null, matched: '定案', reason: 'must-word' },
);
assert.equal(
  decideFavoriteSuggest({ text: '这是一个足够长的结论内容', score: 74, level: 'standard' }).suggest,
  false,
);
assert.equal(
  decideFavoriteSuggest({ text: '这是一个足够长的结论内容', score: 75, level: 'standard' }).suggest,
  true,
);
assert.equal(
  decideFavoriteSuggest({ text: '这是一个足够长的结论内容', score: 61, level: 'loose' }).suggest,
  true,
);
assert.equal(
  decideFavoriteSuggest({ text: '这是一个足够长的结论内容', score: 84, level: 'strict' }).suggest,
  false,
);
assert.equal(decideFavoriteSuggest({ text: '太短', score: 100 }).reason, 'too-short');
assert.equal(decideFavoriteSuggest({ text: '这是一个足够长的结论内容', score: null }).reason, 'unknown-score');

// 分数解析：代码围栏 / 多余文字 / 越界 clamp / 乱输出 null
assert.deepEqual(parseFavoriteScore('```json\n{"score":82,"reason":"结论"}\n```'), { score: 82, reason: '结论' });
assert.deepEqual(parseFavoriteScore('好的，结果：{"score":120}'), { score: 100, reason: '' });
assert.equal(parseFavoriteScore('没有 JSON'), null);
assert.equal(parseFavoriteScore('{"score":"高分"}'), null);

// ---------- 2) 模型打分（stub llm.stream） ----------
class StubAssembler {
  push(chunk) {
    this.text = typeof chunk === 'string' ? chunk : chunk.text;
  }
  blocks() {
    return [{ type: 'text', text: this.text }];
  }
}

function scorerDeps(streamImpl) {
  return {
    ctx: { llm: { stream: streamImpl } },
    engine: { BlockAssembler: StubAssembler },
    cfg: {},
  };
}

const session = {
  id: 'session-suggest-1',
  requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-flash' } }),
};
const agent = { id: session.id, session };

const ok = await scoreFavoriteMessage(
  scorerDeps(async function* () {
    yield '{"score":82,"reason":"结论"}';
  }),
  { agent, text: '这是一个足够长的结论内容，值得收藏' },
);
assert.deepEqual(ok, { score: 82, reason: '结论', provider: 'deepseek', model: 'deepseek-flash' });

const failed = await scoreFavoriteMessage(
  scorerDeps(async function* () {
    throw new Error('network down');
  }),
  { agent, text: '这是一个足够长的结论内容' },
);
assert.equal(failed, null);

const garbage = await scoreFavoriteMessage(
  scorerDeps(async function* () {
    yield '我不打分';
  }),
  { agent, text: '这是一个足够长的结论内容' },
);
assert.equal(garbage, null);

const noSession = await scoreFavoriteMessage(scorerDeps(async function* () {}), { agent: {}, text: '内容' });
assert.equal(noSession, null);

// ---------- 3) 事件钩子 ----------
const watcherDeps = {
  ctx: {},
  engine: {},
  cfg: {
    favorite: { enabled: true, level: 'standard', mustWords: ['定案'], muteWords: ['测试'] },
  },
};
const watcher = createFavoriteWatcher(watcherDeps);
assert.deepEqual(watcher.suggestionOf(session.id), []);

const mustEvent = {
  seq: 7,
  type: 'assistant/message',
  data: { message: { id: 'msg-must', content: [{ type: 'text', text: '这个方案定案了，就按这个执行。' }] } },
};
watcher.onEvent(session, mustEvent);
await new Promise((resolve) => setTimeout(resolve, 1400)); // 去抖窗口 1.2s
const mustSuggestions = watcher.suggestionOf(session.id);
assert.equal(mustSuggestions.length, 1);
assert.equal(mustSuggestions[0].seq, 7);
assert.equal(mustSuggestions[0].messageId, 'msg-must');
assert.equal(mustSuggestions[0].reason, 'must-word');
assert.equal(mustSuggestions[0].matched, '定案');

const muteEvent = {
  seq: 8,
  type: 'assistant/message',
  data: { message: { id: 'msg-mute', content: [{ type: 'text', text: '这只是测试用的回复，不用当真。' }] } },
};
watcher.onEvent(session, muteEvent);
await new Promise((resolve) => setTimeout(resolve, 1400));
assert.equal(watcher.suggestionOf(session.id).length, 1); // 屏蔽词没有新增建议

// 关闭推荐 → 不再产生建议
const offWatcher = createFavoriteWatcher({ ...watcherDeps, cfg: { favorite: { enabled: false } } });
offWatcher.onEvent(session, mustEvent);
await new Promise((resolve) => setTimeout(resolve, 1400));
assert.deepEqual(offWatcher.suggestionOf(session.id), []);

// ---------- 3b) 0.5.4 D3：压缩后清空建议投影（被压走的 seq 不能残留） ----------
// 此时 watcher 里有一条 seq7 建议（必亮词命中）。
watcher.onEvent(session, { seq: 20, type: 'compaction/summary', data: { compactionId: 'c1' } });
assert.deepEqual(watcher.suggestionOf(session.id), [], 'compaction/summary 后本会话建议立即清空');
// `/favorite suggest` 读的就是这份投影：压缩后不能再列出被压走的 seq。
const afterClearListing = listFavoriteSuggestions({ favoriteWatch: watcher }, { agent: { session } });
assert.deepEqual(afterClearListing.suggestions, [], '/favorite suggest 压缩后不再列出旧建议');
assert.equal(afterClearListing.message.includes('暂时没有推荐'), true, '命令文案回到「暂时没有推荐」');

// 压缩后新回合照常打分（去抖 / 每回合一次 / 只判最后一条 均不受影响）。
const afterCompactEvent = {
  seq: 21,
  type: 'assistant/message',
  data: { message: { id: 'msg-after-compact', content: [{ type: 'text', text: '压缩之后这个方案也定案了。' }] } },
};
watcher.onEvent(session, afterCompactEvent);
await new Promise((resolve) => setTimeout(resolve, 1400));
const afterCompact = watcher.suggestionOf(session.id);
assert.equal(afterCompact.length, 1);
assert.equal(afterCompact[0].seq, 21, '压缩后新消息仍能产生建议');

// 去抖窗口内压缩：待跑的打分要取消，不能把旧 seq 又写回建议。
const pendingEvent = {
  seq: 22,
  type: 'assistant/message',
  data: { message: { id: 'msg-pending', content: [{ type: 'text', text: '压缩前刚发的这条也定案了。' }] } },
};
watcher.onEvent(session, pendingEvent);
watcher.onEvent(session, { seq: 23, type: 'compaction/end', data: { compactionId: 'c1' } });
await new Promise((resolve) => setTimeout(resolve, 1400));
assert.deepEqual(watcher.suggestionOf(session.id), [], '去抖窗口内压缩 → 旧消息打分被取消');

// 模型打分在跑时压缩：旧世代结果丢弃（不会事后把被压走的 seq 写回建议）。
const slowDeps = {
  ctx: {
    llm: {
      stream: async function* () {
        await new Promise((resolve) => setTimeout(resolve, 300));
        yield '{"score":92,"reason":"结论"}';
      },
    },
  },
  engine: { BlockAssembler: StubAssembler },
  cfg: { favorite: { enabled: true, level: 'standard', mustWords: [], muteWords: [] } },
};
const slowWatcher = createFavoriteWatcher(slowDeps);
const inFlightEvent = {
  seq: 30,
  type: 'assistant/message',
  data: { message: { id: 'msg-inflight', content: [{ type: 'text', text: '这是一段足够长的助手回复，内容涉及系统架构与取舍。' }] } },
};
slowWatcher.onEvent(session, inFlightEvent);
await new Promise((resolve) => setTimeout(resolve, 1300)); // 去抖到点，模型打分在跑（300ms）
slowWatcher.onEvent(session, { seq: 31, type: 'compaction/summary', data: { compactionId: 'c2' } });
await new Promise((resolve) => setTimeout(resolve, 600));
assert.deepEqual(slowWatcher.suggestionOf(session.id), [], '压缩后旧世代的模型打分结果要丢弃');
slowWatcher.close();

// 其它事件不误清：compaction/start 只是开始（可能失败），不清建议。
const keepWatcher = createFavoriteWatcher(watcherDeps);
keepWatcher.onEvent(session, mustEvent);
await new Promise((resolve) => setTimeout(resolve, 1400));
keepWatcher.onEvent(session, { seq: 40, type: 'compaction/start', data: { compactionId: 'c3' } });
assert.equal(keepWatcher.suggestionOf(session.id).length, 1, 'compaction/start 不清建议（事务可能失败）');
keepWatcher.close();

console.log(
  'PASS  0.5.4 D3 压缩清理：summary/end 清空建议 + 取消待跑打分 + 丢弃在跑旧世代结果 + start 不误清',
);

// 红线：任何路径都不写收藏文件
assert.equal(fs.existsSync(path.join(tmpHome, 'dcr-favorites')), false);

// 配置默认值（设置页/合并依赖这张表）
assert.equal(DEFAULT_CONFIG.favorite.enabled, true);
assert.equal(DEFAULT_CONFIG.favorite.level, 'standard');
assert.deepEqual([...DEFAULT_CONFIG.favorite.mustWords], []);
assert.deepEqual([...DEFAULT_CONFIG.favorite.muteWords], []);

watcher.close();
offWatcher.close();
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log('PASS  推荐收藏：档位阈值 / 词表规范化与优先级 / 分数解析 / 模型失败不亮');
console.log('PASS  推荐收藏钩子：必亮词命中出建议、屏蔽词不出、关闭不再打分、红线不写收藏文件');
console.log('favorite-suggest：通过');
