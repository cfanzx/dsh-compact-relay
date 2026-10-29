/**
 * 配置合并与校验。
 *
 * 字段清单、默认值、中文校验文案都在 core/config-schema.js（A4：单表派生）。
 * 这里只负责：cordis 基础配置 + 用户覆盖层的深合并、旧写法兼容（绝对阈值/扁平颜色）、
 * 颜色派生前的归一化。
 */
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  expandHome,
  failConfig,
  fieldAt,
  validateConfig,
} from './core/config-schema.js';
import { isPlainObject } from './core/object.js';
import { normalizeFavoriteWords } from './core/favorite-score.js';

// 兼容旧导入：其它模块/文档仍可从 config.js 拿默认配置与路径工具。
export { CONFIG_FIELDS, DEFAULT_CONFIG, defaultDshHome, expandHome } from './core/config-schema.js';

const COLOR_KEYS = ['idle', 'stage', 'pin', 'compact', 'handoff'];
const COLOR_MODES = fieldAt(['colors', 'mode']).values;
const BASE_COLOR_DEFAULTS = {
  idle: fieldAt(['colors', 'base', 'idle']).default,
  stage: fieldAt(['colors', 'base', 'stage']).default,
  pin: fieldAt(['colors', 'base', 'pin']).default,
  compact: fieldAt(['colors', 'base', 'compact']).default,
  handoff: fieldAt(['colors', 'base', 'handoff']).default,
};

function objectOf(raw, key) {
  return isPlainObject(raw[key]) ? raw[key] : {};
}

/**
 * 颜色配置归一化：
 * - 新结构 `{ mode, autoAdapt, base:{idle,compact,handoff,pin,stage} }`；
 * - 兼容旧结构 `{ idle, stage, compact, handoff }`：当作 base，且默认关掉自动适配
 *   （旧版本来就是一套颜色用到底，保持原样）；
 * - 逐字段校验：给了就必须是非空字符串（合法 CSS 颜色）。
 * @param {object} raw
 * @returns {{mode:string, autoAdapt:boolean, base:object}}
 */
function normalizeColors(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const mode = input.mode ?? DEFAULT_CONFIG.colors.mode;
  if (!COLOR_MODES.includes(mode)) failConfig(['colors', 'mode'], `只能是 ${COLOR_MODES.join(' / ')}`, mode);
  if (input.autoAdapt !== undefined && typeof input.autoAdapt !== 'boolean') {
    failConfig(['colors', 'autoAdapt'], '必须是开/关（true/false）', input.autoAdapt);
  }

  const take = (source) => {
    const out = {};
    for (const key of COLOR_KEYS) {
      const value = isPlainObject(source) ? source[key] : undefined;
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.trim().length === 0) {
        failConfig(['colors', 'base', key], '不能为空，必须是颜色值（如 #6F7680）', value);
      }
      out[key] = value.trim();
    }
    return out;
  };
  const legacy = take(input);
  const hasLegacy = Object.keys(legacy).length > 0;
  const base = { ...BASE_COLOR_DEFAULTS, ...legacy, ...take(input.base) };
  // 旧扁平结构默认关自动适配（保持旧观感）；新结构默认开。
  const autoAdapt = typeof input.autoAdapt === 'boolean' ? input.autoAdapt : !hasLegacy;
  return { mode, autoAdapt, base };
}

/**
 * 合并默认配置并做校验。未知键忽略（cordis 可能塞别的字段进来）。
 *
 * 阈值按**窗口比例**配置（compactRatio / handoffRatio）：换 1M / 200k / 128k
 * 窗口的模型都自动按比例缩放，不会出现「绝对阈值超过窗口、提示永不触发」。
 * 兼容旧版绝对写法（thresholds.compactAt/handoffAt 或顶层同名字段）：
 * 用 contextWindowFallback 折算成比例；新旧同时给时以比例为准。
 *
 * @param {object} [raw]
 * @returns {object}
 */
