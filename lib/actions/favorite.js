/**
 * 收藏的动作层 —— 命令与 HTTP 共用，不含 UI。
 *
 * 与旧 pin 的区别：pin 是「压缩时截断范围」，收藏**不改变压缩选段**，
 * 只在压缩摘要里留一段目录 + 让用户随时按序号取回原文。
 */
import { actionError } from '../core/errors.js';
import { roleLabelOf } from '../core/pin-anchors.js';
import { FAVORITE_MAX, buildFavoriteDirectoryLines, buildFavoriteTitle, suggestFavorites } from '../core/favorites.js';
import { appendFavoriteRecord, appendSnapshotEntries, favoriteMapForRoot, favoritesFileForRoot, favoriteMapOf, favoritesFileOf, rootSessionIdOfId, snapshotFileOf, snapshotTextFor } from '../dsh/favorites-file.js';
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

/**
 * messageId 落在哪个**活会话**里（收藏兜底用）。
 *
 * 客户端可能没带 sessionId、或带的是切换前的旧会话：messageId 是宿主生成的 UUID，
 * 扫一遍活 agent 的会话日志即可反查。命中 0 个或多个都返回 null——宁可报错，也不收错会话。
 * @param {{ctx:object}} deps
 * @param {string} messageId
 * @returns {object|null}
 */
export function ownerAgentOfMessage(deps, messageId) {
  const agents = deps?.ctx?.agents;
  if (agents === null || agents === undefined || typeof agents.list !== 'function') return null;
  if (typeof messageId !== 'string' || messageId.length === 0) return null;
  let all = [];
  try {
    all = agents.list();
  } catch {
    return null;
  }
  if (!Array.isArray(all)) return null;
  const hits = [];
  for (const candidate of all) {
    const session = candidate?.session;
    if (session === null || session === undefined) continue;
    if (seqOfMessageId(session, messageId) !== null) hits.push(candidate);
  }
  return hits.length === 1 ? hits[0] : null;
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
  if (typeof messageId !== 'string' || messageId.length === 0) throw actionError('favorite', '缺少 messageId');
  // 传进来的 agent 不一定对（多会话时客户端可能带错 sessionId）：先认它，认不出再按 messageId 反查。
  const owner = (() => {
    const passed = agent?.session;
    if (passed !== null && passed !== undefined && seqOfMessageId(passed, messageId) !== null) return agent;
    return ownerAgentOfMessage(deps, messageId);
  })();
  if (owner === null) {
    throw actionError('favorite', '找不到这条消息所属的会话（会话可能已关闭，或这条已被压缩）');
  }
  const session = sessionOf(owner);
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

/**
 * 按「会话 id + seq」收藏/取消（**不要求活会话**）——归档/关闭的会话也能标。
 *
 * 这是「标记」与「压缩落档」解耦的第一步：标记只写一行 JSONL，不读会话日志、不碰压缩。
 * 链根解析走 `ctx.get('workspaceRegistry').readSessionHeader`（对已存会话同样可读）；
 * 解析不到就把 sessionId 当根（不猜更多）。写失败明确报错，不假装成功。
 *
 * @param {{ctx:object}} deps
 * @param {{sessionId:string, seq:number, active?:boolean}} input
 *   active 省略 = 切换；true = 只加；false = 只删。已是目标状态时幂等返回（不重复写）。
 * @returns {Promise<{active:boolean, seq:number, count:number, sessionId:string, note?:string, message:string}>}
 */
export async function markFavoriteBySeq(deps, { sessionId, seq, active } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw actionError('favorite', '缺少 sessionId');
  if (!Number.isInteger(seq) || seq < 0) throw actionError('favorite', '缺少或非法的消息序号 seq（应为非负整数）');
  const rootId = (await rootSessionIdOfId(deps.ctx, sessionId)) ?? sessionId;
  const file = favoritesFileForRoot(rootId);
  const map = favoriteMapForRoot(rootId);
  const set = new Set(map.get(sessionId) ?? []);
  const already = set.has(seq);
  // active 省略 = 切换；true/false = 只加/只删，已是目标状态就幂等返回（不重复写盘）。
  let add;
  if (active === undefined) {
    add = !already;
  } else if (active === true) {
    if (already) return { active: true, seq, count: set.size, sessionId, note: 'already', message: `第 ${seq} 条已经收藏过了` };
    add = true;
  } else {
    if (!already) return { active: false, seq, count: set.size, sessionId, note: 'already', message: `第 ${seq} 条本来就没收藏` };
    add = false;
  }
  if (add && set.size >= FAVORITE_MAX) throw actionError('favorite', `这条工作的收藏已达上限 ${FAVORITE_MAX} 条，先取消一些`);
  const record = { schema: 'dcr-favorite/v1', op: add ? 'add' : 'remove', sessionId, seq, at: Date.now() };
  const written = appendFavoriteRecord(record, file);
  if (written.ok !== true) throw actionError('favorite', '收藏文件写不进去（检查 ~/.dsh 的权限）');
  if (add) set.add(seq);
  else set.delete(seq);
  return {
    active: add,
    seq,
    count: set.size,
    sessionId,
    message: add ? `已收藏第 ${seq} 条` : `已取消收藏第 ${seq} 条`,
  };
}

/** 日志里最后一条助手消息的 seq（命令 /favorite mark 不带参数时用）。 */
function lastAssistantSeqOf(session) {
  const log = sessionLog(session);
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index];
    if (event !== null && typeof event === 'object' && event.type === 'assistant/message') return event.seq;
  }
  return null;
}

