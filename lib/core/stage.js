/**
 * 标记进度（M4，内部代号「阶段标记」）—— 纯数据与纯判定，不依赖 DSH。
 *
 * 模型调 `mark_stage` 工具时，往会话日志追加一条 plugin record：
 *   plugin:compact-relay/stage   data: { label, at, ratio }
 *
 *   ratio 是标记那一刻的容量比例（0–1），用来在指示灯的环上标出「标记位置」；
 *   旧记录没有这个字段时按 null 处理（环上退化成标记当前比例）。
 *
 * plugin record 是 DSH 0.2 的「插件私有事件」：`ignorable`、不进模型可见 surface、
 * 跟着会话落盘/分叉/迁移。所以「阶段完成」不会被压缩掉，重启后也还在。
 */

/** 记录类型（DSH 语法：`plugin:` + 小写段；只认精确匹配，不收别的插件）。 */
export const STAGE_RECORD_TYPE = 'plugin:compact-relay/stage';

/** 没给 label 时的默认阶段名。 */
export const STAGE_DEFAULT_LABEL = '本阶段完成';

/** label 长度上限（超了截断，避免把整段话塞进指示灯标题）。 */
export const STAGE_LABEL_MAX = 80;

/**
 * 规范化阶段名：去首尾空白、折叠连续空白、超长截断；空值回落到默认名。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeStageLabel(raw) {
  if (typeof raw !== 'string') return STAGE_DEFAULT_LABEL;
  const text = raw.replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return STAGE_DEFAULT_LABEL;
  // 用码点截断，别切裂 emoji 的 surrogate pair（截出孤立代理会显示成 �）。
  const chars = Array.from(text);
  return chars.length > STAGE_LABEL_MAX ? `${chars.slice(0, STAGE_LABEL_MAX - 1).join('')}…` : text;
}

/**
 * 该事件是不是本插件的阶段记录。
 * plugin record 的判定 = `ignorable === true` + 类型精确匹配（我们只写自己的类型）。
 * @param {unknown} event
 * @returns {boolean}
 */
export function isStageRecordEvent(event) {
  return event !== null && typeof event === 'object' && event.ignorable === true && event.type === STAGE_RECORD_TYPE;
}

/**
 * 从会话事件流里取最近的 N 条阶段标记（最新的在前）。
 *
 * 0.3.1：从「只取最新一条」升级为「保留最近几个」——指示灯环上可以同时画出多个
 * 阶段块（最新的最亮，旧的半透明）。`limit` 由配置 `stage.maxMarks` 决定（1–10）。
 *
 * @param {object[]} events
 * @param {number} [limit=3]
 * @returns {{label:string, at:number, seq:number, ratio:number|null}[]}
 */
export function latestStageMarks(events, limit = 3) {
  if (!Array.isArray(events)) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : 3;
  const marks = [];
  for (const event of events) {
    if (!isStageRecordEvent(event)) continue;
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;
    const at = typeof data.at === 'number' && Number.isFinite(data.at) ? data.at : 0;
    const ratio =
      typeof data.ratio === 'number' && Number.isFinite(data.ratio)
        ? Math.max(0, Math.min(1, data.ratio))
        : null;
    marks.push({ label: normalizeStageLabel(data.label), at, seq: event.seq, ratio });
  }
  return marks.slice(-cap).reverse();
}

/**
 * 从会话事件流里取最近一条阶段标记；没有或数据不合法返回 null。
 * @param {object[]} events
 * @returns {{label:string, at:number, seq:number, ratio:number|null}|null}
 */
export function latestStageMark(events) {
  return latestStageMarks(events, 1)[0] ?? null;
}

/**
 * 标记进度是否「仍然新鲜」：要比最后一次压缩 checkpoint 新才算数。
 *
 * 这样压缩/交接之后圆环自动恢复常态，不用额外写「清除」记录。
 * @param {{seq:number}|null} mark
 * @param {number|undefined} checkpointSeq 最后一次 checkpoint 消息的 event seq
 * @returns {boolean}
 */
export function stageIsActive(mark, checkpointSeq) {
  if (mark === null || mark === undefined) return false;
  if (!Number.isInteger(checkpointSeq)) return true;
  return mark.seq > checkpointSeq;
}
