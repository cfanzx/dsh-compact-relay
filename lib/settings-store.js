/**
 * 兼容 shim（A9）。
 *
 * 设置存储已按分层拆开：
 *   - 文件读写：lib/dsh/settings-file.js
 *   - 合并/校验/热替换：lib/actions/settings.js
 * 旧导入路径（`lib/settings-store.js`）保持可用，外部/测试不用改。
 */
export { createSettingsStore, defaultSettingsPath } from './actions/settings.js';
export { default } from './actions/settings.js';
