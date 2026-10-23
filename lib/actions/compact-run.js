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
import { runIdle } from '../dsh/idle.js';
import { summarize } from '../dsh/summarizer.js';
import { combinedSignal } from './support.js';

/**
 * 执行一次压缩替换事务。
 * @param {{ctx:object, cfg:object, engine:object}} deps
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
export async function runCompaction(
  deps,
  { agent, session, range, instruction, requiredSections, signal, commandId, inputTokens, timeoutMs },
) {
  const flush =
    typeof deps.ctx.sessions?.flush === 'function' ? () => deps.ctx.sessions.flush(session) : undefined;
  const estimateMessage =
    typeof deps.ctx?.tokenMeter?.estimateMessage === 'function'
      ? (message) => deps.ctx.tokenMeter.estimateMessage(message)
      : undefined;

  return runIdle(agent, (idleSignal) => {
    const combined = combinedSignal(signal, idleSignal);
    return replaceRangeWithSummary({
      session,
      range,
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
          endSeq: range.endSeq,
          instruction,
          requiredSections,
          maxTokens: deps.cfg.summary.maxTokens,
          inputTokens,
          // 超时由调用方传：正式精压传 cfg.timeouts.llmMs（原行为），/bctest 不传 → 180s 默认。
          timeoutMs,
          signal: innerSignal,
        }),
      flush,
    });
  });
}
