/**
 * M1 实验动作 —— `/bctest`。
 *
 * 默认 dry-run 只给预览；加 confirm 才真的执行替换。
 * 走的是和正式压缩旧会话同一条 dsh/compact-transaction，不另写一遍 append。
 */
import { actionError } from '../core/errors.js';
import { TEST_INSTRUCTION } from '../core/prompts.js';
import { selectTestRange } from '../core/ranges.js';
import { sumShadowedTokens } from '../core/tokens.js';
import { measurePressure } from '../dsh/pressure.js';
import { firstCompactableIdx } from '../dsh/session-view.js';
import { runCompaction } from './compact-run.js';
import { withLock } from './lock.js';

/**
 * @param {{ctx:object, cfg:object, lock:object, engine:object}} deps
 * @param {{agent:object, signal?:AbortSignal, confirm?:boolean, commandId?:string}} input
 */
export async function testCompact(deps, { agent, signal, confirm = false, commandId }) {
  if (agent === undefined || agent === null) throw actionError('nosession', '没有活动会话');
  const session = agent.session;

  return withLock(deps.lock, agent.id, async () => {
    const measured = await measurePressure(deps.ctx, agent, { windowFallback: deps.cfg.contextWindowFallback });
    const nodes = measured.nodes.filter((node) => Number.isInteger(node?.seq));

    const range = selectTestRange({
      nodes,
      firstIdx: firstCompactableIdx(session),
      nodeCount: deps.cfg.dev.testRangeNodes,
      isBalancedBefore: (seq) => deps.engine.toolPairingBalancedBefore(session, seq),
      isBalancedAfter: (seq) => deps.engine.toolPairingBalancedAfter(session, seq),
    });
    if (range === null) {
      throw actionError('range', '找不到配对平衡的小范围（会话太短，或工具有未配对调用）');
    }

    const shadowedTokenCount = sumShadowedTokens(nodes, range.shadowedSeqs);
    const freshRange = { ...range, shadowedTokenCount };

    if (!confirm) {
      return {
        dryRun: true,
        range: freshRange,
        shadowedTokenCount,
        message:
          `预览：将把 seq ${range.startSeq}–${range.endSeq} 共 ${range.shadowedSeqs.length} 条历史替换成一条摘要` +
          `（约 ${shadowedTokenCount} token）。确认执行：/bctest confirm`,
      };
    }

    // 和正式精压走同一条执行路径，只是范围小、摘要指令不同、不做六段校验。
    const outcome = await runCompaction(deps, {
      agent,
      session,
      range: freshRange,
      instruction: TEST_INSTRUCTION,
      requiredSections: [], // /bctest 是短段落摘要，不做六段校验
      signal,
      commandId,
    });

    return {
      ok: true,
      dryRun: false,
      range: freshRange,
      ...outcome,
      message:
        `替换成功：${outcome.shadowedSeqs.length} 条历史 → 一条摘要` +
        `（compaction seq ${outcome.startSeq}–${outcome.endSeq}，约 ${outcome.shadowedTokenCount} token）。`,
    };
  });
}
