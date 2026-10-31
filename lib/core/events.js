/**
 * 事件流（0.5.6 Phase A）—— `dcr-event/v1` 的**纯数据层**（零 IO、零 node 内置依赖）。
 *
 * 设计（见 0.5.6 总计划 D1/D4）：
 *   - 一个动作写两行：`phase:'start'` → `phase:'end'`，共享同一个 `id`；
 *   - 失败不单独建文件：`outcome:'fail'` 的行就是失败台账，`failures` 命令 / 诊断端点
 *     的 `recentFailures` 都是**读侧投影**；
 *   - 本文件是 schema / 枚举 / 截断 / 裁剪的唯一实现点（writer / CLI / 端点共用），
 *     文件读写在 `dsh/events.js`；
 *   - `context` 按 **action 白名单**逐字段 pick（`EVENT_CONTEXT_KEYS`）：值只允许
 *     标量或标量数组，字符串单行 ≤80。以后（Phase B/C/D）要加 compaction range /
 *     归属字段时，只需在对应 action 的白名单里加键 —— 旧行没有这个键照样能读，
 *     **不需要迁移**。
 *
 * 两档脱敏（`core/redact.js`）：
 *   - 落盘（`buildEventRecord`）：只删凭据/邮箱，保留路径与 sessionId（本地排查必需），
 *     `$HOME` 前缀缩成 `~`；
 *   - 外发（`exportRowOf`）：全套 LEAK_PATTERNS（含路径/sessionId/私有 IP），
 *     sessionId 只留尾 8 位，message 截到 200。
 */
import { clipCodeUnits, clipChars } from './clip.js';
import { maskSessionId, redactLocalText, redactText, singleLine } from './redact.js';

/** 事件行 schema 版本（每行一个 JSON 对象）。 */
export const EVENT_SCHEMA = 'dcr-event/v1';

/** 事件文件上限：行数 800（D1）。 */
export const EVENT_MAX_ROWS = 800;
/** 失败保护：最近 200 条 fail/cancelled 永不因成功太多被挤掉。 */
export const EVENT_KEEP_FAILURES = 200;
/** 字节上限兜底（800 行 × ~450B ≈ 360KB，给到 1.5MB 只防手滑）。 */
export const EVENT_MAX_BYTES = 1.5 * 1024 * 1024;

/** 单行 message 上限（码元）。 */
export const EVENT_MESSAGE_MAX_CHARS = 300;
/** 外发投影里的 message 上限（诊断端点/export）。 */
export const EXPORT_MESSAGE_MAX_CHARS = 200;
/** code / id / 路径类短字段上限。 */
export const EVENT_CODE_MAX_CHARS = 60;
export const EVENT_ID_MAX_CHARS = 80;
export const EVENT_SHORT_MAX_CHARS = 160;
/** context 单值上限（字符串按码点截断，避免切坏 emoji）。 */
export const CONTEXT_VALUE_MAX_CHARS = 80;
/** start-only 超过这个时长折叠成 `stalled`（10 分钟）。 */
export const STALLED_MS = 10 * 60_000;

/** 两阶段。 */
export const EVENT_PHASES = Object.freeze(['start', 'end']);

/** end 行的结果枚举（start 行恒为 null）。 */
export const EVENT_OUTCOMES = Object.freeze(['ok', 'fail', 'cancelled', 'stalled']);

/** 归属口径（与清单 §3 对齐；unknown = 不猜）。 */
export const EVENT_TRIGGERS = Object.freeze([
  'ui-menu',
  'ui-ring',
  'command',
  'handoff',
  'native-auto',
  'external',
  'unknown',
]);

/**
 * actor：谁发起。0.5.6 D1 起补 `unknown`：旁路监听到的压缩若没有硬证据
 * （turn 非数字、无 sourceCommandId），写入时必须诚实标 unknown，绝不能默认成 user。
 */
export const EVENT_ACTORS = Object.freeze(['user', 'system', 'handoff', 'unknown']);

/**
 * 动作枚举。A 级 = start+end 全记；B 级 = 只在 HTTP 出口的失败/取消记一行 end。
 * 名称沿用 HTTP body 的 `action`，避免两套词汇。
 */
export const EVENT_ACTIONS = Object.freeze([
  'preview',
  'compact',
  'cancel',
  'handoff-preview',
  'handoff',
  'force-archive',
  'recover',
  'favorite-toggle',
  'favorite-mark',
  'favorite-score-trial',
  'pin-toggle',
  'diff',
  'state',
  'native-auto',
  // 0.5.7：客户端上报的传输/渲染侧失败（没有服务端 error 对象，字段由 HTTP 分支直接控）。
  'client-error',
  'unknown',
]);

