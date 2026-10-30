/**
 * 压缩旁路归属（0.5.6 Phase D1）—— 监听 `session/event`，把**不是我们发起**的
 * `compaction/*` 事件归成一行 `action:'compact'` 的事件（写进同一事件流）。
 *
 * 为什么需要它：`compaction/start` 的 `data` 只有 `{compactionId, sourceCommandId?, turn}`。
 *   - `turn` 是**数字** ⇒ DSH 自动/显式范围路径（native-auto）；
 *   - `turn === null` 且有 `sourceCommandId` ⇒ 外部命令（内置 /compact 等）；
 *   - 都没有 ⇒ **unknown**（绝不猜成 native-auto —— 10-29 两次误判就错在这条）。
 *
 * 红线：
 *   1. 只写 `deps.events.record`（`lib/dsh/events.js` 是唯一文件写入点），不建第二份 JSONL；
 *   2. 我们自己发起的压缩（`runCompaction` 提前 mint id 并 claim）**一律跳过**——
 *      归属行由动作层的事件行负责，旁路不重复记账；
 *   3. 任何异常静默吞掉，绝不影响宿主动作。
 */
import { classifyForeignCompaction } from '../core/attribution.js';

/** 正在执行的「我们的」compactionId（进程内；runCompaction 在事务前 claim、finally release）。 */
const ownCompactions = new Set();

/** 登记一个由我们发起的压缩 id（旁路监听器据此跳过）。 */
export function claimCompactionId(compactionId) {
  if (typeof compactionId === 'string' && compactionId.length > 0) ownCompactions.add(compactionId);
}

/** 释放登记（事务结束后调用；即使失败也要释放，避免集合无限增长）。 */
export function releaseCompactionId(compactionId) {
  ownCompactions.delete(compactionId);
}

/** 这个 id 是不是我们发起的。 */
export function isOwnCompactionId(compactionId) {
  return ownCompactions.has(compactionId);
}

/** 等待收尾的压缩上限（防事件风暴撑内存）。 */
const PENDING_MAX = 256;
/** command/run 缓存上限（sourceCommandId → 命令名）。 */
const COMMAND_MAX = 50;

function stringOrNull(value, max = 160) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function intOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

/** 从 `compaction/summary` 的 data 取范围/模型（字段名与 DSH 0.2.x 一致）。 */
function summaryInfoOf(data) {
  if (data === null || typeof data !== 'object') return null;
  const range = data.shadowedRange !== null && typeof data.shadowedRange === 'object' ? data.shadowedRange : null;
  return {
    count: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null,
    tokens: intOrNull(data.shadowedTokenCount),
    startSeq: intOrNull(range?.start),
    endSeq: intOrNull(range?.end),
    model: stringOrNull(data.model, 80),
  };
}

/**
 * 从会话日志回扫一次（插件晚加载/重启后只收到 end 的情况）。
 * 只扫最后 500 条，拿不到就按 unknown 收尾（不猜）。
 */
function rebuildFromLog(session, compactionId) {
  const log = Array.isArray(session?.log) ? session.log : [];
  const start = log.length > 500 ? log.slice(-500) : log;
  const entry = { turn: null, sourceCommandId: null, startedAt: null, summary: null };
  for (const event of start) {
    if (event?.data?.compactionId !== compactionId) continue;
    if (event.type === 'compaction/start') {
      entry.turn = typeof event.data.turn === 'number' ? event.data.turn : null;
      entry.sourceCommandId = stringOrNull(event.data.sourceCommandId);
      entry.startedAt = typeof event.time === 'number' ? event.time : null;
    } else if (event.type === 'compaction/summary') {
      entry.summary = summaryInfoOf(event.data);
    }
  }
  return entry;
}

/**
 * @param {{events?:object, log?:object}} deps
 * @returns {{onEvent:(session:object, event:object)=>void, close:()=>void}}
 */
