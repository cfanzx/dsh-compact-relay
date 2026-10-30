/**
 * 「把一段 surface 历史替换成一条摘要」—— 唯一替换事务。
 *
 * 与 @deepseek-ai/dsh-compaction-basic 的事务同构，但只用公共 Session API：
 *   compaction/start → compaction/summary → user/message(replace) → compaction/end
 *
 * 注意（2026-10-19 从 DSH 源码确认的硬约束）：
 *   1. surfaceOp replace 必须带 sourceEventSeqs，且包含全部被遮罩的节点；
 *   2. start/end 必须成对，失败也要补 end，否则会留下压缩锁把后续原生压缩卡成 busy；
 *   3. 摘要消息用 DSH 的 compactCheckpointSource 标记，旧摘要识别靠它。
 */
import { randomUUID } from 'node:crypto';
import { actionError } from '../core/errors.js';
import { frameSummary } from '../core/prompts.js';
import { entryState } from './session-view.js';

function assertRange(session, range) {
  if (range === null || typeof range !== 'object') throw actionError('range', '没有可替换的范围');
  const seqs = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
  const startIdx = seqs.indexOf(range.startSeq);
  const endIdx = seqs.indexOf(range.endSeq);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw actionError('range', '选中的范围已经不在当前 surface 上');
  }
  const current = seqs.slice(startIdx, endIdx + 1);
  const expected = Array.isArray(range.shadowedSeqs) ? range.shadowedSeqs : [];
  if (current.length !== expected.length || current.some((seq, index) => seq !== expected[index])) {
    throw actionError('changed', '选中的范围在开始之前就变了');
  }
  return { startIdx, endIdx };
}

function assertBalanced(session, range, engine) {
  try {
    if (!engine.toolPairingBalancedBefore(session, range.startSeq)) {
      throw actionError('pairing', '起点会切断配对的工具调用');
    }
    if (!engine.toolPairingBalancedAfter(session, range.endSeq)) {
      throw actionError('pairing', '终点会切断配对的工具调用');
    }
  } catch (error) {
    if (error !== null && typeof error === 'object' && typeof error.code === 'string') throw error;
    throw actionError('range', '工具调用配对检查失败：' + String(error?.message ?? error), error);
  }
}

/** 摘要完成后，确认 surface 没变过。 */
function assertStable(session, range) {
  try {
    assertRange(session, range);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'changed') throw error;
    throw actionError('changed', '压缩过程中会话内容变了，本次未提交（日志有记录）', error);
  }
}

/**
 * 0.5.6 A：把事务的 compactionId 挂到错误上 —— 失败也能和会话日志里的
 * compaction/start|end 对上号（事件流的 `compactionId` 字段直接读它）。
 * @param {unknown} error
 * @param {string} compactionId
 * @returns {unknown}
 */
function tagCompactionId(error, compactionId) {
  try {
    if (error !== null && typeof error === 'object' && typeof error.compactionId !== 'string') {
      error.compactionId = compactionId;
    }
  } catch {
    /* 冻结对象等：忽略 */
  }
  return error;
}