/** A 级动作（有副作用或贵；start+end 全记）。 */
export const A_LEVEL_ACTIONS = Object.freeze([
  'preview',
  'compact',
  'cancel',
  'handoff-preview',
  'handoff',
  'force-archive',
  'recover',
]);

/**
 * context 的 action 白名单（唯一允许落盘的字段）。
 *
 * 红线：**只从这张表里逐字段 pick**，不接受整对象展开。新增字段 = 在这里加一个键；
 * 旧事件行没有该键时读侧照常工作，所以 Phase B/C/D 不需要迁移数据。
 *
 * 预留（Phase D，尚未产生）：`compact` 计划增加 compaction range / 归属字段
 * （`rangeStartSeq` / `rangeEndSeq` / `rangeNodes` / `attribution` 等），
 * 加到下面 `compact` 数组即可。
 */
export const EVENT_CONTEXT_KEYS = Object.freeze({
  preview: Object.freeze([
    'phase',
    'surfaceNodes',
    'note',
    'nodes',
    'tokens',
    'shadowedTokens',
    'summaries',
    'ratio',
    'advice',
    'pinned',
    'lastSurfaceSeq',
    'lastSurfaceType',
    'openTurn',
    'pairingBalanced',
  ]),
  compact: Object.freeze([
    'phase',
    'surfaceNodes',
    'note',
    'nodes',
    'tokens',
    'ratio',
    'shadowedSeqs',
    'startSeq',
    'endSeq',
    'shadowedTokens',
    'summaries',
    'allowMergeOldSummaries',
    'pinned',
    'pinnedKept',
    'attempts',
    // 0.5.6 D1（压缩归属，additive）：摘要模型 / 本次是否真的合并了旧摘要。
    // 范围条数/tokens/起止 seq 复用上面的 nodes/shadowedTokens/startSeq/endSeq，
    // 结果复用 end 行的 outcome/code/message —— 不重复造键。
    'model',
    'merged',
    // 0.5.7：长动作异步化后，start/end 行都带 jobId（compact 的两处 event.context 是整体替换，必须显式带上）。
    'jobId',
  ]),
  cancel: Object.freeze(['kind', 'inflight']),
  'handoff-preview': Object.freeze([
    'phase',
    'surfaceNodes',
    'note',
    'tokens',
    'ratio',
    'summaries',
    'pinned',
    'attempts',
    'ready',
    'openTurn',
    'pairingBalanced',
    'lastSurfaceSeq',
    'lastSurfaceType',
    // 0.5.7：长动作异步化（job-start 起的任务 id）。
    'jobId',
  ]),
  handoff: Object.freeze([
    'phase',
    'surfaceNodes',
    'note',
    'tokens',
    'ratio',
    'summaries',
    'pinned',
    'compacted',
    'shadowedSeqs',
    'attempts',
    'ready',
    'archive',
    'lastSurfaceSeq',
    'lastSurfaceType',
    // 0.5.7：长动作异步化（job-start 起的任务 id）。
    'jobId',
  ]),
  'force-archive': Object.freeze(['phase', 'surfaceNodes', 'archived', 'activity', 'status', 'hasChild']),
  recover: Object.freeze(['phase', 'surfaceNodes', 'archived', 'status']),
  'favorite-toggle': Object.freeze([]),
  'favorite-mark': Object.freeze([]),
  'favorite-score-trial': Object.freeze([]),
  'pin-toggle': Object.freeze([]),
  diff: Object.freeze([]),
  state: Object.freeze([]),
  'native-auto': Object.freeze(['enabled']),
  // 0.5.7：客户端错误只留三个标量（bodyHead 由客户端先 clip 到 80 码点）。
  'client-error': Object.freeze(['status', 'bodyHead', 'kind']),
  unknown: Object.freeze([]),
});

