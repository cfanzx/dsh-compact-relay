/**
 * 指示灯环的「分段 + 断点」—— 纯函数，零依赖（0.3.1 新设计）。
 *
 * 2026-10-20 方案对齐：环按「压缩判断」分段，而不是单纯按阈值整体变色。
 *
 * 两个压缩判断路径（谁先到谁就是断点1）：
 * 1. 模型判断：最小线 < 当前 < 压缩线，且内容到了适合压缩的小节点 → 断点1 = 判断时的实际比例；
 * 2. 阈值判断：当前 ≥ 压缩线（设置里的阈值）→ 断点1 = 压缩线比例。
 *
 * 颜色规则：
 * - 正常区 0 → 断点1：还没到断点1 时灰（未走满）；到了断点1（走满）整段蓝；
 * - 压缩区 断点1 → 交接线：琥珀；
 * - 交接区 交接线 → 当前进度：红。
 * - 断点2 = 交接线（设置里的阈值），模型不参与。
 * - 断点只在该边界「两侧都有弧」时显示——压缩后环变短，断点因为前后没有颜色自然消失。
 *
 * 比例都是 0–1；缺口宽度由渲染层按环周长换算（这里只返回边界是否存在）。
 */

/** 把任意输入收成 0–1。 */
function clampRatio(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * 计算环的分段与断点。
 * @param {number} ratio 当前已用比例（0–1）
 * @param {number} compactRatio 压缩线比例（0–1）
 * @param {number} handoffRatio 交接线比例（0–1）
 * @param {number|null} [hintRatio] 模型判断的「适合压缩」位置（0–1）；没有就是 null
 * @returns {{ratio:number, break1:number|null, segments:{from:number,to:number,color:'idle'|'stage'|'compact'|'handoff'}[], boundaries:{at:number}[]}}
 */
export function ringSegments(ratio, compactRatio, handoffRatio, hintRatio = null) {
  const r = clampRatio(ratio);
  const c = clampRatio(compactRatio);
  const h = clampRatio(handoffRatio);
  const hint = hintRatio === null || hintRatio === undefined ? null : clampRatio(hintRatio);

  // 断点1：模型判断的位置优先；否则到压缩线时用阈值位置。
  // 模型判断记录可能比当前进度靠后（压缩后比例回落），那种情况按阈值逻辑处理。
  let break1 = null;
  if (hint !== null && hint <= r + 1e-9) break1 = Math.min(hint, c); // 阈值先到就用压缩线
  else if (r >= c) break1 = c;

  const segments = [];
  if (break1 === null || break1 <= 0) {
    // 还没出现压缩判断：只有正常区，未走满 = 灰。
    if (r > 0) segments.push({ from: 0, to: r, color: 'idle' });
  } else {
    // 正常区：走满 → 蓝。
    segments.push({ from: 0, to: break1, color: 'stage' });
    // 压缩区：断点1 → 交接线（没走到交接线就截到当前进度），琥珀。
    const compactEnd = Math.min(r, h);
    if (compactEnd > break1) segments.push({ from: break1, to: compactEnd, color: 'compact' });
    // 交接区：交接线 → 当前进度，红。
    if (r > h) segments.push({ from: h, to: r, color: 'handoff' });
  }

  // 断点：交界两侧都得有弧才显示（r 越过线）。
  const boundaries = [];
  if (break1 !== null && r > break1 + 1e-9) boundaries.push({ at: break1 });
  if (break1 !== null && break1 < h && r > h + 1e-9) boundaries.push({ at: h });

  return { ratio: r, break1, segments, boundaries };
}

/**
 * 某段在渲染时实际要画的起止（两端各让出半个缺口；首段 0 处和末段当前进度处不留缺口）。
 * @param {{from:number,to:number}} segment
 * @param {number} gapRatio 半个缺口的比例宽度（gapPx / 环周长）
 * @param {number} ratio 当前总比例（判断是不是末段）
 * @returns {{from:number, to:number}}
 */
export function trimSegment(segment, gapRatio, ratio) {
  const first = segment.from <= 0;
  const last = Math.abs(segment.to - ratio) < 1e-9;
  const from = first ? segment.from : segment.from + gapRatio;
  const to = last ? segment.to : segment.to - gapRatio;
  return { from, to };
}
