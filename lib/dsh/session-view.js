/**
 * 只读的 session 视图 —— 把 Session 的访问面收在一处。
 *
 * 事务层（compact-transaction）不直接翻 session 内部结构，
 * 都从这里拿；M2 的 checkpoint 定位、压缩判断记录也在这里。
 */
import { latestCompressHint } from '../core/compress-hint.js';
import { latestPinnedSeqs } from '../core/pins.js';
import { scanCompactionLog } from './compaction-pair.js';

/**
 * 0.4 BUG-013：checkpoint 判定的默认实现（漏传第二个参数时也不再静默失效）。
 *
 * 背景：0.3.1 起 `lastCheckpointSurfaceIdx/Seq` 的第二个参数 `isCheckpointSource`
 * 在部分调用点（如 actions/state.js）被漏传。`isCheckpointSource(source)` 对
 * undefined 会抛 TypeError，而函数内 try/catch 把它吞成「不是 checkpoint」→ 永远
 * 返回 -1 → `compressHint` 永远算「有效」（压缩/交接后旧断点不消失、还会抑制 cue）。
 *
 * 这里给默认值补上 engine 的实现（dsh→dsh 同层，不产生环；engine 不 import 本文件）。
 * 但 engine 是全插件唯一 import `@deepseek-ai/*` 的模块：纯 node 单测
 * （test/smoke.mjs / state-passive.mjs / handoff.mjs）不注册包解析钩子、加载不了
 * 这些包。所以用受保护的动态 import 取默认实现：
 *   - 宿主环境：正常拿到 engine.isCompactCheckpointSource；
 *   - 纯 node 单测：加载失败则保持 null（函数里显式传入的 fake engine 照常优先）。
 */
let defaultIsCheckpointSource = null;
try {
  const loaded = await import('./engine.js');
  const candidate = loaded?.default?.isCompactCheckpointSource;
  if (typeof candidate === 'function') defaultIsCheckpointSource = candidate;
} catch {
  defaultIsCheckpointSource = null;
}

/** @returns {number[]} 当前 surface 的 event seq（升序） */
export function surfaceSeqs(session) {
  const nodes = session?.surface?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

/** 会话事件日志（公开字段；缺失时返回 []）。 */
export function sessionLog(session) {
  if (Array.isArray(session?.log)) return session.log;
  if (typeof session?.events === 'function') {
    try {
      const events = session.events();
      if (Array.isArray(events)) return events;
    } catch {
      /* ignore */
    }
  }
  return [];
}

/**
 * 第一个允许进入压缩范围的下标：surface 头是 system/message 时跳过它。
 * @returns {number}
 */
export function firstCompactableIdx(session) {
  const seqs = surfaceSeqs(session);
  if (seqs.length === 0) return 0;
  const head = typeof session.eventAt === 'function' ? session.eventAt(seqs[0]) : undefined;
  return head !== undefined && head.type === 'system/message' ? 1 : 0;
}

/**
 * 已提交的压缩份数（A6 最小口径 / P2-3）。
 *
 * 以前数所有 compaction/summary，事务在 summary 之后失败会留下「幽灵摘要」，
 * 把 advice 提前推到交接、6 次后提前打开合并旧摘要模式。
 * 现在按 compactionId 配对：summary + 无 error 的 end + 覆盖该 summary 的 replace 才算一次；
 * 没有 compactionId 的旧日志（或外部夹具）按旧口径计数，保证兼容。
 */
export function countSummaries(session) {
  // 配对扫描（summary/end/replace）与 dsh/compaction-log 共用，口径见 compaction-pair.js。
  const { summaries, ends, replaceByCoveredSeq } = scanCompactionLog(sessionLog(session));
  let count = 0;
  for (const summary of summaries) {
    const id = summary.data?.compactionId;
    if (typeof id !== 'string') {
      count += 1;
      continue;
    }
    const end = ends.get(id);
    if (end === undefined || end.error !== undefined) continue;
    if (!replaceByCoveredSeq.has(summary.seq)) continue;
    count += 1;
  }
  return count;
}

/**
 * 最后一次 checkpoint 消息在 surface 中的下标；没有返回 -1。
 * @param {object} session
 * @param {(source: unknown) => boolean} [isCheckpointSource] 省略时用 engine.isCompactCheckpointSource
 * @returns {number}
 */
export function lastCheckpointSurfaceIdx(session, isCheckpointSource = defaultIsCheckpointSource) {
  // 既没显式传、默认实现也没加载到（纯 node 单测）：按「没有 checkpoint」处理，
  // 不再让 TypeError 在循环里被静默吞掉。
  if (typeof isCheckpointSource !== 'function') return -1;
  const seqs = surfaceSeqs(session);
  for (let index = seqs.length - 1; index >= 0; index -= 1) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seqs[index]) : undefined;
    if (event === undefined) continue;
    // 只有 user/message 才可能带 source；DSH 的 isCompactCheckpointSource 不防空
    // （source.kind 直接取），对非 user 节点或无 source 的消息传 undefined 会抛。
    if (event.type !== 'user/message') continue;
    const source = event.data?.source;
    if (source === undefined || source === null) continue;
    let hit = false;
    try {
      hit = isCheckpointSource(source) === true;
    } catch {
      hit = false;
    }
    if (hit) return index;
  }
  return -1;
}

