/**
 * 推荐收藏 · 事件钩子（0.5.3 P1-6）。
 *
 * 职责：监听 `session/event`，在**每轮最后一条助手回复**落地约 1.2s 后异步打分，
 * 保存「建议点亮」投影（≤3 条 / 会话），由 readState 下发、客户端星标高亮。
 *
 * 三个约束（定稿）：
 *   1. **只判最后一条**：助手消息可能分步到达（工具调用中间态），用去抖把同一轮的
 *      多次 assistant/message 收成一次，只对最后一条打分；
 *   2. **每回合最多一次**：同一会话同时只有一个打分在跑；
 *   3. **红线：绝不收藏**。这里只写内存建议，不碰 `dcr-favorites` 文件。
 *
 * 失败静默降级（不亮），不重试、不阻塞事件处理。
 */
import { decideFavoriteSuggest, FAVORITE_SCORE_MIN_CHARS } from '../core/favorite-score.js';
import { favoriteSeqsOf } from '../core/favorites.js';
import { favoriteMapOf } from './favorites-file.js';
import { scoreFavoriteMessage } from './favorite-scorer.js';

/** 同一轮内多条助手消息的合并窗口：在这之后还没新消息才算「这一轮的最后一条」。 */
const WATCH_DEBOUNCE_MS = 1_200;

/** 每个会话最多保留几条建议（readState 帧预算）。 */
export const FAVORITE_SUGGEST_MAX = 3;

/**
 * 从一个事件里抠助手消息纯文本。
 * @param {object|undefined} event
 * @returns {string}
 */
export function assistantTextOf(event) {
  const data = event !== null && typeof event === 'object' ? event.data : undefined;
  const message = data?.message;
  const content = message?.content ?? data?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * @param {{ctx:object, engine:object, cfg:object, log?:object}} deps
 */
export function createFavoriteWatcher(deps) {
  /** @type {Map<string, ReturnType<typeof setTimeout>>} sessionId → 去抖定时器 */
  const timers = new Map();
  /** @type {Set<string>} 正在打分的会话（每回合最多一次） */
  const inflight = new Set();
  /** @type {Map<string, object[]>} sessionId → 建议列表（新的在前） */
  const suggestions = new Map();
  /** @type {{refreshAll:Function}|null} */
  let hub = null;

  const favoriteConfig = () => {
    const cfg = deps.cfg?.favorite;
    return cfg !== null && typeof cfg === 'object' ? cfg : {};
  };

  /** 当前会话已收藏的 seq 集合（判断「已收藏的不再推荐」）。 */
  const favoritedSeqsOf = (session) => {
    try {
      return favoriteSeqsOf(favoriteMapOf(deps.ctx, session), session.id);
    } catch {
      return [];
    }
  };

  const pushSuggestion = (sessionId, item) => {
    const list = suggestions.get(sessionId) ?? [];
    const next = [item, ...list.filter((entry) => entry.seq !== item.seq)];
    suggestions.set(sessionId, next.slice(0, FAVORITE_SUGGEST_MAX));
    hub?.refreshAll?.();
  };

  const scoreLater = (session, event) => {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const existing = timers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      void runScore(session, event);
    }, WATCH_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    timers.set(sessionId, timer);
  };

  const runScore = async (session, event) => {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (inflight.has(sessionId)) return;
    const cfg = favoriteConfig();
    if (cfg.enabled === false) return;

    const text = assistantTextOf(event);
    if ([...text.trim()].length < FAVORITE_SCORE_MIN_CHARS) return;
    const seq = Number.isFinite(event?.seq) ? event.seq : null;
    const messageId = typeof event?.data?.message?.id === 'string' ? event.data.message.id : null;
    if (seq === null || messageId === null) return;
    if (favoritedSeqsOf(session).includes(seq)) return; // 已收藏：不再推荐

    const level = cfg.level;
    const mustWords = cfg.mustWords;
    const muteWords = cfg.muteWords;

    // 先做不花钱的判定：太短/屏蔽词/必亮词都不需要模型。
    const cheap = decideFavoriteSuggest({ text, score: null, level, mustWords, muteWords });
    if (cheap.reason === 'mute-word' || cheap.reason === 'too-short') return;
    if (cheap.reason === 'must-word') {
      pushSuggestion(sessionId, {
        seq,
        messageId,
        score: null,
        reason: 'must-word',
        matched: cheap.matched,
        at: Date.now(),
      });
      return;
    }

    inflight.add(sessionId);
    try {
      const scored = await scoreFavoriteMessage(deps, { agent: { id: sessionId, session }, text });
      if (scored === null) return; // 模型失败：不亮（fail closed）
      const decision = decideFavoriteSuggest({
        text,
        score: scored.score,
        level,
        mustWords,
        muteWords,
      });
      if (decision.suggest !== true) return;
      pushSuggestion(sessionId, {
        seq,
        messageId,
        score: decision.score,
        reason: decision.reason,
        matched: decision.matched,
        at: Date.now(),
      });
    } finally {
      inflight.delete(sessionId);
    }
  };

  /**
   * 会话事件入口。只关心助手消息；其它事件直接返回。
   * @param {object} session
   * @param {object} event
   */
  const onEvent = (session, event) => {
    if (event === null || typeof event !== 'object') return;
    if (event.type !== 'assistant/message') return;
    scoreLater(session, event);
  };

  /**
   * readState 用的建议投影（只下发 seq/messageId/分数/原因，守帧预算）。
   * @param {string|null|undefined} sessionId
   * @returns {{seq:number, messageId:string, score:number|null, reason:string, matched:string|null}[]}
   */
  const suggestionOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return [];
    const list = suggestions.get(sessionId) ?? [];
    return list.map((item) => ({
      seq: item.seq,
      messageId: item.messageId,
      score: item.score,
      reason: item.reason,
      matched: item.matched,
    }));
  };

  const setHub = (nextHub) => {
    hub = nextHub ?? null;
  };

  const clear = (sessionId) => {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      suggestions.delete(sessionId);
      return;
    }
    suggestions.clear();
  };

  const close = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    inflight.clear();
    suggestions.clear();
  };

  return { onEvent, suggestionOf, setHub, clear, close };
}

export default createFavoriteWatcher;
