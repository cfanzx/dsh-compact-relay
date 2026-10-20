/**
 * 锁定重要消息（M6，内部代号「钉住」/pin）—— 用户指定「必须保留、不被压缩」的消息。
 *
 * 实现：往会话日志追加一条 plugin record（`ignorable`、不进模型 surface）：
 *   plugin:compact-relay/pin   data: { seqs: number[], at }
 * 每条记录都是「当前锁定集合」的完整快照 → 取最后一条即最新状态；
 * 解除锁定就再写一条 `seqs: []`，不删历史、不改原文。
 *
 * 选段规则（clipRangeByPins）：候选范围里只要碰到被锁定的 seq，
 * 就从最早那条被锁定的消息之前截断——被锁定的消息和它之后的内容都保留。
 * 若截完什么都不剩，本次不压，由调用方提示「先用 /unpin 解除锁定」。
 */

export const PIN_RECORD_TYPE = 'plugin:compact-relay/pin';

const isSeq = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * 该事件是不是本插件的锁定记录。
 * @param {unknown} event
 * @returns {boolean}
 */
export function isPinRecordEvent(event) {
  return event !== null && typeof event === 'object' && event.ignorable === true && event.type === PIN_RECORD_TYPE;
}

/**
 * 规范化锁定集合：只留非负整数，去重、升序。
 * @param {unknown} raw
 * @returns {number[]}
 */
export function normalizePinnedSeqs(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isSeq))].sort((a, b) => a - b);
}

/**
 * 从会话事件流里取最新的锁定集合；没有记录返回 []。
 * @param {object[]} events
 * @returns {number[]}
 */
export function latestPinnedSeqs(events) {
  if (!Array.isArray(events)) return [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isPinRecordEvent(event)) continue;
    const data = event.data;
    return data !== null && typeof data === 'object' ? normalizePinnedSeqs(data.seqs) : [];
  }
  return [];
}

/**
 * 按锁定集合裁剪候选范围（纯函数，不改入参）。
 *
 * @param {{startSeq:number,endSeq:number,shadowedSeqs:number[]}|null} range
 * @param {number[]} pinnedSeqs
 * @returns {{startSeq:number,endSeq:number,shadowedSeqs:number[],pinnedCut?:boolean,pinnedKept?:number}|null}
 *   返回 null = 范围被锁定消息完全挡住（本次不能压）。
 */
export function clipRangeByPins(range, pinnedSeqs) {
  if (range === null || range === undefined || typeof range !== 'object') return range;
  if (!Array.isArray(range.shadowedSeqs) || range.shadowedSeqs.length === 0) return range;

  // 按「成员」判定，不做数值区间过滤：压缩后 seq 非单调，startSeq>endSeq 的合法范围也存在，
  // 数值比较会把范围内的钉住消息漏掉（2026-10-19 debug 实测：钉住 seq11 被忽略、压缩覆盖了锁定消息）。
  const pinnedSet = new Set(normalizePinnedSeqs(pinnedSeqs));
  const pinned = range.shadowedSeqs.filter((seq) => pinnedSet.has(seq));
  if (pinned.length === 0) return range;

  const cutIndex = range.shadowedSeqs.indexOf(pinned[0]);
  const shadowedSeqs = range.shadowedSeqs.slice(0, cutIndex);
  if (shadowedSeqs.length === 0) return null;

  return {
    ...range,
    endSeq: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
    pinnedCut: true,
    pinnedKept: pinned.length,
  };
}