export function createAttributionWatcher(deps = {}) {
  /** @type {Map<string, object>} compactionId → 进行中的观察 */
  const pending = new Map();
  /** @type {Set<string>} 已写过归属行的 compactionId（同一 id 永不重复记） */
  const recorded = new Set();
  /** @type {Map<string,string>} sourceCommandId → command name */
  const commands = new Map();
  let closed = false;

  function rememberCommand(commandId, name) {
    if (typeof commandId !== 'string' || commandId.length === 0) return;
    commands.set(commandId, typeof name === 'string' ? name : '');
    while (commands.size > COMMAND_MAX) {
      const oldest = commands.keys().next().value;
      commands.delete(oldest);
    }
  }

  /**
   * 这个 id 是否已经有归属行（跨进程/重启/回放去重）。
   * 正常实时路径：我们的 start 事件先到、end 行还没写 → false，靠 claim 跳过；
   * 回放/重启路径：文件里已有同 id 的行 → 不再重复记。
   */
  function alreadyAttributed(compactionId) {
    if (recorded.has(compactionId)) return true;
    try {
      if (typeof deps.events?.compactions === 'function') {
        return deps.events.compactions({ limit: null }).some((row) => row.compactionId === compactionId);
      }
    } catch {
      /* 读不到就当没有；claim 仍然兜住我们自己的实时路径 */
    }
    return false;
  }

  function startOf(session, event) {
    const data = event?.data;
    const compactionId = stringOrNull(data?.compactionId, 80);
    if (compactionId === null) return;
    if (isOwnCompactionId(compactionId) || alreadyAttributed(compactionId)) {
      // 我们的压缩：动作层已经会写归属行（带完整上下文），旁路不重复记。
      pending.delete(compactionId);
      return;
    }
    pending.set(compactionId, {
      sessionId: stringOrNull(session?.id),
      startedAt: typeof event.time === 'number' ? event.time : Date.now(),
      turn: typeof data.turn === 'number' ? data.turn : null,
      sourceCommandId: stringOrNull(data.sourceCommandId),
      summary: null,
    });
    while (pending.size > PENDING_MAX) {
      const oldest = pending.keys().next().value;
      pending.delete(oldest);
    }
  }

  function summaryOf(session, event) {
    const compactionId = stringOrNull(event?.data?.compactionId, 80);
    if (compactionId === null) return;
    const entry = pending.get(compactionId);
    if (entry === undefined) return;
    entry.summary = summaryInfoOf(event.data);
    entry.sessionId = entry.sessionId ?? stringOrNull(session?.id);
  }

  function endOf(session, event) {
    const compactionId = stringOrNull(event?.data?.compactionId, 80);
    if (compactionId === null) return;
    if (isOwnCompactionId(compactionId)) {
      pending.delete(compactionId);
      return;
    }
    if (recorded.has(compactionId)) {
      pending.delete(compactionId);
      return;
    }
    const entry = pending.get(compactionId) ?? rebuildFromLog(session, compactionId);
    pending.delete(compactionId);

    const classification = classifyForeignCompaction({
      turn: entry.turn,
      sourceCommandId: entry.sourceCommandId,
      commandName: commands.get(entry.sourceCommandId),
    });
    const endedAt = typeof event.time === 'number' ? event.time : Date.now();
    const startedAt = typeof entry.startedAt === 'number' ? entry.startedAt : null;
    const error = event.data?.error;
    const failed = error !== null && error !== undefined;
    const summary = entry.summary ?? null;
    const context = {
      ...(summary?.count === null || summary?.count === undefined ? {} : { nodes: summary.count }),
      ...(summary?.tokens === null || summary?.tokens === undefined ? {} : { shadowedTokens: summary.tokens }),
      ...(summary?.startSeq === null || summary?.startSeq === undefined ? {} : { startSeq: summary.startSeq }),
      ...(summary?.endSeq === null || summary?.endSeq === undefined ? {} : { endSeq: summary.endSeq }),
      ...(summary?.model === null || summary?.model === undefined ? {} : { model: summary.model }),
    };

    try {
      deps.events?.record?.({
        action: 'compact',
        trigger: classification.trigger,
        actor: classification.actor,
        sessionId: entry.sessionId ?? stringOrNull(session?.id),
        compactionId,
        outcome: failed ? 'fail' : 'ok',
        code: failed ? 'compaction-error' : null,
        message: failed
          ? typeof error?.message === 'string'
            ? error.message
            : '压缩事务失败'
          : null,
        durationMs: startedAt === null ? null : Math.max(0, endedAt - startedAt),
        context: Object.keys(context).length === 0 ? undefined : context,
      });
      recorded.add(compactionId);
      while (recorded.size > 512) {
        const oldest = recorded.values().next().value;
        recorded.delete(oldest);
      }
    } catch {
      /* 归属记录失败绝不影响宿主 */
    }
  }

  return {
    /**
     * `ctx.on('session/event')` 回调（与 hub / favoriteWatch 同一个挂载点）。
     * @param {object} session
     * @param {object} event
     */
    onEvent(session, event) {
      if (closed) return;
      try {
        switch (event?.type) {
          case 'command/run':
            rememberCommand(event.data?.commandId, event.data?.name);
            return;
          case 'compaction/start':
            startOf(session, event);
            return;
          case 'compaction/summary':
            summaryOf(session, event);
            return;
          case 'compaction/end':
            endOf(session, event);
            return;
          default:
            return;
        }
      } catch {
        /* 任何解析/写盘异常都吞掉：归属只是提示，不能影响宿主动作 */
      }
    },
    close() {
      closed = true;
      pending.clear();
      commands.clear();
      recorded.clear();
    },
  };
}
