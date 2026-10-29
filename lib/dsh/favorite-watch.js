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
 * 0.5.4 D3 补第 4 条：**压缩后作废旧建议**——收到 compaction/summary|end 就清空本会话
 * 建议、取消待跑打分、作废在跑结果，避免被压走的 seq 残留在 /favorite suggest 与星标上。
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
  /**
   * @type {Map<string, number>} sessionId → 世代号（0.5.4 D3）。
   * 压缩会替换本会话历史：清空建议的同时 +1，正在跑的打分回来发现世代变了就直接丢弃，
   * 避免被压走的 seq 又被写回建议里（真机残留过 seq 2737）。
   */
  const generations = new Map();
  /** @type {{refreshAll:Function}|null} */
  let hub = null;

  const favoriteConfig = () => {
    const cfg = deps.cfg?.favorite;
    return cfg !== null && typeof cfg === 'object' ? cfg : {};
  };

  /** 当前世代号（没有记录 = 0）。 */
  const generationOf = (sessionId) => generations.get(sessionId) ?? 0;

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

  /**
   * 0.5.4 D3：本会话发生过压缩（历史被替换）→ 作废建议投影，避免被压走的 seq 残留。
   *
   * 三件事一起做：
   *   1. 清掉该会话已有建议（readState 投影立即为空，星标不再亮在已压走的消息上）；
   *   2. 取消待跑的去抖定时器（否则压缩后 1.2s 内还会给旧消息打分）；
   *   3. 世代号 +1（正在跑的打分回来也会被丢弃，见 runScore）。
   * 之后的回合照常：每回合最多一次/去抖/只判最后一条均不变。
   */
  const dropStaleSuggestions = (session) => {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const timer = timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(sessionId);
    }
    generations.set(sessionId, generationOf(sessionId) + 1);
    if (suggestions.delete(sessionId)) hub?.refreshAll?.();
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
    // 0.5.4 D3：记下打分开始时的世代号；期间发生压缩（历史被替换）就丢弃这次结果。
    const generationAtStart = generationOf(sessionId);
    try {
      const scored = await scoreFavoriteMessage(deps, { agent: { id: sessionId, session }, text });
      if (scored === null) return; // 模型失败：不亮（fail closed）
      if (generationOf(sessionId) !== generationAtStart) return; // 期间压缩过：旧 seq 不再建议
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

  /** 0.5.4 D3：压缩事务的事件（summary 先到、end 收尾；native 压缩同样会发）。 */
  const COMPACTION_EVENT_TYPES = new Set(['compaction/summary', 'compaction/end']);

  /**
   * 会话事件入口。只关心助手消息（打分）与压缩事件（清建议）；其它事件直接返回。
   * @param {object} session
   * @param {object} event
   */
  const onEvent = (session, event) => {
    if (event === null || typeof event !== 'object') return;
    if (COMPACTION_EVENT_TYPES.has(event.type)) {
      dropStaleSuggestions(session);
      return;
    }
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
    generations.clear();
  };

  return { onEvent, suggestionOf, setHub, clear, close };
}

export default createFavoriteWatcher;
