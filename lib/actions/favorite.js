/**
 * 收藏的动作层 —— 命令与 HTTP 共用，不含 UI。
 *
 * 与旧 pin 的区别：pin 是「压缩时截断范围」，收藏**不改变压缩选段**，
 * 只在压缩摘要里留一段目录 + 让用户随时按序号取回原文。
 */
import { actionError } from '../core/errors.js';
import { roleLabelOf } from '../core/pin-anchors.js';
import { FAVORITE_MAX, buildFavoriteDirectoryLines, buildFavoriteTitle, suggestFavorites } from '../core/favorites.js';
import { appendFavoriteRecord, favoriteMapOf, favoritesFileOf, readFavoritesFile, snapshotFileOf, snapshotTextFor } from '../dsh/favorites-file.js';
import { sessionLog, surfaceSeqs } from '../dsh/session-view.js';

/** 粗略 token 估算（字符数 / 2）——只用于「先报体积」，不参与预算决策。 */
export function estimateTextTokens(text) {
  const length = typeof text === 'string' ? text.length : 0;
  return Math.max(1, Math.round(length / 2));
}

function blockTextOf(block) {
  return block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : '';
}

/**
 * 从事件里抠完整原文（content 可能是字符串或 block 数组）。
 * @param {object|undefined} event
 * @returns {string}
 */
export function eventTextOf(event) {
  const data = event !== null && typeof event === 'object' ? event.data : undefined;
  const candidates = [data?.content, data?.message?.content];
  for (const content of candidates) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content.map(blockTextOf).filter((part) => part.length > 0).join('\n');
      if (text.length > 0) return text;
    }
  }
  return '';
}

/**
 * messageId → seq：扫会话日志匹配宿主消息 id。
 * 助手消息的 id 在 `data.message.id`，用户消息在 `data.id`（2026-10-28 真机核实）。
 * @param {object} session
 * @param {string} messageId
 * @returns {number|null}
 */
export function seqOfMessageId(session, messageId) {
  if (typeof messageId !== 'string' || messageId.length === 0) return null;
  const log = sessionLog(session);
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index];
    const data = event?.data;
    if (data === null || typeof data !== 'object') continue;
    if (event.type === 'assistant/message' && data.message?.id === messageId) return event.seq;
    if (event.type === 'user/message' && data.id === messageId) return event.seq;
  }
  return null;
}

function sessionOf(agent) {
  const session = agent?.session;
  if (session === null || session === undefined) throw actionError('favorite', '当前没有打开的会话');
  return session;
}

function writeFavorite(deps, session, op, seq) {
  const record = {
    schema: 'dcr-favorite/v1',
    op,
    sessionId: session.id,
    seq,
    at: Date.now(),
  };
  return appendFavoriteRecord(record, favoritesFileOf(deps.ctx, session)).ok;
}

function liveFavoriteSeqs(deps, session) {
  const map = favoriteMapOf(deps.ctx, session);
  const set = map.get(session.id);
  return set === undefined ? [] : [...set].sort((a, b) => a - b);
}

/** 收藏 / 取消收藏一条消息（按宿主 messageId，UI 按钮走这里）。 */
export function toggleFavorite(deps, { agent, messageId } = {}) {
  const session = sessionOf(agent);
  const seq = seqOfMessageId(session, messageId);
  if (seq === null) throw actionError('favorite', '找不到这条消息（会话可能被压缩过），换一条试试');
  const set = new Set(liveFavoriteSeqs(deps, session));
  if (set.has(seq)) {
    writeFavorite(deps, session, 'remove', seq);
    set.delete(seq);
    return { active: false, seq, count: set.size, message: '已取消收藏' };
  }
  if (set.size >= FAVORITE_MAX) throw actionError('favorite', `这条工作的收藏已达上限 ${FAVORITE_MAX} 条，先取消一些`);
  writeFavorite(deps, session, 'add', seq);
  set.add(seq);
  return { active: true, seq, count: set.size, message: '已收藏' };
}

/** 收藏「我刚发的最后一条」。 */
export function favoriteLast(deps, { agent } = {}) {
  const session = sessionOf(agent);
  const seqs = surfaceSeqs(session);
  let seq = null;
  for (let index = seqs.length - 1; index >= 0; index -= 1) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seqs[index]) : undefined;
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      seq = seqs[index];
      break;
    }
  }
  if (seq === null) throw actionError('favorite', '没有找到你发的消息');
  const set = new Set(liveFavoriteSeqs(deps, session));
  if (set.has(seq)) {
    writeFavorite(deps, session, 'remove', seq);
    return { active: false, seq, count: set.size, message: '已取消收藏（这条本来已收藏）' };
  }
  if (set.size >= FAVORITE_MAX) throw actionError('favorite', `这条工作的收藏已达上限 ${FAVORITE_MAX} 条`);
  writeFavorite(deps, session, 'add', seq);
  set.add(seq);
  return { active: true, seq, count: set.size, message: '已收藏你刚发的这条' };
}

