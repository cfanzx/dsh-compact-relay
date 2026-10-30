/**
 * 压缩执行流程 —— 正式精压（actions/better-compact.js）与实验动作 /bctest
 * （actions/test-compact.js）共用的那一段「idle 准入 → 替换事务 → 调摘要」。
 *
 * 两个动作的差异只在**怎么选段、用什么摘要指令、要不要六段校验、超时从哪来**；
 * 真正改历史的执行路径必须完全同一条（否则 /bctest 就不是「小范围真事务」了）：
 *   1. 从 deps.ctx 取 flush / tokenMeter.estimateMessage（宿主能力，可选）；
 *   2. runIdle(agent, ...) 里跑事务（手动压缩的 idle 准入 / 与自动压缩互斥）；
 *   3. 用户取消信号与 idle 信号合并；
 *   4. replaceRangeWithSummary：summarize 回放前缀（cache 对齐）+ 替换历史 + 成对 start/end。
 *
 * 超时不在本函数内部读 cfg：由调用方传 `timeoutMs`。正式精压传 cfg.timeouts.llmMs
 * （原有行为），/bctest 不传 → summarize 用 llm-call 的 180s 默认（同样保持原行为）。
 *
 * 以前这 20+ 行在 better-compact.js 与 test-compact.js 里逐字重复（含 summarize
 * 参数的拼装），改一处漏一处就会让 /bctest 与正式压缩行为分叉。
 */
import { randomUUID } from 'node:crypto';
import { replaceRangeWithSummary } from '../dsh/compact-transaction.js';
import { claimCompactionId, releaseCompactionId } from '../dsh/attribution-watch.js';
import { actorOfTrigger } from '../core/attribution.js';
import { attributionLineOf } from '../core/attribution-label.js';
import { normalizeTrigger } from '../core/events.js';
import { errorCodeOf } from '../dsh/diag-counters.js';
import { runIdle } from '../dsh/idle.js';
import { summarize } from '../dsh/summarizer.js';
import { appendFavoriteDirectory, buildFavoriteDirectoryLines, buildFavoriteTitle } from '../core/favorites.js';
import { appendSnapshotEntries, favoriteMapOf, snapshotFileOf } from '../dsh/favorites-file.js';
import { eventTextOf } from './favorite.js';
import { roleLabelOf } from '../core/pin-anchors.js';
import { combinedSignal } from './support.js';

/**
 * 执行一次压缩替换事务（对外入口 = 诊断埋点的唯一采集点）。
 *
 * 0.4 P0-2：只在这里数「压缩成功/失败 / 耗时 / 错误码」——正式精压与 /bctest
 * 走的是同一条执行路径，所以两边的计数器口径天然一致；失败原因只记 code，
 * **不记 message**（message 可能带路径/会话内容）。
 *
 * @param {{ctx:object, cfg:object, engine:object, diag?:object}} deps
 * @param {object} input
 * @param {object} input.agent
 * @param {object} input.session
 * @param {{startSeq:number, endSeq:number, shadowedSeqs:number[], shadowedTokenCount:number}} input.range
 * @param {string} input.instruction 摘要指令（正式版 SUMMARY_INSTRUCTION / 实验版 TEST_INSTRUCTION）
 * @param {string[]} [input.requiredSections] 摘要结构校验的小节；省略=默认六段，[]=不校验（/bctest）
 * @param {AbortSignal} [input.signal]
 * @param {string} [input.commandId]
 * @param {number} [input.inputTokens] 调用前预算预检的输入 token 估算（可选）
 * @param {number} [input.timeoutMs] 单次模型调用超时；**由调用方决定**（省略 = llm-call 的 180s 默认）
 * @param {string} [input.trigger] 归属口径（ui-menu/command/handoff/native-auto/external/unknown；
 *   省略 = 'unknown'，不猜。0.5.6 D1：trigger 由入口登记，旁路监听器只处理不是我们发起的压缩）
 * @param {boolean|null} [input.merged] 0.5.6 D2：本次是否合并了旧摘要（checkpoint 归属行用；
 *   省略/非布尔 = 不知道，行里写「合并情况未知」，绝不猜）
 * @returns {Promise<{compactionId:string, startSeq:number, summarySeq:number, endSeq:number, shadowedSeqs:number[], shadowedTokenCount:number, model:string|null, durationMs:number}>}
 */
export async function runCompaction(deps, input = {}) {
  const startedAt = Date.now();
  const trigger = normalizeTrigger(input.trigger);
  // 0.5.6 D1：**执行前** mint id（E8）。事务、归属事件行、失败错误对象共用同一个主键；
  // 同时 claim 给旁路监听器，避免我们自己的压缩又被旁路记一条。
  const compactionId = randomUUID();
  claimCompactionId(compactionId);
  try {
    const outcome = await runCompactionProcess(deps, { ...input, trigger, compactionId });
    deps.diag?.bumpAction('compact', true);
    return { ...outcome, durationMs: Date.now() - startedAt };
  } catch (error) {
    deps.diag?.bumpAction('compact', false);
    deps.diag?.recordError(errorCodeOf(error), 'compact');
    // 事务内部已经 tag 过一次；这里兜住「进入事务前」的失败（idle 准入/取消等）。
    tagCompactionId(error, compactionId);
    throw error;
  } finally {
    releaseCompactionId(compactionId);
    deps.diag?.recordDuration('compact', Date.now() - startedAt);
  }
}

