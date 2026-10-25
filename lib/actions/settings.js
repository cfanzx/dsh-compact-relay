/**
 * 设置存储动作层（A9：从根目录 settings-store.js 拆出来）。
 *
 * 分层：cordis 插件配置（基础层）← 用户 JSON（覆盖层）→ resolveConfig 校验。
 * 文件读写在 dsh/settings-file.js；字段白名单/公开视图在 core/config-schema.js。
 * 这里只做「合并 + 校验 + 回落 + 热替换 + 错误上报」。
 *
 * A4（2026-10-20）：
 * - 用户文件「合法 JSON + 非法值」不再让插件整体不激活：回落基础配置，
 *   把 `settingsError{field,message}` 交给设置页展示。
 * - 文件写成 `{v:1,config:{...}}` 信封；读侧兼容旧扁平文件。
 */
import { resolveConfig } from '../config.js';
import { paletteForBothSchemes } from '../core/colors.js';
import { handoffGuard } from '../core/handoff-guard.js';
import { isPlainObject } from '../core/object.js';
import { readNativeCompaction } from '../dsh/native-compaction.js';
import { filterSettingsPatch, publicConfigOf } from '../core/config-schema.js';
import {
  defaultSettingsPath,
  readPackageVersion,
  readSettingsFile,
  removeSettingsFile,
  writeSettingsFile,
} from '../dsh/settings-file.js';

export { defaultSettingsPath } from '../dsh/settings-file.js';

/** 深合并普通对象；数组/标量直接覆盖。 */
function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/**
 * 把异常统一成 `{field,message}`；field 只用于定位，不写进设置文件。
 * @param {unknown} error
 * @returns {{field:string|null,message:string}}
 */
function toSettingsError(error) {
  return {
    field: error !== null && typeof error === 'object' && typeof error.field === 'string' ? error.field : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * @param {{config?:object, file?:string}} [options]
 */
export function createSettingsStore({ config = {}, file = defaultSettingsPath() } = {}) {
  const base = isPlainObject(config) ? config : {};
  const loaded = readSettingsFile(file);
  let user = loaded.user;
  let settingsError = loaded.error;
  let current;

  if (settingsError === null) {
    try {
      current = resolveConfig(deepMerge(base, user));
    } catch (error) {
      // 用户覆盖层非法：忽略它，回落基础配置；错误留给设置页显示。
      settingsError = toSettingsError(error);
      user = {};
    }
  }
  if (current === undefined) {
    try {
      current = resolveConfig(base);
    } catch (error) {
      if (settingsError === null) settingsError = toSettingsError(error);
      // 连基础配置都非法时，保证插件仍能启动（用默认值），错误照常上报。
      current = resolveConfig({});
    }
  }

  // 设置页「恢复默认」显示的基准：cordis 基础配置（坏的话用默认值兜底）。
  let baseResolved;
  try {
    baseResolved = resolveConfig(base);
  } catch {
    baseResolved = resolveConfig({});
  }

  const listeners = new Set();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        /* 单个监听器失败不影响保存 */
      }
    }
  };

  const view = () => ({
    config: publicConfigOf(current),
    defaults: publicConfigOf(baseResolved),
    // A8：浅/深两套派生色板（设置页预览可用；未保存编辑仍走客户端纯函数）。
    palettes: paletteForBothSchemes(current.colors),
    windowFallback: current.contextWindowFallback,
    version: readPackageVersion(),
    // 0.3.1：DSH 原生自动压缩配置（设置页开关 / 交接线上限校验用）。
    native: (() => {
      const nativeCfg = readNativeCompaction();
      return { autoEnabled: nativeCfg.autoEnabled, thresholdRatio: nativeCfg.thresholdRatio, file: nativeCfg.file };
    })(),
    path: file,
    settingsError: settingsError === null ? null : { ...settingsError },
  });

  return {
    /** 当前生效的完整配置（readState / actions 每次调用时读）。 */
    get current() {
      return current;
    },
    /** 当前设置文件问题（用于 state/设置页提示）；null=正常。 */
    get error() {
      return settingsError === null ? null : { ...settingsError };
    },
    filePath: file,
    view,
    /**
     * 合并保存一组设置；先校验再写盘，最后热替换当前配置。
     * @param {object} patch
     * @param {{nativeRatio?:number|null}} [options]
     *   0.4.2：客户端传入的「当前模型实际触发线」（state.native.ratio）。
     *   带了就按「实际线 −5pp」校验交接线；没带 / 非法（旧客户端、无会话）退回配置阈值防呆。
     * @returns {object} 最新 view
     */
    save(patch, { nativeRatio = null } = {}) {
      const filtered = filterSettingsPatch(patch);
      if (Object.keys(filtered).length === 0) throw new Error('没有可保存的设置项');
      const nextUser = deepMerge(user, filtered);
      // 先校验，失败不落盘
      let next;
      try {
        next = resolveConfig(deepMerge(base, nextUser));
      } catch (error) {
        const wrapped = new Error(error instanceof Error ? error.message : String(error));
        wrapped.field = error !== null && typeof error === 'object' ? error.field : undefined;
        throw wrapped;
      }
      // 0.4.2（P0-2）：交接线硬上限与 UI 同口径 —— 实际触发线 −5pp（整数百分位）。
      // 实际线算不出（未带 nativeRatio / 无会话）时退回配置阈值 −1pp 防呆，与 0.4.1 一致；
      // 原生自动压缩关闭时不校验（没有「DSH 先压」的截止线）。一律拒绝 + 给目标值，不静默夹紧。
      const nativeCfg = readNativeCompaction();
      const guard = handoffGuard({
        actualRatio: nativeRatio,
        configuredRatio: nativeCfg.thresholdRatio,
        handoffRatio: next.thresholds.handoffRatio,
        compactRatio: next.thresholds.compactRatio,
        autoEnabled: nativeCfg.autoEnabled,
        fallback: 'configured',
      });
      if (!guard.ok) {
        const wrapped = new Error(guard.message);
        wrapped.field = 'thresholds.handoffRatio';
        throw wrapped;
      }
      // A4：信封装盘；旧扁平文件在这时自动升级，不丢用户设置。
      writeSettingsFile(file, nextUser);
      user = nextUser;
      current = next;
      settingsError = null;
      notify();
      return view();
    },
    /** 删除用户覆盖，回到默认（含 cordis 基础配置）。 */
    reset() {
      removeSettingsFile(file);
      user = {};
      settingsError = null;
      try {
        current = resolveConfig(base);
      } catch {
        current = resolveConfig({});
      }
      notify();
      return view();
    },
    /** 配置热替换回调；返回取消函数。 */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
    },
  };
}

export default createSettingsStore;