/**
 * 命令 `/favorite mark [seq]`：按 seq 收藏（不传 seq = 最后一条已完成的助手回复）。
 * 与星标共用同一个 JSONL；绝不因为「消息被压走」就静默失败——那条不在日志里会明确报错。
 */
export function markFavoriteInSession(deps, { agent, seq } = {}) {
  const session = sessionOf(agent);
  const target = seq === undefined ? lastAssistantSeqOf(session) : seq;
  if (target === null) throw actionError('favorite', '这个会话里还没有助手回复可收藏');
  if (!Number.isInteger(target) || target < 0) throw actionError('favorite', '序号须为非负整数，例如 /favorite mark 1234');
  const event = typeof session.eventAt === 'function' ? session.eventAt(target) : undefined;
  if (event === undefined || event === null) {
    throw actionError('favorite', `没有 seq ${target} 这条消息（可能已被压缩或清理）；要标别的先看 /favorite list 或压缩摘要里的序号`);
  }
  const set = new Set(liveFavoriteSeqs(deps, session));
  if (set.has(target)) {
    const snapshot = snapshotIfCompacted(deps, session, target, event);
    return {
      active: true,
      seq: target,
      count: set.size,
      note: 'already',
      snapshot,
      message: snapshot === 'written' ? `第 ${target} 条已经收藏过了（原文已补写进快照）` : `第 ${target} 条已经收藏过了`,
    };
  }
  if (set.size >= FAVORITE_MAX) throw actionError('favorite', `这条工作的收藏已达上限 ${FAVORITE_MAX} 条，先取消一些`);
  if (writeFavorite(deps, session, 'add', target) !== true) throw actionError('favorite', '收藏文件写不进去（检查 ~/.dsh 的权限）');
  set.add(target);
  const snapshot = snapshotIfCompacted(deps, session, target, event);
  return {
    active: true,
    seq: target,
    count: set.size,
    snapshot,
    message: `已收藏第 ${target} 条${snapshot === 'written' ? '（这条已被压走，原文已写进快照）' : ''}`,
  };
}

/**
 * P0-3 兜底：给「已经被压走、但原文还在日志里」的收藏**当场写快照**。
 *
 * 压缩摘要里的「收藏（本段）」是压缩那一刻的快照，之后补标不会回写摘要；
 * 不写快照就会出现「标记在、原文读不到」。这里只兜日志可读的情形
 * （读不到就保持无快照，由 read 侧明确报错；完整档案读取是 0.6）。
 * @returns {'written'|'present'|'none'}
 */
function snapshotIfCompacted(deps, session, seq, event) {
  if (event === undefined || event === null) return 'none';
  const surface = new Set(surfaceSeqs(session));
  if (surface.has(seq)) return 'none'; // 还在界面上：走正常星标路径，不需要兜底
  const file = snapshotFileOf(deps.ctx, session);
  if (snapshotTextFor(file, seq) !== null) return 'present';
  const text = eventTextOf(event);
  if (text.length === 0) return 'none';
  const written = appendSnapshotEntries(file, [
    { seq, role: roleLabelOf(event.type), title: buildFavoriteTitle(event), text, at: Date.now() },
  ]);
  return written.ok === true && written.written === 1 ? 'written' : 'none';
}

/** 收藏「我刚发的最后一条」。 */export function favoriteLast(deps, { agent } = {}) {
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
