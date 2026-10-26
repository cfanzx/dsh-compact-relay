/**
 * 压缩事件配对扫描（A6）—— 从会话日志里把 summary / end / replace 挂上钩。
 *
 * 两处消费方，口径必须一致：
 *   - dsh/session-view.countSummaries：数「已提交的压缩份数」（advice/合并旧摘要用）；
 *   - dsh/compaction-log.collectCompactions：还原最近几次压缩（只读面板 / diff 端点）。
 *
 * 以前两处各自 for 一遍日志、各自建 summaries / ends / replace 索引，键名和过滤
 * 条件还不完全一样（countSummaries 用 replacedSeqs Set，compaction-log 用
 * replaceByCoveredSeq Map）——只要一处改配对规则，另一处就静默漂移。
 * 现在扫描与「已提交」判定都只在这里做一次（0.5.1 D01：判定也合并）。
 *
 * 只读：不写日志、不碰 session 内部结构。
 */

/**
 * 扫描事件日志，返回三类索引。
 *
 * - summaries：compaction/summary 事件，按日志顺序；
 * - ends：compactionId → compaction/end 事件的 data（同 id 多次时后者覆盖，与旧实现一致）；
 * - replaceByCoveredSeq：被 replace 覆盖的 seq → 该 user/message 事件。
 *   只收 number 且有限的 seq（summary.seq 必然是整数，字符串/NaN 键匹配不上，
 *   和旧实现直接 Set.add 的判定结果一致）。
 *
 * @param {object[]} log 会话事件日志（dsh/session-view.sessionLog 的返回值）
 * @returns {{summaries:object[], ends:Map<string,object>, replaceByCoveredSeq:Map<number,object>}}
 */
export function scanCompactionLog(log) {
  const summaries = [];
  const ends = new Map();
  const replaceByCoveredSeq = new Map();

  for (const event of Array.isArray(log) ? log : []) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'compaction/summary') {
      summaries.push(event);
    } else if (event.type === 'compaction/end') {
      const id = event.data?.compactionId;
      if (typeof id === 'string') ends.set(id, event.data);
    } else if (event.type === 'user/message' && Array.isArray(event.sourceEventSeqs)) {
      for (const seq of event.sourceEventSeqs) {
        if (typeof seq === 'number' && Number.isFinite(seq)) replaceByCoveredSeq.set(seq, event);
      }
    }
  }

  return { summaries, ends, replaceByCoveredSeq };
}

/**
 * 一次压缩是否「已提交」（D01：唯一口径）。
 *
 * 0.5.1 之前两个消费方各写一遍，而且在**没有 `compactionId` 的旧日志**上答案不同：
 *   - `dsh/compaction-log.collectCompactions`：所有 summary 都要求 replace；
 *   - `dsh/session-view.countSummaries`：没有 id 的 summary 直接 +1，不看 replace。
 * 同一份日志于是出现「countSummaries=1 / committed=false」的幽灵压缩。现在统一按
 * 严格版：**没有 id 也必须被 replace 覆盖**（没有 id 无法配对 end，只能要求 replace）。
 *
 * 有 id 时还要求同 id 的 end 存在且没有 error（失败事务的 summary 是幽灵摘要，不算）。
 *
 * @param {{compactionId?:string|null, end?:object, replace?:object|null}} input
 *   compactionId：summary.data.compactionId（旧日志没有 → null/undefined）
 *   end：同 id 的 compaction/end data（没有 → undefined）
 *   replace：覆盖 summary.seq 的 user/message(replace) 事件（没有 → undefined）
 * @returns {boolean}
 */
export function isCommittedCompaction({ compactionId, end, replace } = {}) {
  // 1) 无论有没有 compactionId，都必须有一条覆盖该 summary 的 replace。
  if (replace === undefined || replace === null) return false;
  // 2) 旧日志没有 id：无法配对 end，replace 即算已提交（0.4 兼容口径）。
  if (typeof compactionId !== 'string' || compactionId.length === 0) return true;
  // 3) 新日志：还要求 end 存在且不是失败 end。
  return end !== undefined && end !== null && end.error === undefined;
}
