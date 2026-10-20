/**
 * 配置 schema —— 所有配置项的唯一清单。
 *
 * 加一个设置项只改这里：默认值、类型/范围校验、中文文案、设置页白名单、
 * 公开视图（publicConfig）全部由这张表派生。config.js 只负责合并兼容写法与颜色归一。
 *
 * 字段标志：
 * - `editable`: 允许从设置栏写入 `compact-relay.json`（filterPatch 白名单）
 * - `view`:     出现在设置栏读取的公开视图里（publicConfig）
 * - `internal`: 内部配置（不出现在设置页，也不允许设置页写）
 */
import os from 'node:os';
import path from 'node:path';

/**
 * 展开开头的 `~`（只认 `~` 或 `~/`；`~user` 形式不猜）。
 * @param {string} value
 * @returns {string}
 */
export function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * 默认 DSH home：优先环境变量 DSH_HOME（隔离复刻/测试会用），否则 ~/.dsh。
 * @returns {string}
 */
export function defaultDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return path.resolve(expandHome(fromEnv));
  }
  return path.join(os.homedir(), '.dsh');
}

function field(pathParts, options) {
  return Object.freeze({
    path: Object.freeze(pathParts),
    label: options.label,
    kind: options.kind,
    values: options.values === undefined ? undefined : Object.freeze(options.values),
    max: options.max,
    default: options.default,
    editable: options.editable === true,
    view: options.view === true,
  });
}

/**
 * 单表：路径 / 类型 / 默认值 / 中文标签 / 是否设置页可改。
 * 顺序即设置页展示顺序（settings 面板里仍按自己的分组渲染，这里只管数据）。
 */
export const CONFIG_FIELDS = Object.freeze([
  // 0.3.1：「值得压缩」的最小线——低于它压缩不划算（摘要可能比原文还大），模型不会建议压缩。
  field(['thresholds', 'minRatio'], { label: '最小压缩线', kind: 'ratio', default: 0.05, editable: true, view: true }),
  field(['thresholds', 'compactRatio'], { label: '压缩提醒线', kind: 'ratio', default: 0.4, editable: true, view: true }),
  field(['thresholds', 'handoffRatio'], { label: '交接提醒线', kind: 'ratio', default: 0.6, editable: true, view: true }),
  // P3-02：必须 ≥1。0 在策略层会同时触发「恒交接 + 恒合并旧摘要」，没有可用语义，
  // 以前允许 0 会让指示灯永远停在交接状态；现在保存 0 直接给中文校验错误。
  field(['thresholds', 'maxSummaries'], { label: '摘要份数上限', kind: 'positiveInt', default: 6, editable: true, view: true }),
  field(['contextWindowFallback'], { label: '兜底窗口', kind: 'positiveInt', default: 1_000_000 }),
  field(['retention', 'recentTailTokens'], { label: '保留近期原文', kind: 'nonNegativeInt', default: 40_000, editable: true, view: true }),
  field(['summary', 'maxTokens'], { label: '摘要输出上限', kind: 'positiveInt', default: 8_192 }),
  field(['handoff', 'maxTokens'], { label: '交接单输出上限', kind: 'positiveInt', default: 8_192 }),
  field(['timeouts', 'llmMs'], { label: '模型调用超时', kind: 'positiveInt', default: 180_000 }),
  field(['dev', 'testRangeNodes'], { label: '测试取段条数', kind: 'positiveInt', default: 4 }),
  field(['handoffDir'], {
    label: '交接单目录',
    kind: 'path',
    default: () => path.join(defaultDshHome(), 'handoffs'),
    editable: true,
    view: true,
  }),
  field(['colors', 'mode'], { label: '颜色模式', kind: 'enum', values: ['auto', 'light', 'dark'], default: 'auto', editable: true, view: true }),
  field(['colors', 'autoAdapt'], { label: '自动适配颜色', kind: 'boolean', default: true, editable: true, view: true }),
  field(['colors', 'base', 'idle'], { label: '默认颜色', kind: 'color', default: '#6F7680', editable: true, view: true }),
  field(['colors', 'base', 'stage'], { label: '填满颜色', kind: 'color', default: '#2563EB', editable: true, view: true }),
  field(['colors', 'base', 'pin'], { label: '锁定颜色', kind: 'color', default: '#C026D3', editable: true, view: true }),
  field(['colors', 'base', 'compact'], { label: '调整颜色', kind: 'color', default: '#C26A00', editable: true, view: true }),
  field(['colors', 'base', 'handoff'], { label: '上限颜色', kind: 'color', default: '#D92D20', editable: true, view: true }),
  // 0.3.1：仓库已建（cfanzx/dsh-compact-relay），默认指向仓库内的教程与 Issues；
  // 用户仍可在设置文件里覆盖 links.tutorial / links.feedback。
  field(['links', 'tutorial'], { label: '使用教程链接', kind: 'urlOrEmpty', default: 'https://github.com/cfanzx/dsh-compact-relay/blob/main/TUTORIAL.md', view: true }),
  field(['links', 'feedback'], { label: '反馈链接', kind: 'urlOrEmpty', default: 'https://github.com/cfanzx/dsh-compact-relay/issues', view: true }),
]);

