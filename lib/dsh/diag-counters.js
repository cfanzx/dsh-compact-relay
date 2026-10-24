/**
 * 诊断计数 / 耗时 / 错误码（dcr 0.4 P0-2）—— 纯内存，进程内累计，重启清零。
 *
 * 为什么单独一个模块：诊断包只允许「数值 / 枚举 / 布尔 / 错误码」，计数必须在动作层
 * 顺手记，但上界、聚合口径与产物形状要有一处唯一实现。本模块：
 *   - 不读会话、不读文件、不发起任何网络请求；
 *   - 只保留最近 20 个耗时样本 / 最近 20 条错误码，长时间运行不膨胀；
 *   - `snapshot()` 每次返回全新对象，调用方改不坏内部状态；
 *   - 错误只收 `code` / `phase` / `at` / `count`，**绝不收 message**（可能含聊天/路径）。
 *
 * 单例在 lib/index.js 装配到 `deps.diag`；actions 通过 `deps.diag.*` 埋点。
 */

/** 耗时样本上限（最近 20 次）。 */
export const LATENCY_SAMPLE_LIMIT = 20;
/** 错误码条目上限（按 code+phase 聚合后的条数）。 */
export const ERROR_ENTRY_LIMIT = 20;
/** 错误码 / 阶段名截断长度（防止异常长字符串撑大诊断包）。 */
const CODE_MAX_CHARS = 60;
const PHASE_MAX_CHARS = 20;

/** 会被计数的动作类别（只统计这两条执行路径）。 */
const ACTION_KINDS = Object.freeze(['compact', 'handoff']);

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * 本地 ISO 时间（带时区偏移，例如 2026-10-24T15:40:00+08:00）。
 *
 * 不用 `toISOString()`：那是 UTC，用户看诊断包时要能对得上本地时间。
 * @param {Date|number|string} [date]
 * @returns {string}
 */
export function localIso(date = new Date()) {
  const time = date instanceof Date ? date.getTime() : new Date(date).getTime();
  const safe = Number.isNaN(time) ? new Date() : new Date(time);
  const offsetMinutes = -safe.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return (
    `${safe.getFullYear()}-${pad2(safe.getMonth() + 1)}-${pad2(safe.getDate())}` +
    `T${pad2(safe.getHours())}:${pad2(safe.getMinutes())}:${pad2(safe.getSeconds())}` +
    `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
  );
}

/** 把任意文本规整成「单行 + 截断」的短标识；空串返回 null。 */
function normalizeToken(value, maxChars) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/gu, ' ').trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxChars ? `${trimmed.slice(0, Math.max(0, maxChars - 1))}…` : trimmed;
}

/**
 * 错误 → 稳定的短 code（只用于诊断计数，不进用户文案）。
 *
 * 优先 `error.code`（本插件动作层自己抛的稳定 code），其次 `error.name`
 * （AbortError / TypeError 等），都没有就 `'error'`。
 * @param {unknown} error
 * @returns {string}
 */
export function errorCodeOf(error) {
  if (error !== null && typeof error === 'object') {
    const code = normalizeToken(error.code, CODE_MAX_CHARS);
    if (code !== null) return code;
    const name = normalizeToken(error.name, CODE_MAX_CHARS);
    if (name !== null && name !== 'Error') return name;
  }
  return 'error';
}

/**
 * 最近 rank 口径的百分位（nearest-rank）：p 分位 = 排序后第 ceil(p*n) 个。
 * 样本为空返回 null；样本 < 3 时也照实给值（n 分别是 1 / 2）。
 * @param {number[]} sorted 已升序排序的样本
 * @param {number} fraction 0–1
 * @returns {number|null}
 */
function percentile(sorted, fraction) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * 进程内诊断计数器。
 *
 * 返回：
 *   - `bumpAction(kind, ok)`：压缩/交接成功或失败 +1（kind: 'compact' | 'handoff'）；
 *   - `recordDuration(kind, ms)`：记录一次耗时（只留最近 20 个样本）；
 *   - `bumpPin()`：一次成功的「锁定」动作 +1（toggle 走一次只记一次）；
 *   - `recordError(code, phase)`：按 (code, phase) 聚合并保留最近 20 条；丢弃 message；
 *   - `snapshot()`：返回 `{ counters, latency, errors }`（形状严格白名单，见方案 §3）。
 *
 * @returns {{bumpAction:Function, recordDuration:Function, bumpPin:Function, recordError:Function, snapshot:Function}}
 */
export function createDiagCounters() {
  const action = {
    compact: { ok: 0, fail: 0 },
    handoff: { ok: 0, fail: 0 },
  };
  let pins = 0;
  const durations = { compact: [], handoff: [] };
  /** key = `${phase}:${code}`；Map 的插入顺序即最近使用顺序（命中时删除再插入）。 */
  const errors = new Map();

  const isKind = (kind) => ACTION_KINDS.includes(kind);

  function bumpAction(kind, ok) {
    if (!isKind(kind)) return;
    if (ok === true) action[kind].ok += 1;
    else action[kind].fail += 1;
  }

  function recordDuration(kind, ms) {
    if (!isKind(kind)) return;
    const value = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
    if (value === null) return;
    const samples = durations[kind];
    samples.push(value);
    if (samples.length > LATENCY_SAMPLE_LIMIT) samples.splice(0, samples.length - LATENCY_SAMPLE_LIMIT);
  }

  function bumpPin() {
    pins += 1;
  }

  function recordError(code, phase) {
    const codeText = normalizeToken(code, CODE_MAX_CHARS) ?? 'error';
    const phaseText = normalizeToken(phase, PHASE_MAX_CHARS) ?? 'unknown';
    const key = `${phaseText}:${codeText}`;
    const existing = errors.get(key);
    if (existing === undefined) {
      errors.set(key, { code: codeText, phase: phaseText, at: localIso(), count: 1 });
      // 只保留最近 20 条：最久没再出现的那条先淘汰（Map 头部）。
      while (errors.size > ERROR_ENTRY_LIMIT) {
        const oldestKey = errors.keys().next().value;
        errors.delete(oldestKey);
      }
      return;
    }
    existing.count += 1;
    existing.at = localIso();
    // 命中即「最近出现过」：挪到 Map 尾部，淘汰顺序才准确。
    errors.delete(key);
    errors.set(key, existing);
  }

  function latencyOf(kind) {
    const sorted = [...durations[kind]].sort((left, right) => left - right);
    return {
      n: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
    };
  }

  function snapshot() {
    return {
      counters: {
        compactOk: action.compact.ok,
        compactFail: action.compact.fail,
        handoffOk: action.handoff.ok,
        handoffFail: action.handoff.fail,
        pins,
      },
      latency: { compact: latencyOf('compact'), handoff: latencyOf('handoff') },
      // 最近出现的在前（诊断包最关心「刚炸了什么」）。
      errors: [...errors.values()].reverse().map(({ code, phase, at, count }) => ({ code, phase, at, count })),
    };
  }

  return { bumpAction, recordDuration, bumpPin, recordError, snapshot };
}
