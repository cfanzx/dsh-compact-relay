/**
 * 纯对象工具 —— 零依赖。
 *
 * `isPlainObject` 曾在本文件出现之前有三份（config.js / dsh/settings-file.js /
 * actions/settings.js）：语义完全相同（非 null、typeof object、非数组），
 * 但任何一份改了判定口径，三处的「配置/信封/深合并」就会不一致。
 * 现在只保留这一份，其余位置一律 import。
 */

/**
 * 是否是「普通对象」（非 null、typeof object、非数组）。
 *
 * 注意：这是本项目对「JSON 对象」的判定口径，不区分原型链（class 实例也算）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
