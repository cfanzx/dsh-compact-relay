/**
 * 0.3.4 / 0.4 P0-1：「可以记一个压缩节点」的动态提示 —— 纯函数，零依赖。
 *
 * 背景（BUG-010）：0.3.1 的 `mark_stage` 工具只告诉模型「条件合适时调用」，
 * 但模型根本看不到当前容量，两条条件无法判断 → 427 个真实会话里 0 次调用。
 * 0.3.4 起由宿主在 system prompt 的动态 context 里给出「当前处于可压缩区间」的提示。
 *
 * 0.4 P0-1（BUG-010 的后续，Win 173 会话 cue 注入 18 次但工具 0 调用）：
 *  1. 文案 v2：把抽象的「自然节点」换成 4 个可自检的完成信号（功能已实现并验证 /
 *     文档已交付 / 问题已定位并修复 / 准备交接），并把「不确定就别调」改成
 *     「不确定也建议调一次让工具判断：被拒绝不会改动历史」——零成本试错；
 *  2. 区间 v2：cue 只在 [CUE_MIN_RATIO, min(CUE_MAX_RATIO, compactRatio)) 内生成；
 *     下限与动态最小线（保留尾部 + 最小可压 token / 窗口）取较大者，保证 `min` 显示的
 *     是「真正压得划算」的线；上限不含压缩线（到线该直接建议压缩，不该再记节点）。
 *
 * 这段输出会被塞进 system prompt，所以两件事很重要：
 *  1. 尽量稳定：容量按 5% 桶取整，避免每个 token 变化都让提示重发；
 *  2. 尽量安静：刚记过 hint（差 10 个百分点内）不再重复提醒；注入频率由
 *     adapters/prompt.js 的门控（≥ CUE_MIN_TURNS 轮一次）再收一道。
 *
 * 只做纯计算：入参都是数字/小对象，不 import 任何 DSH 模块，可裸跑单测。
 */
import { CUE_MAX_RATIO, CUE_MIN_RATIO } from './policy.js';

/** 动态 context 的名称（宿主按 name 去重/覆盖）。 */
export const COMPRESS_CUE_NAME = 'compact-relay:compress-cue';

/** 动态 context 的排序位置：排在宿主内置 context（100–210）之后。 */
export const COMPRESS_CUE_ORDER = 300;

/** 容量百分比取整桶：5%（0.05）。 */
export const BUCKET_RATIO = 0.05;

/** 已记 hint 后，容量再涨这么多（10 个百分点）才重新提示。 */
export const HINT_SUPPRESS_RATIO = 0.1;

/**
 * 把 0–1 的比例向下取整到 5% 桶（避免 system-prompt 每轮都变）。
 * 0.32 → 0.30，0.39 → 0.35，1 → 1（压缩线在 1 之前，正常到不了 100%）。
 * @param {number} ratio
 * @param {number} [step]
 * @returns {number}
 */
export function bucketRatio(ratio, step = BUCKET_RATIO) {
  if (!Number.isFinite(ratio) || !Number.isFinite(step) || step <= 0) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  const bucketed = Math.floor(clamped / step + 1e-9) * step;
  // 浮点累加（0.05*7=0.35000000000000003）会有尾数，四舍五入回两位小数。
  return Math.round(bucketed * 100) / 100;
}

/**
 * 比例 → 百分比文本：0.05 → '5'，0.325 → '32.5'。
 *
 * 保留一位小数时**向上取整**：动态最小线可能是 33.569%（128K 窗口 + 40K 保留），
 * 若四舍五入成 33.6/33.5 会出现「提示值低于同一句的区间下限」的自相矛盾；
 * 向上取整保证展示值不小于真实值（宁可说大 0.1 个百分点）。
 * @param {number} ratio
 * @returns {string}
 */
export function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return '?';
  const percent = Math.ceil(Math.min(100, Math.max(0, ratio * 100)) * 10 - 1e-9) / 10;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

