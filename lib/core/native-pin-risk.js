/**
 * 0.5.1 批 2：预判「下一次 DSH 原生自动压缩会覆盖哪些锁定消息」—— 纯函数，零依赖。
 *
 * 宿主 `@deepseek-ai/dsh-compaction-basic` 的选段（0.2.1-rc.3 源码）：
 *
 *   const firstIdx = systemHead(session, surface[0]) === undefined ? 0 : 1;
 *   let accumulated = 0, keepFromIdx = nodes.length;
 *   for (let i = nodes.length - 1; i >= 0; i--) {
 *     accumulated += nodes[i].tokens;
 *     keepFromIdx = i;
 *     if (accumulated >= retainTokens) break;
 *   }
 *   if (keepFromIdx <= firstIdx) return null;
 *   while (keepFromIdx > firstIdx && !toolPairingBalancedBefore(session, surface[keepFromIdx])) keepFromIdx -= 1;
 *   if (keepFromIdx <= firstIdx) return null;
 *   return { start: surface[firstIdx], end: surface[keepFromIdx - 1] };
 *
 * 本模块只复刻「选段」这一段，不执行任何压缩；配对平衡用调用方传入的
 * `engine.toolPairingBalancedBefore`，与宿主同口径（缺回调时跳过该步，宁少报不多报）。
 *
 * 触发条件（由 actions/state 判断）：原生自动压缩开启、当前压力 ≥ 真实触发线。
 * 宿主在 step boundary 才真正压；用户看到预警时还有机会先 /handoff 或解锁。
 *
 * @module core/native-pin-risk
 */
import { tokenOf } from './tokens.js';

function isSeq(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function normalizeNodes(nodes) {
  return Array.isArray(nodes)
    ? nodes.filter((node) => node !== null && typeof node === 'object' && isSeq(node.seq))
    : [];
}

/**
 * 复刻宿主的保留尾部 + 配对平衡选段，返回会被压缩的 seq 范围。
 *
 * @param {object} input
 * @param {number[]} input.pinnedSeqs 当前仍 live 的锁定 seq
 * @param {{seq:number, tokens?:number, heuristicTokens?:number}[]} input.nodes 当前 surface 节点（含 token 定价）
 * @param {number} [input.firstIdx] 第一个允许被压的下标（system head 存在时为 1）
 * @param {number} [input.retainTokens] 原生保留尾部预算（compaction-basic 的 retainTokens）
 * @param {(seq:number)=>boolean} [input.isBalancedBefore] 该 seq 之前切一刀是否工具配对平衡
 * @returns {{count:number, seqs:number[], startSeq:number, endSeq:number}|null}
 *   null = 没有可压范围 / 没有 pin（无需预警）
 */
export function nativePinnedRiskOf({ pinnedSeqs, nodes, firstIdx = 0, retainTokens = 0, isBalancedBefore } = {}) {
  const pinned = Array.isArray(pinnedSeqs) ? pinnedSeqs.filter(isSeq) : [];
  if (pinned.length === 0) return null;
  const list = normalizeNodes(nodes);
  if (list.length === 0) return null;

  const startIdx = Math.max(0, Math.min(Number.isInteger(firstIdx) ? firstIdx : 0, list.length));
  if (startIdx >= list.length) return null;
  const budget = Number.isFinite(retainTokens) && retainTokens > 0 ? retainTokens : 0;

  // 与宿主逐字同序：永远至少保留最后一条（accumulated 在第一轮就 >= 0）。
  let accumulated = 0;
  let keepFromIdx = list.length;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    accumulated += tokenOf(list[index]);
    keepFromIdx = index;
    if (accumulated >= budget) break;
  }
  if (keepFromIdx <= startIdx) return null;

  if (typeof isBalancedBefore === 'function') {
    let rewind = 0;
    while (keepFromIdx > startIdx && rewind < list.length) {
      const seq = list[keepFromIdx].seq;
      let balanced = false;
      try {
        balanced = isBalancedBefore(seq) === true;
      } catch {
        balanced = true; // 判定失败时按「可切」处理：宁少报（不破坏配对）也不多报
      }
      if (balanced) break;
      keepFromIdx -= 1;
      rewind += 1;
    }
  }
  if (keepFromIdx <= startIdx) return null;

  const rangeStart = list[startIdx];
  const rangeEnd = list[keepFromIdx - 1];
  const inRange = (seq) => {
    // surface 顺序不一定按 seq 单调（压缩后 checkpoint 插在旧尾部前），按成员判定。
    for (let index = startIdx; index < keepFromIdx; index += 1) {
      if (list[index].seq === seq) return true;
    }
    return false;
  };
  const seqs = pinned.filter(inRange);
  if (seqs.length === 0) return null;
  return {
    count: seqs.length,
    seqs,
    startSeq: rangeStart.seq,
    endSeq: rangeEnd.seq,
  };
}

export default nativePinnedRiskOf;
