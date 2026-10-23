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
 * 现在扫描只在这里做一次，两个消费方各自保留自己的「已提交」判定。
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
