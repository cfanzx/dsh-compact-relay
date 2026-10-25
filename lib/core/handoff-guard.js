/**
 * 交接线保命判定 —— 纯函数，零依赖（0.4.2）。
 *
 * 背景（0.4.1 遗留的三个洞，见 docs/0.4.2-implementation-plan.md）：
 * 1. 交接提醒线仍是配置值（默认 60%），换到实际触发线更低的模型（如 55%）时，
 *    DSH 会先自己压历史，dcr 的交接提醒来不及；
 * 2. 服务端保存校验只看配置阈值（80%），手改设置文件能设到 70%；
 * 3. 旧值不跟随当前模型，除设置页一行 warning 外没有其它可见提示。
 *
 * 0.4.2 规则（范围定稿）：
 *   交接提醒线 ≤ 实际触发线 − 5pp（HANDOFF_MARGIN_PP），向下取整到整数百分位。
 *   - 实际触发线来自 state.native.ratio（按当前路由模型实时算，见 core/native-line.js）；
 *   - 实际线算不出时：运行时不告警、不阻断；服务端保存退回配置阈值防呆（0.4.1 行为）；
 *   - DSH 原生自动压缩关闭时不存在「被抢先压缩」的截止线，不判定；
 *   - 只告警 / 拒绝，绝不静默改写用户配置。
 *
 * 本模块只做判定与文案，不做 IO：服务端 `lib/actions/settings.js` 直接 import，
 * 客户端由 `scripts/build-client.mjs` 的 `/* @inline core/handoff-guard.js *\/`
 * 内联进 `lib/client.js`（同一份判定，避免 UI 与后台两套口径）。
 */

/** 交接线相对实际触发线至少留 5 个百分点（1M 窗口 ≈ 50K tokens 缓冲）。 */
export const HANDOFF_MARGIN_PP = 5;

/** 实际线算不出、退回配置阈值防呆时的余量（0.4.1 口径：最高 = 配置阈值 −1pp）。 */
export const FALLBACK_MARGIN_PP = 1;

/** cap 的绝对上限（避免算出 96%+ 这种没有意义的上限）。 */
export const HANDOFF_LIMIT_DEFAULT = 0.95;

const EPS = 1e-9;

/**
 * 合法窗口比例：必须是 0<r<1 的有限数。
 * @param {unknown} value
 * @returns {number|null}
 */
function ratioOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1 ? value : null;
}

/**
 * 比例 → 百分数数字（一位小数，整数不带小数）：0.678 → 67.8，0.62 → 62。
 * @param {number|null} ratio
 * @returns {number|null}
 */
function percentOf(ratio) {
  if (ratio === null) return null;
  const percent = ratio * 100;
  return Math.abs(percent - Math.round(percent)) < 0.05 ? Math.round(percent) : Number(percent.toFixed(1));
}

/**
 * 比例 → 百分数文本（用于文案）：0.678 → '67.8'，0.62 → '62'。
 * @param {number|null} ratio
 * @returns {string}
 */
function percentText(ratio) {
  if (ratio === null) return '';
  const percent = ratio * 100;
  return Math.abs(percent - Math.round(percent)) < 0.05 ? String(Math.round(percent)) : percent.toFixed(1);
}

/**
 * 只算交接线上限：参考线 − marginPp，向下取整到整数百分位，再夹到 limit。
 *
 * 浮点安全：`0.62 − 0.05` 在二进制里可能是 0.5700000000000001 / 0.5699999999999999，
 * 直接 floor 会把 57 变成 56，所以加 EPS 再 floor。
 *
 * @param {number|null} referenceRatio 参考线（实际触发线或配置阈值），非法时返回 null
 * @param {{marginPp?:number, limit?:number}} [options]
 * @returns {number|null} 例如 0.62；参考线太小（减完 ≤0）时返回 null
 */
export function handoffCapOf(referenceRatio, { marginPp = HANDOFF_MARGIN_PP, limit = HANDOFF_LIMIT_DEFAULT } = {}) {
  const reference = ratioOf(referenceRatio);
  if (reference === null) return null;
  const margin = (Number.isFinite(marginPp) ? marginPp : HANDOFF_MARGIN_PP) / 100;
  const max = Number.isFinite(limit) && limit > 0 && limit < 1 ? limit : HANDOFF_LIMIT_DEFAULT;
  // 向下取整到整数百分位（例如 62.8 → 0.62），不是四舍五入。
  const cap = Math.floor((reference - margin) * 100 + EPS) / 100;
  if (!(cap > 0)) return null;
  return Math.min(cap, max);
}

/** 「重算目标 ≤ 压缩线」时的补充提示（保持「交接线 > 压缩线」现有约束）。 */
function compactConflictText(capPercent, compactRatio) {
  return `按实际线重算目标 ${capPercent}% 不高于压缩线 ${percentText(compactRatio)}%，请先把压缩线降到 ${capPercent}% 以下。`;
}

