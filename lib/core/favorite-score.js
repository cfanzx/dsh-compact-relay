/**
 * 推荐收藏 · 打分与判定（纯函数层）—— 2026-10-28 定稿。
 *
 * 位置：`AI 回复落地 → 异步问模型「这条值不值得收藏原文」→ 判定 → 客户端星标高亮`。
 * 这里只做**不碰 IO 的那一半**：提示词、解析、档位阈值、筛选词过滤、最终判定。
 * 模型调用在 `dsh/favorite-scorer.js`，事件钩子在 `dsh/favorite-watch.js`。
 *
 * 红线（定稿 §6）：推荐只决定「亮不亮」，绝不自动写收藏；真正的收藏仍由用户点星触发。
 *
 * 档位（实测数据见 `dcr-收藏-推荐收藏-验证-2026-10-28.md`）：
 *   宽松 ≥60：每 3 条回复亮 1 次，准确率 71%
 *   标准 ≥75：每 4 条亮 1 次，准确率 76%（默认）
 *   严格 ≥85：每 7 条亮 1 次，准确率 89%
 *
 * 筛选词（定稿 §3）：
 *   必亮词：出现就亮（跳过分数）；屏蔽词：出现就绝不亮；优先级 屏蔽 > 必亮 > 分数。
 *   只做大小写无关的**子串包含**，不引正则——用户写不坏、可试算、可预期。
 *
 * 判定顺序：屏蔽词 → 必亮词 → 档位阈值。模型失败（score===null）→ 不亮（fail closed）。
 */

/** 三档阈值（分数 0-100）。 */
export const FAVORITE_SCORE_LEVELS = Object.freeze({ loose: 60, standard: 75, strict: 85 });

/** 默认档位（2026-10-28 小潇拍板）。 */
export const FAVORITE_SCORE_DEFAULT_LEVEL = 'standard';

/** 合法档位名。 */
const LEVELS = Object.freeze(['loose', 'standard', 'strict']);

/** 必亮词 / 屏蔽词各自上限。 */
export const FAVORITE_WORDS_MAX = 20;

/** 单个词最长字符数。 */
export const FAVORITE_WORD_MAX_CHARS = 12;

/** 单条消息送给模型的最大字符数（超长截断，末尾加省略号）。 */
export const FAVORITE_SCORE_INPUT_MAX_CHARS = 3500;

/** 短于这个长度的消息不参与推荐（没有可收藏的原文价值）。 */
export const FAVORITE_SCORE_MIN_CHARS = 12;

/** 解析失败/模型不可用时的占位分数（null 表示「不知道」，判定为不亮）。 */
export const FAVORITE_SCORE_UNKNOWN = null;

/**
 * 档位 → 阈值；非法档位回落默认档。
 * @param {string} [level]
 * @returns {number}
 */
export function favoriteScoreThresholdOf(level) {
  if (typeof level === 'string' && Object.hasOwn(FAVORITE_SCORE_LEVELS, level)) {
    return FAVORITE_SCORE_LEVELS[level];
  }
  return FAVORITE_SCORE_LEVELS[FAVORITE_SCORE_DEFAULT_LEVEL];
}

/**
 * 规范化档位名；非法值回落默认档。
 * @param {unknown} level
 * @returns {'loose'|'standard'|'strict'}
 */
export function normalizeFavoriteLevel(level) {
  return typeof level === 'string' && LEVELS.includes(level) ? level : FAVORITE_SCORE_DEFAULT_LEVEL;
}

/**
 * 规范化一组筛选词：去空白、去重（按小写比较）、截长、限量。
 * 空串/非字符串一律丢弃；词内空白保留原样（用户可能写「测试 全绿」）。
 * @param {unknown} words
 * @returns {string[]}
 */
export function normalizeFavoriteWords(words) {
  if (!Array.isArray(words)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of words) {
    if (typeof raw !== 'string') continue;
    const word = raw.trim();
    if (word.length === 0) continue;
    const clipped = [...word].slice(0, FAVORITE_WORD_MAX_CHARS).join('');
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= FAVORITE_WORDS_MAX) break;
  }
  return out;
}

/**
 * 在文本里找第一个命中的词（大小写无关的子串匹配）。
 * @param {string} text
 * @param {string[]} words 规范化后的词表
 * @returns {string|null} 命中的词；没命中返回 null
 */
export function matchFavoriteWord(text, words) {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (!Array.isArray(words) || words.length === 0) return null;
  const haystack = text.toLowerCase();
  for (const word of words) {
    if (typeof word !== 'string' || word.length === 0) continue;
    if (haystack.includes(word.toLowerCase())) return word;
  }
  return null;
}