/** 读侧行 schema：CLI `--json` / 端点 `recentFailures` / export 机读块共用。 */
export const EVENT_ROW_KEYS = Object.freeze([
  'id',
  'at',
  'action',
  'trigger',
  'outcome',
  'durationMs',
  'code',
  'message',
  'sessionId',
  'compactionId',
  'context',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function intOrNull(value) {
  const number = finiteOrNull(value);
  return number === null ? null : Math.max(0, Math.round(number));
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

/** 枚举归一：非法/缺失 → 'unknown'（不猜）。 */
export function normalizeTrigger(value) {
  return EVENT_TRIGGERS.includes(value) ? value : 'unknown';
}

/** 动作归一：非法/缺失 → 'unknown'。 */
export function normalizeAction(value) {
  return EVENT_ACTIONS.includes(value) ? value : 'unknown';
}

/** outcome 归一：非法 → end 行按 fail 处理（写坏数据也不能读成成功）。 */
export function normalizeOutcome(value) {
  return EVENT_OUTCOMES.includes(value) ? value : 'fail';
}

/**
 * context 单值：只接受标量或标量数组；字符串单行 + 按码点截断 80。
 * @returns {string|number|boolean|null} null = 丢弃这个键
 */
function contextValueOf(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const text = singleLine(value, 400);
    return text === null ? null : clipChars(text, CONTEXT_VALUE_MAX_CHARS, { ellipsis: 'inside' });
  }
  if (Array.isArray(value)) {
    const parts = value
      .filter((item) => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)))
      .slice(0, 16)
      .map((item) => String(item));
    if (parts.length === 0) return null;
    return clipChars(parts.join(','), CONTEXT_VALUE_MAX_CHARS, { ellipsis: 'inside' });
  }
  return null;
}

/**
 * 按 action 白名单裁剪 context；未知 action → 空上下文。
 * @param {string} action
 * @param {unknown} raw
 * @returns {object|null} 没有任何可用值时返回 null
 */
export function contextOf(action, raw) {
  const allowed = EVENT_CONTEXT_KEYS[action];
  if (!Array.isArray(allowed) || !isObject(raw)) return null;
  const out = {};
  let count = 0;
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = contextValueOf(raw[key]);
    if (value === null) continue;
    out[key] = value;
    count += 1;
  }
  return count === 0 ? null : out;
}

/** 读侧：保留任意 scalar context 键（向前兼容未来版本写入的字段）。 */
function contextOfRaw(raw) {
  if (!isObject(raw)) return null;
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/u.test(key)) continue;
    const picked = contextValueOf(value);
    if (picked === null) continue;
    out[key] = picked;
    count += 1;
  }
  return count === 0 ? null : out;
}

/**
 * 构造一条事件记录（writer 用；非法 phase/action/id → null，调用方静默丢弃）。
 *
 * @param {object} input
 * @param {'start'|'end'} input.phase
 * @param {string} input.id start/end 共享
 * @param {string} [input.at] 本地 ISO（dsh 层注入）
 * @param {string} input.action
 * @param {string} [input.trigger]
 * @param {string} [input.actor]
 * @param {string} [input.outcome] 仅 end
 * @param {number|null} [input.durationMs] 仅 end
 * @param {string|null} [input.code] 仅 end
 * @param {string|null} [input.message] 仅 end（单行 ≤300，落盘档脱敏）
 * @param {string|null} [input.sessionId]
 * @param {string|null} [input.compactionId]
 * @param {string|null} [input.planId]
 * @param {string|null} [input.childId]
 * @param {object|null} [input.context]
 * @param {string} [input.version] 插件版本
 * @param {string} [input.home] 本机 home（把路径缩成 ~）；不传则跳过
 * @returns {object|null}
 */
export function buildEventRecord(input = {}) {
  if (!isObject(input)) return null;
  const phase = EVENT_PHASES.includes(input.phase) ? input.phase : null;
  if (phase === null) return null;
  const action = EVENT_ACTIONS.includes(input.action) ? input.action : null;
  if (action === null) return null;
  const id = singleLine(input.id, EVENT_ID_MAX_CHARS);
  if (id === null) return null;
  const at = singleLine(input.at, 40);
  if (at === null) return null;

  const isEnd = phase === 'end';
  const rawMessage = isEnd ? singleLine(input.message, 400) : null;
  let message = null;
  if (rawMessage !== null) {
    const cleaned = redactLocalText(clipCodeUnits(rawMessage, EVENT_MESSAGE_MAX_CHARS), { home: input.home });
    message = cleaned.text.length === 0 ? null : cleaned.text;
  }

  return {
    schema: EVENT_SCHEMA,
    id,
    phase,
    at,
    action,
    trigger: normalizeTrigger(input.trigger),
    actor: EVENT_ACTORS.includes(input.actor) ? input.actor : 'user',
    outcome: isEnd ? normalizeOutcome(input.outcome) : null,
    sessionId: singleLine(input.sessionId, EVENT_SHORT_MAX_CHARS),
    compactionId: singleLine(input.compactionId, EVENT_SHORT_MAX_CHARS),
    planId: singleLine(input.planId, EVENT_SHORT_MAX_CHARS),
    childId: singleLine(input.childId, EVENT_SHORT_MAX_CHARS),
    durationMs: isEnd ? intOrNull(input.durationMs) : null,
    code: isEnd ? singleLine(input.code, EVENT_CODE_MAX_CHARS) : null,
    message,
    context: contextOf(action, input.context),
    v: singleLine(input.version, 20),
  };
}

