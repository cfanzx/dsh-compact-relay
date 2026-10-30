/**
 * debug CLI 的人读输出（0.5.6 Phase A）—— 零依赖、无副作用。
 *
 * 约定：
 *   - 时间**原样打印文件里的 ISO 串**（不转时区），测试断言因此确定；
 *   - 时长固定 `x.xs` / `xms`；
 *   - 表格按列宽 padEnd（中文按宽度算不划算，但 CLI 只是给自己 grep，够用）。
 */

/**
 * 时长格式：<1s 用 ms，否则一位小数秒。
 * @param {number|null} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 单行短文本（表格用）：折叠空白 + 截断。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function shortText(value, max = 60) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 按列输出表格（列之间两个空格；不打印表头以外的装饰）。
 * @param {string[][]} rows
 * @param {{header?:string[]}} [options]
 * @returns {string}
 */
export function table(rows, { header } = {}) {
  const all = header === undefined ? rows : [header, ...rows];
  const widthOf = (value) => [...String(value)].length;
  const widths = [];
  for (const row of all) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, widthOf(cell));
    });
  }
  return all
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? String(cell) : String(cell).padEnd(widths[index])))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/**
 * 字节数 → 人类可读。
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
