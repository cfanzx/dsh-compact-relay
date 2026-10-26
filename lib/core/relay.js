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

/**
 * 会话标题的 UTF-8 字节预算 —— 与 DSH `session-title` 的默认 `maxTitleBytes` 一致。
 *
 * 宿主 `sessionTitle.rename()` 会按这个预算把标题从尾部截断；前缀也算预算。
 * 插件先自己按同一口径缩 base，保证「历史 N：」前缀不会被宿主的尾部截断吃掉。
 */
export const MAX_TITLE_BYTES = 80;

/** 「历史 N：」标题的正则；空白/半角冒号的容忍度与下面的「交接第 N 次：」一致。 */
const HISTORY_TITLE_RE = new RegExp(`^${HISTORY_PREFIX}\\s*(\\d+)\\s*[：:]\\s*([\\s\\S]*)$`);

/**
 * 按 UTF-8 字节预算截断标题（不切坏多字节字符 / 代理对）。
 *
 * 与 DSH `session-title` 的 `truncateTitleUtf8` 同口径：取「能放进预算的最长前缀」，
 * 不补省略号（补了会占预算，也会让前缀解析多一个尾巴）。
 * maxBytes 非法/缺失时原样返回（纯函数层保持旧行为，预算只在调用方显式传入时生效）。
 * @param {string} input
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function truncateTitleUtf8(input, maxBytes) {
  if (typeof input !== 'string') return '';
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return input;
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let used = 0;
  let output = '';
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

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
 *
 * 0.5.0 可选第三参 `maxBytes`：给 UTF-8 字节预算时，**前缀先计入预算、超长只缩 base**，
 * 保证宿主按 maxTitleBytes 截断时不会把「历史 N：」本身截掉。
 * 不传时保持 0.4.3 的纯函数行为（不截断）。
 * @param {number} index
 * @param {string} [baseTitle]
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function historyTitleOf(index, baseTitle, maxBytes) {
  const base = typeof baseTitle === 'string' && baseTitle.trim().length > 0 ? baseTitle.trim() : '会话';
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return `${HISTORY_PREFIX} ${index}：${base}`;
  const prefix = `${HISTORY_PREFIX} ${index}：`;
  const budget = maxBytes - Buffer.byteLength(prefix, 'utf8');
  // 预算连 base 都放不下时只保留前缀（宿主最多再截一次前缀，至少不会切坏字符）。
  if (budget <= 0) return prefix;
  const fitted = truncateTitleUtf8(base, budget).trimEnd() || truncateTitleUtf8('会话', budget);
  return `${prefix}${fitted}`;
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
