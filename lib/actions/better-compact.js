/**
 * 压缩旧会话（/bc，内部代号「精压」/BC）—— 唯一实现（M2 正式版 / M6 预览 + 确认 + 取消）。
 *
 * 不再包装原生 compactNow，走自建事务：
 *   选段（跳过旧摘要 = 不二压）→ 摘要（结构化 prompt）→ 替换历史。
 *
 * 泄压阀：摘要份数到 thresholds.maxSummaries 后，选段不再受「最后 checkpoint 之后」
 * 约束（core/policy.compactionPolicy → dsh/select-range 的 afterSeq=undefined），
 * 旧摘要会被新摘要一并覆盖（合并），防止摘要无限堆积。
 *
 * M6 起分三步走：
 *   1. previewBetterCompact —— 只算「能压多少」，不写任何东西（/bc 与菜单先走它）；
 *   2. betterCompact —— 真正执行（/bc confirm 或确认卡按钮）；
 *   3. cancelBetterCompact —— 执行中取消（HTTP cancel → deps.inflight 里的 AbortController）。
 * 预览与执行共用 planCompact，保证两边口径一致。
 */
import { createHash } from 'node:crypto';
import { actionError } from '../core/errors.js';
import { livePinnedSeqs } from '../dsh/session-view.js';
import { compactionPolicy } from '../core/policy.js';
import { SUMMARY_INSTRUCTION } from '../core/prompts.js';
import { selectCompactableRange } from '../dsh/select-range.js';
import { replaceRangeWithSummary } from '../dsh/compact-transaction.js';
import { runIdle } from '../dsh/idle.js';
import { measurePressure } from '../dsh/pressure.js';
import { countSummaries } from '../dsh/session-view.js';
import { summarize } from '../dsh/summarizer.js';
import { withLock } from './lock.js';

/** 范围小于这个 token 数时，摘要大概率比原文大：预览阶段就提示、前端据此禁用确认（0.3.1）。 */
const MIN_MEANINGFUL_TOKENS = 800;

/** 容量数字的紧凑写法（与浏览器半 `20-format.js` 的 fmt 保持同一口径）。 */
function fmtTokens(tokens) {
  if (!Number.isFinite(tokens)) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

/**
 * 预览计划缓存（架构 A3）。
 *
 * 「用户看到的范围」与「点确认后实际压的范围」必须是同一份数据：
 * preview 记下 planId + 范围，confirm 带 planId 回来；宿主重算发现不一致就拒绝。
 * 按会话存，5 分钟过期；`/bc confirm` 从这里取（HTTP 客户端则显式带 expected）。
 */
const PREVIEW_TTL_MS = 5 * 60_000;
const previewPlans = new Map();

function planIdOf(range) {
  return createHash('sha256')
    .update(`${range.startSeq}:${range.endSeq}:${range.shadowedSeqs.join(',')}`)
    .digest('hex')
    .slice(0, 16);
}

function rememberPreviewPlan(sessionId, plan) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;
  previewPlans.set(sessionId, { ...plan, expiresAt: Date.now() + PREVIEW_TTL_MS });
}

/**
 * 取出并消费一次预览计划；过期/不存在返回 null。
 * @param {string|undefined} sessionId
 * @returns {{planId:string,startSeq:number,endSeq:number,shadowedSeqs:number[]}|null}
 */
export function takePreviewPlan(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const entry = previewPlans.get(sessionId);
  if (entry === undefined) return null;
  if (entry.expiresAt < Date.now()) {
    previewPlans.delete(sessionId);
    return null;
  }
  return {
    planId: entry.planId,
    startSeq: entry.startSeq,
    endSeq: entry.endSeq,
    shadowedSeqs: [...entry.shadowedSeqs],
  };
}

/** 测试用：清空预览缓存。 */
export function clearPreviewPlans() {
  previewPlans.clear();
}

function shadowedTokensOf(nodes, shadowedSeqs) {
  const wanted = new Set(shadowedSeqs);
  return nodes
    .filter((node) => wanted.has(node.seq))
    .reduce((sum, node) => sum + (node.heuristicTokens ?? node.tokens ?? 0), 0);
}

/**
 * 算一遍「这次能压什么」—— 预览与正式执行共用，保证两边口径一致。
 * @param {{ctx:object, cfg:object, engine:object}} deps
 * @param {object} agent
 */
