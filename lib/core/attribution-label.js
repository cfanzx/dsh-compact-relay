/**
 * 压缩归属的**展示文案**（0.5.6 Phase D2）—— 纯函数、零依赖、零 IO。
 *
 * 为什么单独一层：同一条归属要出现在三处（checkpoint 摘要头、完成 toast/命令卡、
 * 悬停卡与「查看上次压缩」面板），服务端与浏览器半必须用同一份措辞；浏览器半
 * 通过 `scripts/build-client.mjs` 的 `/* @inline *\/` 内联本模块，所以这里：
 *   1. 不许 import（内联会把 import 行原样带进 bundle）；
 *   2. 不许碰 Node API / 时钟 / 随机（内联后浏览器要能直接跑）。
 *
 * 口径（总计划 D2 / task-3 §3.4，冻结）：
 *   trigger：ui-menu→菜单压缩、ui-ring→环压缩、command→命令压缩、handoff→交接压缩、
 *            native-auto→DSH 原生自动、external/unknown/其他→来源不明；
 *   actor：  user→用户、system→系统、unknown/其他→不明。
 *
 * 红线：这里**只做措辞映射**，不做任何推断。trigger 缺失/非法一律「来源不明」，
 * 绝不根据 `turn`/`summaries`/时间等旁证猜测触发者（task-3 §1 第 5 条）。
 */

/** 没有任何归属记录时的统一文案（历史压缩/老 checkpoint）；不猜、不暗示。 */
export const NO_ATTRIBUTION_LABEL = '来源不明（无归属记录）';

/** trigger → 中文名（冻结；改这里等于改用户可见文案）。 */
export const TRIGGER_LABELS = Object.freeze({
  'ui-menu': '菜单压缩',
  'ui-ring': '环压缩',
  command: '命令压缩',
  handoff: '交接压缩',
  'native-auto': 'DSH 原生自动',
  external: '来源不明',
  unknown: '来源不明',
});

/** actor → 中文名（冻结）。 */
export const ACTOR_LABELS = Object.freeze({
  user: '用户',
  system: '系统',
  unknown: '不明',
});

/** merged（是否合并了旧摘要）→ 中文名；null = 不知道。 */
export const MERGED_LABELS = Object.freeze({
  merged: '已合并旧摘要',
  plain: '未合并旧摘要',
  unknown: '合并情况未知',
});

/** trigger 归一成已知键；缺失/非法 → 'unknown'（不猜）。 */
export function normalizeTriggerKey(trigger) {
  const key = typeof trigger === 'string' ? trigger.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(TRIGGER_LABELS, key) ? key : 'unknown';
}

/** trigger 的中文名；未知 → 「来源不明」。 */
export function triggerLabelOf(trigger) {
  return TRIGGER_LABELS[normalizeTriggerKey(trigger)];
}

/** actor 的中文名；缺失/非法 → 「不明」。 */
export function actorLabelOf(actor) {
  const key = typeof actor === 'string' ? actor.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(ACTOR_LABELS, key) ? ACTOR_LABELS[key] : ACTOR_LABELS.unknown;
}

/**
 * 一行归属的括注：`菜单压缩（用户）`。
 * @param {{trigger?:unknown, actor?:unknown}|null} row
 */
export function attributionLabelOf(row) {
  const source = row !== null && typeof row === 'object' ? row : {};
  return `${triggerLabelOf(source.trigger)}（${actorLabelOf(source.actor)}）`;
}

/** 归属行 or（无记录时）统一文案；绝不返回任何猜出来的触发者。 */
export function attributionLabelOrNoRecord(row) {
  return row === null || row === undefined ? NO_ATTRIBUTION_LABEL : attributionLabelOf(row);
}

/** compactionId 的前 8 位（checkpoint 行/调试位用）；无 id → null。 */
export function compactionIdShort(compactionId) {
  if (typeof compactionId !== 'string') return null;
  const text = compactionId.trim();
  if (text.length === 0) return null;
  return text.slice(0, 8);
}

/**
 * token 的短写法：`32.5k` / `900`。
 * 与客户端 `fmt`（32.5K）刻意不同：这里出现在给模型读的 checkpoint 行与悬停卡，
 * 统一小写 k，避免同一数字两处写法不一致。
 * @param {unknown} tokens
 * @returns {string|null} 不是有限数字 → null（调用方显示「未知」，不显示 0）
 */
export function tokensShortOf(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return null;
  if (tokens < 1000) return String(Math.round(tokens));
  const thousands = Math.round(tokens / 100) / 10;
  return `${Number.isInteger(thousands) ? thousands.toFixed(1) : String(thousands)}k`;
}

/** merged → 中文名（null/缺失 = 不知道）。 */
export function mergedLabelOf(merged) {
  if (merged === true) return MERGED_LABELS.merged;
  if (merged === false) return MERGED_LABELS.plain;
  return MERGED_LABELS.unknown;
}

function countSegmentOf(range) {
  const count = range !== null && typeof range === 'object' ? range.count : null;
  return typeof count === 'number' && Number.isFinite(count) && count >= 0
    ? `${Math.round(count)} 条`
    : '条数未知';
}

function tokensSegmentOf(range) {
  const tokens = range !== null && typeof range === 'object' ? range.tokens : null;
  const short = tokensShortOf(tokens);
  return short === null ? 'token 未知' : `${short} tokens`;
}

/**
 * checkpoint 摘要头的那一行（**只写不解析**）：
 *   〔压缩归属：菜单压缩·用户｜22 条｜32.5k tokens｜未合并旧摘要｜#a1b2c3d4〕
 *
 * 缺字段时用「未知」占位，绝不填 0 或猜一个值；整行永不为空（至少含来源与角色）。
 * @param {object|null} row 内存中的归属对象（compactionId/trigger/actor/range/merged）
 * @returns {string}
 */
export function attributionLineOf(row) {
  const source = row !== null && typeof row === 'object' ? row : {};
  const segments = [
    `${triggerLabelOf(source.trigger)}·${actorLabelOf(source.actor)}`,
    countSegmentOf(source.range),
    tokensSegmentOf(source.range),
    mergedLabelOf(source.merged),
  ];
  const short = compactionIdShort(source.compactionId);
  if (short !== null) segments.push(`#${short}`);
  return `〔压缩归属：${segments.join('｜')}〕`;
}
