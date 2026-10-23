/**
 * 选段 —— 纯函数，零依赖。
 *
 * 只接收「surface 节点描述 + 两个平衡判定回调」，
 * 不碰 session / ctx，方便单测。
 *
 * 两种策略：
 *   - selectTestRange：M1 实验用，取最近 N 条（小范围、可预测）；
 *   - selectFullRange：M2 正式版用，跳过旧摘要（不二压）、保留近期尾部。
 */
import { tokenOf } from './tokens.js';

const isSeq = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function normalizeNodes(nodes) {
  return Array.isArray(nodes) ? nodes.filter((node) => node != null && isSeq(node.seq)) : [];
}

function buildRange(shadowed) {
  // 注意：压缩后 surface 里 checkpoint 的 seq 最大却插在旧尾部前面，所以 seq 非单调是合法的；
  // 事务层（compact-transaction.assertRange）按 surface 位置校验，不按 seq 大小。
  return {
    startSeq: shadowed[0].seq,
    endSeq: shadowed[shadowed.length - 1].seq,
    shadowedSeqs: shadowed.map((node) => node.seq),
  };
}

/**
 * M1 实验选段：取最近 nodeCount 个 surface 节点，
 * 起点向前找最近的「配对平衡」切点，终点向后找最近的平衡切点。
 *
 * @param {object} input
 * @param {{seq:number, tokens?:number, heuristicTokens?:number}[]} input.nodes 当前 surface 节点（升序）
 * @param {number} input.firstIdx 第一个允许被替换的下标（有 system head 时是 1）
 * @param {number} input.nodeCount 目标节点数
 * @param {(seq:number)=>boolean} input.isBalancedBefore 该节点前切一刀是否配对平衡
 * @param {(seq:number)=>boolean} input.isBalancedAfter 该节点后切一刀是否配对平衡
 * @returns {{startSeq:number, endSeq:number, shadowedSeqs:number[]}|null}
 */
export function selectTestRange({ nodes, firstIdx = 0, nodeCount, isBalancedBefore, isBalancedAfter }) {
  const list = normalizeNodes(nodes);
  if (list.length === 0) return null;

  let end = list.length - 1;
  while (end > firstIdx && !isBalancedAfter(list[end].seq)) end -= 1;

  let start = Math.max(firstIdx, end - Math.max(1, nodeCount) + 1);
  while (start < end && !isBalancedBefore(list[start].seq)) start += 1;

  if (start >= end) return null;
  return buildRange(list.slice(start, end + 1));
}

/**
 * M2 正式版选段：从「最后一个旧摘要之后」开始，保留近期尾部，
 * 天然跳过旧摘要 → 不二压。
 *
 * @param {object} input
 * @param {{seq:number, tokens?:number, heuristicTokens?:number}[]} input.nodes 当前 surface 节点（升序）
 * @param {number} input.firstIdx 第一个允许被替换的下标（有 system head 时是 1）
 * @param {number} input.checkpointIdx 最后一个 checkpoint 消息在 surface 中的下标（没有则 -1）
 * @param {number} [input.afterSeq] 只允许压缩 seq 严格大于它的节点（= 最后 checkpoint 的 seq）。
 *   有它时优先用它，避免把「surface 插入顺序上排在 checkpoint 后面的旧尾部」误压（真机坑）。
 * @param {number} input.recentTailTokens 逐字保留的近期尾部预算
 * @param {(seq:number)=>boolean} input.isBalancedBefore
 * @param {(seq:number)=>boolean} input.isBalancedAfter
 * @returns {{startSeq:number, endSeq:number, shadowedSeqs:number[]}|null}
 */
export function selectFullRange({
  nodes,
  firstIdx = 0,
  checkpointIdx = -1,
  afterSeq,
  recentTailTokens = 0,
  isBalancedBefore,
  isBalancedAfter,
}) {
  const list = normalizeNodes(nodes);
  if (list.length === 0) return null;

  // 起点：只压「比最后 checkpoint 更新」的节点。
  // 优先按 seq 判定——checkpoint 之后的节点在 surface 顺序上不一定都更新；
  // 压缩保留的旧尾部就排在 checkpoint 后面，按下标会把它误当成待压内容。
  let begin;
  if (typeof afterSeq === 'number' && Number.isInteger(afterSeq)) {
    let index = 0;
    while (index < list.length && list[index].seq <= afterSeq) index += 1;
    begin = Math.max(firstIdx, index);
  } else {
    begin = Math.max(firstIdx, checkpointIdx + 1);
  }
  if (begin >= list.length - 1) return null;

  // 终点：从尾部往回留出 recentTailTokens 的逐字尾部。
  let end = list.length - 1;
  let tailSum = 0;
  while (end > begin && tailSum < recentTailTokens) {
    tailSum += tokenOf(list[end]);
    end -= 1;
  }

  // 配对平衡：终点向前缩，起点向后挪。
  while (end > begin && !isBalancedAfter(list[end].seq)) end -= 1;
  let start = begin;
  while (start < end && !isBalancedBefore(list[start].seq)) start += 1;

  if (start >= end) return null;
  const shadowed = list.slice(start, end + 1);
  // afterSeq 模式只允许压「checkpoint 之后」的节点。真实 surface 里 begin 之后的节点
  // 都应更新（seq 更大）；若出现非单调（旧尾部混在后面），宁可本次不压，也别把保留内容误压。
  if (typeof afterSeq === 'number' && Number.isInteger(afterSeq) && shadowed.some((node) => node.seq <= afterSeq)) {
    return null;
  }
  return buildRange(shadowed);
}