/**
 * 读侧容错：schema/phase/action/id/at 不合法 → null（该行跳过）。
 * @param {unknown} raw
 * @returns {object|null}
 */
export function normalizeEventRecord(raw) {
  if (!isObject(raw)) return null;
  if (raw.schema !== EVENT_SCHEMA) return null;
  const record = buildEventRecord(raw);
  if (record === null) return null;
  // 读侧保留任意 context 标量键（写侧白名单将来新增字段时，旧读侧也能展示）。
  return { ...record, context: contextOfRaw(raw.context) };
}

/**
 * 解析 JSONL 文本：坏行 / 未知 schema / 非法记录跳过。
 * @param {string} text
 * @returns {object[]}
 */
export function parseEventLines(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // 半截写/手改：跳过
    }
    const record = normalizeEventRecord(parsed);
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * 读侧行投影（11 键，顺序冻结）—— CLI `--json` / `show` / export 共用。
 * @param {object} record 事件记录
 * @returns {object|null}
 */
export function eventRowOf(record) {
  if (!isObject(record)) return null;
  return {
    id: singleLine(record.id, EVENT_ID_MAX_CHARS),
    at: singleLine(record.at, 40),
    action: normalizeAction(record.action),
    trigger: normalizeTrigger(record.trigger),
    outcome: record.outcome === null || record.outcome === undefined ? null : normalizeOutcome(record.outcome),
    durationMs: intOrNull(record.durationMs),
    code: singleLine(record.code, EVENT_CODE_MAX_CHARS),
    message: singleLine(record.message, EVENT_MESSAGE_MAX_CHARS),
    sessionId: singleLine(record.sessionId, EVENT_SHORT_MAX_CHARS),
    compactionId: singleLine(record.compactionId, EVENT_SHORT_MAX_CHARS),
    context: isObject(record.context) ? { ...record.context } : null,
  };
}

/**
 * 外发投影（与 eventRowOf 同键）：全套脱敏 + sessionId 只留尾 8 位 + message ≤200。
 * 用于诊断端点 `events.recentFailures` / CLI `export` / 500 body 的 `failure`。
 * @param {object} record
 * @param {{messageMax?:number}} [options]
 * @returns {object|null}
 */
export function exportRowOf(record, { messageMax = EXPORT_MESSAGE_MAX_CHARS } = {}) {
  const row = eventRowOf(record);
  if (row === null) return null;
  const message = row.message === null ? null : redactText(row.message).text;
  const context = row.context === null ? null : redactContext(row.context);
  return {
    ...row,
    message: message === null ? null : clipCodeUnits(message, messageMax),
    sessionId: maskSessionId(row.sessionId),
    context,
  };
}

/** context 逐值脱敏（外发档）。 */
function redactContext(context) {
  const out = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = typeof value === 'string' ? redactText(value).text : value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** 这条记录算不算「失败投影」（fail / cancelled / stalled）。 */
export function isFailureRow(record) {
  return isObject(record) && (record.outcome === 'fail' || record.outcome === 'cancelled' || record.outcome === 'stalled');
}

/**
 * 失败留档的写入门槛（B 级动作与 HTTP 出口共用）。
 * busy/changed/nosession(409) 是正常可重试状态，不写；取消写（outcome cancelled，不计失败）。
 * @param {{statusCode?:number, code?:string, cancelled?:boolean}} [input]
 * @returns {boolean}
 */
export function shouldRecordFailure({ statusCode, code, cancelled } = {}) {
  if (cancelled === true) return true;
  if (code === 'busy' || code === 'changed') return false;
  if (code === 'nosession' && statusCode === 409) return false;
  return true;
}

/**
 * 过滤（CLI / 端点共用）：保持文件顺序（旧 → 新）。
 * @param {object[]} records
 * @param {{last?:number, action?:string, outcome?:string, sessionId?:string, since?:number}} [options]
 * @returns {object[]}
 */
export function filterEvents(records, { last, action, outcome, sessionId, since } = {}) {
  let list = Array.isArray(records) ? records.filter((record) => isObject(record)) : [];
  if (typeof action === 'string' && action.length > 0) {
    const wanted = action.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
    if (wanted.length > 0) list = list.filter((record) => wanted.includes(record.action));
  }
  if (typeof outcome === 'string' && outcome.length > 0) {
    const wanted = outcome.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
    if (wanted.length > 0) list = list.filter((record) => wanted.includes(record.outcome));
  }
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    list = list.filter((record) => record.sessionId === sessionId);
  }
  if (typeof since === 'number' && Number.isFinite(since)) {
    list = list.filter((record) => {
      const time = Date.parse(record.at);
      return Number.isNaN(time) ? true : time >= since;
    });
  }
  if (Number.isInteger(last) && last > 0 && list.length > last) list = list.slice(-last);
  return list;
}