/**
 * 最近一次「这里适合压缩」的判断（0.3.1）：读会话日志里的 plugin record；没有返回 null。
 * @param {object} session
 * @returns {{ratio:number, at:number, seq:number}|null}
 */
export function compressHint(session) {
  return latestCompressHint(sessionLog(session));
}

/**
 * 当前 surface 上仍然有效的钉住 seq（去掉已被原生压缩/历史变化带走的过期快照）。
 * 仅供展示与提示用；选段裁剪只关心「范围内」的成员，用 latestPinnedSeqs 也不会错。
 * @param {object} session
 * @returns {number[]}
 */
export function livePinnedSeqs(session) {
  const live = new Set(surfaceSeqs(session));
  return latestPinnedSeqs(sessionLog(session)).filter((seq) => live.has(seq));
}

/**
 * 最后一次 checkpoint 消息在 surface 中的 event seq；没有返回 undefined。
 *
 * 选段要用 seq 而不是「下标之后」：DSH 的 replace 是把 checkpoint 插到被替换区间
 * 的位置上，而压缩保留的「近期尾部」是**旧消息**，它们会排在 checkpoint 后面。
 * 按下标切会把这段旧尾部又压一遍（2026-10-19 真机踩过：33 条旧消息被误压）。
 *
 * @param {object} session
 * @param {(source: unknown) => boolean} [isCheckpointSource] 省略时用 engine.isCompactCheckpointSource
 * @returns {number|undefined}
 */
export function lastCheckpointSurfaceSeq(session, isCheckpointSource = defaultIsCheckpointSource) {
  const index = lastCheckpointSurfaceIdx(session, isCheckpointSource);
  if (index < 0) return undefined;
  return surfaceSeqs(session)[index];
}

/**
 * 当前会话的「是否存在未闭合 turn / 未完成压缩」状态。
 * 与 DSH compaction 的锁语义保持一致：一个未配对的 compaction/start 会挡住后续压缩。
 * @returns {{openTurn: boolean, lockActive: boolean, unmatchedStartSeq: number|null}}
 */
export function entryState(session) {
  const events = sessionLog(session);
  let openTurn = false;
  let openTurnKnown = false;
  let unmatchedStartSeq = null;
  let compactionKnown = false;
  let latestSeedSeq = null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (latestSeedSeq === null && event.type === 'session/end-seed') latestSeedSeq = event.seq;
    if (!compactionKnown) {
      if (event.type === 'compaction/start') {
        unmatchedStartSeq = event.seq ?? null;
        compactionKnown = true;
      } else if (event.type === 'compaction/end') {
        compactionKnown = true;
      }
    }
    if (!openTurnKnown) {
      if (event.type === 'turn/start') {
        openTurn = true;
        openTurnKnown = true;
      } else if (event.type === 'turn/end') {
        openTurnKnown = true;
      }
    }
    if (openTurnKnown && compactionKnown && latestSeedSeq !== null) break;
  }

  const lockActive =
    unmatchedStartSeq !== null && !(latestSeedSeq !== null && latestSeedSeq > unmatchedStartSeq);
  return { openTurn, lockActive, unmatchedStartSeq };
}

/**
 * 从 agent 注册表里挑一个：优先指定 sessionId，否则取最后一个。
 *
 * 0.2 的 `ctx.agents` 只有 `get(id)` 和 `list()`；0.1 时代是 `values()`。
 * 两个都认，避免「HTTP 端点永远拿不到活动会话」这种静默失败（M3 实测踩过）。
 * @param {object} ctx
 * @param {string} [sessionId]
 * @returns {object|null}
 */
export function pickAgent(ctx, sessionId) {
  const agents = ctx?.agents;
  if (agents === undefined || agents === null) return null;

  // 指定了 sessionId 就只认这个会话的 agent：绝不回退到「最后一个 agent」。
  // 2026-10-19 真机踩过：会话刚打开、agent 还没建时，指示灯/HTTP 动作会拿到
  // 别的会话的 agent，于是数字属于另一个会话（重启后「数字不对」的直接原因）。
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    if (typeof agents.get === 'function') {
      const hit = agents.get(sessionId);
      if (hit) return hit;
    }
    if (typeof agents.list === 'function') {
      const all = agents.list();
      if (Array.isArray(all)) {
        const hit = all.find(
          (candidate) => candidate?.id === sessionId || candidate?.session?.id === sessionId,
        );
        if (hit) return hit;
      }
    }
    return null;
  }

  // 没指定 sessionId（HTTP 调试/无会话场景）：保持旧行为，取最后一个 agent。
  let all = [];
  if (typeof agents.list === 'function') all = agents.list();
  else if (typeof agents.values === 'function') all = [...agents.values()];
  if (!Array.isArray(all)) all = [];
  return all.length > 0 ? all[all.length - 1] : null;
}

/**
 * 会话已经加载进内存、但还没有 agent 时，直接拿 live session（M5 修复重启后数字为空的坑）。
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {object|undefined}
 */
export function liveSessionOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  const sessions = ctx?.sessions;
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined;
  try {
    return sessions.get(sessionId);
  } catch {
    return undefined;
  }
}
