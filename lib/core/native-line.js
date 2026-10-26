/**
 * 0.4 P2-3：DSH 原生自动压缩的**真实触发线**（纯函数，零依赖）。
 *
 * 背景（BUG-012 后续 / Win 真实会话 session-1f90f5ee）：
 * 指示灯过去把 compaction-basic 的 `thresholdRatio` 直接当触发线显示（默认 80%），
 * 但 DSH 实际判断压力用的是 token 数，公式（见 dsh-compaction-basic 源码）：
 *
 *   messageBudgetTokens  = contextWindow − reservedCompletionTokens
 *   pressureBudgetTokens = messageBudgetTokens − headroomTokens
 *   thresholdTokens      = floor(min(contextWindow × thresholdRatio, pressureBudgetTokens))
 *   真实触发点           = thresholdTokens / contextWindow
 *
 * 其中：
 *   - contextWindow：路由模型的上下文窗口（dcr 已从 ctx.llm.resolveModelInfo 拿到）；
 *   - reservedCompletionTokens：该次路由请求给输出预留的 token 数
 *     = session.requestHeader().config.maxTokens ?? 适配器 defaultMaxTokens ?? 0；
 *   - headroomTokens：compaction-basic 的余量（默认 65536，可被全局或 modelPolicies 覆盖）。
 *
 * 只有 `min` 的第二项更小时（输出预留 + 余量把可用空间压下去），真实线才低于
 * 窗口比例；这时显示「原生自动压缩线 67.8%」而不是 80%。
 */

/** compaction-basic 的 headroomTokens 默认值（源码：?? 65536）。 */
export const NATIVE_HEADROOM_DEFAULT = 65536;

/**
 * compaction-basic 的 retainRatio 默认值（0.2.1-rc.3 源码：DEFAULT_RETAIN_RATIO = .16）。
 *
 * 只用于「预判原生压缩范围」：宿主没有把生效默认值暴露给插件，这里跟随
 * 0.2.1-rc.3 的源码常量。用户显式配置 retainRatio/retainTokens 时以配置为准。
 */
export const NATIVE_RETAIN_RATIO_DEFAULT = 0.16;

/**
 * 原生压缩的「保留近期尾部」预算（compaction-basic 的 retainTokens）：
 *   显式 retainTokens → 直接用；
 *   否则 floor(messageBudgetTokens × retainRatio)，messageBudget = 窗口 − 输出预留。
 * 与宿主 resolveCompactSpec 同口径。
 *
 * @param {{contextWindow:number|null, reservedCompletionTokens?:number, retainRatio?:number, retainTokens?:number}} input
 * @returns {number|null} 算不出返回 null
 */
export function nativeRetainTokensOf({ contextWindow, reservedCompletionTokens = 0, retainRatio, retainTokens } = {}) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  if (Number.isInteger(retainTokens) && retainTokens >= 0) return retainTokens;
  const reserved = Number.isFinite(reservedCompletionTokens) && reservedCompletionTokens >= 0 ? reservedCompletionTokens : 0;
  const budget = contextWindow - reserved;
  if (budget <= 0) return null;
  const ratio = Number.isFinite(retainRatio) && retainRatio >= 0 && retainRatio < 1 ? retainRatio : NATIVE_RETAIN_RATIO_DEFAULT;
  return Math.floor(budget * ratio);
}

/**
 * 计算真实触发线。
 *
 * @param {object} input
 * @param {number} input.contextWindow 路由上下文窗口（>0 的整数）
 * @param {number} [input.reservedCompletionTokens] 路由输出预留（缺省 0）
 * @param {number} input.thresholdRatio compaction-basic 有效窗口比例（0–1）
 * @param {number} [input.headroomTokens] 余量（缺省 NATIVE_HEADROOM_DEFAULT）
 * @returns {{ok:boolean, reason:string|null, thresholdTokens:number|null, ratio:number|null, pressureBudgetTokens:number|null, messageBudgetTokens:number|null}}
 *   ok=false 时 thresholdTokens/ratio 为 null，reason 说明原因（input/no-budget/overflow）
 */
export function nativeLineOf({ contextWindow, reservedCompletionTokens, thresholdRatio, headroomTokens } = {}) {
  const window = contextWindow;
  if (!Number.isFinite(window) || window <= 0) {
    return { ok: false, reason: 'input', thresholdTokens: null, ratio: null, pressureBudgetTokens: null, messageBudgetTokens: null };
  }
  const ratioCfg = thresholdRatio;
  if (!Number.isFinite(ratioCfg) || ratioCfg <= 0 || ratioCfg > 1) {
    return { ok: false, reason: 'input', thresholdTokens: null, ratio: null, pressureBudgetTokens: null, messageBudgetTokens: null };
  }
  const reserved = Number.isFinite(reservedCompletionTokens) && reservedCompletionTokens >= 0 ? reservedCompletionTokens : 0;
  const headroom = Number.isFinite(headroomTokens) && headroomTokens >= 0 ? headroomTokens : NATIVE_HEADROOM_DEFAULT;
  const messageBudget = window - reserved;
  const pressureBudget = messageBudget - headroom;
  if (pressureBudget <= 0) {
    return { ok: false, reason: 'no-budget', thresholdTokens: null, ratio: null, pressureBudgetTokens: pressureBudget, messageBudgetTokens: messageBudget };
  }
  const threshold = Math.floor(Math.min(window * ratioCfg, pressureBudget));
  if (!(threshold > 0) || threshold >= window) {
    return { ok: false, reason: 'overflow', thresholdTokens: threshold, ratio: null, pressureBudgetTokens: pressureBudget, messageBudgetTokens: messageBudget };
  }
  return {
    ok: true,
    reason: null,
    thresholdTokens: threshold,
    ratio: threshold / window,
    pressureBudgetTokens: pressureBudget,
    messageBudgetTokens: messageBudget,
  };
}