export function resolveConfig(raw = {}) {
  const input = isPlainObject(raw) ? raw : {};
  const thresholds = objectOf(input, 'thresholds');
  const retention = objectOf(input, 'retention');
  const summary = objectOf(input, 'summary');
  const handoff = objectOf(input, 'handoff');
  const timeouts = objectOf(input, 'timeouts');
  const dev = objectOf(input, 'dev');
  const colors = objectOf(input, 'colors');

  const windowFallback = input.contextWindowFallback ?? DEFAULT_CONFIG.contextWindowFallback;
  const legacyCompactAt = thresholds.compactAt ?? input.compactAt;
  const legacyHandoffAt = thresholds.handoffAt ?? input.handoffAt;
  const ratioFromLegacy = (value, pathParts) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      failConfig(pathParts, '旧版绝对阈值必须是正数（或改用窗口比例 0~1）', value);
    }
    return value / windowFallback;
  };

  const merged = {
    thresholds: {
      compactRatio:
        thresholds.compactRatio ??
        ratioFromLegacy(legacyCompactAt, ['thresholds', 'compactRatio']) ??
        DEFAULT_CONFIG.thresholds.compactRatio,
      handoffRatio:
        thresholds.handoffRatio ??
        ratioFromLegacy(legacyHandoffAt, ['thresholds', 'handoffRatio']) ??
        DEFAULT_CONFIG.thresholds.handoffRatio,
      maxSummaries: thresholds.maxSummaries ?? DEFAULT_CONFIG.thresholds.maxSummaries,
      minRatio: thresholds.minRatio ?? DEFAULT_CONFIG.thresholds.minRatio,
    },
    contextWindowFallback: windowFallback,
    retention: {
      recentTailTokens: retention.recentTailTokens ?? DEFAULT_CONFIG.retention.recentTailTokens,
    },
    summary: {
      maxTokens: summary.maxTokens ?? DEFAULT_CONFIG.summary.maxTokens,
    },
    handoff: {
      maxTokens: handoff.maxTokens ?? DEFAULT_CONFIG.handoff.maxTokens,
    },
    timeouts: {
      llmMs: timeouts.llmMs ?? DEFAULT_CONFIG.timeouts.llmMs,
    },
    dev: {
      testRangeNodes: dev.testRangeNodes ?? DEFAULT_CONFIG.dev.testRangeNodes,
    },
    // 配置里允许写 `~/...`：统一展开成绝对路径，别在 cwd 下建字面 `~` 目录。
    handoffDir: path.resolve(
      typeof input.handoffDir === 'string' && input.handoffDir.length > 0
        ? expandHome(input.handoffDir)
        : DEFAULT_CONFIG.handoffDir,
    ),
    // 0.5.3 P1-6：推荐收藏配置（词表规范化：去空白/去重/截长/限量）。
    favorite: {
      enabled: input.favorite?.enabled ?? DEFAULT_CONFIG.favorite.enabled,
      level: input.favorite?.level ?? DEFAULT_CONFIG.favorite.level,
      mustWords: normalizeFavoriteWords(input.favorite?.mustWords ?? DEFAULT_CONFIG.favorite.mustWords),
      muteWords: normalizeFavoriteWords(input.favorite?.muteWords ?? DEFAULT_CONFIG.favorite.muteWords),
    },
    colors: normalizeColors(colors),
    links: {
      tutorial: input.links?.tutorial ?? DEFAULT_CONFIG.links.tutorial,
      feedback: input.links?.feedback ?? DEFAULT_CONFIG.links.feedback,
    },
  };

  // schema 里的所有非颜色字段统一校验（中文文案由 schema 提供）。
  validateConfig(merged);

  const { compactRatio, handoffRatio, minRatio } = merged.thresholds;
  if (minRatio >= compactRatio) {
    failConfig(
      ['thresholds', 'minRatio'],
      '必须小于「压缩提醒线」；最小压缩线是「值得压缩」的门槛，要在压缩线之前',
      minRatio,
    );
  }
  if (compactRatio >= handoffRatio) {
    failConfig(
      ['thresholds', 'compactRatio'],
      '必须小于「交接提醒线」；压缩线要在交接线之前，否则会先建议换会话',
      compactRatio,
    );
  }

  return merged;
}
