/**
 * 选段（压缩旧会话候选范围）—— 压缩动作与 state 端点共用同一份实现。
 *
 * 不二压：默认从最后一个 checkpoint 的 seq 之后开始（selectFullRange 的 afterSeq），
 * 保留近期尾部；摘要份数到 maxSummaries 后允许合并旧摘要（afterSeq=undefined）。
 * 工具调用必须配对（provider 的 toolPairingBalanced*）。
 */
import { compactionPolicy } from '../core/policy.js';
import { selectFullRange } from '../core/ranges.js';
import { countSummaries, firstCompactableIdx, lastCheckpointSurfaceSeq, sessionLog } from './session-view.js';

/**
 * @param {{session:object, nodes:object[], engine:object, cfg:object, tokenOf:(node:object)=>number}} input
 * @returns {{startSeq:number,endSeq:number,shadowedSeqs:number[],tokenCount:number}|null}
 */
export function selectCompactableRange({ session, nodes, engine, cfg, tokenOf }) {
  const summaries = countSummaries(session);
  const { allowMergeOldSummaries } = compactionPolicy({ summaries, thresholds: cfg.thresholds });
  const afterSeq = allowMergeOldSummaries
    ? undefined
    : lastCheckpointSurfaceSeq(session, engine.isCompactCheckpointSource);

  const candidate = selectFullRange({
    nodes,
    firstIdx: firstCompactableIdx(session),
    afterSeq,
    recentTailTokens: cfg.retention.recentTailTokens,
    isBalancedBefore: (seq) => engine.toolPairingBalancedBefore(session, seq),
    isBalancedAfter: (seq) => engine.toolPairingBalancedAfter(session, seq),
  });
  if (candidate === null) return null;

  // M6：锁定的消息必须保留——范围里碰到就截到最早那条锁定消息之前；
  // 截空（锁定挡在最前面）就本次不压，由调用方提示 /unpin。
  // 0.6：pin 已退役（改「收藏」），不再按锁定消息截断选段；收藏不改变压缩范围。
  let range = candidate;
  if (range === null) return null;

  // clip 缩短后终点可能落在 tool-call 中间（原来平衡的 candidate 被截断）：
  // 继续向前缩到最近的平衡点；缩到只剩 1 条仍不平衡就本次不压。
  // 2026-10-19 debug 实测：钉住一条 tool/result 时，preview 说能压、confirm 才报 range。
  const balancedAfter = (seq) => {
    try {
      return engine.toolPairingBalancedAfter(session, seq) === true;
    } catch {
      return false;
    }
  };
  while (range.shadowedSeqs.length > 1 && !balancedAfter(range.endSeq)) {
    const shadowedSeqs = range.shadowedSeqs.slice(0, -1);
    range = { ...range, endSeq: shadowedSeqs[shadowedSeqs.length - 1], shadowedSeqs };
  }
  if (range.shadowedSeqs.length === 0 || !balancedAfter(range.endSeq)) return null;

  const wanted = new Set(range.shadowedSeqs);
  let tokenCount = 0;
  if (typeof tokenOf === 'function') {
    for (const node of nodes) {
      if (wanted.has(node.seq)) tokenCount += tokenOf(node);
    }
  }
  return {
    startSeq: range.startSeq,
    endSeq: range.endSeq,
    shadowedSeqs: range.shadowedSeqs,
    tokenCount,
    ...(range.pinnedCut === true ? { pinnedCut: true, pinnedKept: range.pinnedKept } : {}),
  };
}

export default selectCompactableRange;
