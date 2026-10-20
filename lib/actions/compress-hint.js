/**
 * 「这里适合压缩」判断（0.3.1）。
 *
 * 模型工具 `mark_stage` 在这里落一条 plugin record；环上把它画成断点1。
 * 用户手动入口已删除（作者 2026-10-20 拍板：判断由模型/阈值自动完成）。
 */
import { COMPRESS_HINT_RECORD_TYPE } from '../core/compress-hint.js';
import { compressionMinRatio } from '../core/policy.js';
import { measurePressure } from '../dsh/pressure.js';

/**
 * 记录一次「适合压缩」的判断。
 * @param {object} deps
 * @param {{agent: object}} input
 * @returns {Promise<{ok:boolean, ratio:number, at:number, seq?:number, reason?:string, message:string}>}
 */
export async function markCompressHint(deps, { agent } = {}) {
  const session = agent?.session;
  if (session === null || session === undefined) {
    return { ok: false, ratio: 0, at: 0, reason: 'no-session', message: '没有活动会话，无法记录判断' };
  }
  const measured = await measurePressure(deps.ctx, agent, { windowFallback: deps.cfg.contextWindowFallback }).catch(() => null);
  if (measured === null || typeof measured.ratio !== 'number') {
    return { ok: false, ratio: 0, at: 0, reason: 'no-pressure', message: '拿不到当前容量，先别记录' };
  }
  const ratio = measured.ratio;
  const window = measured.window;
  const minRatio = compressionMinRatio(deps.cfg.thresholds, deps.cfg.retention, window);
  const compactRatio = deps.cfg.thresholds.compactRatio;
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  if (ratio < minRatio) {
    return {
      ok: false,
      ratio,
      at: Date.now(),
      reason: 'below-min',
      message: `当前容量 ${percent(ratio)} 还没到最小压缩线 ${percent(minRatio)}——这个位置压缩不划算，不用记录，继续做你的工作`,
    };
  }
  if (ratio >= compactRatio) {
    return {
      ok: false,
      ratio,
      at: Date.now(),
      reason: 'already-over',
      message: `当前容量 ${percent(ratio)} 已经到压缩线了——直接建议用户压缩就行，不用再记录判断点`,
    };
  }
  const at = Date.now();
  const seq = deps.engine.appendPluginRecord(session, COMPRESS_HINT_RECORD_TYPE, { ratio, at });
  return {
    ok: true,
    ratio,
    at,
    seq,
    message: `已记录「适合压缩」判断：当前 ${percent(ratio)}（在最小线和压缩线之间）。用户会在环上看到一个断点`,
  };
}
