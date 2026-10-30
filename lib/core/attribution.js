/**
 * 压缩归属投影（0.5.6 Phase D1）—— **纯数据层**（零 IO、零时钟、零随机）。
 *
 * 设计（总计划 D2）：
 *   - 归属事实不单独落文件：`action:'compact'` 的事件行本身就是归属行；
 *   - 读侧从事件行派生 `{compactionId, at, trigger, actor, outcome, durationMs,
 *     range:{count,tokens,startSeq,endSeq}, model, merged, code, message}`；
 *   - **不猜**：`trigger` 来自写入方（我们自己的动作登记 / 旁路监听器按
 *     `compaction/start` 的 turn + sourceCommandId 分类），投影只做归一；
 *   - 同一 `compactionId` 的多行（如 start/end、跨进程补写）按「最后一条」折叠，
 *     绝不重复计数。
 *
 * actor 口径（与清单 §3 一致）：
 *   native-auto → system
 *   ui-menu / ui-ring / command / handoff / external → user
 *   unknown（缺证据）→ unknown
 *
 * 红线：`turn === null` **永远不是** native-auto 的证据。
 */
import { normalizeOutcome, normalizeTrigger } from './events.js';

/** 默认返回条数（端点 / readState 共用）。 */
export const ATTRIBUTION_LIMIT_DEFAULT = 20;
/** 单次最多返回条数（端点 limit 上限）。 */
export const ATTRIBUTION_LIMIT_MAX = 100;

/** 归属行键集合（顺序冻结；readState.lastCompaction 与端点共用同一形状）。 */
export const ATTRIBUTION_ROW_KEYS = Object.freeze([
  'compactionId',
  'at',
  'trigger',
  'actor',
  'outcome',
  'durationMs',
  'range',
  'model',
  'merged',
  'code',
  'message',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value, max = 160) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function intOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

/**
 * trigger → actor（未知枚举按 unknown 处理，不猜成 user）。
 * @param {string} trigger
 * @returns {'user'|'system'|'unknown'}
 */
export function actorOfTrigger(trigger) {
  switch (normalizeTrigger(trigger)) {
    case 'native-auto':
      return 'system';
    case 'ui-menu':
    case 'ui-ring':
    case 'command':
    case 'handoff':
    case 'external':
      return 'user';
    default:
      return 'unknown';
  }
}

/**
 * 旁路归属判据（唯一实现点）：
 *   - `turn` 是数字 → DSH 自动/显式范围路径 → native-auto / system；
 *   - 否则有 `sourceCommandId` → 外部命令（内置 /compact 等）→ command / user；
 *   - 都没有 → unknown / unknown（**不猜**）。
 *
 * @param {{turn?:unknown, sourceCommandId?:unknown, commandName?:unknown}} [input]
 * @returns {{trigger:string, actor:'user'|'system'|'unknown', evidence:{turn:number|null, sourceCommandId:string|null, commandName:string|null}}}
 */
export function classifyForeignCompaction({ turn, sourceCommandId, commandName } = {}) {
  const evidence = {
    turn: typeof turn === 'number' && Number.isFinite(turn) ? turn : null,
    sourceCommandId: stringOrNull(sourceCommandId, 160),
    commandName: stringOrNull(commandName, 80),
  };
  if (evidence.turn !== null) return { trigger: 'native-auto', actor: 'system', evidence };
  if (evidence.sourceCommandId !== null) return { trigger: 'command', actor: 'user', evidence };
  return { trigger: 'unknown', actor: 'unknown', evidence };
}

/** 从 context 取范围（缺键 → null；不猜 0）。 */
function rangeOf(context) {
  return {
    count: intOrNull(context?.nodes),
    tokens: intOrNull(context?.shadowedTokens),
    startSeq: intOrNull(context?.startSeq),
    endSeq: intOrNull(context?.endSeq),
  };
}

/** 一行事件 → 归属行；不是归属行（action/compactionId 不符）→ null。 */
function attributionRowOf(record) {
  if (!isObject(record) || record.action !== 'compact') return null;
  const compactionId = stringOrNull(record.compactionId, 80);
  if (compactionId === null) return null;
  const trigger = normalizeTrigger(record.trigger);
  const context = isObject(record.context) ? record.context : {};
  const outcome =
    record.outcome === null || record.outcome === undefined ? null : normalizeOutcome(record.outcome);
  return {
    compactionId,
    at: stringOrNull(record.at, 40),
    trigger,
    actor: actorOfTrigger(trigger),
    outcome,
    durationMs: intOrNull(record.durationMs),
    range: rangeOf(context),
    model: stringOrNull(context.model, 80),
    merged: typeof context.merged === 'boolean' ? context.merged : null,
    code: stringOrNull(record.code, 60),
    message: stringOrNull(record.message, 200),
  };
}

/** 会话过滤：字符串精确匹配 / 数组包含；没有过滤条件 → 全部。 */
function sessionMatches(record, sessionId, sessionIds) {
  if (typeof sessionId === 'string' && sessionId.length > 0) return record.sessionId === sessionId;
  if (Array.isArray(sessionIds) && sessionIds.length > 0) {
    return sessionIds.includes(record.sessionId);
  }
  return true;
}

/**
 * 从事件行派生全部压缩归属（最新在前）。
 *
 * @param {object[]} records 事件行（`dcr-event/v1`，文件顺序旧 → 新）
 * @param {{sessionId?:string, sessionIds?:string[]}} [options]
 * @returns {object[]}
 */
export function collectAttributions(records, { sessionId, sessionIds } = {}) {
  const list = Array.isArray(records) ? records : [];
  /** @type {Map<string, {row:object, index:number, time:number}>} */
  const byId = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const record = list[index];
    if (!isObject(record) || !sessionMatches(record, sessionId, sessionIds)) continue;
    const row = attributionRowOf(record);
    if (row === null) continue;
    const time = Date.parse(row.at ?? '');
    const entry = { row, index, time: Number.isNaN(time) ? 0 : time };
    // 同一 compactionId：后写覆盖先写（end 行通常在后），但保留最后出现的位置。
    const previous = byId.get(row.compactionId);
    if (previous === undefined || entry.index >= previous.index) byId.set(row.compactionId, entry);
  }
  const rows = [...byId.values()];
  // 最新在前：at 降序；同一时间按文件顺序倒序（后写的是更新的观察）。
  rows.sort((a, b) => (b.time - a.time) || (b.index - a.index));
  return rows.map((entry) => entry.row);
}

/**
 * 最近 N 次压缩归属（最新在前）。
 *
 * @param {object[]} records
 * @param {{sessionId?:string, sessionIds?:string[], limit?:number|null}} [options]
 *   limit 省略 = ATTRIBUTION_LIMIT_DEFAULT；null / 非正数 = 不限；超过上限自动裁剪。
 * @returns {object[]}
 */
export function attributionOfEvents(records, { sessionId, sessionIds, limit = ATTRIBUTION_LIMIT_DEFAULT } = {}) {
  const rows = collectAttributions(records, { sessionId, sessionIds });
  if (limit === null || limit === Number.POSITIVE_INFINITY) return rows;
  const cap =
    Number.isInteger(limit) && limit > 0
      ? Math.min(limit, ATTRIBUTION_LIMIT_MAX)
      : ATTRIBUTION_LIMIT_DEFAULT;
  return rows.slice(0, cap);
}

/** 最近一条压缩归属；没有 → null。 */
export function latestAttributionOf(records, { sessionId, sessionIds } = {}) {
  return collectAttributions(records, { sessionId, sessionIds })[0] ?? null;
}