/** 当前会话收藏的条目（编号从 1 开始，按 seq 升序）。 */
export function favoriteEntries(deps, session) {
  return liveFavoriteSeqs(deps, session).map((seq, index) => {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    const live = event !== undefined && event !== null;
    const snapshot = live ? null : snapshotTextFor(snapshotFileOf(deps.ctx, session), seq);
    const status = live ? 'live' : snapshot !== null ? 'snapshot' : 'lost';
    return {
      index: index + 1,
      seq,
      role: live ? roleLabelOf(event?.type) : '原消息',
      title: live ? buildFavoriteTitle(event) : snapshot !== null ? snapshot.replace(/\s+/gu, ' ').slice(0, 60) : '（原文已不可达）',
      tokens: estimateTextTokens(live ? eventTextOf(event) : snapshot ?? ''),
      status,
    };
  });
}

/** 列表（目录）。 */
export function listFavorites(deps, { agent } = {}) {
  const session = sessionOf(agent);
  const entries = favoriteEntries(deps, session);
  const lines = buildFavoriteDirectoryLines(entries, 20);
  const lost = entries.filter((entry) => entry.status !== 'live').length;
  const lostNote =
    lost === 0
      ? ''
      : `\n其中 ${lost} 条原件日志已不在：${entries
          .filter((entry) => entry.status !== 'live')
          .map((entry) => `${entry.index}${entry.status === 'snapshot' ? '（可用快照读）' : '（快照也没有）'}`)
          .join('、')}`;
  return {
    entries,
    count: entries.length,
    message:
      entries.length === 0
        ? '当前会话还没有收藏。点消息下面的星，或输入 /favorite last 收藏你刚发的这条。'
        : `当前会话收藏 ${entries.length} 条：\n${lines.join('\n')}${lostNote}\n\n读原文：/favorite <序号>（先报体积）｜取消：/favorite rm <序号>`,
  };
}

function entryOf(deps, session, index) {
  const wanted = Number(index);
  if (!Number.isInteger(wanted) || wanted < 1) throw actionError('favorite', '序号须为正整数，例如 /favorite 2');
  const entries = favoriteEntries(deps, session);
  const entry = entries.find((item) => item.index === wanted);
  if (entry === undefined) {
    throw actionError('favorite', `没有第 ${wanted} 条（当前共 ${entries.length} 条，用 /favorite list 查看）`);
  }
  return entry;
}

/** 读原文（先报体积，不输出正文）。 */
export function readFavoriteInfo(deps, { agent, index } = {}) {
  const session = sessionOf(agent);
  const entry = entryOf(deps, session, index);
  return {
    entry,
    message: `第 ${entry.index} 条（${entry.role}）：${entry.title}\n原文约 ${entry.tokens} token。要读的话输入：/favorite ${entry.index} read`,
  };
}

/** 读原文正文（用户已经看过体积并确认）。 */
export function readFavoriteFull(deps, { agent, index } = {}) {
  const session = sessionOf(agent);
  const entry = entryOf(deps, session, index);
  const event = typeof session.eventAt === 'function' ? session.eventAt(entry.seq) : undefined;
  let text = eventTextOf(event);
  let source = 'log';
  if (text.length === 0) {
    const snapshot = snapshotTextFor(snapshotFileOf(deps.ctx, session), entry.seq);
    if (snapshot !== null) {
      text = snapshot;
      source = 'snapshot';
    }
  }
  if (text.length === 0) {
    throw actionError('favorite', '这条收藏的原文已不可达（日志与压缩快照里都没有；可能日志被清理且从未经过压缩）');
  }
  const note = source === 'snapshot' ? '（来自压缩快照：原件日志已不在）' : '';
  return {
    entry,
    text,
    source,
    message: `第 ${entry.index} 条原文${note}（约 ${entry.tokens} token）：\n\n${text}`,
  };
}

/** 取消收藏（按序号）。 */
export function unfavoriteByIndex(deps, { agent, index } = {}) {
  const session = sessionOf(agent);
  const entry = entryOf(deps, session, index);
  writeFavorite(deps, session, 'remove', entry.seq);
  return { seq: entry.seq, message: `已取消收藏第 ${entry.index} 条：${entry.title}` };
}

/**
 * 推荐收藏（半自动）—— 命令 `/favorite suggest` 的出口。
 * 现在 core/suggestFavorites 是接口占位（返回空）；接入后这里不用改。
 */
export function listFavoriteSuggestions(deps, { agent } = {}) {
  const session = sessionOf(agent);
  const seqs = surfaceSeqs(session);
  const events = [];
  for (const seq of seqs) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (event !== undefined && event !== null) events.push({ seq, type: event.type, event });
  }
  const suggestions = suggestFavorites(events, { limit: 3 });
  return {
    suggestions,
    message:
      suggestions.length === 0
        ? '推荐收藏还没接入（接口已留好：core/favorites.js 的 suggestFavorites）。目前需要手动点星或 /favorite last。'
        : `建议收藏这 ${suggestions.length} 条：\n${suggestions
            .map((item) => `- 第 ${item.seq} 条（${item.role}）：${item.title} — ${item.reason}`)
            .join('\n')}\n\n确认收藏：/favorite last 或点消息下面的星`,
  };
}
