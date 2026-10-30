/**
 * 事件文件存储（0.5.6 Phase A）—— `$DSH_HOME/compact-relay-events.jsonl` 的唯一 IO 层。
 *
 * 设计红线（总计划 D1/D4）：
 *   - **永不抛**：所有读写都 try/catch 吞掉，写失败只 `{ok:false}`，绝不改变动作结果；
 *   - **有界**：行数 800 / 字节 1.5MB 双阈值，失败保护最近 200 条（由 `core/events.pruneEvents`）；
 *   - **一个写入点**：本模块的 `start`/`end`/`record` 是唯一写入口；失败台账不存在独立文件，
 *     `recentFailures` 是事件流的读侧投影；
 *   - **两档脱敏**：落盘走 `buildEventRecord`（保留路径、删凭据），外发走 `exportRowOf`。
 *
 * 与 `dsh/ledger.js` 的分工：ledger 是给用户看的成功指标账本（只数值、只成功）；
 * 本文件是给 agent 自己看的动作日志（成败取消都有、含截断 message）。两者不互相派生。
 */
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultDshHome } from '../core/config-schema.js';
import {
  EVENT_KEEP_FAILURES,
  EVENT_MAX_BYTES,
  EVENT_MAX_ROWS,
  buildEventRecord,
  collapseEvents,
  eventRowOf,
  exportRowOf,
  filterEvents,
  isFailureRow,
  normalizeAction,
  parseEventLines,
  pruneEvents,
  shouldRecordFailure,
} from '../core/events.js';
import { localIso } from './diag-counters.js';
import { createJsonlLog, readJsonlText } from './jsonl.js';

/** 事件文件名（放 DSH_HOME 下，与 compact-relay-ledger.jsonl 同级）。 */
export const EVENTS_FILE = 'compact-relay-events.jsonl';

/** 默认事件文件路径：`$DSH_HOME/compact-relay-events.jsonl`。 */
export function defaultEventsPath() {
  return path.join(defaultDshHome(), EVENTS_FILE);
}