/**
 * 送模型的系统提示词（与验证脚本 v3 逐字一致，唯一差别是要求 0-100 分）。
 * 改这里等于改口径——`test/favorite-suggest.mjs` 锁了几个关键句，别顺手删。
 * @returns {string}
 */
export function buildFavoriteScoreSystemPrompt() {
  return (
    '你帮用户判断：AI 的一条回复，值不值得『收藏原文』（以后可能想回看这条的原话）。\n\n' +
    '判断标准（三类算）：\n' +
    '- 结论：能/不能、可行/不可行、该做/不该做、问题在哪、定案；\n' +
    '- 判断：方案取舍与理由、原因分析、优先级、对错判断、建议；\n' +
    '- 纠偏：承认之前判断错了、指出根因、给出改进方向或下次注意。\n\n' +
    '不算：主体是报进度（做完了/改完了/测试全绿/真机验证通过/发版了）、列清单（改了哪些文件/有哪些发现）、操作步骤、提问、寒暄、确认收到。\n\n' +
    '给这条消息打一个 0-100 的分：\n' +
    '90-100：就是一条关键结论/判断/纠偏，用户以后大概率想回看原话；\n' +
    '70-89：有明确判断，但也掺了流水账，可收可不收；\n' +
    '40-69：有点结论的味道，但主体不是判断；\n' +
    '0-39：进度汇报/清单/步骤/寒暄，不该收。\n' +
    '只回 JSON：{"score":0到100的整数,"reason":"不超过15字"}'
  );
}

/**
 * 裁到送模型的最大长度（按字符，不切坏 emoji）。
 * @param {string} text
 * @returns {string}
 */
export function clipForScore(text) {
  if (typeof text !== 'string') return '';
  const chars = [...text];
  if (chars.length <= FAVORITE_SCORE_INPUT_MAX_CHARS) return text;
  return `${chars.slice(0, FAVORITE_SCORE_INPUT_MAX_CHARS).join('')}…`;
}

/**
 * 送模型的用户消息文本。
 * @param {string} text
 * @returns {string}
 */
export function buildFavoriteScoreUserText(text) {
  return `消息原文：\n${clipForScore(text)}`;
}

/**
 * 解析模型输出：剥 ```json 围栏、取第一个 JSON 对象、clamp 到 0-100。
 * 解析不出来返回 null（调用方按「不亮」处理，不抛错）。
 * @param {unknown} content
 * @returns {{score:number, reason:string}|null}
 */
export function parseFavoriteScore(content) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/u, '').replace(/```\s*$/u, '');
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const rawScore = parsed.score;
  const score = typeof rawScore === 'number' ? rawScore : Number.NaN;
  if (!Number.isFinite(score)) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 40) : '';
  return { score: clamped, reason };
}

/**
 * 最终判定：这条 AI 回复要不要点亮收藏星标。
 *
 * @param {{ text?:string, score?:number|null, level?:string, mustWords?:unknown, muteWords?:unknown }} input
 * @returns {{ suggest:boolean, score:number|null, reason:'mute-word'|'must-word'|'threshold'|'too-short'|'unknown-score', matched:string|null }}
 */
export function decideFavoriteSuggest({ text, score, level, mustWords, muteWords } = {}) {
  const body = typeof text === 'string' ? text : '';
  const words = {
    must: normalizeFavoriteWords(mustWords),
    mute: normalizeFavoriteWords(muteWords),
  };
  const unknown = { suggest: false, score: FAVORITE_SCORE_UNKNOWN, matched: null };

  if ([...body.trim()].length < FAVORITE_SCORE_MIN_CHARS) {
    return { ...unknown, reason: 'too-short' };
  }

  // 屏蔽词优先：命中就绝不亮（即使模型给高分）。
  const muted = matchFavoriteWord(body, words.mute);
  if (muted !== null) return { ...unknown, matched: muted, reason: 'mute-word' };

  // 必亮词：出现就亮，跳过模型分数（模型失败也亮）。
  const must = matchFavoriteWord(body, words.must);
  if (must !== null) {
    const knownScore = typeof score === 'number' && Number.isFinite(score) ? Math.round(score) : null;
    return { suggest: true, score: knownScore, matched: must, reason: 'must-word' };
  }

  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return { ...unknown, reason: 'unknown-score' };
  }
  const threshold = favoriteScoreThresholdOf(level);
  return {
    suggest: score >= threshold,
    score: Math.round(score),
    matched: null,
    reason: 'threshold',
  };
}