/** 路径 → 字段 的索引。 */
const FIELD_BY_PATH = new Map(CONFIG_FIELDS.map((item) => [item.path.join('.'), item]));

/**
 * @param {string[]} pathParts
 * @returns {object|undefined}
 */
export function fieldAt(pathParts) {
  return FIELD_BY_PATH.get(pathParts.join('.'));
}

/**
 * 合并后的配置对象里取一个路径的值。
 * @param {object} object
 * @param {readonly string[]} pathParts
 * @returns {unknown}
 */
export function getAt(object, pathParts) {
  let cursor = object;
  for (const key of pathParts) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * 往对象里写一个路径（就地写；调用方负责保证起点是新对象）。
 * @param {object} object
 * @param {readonly string[]} pathParts
 * @param {unknown} value
 */
export function setAt(object, pathParts, value) {
  let cursor = object;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const key = pathParts[index];
    if (cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[pathParts[pathParts.length - 1]] = value;
}

/**
 * 递归冻结普通对象/数组（默认配置只读）。
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 按 schema 生成一份默认配置。
 * @returns {object}
 */
export function buildDefaultConfig() {
  const out = {};
  for (const item of CONFIG_FIELDS) {
    const value = typeof item.default === 'function' ? item.default() : item.default;
    setAt(out, item.path, value);
  }
  return out;
}

/** 默认配置（由 schema 派生；模块加载时冻结一次）。 */
export const DEFAULT_CONFIG = deepFreeze(buildDefaultConfig());

/** 配置错误：带字段路径与中文文案，设置页/日志可定位到具体项。 */
export class ConfigError extends Error {
  /**
   * @param {object} item schema 字段
   * @param {string} message 中文说明（不含字段名）
   * @param {unknown} [value] 实际值（只用于文案，不写进设置文件）
   */
  constructor(item, message, value) {
    const suffix = value === undefined ? '' : `（当前值：${formatValue(value)}）`;
    super(`「${item.label}」${message}${suffix}`);
    this.name = 'ConfigError';
    this.field = item.path.join('.');
    this.fieldLabel = item.label;
    this.value = value;
  }
}

/**
 * 抛一个带字段路径的配置错误。
 * @param {string[]} pathParts
 * @param {string} message
 * @param {unknown} [value]
 * @returns {never}
 */
export function failConfig(pathParts, message, value) {
  const item = fieldAt(pathParts);
  if (item === undefined) throw new Error(`compact-relay: 未知配置字段 ${pathParts.join('.')}`);
  throw new ConfigError(item, message, value);
}

function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const INTEGER_HINT = '必须是正整数';

/**
 * 校验一个字段值；合法返回 null，不合法返回中文原因（不含字段名）。
 * @param {object} item
 * @param {unknown} value
 * @returns {string|null}
 */
export function validateFieldValue(item, value) {
  switch (item.kind) {
    case 'ratio':
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
        return '必须是 0 到 1 之间的小数（例如 0.4 表示 40%）';
      }
      return null;
    case 'positiveInt': {
      if (!Number.isInteger(value) || value <= 0) return INTEGER_HINT;
      if (typeof item.max === 'number' && value > item.max) return `不能超过 ${item.max}`;
      return null;
    }
    case 'nonNegativeInt':
      return Number.isInteger(value) && value >= 0 ? null : '必须是非负整数';
    case 'boolean':
      return typeof value === 'boolean' ? null : '必须是开/关（true/false）';
    case 'enum':
      return item.values.includes(value) ? null : `只能是 ${item.values.join(' / ')}`;
    case 'color':
      return typeof value === 'string' && value.trim().length > 0 ? null : '不能为空，必须是颜色值（如 #6F7680）';
    case 'path':
      return typeof value === 'string' && value.length > 0 ? null : '不能为空';
    case 'urlOrEmpty':
      if (typeof value !== 'string') return '必须是字符串';
      if (value.length > 0 && !/^https?:\/\//i.test(value)) return '必须是 http(s) 链接，或留空';
      return null;
    default:
      return `未知类型 ${item.kind}`;
  }
}

/**
 * 校验完整配置里的所有非颜色字段（颜色由 config.js 的颜色归一逻辑校验，
 * 以保留旧扁平颜色结构的兼容）。
 * @param {object} cfg
 */
export function validateConfig(cfg) {
  for (const item of CONFIG_FIELDS) {
    if (item.path[0] === 'colors') continue;
    const value = getAt(cfg, item.path);
    const problem = validateFieldValue(item, value);
    if (problem !== null) throw new ConfigError(item, problem, value);
  }
}

/**
 * 只保留设置栏允许写入的字段（派生自 schema.editable）。
 * @param {object} patch
 * @returns {object}
 */
export function filterSettingsPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('设置必须是 JSON 对象');
  }
  const out = {};
  for (const item of CONFIG_FIELDS) {
    if (!item.editable) continue;
    const value = getAt(patch, item.path);
    if (value !== undefined) setAt(out, item.path, value);
  }
  return out;
}

/**
 * 设置栏读取用的公开视图（派生自 schema.view）。
 * @param {object} cfg
 * @returns {object}
 */
export function publicConfigOf(cfg) {
  const out = {};
  for (const item of CONFIG_FIELDS) {
    if (!item.view) continue;
    setAt(out, item.path, getAt(cfg, item.path));
  }
  return out;
}
