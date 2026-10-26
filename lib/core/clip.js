/**
 * 文本截断的两个共享口径（0.5.1 D03）—— 消掉散在 6 处的「切一刀加省略号」。
 *
 * 为什么只有两个函数：评审把现有截断按**单位**归成三类 ——
 *   1. UTF-16 码元（`String.prototype.slice`）：0.4/0.5 的既有实现，逐字节兼容用；
 *   2. 码点（`Array.from`）：0.6 新写的两份逻辑相同「不切坏 emoji」，收在这里；
 *   3. UTF-8 字节：那是宿主 `session-title` 的 `maxTitleBytes` 契约克隆
 *      （`core/relay.js:truncateTitleUtf8`），语义是"按宿主预算缩标题"，**不是**
 *      展示层截断，按评审结论不并进来（0.5.2 S3 再迁 `dsh/title-budget.js`）。
 *
 * 省略号预算必须显式，因为现网有两种既有输出：
 *   - 'inside'（默认）：省略号算进上限，结果长度 ≤ max —— 旧 `slice(0, max-1) + '…'`；
 *   - 'append'：省略号额外多 1 字符 —— `dsh/compaction-log` 的预览既有输出（201 字符
 *     上限），`previewTruncated` 依赖它，合并时**必须保留**；
 *   - false：不补省略号。
 *
 * 纯函数、零依赖（可被 client bundle 内联）。非字符串一律返回 ''（调用方本来都先做
 * 了 typeof 判断，这里只是兜底不抛错）；max 非法（undefined/NaN）时原样返回 —— 不猜预算。
 */

/** 省略号：与本项目其它文案一致，用单个 U+2026（不是三个点）。 */
const ELLIPSIS = '…';

/**
 * 归一化上限：非法 → null（调用方原样返回）；小数向下取整；负数按 0 处理。
 * @param {unknown} max
 * @returns {number|null}
 */
function limitOf(max) {
  if (typeof max !== 'number' || !Number.isFinite(max)) return null;
  return Math.max(0, Math.trunc(max));
}

/**
 * 按预算切一段 + 省略号（长度/切片方式由调用方给：码点数组或码元字符串）。
 * @param {string} text 原文本
 * @param {number} limit 归一化后的上限
 * @param {'inside'|'append'|false} ellipsis 省略号预算
 * @param {(text:string)=>number} lengthOf 按目标单位算长度
 * @param {(text:string, count:number)=>string} slice 按目标单位取前缀
 * @returns {string}
 */
function cut(text, limit, ellipsis, lengthOf, slice) {
  const length = lengthOf(text);
  if (length <= limit) return text;
  if (ellipsis === 'append') return `${slice(text, limit)}${ELLIPSIS}`;
  if (ellipsis === false) return slice(text, limit);
  // 'inside'（默认）：省略号占一个单位；limit=0 时只剩省略号（与旧实现一致）。
  return `${slice(text, Math.max(0, limit - 1))}${ELLIPSIS}`;
}

/**
 * 按**码点**截断（emoji / 代理对不会被切半）。展示层优先用它。
 * @param {string} text
 * @param {number} max 上限（按码点计）
 * @param {{ellipsis?:'inside'|'append'|false}} [options]
 * @returns {string}
 */
export function clipChars(text, max, { ellipsis = 'inside' } = {}) {
  if (typeof text !== 'string') return '';
  const limit = limitOf(max);
  if (limit === null || text.length === 0) return text;
  const charsOf = (value) => Array.from(value);
  return cut(
    text,
    limit,
    ellipsis,
    (value) => charsOf(value).length,
    (value, count) => charsOf(value).slice(0, count).join(''),
  );
}

/**
 * 按**UTF-16 码元**截断（`String.prototype.slice`，0.4/0.5 的既有行为逐字节兼容）。
 * 注意：代理对（emoji）可能被切在中间 —— 需要「不切半」时用 clipChars。
 * @param {string} text
 * @param {number} max 上限（按码元计，即 `String.length`）
 * @param {{ellipsis?:'inside'|'append'|false}} [options]
 * @returns {string}
 */
export function clipCodeUnits(text, max, { ellipsis = 'inside' } = {}) {
  if (typeof text !== 'string') return '';
  const limit = limitOf(max);
  if (limit === null || text.length === 0) return text;
  return cut(
    text,
    limit,
    ellipsis,
    (value) => value.length,
    (value, count) => value.slice(0, count),
  );
}
