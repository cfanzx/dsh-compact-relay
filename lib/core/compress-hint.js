/**
 * 「这里适合压缩」判断记录（0.3.1）—— 纯数据与纯判定，不依赖 DSH。
 *
 * 模型判断：最小线 < 当前 < 压缩线，且工作到了自然节点 → 调用工具记一条：
 *   plugin:compact-relay/compress-hint   data: { ratio, at }
 *
 * 环上把它画成「断点1」（正常区/压缩区的分界）；压缩或交接改变历史后自动失效
 * （和 checkpoint 比较 seq，跟旧阶段标记一个套路）。
 */

/** 记录类型（DSH 语法：`plugin:` + 小写段；只认精确匹配）。 */
export const COMPRESS_HINT_RECORD_TYPE = 'plugin:compact-relay/compress-hint';

/** 判断记录的判定 = ignorable + 类型精确匹配。 */
export function isCompressHintEvent(event) {
  return event !== null && typeof event === 'object' && event.ignorable === true && event.type === COMPRESS_HINT_RECORD_TYPE;
}

/**
 * 从会话事件流里取最近一条「适合压缩」判断；没有或不合法返回 null。
 * @param {object[]} events
 * @returns {{ratio:number, at:number, seq:number}|null}
 */
export function latestCompressHint(events) {
  if (!Array.isArray(events)) return null;
  let hint = null;
  for (const event of events) {
    if (!isCompressHintEvent(event)) continue;
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;
    const ratio =
      typeof data.ratio === 'number' && Number.isFinite(data.ratio)
        ? Math.max(0, Math.min(1, data.ratio))
        : null;
    if (ratio === null) continue;
    const at = typeof data.at === 'number' && Number.isFinite(data.at) ? data.at : 0;
    hint = { ratio, at, seq: event.seq };
  }
  return hint;
}

/**
 * 判断记录是否仍然有效：要比最后一次压缩/交接 checkpoint 新才算数。
 * @param {{seq:number}|null} hint
 * @param {number|undefined} checkpointSeq 最后一次 checkpoint 消息的 event seq
 * @returns {boolean}
 */
export function compressHintIsActive(hint, checkpointSeq) {
  if (hint === null || hint === undefined) return false;
  if (!Number.isInteger(checkpointSeq)) return true;
  return hint.seq > checkpointSeq;
}