async function planCompact(deps, agent) {
  const measured = await measurePressure(deps.ctx, agent, { windowFallback: deps.cfg.contextWindowFallback });
  const nodes = measured.nodes.filter((node) => Number.isInteger(node?.seq));

  const summaries = countSummaries(agent.session);
  const { allowMergeOldSummaries } = compactionPolicy({ summaries, thresholds: deps.cfg.thresholds });
  // 只把「当前 surface 上还在」的钉住消息算进去：过期 seq 不该再劝用户 /unpin。
  const pinned = livePinnedSeqs(agent.session);

  const range = selectCompactableRange({
    session: agent.session,
    nodes,
    engine: deps.engine,
    cfg: deps.cfg,
    tokenOf: (node) => node.heuristicTokens ?? node.tokens ?? 0,
  });

  return { measured, nodes, summaries, allowMergeOldSummaries, range, pinned, planId: range === null ? null : planIdOf(range) };
}

/**
 * 没有可压范围时给用户的解释——被钉住挡住时要指出来，否则用户不知道去 /unpin。
 * @param {number[]|undefined} pinned
 */
function noRangeMessage(pinned) {
  return pinned !== undefined && pinned.length > 0
    ? `暂无可压缩内容：有 ${pinned.length} 条消息被「锁定」保护，请先解锁再试（/unpin）。`
    : '暂无可压缩内容（当前会话太短，或近期会话需保留原文）。';
}

/**
 * 压缩本体（不加锁、不登记）—— 交接要先压缩旧会话，复用这一份实现，不要各写一遍。
 * @param {{ctx:object, cfg:object, lock:object, engine:object}} deps
 * @param {{agent:object, signal?:AbortSignal, commandId?:string}} input
 */
export async function betterCompactLocked(deps, { agent, signal, commandId, expected }) {
  if (agent === undefined || agent === null) throw actionError('nosession', '没有活动会话');
  const session = agent.session;

  const plan = await planCompact(deps, agent);
  const { nodes, allowMergeOldSummaries, summaries, range, pinned, planId } = plan;

  // 架构 A3：确认必须绑定同一段范围。重算后发现不是用户看过的那一段 → 拒绝，不写任何东西。
  if (range !== null && expected !== undefined && expected !== null) {
    if (typeof expected !== 'object' || typeof expected.planId !== 'string' || expected.planId !== planId) {
      throw actionError('changed', '会话在确认期间又更新了，压缩范围已变；请重新预览后再确认。');
    }
  }

  if (range === null) {
    return {
      ok: true,
      compacted: false,
      planId: null,
      message: noRangeMessage(pinned),
    };
  }

  const freshRange = { ...range, shadowedTokenCount: shadowedTokensOf(nodes, range.shadowedSeqs) };
  const flush =
    typeof deps.ctx.sessions?.flush === 'function' ? () => deps.ctx.sessions.flush(session) : undefined;
  const estimateMessage =
    typeof deps.ctx?.tokenMeter?.estimateMessage === 'function'
      ? (message) => deps.ctx.tokenMeter.estimateMessage(message)
      : undefined;

  const outcome = await runIdle(agent, (idleSignal) => {
    const combined = signal === undefined ? idleSignal : AbortSignal.any([signal, idleSignal]);
    return replaceRangeWithSummary({
      session,
      range: freshRange,
      engine: deps.engine,
      signal: combined,
      sourceCommandId: commandId,
      estimateMessage,
      summarize: ({ shadowedSeqs, signal: innerSignal }) =>
        summarize({
          ctx: deps.ctx,
          engine: deps.engine,
          agent,
          shadowedSeqs,
          endSeq: freshRange.endSeq,
          instruction: SUMMARY_INSTRUCTION,
          maxTokens: deps.cfg.summary.maxTokens,
          inputTokens: plan.measured.tokens,
          timeoutMs: deps.cfg.timeouts?.llmMs,
          signal: innerSignal,
        }),
      flush,
    });
  });

  const note = allowMergeOldSummaries
    ? '，同时合并了旧摘要'
    : summaries > 0
      ? '，旧摘要保持原样'
      : '';
  const pinNote = range.pinnedCut === true ? `，已跳过 ${range.pinnedKept} 条锁定的消息` : '';
  return {
    ok: true,
    compacted: true,
    // A3/A5：把被批准的范围 id 带出动作层（交接链记录/0.4 diff 可引用）。
    planId,
    ...outcome,
    message: `压缩完成：${outcome.shadowedSeqs.length} 条旧会话 → 1 条摘要（腾出约 ${outcome.shadowedTokenCount} 容量${note}${pinNote}）。`,
  };
}