/**
 * 0.4 P0-1：计算本会话的 cue 区间。
 *
 * - 下限 = max(CUE_MIN_RATIO, 动态最小线)：10% 以下压不划算，动态最小线以下同样不划算；
 * - 上限 = min(CUE_MAX_RATIO, compactRatio)：40% 及以上该直接建议压缩，用户把压缩线
 *   配得更低时也不能越过它（否则 cue 会诱导一次注定被拒的调用）。
 *
 * 返回的 `{minRatio, maxRatio}` 直接喂给 inCompressCueBand / compressCueText，
 * 也用于提示里的「可压缩区间 X%–Y%」显示（与真实可接受区间一致）。
 *
 * @param {{compactRatio?:number, dynamicMinRatio?:number}} [input]
 * @returns {{minRatio:number, maxRatio:number}}
 */
export function cueBandOf({ compactRatio, dynamicMinRatio } = {}) {
  const dynamic = Number.isFinite(dynamicMinRatio) ? dynamicMinRatio : 0;
  const lower = Math.max(CUE_MIN_RATIO, dynamic);
  const configured = Number.isFinite(compactRatio) ? compactRatio : CUE_MAX_RATIO;
  const upper = Math.min(CUE_MAX_RATIO, configured);
  return { minRatio: lower, maxRatio: upper };
}

/**
 * 是否处于「可以记压缩节点」的区间：minRatio ≤ 当前 < maxRatio。
 * 上限不含压缩线本身 —— 到线该直接建议压缩，而不是记节点（工具也会拒绝）。
 * @param {{ratio:number, minRatio:number, maxRatio:number}} input
 * @returns {boolean}
 */
export function inCompressCueBand({ ratio, minRatio, maxRatio }) {
  if (!Number.isFinite(ratio) || !Number.isFinite(minRatio) || !Number.isFinite(maxRatio)) return false;
  return ratio >= minRatio && ratio < maxRatio;
}

/**
 * 生成动态提示；不满足条件返回空串（宿主不会展示空 context）。
 *
 * @param {object} input
 * @param {number} input.ratio 当前上下文占用比例（0–1）
 * @param {number} input.minRatio cue 区间下限（cueBandOf 的结果，已含动态最小线）
 * @param {number} input.maxRatio cue 区间上限（cueBandOf 的结果，已含压缩线）
 * @param {{ratio:number}|null} [input.compressHint] 当前有效的「适合压缩」记录（没有为 null）
 * @returns {string}
 */
export function compressCueText({ ratio, minRatio, maxRatio, compressHint = null }) {
  if (!inCompressCueBand({ ratio, minRatio, maxRatio })) return '';
  // 刚记过断点：容量只涨了不到 10 个百分点 → 不重复提醒（模型已经判断过一次）。
  if (
    compressHint !== null &&
    compressHint !== undefined &&
    Number.isFinite(compressHint.ratio) &&
    ratio - compressHint.ratio < HINT_SUPPRESS_RATIO
  ) {
    return '';
  }
  // 显示值不能低于同一句里的区间下限：5% 桶可能把 33.7% 取整成 30%，而 128K 窗口
  // 的动态最小线是 33.569% —— 那样提示会自相矛盾（「约 30%（可压缩区间 33.6%–40%）」）。
  const shownRatio = Math.max(bucketRatio(ratio), minRatio);
  return (
    `上下文容量约 ${formatPercent(shownRatio)}%（可压缩区间 ${formatPercent(minRatio)}%–${formatPercent(maxRatio)}%）。` +
    '如果你刚刚完成了一个明确阶段——功能已实现并验证 / 文档已交付 / 问题已定位并修复 / 准备交接——就在回复前调用一次 mark_compress_point 记录节点。' +
    '不确定也建议调一次让工具判断：被拒绝不会改动历史、不影响会话。不处于阶段收尾就不用管这句。'
  );
}