/** 本地时间戳（id 里用，压缩到秒）。 */
function stampOf(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * 生成事件 id：`evt-20261029T201233-7c1e33ab`（start/end 共享）。
 * @param {Date} [now]
 * @returns {string}
 */
export function newEventId(now = new Date()) {
  return `evt-${stampOf(now)}-${randomUUID().replace(/-/gu, '').slice(0, 8)}`;
}

/**
 * 读事件文件（坏行跳过；读失败 → []，不抛）。
 * @param {string} [file]
 * @param {{maxRows?:number}} [options]
 * @returns {object[]}
 */
export function readEventsFile(file = defaultEventsPath(), { maxRows = EVENT_MAX_ROWS } = {}) {
  try {
    const text = readJsonlText(file);
    if (text === null) return [];
    const records = parseEventLines(text);
    const cap = Number.isInteger(maxRows) && maxRows > 0 ? maxRows : EVENT_MAX_ROWS;
    return records.length > cap ? records.slice(-cap) : records;
  } catch {
    return [];
  }
}

/** 同一路径/上限复用一份行数计数，避免每次 append 全量读。 */
const eventLogs = new Map();

function eventLogOf(file, { maxRows = EVENT_MAX_ROWS, maxBytes = EVENT_MAX_BYTES } = {}) {
  const key = `${file}\u0000${maxRows}\u0000${maxBytes}`;
  let log = eventLogs.get(key);
  if (log === undefined) {
    log = createJsonlLog({
      file,
      maxRows,
      byteLimit: maxBytes,
      prune(lines) {
        const records = parseEventLines(lines.join('\n'));
        return pruneEvents(records, { maxRows, maxBytes }).map((record) => JSON.stringify(record));
      },
    });
    eventLogs.set(key, log);
  }
  return log;
}

/**
 * 追加一条已构造好的事件记录（永不抛）。
 * @param {object} record buildEventRecord 的产物
 * @param {string} [file]
 * @returns {{ok:boolean}}
 */
export function appendEventRecord(record, file = defaultEventsPath(), options = {}) {
  try {
    if (record === null || typeof record !== 'object') return { ok: false };
    const result = eventLogOf(file, options).append(JSON.stringify(record));
    return { ok: result.ok === true };
  } catch {
    return { ok: false };
  }
}

/**
 * 事件存储单例（`lib/index.js` 装配到 `deps.events`）。
 *
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {number} [options.maxRows]
 * @param {number} [options.keepFailures]
 * @param {number} [options.maxBytes]
 * @param {string} [options.version] 插件版本（写进每行 `v`，用来排「旧版没埋点」）
 * @param {string} [options.home] 本机 home（落盘把路径缩成 ~）；缺省 os.homedir()
 * @returns {object}
 */
export function createEventStore({
  file = defaultEventsPath(),
  maxRows = EVENT_MAX_ROWS,
  keepFailures = EVENT_KEEP_FAILURES,
  maxBytes = EVENT_MAX_BYTES,
  version,
  home = safeHome(),
} = {}) {
  // 进行中的 start 上下文：end 只带 id 时也能补齐 action/trigger/sessionId 等字段。
  const pending = new Map();
  const PENDING_LIMIT = 256;

  function remember(id, base) {
    if (typeof id !== 'string' || id.length === 0) return;
    pending.set(id, base);
    while (pending.size > PENDING_LIMIT) {
      const oldest = pending.keys().next().value;
      pending.delete(oldest);
    }
  }

  function buildAndAppend(input) {
    try {
      const record = buildEventRecord({ ...input, version, home });
      if (record === null) return { ok: false, record: null };
      const result = appendEventRecord(record, file, { maxRows, maxBytes });
      return { ok: result.ok === true, record };
    } catch {
      return { ok: false, record: null };
    }
  }

  return {
    filePath: file,
    /**
     * 记 start 行。
     * @param {object} input {action, trigger?, actor?, sessionId?, compactionId?, planId?, childId?, context?}
     * @returns {{ok:boolean, id:string|null, at:string}}
     */
    start(input = {}) {
      const now = new Date();
      const at = localIso(now);
      const id = newEventId(now);
      const base = {
        action: normalizeAction(input.action),
        trigger: input.trigger,
        actor: input.actor,
        sessionId: input.sessionId,
        compactionId: input.compactionId,
        planId: input.planId,
        childId: input.childId,
      };
      const result = buildAndAppend({
        ...base,
        id,
        at,
        phase: 'start',
        context: input.context,
      });
      if (result.ok === true) remember(id, { ...base, startedAt: now.getTime() });
      return { ok: result.ok === true, id: result.ok === true ? id : null, at };
    },
    /**
     * 记 end 行（自动继承 start 的 action/trigger/sessionId/context，自动算耗时）。
     * @param {object} input {id, outcome, code?, message?, durationMs?, context?, compactionId?,
     *   planId?, childId?, action?, trigger?, sessionId?, actor?}
     * @returns {{ok:boolean, id:string|null, at:string}}
     */
    end(input = {}) {
      const at = localIso();
      const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : null;
      const base = id === null ? {} : (pending.get(id) ?? {});
      if (id !== null) pending.delete(id);
      const durationMs =
        Number.isFinite(input.durationMs)
          ? input.durationMs
          : Number.isFinite(base.startedAt)
            ? Date.now() - base.startedAt
            : null;
      const result = buildAndAppend({
        ...base,
        ...input,
        id,
        at,
        phase: 'end',
        action: normalizeAction(input.action ?? base.action),
        durationMs,
      });
      return {
        ok: result.ok === true,
        id,
        at,
        // 失败响应用的脱敏投影（HTTP 出口据此回 failureId + failure，不再重写一份）。
        row: result.ok === true && result.record !== null ? exportRowOf(result.record) : null,
      };
    },
    /**
     * 记一行独立 end（B 级动作的失败/取消；没有 start 配对）。
     * @param {object} input {action, trigger?, outcome?, code?, message?, sessionId?, context?, durationMs?}
     * @returns {{ok:boolean, id:string|null, at:string}}
     */
    record(input = {}) {
      const now = new Date();
      const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : newEventId(now);
      const at = typeof input.at === 'string' && input.at.length > 0 ? input.at : localIso(now);
      try {
        const record = buildEventRecord({
          ...input,
          id,
          at,
          phase: 'end',
          outcome: input.outcome ?? 'fail',
          action: normalizeAction(input.action),
          version,
          home,
        });
        if (record === null) return { ok: false, id, at, row: null };
        const result = appendEventRecord(record, file, { maxRows, maxBytes });
        return { ok: result.ok === true, id, at, row: result.ok === true ? exportRowOf(record) : null };
      } catch {
        return { ok: false, id, at, row: null };
      }
    },
    /**
     * 读投影行（默认折叠 start/end；`raw:true` 返回原始行）。
     * @param {{last?:number, action?:string, outcome?:string, sessionId?:string, since?:number,
     *   raw?:boolean, now?:number}} [query]
     */
    rows({ raw = false, now, ...query } = {}) {
      try {
        const records = readEventsFile(file, { maxRows: Number.MAX_SAFE_INTEGER });
        if (raw === true) return filterEvents(records, query);
        return collapseEvents(filterEvents(records, query), now === undefined ? {} : { now });
      } catch {
        return [];
      }
    },
    /**
     * 最近失败（读侧投影）：fail/cancelled/stalled，排除 busy/changed 这类正常状态；
     * 外发脱敏（`exportRowOf`），按时间顺序（旧 → 新），最多 limit 条。
     * @param {number} [limit]
     * @returns {object[]}
     */
    recentFailures(limit = 10) {
      try {
        const cap = Number.isInteger(limit) && limit > 0 ? limit : 10;
        const rows = collapseEvents(readEventsFile(file, { maxRows: Number.MAX_SAFE_INTEGER })).filter((row) => {
          if (!isFailureRow(row)) return false;
          return shouldRecordFailure({
            code: row.code ?? undefined,
            cancelled: row.outcome === 'cancelled',
          });
        });
        return rows.slice(-cap).map((row) => exportRowOf(row));
      } catch {
        return [];
      }
    },
    /** 最近动作（外发脱敏；旧 → 新，最多 limit 条）。 */
    recentActions(limit = 20) {
      try {
        const cap = Number.isInteger(limit) && limit > 0 ? limit : 20;
        return collapseEvents(readEventsFile(file, { maxRows: Number.MAX_SAFE_INTEGER }))
          .slice(-cap)
          .map((row) => exportRowOf(row));
      } catch {
        return [];
      }
    },
    /** 文件状态（CLI `state`/`export`、端点 `events` 块用）。 */
    status() {
      try {
        const stat = eventLogOf(file, { maxRows, maxBytes }).status();
        const records = readEventsFile(file, { maxRows: Number.MAX_SAFE_INTEGER });
        const last = records.length === 0 ? null : records[records.length - 1];
        return {
          file,
          filePath: file,
          exists: stat.exists,
          size: stat.size,
          rows: records.length,
          lastAt: last !== null && typeof last.at === 'string' ? last.at : null,
          writeable: stat.writeable,
        };
      } catch {
        return { file, filePath: file, exists: false, size: 0, rows: 0, lastAt: null, writeable: false };
      }
    },
  };
}

function safeHome() {
  try {
    return os.homedir();
  } catch {
    return undefined;
  }
}

/** 读侧行投影（CLI `--json` 单行）—— re-export 方便 CLI 只 import dsh 层。 */
export { eventRowOf, exportRowOf };