/**
 * 压缩预览：只算范围与 token，不写会话日志。
 * @param {{ctx:object, cfg:object, lock:object, engine:object}} deps
 * @param {{agent:object}} input
 */
export async function previewBetterCompact(deps, { agent } = {}) {
  if (agent === undefined || agent === null) throw actionError('nosession', '没有活动会话');
  if (typeof deps.lock?.isBusy === 'function' && deps.lock.isBusy(agent.id)) {
    throw actionError('busy', '当前会话正在压缩或交接，请等完成后再预览');
  }

  const { nodes, range, pinned, planId } = await planCompact(deps, agent);
  if (range === null) {
    return {
      ok: true,
      compacted: false,
      preview: null,
      message: noRangeMessage(pinned),
    };
  }

  const shadowedTokenCount = shadowedTokensOf(nodes, range.shadowedSeqs);
  rememberPreviewPlan(agent.id, {
    planId,
    startSeq: range.startSeq,
    endSeq: range.endSeq,
    shadowedSeqs: range.shadowedSeqs,
  });
  // 0.3.1：小范围压缩大概率「摘要比原文还大」被拒，预览阶段就提示并让前端禁用确认。
  const tooSmall = shadowedTokenCount < MIN_MEANINGFUL_TOKENS;
  return {
    ok: true,
    compacted: false,
    planId,
    preview: {
      nodes: range.shadowedSeqs.length,
      tokens: shadowedTokenCount,
      startSeq: range.startSeq,
      endSeq: range.endSeq,
      planId,
      tooSmall,
      ...(range.pinnedCut === true ? { pinnedKept: range.pinnedKept } : {}),
    },
    message:
      `压缩预估：将把 ${range.shadowedSeqs.length} 条旧会话压成 1 条摘要` +
      `（腾出约 ${fmtTokens(shadowedTokenCount)} tokens${range.pinnedCut === true ? `，已跳过 ${range.pinnedKept} 条锁定的消息` : ''}）。` +
      (tooSmall
        ? `这段偏小，压了可能反而更大；建议再聊几轮或把「保留近期原文」调小后再压缩。`
        : '只估算范围和容量，摘要内容确认后才生成。') +
      (tooSmall ? '' : '确认执行：/bc confirm'),
  };
}

/**
 * 请求取消正在跑的压缩。
 * @param {{inflight?:object}} deps
 * @param {{agent?:object}} [input]
 */
export function cancelBetterCompact(deps, { agent } = {}) {
  const kind = deps.inflight?.kindOf?.(agent?.id) ?? null;
  const found =
    deps.inflight !== undefined &&
    typeof deps.inflight.cancel === 'function' &&
    deps.inflight.cancel(agent?.id);
  return found
    ? {
        ok: true,
        cancelled: true,
        kind,
        message:
          kind === 'handoff'
            ? '已请求取消交接（已完成的压缩不会回滚）。'
            : '已请求取消压缩（会话记录不会改动）。',
      }
    : { ok: false, cancelled: false, kind: null, message: '当前没有正在进行的压缩/交接任务。' };
}

function combinedSignal(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return AbortSignal.any([a, b]);
}

/**
 * 压缩动作入口：带每会话单飞锁 + 可取消登记。
 * @param {{ctx:object, cfg:object, lock:object, engine:object, inflight?:object}} deps
 * @param {{agent:object, signal?:AbortSignal, commandId?:string}} input
 */
export async function betterCompact(deps, input) {
  if (input?.agent === undefined || input?.agent === null) throw actionError('nosession', '没有活动会话');
  const agent = input.agent;
  const controller =
    deps.inflight !== undefined && typeof deps.inflight.begin === 'function'
      ? deps.inflight.begin(agent.id, 'compact')
      : null;
  const signal = combinedSignal(controller?.signal, input.signal);

  try {
    return await withLock(deps.lock, agent.id, () => betterCompactLocked(deps, { ...input, signal }));
  } catch (error) {
    // 取消 → 统一成 cancelled 文案（宿主 HTTP 层据此回「历史没改」）。
    // P2-1：commit/persistence 表示历史可能已改或落盘状态不明，绝不能谎报「历史没改」。
    if (
      signal !== undefined &&
      signal.aborted &&
      error?.code !== 'cancelled' &&
      error?.code !== 'commit' &&
      error?.code !== 'persistence'
    ) {
      throw actionError('cancelled', '已取消，会话记录没有改动。', error);
    }
    throw error;
  } finally {
    if (controller !== null && typeof deps.inflight.finish === 'function') {
      deps.inflight.finish(agent.id, controller);
    }
  }
}
