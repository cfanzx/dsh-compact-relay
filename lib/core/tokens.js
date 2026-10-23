/**
 * token 估算公共口径 —— 纯函数，零依赖。
 *
 * surface 节点（dsh/pressure 测出来的 node）同时可能带 `heuristicTokens`
 * 与 `tokens`。口径必须全插件一致：
 *   - 选段的「近期尾部预算」（core/ranges.js）
 *   - state 帧里算可压范围（actions/state.js）
 *   - 压缩预览/执行里算「腾出多少容量」（actions/better-compact.js、actions/test-compact.js）
 *
 * 以前这几处各写一份 `node.heuristicTokens ?? node.tokens ?? 0`，还有两处
 * 完全相同的 `shadowedTokensOf` / `tokenCountOf` 求和函数；现在只保留这里一份。
 */

/**
 * 单个 surface 节点按哪个字段算 token（heuristic 优先，口径唯一）。
 * @param {{tokens?:number, heuristicTokens?:number}} node
 * @returns {number}
 */
export function tokenOf(node) {
  return node?.heuristicTokens ?? node?.tokens ?? 0;
}

/**
 * 被遮罩 seq 集合的 token 总数（压缩范围要「腾出多少容量」的公共算法）。
 * @param {{seq:number, tokens?:number, heuristicTokens?:number}[]} nodes
 * @param {number[]} shadowedSeqs
 * @returns {number}
 */
export function sumShadowedTokens(nodes, shadowedSeqs) {
  const wanted = new Set(shadowedSeqs);
  return nodes
    .filter((node) => wanted.has(node.seq))
    .reduce((sum, node) => sum + tokenOf(node), 0);
}