/**
 * start/end 按 id 折叠成一行（CLI 默认视图）。
 *
 * - 有 end：用 end 行做投影；
 * - 只有 start：超过 `STALLED_MS` → `outcome:'stalled'`（宿主被杀/卡死），否则 outcome=null（进行中）。
 *
 * @param {object[]} records
 * @param {{now?:number, stalledMs?:number}} [options]
 * @returns {object[]} 与输入同序（每个 id 第一次出现的位置）
 */
export function collapseEvents(records, { now = Date.now(), stalledMs = STALLED_MS } = {}) {
  const list = Array.isArray(records) ? records.filter((record) => isObject(record)) : [];
  const order = [];
  const groups = new Map();
  for (const record of list) {
    const key = typeof record.id === 'string' ? record.id : null;
    if (key === null) continue;
    if (!groups.has(key)) {
      groups.set(key, { start: null, end: null });
      order.push(key);
    }
    const group = groups.get(key);
    if (record.phase === 'start') group.start = record;
    else if (record.phase === 'end') group.end = record;
  }

  const rows = [];
  for (const key of order) {
    const group = groups.get(key);
    const base = group.end ?? group.start;
    if (base === null) continue;
    const row = eventRowOf(base);
    if (row === null) continue;
    if (group.end === null) {
      const startedAt = Date.parse(row.at ?? '');
      const age = Number.isNaN(startedAt) ? Number.POSITIVE_INFINITY : now - startedAt;
      rows.push({ ...row, outcome: age > stalledMs ? 'stalled' : null });
    } else {
      rows.push(row);
    }
  }
  return rows;
}

/** 单行 JSON 的字节数（TextEncoder 在 node/浏览器都有，core 不依赖 node:buffer）。 */
function byteLengthOf(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * 纯函数裁剪：行数 800 + 字节 1.5MB 双阈值，**失败保护 200**。
 *
 * 算法：
 *   1. 未超限 → 原样返回；
 *   2. 从最旧的「非 fail/cancelled 行」开始删，直到满足行数/字节上限；
 *   3. 仍超（全是失败）→ 从最旧的失败删，但保留最近 `keepFailures` 条。
 *
 * @param {object[]} records
 * @param {{maxRows?:number, keepFailures?:number, maxBytes?:number}} [options]
 * @returns {object[]} 保持原顺序
 */
export function pruneEvents(records, { maxRows = EVENT_MAX_ROWS, keepFailures = EVENT_KEEP_FAILURES, maxBytes = EVENT_MAX_BYTES } = {}) {
  const list = Array.isArray(records) ? records.slice() : [];
  const rowsCap = Number.isInteger(maxRows) && maxRows > 0 ? maxRows : EVENT_MAX_ROWS;
  const failCap = Number.isInteger(keepFailures) && keepFailures > 0 ? keepFailures : EVENT_KEEP_FAILURES;
  const bytesCap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : EVENT_MAX_BYTES;

  const within = (value) => value.length <= rowsCap && byteLengthOf(value) <= bytesCap;
  if (within(list)) return list;

  // 从最旧的普通行开始丢；不够再丢最旧的失败（失败保护优先）。
  // 注意：不在开头预裁失败 —— 900 行里 300 条失败、行数上限 800 时，
  // 只该丢掉 100 条最旧的普通行，300 条失败一条都不该少。
  let cursor = 0;
  while (!within(list) && cursor < list.length) {
    if (!isFailureRow(list[cursor])) {
      list.splice(cursor, 1);
      continue;
    }
    cursor += 1;
  }
  // 删完普通行仍超上限 = 剩下的全是失败：保留最近 failCap 条（失败配额，不是行数上限）。
  if (!within(list) && list.length > failCap && list.every(isFailureRow)) {
    return list.slice(-failCap);
  }
  return list;
}
