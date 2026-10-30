/**
 * 压缩归属动作层（0.5.6 Phase D1）。
 *
 * 两件事，都不改历史、不建第二份 JSONL：
 *   1. `readAttribution` —— 只读事件流的投影（端点 / 诊断共用）；
 *   2. `recordCompactionObservation` —— 给「不走 withActionEvent 的压缩入口」
 *      （交接前置压缩 / `/bctest`）补一行 `action:'compact'` 的归属行（end-only）。
 *
 * 正常菜单/命令压缩走 betterCompact 的 withActionEvent，start/end 两行已含归属字段，
 * 不要再调 recordCompactionObservation（否则同一 id 双写，投影虽会折叠，但文件会脏）。
 */
import {
  ATTRIBUTION_LIMIT_DEFAULT,
  ATTRIBUTION_LIMIT_MAX,
  attributionOfEvents,
} from '../core/attribution.js';
import { sessionIdOf } from './evented.js';

/**
 * 最近 N 次压缩归属（只读本机事件文件；不要求活会话）。
 *
 * @param {{events?:object}} deps
 * @param {{sessionId?:string, limit?:number}} [options]
 * @returns {{ok:boolean, attribution:object[], total:number}}
 */
export function readAttribution(deps, { sessionId, limit = ATTRIBUTION_LIMIT_DEFAULT } = {}) {
  try {
    const store = deps?.events;
    if (store === null || store === undefined || typeof store !== 'object') {
      return { ok: true, attribution: [], total: 0 };
    }
    const all =
      typeof store.compactions === 'function'
        ? store.compactions({ limit: null, sessionId })
        : typeof store.rows === 'function'
          ? attributionOfEvents(store.rows({ raw: true, action: 'compact' }), { limit: null, sessionId })
          : [];
    const cap =
      Number.isInteger(limit) && limit > 0
        ? Math.min(limit, ATTRIBUTION_LIMIT_MAX)
        : ATTRIBUTION_LIMIT_DEFAULT;
    return { ok: true, attribution: all.slice(0, cap), total: all.length };
  } catch {
    return { ok: true, attribution: [], total: 0 };
  }
}

/**
 * 给一次已完成的压缩补一行归属事件（end-only）。
 *
 * @param {{events?:object}} deps
 * @param {object} input
 * @param {object} input.agent 活 agent（取 sessionId）
 * @param {object} input.outcome `runCompaction` / `betterCompactLocked` 的返回
 * @param {string} [input.trigger] 归属口径（省略 = unknown）
 * @param {number} [input.summaries] 压前摘要份数（不知道就不传）
 * @param {boolean} [input.merged] 本次是否合并了旧摘要（不知道就不传）
 * @returns {{ok:boolean}|null}
 */
export function recordCompactionObservation(deps, { agent, outcome, trigger = 'unknown', summaries, merged } = {}) {
  try {
    const store = deps?.events;
    if (store === null || store === undefined || typeof store.record !== 'function') return null;
    if (outcome === null || typeof outcome !== 'object') return null;
    const compactionId = typeof outcome.compactionId === 'string' ? outcome.compactionId : null;
    if (compactionId === null) return null;
    const context = {
      ...(Array.isArray(outcome.shadowedSeqs) ? { nodes: outcome.shadowedSeqs.length } : {}),
      ...(Number.isFinite(outcome.startSeq) ? { startSeq: outcome.startSeq } : {}),
      ...(Number.isFinite(outcome.endSeq) ? { endSeq: outcome.endSeq } : {}),
      ...(Number.isFinite(outcome.shadowedTokenCount) ? { shadowedTokens: outcome.shadowedTokenCount } : {}),
      ...(Number.isFinite(summaries) ? { summaries } : {}),
      ...(typeof merged === 'boolean' ? { allowMergeOldSummaries: merged, merged } : {}),
      ...(typeof outcome.model === 'string' && outcome.model.length > 0 ? { model: outcome.model } : {}),
      ...(Number.isFinite(outcome.pinnedKept) ? { pinnedKept: outcome.pinnedKept } : {}),
    };
    return store.record({
      action: 'compact',
      trigger,
      sessionId: sessionIdOf(agent),
      compactionId,
      outcome: 'ok',
      durationMs: Number.isFinite(outcome.durationMs) ? outcome.durationMs : null,
      context: Object.keys(context).length === 0 ? undefined : context,
    });
  } catch {
    return null; // 归属记录失败绝不影响压缩/交接结果
  }
}
