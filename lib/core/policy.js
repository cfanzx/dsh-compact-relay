/**
 * 阈值判定 —— 纯函数，零依赖。
 *
 * 指示灯、菜单、命令、HTTP 全都读这里的结论；
 * 客户端不再自己拿 token 算一遍。
 */

/**
 * 综合压力与摘要份数给出建议。
 * @param {{pressure: number|null, summaries: number, thresholds: {compactAt:number, handoffAt:number, maxSummaries:number}}} input
 * @returns {'none'|'compact'|'handoff'}
 */
export function adviceFor({ pressure, summaries = 0, thresholds }) {
  if (summaries >= thresholds.maxSummaries) return 'handoff';
  if (pressure == null) return 'none';
  if (pressure >= thresholds.handoffAt) return 'handoff';
  if (pressure >= thresholds.compactAt) return 'compact';
  return 'none';
}

/**
 * 把「窗口比例阈值」换算成当前模型窗口下的绝对 token 线。
 *
 * 配置只存 compactRatio/handoffRatio（0–1 之间的比例），测量出真实窗口后
 * 再换算，换 1M/200k/128k 窗口的模型都不会出现「阈值超过窗口、永不触发」。
 *
 * @param {{compactRatio:number, handoffRatio:number, maxSummaries:number}} thresholds
 * @param {number} window 当前模型的上下文窗口（正数）
 * @returns {{compactAt:number, handoffAt:number, maxSummaries:number, compactRatio:number, handoffRatio:number, window:number}}
 */
export function thresholdsForWindow(thresholds, window) {
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
    throw new Error('compact-relay: context window must be a positive number');
  }
  const compactAt = Math.max(1, Math.round(window * thresholds.compactRatio));
  const handoffAt = Math.max(compactAt + 1, Math.round(window * thresholds.handoffRatio));
  return {
    compactAt: Math.min(compactAt, window - 1),
    handoffAt: Math.min(handoffAt, window),
    maxSummaries: thresholds.maxSummaries,
    compactRatio: thresholds.compactRatio,
    handoffRatio: thresholds.handoffRatio,
    window,
  };
}

/**
 * 上下文占用比例，夹在 [0,1]。
 * @param {number|null} pressure
 * @param {number} window
 * @returns {number}
 */
export function ratioOf(pressure, window) {
  if (pressure == null || !Number.isFinite(window) || window <= 0) return 0;
  return Math.min(1, Math.max(0, pressure / window));
}

/** 压缩范围至少要比摘要大这么多 token 才划算（摘要 ~1K，留 4 倍安全系数）。 */
export const MIN_COMPRESS_TOKENS = 4_000;

/**
 * 「值得压缩」的最小容量比例（最小线，0.3.1）。
 *
 * 判断标准：压缩后净收益必须为正。两个来源取较大者：
 * - 用户配置的 `thresholds.minRatio`（默认 5%）；
 * - 动态下限：(保留近期原文 + 最小可压 token) / 窗口——小窗口模型下 5% 可能
 *   根本压不出净收益（比如 200K 窗口保留 40K 时，5% = 10K 还在保留区里）。
 *
 * @param {{minRatio?:number}} thresholds
 * @param {{recentTailTokens?:number}} retention
 * @param {number} window 当前模型窗口
 * @returns {number} 0–1
 */
export function compressionMinRatio(thresholds, retention, window) {
  const configured = typeof thresholds?.minRatio === 'number' && Number.isFinite(thresholds.minRatio) ? thresholds.minRatio : 0.05;
  const tail = typeof retention?.recentTailTokens === 'number' && Number.isFinite(retention.recentTailTokens) ? retention.recentTailTokens : 40_000;
  const floorRatio = typeof window === 'number' && Number.isFinite(window) && window > 0 ? (tail + MIN_COMPRESS_TOKENS) / window : 0;
  return Math.max(configured, Math.min(0.95, floorRatio));
}

/**
 * 精压策略：旧摘要什么时候允许被合并（泄压阀）。
 *
 * 默认「不二压」：跳过旧摘要、只压 checkpoint 之后的内容。
 * 摘要份数到上限后才允许合并旧摘要，防止摘要无限堆积。
 *
 * @param {{summaries: number, thresholds: {maxSummaries: number}}} input
 * @returns {{allowMergeOldSummaries: boolean}}
 */
export function compactionPolicy({ summaries, thresholds }) {
  return { allowMergeOldSummaries: summaries >= thresholds.maxSummaries };
}

