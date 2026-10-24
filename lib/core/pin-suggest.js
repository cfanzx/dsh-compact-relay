/**
 * 压缩预览「建议锁定」候选识别（0.4 P1-1）—— 纯本地启发式，零依赖、不调模型。
 *
 * 目标：在压缩预览里指出「这次要压掉的历史中，哪些消息看起来值得先 /pin 再压」，
 * 让用户在不可逆的压缩前把「关键决策 / 报错堆栈 / 明确要求别改」保留下来。
 *
 * 红线：
 *  - **只提示、绝不自动锁**：本模块只返回候选（seq/角色/理由/一句摘要），不写任何记录；
 *    客户端只渲染提示，锁定动作仍由用户执行 `/pin`；
 *  - 隐私：只产出截断的一句摘要（默认 60 字符，不贴全文），用于本机 UI；
 *  - 启发式宁可少报：长度太短、没有明确信号的消息不进入候选。
 *
 * 三类信号（优先级从高到低）：
 *   1. `明确要求别改`：用户消息里说「不要改 / 别动 / 保持原样 / 必须保留 …」；
 *   2. `报错堆栈`：异常类名 / 堆栈帧 / 中文「堆栈/报错」等；
 *   3. `关键决策`：决定 / 拍板 / 采用 / 改用 / 结论 / 定稿等取舍用语。
 */

import {
  isUserAuthoredMessage,
  messageSnippetOf,
  messageTextOf,
  roleLabelOf,
} from './pin-anchors.js';

/** 一次预览最多建议几条（太多会变成噪声）。 */
export const PIN_SUGGEST_LIMIT = 5;

/** 文本至少这么长才参与识别（避免「好」「继续」这类短句误报）。 */
export const PIN_SUGGEST_MIN_CHARS = 12;

/** 摘要截断长度（与 pin 列表一致）。 */
export const PIN_SUGGEST_SNIPPET_CHARS = 60;

/** 三类理由的唯一文案（客户端直接展示）。 */
export const PIN_SUGGEST_REASONS = Object.freeze({
  error: '报错堆栈',
  keep: '明确要求别改',
  decision: '关键决策',
});

/** 用户明确要求「别改 / 保留」的措辞。 */
const KEEP_RE =
  /(?:(?:不要|别|勿|禁止|不能|不许|请勿|切勿)\s*(?:再)?\s*(?:修改|改动|改|动|变更|碰|删|删除))|(?:保持原样|保留原样|原样保留|必须保留|务必保留|千万别改|不要动)/iu;

/** 报错 / 堆栈信号（异常类名、堆栈帧、中文「堆栈」等）。 */
const ERROR_RE =
  /(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AggregateError|Error:|Exception|Traceback|panic:|stack trace|UnhandledPromiseRejection|at\s+[^\s]+\s*\([^)]*:\d+:\d+\)|堆栈|错误日志|报错)/iu;

/** 决策 / 取舍信号。 */
const DECISION_RE =
  /(?:决定|决策|拍板|结论|定稿|选型|采用|改用|改成|就按|最终方案|确定用|方案定为|取舍)/iu;

/**
 * 单条消息的候选理由；不是候选返回 null。
 * @param {object} event
 * @returns {'报错堆栈'|'明确要求别改'|'关键决策'|null}
 */
function reasonOf(event) {
  const type = event?.type;
  const text = messageTextOf(event);
  if (text.length < PIN_SUGGEST_MIN_CHARS) return null;

  // 用户消息优先判「明确要求别改」：这是最该原样保留的意图。
  if (isUserAuthoredMessage(event) && KEEP_RE.test(text)) return PIN_SUGGEST_REASONS.keep;
  // 报错堆栈/错误日志（用户贴的、助手复述的、工具结果里的都算）。
  if (ERROR_RE.test(text)) return PIN_SUGGEST_REASONS.error;
  // 决策/取舍：只认真实对话消息，不把工具结果里的普通输出当决策。
  if (type !== 'tool/result' && DECISION_RE.test(text)) return PIN_SUGGEST_REASONS.decision;
  return null;
}

/**
 * 单条事件是否可能成为候选（类型过滤）：用户真实消息 / 助手消息 / 工具结果。
 * 系统消息与运行时合成的 user/message（source.kind 非 user，如 checkpoint/时间上下文）
 * 不参与建议。
 * @param {object} event
 * @returns {boolean}
 */
function eligibleOf(event) {
  const type = event?.type;
  if (type === 'assistant/message' || type === 'tool/result') return true;
  if (type === 'user/message') return isUserAuthoredMessage(event);
  return false;
}

const REASON_PRIORITY = Object.freeze({
  [PIN_SUGGEST_REASONS.keep]: 0,
  [PIN_SUGGEST_REASONS.error]: 1,
  [PIN_SUGGEST_REASONS.decision]: 2,
});

/**
 * 从「即将被压掉」的事件里挑值得先锁定的候选。
 *
 * @param {object[]} events 按历史顺序（旧→新）的事件列表；通常传 range.shadowedSeqs 对应的事件
 * @param {{limit?:number}} [options]
 * @returns {Array<{seq:number, role:string, reason:string, snippet:string}>}
 *   按 seq 升序（文档顺序）返回；同一 seq 只出现一次。
 */
export function suggestPinCandidates(events, { limit = PIN_SUGGEST_LIMIT } = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const max = Number.isInteger(limit) && limit > 0 ? limit : PIN_SUGGEST_LIMIT;
  const seen = new Set();
  const matched = [];

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const seq = event.seq;
    if (!Number.isInteger(seq) || seq < 0 || seen.has(seq)) continue;
    if (!eligibleOf(event)) continue;
    const reason = reasonOf(event);
    if (reason === null) continue;
    seen.add(seq);
    matched.push({
      seq,
      role: roleLabelOf(event.type),
      reason,
      snippet: messageSnippetOf(event, PIN_SUGGEST_SNIPPET_CHARS),
    });
  }

  if (matched.length <= max) return matched.sort((left, right) => left.seq - right.seq);
  // 超过上限：先保「明确要求别改」，再报错堆栈，再关键决策；同级取更早的（更在压缩范围里）。
  const picked = [...matched]
    .sort((left, right) => REASON_PRIORITY[left.reason] - REASON_PRIORITY[right.reason] || left.seq - right.seq)
    .slice(0, max);
  return picked.sort((left, right) => left.seq - right.seq);
}
