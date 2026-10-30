/**
 * 脱敏规则的唯一来源（0.5.6 D4）—— 从 dsh/diagnostics.js 下沉到 core。
 *
 * 为什么下沉：0.5.6 的事件流（`compact-relay-events.jsonl`）也要脱敏，而且有两档：
 *   1. **本地档**（落盘）：只删凭据（token / authorization / cookie / 邮箱），
 *      **保留绝对路径与 sessionId** —— 本地排查「交接单目录不可写」这类失败时需要路径；
 *      同时把 `$HOME` 前缀缩成 `~`，少泄露用户名。
 *   2. **外发档**（CLI `export` / 诊断包 / 失败响应里的 `failure`）：
 *      全套 LEAK_PATTERNS（含绝对路径 / 私有 IP / sessionId）+ 调用方另行遮蔽 id。
 *
 * 红线：**只有这一份正则**。任何新模块要脱敏都从这里 import，不许再抄一套。
 * 本模块是纯函数（零 node 内置依赖），可裸跑单测。
 */
import { clipCodeUnits } from './clip.js';

/**
 * 敏感串检测集（与 0.4 诊断包完全一致，顺序从具体到宽泛，避免同一条串被重复计数）。
 * `label` 只用于测试/计数，**不会**把命中的原文带出去。
 */
export const LEAK_PATTERNS = Object.freeze([
  Object.freeze({ label: 'github-pat', pattern: /github_pat_[A-Za-z0-9_]{10,}/gu }),
  Object.freeze({ label: 'github-token', pattern: /ghp_[A-Za-z0-9]{10,}/gu }),
  Object.freeze({ label: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{10,}/gu }),
  Object.freeze({ label: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/gu }),
  Object.freeze({ label: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{20,}/gu }),
  Object.freeze({ label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/gu }),
  Object.freeze({ label: 'authorization-header', pattern: /\bauthorization\s*:\s*[^\r\n]{4,}/giu }),
  Object.freeze({ label: 'bearer-token', pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/giu }),
  Object.freeze({ label: 'cookie', pattern: /\bcookie\s*[:=]\s*[^\s;,]{3,}/giu }),
  Object.freeze({ label: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu }),
  Object.freeze({ label: 'unix-abs-path', pattern: /(?<![\w.-])\/(?:Users|home|root|private|var|opt|etc|tmp)\/[^\s"'`]+/gu }),
  Object.freeze({ label: 'windows-abs-path', pattern: /\b[A-Za-z]:\\[^\s"'`<>|]*/gu }),
  Object.freeze({
    label: 'private-ip',
    pattern:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/gu,
  }),
  Object.freeze({ label: 'session-id', pattern: /\bsession-[0-9a-z]{8,}\b/gu }),
]);

/**
 * 本地档（落盘）只删「凭据类」：路径 / sessionId / 私有 IP 保留，供本地排查。
 * 顺序与 LEAK_PATTERNS 的前 10 项一致（label 也复用同一套）。
 */
export const SECRET_PATTERNS = Object.freeze(LEAK_PATTERNS.slice(0, 10));

/** `[REDACTED]` 占位符（测试断言用同一份常量，避免手写两处不一致）。 */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * 扫描文本里的疑似敏感串。
 * @param {string} text
 * @param {ReadonlyArray<{label:string, pattern:RegExp}>} [patterns]
 * @returns {string[]} 命中的模式 label（去重；**不返回命中的原文**）
 */
export function scanLeakLabels(text, patterns = LEAK_PATTERNS) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  for (const { label, pattern } of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text) && !hits.includes(label)) hits.push(label);
  }
  return hits;
}

/**
 * 把文本里命中的疑似敏感串替换成 `[REDACTED]`。
 * @param {string} text
 * @param {ReadonlyArray<{label:string, pattern:RegExp}>} [patterns]
 * @returns {{text:string, count:number}}
 */
export function redactText(text, patterns = LEAK_PATTERNS) {
  let out = text;
  let count = 0;
  for (const { pattern } of patterns) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => {
      count += 1;
      return REDACTION_PLACEHOLDER;
    });
  }
  return { text: out, count };
}

/** 本地档：只删凭据 + 邮箱（路径 / sessionId / 私有 IP 保留）。 */
export function redactSecrets(text) {
  return redactText(text, SECRET_PATTERNS);
}

/** 转义正则元字符（用于把 $HOME 字面量拼进正则）。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * 本地档（落盘）：凭据脱敏 + `$HOME` 前缀缩成 `~`。
 *
 * @param {string} text
 * @param {{home?:string}} [options] home 由 dsh 层传入（core 不读环境）；不传就跳过前缀替换
 * @returns {{text:string, count:number}}
 */
export function redactLocalText(text, { home } = {}) {
  if (typeof text !== 'string' || text.length === 0) return { text: typeof text === 'string' ? text : '', count: 0 };
  const cleaned = redactSecrets(text);
  let out = cleaned.text;
  let count = cleaned.count;
  if (typeof home === 'string' && home.length > 1) {
    const pattern = new RegExp(`${escapeRegExp(home)}(?=$|[\\\\/])`, 'gu');
    out = out.replace(pattern, () => {
      count += 1;
      return '~';
    });
  }
  return { text: out, count };
}

/**
 * sessionId 遮蔽（外发档）：只留尾 8 位，例如 `…8b0fbefe`。
 * 非字符串 / 太短 → null（不猜）。
 * @param {unknown} value
 * @returns {string|null}
 */
export function maskSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const tail = [...value].slice(-8).join('');
  return value.length <= 8 ? tail : `…${tail}`;
}

/**
 * 单行化 + 截断（事件/失败记录共用；非字符串 → null）。
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {string|null}
 */
export function singleLine(value, maxChars) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return null;
  return clipCodeUnits(text, maxChars);
}