function encodeError(engine, error) {
  try {
    if (typeof engine.errorChain === 'function') return engine.errorChain(error);
  } catch {
    /* fallthrough */
  }
  return { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
}

/**
 * 执行一次替换事务。
 * @param {object} input
 * @param {object} input.session
 * @param {{startSeq:number,endSeq:number,shadowedSeqs:number[],shadowedTokenCount?:number}} input.range
 * @param {object} input.engine
 * @param {(ctx: {shadowedSeqs:number[], signal:AbortSignal|undefined}) => Promise<object>} input.summarize
 * @param {string} [input.sourceCommandId]
 * @param {string} [input.compactionId] 0.5.6 D1：调用方提前 mint 的 id（省略 = 本函数自己生成，旧行为）
 * @param {AbortSignal} [input.signal]
 * @param {(message:object)=>number} [input.estimateMessage] 估算一条消息的 token（摘要体积防护）
 * @param {() => Promise<void>} [input.flush] 提交后落盘（没传就跳过）
 */
export async function replaceRangeWithSummary({ session, range, engine, summarize, sourceCommandId, compactionId: presetCompactionId, signal, estimateMessage, flush }) {
  if (session === undefined) throw actionError('range', '会话不存在');
  signal?.throwIfAborted?.();

  assertRange(session, range);
  assertBalanced(session, range, engine);

  const state = entryState(session);
  if (state.openTurn) throw actionError('busy', '当前会话正在回复，无法压缩');
  if (state.lockActive) throw actionError('busy', '已有未完成的压缩，稍后再试');

  // 0.5.6 D1：优先用调用方提前 mint 的 id —— 这样「压缩事件（start/summary/end）」、
  // 「归属事件行」和「失败错误对象」共用同一个主键；旧调用方不传时保持原行为。
  const compactionId =
    typeof presetCompactionId === 'string' && presetCompactionId.length > 0 ? presetCompactionId : randomUUID();
  const lifecycle = {
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    turn: null,
  };

  const startEvent = session.append('compaction/start', lifecycle);
  let closed = false;

  try {
    const summarized = await summarize({ shadowedSeqs: [...range.shadowedSeqs], endSeq: range.endSeq, signal });
    signal?.throwIfAborted?.();
    assertStable(session, range);

    const checkpointMessage = engine.createUserMessage({
      content: frameSummary(summarized.summary),
      source: engine.compactCheckpointSource(compactionId, sourceCommandId),
    });

    // 摘要体积防护：小范围压缩时，啰嗦摘要可能让上下文不降反升。
    // 与 DSH 官方 compaction-basic 同思路：用 tokenMeter.estimateMessage 量「包帧后的摘要消息」。
    if (typeof estimateMessage === 'function') {
      let framedTokens = null;
      try {
        const estimated = estimateMessage(checkpointMessage);
        framedTokens = Number.isFinite(estimated) ? estimated : null;
      } catch {
        framedTokens = null; // 量不出来就不拦，别让防护本身弄坏压缩
      }
      const shadowedTokens = Number.isFinite(range.shadowedTokenCount) ? range.shadowedTokenCount : 0;
      if (framedTokens !== null && shadowedTokens > 0 && framedTokens >= shadowedTokens) {
        throw actionError(
          'shrink',
          `摘要比被遮罩内容还大（${framedTokens} ≥ ${shadowedTokens} token），本次未提交`,
        );
      }
    }

    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      summary: summarized.summary,
      shadowedRange: { start: range.startSeq, end: range.endSeq },
      shadowedSeqs: [...range.shadowedSeqs],
      shadowedTokenCount: Number.isFinite(range.shadowedTokenCount) ? range.shadowedTokenCount : 0,
      provider: summarized.provider,
      model: summarized.model,
      ...(Number.isFinite(summarized.maxTokens) ? { maxTokens: summarized.maxTokens } : {}),
      ...(summarized.usage === undefined ? {} : { usage: summarized.usage }),
    });

    const replaceEvent = session.append('user/message', checkpointMessage, {
      surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...range.shadowedSeqs],
    });

    const endEvent = session.append('compaction/end', lifecycle);
    closed = true;

    if (typeof flush === 'function') {
      try {
        await flush();
      } catch (error) {
        throw actionError('persistence', '压缩完成但会话未保存成功', error);
      }
    }

    return {
      compactionId,
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      replaceSeq: replaceEvent.seq,
      shadowedSeqs: [...range.shadowedSeqs],
      shadowedTokenCount: Number.isFinite(range.shadowedTokenCount) ? range.shadowedTokenCount : 0,
      summary: summarized.summary,
      // 0.5.6 D1：（additive）归属事件行要用摘要模型；provider 一并带出便于排查路由。
      provider: summarized.provider ?? null,
      model: summarized.model ?? null,
    };
  } catch (error) {
    // P2-1：取消发生在提交前（还没 append summary/replace）→ 先补 end(error)，再明确归为 cancelled；
    // 提交/落盘阶段的错误保持 commit/persistence，不能谎报「历史没改」。
    if (!closed && signal?.aborted === true) {
      try {
        session.append('compaction/end', { ...lifecycle, error: encodeError(engine, error) });
      } catch {
        /* 补不上 end 也不掩盖原始错误 */
      }
      throw tagCompactionId(actionError('cancelled', '已取消，会话记录没有改动', error), compactionId);
    }
    if (!closed) {
      try {
        session.append('compaction/end', { ...lifecycle, error: encodeError(engine, error) });
      } catch {
        /* 补不上 end 也不掩盖原始错误 */
      }
    }
    if (error !== null && typeof error === 'object' && typeof error.code === 'string') throw tagCompactionId(error, compactionId);
    throw tagCompactionId(
      actionError('commit', error?.message === undefined ? String(error) : error.message, error),
      compactionId,
    );
  }
}
