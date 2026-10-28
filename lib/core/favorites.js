/**
 * 收藏（favorite）—— 纯数据层：记录校验、集合计算、标题截取、摘要目录生成。
 *
 * 零 IO、零依赖（只复用 pin-anchors 的消息摘要），可裸跑单测。
 * 记录存储走 dsh/favorites-file.js 的「一项工作一个文件」JSONL：追加式 add/remove，不写快照。
 */

import { messageSnippetOf } from './pin-anchors.js';

/** 单条记录 schema 版本。 */
export const FAVORITE_SCHEMA = 'dcr-favorite/v1';

/** 单项目收藏上限（定稿：够用）。 */
export const FAVORITE_MAX = 500;

/** 摘要目录最多列几条（超了截断，不让摘要膨胀）。 */
export const DIRECTORY_MAX = 20;

const isSeq = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 读侧容错：形状不对 → null（调用方跳过该行，永不抛）。
 * @param {unknown} raw
 * @returns {{schema:string,op:'add'|'remove',sessionId:string,seq:number,at:number|null}|null}
 */
export function normalizeFavoriteRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.schema !== FAVORITE_SCHEMA) return null;
  if (raw.op !== 'add' && raw.op !== 'remove') return null;
  if (!isSeq(raw.seq)) return null;
  const sessionId = nonEmpty(raw.sessionId);
  if (sessionId === null) return null;
  return {
    schema: FAVORITE_SCHEMA,
    op: raw.op,
    sessionId,
    seq: raw.seq,
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : null,
  };
}

/**
 * JSONL 文本 → 记录数组（坏行跳过）。
 * @param {string} text
 * @returns {object[]}
 */
export function parseFavoriteLines(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // 半截写/手改 → 跳过
    }
    const record = normalizeFavoriteRecord(parsed);
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * 记录数组 → Map<sessionId, Set<seq>>（按时间顺序应用 add/remove）。
 * @param {object[]} records
 * @returns {Map<string, Set<number>>}
 */
export function applyFavoriteOps(records) {
  const map = new Map();
  if (!Array.isArray(records)) return map;
  for (const record of records) {
    const op = normalizeFavoriteRecord(record);
    if (op === null) continue;
    let set = map.get(op.sessionId);
    if (set === undefined) {
      set = new Set();
      map.set(op.sessionId, set);
    }
    if (op.op === 'add') set.add(op.seq);
    else set.delete(op.seq);
  }
  for (const [sessionId, set] of [...map]) {
    if (set.size === 0) map.delete(sessionId);
  }
  return map;
}

/** 全部会话的收藏总数。 */
export function countFavorites(map) {
  let total = 0;
  for (const set of map.values()) total += set.size;
  return total;
}

/** 某会话的收藏 seq（升序数组）。 */
export function favoriteSeqsOf(map, sessionId) {
  const set = map instanceof Map && typeof sessionId === 'string' ? map.get(sessionId) : undefined;
  return set === undefined ? [] : [...set].sort((a, b) => a - b);
}

/**
 * 标题截取：40–60 字，不调模型。
 * @param {object|undefined} event 消息事件
 * @param {number} [max]
 * @returns {string}
 */
export function buildFavoriteTitle(event, max = 60) {
  const snippet = messageSnippetOf(event) || '';
  const text = snippet.replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return '（无文本）';
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/**
 * 目录行（摘要与 /favorite list 共用）。
 * @param {{index:number, role:string, title:string}[]} entries
 * @param {number} [max]
 * @returns {string[]}
 */
export function buildFavoriteDirectoryLines(entries, max = DIRECTORY_MAX) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry !== null && typeof entry === 'object') : [];
  const shown = list.slice(0, Math.max(1, max));
  const lines = shown.map((entry) => `- 收藏 ${entry.index} · [${entry.role}] ${entry.title}`);
  if (list.length > shown.length) lines.push(`- …等 ${list.length} 条，用 /favorite list 查看`);
  return lines;
}

/**
 * 把「收藏目录」作为独立文本块追加在摘要之后；没有目录原样返回。
 * @param {{type:string,text:string}[]} summary
 * @param {string[]} lines buildFavoriteDirectoryLines 的产物
 * @returns {{type:string,text:string}[]}
 */
export function appendFavoriteDirectory(summary, lines) {
  const blocks = Array.isArray(summary)
    ? summary.filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    : [];
  if (!Array.isArray(lines) || lines.length === 0) return blocks;
  const text = ['## 收藏（本段）', ...lines, '', '（以上原文未进摘要，按序号可查：/favorite <序号>）'].join('\n');
  return [...blocks, { type: 'text', text }];
}

/**
 * 推荐收藏（半自动）—— **接口占位，实现待接**。
 *
 * 定位：系统识别「值得留」的消息并**建议**，必须由用户点星/命令确认，绝不自动收藏。
 * 预期实现：复用 lib/core/pin-suggest.js 的识别规则（关键决策 / 报错堆栈 / 明确要求别改），
 * 把输出从「建议锁定」改成「建议收藏」。
 *
 * 约定（调用方已按此消费，改实现不用改调用方）：
 * @param {{seq:number,type:string}[]} events 候选事件（通常是当前会话 surface 内消息）
 * @param {{limit?:number}} [options]
 * @returns {{seq:number,role:string,title:string,reason:string,confidence:'high'|'medium'|'low'}[]}
 */
export function suggestFavorites(events, { limit = 3 } = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 3;
  // 实现留白：接 pin-suggest 规则后在这里返回建议；
  // 现在返回空数组 = 「没有推荐」，命令会明确提示「推荐收藏尚未接入」。
  return events.slice(0, 0).slice(0, cap);
}