/**
 * 判定「当前交接线是否会在 DSH 原生压缩之后」。
 *
 * @param {object} [input]
 * @param {number|null} [input.actualRatio] 当前模型实际触发线（state.native.ratio）；算不出/关闭时 null
 * @param {number|null} [input.configuredRatio] 配置阈值（native.thresholdRatio），兜底用
 * @param {number|null} [input.handoffRatio] 当前交接提醒线（thresholds.handoffRatio）
 * @param {number|null} [input.compactRatio] 压缩提醒线（thresholds.compactRatio），判重算冲突
 * @param {boolean} [input.autoEnabled] DSH 原生自动压缩是否开启（false → 不判定，交接线无截止线）
 * @param {number} [input.limit] cap 绝对上限，默认 0.95
 * @param {'none'|'configured'} [input.fallback]
 *   'none'（运行时默认）：实际线算不出就不判定（不告警、不阻断）；
 *   'configured'（服务端保存默认）：实际线算不出时按配置阈值 −1pp 防呆（0.4.1 行为）。
 * @returns {{
 *   source:'actual'|'configured'|null,
 *   actualRatio:number|null, actualPercent:number|null,
 *   configuredRatio:number|null, configuredPercent:number|null,
 *   handoffRatio:number|null, handoffPercent:number|null,
 *   compactRatio:number|null, compactPercent:number|null,
 *   cap:number|null, capPercent:number|null,
 *   ok:boolean, severity:'ok'|'warn'|'late'|'unknown',
 *   reason:'ok'|'late'|'margin'|'fallback'|'no-reference'|'invalid-handoff'|'no-cap',
 *   message:string, target:number|null, compactConflict:boolean
 * }}
 */
export function handoffGuard({
  actualRatio = null,
  configuredRatio = null,
  handoffRatio = null,
  compactRatio = null,
  autoEnabled = true,
  limit = HANDOFF_LIMIT_DEFAULT,
  fallback = 'none',
} = {}) {
  const actual = ratioOf(actualRatio);
  const configured = ratioOf(configuredRatio);
  const handoff = ratioOf(handoffRatio);
  const compact = ratioOf(compactRatio);
  const neutral = {
    source: null,
    actualRatio: actual,
    actualPercent: percentOf(actual),
    configuredRatio: configured,
    configuredPercent: percentOf(configured),
    handoffRatio: handoff,
    handoffPercent: percentOf(handoff),
    compactRatio: compact,
    compactPercent: percentOf(compact),
    cap: null,
    capPercent: null,
    ok: true,
    severity: 'unknown',
    reason: 'no-reference',
    message: '',
    target: null,
    compactConflict: false,
  };
  // 原生自动压缩关着：DSH 不会自己压，不存在「提醒来不及」的截止线。
  if (autoEnabled === false) return neutral;

  /** 带 cap 的结果骨架（cap 已是整数百分位，×100 即整数）。 */
  const withCap = (source, cap) => {
    const capPercent = cap === null ? null : Math.round(cap * 100);
    return {
      ...neutral,
      source,
      cap,
      capPercent,
      target: source === 'actual' ? cap : null,
      compactConflict: cap !== null && compact !== null && cap <= compact + EPS,
    };
  };

  // 1) 实际触发线可用：唯一口径（−5pp），不再叠加「配置阈值 −1pp」。
  if (actual !== null) {
    const cap = handoffCapOf(actual, { limit });
    if (cap === null) return { ...withCap('actual', null), reason: 'no-cap' };
    const base = withCap('actual', cap);
    if (handoff === null) return { ...base, reason: 'invalid-handoff' };
    const conflict = base.compactConflict ? compactConflictText(base.capPercent, compact) : '';
    // 等于实际触发线也算「晚」：DSH 会在同一位置自己压历史，提醒来不及。
    if (handoff > actual - EPS) {
      return {
        ...base,
        ok: false,
        severity: 'late',
        reason: 'late',
        message:
          `交接线已晚：当前模型实际触发 ${percentText(actual)}%，交接线 ${percentText(handoff)}% 会在原生压缩之后` +
          `（DSH 会先压历史）；最高可设 ${base.capPercent}%。${conflict}`,
      };
    }
    if (handoff > cap + EPS) {
      return {
        ...base,
        ok: false,
        severity: 'warn',
        reason: 'margin',
        message:
          `交接线偏晚：当前模型实际触发 ${percentText(actual)}%，交接线 ${percentText(handoff)}% ` +
          `距原生压缩不足 ${HANDOFF_MARGIN_PP} 个百分点；最高可设 ${base.capPercent}%。${conflict}`,
      };
    }
    return { ...base, ok: true, severity: 'ok', reason: 'ok' };
  }

  // 2) 实际线算不出 + 服务端保存：退回配置阈值防呆（0.4.1 行为，兼容旧客户端）。
  if (fallback === 'configured' && configured !== null) {
    const cap = handoffCapOf(configured, { marginPp: FALLBACK_MARGIN_PP, limit });
    if (cap === null) return { ...withCap('configured', null), reason: 'no-cap' };
    const base = withCap('configured', cap);
    if (handoff === null) return { ...base, reason: 'invalid-handoff' };
    if (handoff > cap + EPS) {
      return {
        ...base,
        ok: false,
        severity: 'warn',
        reason: 'fallback',
        message:
          `「交接提醒线」必须低于 DSH 原生自动压缩线（配置阈值 ${percentText(configured)}%），` +
          `否则原生压缩会先动手；最高只能设到 ${base.capPercent}%。` +
          '想设更高请先在设置里关闭「DSH 原生自动压缩」。',
      };
    }
    return { ...base, ok: true, severity: 'ok', reason: 'ok' };
  }

  // 3) 运行时且算不出：不告警、不阻断。
  return neutral;
}
