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
import { replaceRangeWithSummary } from '../dsh/compact-transaction.js';
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
 * @returns {Promise<{compactionId:string, startSeq:number, summarySeq:number, endSeq:number, shadowedSeqs:number[], shadowedTokenCount:number}>}
 */
export async function runCompaction(deps, input) {
  const startedAt = Date.now();
  try {
    const outcome = await runCompactionProcess(deps, input);
    deps.diag?.bumpAction('compact', true);
    return outcome;
  } catch (error) {
    deps.diag?.bumpAction('compact', false);
    deps.diag?.recordError(errorCodeOf(error), 'compact');
    throw error;
  } finally {
    deps.diag?.recordDuration('compact', Date.now() - startedAt);
  }
}

/**
 * 压缩执行流程本体（跑 idle 事务 → 替换历史 + 调摘要）。
 * @param {{ctx:object, cfg:object, engine:object}} deps
 * @param {object} input 见 runCompaction
 */
async function runCompactionProcess(
  deps,
  { agent, session, range, instruction, requiredSections, signal, commandId, inputTokens, timeoutMs },
) {
  const flush =
    typeof deps.ctx.sessions?.flush === 'function' ? () => deps.ctx.sessions.flush(session) : undefined;
  const estimateMessage =
    typeof deps.ctx?.tokenMeter?.estimateMessage === 'function'
      ? (message) => deps.ctx.tokenMeter.estimateMessage(message)
      : undefined;

  return runIdle(agent, async (idleSignal) => {
    const combined = combinedSignal(signal, idleSignal);
    const result = await replaceRangeWithSummary({
      session,
      range,
      engine: deps.engine,
      signal: combined,
      sourceCommandId: commandId,
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
