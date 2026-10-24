/**
 * 接力链记录（A5）—— 把「这次交接建了哪个子会话」从文案变成数据。
 *
 * 写在**父会话**日志里的一条 plugin record（不进模型上下文、不算 token、压缩碰不到），
 * 和压缩判断记录/pin 同一种模式。下一次从同一会话交接时优先读它，不再靠解析标题/输出文案。
 */

/** 会话日志里记录 relay 的类型（与压缩判断记录/pin 的 plugin record 同前缀）。 */
export const RELAY_RECORD_TYPE = 'plugin:compact-relay/relay';

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
 * 从任意文本里剥掉现代/历史交接前缀，拿到原始标题。
 * 旧格式（「交接：」/「接棒：」可堆叠）只在读旧标题时兼容，不删除会话标题。
 * @param {string|undefined} title
 * @returns {{baseTitle:string, handedOff:number}}
 */
export function splitHandoffTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) return { baseTitle: '会话', handedOff: 0 };
  const modern = /^交接第\s*(\d+)\s*次[：:]\s*([\s\S]*)$/.exec(title.trim());
  if (modern !== null) {
    const base = modern[2].trim();
    return { baseTitle: base.length > 0 ? base : '会话', handedOff: Number.parseInt(modern[1], 10) };
  }
  let base = title.trim();
  let handedOff = 0;
  for (;;) {
    const match = /^(?:交接|接棒)[：:]\s*/.exec(base);
    if (match === null) break;
    base = base.slice(match[0].length);
    handedOff += 1;
  }
  const clean = base.trim();
  return { baseTitle: clean.length > 0 ? clean : '会话', handedOff };
}