/** 失败错误对象带上 compactionId（冻结对象等忽略）。 */
function tagCompactionId(error, compactionId) {
  try {
    if (error !== null && typeof error === 'object' && typeof error.compactionId !== 'string') {
      error.compactionId = compactionId;
    }
  } catch {
    /* 冻结对象/原始值：忽略 */
  }
  return error;
}

/**
 * 压缩执行流程本体（跑 idle 事务 → 替换历史 + 调摘要）。
 * @param {{ctx:object, cfg:object, engine:object}} deps
 * @param {object} input 见 runCompaction
 */
async function runCompactionProcess(
  deps,
  { agent, session, range, instruction, requiredSections, signal, commandId, inputTokens, timeoutMs, compactionId, trigger, merged },
) {
  const flush =
    typeof deps.ctx.sessions?.flush === 'function' ? () => deps.ctx.sessions.flush(session) : undefined;
  const estimateMessage =
    typeof deps.ctx?.tokenMeter?.estimateMessage === 'function'
      ? (message) => deps.ctx.tokenMeter.estimateMessage(message)
      : undefined;

  // 0.5.6 D2：checkpoint 摘要头的那一行 —— 用**内存中的归属对象**现拼（不读事件文件），
  // 与归属事件行同一份 trigger/actor/range/merged；失败只丢这一行，绝不影响压缩本体。
  let checkpointAttribution = null;
  try {
    checkpointAttribution = attributionLineOf({
      compactionId,
      trigger,
      actor: actorOfTrigger(trigger),
      range: {
        count: Array.isArray(range.shadowedSeqs) ? range.shadowedSeqs.length : null,
        tokens: range.shadowedTokenCount,
        startSeq: range.startSeq,
        endSeq: range.endSeq,
      },
      merged: typeof merged === 'boolean' ? merged : null,
    });
  } catch {
    checkpointAttribution = null;
  }

  return runIdle(agent, async (idleSignal) => {
    const combined = combinedSignal(signal, idleSignal);
    const result = await replaceRangeWithSummary({
      session,
      range,
      engine: deps.engine,
      signal: combined,
      sourceCommandId: commandId,
      // 0.5.6 D1：id 由执行层提前 mint，事务与归属事件行同源。
      compactionId,
      // 0.5.6 D2：归属行只写不解析；shrink 防护仍量不带归属行的同源包帧。
      checkpointAttribution,
      estimateMessage,
      summarize: async ({ shadowedSeqs, signal: innerSignal }) => {
        const result = await summarize({
          ctx: deps.ctx,
          engine: deps.engine,
          agent,
          shadowedSeqs,
          endSeq: range.endSeq,
          instruction,
          requiredSections,
          maxTokens: deps.cfg.summary.maxTokens,
          inputTokens,
          // 超时由调用方传：正式精压传 cfg.timeouts.llmMs（原行为），/bctest 不传 → 180s 默认。
          timeoutMs,
          signal: innerSignal,
        });
        // 0.6：摘要后追「本段收藏目录」——纯文本后处理，不调模型；失败只丢目录，不阻断压缩。
        try {
          const wanted = new Set(shadowedSeqs);
          const seqs = [...(favoriteMapOf(deps.ctx, session).get(session.id) ?? [])].sort((a, b) => a - b);
          const entries = [];
          for (const seq of seqs) {
            if (!wanted.has(seq)) continue;
            const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
            entries.push({ index: entries.length + 1, role: roleLabelOf(event?.type), title: buildFavoriteTitle(event) });
          }
          return { ...result, summary: appendFavoriteDirectory(result.summary, buildFavoriteDirectoryLines(entries, 20)) };
        } catch {
          return result;
        }
      },
      flush,
    });
    // 0.6：把本段被压掉、且被收藏的消息原文落到压缩快照。
    // 失败只 warn，不影响压缩结果（与「目录注入」同一条红线）。
    writeFavoriteSnapshots(deps, session, range);
    return result;
  });
}

/**
 * 压缩成功后：把「本段被压掉且被收藏」的消息原文追加进快照（按 seq 去重）。
 * @param {{ctx:object, log?:object}} deps
 * @param {object} session
 * @param {{shadowedSeqs:number[]}} range
 */
function writeFavoriteSnapshots(deps, session, range) {
  try {
    const set = favoriteMapOf(deps.ctx, session).get(session.id);
    if (set === undefined || set.size === 0) return;
    const shadowed = new Set(Array.isArray(range.shadowedSeqs) ? range.shadowedSeqs : []);
    const entries = [];
    for (const seq of set) {
      if (!shadowed.has(seq)) continue;
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
      if (event === undefined || event === null) continue;
      const text = eventTextOf(event);
      if (text.length === 0) continue;
      entries.push({ seq, role: roleLabelOf(event.type), title: buildFavoriteTitle(event), text, at: event.time });
    }
    appendSnapshotEntries(snapshotFileOf(deps.ctx, session), entries);
  } catch (error) {
    deps.log?.warn?.(`compact-relay: 收藏快照写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
