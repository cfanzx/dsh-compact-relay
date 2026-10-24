/**
 * pin 锚点 / 消息摘要 —— 纯函数，零依赖（0.4 P1-1 / P1-2）。
 *
 * 三处展示共用同一份「怎么从会话事件里取一句可读短摘要 + 角色」的实现：
 *  1. `/pin list` 的候选列表（actions/pin.js，0.3.1 起就有这段逻辑，挪到这里收口）；
 *  2. 压缩预览的「建议锁定」候选（core/pin-suggest.js，P1-1）；
 *  3. 交接单的「锁定锚点（保留契约）」段（core/handoff-facts.js，P1-2）。
 *
 * 只做展示：摘要截断到一句（默认 60 字符，不贴原文全文），不读全量历史、不调模型。
 */

/** 事件类型 → 中文角色标签（唯一来源）。 */
export const ROLE_LABELS = Object.freeze({
  'system/message': '系统',
  'user/message': '用户',
  'assistant/message': '助手',
  'tool/result': '工具',
});

/**
 * @param {string|undefined} type 事件类型
 * @returns {string} 角色标签；未知类型返回「其他」
 */
export function roleLabelOf(type) {
  return ROLE_LABELS[type] ?? '其他';
}

/**
 * 从事件里抠出纯文本（消息 content 可能是字符串，也可能是 text block 数组）。
 *
 * DSH v4：user/message 的 data 本身就是消息（{role,content,source}），
 * 只有 system/assistant/tool 包在 data.message 里。2026-10-19 debug 实测：
 * 只读 data.message 会让用户消息全部显示「（无文本）」。
 *
 * @param {object|undefined|null} event
 * @returns {string} 空白折叠后的文本；没有文本返回 ''
 */
export function messageTextOf(event) {
  const content = event?.data?.content ?? event?.data?.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ');
  }
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * 一句可读摘要：折叠空白 + 截断（默认 60 字符，超长加省略号）。
 * @param {object|undefined|null} event
 * @param {number} [maxChars]
 * @returns {string} 没有文本返回 ''
 */
export function messageSnippetOf(event, maxChars = 60) {
  const text = messageTextOf(event);
  if (text.length === 0) return '';
  const limit = Number.isInteger(maxChars) && maxChars > 1 ? maxChars : 60;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * 是不是「真正的用户消息」：user/message 且 source 缺失（老夹具/测试）或 source.kind==='user'。
 *
 * 运行时合成的 user/message（runtime-context / time-context / compact-checkpoint 等）
 * source.kind 不是 'user'，不该被当成「用户明确要求」去做建议锁定/保留锚点。
 * @param {object|undefined|null} event
 * @returns {boolean}
 */
export function isUserAuthoredMessage(event) {
  if (event?.type !== 'user/message') return false;
  const source = event?.data?.source;
  if (source === undefined || source === null) return true;
  return source.kind === 'user';
}

/**
 * 一个 pin 锚点：seq + 角色 + 一句摘要（不贴全文）。
 * @param {object|undefined|null} event
 * @param {{maxChars?:number}} [options]
 * @returns {{seq:number, role:string, snippet:string}|null} 没有可用 seq 返回 null
 */
export function pinAnchorOf(event, { maxChars = 60 } = {}) {
  const seq = event?.seq;
  if (!Number.isInteger(seq) || seq < 0) return null;
  return {
    seq,
    role: roleLabelOf(event.type),
    snippet: messageSnippetOf(event, maxChars) || '（无文本）',
  };
}
