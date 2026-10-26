/**
 * 接力链记录（A5）—— 把「这次交接建了哪个子会话」从文案变成数据。
 *
 * 写在**父会话**日志里的一条 plugin record（不进模型上下文、不算 token、压缩碰不到），
 * 和压缩判断记录/pin 同一种模式。下一次从同一会话交接时优先读它，不再靠解析标题/输出文案。
 */

/** 会话日志里记录 relay 的类型（与压缩判断记录/pin 的 plugin record 同前缀）。 */
export const RELAY_RECORD_TYPE = 'plugin:compact-relay/relay';

/** 历史标题前缀（0.5.0 命名反转：历史 N：<原名>）。 */
export const HISTORY_PREFIX = '历史';

/** 「历史 N：」标题的正则；空白/半角冒号的容忍度与下面的「交接第 N 次：」一致。 */
const HISTORY_TITLE_RE = new RegExp(`^${HISTORY_PREFIX}\\s*(\\d+)\\s*[：:]\\s*([\\s\\S]*)$`);

/**
 * 标题统一格式：交接第 N 次：<原始标题>。
 * @param {number} index
 * @param {string} [baseTitle]
 * @returns {string}
 */
export function relayTitleOf(index, baseTitle) {
  const base = typeof baseTitle === 'string' && baseTitle.trim().length > 0 ? baseTitle.trim() : '会话';
  return `交接第 ${index} 次：${base}`;
}

/**
 * 历史标题统一格式：历史 N：<原始标题>。
 *
 * 空格位置/全角冒号/序号写法与 relayTitleOf 完全一致（序号不补零、不换算）；
 * 原名先 trim，空/非字符串回落「会话」。
 * @param {number} index
 * @param {string} [baseTitle]
 * @returns {string}
 */
export function historyTitleOf(index, baseTitle) {
  const base = typeof baseTitle === 'string' && baseTitle.trim().length > 0 ? baseTitle.trim() : '会话';
  return `${HISTORY_PREFIX} ${index}：${base}`;
}

/**
 * 从任意文本里剥掉现代/历史交接前缀，拿到原始标题。
 * 旧格式（「交接：」/「接棒：」可堆叠）只在读旧标题时兼容，不删除会话标题。
 *
 * 0.4.3 F1：返回值新增 `scheme`（只增不改，baseTitle/handedOff 的名字与语义不变）：
 *  - 'handoff-n'：「交接第 N 次：」；
 *  - 'history-n'：「历史 N：」；
 *  - 'legacy'：其余（旧「交接：」/「接棒：」堆叠、无前缀、空/脏输入回落）。
 * @param {string|undefined} title
 * @returns {{baseTitle:string, handedOff:number, scheme:'handoff-n'|'history-n'|'legacy'}}
 */
export function splitHandoffTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    return { baseTitle: '会话', handedOff: 0, scheme: 'legacy' };
  }
  const trimmed = title.trim();
  const modern = /^交接第\s*(\d+)\s*次[：:]\s*([\s\S]*)$/.exec(trimmed);
  if (modern !== null) {
    const base = modern[2].trim();
    return { baseTitle: base.length > 0 ? base : '会话', handedOff: Number.parseInt(modern[1], 10), scheme: 'handoff-n' };
  }
  const history = HISTORY_TITLE_RE.exec(trimmed);
  if (history !== null) {
    const base = history[2].trim();
    return { baseTitle: base.length > 0 ? base : '会话', handedOff: Number.parseInt(history[1], 10), scheme: 'history-n' };
  }
  let base = trimmed;
  let handedOff = 0;
  for (;;) {
    const match = /^(?:交接|接棒)[：:]\s*/.exec(base);
    if (match === null) break;
    base = base.slice(match[0].length);
    handedOff += 1;
  }
  const clean = base.trim();
  return { baseTitle: clean.length > 0 ? clean : '会话', handedOff, scheme: 'legacy' };
}
