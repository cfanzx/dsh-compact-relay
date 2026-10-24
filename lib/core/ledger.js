/**
 * 轻账本（0.4 P1-3）—— 压缩/交接「可审计流水」的**纯数据层**（零 IO、零依赖）。
 *
 * 只做三件事：
 *  1. `buildLedgerRecord(input)`：按 allowlist 构造一条记录（只收数值/枚举/时间/交接单路径；
 *     **绝不收消息原文、摘要、交接单正文、sessionId、cwd、用户名**等隐私内容）；
 *  2. `normalizeLedgerRecord(raw)` / `parseLedgerLines(text)`：读侧容错——坏行/坏记录直接跳过，
 *     让损坏文件永远不会影响宿主动作；
 *  3. `summarizeLedgerRecords(records)`：设置页那一行累计数字（次数 / 腾出 tokens / 平均耗时）。
 *
 * 文件读写在 `dsh/ledger.js`；本模块可裸跑单测。
 */

/** 账本 schema 版本（JSONL 每行一个对象）。 */
export const LEDGER_SCHEMA = 'dcr-ledger/v1';

/** 保留的最近条数上限（超过就裁掉最旧的）。 */
export const LEDGER_MAX_ENTRIES = 200;

/** 允许的 kind。 */
export const LEDGER_KINDS = Object.freeze(['compact', 'handoff']);

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** token 数：非负整数（>2^53 的怪值也夹住，防手滑）。 */
function tokensOrNull(value) {
  const number = finiteOrNull(value);
  if (number === null) return null;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(number)));
}

/** 比例：0–1，保留 3 位小数。 */
function ratioOrNull(value) {
  const number = finiteOrNull(value);
  if (number === null) return null;
  return Math.round(Math.min(1, Math.max(0, number)) * 1000) / 1000;
}

/** 耗时 ms：非负整数。 */
function durationOrNull(value) {
  const number = finiteOrNull(value);
  if (number === null) return null;
  return Math.max(0, Math.round(number));
}

/** 单行文本（路径/id 用）：折叠空白 + 截断；空串 → null。 */
function lineOrNull(value, maxChars) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * 构造一条账本记录；kind 非法返回 null（调用方静默丢弃）。
 *
 * @param {object} input
 * @param {'compact'|'handoff'} input.kind
 * @param {string} [input.at] 本地 ISO 时间（由 dsh/ledger 注入；纯函数这里只做字符串校验）
 * @param {number} [input.durationMs]
 * @param {number|null} [input.beforeTokens]
 * @param {number|null} [input.afterTokens]
 * @param {number|null} [input.beforeRatio]
 * @param {number|null} [input.afterRatio]
 * @param {{inRange?:number|null, total?:number|null}|null} [input.pinHits]
 * @param {{path?:string, childId?:string, started?:boolean}|null} [input.handoff] 仅交接记录
 * @returns {object|null}
 */
export function buildLedgerRecord(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const kind = LEDGER_KINDS.includes(input.kind) ? input.kind : null;
  if (kind === null) return null;

  const beforeTokens = tokensOrNull(input.beforeTokens);
  const afterTokens = tokensOrNull(input.afterTokens);
  // 「腾出」= 压前 - 压后；拿不到两个数就 null（不猜）。
  const freedTokens = beforeTokens !== null && afterTokens !== null ? Math.max(0, beforeTokens - afterTokens) : null;
  const pinSource = input.pinHits !== null && typeof input.pinHits === 'object' ? input.pinHits : {};
  const pinInRange = tokensOrNull(pinSource.inRange);
  const pinTotal = tokensOrNull(pinSource.total);
  const handoffSource = input.handoff !== null && typeof input.handoff === 'object' ? input.handoff : null;

  return {
    schema: LEDGER_SCHEMA,
    kind,
    at: lineOrNull(input.at, 40),
    durationMs: durationOrNull(input.durationMs),
    beforeTokens,
    afterTokens,
    freedTokens,
    beforeRatio: ratioOrNull(input.beforeRatio),
    afterRatio: ratioOrNull(input.afterRatio),
    pinHits: { inRange: pinInRange, total: pinTotal },
    handoff:
      kind === 'handoff' && handoffSource !== null
        ? {
            // 只记路径（任务要求）与短 id/布尔；不记交接单正文。
            path: lineOrNull(handoffSource.path, 500),
            childId: lineOrNull(handoffSource.childId, 120),
            started: typeof handoffSource.started === 'boolean' ? handoffSource.started : null,
          }
        : null,
  };
}

/**
 * 读侧单条记录容错：形状不对/kind 非法 → null（该行跳过）。
 * @param {unknown} raw
 * @returns {object|null}
 */
export function normalizeLedgerRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.schema !== LEDGER_SCHEMA) return null;
  return buildLedgerRecord(raw);
}

/**
 * 解析 JSONL 文本：逐行 JSON.parse，坏行/坏记录跳过（损坏文件静默降级）。
 * @param {string} text
 * @returns {object[]}
 */
export function parseLedgerLines(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // 坏行（半截写/手改）直接跳过
    }
    const record = normalizeLedgerRecord(parsed);
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * 设置页「一行累计数字」的数据（与账本同源，可直接对照）。
 *
 * @param {object[]} records 账本记录（已按时间顺序）
 * @returns {{count:number, compactCount:number, handoffCount:number, freedTokens:number, avgDurationMs:number|null, lastAt:string|null}}
 */
export function summarizeLedgerRecords(records) {
  const list = Array.isArray(records) ? records.filter((record) => record !== null && typeof record === 'object') : [];
  let compactCount = 0;
  let handoffCount = 0;
  let freedTokens = 0;
  let durationSum = 0;
  let durationCount = 0;
  let lastAt = null;
  for (const record of list) {
    if (record.kind === 'compact') compactCount += 1;
    else if (record.kind === 'handoff') handoffCount += 1;
    if (typeof record.freedTokens === 'number' && Number.isFinite(record.freedTokens) && record.freedTokens > 0) {
      freedTokens += record.freedTokens;
    }
    if (typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0) {
      durationSum += record.durationMs;
      durationCount += 1;
    }
    if (typeof record.at === 'string' && record.at.length > 0) lastAt = record.at;
  }
  return {
    count: compactCount + handoffCount,
    compactCount,
    handoffCount,
    freedTokens,
    avgDurationMs: durationCount === 0 ? null : Math.round(durationSum / durationCount),
    lastAt,
  };
}
